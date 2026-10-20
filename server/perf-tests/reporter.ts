import * as fs from 'fs';
import * as path from 'path';
import { ScenarioResult } from './types';

interface ReportMeta {
  timestamp: string;
  baseUrl: string;
  iterations: number;
  warmupIterations: number;
}

interface Report {
  meta: ReportMeta;
  results: ScenarioResult[];
}

export function loadBaseline(outputDir: string): Report | null {
  const file = path.join(outputDir, 'baseline.json');
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Report;
    return parsed;
  } catch {
    return null;
  }
}

export function saveResults(
  outputDir: string,
  results: ScenarioResult[],
  meta: ReportMeta,
): { report: Report; baseline: Report | null } {
  fs.mkdirSync(outputDir, { recursive: true });
  const baseline = loadBaseline(outputDir);
  const report: Report = { meta, results };

  if (!baseline) {
    fs.writeFileSync(
      path.join(outputDir, 'baseline.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(
      '  JSON → tmp/perftests/baseline.json  (first run saved as baseline)',
    );
    return { report, baseline: null };
  }

  const slug = meta.timestamp
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const filename = `results_${slug}.json`;
  fs.writeFileSync(
    path.join(outputDir, filename),
    JSON.stringify(report, null, 2),
  );
  console.log(`  JSON → tmp/perftests/${filename}`);
  return { report, baseline };
}

export function renderHtml(
  report: Report,
  baseline: Report | null,
  outputDir: string,
): void {
  const slug = report.meta.timestamp
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const filename = `results_${slug}.html`;
  const html = buildHtml(report, baseline);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, filename), html, 'utf8');
  console.log(`  HTML → tmp/perftests/${filename}`);
}

function f(v: number | string): string {
  return typeof v === 'number' ? v.toFixed(1) : String(v);
}

function deltaCell(curr: number, base: number | undefined): string {
  if (base == null || base === 0) return '<td class="nd">—</td>';
  const delta = curr - base;
  const pct = ((delta / base) * 100).toFixed(1);
  const sign = delta > 0 ? '+' : '';
  const cls = delta > 5 ? 'reg' : delta < -5 ? 'imp' : 'ok';
  return `<td class="${cls}">${sign}${delta.toFixed(1)}<span class="u">ms</span> (${sign}${pct}%)</td>`;
}

function buildHtml(report: Report, baseline: Report | null): string {
  const { meta, results } = report;
  const bMap: Record<string, ScenarioResult> = {};
  if (baseline) for (const r of baseline.results) bMap[r.scenario] = r;
  const hasBL = !!baseline;

  const thExtra = hasBL ? '<th>Δ Mean</th><th>Δ P95</th>' : '';
  const rows = results
    .map((r) => {
      const b = bMap[r.scenario];
      const errCls = r.errors > 0 ? ' class="reg"' : '';
      const cells = [
        `<td class="left"><code>${r.scenario}</code></td>`,
        `<td>${r.description}</td>`,
        `<td>${r.iterations}</td>`,
        `<td>${f(r.mean)}</td>`,
        `<td>${f(r.p50)}</td>`,
        `<td><strong>${f(r.p95)}</strong></td>`,
        `<td>${f(r.p99)}</td>`,
        `<td>${f(r.min)}</td>`,
        `<td>${f(r.max)}</td>`,
        `<td${errCls}>${r.successRate}%</td>`,
        ...(hasBL
          ? [deltaCell(r.mean, b?.mean), deltaCell(r.p95, b?.p95)]
          : []),
      ].join('');
      return `<tr>${cells}</tr>`;
    })
    .join('\n    ');

  const baselineBadge = hasBL
    ? `Baseline: <strong>${baseline.meta.timestamp}</strong>`
    : '<span class="badge">This run is the baseline</span>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Perf Results — ${meta.timestamp}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#111;background:#fff;padding:24px 32px}
h1{font-size:20px;font-weight:700;margin-bottom:6px}
.meta{color:#555;font-size:13px;margin-bottom:20px;line-height:1.8}
.badge{display:inline-block;padding:2px 8px;border-radius:99px;background:#dcfce7;color:#16a34a;font-size:12px;font-weight:600}
table{border-collapse:collapse;width:100%;margin-top:4px}
th{background:#f3f4f6;padding:7px 10px;text-align:right;font-weight:600;font-size:12px;border-bottom:2px solid #d1d5db;white-space:nowrap}
th.left,td.left{text-align:left}
td{padding:6px 10px;text-align:right;border-bottom:1px solid #e5e7eb;font-variant-numeric:tabular-nums}
td:nth-child(2){color:#666;font-size:12px;text-align:left;max-width:260px}
tr:hover td{background:#f9fafb}
.imp{color:#16a34a;font-weight:600}
.reg{color:#dc2626;font-weight:600}
.ok{color:#6b7280}
.nd{color:#d1d5db}
.u{color:#9ca3af;font-size:11px;margin-left:1px}
.note{color:#6b7280;font-size:12px;margin-top:10px}
</style>
</head>
<body>
<h1>Performance Test Results</h1>
<div class="meta">
  <strong>Run:</strong> ${meta.timestamp} &nbsp;|&nbsp;
  <strong>URL:</strong> ${meta.baseUrl} &nbsp;|&nbsp;
  <strong>Iterations:</strong> ${meta.iterations} (+ ${meta.warmupIterations} warmup) &nbsp;|&nbsp;
  ${baselineBadge}
</div>
<table>
<thead>
  <tr>
    <th class="left">Scenario</th>
    <th class="left">Description</th>
    <th>Iter</th>
    <th>Mean</th>
    <th>P50</th>
    <th>P95</th>
    <th>P99</th>
    <th>Min</th>
    <th>Max</th>
    <th>Success</th>
    ${thExtra}
  </tr>
</thead>
<tbody>
    ${rows}
</tbody>
</table>
<p class="note">All times in <strong>ms</strong>. Δ columns: negative (green) = faster vs baseline, positive (red) = slower. Threshold ±5ms.</p>
</body>
</html>`;
}

export function printConsoleComparison(
  report: Report,
  baseline: Report | null,
): void {
  if (!baseline) {
    console.log('\n  No baseline found — this run is now the baseline.');
    return;
  }

  const bMap: Record<string, ScenarioResult> = {};
  for (const r of baseline.results) bMap[r.scenario] = r;

  console.log(
    '\n  ─── Δ vs Baseline ───────────────────────────────────────────────',
  );
  console.log(
    `  ${'Scenario'.padEnd(28)} ${'Mean Δ'.padStart(9)} ${'P95 Δ'.padStart(9)}  Status`,
  );
  console.log('  ' + '─'.repeat(64));

  for (const r of report.results) {
    const b = bMap[r.scenario];
    if (!b) {
      console.log(
        `  ${r.scenario.padEnd(28)} ${'(new)'.padStart(9)} ${'(new)'.padStart(9)}`,
      );
      continue;
    }
    const md = r.mean - b.mean;
    const pd = r.p95 - b.p95;
    const fmt = (v: number) => (v > 0 ? '+' : '') + v.toFixed(1) + 'ms';
    const status = md > 10 ? '⚠ SLOWER' : md < -10 ? '✓ FASTER' : '  OK';
    console.log(
      `  ${r.scenario.padEnd(28)} ${fmt(md).padStart(9)} ${fmt(pd).padStart(9)}  ${status}`,
    );
  }
  console.log('  ' + '─'.repeat(64));
}
