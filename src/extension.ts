import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ACCOUNTS_KEY = 'reclaude.accounts';
const ACTIVE_EMAIL_STATE = 'reclaude.activeEmail';
const COOKIE_KEY = 'reclaude.cookie';
const LEGACY_EMAIL_KEY = 'reclaude.email';
const LEGACY_PASS_KEY = 'reclaude.password';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

interface Account {
  email: string;
  password: string;
}

interface QuotaData {
  quota_usd?: string | number | null;
  used_usd?: string | number | null;
  resets_at_ms?: number;
  enabled?: boolean;
  [key: string]: unknown;
}

interface MetricsData {
  error_rate?: number;
  error_count?: number;
  req_count?: number;
  avg_latency_ms?: number;
  rps?: number;
  tpm?: number;
  [key: string]: unknown;
}

interface RefreshResult {
  metrics: MetricsData | null;
  quota: QuotaData | null;
}

interface CarpoolAllocation {
  org_id?: string | number;
  allocation_id?: string | number;
  id?: string | number;
  sku?: string;
  plan?: string;
  capacity?: number;
  [key: string]: unknown;
}

interface TaggedError extends Error {
  kind?: 'bad-credentials' | 'auth' | 'http';
}

type StatusLevel = 'ok' | 'warn' | 'err';

let statusBar: vscode.StatusBarItem;
let ctx: vscode.ExtensionContext;
let refreshing = false;
let cachedCookie: string | null = null;
let cachedCookieEmail: string | null = null;
let lastData: RefreshResult | null = null;
let tickTimer: NodeJS.Timeout | null = null;
let quotaTimer: NodeJS.Timeout | null = null;
let metricsTimer: NodeJS.Timeout | null = null;
let followTimer: NodeJS.Timeout | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let pollingActive = false;

export function activate(context: vscode.ExtensionContext): void {
  ctx = context;

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(sync~spin) reclaude';
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('reclaude.refresh', () => refresh()),
    vscode.commands.registerCommand('reclaude.addAccount', addAccountCmd),
    vscode.commands.registerCommand('reclaude.switchAccount', switchAccountCmd),
    vscode.commands.registerCommand('reclaude.removeAccount', removeAccountCmd),
    vscode.commands.registerCommand('reclaude.changePassword', changePasswordCmd),
    vscode.commands.registerCommand('reclaude.setCookie', setCookieCmd),
    vscode.commands.registerCommand('reclaude.setOrgId', setOrgIdCmd),
    vscode.commands.registerCommand('reclaude.autoDetectOrgId', autoDetectOrgIdCmd),
    vscode.commands.registerCommand('reclaude.clearAll', clearAllCmd),
    vscode.workspace.onDidSaveTextDocument(() => {
      const cfg = getRefreshCfg();
      if (cfg.refreshOnSave) {
        refresh();
      }
      // 保存视为"有操作"：取消正在跑的定时调取，重新开始闲置计时
      resetIdleSchedule();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('reclaude.quotaRefreshIntervalSec') ||
        e.affectsConfiguration('reclaude.metricsRefreshIntervalSec') ||
        e.affectsConfiguration('reclaude.idleActivateSec')
      ) {
        resetIdleSchedule();
      }
    })
  );

  tickTimer = setInterval(() => { if (lastData) { renderFromCache(); } }, 60_000);
  followTimer = setInterval(checkReclaudeCurrentAccount, 10_000);
  resetIdleSchedule();

  migrateLegacyAccount().then(() => {
    checkReclaudeCurrentAccount();
    refresh();
  });
}

export function deactivate(): void {
  if (tickTimer) { clearInterval(tickTimer); }
  if (followTimer) { clearInterval(followTimer); }
  if (idleTimer) { clearTimeout(idleTimer); }
  stopPollingTimers();
  if (statusBar) { statusBar.dispose(); }
}

// ============ 定时刷新调度 ============
function getRefreshCfg() {
  const cfg = vscode.workspace.getConfiguration('reclaude');
  return {
    quotaSec: Math.max(5, cfg.get<number>('quotaRefreshIntervalSec', 60)),
    metricsSec: Math.max(5, cfg.get<number>('metricsRefreshIntervalSec', 30)),
    idleSec: Math.max(0, cfg.get<number>('idleActivateSec', 0)),
    refreshOnSave: cfg.get<boolean>('refreshOnSave', true)
  };
}

function stopPollingTimers(): void {
  if (quotaTimer) { clearInterval(quotaTimer); quotaTimer = null; }
  if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
  pollingActive = false;
}

function startPollingTimers(): void {
  stopPollingTimers();
  const { quotaSec, metricsSec } = getRefreshCfg();
  quotaTimer = setInterval(refresh, quotaSec * 1000);
  metricsTimer = setInterval(refreshMetricsOnly, metricsSec * 1000);
  pollingActive = true;
}

// 重置闲置计时：idleSec=0 时立即启动定时；否则停掉当前定时，等闲置 idleSec 后再启动
function resetIdleSchedule(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const { idleSec } = getRefreshCfg();
  if (idleSec === 0) {
    if (!pollingActive) { startPollingTimers(); }
    return;
  }
  stopPollingTimers();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    startPollingTimers();
  }, idleSec * 1000);
}

// ============ 账号存储 ============
async function getAccounts(): Promise<Account[]> {
  const raw = await ctx.secrets.get(ACCOUNTS_KEY);
  if (!raw) { return []; }
  try { return JSON.parse(raw) as Account[]; } catch { return []; }
}
async function saveAccounts(list: Account[]): Promise<void> {
  await ctx.secrets.store(ACCOUNTS_KEY, JSON.stringify(list));
}
function getActiveEmail(): string | null {
  return ctx.globalState.get<string>(ACTIVE_EMAIL_STATE) || null;
}
async function setActiveEmail(email: string | undefined): Promise<void> {
  await ctx.globalState.update(ACTIVE_EMAIL_STATE, email || undefined);
}
async function getActiveCredential(): Promise<Account | null> {
  const email = getActiveEmail();
  if (!email) { return null; }
  const accounts = await getAccounts();
  return accounts.find(a => a.email === email) || null;
}

// 旧版本单账号兼容：迁移到新结构
async function migrateLegacyAccount(): Promise<void> {
  const accounts = await getAccounts();
  if (accounts.length > 0) { return; }
  const oldEmail = await ctx.secrets.get(LEGACY_EMAIL_KEY);
  const oldPass = await ctx.secrets.get(LEGACY_PASS_KEY);
  if (oldEmail && oldPass) {
    await saveAccounts([{ email: oldEmail, password: oldPass }]);
    await setActiveEmail(oldEmail);
    await ctx.secrets.delete(LEGACY_EMAIL_KEY);
    await ctx.secrets.delete(LEGACY_PASS_KEY);
  }
}

// ============ 命令 ============
async function addAccountCmd(): Promise<void> {
  const email = await vscode.window.showInputBox({
    prompt: '新账号邮箱',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() === '' ? '不能为空' : undefined)
  });
  if (!email) { return; }
  const password = await vscode.window.showInputBox({
    prompt: '密码',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v === '' ? '不能为空' : undefined)
  });
  if (!password) { return; }

  const accounts = await getAccounts();
  const existing = accounts.find(a => a.email === email.trim());
  if (existing) {
    existing.password = password;
    vscode.window.showInformationMessage(`已更新账号密码：${email.trim()}`);
  } else {
    accounts.push({ email: email.trim(), password });
    vscode.window.showInformationMessage(`已添加账号：${email.trim()}`);
  }
  await saveAccounts(accounts);
  if (!getActiveEmail()) { await setActiveEmail(email.trim()); }
  cachedCookie = null;
  cachedCookieEmail = null;
  refresh();
}

async function switchAccountCmd(): Promise<void> {
  const accounts = await getAccounts();
  if (accounts.length === 0) {
    vscode.window.showWarningMessage('还没添加任何账号，请先运行「Reclaude：添加账号」');
    return;
  }
  const active = getActiveEmail();
  const items = accounts.map(a => ({
    label: a.email,
    description: a.email === active ? '（当前）' : '',
    email: a.email
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择要激活的账号' });
  if (!picked) { return; }
  await setActiveEmail(picked.email);
  cachedCookie = null;
  cachedCookieEmail = null;
  vscode.window.showInformationMessage(`已切换到：${picked.email}`);
  refresh();
}

async function removeAccountCmd(): Promise<void> {
  const accounts = await getAccounts();
  if (accounts.length === 0) {
    vscode.window.showWarningMessage('没有保存的账号');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    accounts.map(a => ({ label: a.email, email: a.email })),
    { placeHolder: '选择要删除的账号' }
  );
  if (!picked) { return; }
  const filtered = accounts.filter(a => a.email !== picked.email);
  await saveAccounts(filtered);
  if (getActiveEmail() === picked.email) {
    await setActiveEmail(filtered[0] ? filtered[0].email : undefined);
    cachedCookie = null;
    cachedCookieEmail = null;
  }
  vscode.window.showInformationMessage(`已删除：${picked.email}`);
  refresh();
}

async function changePasswordCmd(): Promise<void> {
  const accounts = await getAccounts();
  if (accounts.length === 0) {
    vscode.window.showWarningMessage('还没添加任何账号，请先运行「Reclaude：添加账号」');
    return;
  }
  const active = getActiveEmail();
  const items = accounts.map(a => ({
    label: a.email,
    description: a.email === active ? '（当前）' : '',
    email: a.email
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择要修改密码的账号' });
  if (!picked) { return; }
  const password = await vscode.window.showInputBox({
    prompt: `输入 ${picked.email} 的新密码`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v === '' ? '不能为空' : undefined)
  });
  if (!password) { return; }
  const next = accounts.map(a => a.email === picked.email ? { ...a, password } : a);
  await saveAccounts(next);
  if (picked.email === active) {
    cachedCookie = null;
    cachedCookieEmail = null;
  }
  vscode.window.showInformationMessage(`已更新 ${picked.email} 的密码`);
  refresh();
}

// 登录密码错误时，弹窗让用户重新输入账号和密码
async function promptReenterCredentials(reason?: string): Promise<boolean> {
  const activeEmail = getActiveEmail();
  const tip = reason ? `${reason}\n` : '';
  const choice = await vscode.window.showWarningMessage(
    `${tip}账号 ${activeEmail || ''} 登录失败：账号或密码错误，是否重新输入？`,
    { modal: true },
    '重新输入'
  );
  if (choice !== '重新输入') { return false; }

  const email = await vscode.window.showInputBox({
    prompt: '请重新输入账号邮箱',
    value: activeEmail || '',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() === '' ? '不能为空' : undefined)
  });
  if (!email) { return false; }
  const password = await vscode.window.showInputBox({
    prompt: '请重新输入密码',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v === '' ? '不能为空' : undefined)
  });
  if (!password) { return false; }

  const trimmedEmail = email.trim();
  let accounts = await getAccounts();
  const existing = accounts.find(a => a.email === trimmedEmail);
  if (existing) {
    existing.password = password;
  } else {
    accounts.push({ email: trimmedEmail, password });
  }
  // 邮箱被改写时，移除旧的失效记录
  if (activeEmail && activeEmail !== trimmedEmail) {
    accounts = accounts.filter(a => a.email !== activeEmail);
  }
  await saveAccounts(accounts);
  await setActiveEmail(trimmedEmail);
  cachedCookie = null;
  cachedCookieEmail = null;
  return true;
}

async function setCookieCmd(): Promise<void> {
  const input = await vscode.window.showInputBox({
    prompt: '（备用）粘贴 reclaude.ai 完整 Cookie；推荐用账号密码',
    placeHolder: 'rc_sid=...',
    ignoreFocusOut: true,
    password: true
  });
  if (input && input.trim()) {
    await ctx.secrets.store(COOKIE_KEY, input.trim());
    cachedCookie = input.trim();
    cachedCookieEmail = null;
    vscode.window.showInformationMessage('cookie 已保存');
    refresh();
  }
}

async function setOrgIdCmd(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('reclaude');
  const cur = cfg.get<string>('orgId', '');
  const value = await vscode.window.showInputBox({
    prompt: '输入组织 ID（拼车组织 ID）',
    value: cur,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() === '' ? '不能为空' : undefined)
  });
  if (value === undefined) { return; }
  await cfg.update('orgId', value.trim(), vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`组织 ID 已设为 ${value.trim()}`);
  refresh();
}

async function autoDetectOrgIdCmd(): Promise<void> {
  try {
    const cookie = await getCookie(false);
    if (!cookie) { vscode.window.showWarningMessage('请先添加账号'); return; }
    const id = await autoDetectOrgId(cookie, true);
    if (id) { refresh(); }
  } catch (e) {
    const err = e as Error;
    vscode.window.showErrorMessage(`自动探测失败：${err.message || String(e)}`);
  }
}

async function clearAllCmd(): Promise<void> {
  await ctx.secrets.delete(ACCOUNTS_KEY);
  await ctx.secrets.delete(COOKIE_KEY);
  await ctx.secrets.delete(LEGACY_EMAIL_KEY);
  await ctx.secrets.delete(LEGACY_PASS_KEY);
  await setActiveEmail(undefined);
  cachedCookie = null;
  cachedCookieEmail = null;
  lastData = null;
  vscode.window.showInformationMessage('已清除所有账号和凭证');
  refresh();
}

// ============ 跟随 reclaude 当前账号 ============
async function checkReclaudeCurrentAccount(): Promise<void> {
  try {
    const devicePath = path.join(os.homedir(), '.reclaude', 'device.json');
    if (!fs.existsSync(devicePath)) { return; }
    const raw = fs.readFileSync(devicePath, 'utf8');
    const data = JSON.parse(raw) as { user_email?: string };
    const reclaudeEmail = data.user_email;
    if (!reclaudeEmail) { return; }

    const active = getActiveEmail();
    if (reclaudeEmail === active) { return; }

    const accounts = await getAccounts();
    if (accounts.find(a => a.email === reclaudeEmail)) {
      await setActiveEmail(reclaudeEmail);
      cachedCookie = null;
      cachedCookieEmail = null;
      vscode.window.showInformationMessage(`检测到 reclaude 切换到 ${reclaudeEmail}，已同步`);
      refresh();
    }
  } catch {
    // 静默
  }
}

// ============ 登录 + 请求 ============
async function login(email: string, password: string): Promise<string> {
  const res = await fetch('https://reclaude.ai/api/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
      'origin': 'https://reclaude.ai',
      'referer': 'https://reclaude.ai/login',
      'user-agent': UA
    },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 422) {
      const err: TaggedError = new Error(`账号或密码错误（HTTP ${res.status}）`);
      err.kind = 'bad-credentials';
      throw err;
    }
    throw new Error(`登录失败 HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  let setCookie: string[] = [];
  const headersAny = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof headersAny.getSetCookie === 'function') {
    setCookie = headersAny.getSetCookie();
  } else {
    const raw = res.headers.get('set-cookie');
    if (raw) { setCookie = [raw]; }
  }
  if (!setCookie || setCookie.length === 0) { throw new Error('登录响应缺少 Set-Cookie'); }
  return setCookie.map(s => s.split(';')[0].trim()).filter(Boolean).join('; ');
}

async function getCookie(forceRefresh: boolean): Promise<string | null> {
  if (forceRefresh) { cachedCookie = null; cachedCookieEmail = null; }
  const activeEmail = getActiveEmail();
  if (cachedCookie && cachedCookieEmail === activeEmail) { return cachedCookie; }

  const cred = await getActiveCredential();
  if (cred) {
    cachedCookie = await login(cred.email, cred.password);
    cachedCookieEmail = cred.email;
    return cachedCookie;
  }
  const manual = await ctx.secrets.get(COOKIE_KEY);
  if (manual) { cachedCookie = manual; cachedCookieEmail = null; return manual; }
  return null;
}

function apiHeaders(cookie: string): Record<string, string> {
  return {
    'accept': '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'cookie': cookie,
    'referer': 'https://reclaude.ai/app',
    'user-agent': UA,
    'x-lang': 'zh'
  };
}

async function fetchJSON<T = unknown>(url: string, cookie: string): Promise<T> {
  const res = await fetch(url, { headers: apiHeaders(cookie) });
  if (res.status === 401 || res.status === 403) {
    const err: TaggedError = new Error(`auth-${res.status}`); err.kind = 'auth'; throw err;
  }
  if (!res.ok) { const err: TaggedError = new Error(`HTTP ${res.status}`); err.kind = 'http'; throw err; }
  return res.json() as Promise<T>;
}

async function autoDetectOrgId(cookie: string, interactive: boolean): Promise<string | null> {
  const data = await fetchJSON<CarpoolAllocation[] | { allocations?: CarpoolAllocation[]; items?: CarpoolAllocation[]; data?: CarpoolAllocation[] }>(
    'https://reclaude.ai/api/app/billing/carpool-allocations',
    cookie
  );
  const list: CarpoolAllocation[] = Array.isArray(data)
    ? data
    : (data.allocations || data.items || data.data || []);
  if (!list || list.length === 0) {
    if (interactive) { vscode.window.showWarningMessage('当前账号下没有拼车套餐'); }
    return null;
  }

  let chosen: CarpoolAllocation;
  if (list.length === 1) {
    chosen = list[0];
  } else if (interactive) {
    const items = list.map((a) => {
      const id = a.org_id || a.allocation_id || a.id || '?';
      const sku = a.sku || a.plan || '';
      const cap = a.capacity ? `${a.capacity} 人` : '';
      return { label: `${sku} (org_id=${id})`, description: cap, payload: a };
    });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: '账号下有多个拼车套餐，选择要监控的' });
    if (!picked) { return null; }
    chosen = picked.payload;
  } else {
    chosen = list[0];
  }

  const id = String(chosen.org_id || chosen.allocation_id || chosen.id || '');
  if (!id) { throw new Error('返回的套餐缺少 id 字段'); }
  await vscode.workspace.getConfiguration('reclaude').update('orgId', id, vscode.ConfigurationTarget.Global);
  if (interactive) { vscode.window.showInformationMessage(`组织 ID 已自动设为 ${id}`); }
  return id;
}

async function fetchAll(cookie: string, orgId: string): Promise<RefreshResult> {
  const metricsPromise = fetchJSON<MetricsData>('https://reclaude.ai/api/app/ops/metrics', cookie)
    .catch(() => null);
  const quotaPromise = orgId
    ? fetchJSON<QuotaData>(`https://reclaude.ai/api/app/billing/carpool-quota?org_id=${encodeURIComponent(orgId)}`, cookie)
        .catch((e: TaggedError) => {
          if (e && e.kind === 'auth') { throw e; }
          return null;
        })
    : Promise.resolve(null);
  const [metrics, quota] = await Promise.all([metricsPromise, quotaPromise]);
  return { metrics, quota };
}

async function refreshMetricsOnly(): Promise<void> {
  try {
    const cookie = await getCookie(false);
    if (!cookie || !lastData) { return; }
    const m = await fetchJSON<MetricsData>('https://reclaude.ai/api/app/ops/metrics', cookie).catch(() => null);
    if (m) {
      lastData.metrics = m;
      renderFromCache();
    }
  } catch {
    // 静默
  }
}

async function refresh(): Promise<void> {
  if (refreshing) { return; }
  refreshing = true;
  try {
    await doRefresh();
  } finally {
    refreshing = false;
  }
}

async function doRefresh(): Promise<void> {
  let cookie: string | null = null;
  try {
    cookie = await getCookie(false);
  } catch (e) {
    const err = e as TaggedError;
    if (err.kind === 'bad-credentials') {
      const ok = await promptReenterCredentials(err.message);
      if (ok) {
        try {
          cookie = await getCookie(true);
        } catch (e2) {
          const err2 = e2 as TaggedError;
          if (err2.kind === 'bad-credentials') {
            setStatus('$(key) 账号或密码错误', 'reclaude.changePassword', 'err', '点击修改密码');
          } else {
            setStatus('$(key) 登录失败', 'reclaude.switchAccount', 'err', String(err2.message || e2));
          }
          return;
        }
      } else {
        setStatus('$(key) 账号或密码错误', 'reclaude.changePassword', 'err', '点击修改密码');
        return;
      }
    } else {
      setStatus('$(key) 登录失败', 'reclaude.switchAccount', 'err', String(err.message || e));
      return;
    }
  }
  if (!cookie) {
    setStatus('$(key) 未添加账号', 'reclaude.addAccount', 'warn', '点击添加账号');
    return;
  }

  let orgId = vscode.workspace.getConfiguration('reclaude').get<string>('orgId', '').trim();
  if (!orgId) {
    try {
      const detected = await autoDetectOrgId(cookie, false);
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

  let result: RefreshResult;
  try {
    result = await fetchAll(cookie, orgId);
  } catch (e) {
    const err = e as TaggedError;
    if (err.kind === 'auth') {
      try {
        cookie = await getCookie(true);
        if (!cookie) {
          setStatus('$(key) 鉴权失败', 'reclaude.switchAccount', 'warn', '请检查账号密码');
          return;
        }
        result = await fetchAll(cookie, orgId);
      } catch (e2) {
        const err2 = e2 as TaggedError;
        if (err2.kind === 'bad-credentials') {
          const ok = await promptReenterCredentials(err2.message);
          if (ok) {
            try {
              cookie = await getCookie(true);
              if (!cookie) {
                setStatus('$(key) 鉴权失败', 'reclaude.switchAccount', 'warn', '请检查账号密码');
                return;
              }
              result = await fetchAll(cookie, orgId);
            } catch (e3) {
              const err3 = e3 as TaggedError;
              if (err3.kind === 'bad-credentials') { setStatus('$(key) 账号或密码错误', 'reclaude.changePassword', 'err', '点击修改密码'); }
              else if (err3.kind === 'auth') { setStatus('$(key) 鉴权失败', 'reclaude.switchAccount', 'warn', '请检查账号密码'); }
              else { setStatus(`$(error) ${err3.message}`, 'reclaude.refresh', 'err', String(err3.message || e3)); }
              return;
            }
          } else {
            setStatus('$(key) 账号或密码错误', 'reclaude.changePassword', 'err', '点击修改密码');
            return;
          }
        } else if (err2.kind === 'auth') {
          setStatus('$(key) 鉴权失败', 'reclaude.switchAccount', 'warn', '请检查账号密码');
          return;
        } else {
          setStatus(`$(error) ${err2.message}`, 'reclaude.refresh', 'err', String(err2.message || e2));
          return;
        }
      }
    } else {
      setStatus(`$(error) ${err.message}`, 'reclaude.refresh', 'err', String(err.message || e));
      return;
    }
  }

  lastData = result;
  renderFromCache();
}

function renderFromCache(): void {
  if (!lastData) { return; }
  render(lastData.quota, lastData.metrics);
}

function setStatus(text: string, command: string, level: StatusLevel, tooltip?: string | vscode.MarkdownString): void {
  statusBar.text = text;
  statusBar.command = command;
  statusBar.tooltip = tooltip || '';
  if (level === 'err') {
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    statusBar.color = undefined;
  } else if (level === 'warn') {
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusBar.color = undefined;
  } else {
    statusBar.backgroundColor = undefined;
    statusBar.color = new vscode.ThemeColor('reclaudeMonitor.statusForeground');
  }
}

function fmtCountdownShort(ms: number): string {
  if (ms <= 0) { return '已重置'; }
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h > 0) { return `${h}时${m}分`; }
  return `${m}分`;
}

function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined) { return '-'; }
  if (v >= 1e6) { return (v / 1e6).toFixed(1) + 'M'; }
  if (v >= 1e3) { return (v / 1e3).toFixed(1) + 'k'; }
  return String(Math.round(v));
}

function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined) { return '-'; }
  if (v >= 1000) { return (v / 1000).toFixed(2) + 's'; }
  return Math.round(v) + 'ms';
}

// 用 `━` 字符 + <span style="color"> 渲染带颜色的细横条进度条
function buildColorBar(ratio: number, fillColor: string, trackColor: string): string {
  const barLen = 30;
  const filled = Math.max(0, Math.min(barLen, Math.round(ratio * barLen)));
  const filledPart = filled > 0 ? `<span style="color:${fillColor};">${'━'.repeat(filled)}</span>` : '';
  const emptyPart = filled < barLen ? `<span style="color:${trackColor};">${'━'.repeat(barLen - filled)}</span>` : '';
  return filledPart + emptyPart;
}

function render(quota: QuotaData | null, metrics: MetricsData | null): void {
  let mainText: string;
  let level: StatusLevel = 'ok';

  if (quota && quota.quota_usd !== null && quota.quota_usd !== undefined) {
    const used = parseFloat(String(quota.used_usd ?? '0'));
    const total = parseFloat(String(quota.quota_usd ?? '0'));
    const ratio = total > 0 ? used / total : 0;
    if (ratio >= 0.95) { level = 'err'; }
    else if (ratio >= 0.8) { level = 'warn'; }

    const countdown = quota.resets_at_ms ? fmtCountdownShort(quota.resets_at_ms - Date.now()) : '?';
    mainText = `$${used.toFixed(2)}/$${total.toFixed(0)} · ${countdown}`;
  } else {
    mainText = '拼车数据获取失败';
    level = 'err';
  }

  let errText = '';
  if (metrics) {
    const errRate = (metrics.error_rate || 0) * 100;
    if (errRate >= 5) { level = 'err'; }
    else if (errRate >= 1 && level === 'ok') { level = 'warn'; }
    errText = ` · 错误 ${errRate.toFixed(1)}%`;
  } else {
    errText = ' · 指标失败';
  }

  const icon = level === 'err' ? '$(flame)' : level === 'warn' ? '$(warning)' : '$(zap)';
  const activeEmail = getActiveEmail();
  mainText = `${mainText}${errText}`;

  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportThemeIcons = true;
  md.supportHtml = true;

  // ── 账号 ──
  if (activeEmail) {
    md.appendMarkdown(`$(account) ${activeEmail}\n\n`);
  }

  // ── 额度 ──
  if (quota && quota.quota_usd !== null && quota.quota_usd !== undefined) {
    const used = parseFloat(String(quota.used_usd ?? '0'));
    const total = parseFloat(String(quota.quota_usd ?? '0'));
    const ratio = total > 0 ? used / total : 0;
    const pct = ratio * 100;
    const remain = total - used;

    const fillColor = ratio >= 0.95 ? '#f48771' : ratio >= 0.8 ? '#e2c08d' : '#3794ff';
    const bar = buildColorBar(ratio, fillColor, '#3a3d41');
    const resetShort = quota.resets_at_ms ? fmtCountdownShort(quota.resets_at_ms - Date.now()) : '';

    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`**${pct.toFixed(1)}%** 已使用 &emsp;&emsp;&emsp; 重置 **${resetShort || '?'}**\n\n`);
    md.appendMarkdown(`${bar}\n\n`);
    md.appendMarkdown(`<sub>**$${used.toFixed(2)}** / $${total.toFixed(0)} &nbsp;·&nbsp; 剩 **$${remain.toFixed(2)}**${quota.enabled === false ? ' &nbsp;·&nbsp; $(circle-slash) 未启用' : ''}</sub>\n\n`);
  }

  // ── 可用性 ──
  md.appendMarkdown(`---\n\n`);
  if (metrics) {
    const errRate = (metrics.error_rate || 0) * 100;
    const rpm = (metrics.rps || 0) * 60;
    const stateIcon = errRate < 1 ? '$(pass-filled)' : errRate < 5 ? '$(warning)' : '$(error)';
    const stateText = errRate < 1 ? '正常' : errRate < 5 ? '抖动' : '故障';

    md.appendMarkdown(`$(pulse) **服务可用性** <sub>60s 窗口</sub>\n\n`);
    md.appendMarkdown(`状态 &emsp;&emsp; ${stateIcon} **${stateText}**\n\n`);
    md.appendMarkdown(`错误率 &emsp; **${errRate.toFixed(2)}%** <sub>(${metrics.error_count}/${metrics.req_count})</sub>\n\n`);
    md.appendMarkdown(`平均延迟 &emsp; **${fmtMs(metrics.avg_latency_ms)}**\n\n`);
    md.appendMarkdown(`请求/分 &emsp; **${fmtNum(rpm)}** &nbsp;·&nbsp; 令牌/分 &emsp;**${fmtNum(metrics.tpm)}**\n\n`);
  } else {
    md.appendMarkdown(`$(pulse) **服务可用性** &nbsp;·&nbsp; *指标获取失败*\n\n`);
  }

  // ── 操作 ──
  md.appendMarkdown(`---\n\n`);
  md.appendMarkdown(`[$(refresh) 刷新](command:reclaude.refresh) &nbsp;·&nbsp; [$(arrow-swap) 切换](command:reclaude.switchAccount) &nbsp;·&nbsp; [$(add) 添加](command:reclaude.addAccount) &nbsp;·&nbsp; [$(key) 改密](command:reclaude.changePassword) &nbsp;·&nbsp; [$(organization) 组织](command:reclaude.setOrgId)`);

  setStatus(`${icon} ${mainText}`, 'reclaude.refresh', level, md);
}
