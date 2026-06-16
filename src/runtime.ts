// 宿主对象持有层（叶子模块）：集中保管 ExtensionContext 与 StatusBarItem，
// 供需要访问 ctx.secrets/globalState 或状态栏的模块经此取用，避免到处传引用。
import * as vscode from 'vscode';

let ctx: vscode.ExtensionContext | null = null;
let statusBar: vscode.StatusBarItem | null = null;

export function setCtx(context: vscode.ExtensionContext): void {
  ctx = context;
}

export function getCtx(): vscode.ExtensionContext {
  if (!ctx) { throw new Error('ExtensionContext 未初始化'); }
  return ctx;
}

export function setStatusBar(bar: vscode.StatusBarItem): void {
  statusBar = bar;
}

export function getStatusBar(): vscode.StatusBarItem {
  if (!statusBar) { throw new Error('StatusBarItem 未初始化'); }
  return statusBar;
}

// deactivate 期间安全取用（未 activate 过则为 null，不抛错）
export function peekStatusBar(): vscode.StatusBarItem | null {
  return statusBar;
}
