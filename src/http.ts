// HTTP 与登录原语：请求封装、错误分类、登录、JSON 取数、组织 ID 自动探测。
// 无模块级可变状态；apiBase 由调用方传入。
import * as vscode from 'vscode';
import type { TaggedError, ApiSession, CarpoolAllocation } from './types.js';
import { apiUrl, isRbacAccessDenied } from './apiBase.js';
import { setActiveOrgId } from './accounts.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// ============ 登录 + 请求 ============
export function makeTagged(kind: TaggedError['kind'], message: string): TaggedError {
  const err: TaggedError = new Error(message);
  err.kind = kind;
  return err;
}

// 发起请求；网络层异常统一标记 network。仅在此包裹 fetch，body 流由调用方在 !res.ok 时读取
export async function httpRequest(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw makeTagged('network', `网络错误：${String(e)}`);
  }
}

// 由失败响应构造分类错误。仅此处消费 body 流（res.ok 时绝不调用）。
// 先判通用 403-RBAC→http；再判敏感状态码→指定 kind；否则 http + fallbackPrefix。
export async function httpError(
  res: Response,
  sensitiveStatuses: number[],
  sensitiveKind: TaggedError['kind'],
  sensitiveMessage: (status: number) => string,
  fallbackPrefix: string
): Promise<TaggedError> {
  const body = await res.text();
  if (res.status === 403 && isRbacAccessDenied(body)) {
    return makeTagged('http', `API 访问被拒绝（HTTP 403）：${body.slice(0, 200)}`);
  }
  if (sensitiveStatuses.includes(res.status)) {
    return makeTagged(sensitiveKind, sensitiveMessage(res.status));
  }
  return makeTagged('http', `${fallbackPrefix}HTTP ${res.status}: ${body.slice(0, 200)}`);
}

export async function loginAt(apiBase: string, email: string, password: string): Promise<string> {
  const res = await httpRequest(apiUrl(apiBase, '/api/auth/login'), {
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
  if (!res.ok) {
    throw await httpError(res, [400, 401, 403, 422], 'bad-credentials', (s) => `账号或密码错误（HTTP ${s}）`, '登录失败 ');
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

export function apiHeaders(cookie: string, apiBase: string): Record<string, string> {
  return {
    'accept': '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'cookie': cookie,
    'referer': `${apiBase}/app`,
    'user-agent': UA,
    'x-lang': 'zh'
  };
}

export async function fetchJSON<T = unknown>(url: string, session: ApiSession): Promise<T> {
  const res = await httpRequest(url, { headers: apiHeaders(session.cookie, session.apiBase) });
  if (!res.ok) {
    throw await httpError(res, [401, 403], 'auth', (s) => `auth-${s}`, '');
  }
  return res.json() as Promise<T>;
}

export async function autoDetectOrgId(session: ApiSession, interactive: boolean): Promise<string | null> {
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
