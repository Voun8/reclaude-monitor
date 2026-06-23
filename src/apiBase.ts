// API 根地址相关纯函数（不读 vscode 配置，无副作用）。
// 上游 failover 已收敛到中转服务（reclaude-proxy），客户端只走单一中转地址，不再做客户端回退。

export const DEFAULT_API_BASE = 'https://proxy.mortysky.top';

export function normalizeApiBase(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) { return null; }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

export function apiUrl(apiBase: string, pathname: string): string {
  return `${apiBase}${pathname}`;
}

export function isRbacAccessDenied(body: string): boolean {
  return body.toLowerCase().includes('rbac: access denied');
}
