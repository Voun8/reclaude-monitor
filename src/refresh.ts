// 刷新编排：会话建立 → 组织 ID → 取数 + 鉴权重试 → 渲染。
// 私有持有 lastData / metricsHistory / refreshing。重输凭据交互由命令层注入（破环）。
import type { QuotaData, MetricsData, RefreshResult, TaggedError, ApiSession } from './types.js';
import { apiUrl } from './apiBase.js';
import { getActiveEmail, getActiveOrgId } from './accounts.js';
import { canFallback, getSession, withSessionFallback } from './session.js';
import { fetchJSON, autoDetectOrgId } from './http.js';
import { deriveQuota, deriveMetrics } from './derive.js';
import { setStatus, render } from './statusbar.js';
import type { PanelPayload } from './dashboard.js';

let refreshing = false;
let lastData: RefreshResult | null = null;
const metricsHistory: { err: number; lat: number }[] = [];
const MAX_HISTORY = 40;

// 弹窗让用户重输凭据（命令层实现，启动时注入），破除 refresh ↔ commands 环
let reauthPrompt: (reason?: string) => Promise<boolean> = async () => false;
export function setReauthPrompt(fn: (reason?: string) => Promise<boolean>): void {
  reauthPrompt = fn;
}

export function hasData(): boolean {
  return lastData !== null;
}

// 清缓存数据（clearAll 用）
export function clearLastData(): void {
  lastData = null;
}

// 面板数据来源：dashboard 的 payload provider 经此取用 lastData/metricsHistory
export function getPanelPayload(): PanelPayload {
  return {
    email: getActiveEmail(),
    quota: deriveQuota(lastData ? lastData.quota : null),
    metrics: deriveMetrics(lastData ? lastData.metrics : null),
    history: { err: metricsHistory.map(h => h.err), lat: metricsHistory.map(h => h.lat) }
  };
}

function pushMetricsHistory(m: MetricsData): void {
  metricsHistory.push({ err: (m.error_rate || 0) * 100, lat: m.avg_latency_ms || 0 });
  if (metricsHistory.length > MAX_HISTORY) {
    metricsHistory.splice(0, metricsHistory.length - MAX_HISTORY);
  }
}

function renderFromCache(): void {
  if (!lastData) { return; }
  render(lastData.quota, lastData.metrics, metricsHistory);
}

// 分钟级重渲染（仅在有缓存数据时），供 tick 定时器调用以刷新倒计时
export function tickRender(): void {
  if (lastData) { renderFromCache(); }
}

// doRefresh 的状态栏终态（集中，消除重复字面量）
function applyBadCredentials(): void {
  setStatus('$(key) 账号或密码错误', 'reclaude.changePassword', 'err', '点击修改密码');
}
function applyAuthFail(): void {
  setStatus('$(key) 鉴权失败', 'reclaude.switchAccount', 'warn', '请检查账号密码');
}
function applyLoginFail(detail: string): void {
  setStatus('$(key) 登录失败', 'reclaude.switchAccount', 'err', detail);
}
function applyRefreshError(message: string): void {
  setStatus(`$(error) ${message}`, 'reclaude.refresh', 'err', message);
}

async function fetchAll(session: ApiSession, orgId: string): Promise<RefreshResult> {
  return withSessionFallback(session, async (s) => {
    let metrics: MetricsData | null = null;
    try {
      metrics = await fetchJSON<MetricsData>(apiUrl(s.apiBase, '/api/app/ops/metrics'), s);
    } catch (e) {
      if (canFallback(s.apiBase, e)) { throw e; }
    }

    let quota: QuotaData | null = null;
    if (orgId) {
      try {
        quota = await fetchJSON<QuotaData>(
          `${apiUrl(s.apiBase, '/api/app/billing/carpool-quota')}?org_id=${encodeURIComponent(orgId)}`,
          s
        );
      } catch (e) {
        const err = e as TaggedError;
        if (err && err.kind === 'auth') { throw err; }
        if (canFallback(s.apiBase, err)) { throw err; }
      }
    }
    return { metrics, quota };
  });
}

export async function refreshMetricsOnly(): Promise<void> {
  try {
    const session = await getSession(false);
    if (!session || !lastData) { return; }
    const m = await withSessionFallback(session, (s) =>
      fetchJSON<MetricsData>(apiUrl(s.apiBase, '/api/app/ops/metrics'), s)
    ).catch(() => null);
    if (m) {
      lastData.metrics = m;
      pushMetricsHistory(m);
      renderFromCache();
    }
  } catch (e) {
    console.error('[reclaude] refreshMetricsOnly 非预期异常', e);
  }
}

export async function refresh(): Promise<void> {
  if (refreshing) { return; }
  refreshing = true;
  try {
    await doRefresh();
  } finally {
    refreshing = false;
  }
}

type ReauthResult =
  | { status: 'ok'; session: ApiSession | null }
  | { status: 'declined' }
  | { status: 'error'; error: TaggedError };

// 弹窗让用户重输凭据；同意则强制重新登录。session 可能为 null（无凭据），由调用方按各自语义判定终态
async function reauthenticate(reason: string): Promise<ReauthResult> {
  const agreed = await reauthPrompt(reason);
  if (!agreed) { return { status: 'declined' }; }
  try {
    return { status: 'ok', session: await getSession(true) };
  } catch (e) {
    return { status: 'error', error: e as TaggedError };
  }
}

async function doRefresh(): Promise<void> {
  // ── 阶段 1：建立会话。首发 bad-credentials 立即弹窗重输 ──
  let session: ApiSession | null;
  try {
    session = await getSession(false);
  } catch (e) {
    const err = e as TaggedError;
    if (err.kind !== 'bad-credentials') { applyLoginFail(err.message || String(e)); return; }
    const re = await reauthenticate(err.message);
    if (re.status === 'declined') { applyBadCredentials(); return; }
    if (re.status === 'error') {
      if (re.error.kind === 'bad-credentials') { applyBadCredentials(); }
      else { applyLoginFail(re.error.message || String(re.error)); }
      return;
    }
    session = re.session; // 可能为 null，落到统一的未添加账号判定
  }
  if (!session) {
    setStatus('$(key) 未添加账号', 'reclaude.addAccount', 'warn', '点击添加账号');
    return;
  }

  // ── 阶段 2：组织 ID（与鉴权重试无关，原样保留）──
  let orgId = await getActiveOrgId();
  if (!orgId) {
    try {
      const detected = await withSessionFallback(session, (s) => autoDetectOrgId(s, false));
      orgId = detected || '';
    } catch (e) {
      const err = e as Error;
      setStatus('$(organization) 自动探测组织 ID 失败', 'reclaude.autoDetectOrgId', 'warn', `${err.message}\n点击重试`);
      return;
    }
    if (!orgId) {
      setStatus('$(organization) 账号下无拼车套餐', 'reclaude.setOrgId', 'warn', '点击手动设置');
      return;
    }
  }

  // ── 阶段 3：取数。首发 auth 先静默重登一次，再 auth 才弹窗重输 ──
  const result = await fetchAllWithReauth(session, orgId);
  if (!result) { return; } // 失败时 fetchAllWithReauth 已设状态栏

  lastData = result;
  if (result.metrics) { pushMetricsHistory(result.metrics); }
  renderFromCache();
}

// 取数 + 鉴权重试：首发 auth → 静默 getSession(true) 重试；仍 bad-credentials → 弹窗重输再试一次。
// 任一终态已通过 setStatus 反馈并返回 null；成功返回结果
async function fetchAllWithReauth(session: ApiSession, orgId: string): Promise<RefreshResult | null> {
  try {
    return await fetchAll(session, orgId);
  } catch (e) {
    const err = e as TaggedError;
    if (err.kind !== 'auth') { applyRefreshError(err.message); return null; }
  }

  // 首发 auth：静默强制重登一次并重试
  try {
    const reloaded = await getSession(true);
    if (!reloaded) { applyAuthFail(); return null; }
    return await fetchAll(reloaded, orgId);
  } catch (e2) {
    const err2 = e2 as TaggedError;
    if (err2.kind === 'auth') { applyAuthFail(); return null; }
    if (err2.kind !== 'bad-credentials') { applyRefreshError(err2.message); return null; }

    // 重登后仍 bad-credentials：弹窗重输再试一次
    const re = await reauthenticate(err2.message);
    if (re.status === 'declined') { applyBadCredentials(); return null; }
    if (re.status === 'error') {
      if (re.error.kind === 'bad-credentials') { applyBadCredentials(); }
      else if (re.error.kind === 'auth') { applyAuthFail(); }
      else { applyRefreshError(re.error.message); }
      return null;
    }
    if (!re.session) { applyAuthFail(); return null; }
    try {
      return await fetchAll(re.session, orgId);
    } catch (e3) {
      const err3 = e3 as TaggedError;
      if (err3.kind === 'bad-credentials') { applyBadCredentials(); }
      else if (err3.kind === 'auth') { applyAuthFail(); }
      else { applyRefreshError(err3.message); }
      return null;
    }
  }
}
