// 命令适配层：收集输入 + 提示文案，复用账号数据核心；含跟随 reclaude 当前账号、
// 重输凭据交互、自动探测组织 ID、webview 消息分发与命令表。
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DEFAULT_API_BASE } from './apiBase.js';
import { getCtx } from './runtime.js';
import {
  getAccounts, saveAccounts, getActiveEmail, setActiveEmail, getActiveOrgId, setActiveOrgId,
  addOrUpdateAccount, switchTo, removeAccountCore, changeAccountPassword, clearStoredSession
} from './accounts.js';
import { configuredApiBase, invalidateSession, getSession, withSessionFallback } from './session.js';
import { autoDetectOrgId } from './http.js';
import { refresh, clearLastData } from './refresh.js';
import { postAccounts, type DashboardMessage } from './dashboard.js';

const ACCOUNTS_KEY = 'reclaude.accounts';
const COOKIE_KEY = 'reclaude.cookie';
const ACCOUNT_COOKIES_KEY = 'reclaude.accountCookies';
const LEGACY_EMAIL_KEY = 'reclaude.email';
const LEGACY_PASS_KEY = 'reclaude.password';

// 自动探测当前账号的组织 ID（含交互弹窗），两层共用：无凭据警告、成功 refresh、异常错误提示
export async function runAutoDetectOrgId(): Promise<void> {
  try {
    const session = await getSession(false);
    if (!session) { vscode.window.showWarningMessage('请先添加账号'); return; }
    const id = await withSessionFallback(session, (s) => autoDetectOrgId(s, true));
    if (id) { refresh(); }
  } catch (e) {
    const err = e as Error;
    vscode.window.showErrorMessage(`自动探测失败：${err.message || String(e)}`);
  }
}

// ============ 命令（适配层：收集输入 + 提示文案，复用账号数据核心）============
export async function addAccountCmd(): Promise<void> {
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

  const trimmedEmail = email.trim();
  const result = await addOrUpdateAccount(trimmedEmail, password);
  vscode.window.showInformationMessage(result === 'updated' ? `已更新账号密码：${trimmedEmail}` : `已添加账号：${trimmedEmail}`);
  refresh();
}

export async function switchAccountCmd(): Promise<void> {
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
  await switchTo(picked.email);
  vscode.window.showInformationMessage(`已切换到：${picked.email}`);
  refresh();
}

export async function removeAccountCmd(): Promise<void> {
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
  await removeAccountCore(picked.email);
  vscode.window.showInformationMessage(`已删除：${picked.email}`);
  refresh();
}

export async function changePasswordCmd(): Promise<void> {
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
  await changeAccountPassword(picked.email, password);
  vscode.window.showInformationMessage(`已更新 ${picked.email} 的密码`);
  refresh();
}

// 登录密码错误时，弹窗让用户重新输入账号和密码
export async function promptReenterCredentials(reason?: string): Promise<boolean> {
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
  invalidateSession();
  // 重新输入的密码要走密码重登，清掉新旧 email 的存储 Cookie 避免复用旧失效会话
  await clearStoredSession(trimmedEmail);
  if (activeEmail && activeEmail !== trimmedEmail) { await clearStoredSession(activeEmail); }
  return true;
}

export async function setCookieCmd(): Promise<void> {
  const base = configuredApiBase() || DEFAULT_API_BASE;
  const input = await vscode.window.showInputBox({
    prompt: `（备用）粘贴 ${base} 完整 Cookie；推荐用账号密码`,
    placeHolder: 'rc_sid=...',
    ignoreFocusOut: true,
    password: true
  });
  if (input && input.trim()) {
    await getCtx().secrets.store(COOKIE_KEY, input.trim());
    invalidateSession();
    vscode.window.showInformationMessage('cookie 已保存');
    refresh();
  }
}

export async function setOrgIdCmd(): Promise<void> {
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

export async function autoDetectOrgIdCmd(): Promise<void> {
  await runAutoDetectOrgId();
}

export async function clearAllCmd(): Promise<void> {
  await getCtx().secrets.delete(ACCOUNTS_KEY);
  await getCtx().secrets.delete(COOKIE_KEY);
  await getCtx().secrets.delete(ACCOUNT_COOKIES_KEY);
  await getCtx().secrets.delete(LEGACY_EMAIL_KEY);
  await getCtx().secrets.delete(LEGACY_PASS_KEY);
  await setActiveEmail(undefined);
  invalidateSession();
  clearLastData();
  vscode.window.showInformationMessage('已清除所有账号和凭证');
  refresh();
}

// ============ 跟随 reclaude 当前账号 ============
export async function checkReclaudeCurrentAccount(): Promise<void> {
  // device.json 不存在或解析失败属预期（reclaude 未登录/格式变动），仅此处静默
  let reclaudeEmail: string | undefined;
  try {
    const devicePath = path.join(os.homedir(), '.reclaude', 'device.json');
    if (!fs.existsSync(devicePath)) { return; }
    const data = JSON.parse(fs.readFileSync(devicePath, 'utf8')) as { user_email?: string };
    reclaudeEmail = data.user_email;
  } catch {
    return;
  }
  if (!reclaudeEmail) { return; }

  const active = getActiveEmail();
  if (reclaudeEmail === active) { return; }

  const accounts = await getAccounts();
  if (accounts.find(a => a.email === reclaudeEmail)) {
    await setActiveEmail(reclaudeEmail);
    invalidateSession();
    vscode.window.showInformationMessage(`检测到 reclaude 切换到 ${reclaudeEmail}，已同步`);
    refresh();
  }
}

// ============ Webview 消息分发（注入 dashboard）============
export async function handleDashboardMessage(msg: DashboardMessage): Promise<void> {
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
        await switchTo(msg.email);
        refresh();
        await postAccounts();
      }
      break;
    case 'add': {
      const email = (msg.email || '').trim();
      const password = msg.password || '';
      if (!email || !password) { return; }
      await addOrUpdateAccount(email, password);
      refresh();
      await postAccounts();
      break;
    }
    case 'changePassword': {
      const email = (msg.email || '').trim();
      const password = msg.password || '';
      if (!email || !password) { return; }
      await changeAccountPassword(email, password);
      refresh();
      await postAccounts();
      break;
    }
    case 'remove': {
      const email = msg.email;
      if (!email) { return; }
      await removeAccountCore(email);
      refresh();
      await postAccounts();
      break;
    }
    case 'setOrgId':
      await setActiveOrgId((msg.orgId || '').trim());
      refresh();
      break;
    case 'autoDetectOrgId':
      await runAutoDetectOrgId();
      break;
  }
}

// 命令 id → handler；与 package.json contributes.commands 一一对应
export const COMMANDS: ReadonlyArray<readonly [string, () => unknown]> = [
  ['reclaude.refresh', () => refresh()],
  ['reclaude.addAccount', addAccountCmd],
  ['reclaude.switchAccount', switchAccountCmd],
  ['reclaude.removeAccount', removeAccountCmd],
  ['reclaude.changePassword', changePasswordCmd],
  ['reclaude.setOrgId', setOrgIdCmd],
  ['reclaude.autoDetectOrgId', autoDetectOrgIdCmd],
  ['reclaude.setCookie', setCookieCmd],
  ['reclaude.clearAll', clearAllCmd]
];
