// Generates the Tools/MCP tab wireframe (explorer layout: tools tree → calls → details).
// Run: node gen-wireframe.mjs <out.svg>
import { writeFileSync } from 'node:fs';

const W = 1480, H = 1000;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const out = [];
const t = (x, y, s, o = {}) => out.push(`<text x="${x}" y="${y}"${o.size ? ` font-size="${o.size}"` : ''}${o.fill ? ` fill="${o.fill}"` : ' fill="#111827"'}${o.bold ? ' font-weight="bold"' : ''}${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.mono ? ' font-family="Consolas, Menlo, monospace"' : ''}${o.italic ? ' font-style="italic"' : ''} xml:space="preserve">${esc(s)}</text>`);
const r = (x, y, w, h, o = {}) => out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${o.fill ?? '#ffffff'}"${o.stroke ? ` stroke="${o.stroke}"` : ''}${o.dash ? ' stroke-dasharray="4 3"' : ''} rx="${o.rx ?? 3}"/>`);
const hline = (x1, x2, y, c = '#f3f4f6') => out.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${c}"/>`);
const note = (x, y, w, lines) => { r(x, y, w, 14 + lines.length * 14, { fill: '#fffbeb', stroke: '#f59e0b', dash: true }); lines.forEach((l, i) => t(x + 8, y + 16 + i * 14, l, { size: 11, fill: '#92400e' })); return 14 + lines.length * 14; };
const badge = (x, y, label, fill, color) => { const w = label.length * 6.4 + 10; r(x, y - 11, w, 15, { fill, rx: 7 }); t(x + 5, y, label, { size: 10, fill: color, bold: true }); return w; };
const chBadge = (x, y, ch) => badge(x, y, ch, ch === 'MCP' ? '#ede9fe' : '#e0f2fe', ch === 'MCP' ? '#6d28d9' : '#0369a1');
// error-rate colour scale: grey < 5 %, amber < 15 %, red above
const errColor = (p) => (p == null ? '#9ca3af' : p < 5 ? '#6b7280' : p < 15 ? '#b45309' : '#b91c1c');

r(0, 0, W, H, { fill: '#ffffff', rx: 4 });
t(20, 28, 'T-26 — Tools/MCP tab (repository level, explorer layout: tools tree → calls → call details)', { size: 15, bold: true });

// Repo main tabs
r(20, 40, W - 40, 34, { fill: '#f9fafb', stroke: '#e5e7eb' });
[['Sessions', 0], ['Analytics', 0], ['Reports', 0], ['Tools/MCP', 1], ['Settings', 0]].reduce((x, [n, a]) => {
  t(x, 62, n, { size: 13, fill: a ? '#4f46e5' : '#6b7280', bold: !!a });
  if (a) r(x - 4, 70, n.length * 8 + 8, 3, { fill: '#4f46e5', rx: 1 });
  return x + n.length * 8 + 36;
}, 36);

// Filter bar (tool selection lives in the tree now)
const fy = 84;
[['Last 30 days ▾', 120], ['Status: All ▾', 110], ['🔍 search args / output…', 260]].reduce((x, [l, w]) => {
  r(x, fy, w, 28, { fill: '#ffffff', stroke: '#d1d5db' }); t(x + 10, fy + 18, l, { size: 12, fill: '#374151' }); return x + w + 10;
}, 20);
t(560, fy + 18, 'Scope: ce › callers  ✕', { size: 12, fill: '#4f46e5' });
r(W - 190, fy, 170, 28, { fill: '#eef2ff', stroke: '#a5b4fc' }); t(W - 178, fy + 18, '⚙ Monitored tools (3)', { size: 12, fill: '#4338ca', bold: true });

const top = 124, paneH = H - top - 20;

// ── Pane 1: tools tree
const T = { x: 20, y: top, w: 300, h: paneH };
r(T.x, T.y, T.w, T.h, { stroke: '#e5e7eb' });
t(T.x + 12, T.y + 20, 'TOOLS', { size: 10, fill: '#9ca3af', bold: true });
r(T.x + T.w - 34, T.y + 7, 24, 18, { fill: '#f3f4f6', stroke: '#d1d5db' }); t(T.x + T.w - 22, T.y + 20, '«', { size: 13, fill: '#374151', anchor: 'middle', bold: true });
r(T.x + 10, T.y + 30, T.w - 20, 24, { stroke: '#d1d5db' }); t(T.x + 18, T.y + 46, '🔍 filter tools…', { size: 11, fill: '#9ca3af' });
t(T.x + 12, T.y + 72, 'Sort:', { size: 11, fill: '#6b7280' });
[['calls', 1], ['error %', 0], ['retried %', 0], ['last used', 0]].reduce((x, [n, a]) => {
  if (a) r(x - 4, T.y + 61, n.length * 6.4 + 16, 15, { fill: '#eef2ff', rx: 7 });
  t(x, T.y + 72, n + (a ? ' ▾' : ''), { size: 11, fill: a ? '#4338ca' : '#6b7280', bold: !!a }); return x + n.length * 6.4 + 22;
}, T.x + 48);
t(T.x + 150, T.y + 92, 'calls', { size: 9, fill: '#9ca3af' }); t(T.x + T.w - 14, T.y + 92, 'err', { size: 9, fill: '#9ca3af', anchor: 'end' });
// All row
let ty = T.y + 100;
const treeRow = (o) => {
  const h = 24;
  if (o.sel) { r(T.x + 1, ty, T.w - 2, h, { fill: '#eef2ff', rx: 0 }); r(T.x + 1, ty, 3, h, { fill: '#4f46e5', rx: 0 }); }
  const x0 = T.x + 10 + o.depth * 16;
  if (o.twisty) t(x0, ty + 16, o.twisty, { size: 10, fill: '#6b7280' });
  let x = x0 + (o.twisty ? 14 : 4);
  if (o.ch) x += chBadge(x, ty + 16, o.ch) + 5;
  t(x, ty + 16, o.name, { size: o.depth >= 2 ? 11 : 12, fill: o.never ? '#9ca3af' : '#111827', bold: !!o.bold, mono: o.depth >= 1 && !o.group, italic: !!o.never });
  if (o.never) { t(T.x + T.w - 14, ty + 16, 'never called', { size: 10, fill: '#9ca3af', anchor: 'end', italic: true }); }
  else if (o.calls != null) {
    t(T.x + 186, ty + 16, String(o.calls), { size: 11, fill: '#374151', anchor: 'end', mono: true });
    const bw = Math.min(56, Math.max(2, Math.round((o.calls / 523) * 56)));
    r(T.x + 192, ty + 8, 56, 8, { fill: '#f3f4f6', rx: 2 }); r(T.x + 192, ty + 8, bw, 8, { fill: '#a5b4fc', rx: 2 });
    t(T.x + T.w - 14, ty + 16, `${o.err}%`, { size: 11, fill: errColor(o.err), anchor: 'end', bold: o.err >= 15 });
  }
  ty += h;
};
treeRow({ depth: 0, name: 'All tools', calls: 801, err: 13, bold: true });
treeRow({ depth: 0, twisty: '▾', name: 'MCP · 3 servers', group: true, calls: 559, err: 18, bold: true });
treeRow({ depth: 1, twisty: '▸', ch: 'MCP', name: 'playwright', calls: 523, err: 18 });
treeRow({ depth: 1, twisty: '▸', ch: 'MCP', name: 'postgres', calls: 35, err: 11 });
treeRow({ depth: 1, twisty: '▸', ch: 'MCP', name: 'webstorm', calls: 1, err: 0 });
treeRow({ depth: 0, twisty: '▾', name: 'CLI · 3 monitored', group: true, calls: 203, err: 2, bold: true });
treeRow({ depth: 1, twisty: '▾', ch: 'CLI', name: 'ce', calls: 142, err: 3 });
treeRow({ depth: 2, name: 'callers', calls: 88, err: 2, sel: true });
treeRow({ depth: 2, name: 'query', calls: 31, err: 6 });
treeRow({ depth: 2, name: 'search', calls: 15, err: 0 });
treeRow({ depth: 2, name: 'help', calls: 8, err: 0 });
treeRow({ depth: 1, twisty: '▸', ch: 'CLI', name: 'find', calls: 61, err: 0 });
treeRow({ depth: 1, ch: 'CLI', name: 'cb', never: true });
t(T.x + 12, ty + 18, '… scrolls; 40+ tools fit', { size: 10, fill: '#9ca3af', italic: true });
note(T.x + 8, T.y + T.h - 148, T.w - 16, [
  'Tree: groups MCP / CLI → tool → operation.',
  'Click narrows the calls list (scope chip on top).',
  'calls + bar = volume; err % coloured',
  '(grey < 5 %, amber < 15 %, red ≥ 15 %).',
  'Sortable; filter box; « collapses the pane',
  'to a rail (see inset), » restores it.',
  'Monitored CLI tools never called stay visible',
  '(greyed) — wrapper missing or tool unused.',
  'Sub-agent / workflow calls included.',
]);

// ── Pane 2: calls table
const L = { x: T.x + T.w + 12, y: top, w: 450, h: paneH };
r(L.x, L.y, L.w, L.h, { stroke: '#e5e7eb' });
r(L.x, L.y, L.w, 28, { fill: '#f3f4f6', rx: 3 });
const cx = { time: 10, tool: 76, inn: 262, out: 316, st: 376 };
[['Time', cx.time], ['Tool · operation', cx.tool], ['In', cx.inn], ['Out', cx.out], ['Status', cx.st]].forEach(([n, dx]) => t(L.x + dx, L.y + 18, n, { size: 11, fill: '#6b7280', bold: true }));
const rows = [
  ['07:41:08', 'CLI', 'ce callers', '18 B', '457 B', 'ok', 'cut'],
  ['07:41:04', 'CLI', 'ce callers', '16 B', '328 B', 'ok'],
  ['07:39:51', 'CLI', 'ce callers', '22 B', '0 B', 'ok', 'empty'],
  ['07:33:20', 'CLI', 'ce callers', '15 B', '1.1 KB', 'ok', 'no wrapper'],
  ['07:29:02', 'CLI', 'ce callers', '19 B', '—', 'error'],
  ['07:22:47', 'CLI', 'ce callers', '17 B', '612 B', 'ok'],
  ['07:20:15', 'CLI', 'ce callers', '20 B', '100 KB', 'ok', 'truncated'],
  ['07:11:38', 'CLI', 'ce callers', '18 B', '—', 'terminated'],
  ['06:58:09', 'CLI', 'ce callers', '16 B', '391 B', 'ok'],
  ['06:41:30', 'CLI', 'ce callers', '21 B', '702 B', 'ok'],
];
rows.forEach(([time, ch, tool, inn, o, st, extra], i) => {
  const y = L.y + 28 + i * 30, sel = i === 0;
  if (sel) { r(L.x + 1, y, L.w - 2, 30, { fill: '#eef2ff', rx: 0 }); r(L.x + 1, y, 3, 30, { fill: '#4f46e5', rx: 0 }); }
  hline(L.x, L.x + L.w, y + 30);
  t(L.x + cx.time, y + 19, time, { size: 11, fill: '#6b7280', mono: true });
  const bw = chBadge(L.x + cx.tool, y + 19, ch);
  t(L.x + cx.tool + bw + 6, y + 19, tool, { size: 12, mono: true });
  t(L.x + cx.inn, y + 19, inn, { size: 11, fill: '#374151', mono: true });
  t(L.x + cx.out, y + 19, o, { size: 11, fill: '#374151', mono: true });
  const sc = { ok: ['✓ ok', '#047857'], error: ['✗ error', '#b91c1c'], terminated: ['⏹ killed', '#b45309'] }[st];
  t(L.x + cx.st, y + 19, sc[0], { size: 11, fill: sc[1], bold: true });
  if (extra) t(L.x + cx.st, y + 28, extra, { size: 8, fill: '#9ca3af' });
});
const ly = L.y + 28 + rows.length * 30;
t(L.x + 10, ly + 22, '◂ 1–10 of 88 (ce › callers)   ▸', { size: 11, fill: '#6b7280' });
note(L.x + 10, ly + 36, L.w - 20, [
  'Calls of the tree selection, newest first; ↑/↓ moves the selection.',
  'In / Out = input size (args or MCP params + stdin) / output size produced.',
  'Status: ok / error (MCP is_error, CLI exit ≠ 0) / killed / no result;',
  'grey hint: cut (agent saw less), empty, truncated (100 KB), no wrapper.',
  'With "All tools" selected the list mixes MCP and CLI calls.',
  'Splitters ⇔ between the panes: drag to resize; widths remembered per user.',
]);

// Inset: the tools pane collapsed to a rail (placed in the empty space under the calls list)
{
  const ix = L.x + 14, iy = ly + 150, iw = L.w - 28, ih = 150;
  r(ix, iy, iw, ih, { fill: '#ffffff', stroke: '#c4b5fd', dash: true });
  t(ix + 10, iy + 16, 'INSET — tools pane collapsed («): a 28 px rail', { size: 11, fill: '#6d28d9', bold: true });
  r(ix + 10, iy + 26, 28, ih - 36, { fill: '#f9fafb', stroke: '#e5e7eb' });
  t(ix + 24, iy + 42, '»', { size: 13, fill: '#374151', anchor: 'middle', bold: true });
  out.push(`<text x="${ix + 28}" y="${iy + 56}" font-size="10" fill="#6b7280" font-weight="bold" transform="rotate(90 ${ix + 28} ${iy + 56})">TOOLS · ce › callers</text>`);
  r(ix + 44, iy + 26, iw - 54, ih - 36, { stroke: '#e5e7eb' });
  r(ix + 44, iy + 26, iw - 54, 18, { fill: '#f3f4f6', rx: 3 });
  t(ix + 52, iy + 39, 'Time      Tool · operation           In     Out     Status', { size: 9, fill: '#6b7280', mono: true });
  [0, 1, 2, 3].forEach((i) => { hline(ix + 44, ix + iw - 10, iy + 44 + (i + 1) * 20); t(ix + 52, iy + 58 + i * 20, '07:41:0' + (8 - i) + '  ce callers                 18 B   457 B   ✓ ok', { size: 9, fill: '#374151', mono: true }); });
  t(ix + 52, iy + ih - 4, 'the rail keeps the current scope visible; the freed width goes to calls + details', { size: 9, fill: '#9ca3af', italic: true });
}

// Splitters between the panes: drag to resize; widths are remembered per user (localStorage)
const splitter = (x) => {
  r(x + 3, top + paneH / 2 - 24, 6, 48, { fill: '#e5e7eb', rx: 3 });
  [-10, -4, 2, 8].forEach((d) => r(x + 5, top + paneH / 2 + d, 2, 2, { fill: '#9ca3af', rx: 1 }));
};
splitter(T.x + T.w);
splitter(L.x + L.w);
t(T.x + T.w + 6, top + paneH / 2 + 40, '⇔', { size: 12, fill: '#6b7280', anchor: 'middle' });
t(L.x + L.w + 6, top + paneH / 2 + 40, '⇔', { size: 12, fill: '#6b7280', anchor: 'middle' });

// ── Pane 3: call detail
const R = { x: L.x + L.w + 12, y: top, w: W - 20 - (L.x + L.w + 12), h: paneH };
r(R.x, R.y, R.w, R.h, { stroke: '#e5e7eb' });
let y = R.y + 24;
let bx = chBadge(R.x + 16, y, 'CLI');
t(R.x + 22 + bx, y, 'ce callers', { size: 15, bold: true, mono: true });
const b2 = badge(R.x + 124 + bx, y, '✓ exit 0', '#d1fae5', '#047857');
badge(R.x + 130 + bx + b2, y, 'cut by agent: saw 2 of 8 lines', '#fef3c7', '#92400e');
t(R.x + R.w - 16, y, 'Open in session → turn 3 ↗', { size: 12, fill: '#4f46e5', anchor: 'end' });
y += 22;
t(R.x + 16, y, '2026-10-28 07:41:08 · 623 ms · dt@dataart.com · root agent · bash · ~/.dotnet/tools/ce', { size: 11, fill: '#6b7280' });

y += 26; t(R.x + 16, y, 'PARAMETERS', { size: 10, fill: '#9ca3af', bold: true });
y += 8; r(R.x + 16, y, R.w - 32, 74, { fill: '#f9fafb', stroke: '#e5e7eb' });
t(R.x + 28, y + 20, 'command', { size: 11, fill: '#6b7280' }); t(R.x + 100, y + 20, 'ce callers "setStatus" | head -2', { size: 12, mono: true });
t(R.x + 28, y + 40, 'args', { size: 11, fill: '#6b7280' }); t(R.x + 100, y + 40, '[0] callers   [1] setStatus', { size: 12, mono: true });
t(R.x + 28, y + 60, 'cwd', { size: 11, fill: '#6b7280' }); t(R.x + 100, y + 60, '~/src/orders', { size: 12, mono: true });
t(R.x + R.w - 28, y + 20, 'MCP: input JSON, pretty-printed', { size: 10, fill: '#9ca3af', anchor: 'end' });

y += 90; t(R.x + 16, y, 'INPUT (stdin)', { size: 10, fill: '#9ca3af', bold: true });
t(R.x + 104, y, '— only when something was piped / redirected into the tool; here: none', { size: 11, fill: '#9ca3af' });

y += 20; t(R.x + 16, y, 'OUTPUT', { size: 10, fill: '#9ca3af', bold: true });
[['Terminal', 1], ['As the agent saw it', 0], ['Raw', 0]].reduce((x, [n, a]) => { t(x, y, n, { size: 11, fill: a ? '#4f46e5' : '#6b7280', bold: !!a }); if (a) r(x, y + 4, n.length * 6.6, 2, { fill: '#4f46e5', rx: 1 }); return x + n.length * 6.6 + 20; }, R.x + 70);
r(R.x + R.w - 78, y - 14, 62, 20, { fill: '#ffffff', stroke: '#d1d5db' }); t(R.x + R.w - 47, y, '⧉ Copy', { size: 11, fill: '#374151', anchor: 'middle', bold: true });
t(R.x + R.w - 88, y, 'stdout 457 B · stderr 0 B', { size: 11, fill: '#6b7280', anchor: 'end' });
y += 10;
const termH = 220;
r(R.x + 16, y, R.w - 32, termH, { fill: '#f8fafc', stroke: '#e2e8f0', rx: 4 });
const tw = [9, 21, 8, 8, 7, 19];
const hdr = ['Target', 'Caller', 'Kind', 'Relation', 'Project', 'Location'];
const data = [
  ['setStatus', 'OrderService.checkout', 'Function', 'CALLS', 'sample', 'OrderService.java:7'],
  ['setStatus', 'OrderService.cancel', 'Function', 'CALLS', 'sample', 'OrderService.java:9'],
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
term.forEach(([s, c], i) => s && t(R.x + 30, y + 22 + i * 16, s, { size: 10.5, fill: c, mono: true }));
out.push(`<line x1="${R.x + 24}" y1="${y + 9}" x2="${R.x + 24}" y2="${y + 22 + 16 + 5}" stroke="#f59e0b" stroke-width="2"/>`);
t(R.x + 30, y + 22 + 10 * 16 + 4, '▲ amber bar = the 2 lines the agent saw (head -2); the rest never reached the agent', { size: 10, fill: '#b45309' });
y += termH + 8;
y += note(R.x + 16, y, R.w - 32, [
  'Terminal = terminal-like formatting on the normal light surface: monospace, whitespace kept, ANSI colours (light palette).',
  'Markdown pipe tables and TSV / fixed-width tables are re-aligned into a box table; Raw shows exact bytes.',
  'Valid-JSON output → collapsible JSON tree instead (below). stderr follows in its own red-tinted block.',
  'Capture limit 100 KB per call; beyond it the output is cut and the call gets a "truncated" badge.',
  '⧉ Copy copies the active view as plain text (Raw = exact bytes, JSON = pretty-printed); stderr block has its own Copy.',
]) + 20;

t(R.x + 16, y, 'SIGNALS', { size: 10, fill: '#9ca3af', bold: true });
[['opened file from output ✓', '#d1fae5', '#047857'], ['retried ✗', '#f3f4f6', '#6b7280'], ['fell back to grep ✗', '#f3f4f6', '#6b7280'], ['empty ✗', '#f3f4f6', '#6b7280']]
  .reduce((x, [l, f, c]) => x + badge(x, y, l, f, c) + 8, R.x + 80);

y += 22;
r(R.x + 16, y, R.w - 32, R.y + R.h - y - 12, { fill: '#ffffff', stroke: '#c4b5fd', dash: true });
t(R.x + 28, y + 18, 'VARIANT — valid-JSON output (e.g. MCP postgres:query): pretty-printed, collapsible JSON tree', { size: 11, fill: '#6d28d9', bold: true });
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
