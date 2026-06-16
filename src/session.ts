// 会话层：单一会话缓存 + 登录/回退编排。私有持有 cachedSession。
import * as vscode from 'vscode';
import type { ApiSession } from './types.js';
import {
  DEFAULT_API_BASE, normalizeApiBase, defaultApiBases, shouldFallback, nextApiBases
} from './apiBase.js';
import { getCtx } from './runtime.js';
import { getActiveEmail, getActiveCredential, getStoredSessions, setStoredSession } from './accounts.js';
import { loginAt } from './http.js';

const COOKIE_KEY = 'reclaude.cookie';

// 单一会话缓存：email/configKey 为命中键（configKey = 创建时的 configuredApiBase() 快照），
// apiBase 为实际会话地址（可能已 fallback，与 configKey 不同）
interface CachedSession {
  cookie: string;
  email: string | null;
  apiBase: string;
  configKey: string | null;
}

let cachedSession: CachedSession | null = null;

// 读取 vscode 配置的 apiBase（留空 → null，由调用方走默认链）
export function configuredApiBase(): string | null {
  const raw = vscode.workspace.getConfiguration('reclaude').get<string>('apiBase', '');
  return normalizeApiBase(raw || '');
}

// 是否可继续回退到下一个默认 apiBase：仅未自定义 apiBase、当前在默认链中且非鉴权类错误
export function canFallback(apiBase: string, e: unknown): boolean {
  const bases = defaultApiBases();
  const idx = bases.indexOf(apiBase);
  return !configuredApiBase() && idx >= 0 && idx + 1 < bases.length && shouldFallback(e);
}

export function invalidateSession(): void {
  cachedSession = null;
}

export async function loginWithFallback(email: string, password: string): Promise<ApiSession> {
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
    const session = await loginWithFallback(cred.email, cred.password);
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

export async function getFallbackSession(apiBase: string): Promise<ApiSession | null> {
  if (configuredApiBase()) { return null; }
  invalidateSession();
  const bases = nextApiBases(apiBase);
  const cred = await getActiveCredential();
  if (cred) {
    let lastErr: unknown = null;
    for (const base of bases) {
      try {
        const cookie = await loginAt(base, cred.email, cred.password);
        const configKey = configuredApiBase();
        cachedSession = { cookie, email: cred.email, apiBase: base, configKey };
        await setStoredSession(cred.email, { cookie, apiBase: base, configKey });
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
  const manual = await getCtx().secrets.get(COOKIE_KEY);
  if (!manual) { return null; }
  const base = bases[0];
  if (!base) { return null; }
  cachedSession = { cookie: manual, email: null, apiBase: base, configKey: configuredApiBase() };
  return { cookie: manual, apiBase: base };
}

export async function withSessionFallback<T>(
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
