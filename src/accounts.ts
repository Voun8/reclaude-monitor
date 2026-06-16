// 账号存储与 CRUD 核心：secrets 中的账号列表、活动账号、组织 ID、存储 Cookie 助手。
// 无 UI / 无 refresh / 无 postAccounts，供命令层与 webview 层共用。
import * as vscode from 'vscode';
import type { Account } from './types.js';
import { getCtx } from './runtime.js';
import { invalidateSession } from './session.js';

const ACCOUNTS_KEY = 'reclaude.accounts';
const ACTIVE_EMAIL_STATE = 'reclaude.activeEmail';
const ACCOUNT_COOKIES_KEY = 'reclaude.accountCookies';
const LEGACY_EMAIL_KEY = 'reclaude.email';
const LEGACY_PASS_KEY = 'reclaude.password';

// ============ 账号存储 ============
export async function getAccounts(): Promise<Account[]> {
  const raw = await getCtx().secrets.get(ACCOUNTS_KEY);
  if (!raw) { return []; }
  try { return JSON.parse(raw) as Account[]; } catch { return []; }
}
export async function saveAccounts(list: Account[]): Promise<void> {
  await getCtx().secrets.store(ACCOUNTS_KEY, JSON.stringify(list));
}

// 账号 Cookie 持久化：登录拿到的 Cookie 也存进 keychain，下次优先复用，
// 仅当 Cookie 失效（401 → 强制刷新）时才用密码重登 —— 削减明文密码重放频次。
// configKey = 存储时的 configuredApiBase() 快照，配置变更后不复用；apiBase = Cookie 实际所属地址。
export interface StoredSession { cookie: string; apiBase: string; configKey: string | null; }
export async function getStoredSessions(): Promise<Record<string, StoredSession>> {
  const raw = await getCtx().secrets.get(ACCOUNT_COOKIES_KEY);
  if (!raw) { return {}; }
  try { return JSON.parse(raw) as Record<string, StoredSession>; } catch { return {}; }
}
export async function setStoredSession(email: string, s: StoredSession): Promise<void> {
  const map = await getStoredSessions();
  map[email] = s;
  await getCtx().secrets.store(ACCOUNT_COOKIES_KEY, JSON.stringify(map));
}
export async function clearStoredSession(email: string): Promise<void> {
  const map = await getStoredSessions();
  if (email in map) {
    delete map[email];
    await getCtx().secrets.store(ACCOUNT_COOKIES_KEY, JSON.stringify(map));
  }
}
export function getActiveEmail(): string | null {
  return getCtx().globalState.get<string>(ACTIVE_EMAIL_STATE) || null;
}
export async function setActiveEmail(email: string | undefined): Promise<void> {
  await getCtx().globalState.update(ACTIVE_EMAIL_STATE, email || undefined);
}
export async function getActiveCredential(): Promise<Account | null> {
  const email = getActiveEmail();
  if (!email) { return null; }
  const accounts = await getAccounts();
  return accounts.find(a => a.email === email) || null;
}

// 组织 ID 跟着账号走：优先用当前账号自己存的 orgId；
// 仅在"备用 Cookie 模式"（没有账号）时回退到全局配置 reclaude.orgId。
export async function getActiveOrgId(): Promise<string> {
  const cred = await getActiveCredential();
  if (cred) { return (cred.orgId || '').trim(); }
  return vscode.workspace.getConfiguration('reclaude').get<string>('orgId', '').trim();
}

// 把组织 ID 存到当前账号上；没有账号（Cookie 模式）时才落到全局配置。
export async function setActiveOrgId(orgId: string): Promise<void> {
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
export async function migrateLegacyAccount(): Promise<void> {
  const accounts = await getAccounts();
  if (accounts.length > 0) { return; }
  const oldEmail = await getCtx().secrets.get(LEGACY_EMAIL_KEY);
  const oldPass = await getCtx().secrets.get(LEGACY_PASS_KEY);
  if (oldEmail && oldPass) {
    await saveAccounts([{ email: oldEmail, password: oldPass }]);
    await setActiveEmail(oldEmail);
    await getCtx().secrets.delete(LEGACY_EMAIL_KEY);
    await getCtx().secrets.delete(LEGACY_PASS_KEY);
  }
}

// ============ 账号数据核心（无 UI / 无 postAccounts / 无 refresh，供命令层与 webview 层共用）============
// 新增或更新账号密码；失效会话无条件。返回 'added' | 'updated' 供调用方决定提示文案
export async function addOrUpdateAccount(email: string, password: string): Promise<'added' | 'updated'> {
  const accounts = await getAccounts();
  const existing = accounts.find(a => a.email === email);
  let result: 'added' | 'updated';
  if (existing) { existing.password = password; result = 'updated'; }
  else { accounts.push({ email, password }); result = 'added'; }
  await saveAccounts(accounts);
  // 改密后旧 Cookie 可能失配，清掉让新密码重新登录（新增账号则为 no-op）
  await clearStoredSession(email);
  if (!getActiveEmail()) { await setActiveEmail(email); }
  invalidateSession();
  return result;
}

// 切换当前账号；失效会话无条件
export async function switchTo(email: string): Promise<void> {
  await setActiveEmail(email);
  invalidateSession();
}

// 删除账号；仅当删的是当前账号时回退到首个账号并失效会话
export async function removeAccountCore(email: string): Promise<void> {
  const accounts = await getAccounts();
  const filtered = accounts.filter(a => a.email !== email);
  await saveAccounts(filtered);
  await clearStoredSession(email);
  if (getActiveEmail() === email) {
    await setActiveEmail(filtered[0] ? filtered[0].email : undefined);
    invalidateSession();
  }
}

// 改密；仅当改的是当前账号时失效会话（email 不变，必须显式失效）
export async function changeAccountPassword(email: string, password: string): Promise<void> {
  const accounts = await getAccounts();
  await saveAccounts(accounts.map(a => a.email === email ? { ...a, password } : a));
  await clearStoredSession(email);
  if (email === getActiveEmail()) { invalidateSession(); }
}
