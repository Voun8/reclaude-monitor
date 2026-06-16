// 状态栏渲染：setStatus 设状态/背景色，render 消费派生数据生成 Markdown 悬浮窗。
import * as vscode from 'vscode';
import type { QuotaData, MetricsData, StatusLevel } from './types.js';
import { fmtCountdown, fmtNum, fmtMs, buildColorBar, blockSpark, latencyLabel } from './format.js';
import { deriveQuota, deriveMetrics } from './derive.js';
import { getStatusBar } from './runtime.js';
import { getActiveEmail } from './accounts.js';
import { postToPanel } from './dashboard.js';

export function setStatus(text: string, command: string, level: StatusLevel, tooltip?: string | vscode.MarkdownString): void {
  const statusBar = getStatusBar();
  statusBar.text = text;
  statusBar.command = command;
  statusBar.tooltip = tooltip || '';
  if (level === 'err') {
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    statusBar.color = undefined;
  } else if (level === 'warn') {
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusBar.color = undefined;
  } else {
    statusBar.backgroundColor = undefined;
    statusBar.color = new vscode.ThemeColor('reclaudeMonitor.statusForeground');
  }
}

// metricsHistory 由 refresh 层持有，渲染时传入（迷你折线图数据）
export function render(rawQuota: QuotaData | null, rawMetrics: MetricsData | null, metricsHistory: { err: number; lat: number }[]): void {
  const quota = deriveQuota(rawQuota);
  const metrics = deriveMetrics(rawMetrics);

  // 状态栏整体 level：额度比例为基准，错误率叠加（err 直接升级；warn 仅在仍为 ok 时降级）
  let mainText: string;
  let level: StatusLevel = 'ok';
  if (quota) {
    level = quota.level;
    const countdown = quota.resetAtMs ? fmtCountdown(quota.resetAtMs - Date.now(), ['时', '分', '']) : '?';
    mainText = `$${quota.usedUsd.toFixed(2)}/$${quota.totalUsd.toFixed(0)} · ${countdown}`;
  } else {
    mainText = '拼车数据获取失败';
    level = 'err';
  }

  let errText: string;
  if (metrics) {
    if (metrics.stateLevel === 'err') { level = 'err'; }
    else if (metrics.stateLevel === 'warn' && level === 'ok') { level = 'warn'; }
    errText = ` · 错误 ${metrics.errorRatePct.toFixed(1)}%`;
  } else {
    errText = ' · 指标失败';
  }

  const icon = level === 'err' ? '$(flame)' : level === 'warn' ? '$(warning)' : '$(zap)';
  const activeEmail = getActiveEmail();
  mainText = `${mainText}${errText}`;

  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportThemeIcons = true;
  md.supportHtml = true;

  const MUTED = '#8aa0bd';

  // ── 账号 ──
  if (activeEmail) {
    md.appendMarkdown(`$(account)&nbsp; **${activeEmail}**\n\n`);
  }

  // ── 额度 ──
  if (quota) {
    const accent = quota.level === 'err' ? '#f87171' : quota.level === 'warn' ? '#fbbf24' : '#4aa3ff';
    const bar = buildColorBar(quota.ratio, accent, '#44506a');
    const resetTxt = quota.resetAtMs ? fmtCountdown(quota.resetAtMs - Date.now(), ['h', 'm', ' ']) : '?';

    md.appendMarkdown(`$(clock) 重置: **${resetTxt}**\n\n`);
    md.appendMarkdown(`#### 用量: <span style="color:${accent};">${quota.pct.toFixed(1)}%</span>\n\n`);
    md.appendMarkdown(`${bar}\n\n`);
    md.appendMarkdown(`$(credit-card) 已用: &nbsp;**$${quota.usedUsd.toFixed(2)}** &nbsp;&nbsp;&nbsp; $(server) 剩余: <span style="color:#5fd39a;">**$${quota.remainingUsd.toFixed(2)}**</span>${!quota.enabled ? ` &nbsp; <span style="color:#f87171;">$(circle-slash) 未启用</span>` : ''}\n\n`);
  } else {
    md.appendMarkdown(`<span style="color:#f87171;">$(error) **拼车数据获取失败**</span>\n\n`);
  }

  // ── 可用性（纵向两列表格，避免窄悬浮窗三列错位）──
  if (metrics) {
    const stLevel = metrics.stateLevel;
    const stColor = stLevel === 'ok' ? '#4ade80' : stLevel === 'warn' ? '#fbbf24' : '#f87171';
    const stIcon = stLevel === 'ok' ? '$(pass-filled)' : stLevel === 'warn' ? '$(warning)' : '$(error)';
    const stSub = stLevel === 'ok' ? '稳定' : stLevel === 'warn' ? '不稳定' : '中断';
    const errColor = stColor;
    const errSpark = blockSpark(metricsHistory.map(h => h.err), 8);
    const latSpark = blockSpark(metricsHistory.map(h => h.lat), 8);

    md.appendMarkdown(`| $(pulse) 服务可用性 | <span style="color:${MUTED};">60s 窗口</span> |\n|:--|:--|\n`);
    md.appendMarkdown(`| <span style="color:${MUTED};">状态</span> | <span style="color:${stColor};">${stIcon} **${metrics.stateText}**</span> &nbsp;<span style="color:${MUTED};">${stSub}</span> |\n`);
    md.appendMarkdown(`| <span style="color:${MUTED};">错误率</span> | <span style="color:${errColor};">**${metrics.errorRatePct.toFixed(2)}%**</span> &nbsp;<span style="color:${MUTED};">${metrics.errorCount}/${metrics.reqCount}</span> &nbsp;<span style="color:${errColor};">${errSpark}</span> |\n`);
    md.appendMarkdown(`| <span style="color:${MUTED};">平均延迟</span> | <span style="color:#4aa3ff;">**${fmtMs(metrics.avgLatencyMs)}**</span> &nbsp;<span style="color:${MUTED};">${latencyLabel(metrics.avgLatencyMs)}</span> &nbsp;<span style="color:#4aa3ff;">${latSpark}</span> |\n\n`);
  } else {
    md.appendMarkdown(`#### $(pulse) 服务可用性\n\n<span style="color:#f87171;">*指标获取失败*</span>\n\n`);
  }

  // ── 速率 ──
  if (metrics) {
    md.appendMarkdown(`#### $(dashboard) 速率 <span style="color:${MUTED};">(1分钟窗口)</span>\n\n`);
    md.appendMarkdown(`- 请求: &nbsp;→ **${fmtNum(metrics.rpm)}** / 分\n`);
    md.appendMarkdown(`- 令牌: &nbsp;$(database) **${fmtNum(metrics.tpm)}** / 分\n\n`);
  }

  // ── 操作 ──
  md.appendMarkdown(`**操作:**\n\n`);
  md.appendMarkdown(`[$(refresh) 刷新](command:reclaude.refresh) &nbsp;&nbsp; [$(arrow-swap) 切换](command:reclaude.switchAccount) &nbsp;&nbsp; [$(add) 添加](command:reclaude.addAccount) &nbsp;&nbsp; [$(key) 改密](command:reclaude.changePassword) &nbsp;&nbsp; [$(organization) 组织](command:reclaude.setOrgId)`);

  setStatus(`${icon} ${mainText}`, 'reclaude.dashboard.focus', level, md);
  postToPanel();
}
