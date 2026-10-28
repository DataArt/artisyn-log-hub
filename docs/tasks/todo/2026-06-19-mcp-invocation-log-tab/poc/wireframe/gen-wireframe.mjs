// Generates the Tools/MCP tab wireframe (explorer layout). Run: node gen-wireframe.mjs <out.svg>
import { writeFileSync } from 'node:fs';

const W = 1280, H = 960;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const out = [];
const t = (x, y, s, o = {}) => out.push(`<text x="${x}" y="${y}"${o.size ? ` font-size="${o.size}"` : ''}${o.fill ? ` fill="${o.fill}"` : ' fill="#111827"'}${o.bold ? ' font-weight="bold"' : ''}${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.mono ? ' font-family="Consolas, Menlo, monospace"' : ''} xml:space="preserve">${esc(s)}</text>`);
const r = (x, y, w, h, o = {}) => out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${o.fill ?? '#ffffff'}"${o.stroke ? ` stroke="${o.stroke}"` : ''}${o.dash ? ' stroke-dasharray="4 3"' : ''} rx="${o.rx ?? 3}"/>`);
const note = (x, y, w, lines) => { r(x, y, w, 14 + lines.length * 14, { fill: '#fffbeb', stroke: '#f59e0b', dash: true }); lines.forEach((l, i) => t(x + 8, y + 16 + i * 14, l, { size: 11, fill: '#92400e' })); };
const badge = (x, y, label, fill, color) => { const w = label.length * 6.4 + 10; r(x, y - 11, w, 15, { fill, rx: 7 }); t(x + 5, y, label, { size: 10, fill: color, bold: true }); return w; };

r(0, 0, W, H, { fill: '#ffffff', rx: 4 });
t(20, 28, 'T-26 — Tools/MCP tab (repository level, explorer layout)', { size: 15, bold: true });

// Repo main tabs
r(20, 40, W - 40, 34, { fill: '#f9fafb', stroke: '#e5e7eb' });
[['Sessions', 0], ['Analytics', 0], ['Reports', 0], ['Tools/MCP', 1], ['Settings', 0]].reduce((x, [n, a]) => {
  t(x, 62, n, { size: 13, fill: a ? '#4f46e5' : '#6b7280', bold: !!a });
  if (a) r(x - 4, 70, n.length * 8 + 8, 3, { fill: '#4f46e5', rx: 1 });
  return x + n.length * 8 + 36;
}, 36);

// Filter bar
const fy = 84;
[['Last 30 days ▾', 120], ['Tool: All ▾', 110], ['Channel: All ▾', 120], ['Status: All ▾', 110], ['🔍 search args / output…', 220]].reduce((x, [l, w]) => {
  r(x, fy, w, 28, { fill: '#ffffff', stroke: '#d1d5db' }); t(x + 10, fy + 18, l, { size: 12, fill: '#374151' }); return x + w + 10;
}, 20);
r(W - 190, fy, 170, 28, { fill: '#eef2ff', stroke: '#a5b4fc' }); t(W - 178, fy + 18, '⚙ Monitored tools (3)', { size: 12, fill: '#4338ca', bold: true });

// Per-tool summary chips
const cy = 128;
t(20, cy + 14, 'TOOLS', { size: 10, fill: '#9ca3af', bold: true });
[['CLI', 'ce', '142 calls · 3% err · 21% retried'], ['MCP', 'playwright', '523 calls · 18% err'], ['MCP', 'postgres', '35 calls · 11% err'], ['CLI', 'find', '61 calls · 0% err']].reduce((x, [ch, n, s]) => {
  const w = 30 + (n.length + s.length) * 6.6 + 30;
  r(x, cy, w, 22, { fill: '#f9fafb', stroke: '#e5e7eb', rx: 11 });
  const bw = badge(x + 6, cy + 15, ch, ch === 'MCP' ? '#ede9fe' : '#e0f2fe', ch === 'MCP' ? '#6d28d9' : '#0369a1');
  t(x + 12 + bw, cy + 15, n, { size: 12, bold: true }); t(x + 18 + bw + n.length * 7.2, cy + 15, s, { size: 11, fill: '#6b7280' });
  return x + w + 8;
}, 70);

// ── Left pane: calls table
const L = { x: 20, y: 162, w: 520, h: 780 };
r(L.x, L.y, L.w, L.h, { stroke: '#e5e7eb' });
r(L.x, L.y, L.w, 28, { fill: '#f3f4f6', rx: 3 });
const cols = [['Time', 10], ['Tool · operation', 92], ['In', 330], ['Out', 385], ['Status', 446]];
cols.forEach(([n, dx]) => t(L.x + dx, L.y + 18, n, { size: 11, fill: '#6b7280', bold: true }));
const rows = [
  ['07:41:08', 'CLI', 'ce callers', '18 B', '457 B', 'ok', 'cut'],
  ['07:41:05', 'CLI', 'ce query', '214 B', '275 B', 'ok'],
  ['07:41:04', 'CLI', 'ce callers', '16 B', '328 B', 'ok'],
  ['07:40:59', 'CLI', 'ce help', '0 B', '4.2 KB', 'ok'],
  ['07:38:12', 'MCP', 'postgres:query', '96 B', '1.3 KB', 'ok'],
  ['07:37:50', 'MCP', 'playwright:browser_navigate', '41 B', '212 B', 'error'],
  ['07:37:31', 'MCP', 'playwright:browser_snapshot', '2 B', '3.8 KB', 'ok'],
  ['07:36:02', 'CLI', 'find', '24 B', '573 B', 'ok'],
  ['07:35:40', 'CLI', 'ce search', '12 B', '0 B', 'ok', 'empty'],
  ['07:35:11', 'CLI', 'ce trace', '30 B', '—', 'terminated'],
  ['07:34:58', 'MCP', 'postgres:query', '120 B', '88 B', 'error'],
  ['07:33:20', 'CLI', 'ce callers', '15 B', '1.1 KB', 'ok', 'no wrapper'],
];
rows.forEach(([time, ch, tool, inn, o, st, extra], i) => {
  const y = L.y + 28 + i * 30, sel = i === 0;
  if (sel) r(L.x + 1, y, L.w - 2, 30, { fill: '#eef2ff', rx: 0 });
  if (sel) r(L.x + 1, y, 3, 30, { fill: '#4f46e5', rx: 0 });
  out.push(`<line x1="${L.x}" y1="${y + 30}" x2="${L.x + L.w}" y2="${y + 30}" stroke="#f3f4f6"/>`);
  t(L.x + 10, y + 19, time, { size: 11, fill: '#6b7280', mono: true });
  const bw = badge(L.x + 74, y + 19, ch, ch === 'MCP' ? '#ede9fe' : '#e0f2fe', ch === 'MCP' ? '#6d28d9' : '#0369a1');
  t(L.x + 80 + bw, y + 19, tool.length > 27 ? tool.slice(0, 26) + '…' : tool, { size: 12, mono: true });
  t(L.x + 330, y + 19, inn, { size: 11, fill: '#374151', mono: true });
  t(L.x + 385, y + 19, o, { size: 11, fill: '#374151', mono: true });
  const sc = { ok: ['✓ ok', '#047857'], error: ['✗ error', '#b91c1c'], terminated: ['⏹ killed', '#b45309'] }[st];
  t(L.x + 446, y + 19, sc[0], { size: 11, fill: sc[1], bold: true });
  if (extra) t(L.x + 446, y + 28, extra, { size: 8, fill: '#9ca3af' });
});
t(L.x + 10, L.y + 28 + rows.length * 30 + 22, '◂ 1–12 of 761   ▸', { size: 11, fill: '#6b7280' });
note(L.x + 10, L.y + 28 + rows.length * 30 + 36, 500, [
  'Explorer list: newest first, one row per call, both channels mixed.',
  'In / Out = input size (args or MCP params + stdin) / output size the tool produced.',
  'Status: ok / error (MCP is_error, CLI exit ≠ 0) / killed (no exit record) / no result.',
  'Small grey hint under status: cut (agent saw less), empty, no wrapper (transcript only).',
  'Click a row → details on the right; ↑/↓ keys move the selection.',
]);

// ── Right pane: call detail
const R = { x: 552, y: 162, w: W - 572, h: 780 };
r(R.x, R.y, R.w, R.h, { stroke: '#e5e7eb' });
let y = R.y + 24;
let bx = badge(R.x + 16, y, 'CLI', '#e0f2fe', '#0369a1');
t(R.x + 22 + bx, y, 'ce callers', { size: 15, bold: true, mono: true });
badge(R.x + 130 + bx, y, '✓ exit 0', '#d1fae5', '#047857');
badge(R.x + 200 + bx, y, 'cut by agent: saw 2 of 8 lines', '#fef3c7', '#92400e');
t(R.x + R.w - 16, y, 'Open in session → turn 3  ↗', { size: 12, fill: '#4f46e5', anchor: 'end' });
y += 22;
t(R.x + 16, y, '2026-10-28 07:41:08 · 623 ms · dt@dataart.com · root agent · bash · C:\\Users\\Den\\.dotnet\\tools\\ce.exe', { size: 11, fill: '#6b7280' });

// Parameters
y += 26; t(R.x + 16, y, 'PARAMETERS', { size: 10, fill: '#9ca3af', bold: true });
y += 8; r(R.x + 16, y, R.w - 32, 74, { fill: '#f9fafb', stroke: '#e5e7eb' });
t(R.x + 28, y + 20, 'command', { size: 11, fill: '#6b7280' }); t(R.x + 100, y + 20, 'ce callers "setStatus" | head -2', { size: 12, mono: true });
t(R.x + 28, y + 40, 'args', { size: 11, fill: '#6b7280' }); t(R.x + 100, y + 40, '[0] callers   [1] setStatus', { size: 12, mono: true });
t(R.x + 28, y + 60, 'cwd', { size: 11, fill: '#6b7280' }); t(R.x + 100, y + 60, 'D:\\work\\orders', { size: 12, mono: true });
t(R.x + R.w - 28, y + 20, 'MCP: input JSON, pretty-printed', { size: 10, fill: '#9ca3af', anchor: 'end' });

// Stdin
y += 90; t(R.x + 16, y, 'INPUT (stdin)', { size: 10, fill: '#9ca3af', bold: true });
t(R.x + 110, y, '— shown only when something was piped / redirected into the tool; here: none', { size: 11, fill: '#9ca3af' });

// Output
y += 20; t(R.x + 16, y, 'OUTPUT', { size: 10, fill: '#9ca3af', bold: true });
const tabs = [['Terminal', 1], ['As the agent saw it', 0], ['Raw', 0]];
tabs.reduce((x, [n, a]) => { t(x, y, n, { size: 11, fill: a ? '#4f46e5' : '#6b7280', bold: !!a }); if (a) r(x, y + 4, n.length * 6.6, 2, { fill: '#4f46e5', rx: 1 }); return x + n.length * 6.6 + 22; }, R.x + 80);
t(R.x + R.w - 16, y, 'stdout 457 B · stderr 0 B   ⧉ copy', { size: 11, fill: '#6b7280', anchor: 'end' });
y += 10;
const termH = 236;
r(R.x + 16, y, R.w - 32, termH, { fill: '#f8fafc', stroke: '#e2e8f0', rx: 4 });
const tw = [9, 21, 8, 8, 7, 25];
const hdr = ['Target', 'Caller', 'Kind', 'Relation', 'Project', 'Location (File:Line)'];
const data = [
  ['setStatus', 'OrderService.checkout', 'Function', 'CALLS', 'sample', 'src/…/OrderService.java:7'],
  ['setStatus', 'OrderService.cancel', 'Function', 'CALLS', 'sample', 'src/…/OrderService.java:9'],
];
const line = (l, m, rr) => l + tw.map((w) => '─'.repeat(w + 2)).join(m) + rr;
const row = (cells) => '│' + cells.map((c, i) => ` ${c.padEnd(tw[i])} `).join('│') + '│';
const term = [
  ['### Callers & Inbound References for `setStatus`', '#1d4ed8'],
  ['', ''],
  ['Total Inbound Callers: 2', '#1f2937'],
  ['', ''],
  [line('┌', '┬', '┐'), '#94a3b8'],
  [row(hdr), '#111827'],
  [line('├', '┼', '┤'), '#94a3b8'],
  ...data.map((d) => [row(d), '#374151']),
  [line('└', '┴', '┘'), '#94a3b8'],
];
term.forEach(([s, c], i) => s && t(R.x + 30, y + 22 + i * 16, s, { size: 11, fill: c, mono: true }));
out.push(`<line x1="${R.x + 24}" y1="${y + 9}" x2="${R.x + 24}" y2="${y + 22 + 16 + 5}" stroke="#f59e0b" stroke-width="2"/>`);
t(R.x + 30, y + 22 + 10 * 16 + 4, '▲ amber bar = the 2 lines the agent saw (head -2); everything below it never reached the agent', { size: 10, fill: '#b45309' });
y += termH + 8;
note(R.x + 16, y, R.w - 32, [
  'Terminal view = terminal-like rendering on the normal light surface: monospace, whitespace kept, ANSI colours (light palette), h-scroll.',
  'Markdown pipe tables (| a | b |) and TSV/fixed-width tables are re-aligned into a box table as above; Raw shows exact bytes.',
  'If the whole output is valid JSON → JSON view instead (see below). stderr, when present, follows in its own red-tinted block.',
  'Capture limit: 100 KB per call (stdout + stderr). Beyond it the output is cut and the call gets a "truncated" badge.',
]);

// Signals
y += 92; t(R.x + 16, y, 'SIGNALS', { size: 10, fill: '#9ca3af', bold: true });
[['opened file from output ✓', '#d1fae5', '#047857'], ['retried ✗', '#f3f4f6', '#6b7280'], ['fell back to grep ✗', '#f3f4f6', '#6b7280'], ['empty ✗', '#f3f4f6', '#6b7280']]
  .reduce((x, [l, f, c]) => x + badge(x, y, l, f, c) + 8, R.x + 80);

// JSON variant
y += 22;
r(R.x + 16, y, R.w - 32, R.y + R.h - y - 12, { fill: '#ffffff', stroke: '#c4b5fd', dash: true });
t(R.x + 28, y + 18, 'VARIANT — output is valid JSON (e.g. MCP postgres:query): OUTPUT shows a pretty-printed, collapsible JSON tree', { size: 11, fill: '#6d28d9', bold: true });
const js = [
  ['▾ {', '#334155'],
  ['    "rows": ▾ [', '#334155'],
  ['        { "id": 4127, "repo_url": "github.com/acme/orders", "sessions": 38 },', '#0f766e'],
  ['        { "id": 4131, "repo_url": "github.com/acme/billing", "sessions": 12 }', '#0f766e'],
  ['    ],', '#334155'],
  ['    "rowCount": 2,   "command": "SELECT"', '#b45309'],
  ['  }', '#334155'],
];
r(R.x + 28, y + 28, R.w - 56, js.length * 15 + 12, { fill: '#f8fafc', stroke: '#e2e8f0' });
js.forEach(([s, c], i) => t(R.x + 40, y + 46 + i * 15, s, { size: 11, fill: c, mono: true }));

writeFileSync(process.argv[2], `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="12">\n${out.join('\n')}\n</svg>\n`);
