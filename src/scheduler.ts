// 定时调度：分钟级重渲染（tick）、跟随账号（follow）、额度轮询（quota）、
// 指标轮询（metrics）、闲置激活（idle）。私有持有全部定时器与轮询开关。
import * as vscode from 'vscode';
import { refresh, refreshMetricsOnly, tickRender } from './refresh.js';
import { checkReclaudeCurrentAccount } from './commands.js';

let tickTimer: NodeJS.Timeout | null = null;
let quotaTimer: NodeJS.Timeout | null = null;
let metricsTimer: NodeJS.Timeout | null = null;
let followTimer: NodeJS.Timeout | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let pollingActive = false;

// ============ 定时刷新调度 ============
export function getRefreshCfg() {
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
export function resetIdleSchedule(): void {
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

// 启动常驻定时器（tick 分钟级重渲染 + follow 跟随账号），并初始化闲置调度
export function startScheduler(): void {
  tickTimer = setInterval(tickRender, 60_000);
  followTimer = setInterval(checkReclaudeCurrentAccount, 10_000);
  resetIdleSchedule();
}

// 停止全部定时器（deactivate 用）
export function disposeScheduler(): void {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (followTimer) { clearInterval(followTimer); followTimer = null; }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  stopPollingTimers();
}
