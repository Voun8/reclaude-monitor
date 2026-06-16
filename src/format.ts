// 展示格式化纯函数（无副作用、无外部依赖）

// 倒计时格式化；sep 为 [小时单位, 分钟单位, 时分之间分隔]，复用于状态栏（时/分）与悬浮窗（h/m）
export function fmtCountdown(ms: number, sep: [string, string, string]): string {
  if (ms <= 0) { return '已重置'; }
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  const [hu, mu, gap] = sep;
  return h > 0 ? `${h}${hu}${gap}${m}${mu}` : `${m}${mu}`;
}

export function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined) { return '-'; }
  if (v >= 1e6) { return (v / 1e6).toFixed(1) + 'M'; }
  if (v >= 1e3) { return (v / 1e3).toFixed(1) + 'k'; }
  return String(Math.round(v));
}

export function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined) { return '-'; }
  if (v >= 1000) { return (v / 1000).toFixed(2) + 's'; }
  return Math.round(v) + 'ms';
}

// 用 `━` 字符 + <span style="color"> 渲染带颜色的细横条进度条
export function buildColorBar(ratio: number, fillColor: string, trackColor: string): string {
  const barLen = 30;
  const filled = Math.max(0, Math.min(barLen, Math.round(ratio * barLen)));
  const filledPart = filled > 0 ? `<span style="color:${fillColor};">${'━'.repeat(filled)}</span>` : '';
  const emptyPart = filled < barLen ? `<span style="color:${trackColor};">${'━'.repeat(barLen - filled)}</span>` : '';
  return filledPart + emptyPart;
}

// 用 Unicode 方块字符画迷你折线图（悬停 Markdown 无法用 SVG，只能近似）
export function blockSpark(vals: number[], maxLen: number): string {
  if (!vals || vals.length === 0) { return ''; }
  const blocks = '▁▂▃▄▅▆▇█';
  const slice = vals.length > maxLen ? vals.slice(vals.length - maxLen) : vals;
  let min = Math.min(...slice);
  let max = Math.max(...slice);
  if (max - min < 1e-9) { max = min + 1; }
  return slice.map(v => blocks[Math.max(0, Math.min(7, Math.round((v - min) / (max - min) * 7)))]).join('');
}

export function latencyLabel(ms: number): string {
  if (ms < 1000) { return '流畅'; }
  if (ms < 3000) { return '正常'; }
  return '偏慢';
}
