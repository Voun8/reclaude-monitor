import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ACCOUNTS_KEY = 'reclaude.accounts';
const ACTIVE_EMAIL_STATE = 'reclaude.activeEmail';
const COOKIE_KEY = 'reclaude.cookie';
const LEGACY_EMAIL_KEY = 'reclaude.email';
const LEGACY_PASS_KEY = 'reclaude.password';
const DEFAULT_API_BASE = 'https://www.recode.cat';
const FALLBACK_API_BASE = 'https://www.reclaude.ai';
const LEGACY_API_BASE = 'https://reclaude.ai';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

interface Account {
  email: string;
  password: string;
  orgId?: string;
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
  kind?: 'bad-credentials' | 'auth' | 'http' | 'network';
}

type StatusLevel = 'ok' | 'warn' | 'err';

interface ApiSession {
  cookie: string;
  apiBase: string;
}

let statusBar: vscode.StatusBarItem;
let ctx: vscode.ExtensionContext;
let refreshing = false;
let cachedCookie: string | null = null;
let cachedCookieEmail: string | null = null;
let cachedCookieApiBase: string | null = null;
let lastData: RefreshResult | null = null;
let tickTimer: NodeJS.Timeout | null = null;
let quotaTimer: NodeJS.Timeout | null = null;
let metricsTimer: NodeJS.Timeout | null = null;
let followTimer: NodeJS.Timeout | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let pollingActive = false;
let dashboardView: vscode.WebviewView | null = null;
const metricsHistory: { err: number; lat: number }[] = [];
const MAX_HISTORY = 40;

function normalizeApiBase(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) { return null; }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

function configuredApiBase(): string | null {
  const raw = vscode.workspace.getConfiguration('reclaude').get<string>('apiBase', '');
  return normalizeApiBase(raw || '');
}

function defaultApiBases(): string[] {
  return [DEFAULT_API_BASE, FALLBACK_API_BASE, LEGACY_API_BASE];
}

function apiUrl(apiBase: string, pathname: string): string {
  return `${apiBase}${pathname}`;
}

function shouldFallback(e: unknown): boolean {
  const err = e as TaggedError;
  return err.kind !== 'bad-credentials' && err.kind !== 'auth';
}

function isRbacAccessDenied(body: string): boolean {
  return body.toLowerCase().includes('rbac: access denied');
}

function canFallback(apiBase: string, e: unknown): boolean {
  const idx = defaultApiBases().indexOf(apiBase);
  return !configuredApiBase() && idx >= 0 && idx + 1 < defaultApiBases().length && shouldFallback(e);
}

function nextApiBases(apiBase: string): string[] {
  const bases = defaultApiBases();
  const idx = bases.indexOf(apiBase);
  return bases.slice(idx >= 0 ? idx + 1 : 0);
}

function clearCookieCache(): void {
  cachedCookie = null;
  cachedCookieEmail = null;
  cachedCookieApiBase = null;
}

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
    vscode.window.registerWebviewViewProvider('reclaude.dashboard', dashboardProvider, { webviewOptions: { retainContextWhenHidden: true } }),
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
      if (e.affectsConfiguration('reclaude.apiBase')) {
        clearCookieCache();
        refresh();
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

// 组织 ID 跟着账号走：优先用当前账号自己存的 orgId；
// 仅在"备用 Cookie 模式"（没有账号）时回退到全局配置 reclaude.orgId。
async function getActiveOrgId(): Promise<string> {
  const cred = await getActiveCredential();
  if (cred) { return (cred.orgId || '').trim(); }
  return vscode.workspace.getConfiguration('reclaude').get<string>('orgId', '').trim();
}

// 把组织 ID 存到当前账号上；没有账号（Cookie 模式）时才落到全局配置。
async function setActiveOrgId(orgId: string): Promise<void> {
  const email = getActiveEmail();
  const accounts = await getAccounts();
  const hasAccount = email ? accounts.some(a => a.email === email) : false;
  if (hasAccount) {
    await saveAccounts(accounts.map(a => a.email === email ? { ...a, orgId } : a));
  } else {
    await vscode.workspace.getConfiguration('reclaude').update('orgId', orgId, vscode.ConfigurationTarget.Global);
  }
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
  clearCookieCache();
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
  clearCookieCache();
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
    clearCookieCache();
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
    clearCookieCache();
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
  clearCookieCache();
  return true;
}

async function setCookieCmd(): Promise<void> {
  const base = configuredApiBase() || DEFAULT_API_BASE;
  const input = await vscode.window.showInputBox({
    prompt: `（备用）粘贴 ${base} 完整 Cookie；推荐用账号密码`,
    placeHolder: 'rc_sid=...',
    ignoreFocusOut: true,
    password: true
  });
  if (input && input.trim()) {
    await ctx.secrets.store(COOKIE_KEY, input.trim());
    cachedCookie = input.trim();
    cachedCookieEmail = null;
    cachedCookieApiBase = base;
    vscode.window.showInformationMessage('cookie 已保存');
    refresh();
  }
}

async function setOrgIdCmd(): Promise<void> {
  const cur = await getActiveOrgId();
  const activeEmail = getActiveEmail();
  const value = await vscode.window.showInputBox({
    prompt: activeEmail ? `输入 ${activeEmail} 的组织 ID（拼车组织 ID）` : '输入组织 ID（拼车组织 ID）',
    value: cur,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() === '' ? '不能为空' : undefined)
  });
  if (value === undefined) { return; }
  await setActiveOrgId(value.trim());
  vscode.window.showInformationMessage(`组织 ID 已设为 ${value.trim()}`);
  refresh();
}

async function autoDetectOrgIdCmd(): Promise<void> {
  try {
    const session = await getSession(false);
    if (!session) { vscode.window.showWarningMessage('请先添加账号'); return; }
    const id = await autoDetectOrgId(session, true);
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
  clearCookieCache();
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
      clearCookieCache();
      vscode.window.showInformationMessage(`检测到 reclaude 切换到 ${reclaudeEmail}，已同步`);
      refresh();
    }
  } catch {
    // 静默
  }
}

// ============ 登录 + 请求 ============
async function loginAt(apiBase: string, email: string, password: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(apiUrl(apiBase, '/api/auth/login'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        'origin': apiBase,
        'referer': `${apiBase}/login`,
        'user-agent': UA
      },
      body: JSON.stringify({ email, password })
    });
  } catch (e) {
    const err: TaggedError = new Error(`网络错误：${String(e)}`);
    err.kind = 'network';
    throw err;
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403 && isRbacAccessDenied(body)) {
      const err: TaggedError = new Error(`API 访问被拒绝（HTTP 403）：${body.slice(0, 200)}`);
      err.kind = 'http';
      throw err;
    }
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 422) {
      const err: TaggedError = new Error(`账号或密码错误（HTTP ${res.status}）`);
      err.kind = 'bad-credentials';
      throw err;
    }
    const err: TaggedError = new Error(`登录失败 HTTP ${res.status}: ${body.slice(0, 200)}`);
    err.kind = 'http';
    throw err;
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

async function loginWithFallback(email: string, password: string): Promise<ApiSession> {
  const custom = configuredApiBase();
  const bases = custom ? [custom] : defaultApiBases();
  let lastErr: unknown = null;
  for (const apiBase of bases) {
    try {
      const cookie = await loginAt(apiBase, email, password);
      return { cookie, apiBase };
    } catch (e) {
      lastErr = e;
      if (!custom && canFallback(apiBase, e)) {
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function getSession(forceRefresh: boolean): Promise<ApiSession | null> {
  if (forceRefresh) { clearCookieCache(); }
  const activeEmail = getActiveEmail();
  if (cachedCookie && cachedCookieEmail === activeEmail && cachedCookieApiBase) {
    return { cookie: cachedCookie, apiBase: cachedCookieApiBase };
  }

  const cred = await getActiveCredential();
  if (cred) {
    const session = await loginWithFallback(cred.email, cred.password);
    cachedCookie = session.cookie;
    cachedCookieEmail = cred.email;
    cachedCookieApiBase = session.apiBase;
    return session;
  }
  const manual = await ctx.secrets.get(COOKIE_KEY);
  if (manual) {
    const apiBase = configuredApiBase() || DEFAULT_API_BASE;
    cachedCookie = manual;
    cachedCookieEmail = null;
    cachedCookieApiBase = apiBase;
    return { cookie: manual, apiBase };
  }
  return null;
}

async function getFallbackSession(apiBase: string): Promise<ApiSession | null> {
  if (configuredApiBase()) { return null; }
  clearCookieCache();
  const bases = nextApiBases(apiBase);
  const cred = await getActiveCredential();
  if (cred) {
    let lastErr: unknown = null;
    for (const base of bases) {
      try {
        const cookie = await loginAt(base, cred.email, cred.password);
        cachedCookie = cookie;
        cachedCookieEmail = cred.email;
        cachedCookieApiBase = base;
        return { cookie, apiBase: base };
      } catch (e) {
        lastErr = e;
        if (canFallback(base, e)) { continue; }
        throw e;
      }
    }
    if (lastErr) { throw lastErr; }
    return null;
  }
  const manual = await ctx.secrets.get(COOKIE_KEY);
  if (!manual) { return null; }
  const base = bases[0];
  if (!base) { return null; }
  cachedCookie = manual;
  cachedCookieEmail = null;
  cachedCookieApiBase = base;
  return { cookie: manual, apiBase: base };
}

async function withSessionFallback<T>(
  session: ApiSession,
  request: (session: ApiSession) => Promise<T>
): Promise<T> {
  let current = session;
  while (true) {
    try {
      return await request(current);
    } catch (e) {
      if (!canFallback(current.apiBase, e)) { throw e; }
      const fallback = await getFallbackSession(current.apiBase);
      if (!fallback) { throw e; }
      current = fallback;
    }
  }
}

function apiHeaders(cookie: string, apiBase: string): Record<string, string> {
  return {
    'accept': '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'cookie': cookie,
    'referer': `${apiBase}/app`,
    'user-agent': UA,
    'x-lang': 'zh'
  };
}

async function fetchJSON<T = unknown>(url: string, session: ApiSession): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: apiHeaders(session.cookie, session.apiBase) });
  } catch (e) {
    const err: TaggedError = new Error(`网络错误：${String(e)}`);
    err.kind = 'network';
    throw err;
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403 && isRbacAccessDenied(body)) {
      const err: TaggedError = new Error(`API 访问被拒绝（HTTP 403）：${body.slice(0, 200)}`);
      err.kind = 'http';
      throw err;
    }
    if (res.status === 401 || res.status === 403) {
      const err: TaggedError = new Error(`auth-${res.status}`);
      err.kind = 'auth';
      throw err;
    }
    const err: TaggedError = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    err.kind = 'http';
    throw err;
  }
  return res.json() as Promise<T>;
}

async function autoDetectOrgId(session: ApiSession, interactive: boolean): Promise<string | null> {
  const data = await fetchJSON<CarpoolAllocation[] | { allocations?: CarpoolAllocation[]; items?: CarpoolAllocation[]; data?: CarpoolAllocation[] }>(
    apiUrl(session.apiBase, '/api/app/billing/carpool-allocations'),
    session
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
  await setActiveOrgId(id);
  if (interactive) { vscode.window.showInformationMessage(`组织 ID 已自动设为 ${id}`); }
  return id;
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

async function refreshMetricsOnly(): Promise<void> {
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
  let session: ApiSession | null = null;
  try {
    session = await getSession(false);
  } catch (e) {
    const err = e as TaggedError;
    if (err.kind === 'bad-credentials') {
      const ok = await promptReenterCredentials(err.message);
      if (ok) {
        try {
          session = await getSession(true);
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
  if (!session) {
    setStatus('$(key) 未添加账号', 'reclaude.addAccount', 'warn', '点击添加账号');
    return;
  }

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

  let result: RefreshResult;
  try {
    result = await fetchAll(session, orgId);
  } catch (e) {
    const err = e as TaggedError;
    if (err.kind === 'auth') {
      try {
        session = await getSession(true);
        if (!session) {
          setStatus('$(key) 鉴权失败', 'reclaude.switchAccount', 'warn', '请检查账号密码');
          return;
        }
        result = await fetchAll(session, orgId);
      } catch (e2) {
        const err2 = e2 as TaggedError;
        if (err2.kind === 'bad-credentials') {
          const ok = await promptReenterCredentials(err2.message);
          if (ok) {
            try {
              session = await getSession(true);
              if (!session) {
                setStatus('$(key) 鉴权失败', 'reclaude.switchAccount', 'warn', '请检查账号密码');
                return;
              }
              result = await fetchAll(session, orgId);
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
  if (result.metrics) { pushMetricsHistory(result.metrics); }
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

function fmtCountdownHM(ms: number): string {
  if (ms <= 0) { return '已重置'; }
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
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

// 用 Unicode 方块字符画迷你折线图（悬停 Markdown 无法用 SVG，只能近似）
function blockSpark(vals: number[], maxLen: number): string {
  if (!vals || vals.length === 0) { return ''; }
  const blocks = '▁▂▃▄▅▆▇█';
  const slice = vals.length > maxLen ? vals.slice(vals.length - maxLen) : vals;
  let min = Math.min(...slice);
  let max = Math.max(...slice);
  if (max - min < 1e-9) { max = min + 1; }
  return slice.map(v => blocks[Math.max(0, Math.min(7, Math.round((v - min) / (max - min) * 7)))]).join('');
}

function latencyLabel(ms: number): string {
  if (ms < 1000) { return '流畅'; }
  if (ms < 3000) { return '正常'; }
  return '偏慢';
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

  const MUTED = '#8aa0bd';

  // ── 账号 ──
  if (activeEmail) {
    md.appendMarkdown(`$(account)&nbsp; **${activeEmail}**\n\n`);
  }

  // ── 额度 ──
  if (quota && quota.quota_usd !== null && quota.quota_usd !== undefined) {
    const used = parseFloat(String(quota.used_usd ?? '0'));
    const total = parseFloat(String(quota.quota_usd ?? '0'));
    const ratio = total > 0 ? used / total : 0;
    const pct = ratio * 100;
    const remain = total - used;
    const accent = ratio >= 0.95 ? '#f87171' : ratio >= 0.8 ? '#fbbf24' : '#4aa3ff';
    const bar = buildColorBar(ratio, accent, '#44506a');
    const resetTxt = quota.resets_at_ms ? fmtCountdownHM(quota.resets_at_ms - Date.now()) : '?';

    md.appendMarkdown(`$(clock) 重置: **${resetTxt}**\n\n`);
    md.appendMarkdown(`#### 用量: <span style="color:${accent};">${pct.toFixed(1)}%</span>\n\n`);
    md.appendMarkdown(`${bar}\n\n`);
    md.appendMarkdown(`$(credit-card) 已用: &nbsp;**$${used.toFixed(2)}** &nbsp;&nbsp;&nbsp; $(server) 剩余: <span style="color:#5fd39a;">**$${remain.toFixed(2)}**</span>${quota.enabled === false ? ` &nbsp; <span style="color:#f87171;">$(circle-slash) 未启用</span>` : ''}\n\n`);
  } else {
    md.appendMarkdown(`<span style="color:#f87171;">$(error) **拼车数据获取失败**</span>\n\n`);
  }

  // ── 可用性（纵向两列表格，避免窄悬浮窗三列错位）──
  if (metrics) {
    const errRate = (metrics.error_rate || 0) * 100;
    const stLevel = errRate < 1 ? 'ok' : errRate < 5 ? 'warn' : 'err';
    const stColor = stLevel === 'ok' ? '#4ade80' : stLevel === 'warn' ? '#fbbf24' : '#f87171';
    const stIcon = stLevel === 'ok' ? '$(pass-filled)' : stLevel === 'warn' ? '$(warning)' : '$(error)';
    const stText = stLevel === 'ok' ? '正常' : stLevel === 'warn' ? '抖动' : '故障';
    const stSub = stLevel === 'ok' ? '稳定' : stLevel === 'warn' ? '不稳定' : '中断';
    const errColor = errRate >= 5 ? '#f87171' : errRate >= 1 ? '#fbbf24' : '#4ade80';
    const errSpark = blockSpark(metricsHistory.map(h => h.err), 8);
    const latSpark = blockSpark(metricsHistory.map(h => h.lat), 8);

    md.appendMarkdown(`| $(pulse) 服务可用性 | <span style="color:${MUTED};">60s 窗口</span> |\n|:--|:--|\n`);
    md.appendMarkdown(`| <span style="color:${MUTED};">状态</span> | <span style="color:${stColor};">${stIcon} **${stText}**</span> &nbsp;<span style="color:${MUTED};">${stSub}</span> |\n`);
    md.appendMarkdown(`| <span style="color:${MUTED};">错误率</span> | <span style="color:${errColor};">**${errRate.toFixed(2)}%**</span> &nbsp;<span style="color:${MUTED};">${metrics.error_count}/${metrics.req_count}</span> &nbsp;<span style="color:${errColor};">${errSpark}</span> |\n`);
    md.appendMarkdown(`| <span style="color:${MUTED};">平均延迟</span> | <span style="color:#4aa3ff;">**${fmtMs(metrics.avg_latency_ms)}**</span> &nbsp;<span style="color:${MUTED};">${latencyLabel(metrics.avg_latency_ms || 0)}</span> &nbsp;<span style="color:#4aa3ff;">${latSpark}</span> |\n\n`);
  } else {
    md.appendMarkdown(`#### $(pulse) 服务可用性\n\n<span style="color:#f87171;">*指标获取失败*</span>\n\n`);
  }

  // ── 速率 ──
  if (metrics) {
    const rpm = (metrics.rps || 0) * 60;
    md.appendMarkdown(`#### $(dashboard) 速率 <span style="color:${MUTED};">(1分钟窗口)</span>\n\n`);
    md.appendMarkdown(`- 请求: &nbsp;→ **${fmtNum(rpm)}** / 分\n`);
    md.appendMarkdown(`- 令牌: &nbsp;$(database) **${fmtNum(metrics.tpm)}** / 分\n\n`);
  }

  // ── 操作 ──
  md.appendMarkdown(`**操作:**\n\n`);
  md.appendMarkdown(`[$(refresh) 刷新](command:reclaude.refresh) &nbsp;&nbsp; [$(arrow-swap) 切换](command:reclaude.switchAccount) &nbsp;&nbsp; [$(add) 添加](command:reclaude.addAccount) &nbsp;&nbsp; [$(key) 改密](command:reclaude.changePassword) &nbsp;&nbsp; [$(organization) 组织](command:reclaude.setOrgId)`);

  setStatus(`${icon} ${mainText}`, 'reclaude.dashboard.focus', level, md);
  postToPanel();
}

// ============ Webview 面板 ============
function pushMetricsHistory(m: MetricsData): void {
  metricsHistory.push({ err: (m.error_rate || 0) * 100, lat: m.avg_latency_ms || 0 });
  if (metricsHistory.length > MAX_HISTORY) {
    metricsHistory.splice(0, metricsHistory.length - MAX_HISTORY);
  }
}

function buildPanelPayload() {
  const email = getActiveEmail();
  const q = lastData ? lastData.quota : null;
  let quota: unknown = null;
  if (q && q.quota_usd !== null && q.quota_usd !== undefined) {
    const used = parseFloat(String(q.used_usd ?? '0'));
    const total = parseFloat(String(q.quota_usd ?? '0'));
    const ratio = total > 0 ? used / total : 0;
    quota = {
      usedUsd: used,
      totalUsd: total,
      remainingUsd: total - used,
      pct: ratio * 100,
      ratio,
      resetAtMs: q.resets_at_ms || 0,
      enabled: q.enabled !== false
    };
  }
  const mm = lastData ? lastData.metrics : null;
  let metrics: unknown = null;
  if (mm) {
    const errRate = (mm.error_rate || 0) * 100;
    const stateLevel: StatusLevel = errRate < 1 ? 'ok' : errRate < 5 ? 'warn' : 'err';
    metrics = {
      errorRatePct: errRate,
      errorCount: mm.error_count || 0,
      reqCount: mm.req_count || 0,
      avgLatencyMs: mm.avg_latency_ms || 0,
      rpm: (mm.rps || 0) * 60,
      tpm: mm.tpm || 0,
      stateLevel,
      stateText: stateLevel === 'ok' ? '正常' : stateLevel === 'warn' ? '抖动' : '故障'
    };
  }
  return {
    email,
    quota,
    metrics,
    history: { err: metricsHistory.map(h => h.err), lat: metricsHistory.map(h => h.lat) }
  };
}

function postToPanel(): void {
  if (!dashboardView) { return; }
  dashboardView.webview.postMessage({ type: 'data', payload: buildPanelPayload() });
}

interface DashboardMessage {
  type?: string;
  command?: string;
  email?: string;
  password?: string;
  orgId?: string;
}

async function postAccounts(): Promise<void> {
  if (!dashboardView) { return; }
  const accounts = await getAccounts();
  const active = getActiveEmail();
  const orgId = await getActiveOrgId();
  dashboardView.webview.postMessage({
    type: 'accounts',
    accounts: accounts.map(a => ({ email: a.email, active: a.email === active })),
    orgId
  });
}

async function handleDashboardMessage(msg: DashboardMessage): Promise<void> {
  if (!msg || typeof msg.type !== 'string') {
    if (msg && msg.command) { vscode.commands.executeCommand(msg.command); }
    return;
  }
  switch (msg.type) {
    case 'refresh':
      refresh();
      break;
    case 'getAccounts':
      await postAccounts();
      break;
    case 'switch':
      if (msg.email) {
        await setActiveEmail(msg.email);
        clearCookieCache();
        refresh();
        await postAccounts();
      }
      break;
    case 'add': {
      const email = (msg.email || '').trim();
      const password = msg.password || '';
      if (!email || !password) { return; }
      const accounts = await getAccounts();
      const existing = accounts.find(a => a.email === email);
      if (existing) { existing.password = password; } else { accounts.push({ email, password }); }
      await saveAccounts(accounts);
      if (!getActiveEmail()) { await setActiveEmail(email); }
      clearCookieCache();
      refresh();
      await postAccounts();
      break;
    }
    case 'changePassword': {
      const email = (msg.email || '').trim();
      const password = msg.password || '';
      if (!email || !password) { return; }
      const accounts = await getAccounts();
      await saveAccounts(accounts.map(a => a.email === email ? { ...a, password } : a));
      if (email === getActiveEmail()) { clearCookieCache(); }
      refresh();
      await postAccounts();
      break;
    }
    case 'remove': {
      const email = msg.email;
      if (!email) { return; }
      const accounts = await getAccounts();
      const filtered = accounts.filter(a => a.email !== email);
      await saveAccounts(filtered);
      if (getActiveEmail() === email) {
        await setActiveEmail(filtered[0] ? filtered[0].email : undefined);
        clearCookieCache();
      }
      refresh();
      await postAccounts();
      break;
    }
    case 'setOrgId':
      await setActiveOrgId((msg.orgId || '').trim());
      refresh();
      break;
    case 'autoDetectOrgId':
      try {
        const session = await getSession(false);
        if (session) { await withSessionFallback(session, (s) => autoDetectOrgId(s, true)); refresh(); }
      } catch {
        // 忽略
      }
      break;
  }
}

const dashboardProvider: vscode.WebviewViewProvider = {
  resolveWebviewView(view: vscode.WebviewView): void {
    dashboardView = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getWebviewHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: DashboardMessage) => { handleDashboardMessage(msg); });
    view.onDidDispose(() => { dashboardView = null; });
    view.onDidChangeVisibility(() => { if (view.visible) { postToPanel(); postAccounts(); } });
    postToPanel();
    postAccounts();
    if (!lastData) { refresh(); }
  }
};

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 24; i++) { s += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return s;
}

function getWebviewHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  const csp = `default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px; font-size: 13px; line-height: 1.4;
    font-family: var(--vscode-font-family, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif);
    color: var(--vscode-foreground); background: var(--vscode-sideBar-background, transparent); }
  .hello { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .email { font-size: 15px; font-weight: 700; margin: 2px 0 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card { background: var(--vscode-editorWidget-background, rgba(127,127,127,0.06));
    border: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.22));
    border-radius: 10px; padding: 13px; margin-bottom: 10px; }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
  .card-title { font-size: 14px; font-weight: 700; }
  .sub { font-size: 12px; color: var(--vscode-descriptionForeground); font-weight: 400; }
  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .badge .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .badge.ok { background: rgba(46,160,67,0.16); color: #3fb950; }
  .badge.warn { background: rgba(210,153,34,0.18); color: #d29922; }
  .badge.err { background: rgba(248,81,73,0.16); color: #f85149; }
  .amount { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .amount .big { font-size: 22px; font-weight: 700; }
  .amount .pct { font-size: 14px; font-weight: 600; color: var(--vscode-descriptionForeground); }
  .bar { height: 8px; border-radius: 999px; background: rgba(127,127,127,0.24); overflow: hidden; }
  .bar-fill { height: 100%; width: 0%; border-radius: 999px; background: linear-gradient(90deg,#34d399,#10b981); transition: width .3s ease; }
  .muted { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 8px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .stat { background: rgba(127,127,127,0.07); border: 1px solid rgba(127,127,127,0.16); border-radius: 9px; padding: 9px 11px; }
  .stat-label { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
  .stat-val { font-size: 16px; font-weight: 700; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .btn { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; border-radius: 7px; padding: 6px 10px; font-size: 13px; user-select: none;
    background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.14));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-button-border, transparent); }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,0.26)); }
  .btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .btn.primary:hover { background: var(--vscode-button-hoverBackground); }
  .form { margin-top: 11px; display: none; }
  .form.show { display: block; }
  .field { margin-bottom: 8px; }
  .field label { display: block; font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .field input, .field select { width: 100%; padding: 6px 8px; font-size: 13px; border-radius: 6px; outline: none;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.3)); }
  .field input:focus, .field select:focus { border-color: var(--vscode-focusBorder); }
  .form-btns { display: flex; gap: 6px; margin-top: 6px; }
  .acct-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 9px; border-radius: 7px; cursor: pointer;
    border: 1px solid rgba(127,127,127,0.16); margin-bottom: 6px; background: rgba(127,127,127,0.05); }
  .acct-row:hover { background: rgba(127,127,127,0.16); }
  .acct-row.active { border-color: #3fb950; }
  .acct-email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acct-del { cursor: pointer; padding: 2px 7px; border-radius: 5px; color: var(--vscode-descriptionForeground); }
  .acct-del:hover { color: #f85149; background: rgba(248,81,73,0.14); }
  .empty { font-size: 12px; color: var(--vscode-descriptionForeground); padding: 4px 0 8px; }
</style>
</head>
<body>
  <div class="hello">欢迎回来</div>
  <div class="email" id="email">--</div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">拼车额度</span>
      <span class="badge ok" id="quota-badge"><span class="dot"></span>有效</span>
    </div>
    <div class="amount"><span class="big" id="quota-amt">$-- / $--</span><span class="pct" id="quota-pct">--</span></div>
    <div class="bar"><div class="bar-fill" id="bar-fill"></div></div>
    <div class="muted" id="quota-reset"></div>
    <div class="grid" style="margin-top:11px;">
      <div class="stat"><div class="stat-label">已用</div><div class="stat-val" id="s-used">--</div></div>
      <div class="stat"><div class="stat-label">剩余</div><div class="stat-val" id="s-remain">--</div></div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">服务可用性 <span class="sub">60s 窗口</span></span>
      <span class="badge ok" id="state-badge"><span class="dot"></span>--</span>
    </div>
    <div class="grid">
      <div class="stat"><div class="stat-label">错误率</div><div class="stat-val" id="s-err">--</div></div>
      <div class="stat"><div class="stat-label">平均延迟</div><div class="stat-val" id="s-lat">--</div></div>
      <div class="stat"><div class="stat-label">请求 / 分</div><div class="stat-val" id="s-rpm">--</div></div>
      <div class="stat"><div class="stat-label">令牌 / 分</div><div class="stat-val" id="s-tpm">--</div></div>
    </div>
    <div class="muted" id="err-counts"></div>
  </div>

  <div class="card">
    <div class="card-head"><span class="card-title">操作</span></div>
    <div class="actions">
      <div class="btn" data-act="refresh">&#8635; 刷新</div>
      <div class="btn" data-act="switch">&#8644; 切换</div>
      <div class="btn" data-act="add">&#43; 添加</div>
      <div class="btn" data-act="password">&#128273; 改密</div>
      <div class="btn" data-act="org">&#127970; 组织</div>
    </div>
    <div class="form" id="form"></div>
  </div>

<script nonce="${nonce}">
  var vscode = acquireVsCodeApi();
  var last = null, accounts = [], curOrg = '', openAct = null;
  var formEl = document.getElementById('form');

  function $(id) { return document.getElementById(id); }
  function setText(id, t) { var el = $(id); if (el) { el.textContent = t; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function post(m) { vscode.postMessage(m); }
  function fmtNum(v) { if (v == null) return '-'; if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'; if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'; return String(Math.round(v)); }
  function fmtMs(v) { if (v == null) return '-'; if (v >= 1000) return (v / 1000).toFixed(2) + 's'; return Math.round(v) + 'ms'; }
  function fmtCountdown(ms) { if (ms <= 0) return '已重置'; var t = Math.floor(ms / 60000), hh = Math.floor(t / 60), mm = t % 60; return hh > 0 ? (hh + 'h ' + mm + 'm') : (mm + 'm'); }
  function setBadge(id, level, text) { var el = $(id); if (!el) return; el.className = 'badge ' + level; el.innerHTML = '<span class="dot"></span>' + esc(text); }
  function renderReset() {
    if (!last || !last.quota || !last.quota.resetAtMs) { setText('quota-reset', ''); return; }
    setText('quota-reset', '还有 ' + fmtCountdown(last.quota.resetAtMs - Date.now()) + ' 归零');
  }
  function render(p) {
    last = p;
    setText('email', p.email || '未登录');
    var q = p.quota;
    if (q) {
      var r = Math.max(0, Math.min(1, q.ratio));
      setText('quota-amt', '$' + q.usedUsd.toFixed(2) + ' / $' + q.totalUsd.toFixed(2));
      setText('quota-pct', q.pct.toFixed(1) + '%');
      var fill = $('bar-fill');
      fill.style.width = (r * 100).toFixed(1) + '%';
      var c = 'linear-gradient(90deg,#34d399,#10b981)';
      if (r >= 0.95) c = 'linear-gradient(90deg,#fb7185,#ef4444)';
      else if (r >= 0.8) c = 'linear-gradient(90deg,#fbbf24,#f59e0b)';
      fill.style.background = c;
      setBadge('quota-badge', q.enabled ? 'ok' : 'err', q.enabled ? '有效' : '未启用');
      setText('s-used', '$' + q.usedUsd.toFixed(2));
      setText('s-remain', '$' + q.remainingUsd.toFixed(2));
      renderReset();
    } else {
      setText('quota-amt', '数据获取失败'); setText('quota-pct', '');
      $('bar-fill').style.width = '0%';
      setBadge('quota-badge', 'err', '失败');
      setText('s-used', '--'); setText('s-remain', '--'); setText('quota-reset', '');
    }
    var m = p.metrics;
    if (m) {
      setBadge('state-badge', m.stateLevel, m.stateText);
      setText('s-err', m.errorRatePct.toFixed(2) + '%');
      setText('s-lat', fmtMs(m.avgLatencyMs));
      setText('s-rpm', fmtNum(m.rpm));
      setText('s-tpm', fmtNum(m.tpm));
      setText('err-counts', '错误 ' + m.errorCount + ' / ' + m.reqCount + ' 请求');
    } else {
      setBadge('state-badge', 'err', '指标失败');
      setText('s-err', '--'); setText('s-lat', '--'); setText('s-rpm', '-'); setText('s-tpm', '-'); setText('err-counts', '');
    }
  }

  function field(label, inner) { return '<div class="field"><label>' + esc(label) + '</label>' + inner + '</div>'; }
  function saveCancel(saveText) { return '<div class="form-btns"><div class="btn primary" id="f-save">' + esc(saveText) + '</div><div class="btn" id="f-cancel">取消</div></div>'; }
  function acctSelect() {
    var o = '';
    for (var i = 0; i < accounts.length; i++) { o += '<option value="' + esc(accounts[i].email) + '">' + esc(accounts[i].email) + '</option>'; }
    return '<select id="f-acct">' + o + '</select>';
  }
  function acctList() {
    if (!accounts.length) return '<div class="empty">还没有账号，点「添加」新增。</div>';
    var h = '';
    for (var i = 0; i < accounts.length; i++) {
      var a = accounts[i];
      h += '<div class="acct-row' + (a.active ? ' active' : '') + '" data-email="' + esc(a.email) + '">'
         + '<span class="acct-email">' + (a.active ? '● ' : '') + esc(a.email) + '</span>'
         + '<span class="acct-del" data-del="' + esc(a.email) + '" title="删除">&#10005;</span>'
         + '</div>';
    }
    return h + '<div class="form-btns"><div class="btn" id="f-cancel">关闭</div></div>';
  }
  function closeForm() { openAct = null; formEl.className = 'form'; formEl.innerHTML = ''; }
  function openForm(act) {
    openAct = act;
    var h = '';
    if (act === 'add') {
      h = field('邮箱', '<input id="f-email" type="text" placeholder="name@example.com">')
        + field('密码', '<input id="f-pass" type="password" placeholder="密码">')
        + saveCancel('保存');
    } else if (act === 'switch') {
      h = acctList();
    } else if (act === 'password') {
      h = field('账号', acctSelect())
        + field('新密码', '<input id="f-pass" type="password" placeholder="新密码">')
        + saveCancel('保存');
    } else if (act === 'org') {
      h = field('组织 ID (org_id)', '<input id="f-org" type="text" value="' + esc(curOrg) + '" placeholder="例如 2440">')
        + '<div class="form-btns"><div class="btn primary" id="f-save">保存</div><div class="btn" id="f-auto">自动探测</div><div class="btn" id="f-cancel">取消</div></div>';
    }
    formEl.innerHTML = h;
    formEl.className = 'form show';
    wireForm(act);
  }
  function wireForm(act) {
    var cancel = $('f-cancel'); if (cancel) cancel.onclick = closeForm;
    var save = $('f-save');
    if (act === 'add' && save) { save.onclick = function () { var e = $('f-email').value.trim(), p = $('f-pass').value; if (!e || !p) return; post({ type: 'add', email: e, password: p }); closeForm(); }; }
    if (act === 'password' && save) { save.onclick = function () { var a = $('f-acct'); if (!a) return; var e = a.value, p = $('f-pass').value; if (!e || !p) return; post({ type: 'changePassword', email: e, password: p }); closeForm(); }; }
    if (act === 'org') {
      if (save) save.onclick = function () { var v = $('f-org').value.trim(); if (!v) return; post({ type: 'setOrgId', orgId: v }); closeForm(); };
      var auto = $('f-auto'); if (auto) auto.onclick = function () { post({ type: 'autoDetectOrgId' }); closeForm(); };
    }
    if (act === 'switch') {
      var rows = formEl.querySelectorAll('.acct-row');
      for (var i = 0; i < rows.length; i++) {
        (function (row) { row.onclick = function (ev) { if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-del')) return; post({ type: 'switch', email: row.getAttribute('data-email') }); closeForm(); }; })(rows[i]);
      }
      var dels = formEl.querySelectorAll('[data-del]');
      for (var j = 0; j < dels.length; j++) {
        (function (d) { d.onclick = function (ev) { ev.stopPropagation(); post({ type: 'remove', email: d.getAttribute('data-del') }); closeForm(); }; })(dels[j]);
      }
    }
  }

  var actBtns = document.querySelectorAll('[data-act]');
  for (var i = 0; i < actBtns.length; i++) {
    (function (el) {
      el.onclick = function () {
        var a = el.getAttribute('data-act');
        if (a === 'refresh') { post({ type: 'refresh' }); return; }
        if (openAct === a) { closeForm(); } else { openForm(a); }
      };
    })(actBtns[i]);
  }

  window.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (!msg) return;
    if (msg.type === 'data') { render(msg.payload); }
    else if (msg.type === 'accounts') {
      accounts = msg.accounts || []; curOrg = msg.orgId || '';
      if (openAct === 'switch' || openAct === 'password') { openForm(openAct); }
    }
  });
  post({ type: 'getAccounts' });
  setInterval(renderReset, 30000);
</script>
</body>
</html>`;
}
