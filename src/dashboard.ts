// Webview 面板：私有持有 dashboardView，负责 HTML、postMessage 与消息分发。
// 破环：不 import refresh/commands。业务处理（消息分发、首次激活刷新、面板数据来源）
// 一律由 extension.ts 注入回调，dashboard 只对外做单向 post，不反向依赖刷新逻辑。
import * as vscode from 'vscode';
import { getActiveEmail, getAccounts, getActiveOrgId } from './accounts.js';

// 面板数据负载结构（由注入的 provider 生成，dashboard 不感知派生细节）
export interface PanelPayload {
  email: string | null;
  quota: unknown;
  metrics: unknown;
  history: { err: number[]; lat: number[] };
}

export interface DashboardMessage {
  type?: string;
  command?: string;
  email?: string;
  password?: string;
  orgId?: string;
}

let dashboardView: vscode.WebviewView | null = null;
let messageHandler: ((msg: DashboardMessage) => void) | null = null;
let payloadProvider: (() => PanelPayload) | null = null;
let activateHandler: (() => void) | null = null;

// 注入：webview 消息业务处理
export function setDashboardMessageHandler(fn: (msg: DashboardMessage) => void): void {
  messageHandler = fn;
}
// 注入：面板数据来源（refresh 层据 lastData/metricsHistory 生成）
export function setDashboardPayloadProvider(fn: () => PanelPayload): void {
  payloadProvider = fn;
}
// 注入：首次解析视图且无缓存数据时触发的刷新
export function setDashboardActivateHandler(fn: () => void): void {
  activateHandler = fn;
}

export function postToPanel(): void {
  if (!dashboardView || !payloadProvider) { return; }
  dashboardView.webview.postMessage({ type: 'data', payload: payloadProvider() });
}

export async function postAccounts(): Promise<void> {
  if (!dashboardView) { return; }
  const accounts = await getAccounts();
  const active = getActiveEmail();
  const orgId = await getActiveOrgId();
  dashboardView.webview.postMessage({
    type: 'accounts',
    accounts: accounts.map(a => ({ email: a.email, active: a.email === active })),
    orgId
  });
}

export const dashboardProvider: vscode.WebviewViewProvider = {
  resolveWebviewView(view: vscode.WebviewView): void {
    dashboardView = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getWebviewHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: DashboardMessage) => { if (messageHandler) { messageHandler(msg); } });
    view.onDidDispose(() => { dashboardView = null; });
    view.onDidChangeVisibility(() => { if (view.visible) { postToPanel(); postAccounts(); } });
    postToPanel();
    postAccounts();
    if (activateHandler) { activateHandler(); }
  }
};

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 24; i++) { s += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return s;
}

function getWebviewHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  const csp = `default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px; font-size: 13px; line-height: 1.4;
    font-family: var(--vscode-font-family, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif);
    color: var(--vscode-foreground); background: var(--vscode-sideBar-background, transparent); }
  .hello { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .email { font-size: 15px; font-weight: 700; margin: 2px 0 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card { background: var(--vscode-editorWidget-background, rgba(127,127,127,0.06));
    border: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.22));
    border-radius: 10px; padding: 13px; margin-bottom: 10px; }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
  .card-title { font-size: 14px; font-weight: 700; }
  .sub { font-size: 12px; color: var(--vscode-descriptionForeground); font-weight: 400; }
  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .badge .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .badge.ok { background: rgba(46,160,67,0.16); color: #3fb950; }
  .badge.warn { background: rgba(210,153,34,0.18); color: #d29922; }
  .badge.err { background: rgba(248,81,73,0.16); color: #f85149; }
  .amount { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .amount .big { font-size: 22px; font-weight: 700; }
  .amount .pct { font-size: 14px; font-weight: 600; color: var(--vscode-descriptionForeground); }
  .bar { height: 8px; border-radius: 999px; background: rgba(127,127,127,0.24); overflow: hidden; }
  .bar-fill { height: 100%; width: 0%; border-radius: 999px; background: linear-gradient(90deg,#34d399,#10b981); transition: width .3s ease; }
  .muted { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 8px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .stat { background: rgba(127,127,127,0.07); border: 1px solid rgba(127,127,127,0.16); border-radius: 9px; padding: 9px 11px; }
  .stat-label { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
  .stat-val { font-size: 16px; font-weight: 700; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .btn { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; border-radius: 7px; padding: 6px 10px; font-size: 13px; user-select: none;
    background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.14));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-button-border, transparent); }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,0.26)); }
  .btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .btn.primary:hover { background: var(--vscode-button-hoverBackground); }
  .form { margin-top: 11px; display: none; }
  .form.show { display: block; }
  .field { margin-bottom: 8px; }
  .field label { display: block; font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .field input, .field select { width: 100%; padding: 6px 8px; font-size: 13px; border-radius: 6px; outline: none;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.3)); }
  .field input:focus, .field select:focus { border-color: var(--vscode-focusBorder); }
  .form-btns { display: flex; gap: 6px; margin-top: 6px; }
  .acct-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 9px; border-radius: 7px; cursor: pointer;
    border: 1px solid rgba(127,127,127,0.16); margin-bottom: 6px; background: rgba(127,127,127,0.05); }
  .acct-row:hover { background: rgba(127,127,127,0.16); }
  .acct-row.active { border-color: #3fb950; }
  .acct-email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acct-del { cursor: pointer; padding: 2px 7px; border-radius: 5px; color: var(--vscode-descriptionForeground); }
  .acct-del:hover { color: #f85149; background: rgba(248,81,73,0.14); }
  .empty { font-size: 12px; color: var(--vscode-descriptionForeground); padding: 4px 0 8px; }
</style>
</head>
<body>
  <div class="hello">欢迎回来</div>
  <div class="email" id="email">--</div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">拼车额度</span>
      <span class="badge ok" id="quota-badge"><span class="dot"></span>有效</span>
    </div>
    <div class="amount"><span class="big" id="quota-amt">$-- / $--</span><span class="pct" id="quota-pct">--</span></div>
    <div class="bar"><div class="bar-fill" id="bar-fill"></div></div>
    <div class="muted" id="quota-reset"></div>
    <div class="grid" style="margin-top:11px;">
      <div class="stat"><div class="stat-label">已用</div><div class="stat-val" id="s-used">--</div></div>
      <div class="stat"><div class="stat-label">剩余</div><div class="stat-val" id="s-remain">--</div></div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">服务可用性 <span class="sub">60s 窗口</span></span>
      <span class="badge ok" id="state-badge"><span class="dot"></span>--</span>
    </div>
    <div class="grid">
      <div class="stat"><div class="stat-label">错误率</div><div class="stat-val" id="s-err">--</div></div>
      <div class="stat"><div class="stat-label">平均延迟</div><div class="stat-val" id="s-lat">--</div></div>
      <div class="stat"><div class="stat-label">请求 / 分</div><div class="stat-val" id="s-rpm">--</div></div>
      <div class="stat"><div class="stat-label">令牌 / 分</div><div class="stat-val" id="s-tpm">--</div></div>
    </div>
    <div class="muted" id="err-counts"></div>
  </div>

  <div class="card">
    <div class="card-head"><span class="card-title">操作</span></div>
    <div class="actions">
      <div class="btn" data-act="refresh">&#8635; 刷新</div>
      <div class="btn" data-act="switch">&#8644; 切换</div>
      <div class="btn" data-act="add">&#43; 添加</div>
      <div class="btn" data-act="password">&#128273; 改密</div>
      <div class="btn" data-act="org">&#127970; 组织</div>
    </div>
    <div class="form" id="form"></div>
  </div>

<script nonce="${nonce}">
  var vscode = acquireVsCodeApi();
  var last = null, accounts = [], curOrg = '', openAct = null;
  var formEl = document.getElementById('form');

  function $(id) { return document.getElementById(id); }
  function setText(id, t) { var el = $(id); if (el) { el.textContent = t; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function post(m) { vscode.postMessage(m); }
  function fmtNum(v) { if (v == null) return '-'; if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'; if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'; return String(Math.round(v)); }
  function fmtMs(v) { if (v == null) return '-'; if (v >= 1000) return (v / 1000).toFixed(2) + 's'; return Math.round(v) + 'ms'; }
  function fmtCountdown(ms) { if (ms <= 0) return '已重置'; var t = Math.floor(ms / 60000), hh = Math.floor(t / 60), mm = t % 60; return hh > 0 ? (hh + 'h ' + mm + 'm') : (mm + 'm'); }
  function setBadge(id, level, text) { var el = $(id); if (!el) return; el.className = 'badge ' + level; el.innerHTML = '<span class="dot"></span>' + esc(text); }
  function renderReset() {
    if (!last || !last.quota || !last.quota.resetAtMs) { setText('quota-reset', ''); return; }
    setText('quota-reset', '还有 ' + fmtCountdown(last.quota.resetAtMs - Date.now()) + ' 归零');
  }
  function render(p) {
    last = p;
    setText('email', p.email || '未登录');
    var q = p.quota;
    if (q) {
      var r = Math.max(0, Math.min(1, q.ratio));
      setText('quota-amt', '$' + q.usedUsd.toFixed(2) + ' / $' + q.totalUsd.toFixed(2));
      setText('quota-pct', q.pct.toFixed(1) + '%');
      var fill = $('bar-fill');
      fill.style.width = (r * 100).toFixed(1) + '%';
      var c = 'linear-gradient(90deg,#34d399,#10b981)';
      if (q.level === 'err') c = 'linear-gradient(90deg,#fb7185,#ef4444)';
      else if (q.level === 'warn') c = 'linear-gradient(90deg,#fbbf24,#f59e0b)';
      fill.style.background = c;
      setBadge('quota-badge', q.enabled ? 'ok' : 'err', q.enabled ? '有效' : '未启用');
      setText('s-used', '$' + q.usedUsd.toFixed(2));
      setText('s-remain', '$' + q.remainingUsd.toFixed(2));
      renderReset();
    } else {
      setText('quota-amt', '数据获取失败'); setText('quota-pct', '');
      $('bar-fill').style.width = '0%';
      setBadge('quota-badge', 'err', '失败');
      setText('s-used', '--'); setText('s-remain', '--'); setText('quota-reset', '');
    }
    var m = p.metrics;
    if (m) {
      setBadge('state-badge', m.stateLevel, m.stateText);
      setText('s-err', m.errorRatePct.toFixed(2) + '%');
      setText('s-lat', fmtMs(m.avgLatencyMs));
      setText('s-rpm', fmtNum(m.rpm));
      setText('s-tpm', fmtNum(m.tpm));
      setText('err-counts', '错误 ' + m.errorCount + ' / ' + m.reqCount + ' 请求');
    } else {
      setBadge('state-badge', 'err', '指标失败');
      setText('s-err', '--'); setText('s-lat', '--'); setText('s-rpm', '-'); setText('s-tpm', '-'); setText('err-counts', '');
    }
  }

  function field(label, inner) { return '<div class="field"><label>' + esc(label) + '</label>' + inner + '</div>'; }
  function saveCancel(saveText) { return '<div class="form-btns"><div class="btn primary" id="f-save">' + esc(saveText) + '</div><div class="btn" id="f-cancel">取消</div></div>'; }
  function acctSelect() {
    var o = '';
    for (var i = 0; i < accounts.length; i++) { o += '<option value="' + esc(accounts[i].email) + '">' + esc(accounts[i].email) + '</option>'; }
    return '<select id="f-acct">' + o + '</select>';
  }
  function acctList() {
    if (!accounts.length) return '<div class="empty">还没有账号，点「添加」新增。</div>';
    var h = '';
    for (var i = 0; i < accounts.length; i++) {
      var a = accounts[i];
      h += '<div class="acct-row' + (a.active ? ' active' : '') + '" data-email="' + esc(a.email) + '">'
         + '<span class="acct-email">' + (a.active ? '● ' : '') + esc(a.email) + '</span>'
         + '<span class="acct-del" data-del="' + esc(a.email) + '" title="删除">&#10005;</span>'
         + '</div>';
    }
    return h + '<div class="form-btns"><div class="btn" id="f-cancel">关闭</div></div>';
  }
  function closeForm() { openAct = null; formEl.className = 'form'; formEl.innerHTML = ''; }
  function openForm(act) {
    openAct = act;
    var h = '';
    if (act === 'add') {
      h = field('邮箱', '<input id="f-email" type="text" placeholder="name@example.com">')
        + field('密码', '<input id="f-pass" type="password" placeholder="密码">')
        + saveCancel('保存');
    } else if (act === 'switch') {
      h = acctList();
    } else if (act === 'password') {
      h = field('账号', acctSelect())
        + field('新密码', '<input id="f-pass" type="password" placeholder="新密码">')
        + saveCancel('保存');
    } else if (act === 'org') {
      h = field('组织 ID (org_id)', '<input id="f-org" type="text" value="' + esc(curOrg) + '" placeholder="例如 2440">')
        + '<div class="form-btns"><div class="btn primary" id="f-save">保存</div><div class="btn" id="f-auto">自动探测</div><div class="btn" id="f-cancel">取消</div></div>';
    }
    formEl.innerHTML = h;
    formEl.className = 'form show';
    wireForm(act);
  }
  function wireForm(act) {
    var cancel = $('f-cancel'); if (cancel) cancel.onclick = closeForm;
    var save = $('f-save');
    if (act === 'add' && save) { save.onclick = function () { var e = $('f-email').value.trim(), p = $('f-pass').value; if (!e || !p) return; post({ type: 'add', email: e, password: p }); closeForm(); }; }
    if (act === 'password' && save) { save.onclick = function () { var a = $('f-acct'); if (!a) return; var e = a.value, p = $('f-pass').value; if (!e || !p) return; post({ type: 'changePassword', email: e, password: p }); closeForm(); }; }
    if (act === 'org') {
      if (save) save.onclick = function () { var v = $('f-org').value.trim(); if (!v) return; post({ type: 'setOrgId', orgId: v }); closeForm(); };
      var auto = $('f-auto'); if (auto) auto.onclick = function () { post({ type: 'autoDetectOrgId' }); closeForm(); };
    }
    if (act === 'switch') {
      var rows = formEl.querySelectorAll('.acct-row');
      for (var i = 0; i < rows.length; i++) {
        (function (row) { row.onclick = function (ev) { if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-del')) return; post({ type: 'switch', email: row.getAttribute('data-email') }); closeForm(); }; })(rows[i]);
      }
      var dels = formEl.querySelectorAll('[data-del]');
      for (var j = 0; j < dels.length; j++) {
        (function (d) { d.onclick = function (ev) { ev.stopPropagation(); post({ type: 'remove', email: d.getAttribute('data-del') }); closeForm(); }; })(dels[j]);
      }
    }
  }

  var actBtns = document.querySelectorAll('[data-act]');
  for (var i = 0; i < actBtns.length; i++) {
    (function (el) {
      el.onclick = function () {
        var a = el.getAttribute('data-act');
        if (a === 'refresh') { post({ type: 'refresh' }); return; }
        if (openAct === a) { closeForm(); } else { openForm(a); }
      };
    })(actBtns[i]);
  }

  window.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (!msg) return;
    if (msg.type === 'data') { render(msg.payload); }
    else if (msg.type === 'accounts') {
      accounts = msg.accounts || []; curOrg = msg.orgId || '';
      if (openAct === 'switch' || openAct === 'password') { openForm(openAct); }
    }
  });
  post({ type: 'getAccounts' });
  setInterval(renderReset, 30000);
</script>
</body>
</html>`;
}
