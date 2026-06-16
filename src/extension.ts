// 扩展入口：装配宿主对象、注册命令与 webview、注入跨模块回调、启动调度。
import * as vscode from 'vscode';
import { setCtx, setStatusBar, peekStatusBar } from './runtime.js';
import { migrateLegacyAccount } from './accounts.js';
import { invalidateSession } from './session.js';
import { refresh, hasData, getPanelPayload, setReauthPrompt } from './refresh.js';
import {
  dashboardProvider,
  setDashboardMessageHandler, setDashboardPayloadProvider, setDashboardActivateHandler
} from './dashboard.js';
import {
  COMMANDS, promptReenterCredentials, handleDashboardMessage, checkReclaudeCurrentAccount
} from './commands.js';
import { getRefreshCfg, resetIdleSchedule, startScheduler, disposeScheduler } from './scheduler.js';

export function activate(context: vscode.ExtensionContext): void {
  setCtx(context);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(sync~spin) reclaude';
  statusBar.show();
  setStatusBar(statusBar);
  context.subscriptions.push(statusBar);

  // 注入跨模块回调（破环）：refresh 的重输凭据弹窗、dashboard 的消息分发/数据来源/首次激活刷新
  setReauthPrompt(promptReenterCredentials);
  setDashboardMessageHandler((msg) => { handleDashboardMessage(msg); });
  setDashboardPayloadProvider(getPanelPayload);
  setDashboardActivateHandler(() => { if (!hasData()) { refresh(); } });

  for (const [id, handler] of COMMANDS) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('reclaude.dashboard', dashboardProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.onDidSaveTextDocument(() => {
      const cfg = getRefreshCfg();
      if (cfg.refreshOnSave) {
        refresh();
      }
      // 保存视为"有操作"：取消正在跑的定时调取，重新开始闲置计时
      resetIdleSchedule();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('reclaude.quotaRefreshIntervalSec') ||
        e.affectsConfiguration('reclaude.metricsRefreshIntervalSec') ||
        e.affectsConfiguration('reclaude.idleActivateSec')
      ) {
        resetIdleSchedule();
      }
      if (e.affectsConfiguration('reclaude.apiBase')) {
        invalidateSession();
        refresh();
      }
    })
  );

  startScheduler();

  migrateLegacyAccount().then(() => {
    checkReclaudeCurrentAccount();
    refresh();
  });
}

export function deactivate(): void {
  disposeScheduler();
  const statusBar = peekStatusBar();
  if (statusBar) { statusBar.dispose(); }
}
