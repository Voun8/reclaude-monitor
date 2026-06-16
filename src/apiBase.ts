// API 根地址相关纯函数（不读 vscode 配置，无副作用）
import type { TaggedError } from './types.js';

export const DEFAULT_API_BASE = 'https://www.recode.cat';
export const FALLBACK_API_BASE = 'https://www.reclaude.ai';
export const LEGACY_API_BASE = 'https://reclaude.ai';

export function normalizeApiBase(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) { return null; }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

export function defaultApiBases(): string[] {
  return [DEFAULT_API_BASE, FALLBACK_API_BASE, LEGACY_API_BASE];
}

export function apiUrl(apiBase: string, pathname: string): string {
  return `${apiBase}${pathname}`;
}

export function shouldFallback(e: unknown): boolean {
  const err = e as TaggedError;
  return err.kind !== 'bad-credentials' && err.kind !== 'auth';
}

export function isRbacAccessDenied(body: string): boolean {
  return body.toLowerCase().includes('rbac: access denied');
}

export function nextApiBases(apiBase: string): string[] {
  const bases = defaultApiBases();
  const idx = bases.indexOf(apiBase);
  return bases.slice(idx >= 0 ? idx + 1 : 0);
}
