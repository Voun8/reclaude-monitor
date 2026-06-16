// 跨模块共享的数据类型（接口字段为准，展示转换放渲染层）

export interface Account {
  email: string;
  password: string;
  orgId?: string;
}

export interface QuotaData {
  quota_usd?: string | number | null;
  used_usd?: string | number | null;
  resets_at_ms?: number;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface MetricsData {
  error_rate?: number;
  error_count?: number;
  req_count?: number;
  avg_latency_ms?: number;
  rps?: number;
  tpm?: number;
  [key: string]: unknown;
}

export interface RefreshResult {
  metrics: MetricsData | null;
  quota: QuotaData | null;
}

export interface CarpoolAllocation {
  org_id?: string | number;
  allocation_id?: string | number;
  id?: string | number;
  sku?: string;
  plan?: string;
  capacity?: number;
  [key: string]: unknown;
}

export interface TaggedError extends Error {
  kind?: 'bad-credentials' | 'auth' | 'http' | 'network';
}

export type StatusLevel = 'ok' | 'warn' | 'err';

export interface ApiSession {
  cookie: string;
  apiBase: string;
}
