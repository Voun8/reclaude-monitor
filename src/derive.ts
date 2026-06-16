// 派生预聚合：状态栏与 webview 共用的单一派生（消除并行计算的多套阈值/parseFloat/状态文案）
import type { QuotaData, MetricsData, StatusLevel } from './types.js';

// 状态阈值：额度用量比例 / 错误率百分比
export const RATIO_WARN = 0.8;
export const RATIO_ERR = 0.95;
export const ERR_WARN = 1;
export const ERR_ERR = 5;

export interface DerivedQuota {
  usedUsd: number;
  totalUsd: number;
  remainingUsd: number;
  ratio: number;
  pct: number;
  resetAtMs: number;
  enabled: boolean;
  level: StatusLevel; // 仅额度用量比例维度
}

export interface DerivedMetrics {
  errorRatePct: number;
  errorCount: number;
  reqCount: number;
  avgLatencyMs: number;
  rpm: number;
  tpm: number;
  stateLevel: StatusLevel; // 仅错误率维度（三档）
  stateText: string;
}

// 额度纯派生：接口字段可能为 string，统一 parseFloat 归一；quota_usd 缺失视为无数据返回 null
export function deriveQuota(q: QuotaData | null | undefined): DerivedQuota | null {
  if (!q || q.quota_usd === null || q.quota_usd === undefined) { return null; }
  const usedUsd = parseFloat(String(q.used_usd ?? '0'));
  const totalUsd = parseFloat(String(q.quota_usd ?? '0'));
  const ratio = totalUsd > 0 ? usedUsd / totalUsd : 0;
  const level: StatusLevel = ratio >= RATIO_ERR ? 'err' : ratio >= RATIO_WARN ? 'warn' : 'ok';
  return {
    usedUsd,
    totalUsd,
    remainingUsd: totalUsd - usedUsd,
    ratio,
    pct: ratio * 100,
    resetAtMs: q.resets_at_ms || 0,
    enabled: q.enabled !== false,
    level
  };
}

// 指标纯派生：错误率百分比及其三档状态（与额度 level 分开，由展示层叠加）
export function deriveMetrics(m: MetricsData | null | undefined): DerivedMetrics | null {
  if (!m) { return null; }
  const errorRatePct = (m.error_rate || 0) * 100;
  const stateLevel: StatusLevel = errorRatePct < ERR_WARN ? 'ok' : errorRatePct < ERR_ERR ? 'warn' : 'err';
  return {
    errorRatePct,
    errorCount: m.error_count || 0,
    reqCount: m.req_count || 0,
    avgLatencyMs: m.avg_latency_ms || 0,
    rpm: (m.rps || 0) * 60,
    tpm: m.tpm || 0,
    stateLevel,
    stateText: stateLevel === 'ok' ? '正常' : stateLevel === 'warn' ? '抖动' : '故障'
  };
}
