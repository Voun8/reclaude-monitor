// 会话层：单一会话缓存 + 登录。私有持有 cachedSession。
// 上游 failover 已收敛到中转（reclaude-proxy），客户端只走单一地址，不做客户端回退。
import * as vscode from 'vscode';
import type { ApiSession } from './types.js';
import { DEFAULT_API_BASE, normalizeApiBase } from './apiBase.js';
import { getCtx } from './runtime.js';
import { getActiveEmail, getActiveCredential, getStoredSessions, setStoredSession } from './accounts.js';
import { loginAt } from './http.js';

const COOKIE_KEY = 'reclaude.cookie';

// 单一会话缓存：email/configKey 为命中键（configKey = 创建时的 configuredApiBase() 快照）。
interface CachedSession {
  cookie: string;
  email: string | null;
  apiBase: string;
  configKey: string | null;
}

let cachedSession: CachedSession | null = null;

// 读取 vscode 配置的 apiBase（留空 → null，由调用方走默认中转地址）
export function configuredApiBase(): string | null {
  const raw = vscode.workspace.getConfiguration('reclaude').get<string>('apiBase', '');
  return normalizeApiBase(raw || '');
}

export function invalidateSession(): void {
  cachedSession = null;
}

// 单地址登录：上游切换由中转负责，这里不再循环多个 base。
async function login(email: string, password: string): Promise<ApiSession> {
  const apiBase = configuredApiBase() || DEFAULT_API_BASE;
  const cookie = await loginAt(apiBase, email, password);
  return { cookie, apiBase };
}

// 缓存命中键：(activeEmail, 当前 configuredApiBase()) 元组实时比对
function cacheHit(activeEmail: string | null): ApiSession | null {
  if (cachedSession && cachedSession.email === activeEmail && cachedSession.configKey === configuredApiBase()) {
    return { cookie: cachedSession.cookie, apiBase: cachedSession.apiBase };
  }
  return null;
}

export async function getSession(forceRefresh: boolean): Promise<ApiSession | null> {
  if (forceRefresh) { invalidateSession(); }
  const activeEmail = getActiveEmail();
  const hit = cacheHit(activeEmail);
  if (hit) { return hit; }

  const cred = await getActiveCredential();
  if (cred) {
    // Cookie 优先：非强制刷新时复用已持久化、且与当前配置匹配的 Cookie，避免重放明文密码。
    // 强制刷新（上次 Cookie 已 401）则跳过，直接走密码重登。
    if (!forceRefresh) {
      const stored = (await getStoredSessions())[cred.email];
      if (stored && stored.configKey === configuredApiBase()) {
        cachedSession = { cookie: stored.cookie, email: cred.email, apiBase: stored.apiBase, configKey: stored.configKey };
        return { cookie: stored.cookie, apiBase: stored.apiBase };
      }
    }
    const session = await login(cred.email, cred.password);
    const configKey = configuredApiBase();
    cachedSession = { cookie: session.cookie, email: cred.email, apiBase: session.apiBase, configKey };
    await setStoredSession(cred.email, { cookie: session.cookie, apiBase: session.apiBase, configKey });
    return session;
  }
  const manual = await getCtx().secrets.get(COOKIE_KEY);
  if (manual) {
    const apiBase = configuredApiBase() || DEFAULT_API_BASE;
    cachedSession = { cookie: manual, email: null, apiBase, configKey: configuredApiBase() };
    return { cookie: manual, apiBase };
  }
  return null;
}
