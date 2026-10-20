#!/usr/bin/env node
// Coverage and mutation baselines of the test suites, and their comparison (impl-plan DD L1, L2).
//
// Coverage (--kind coverage, the default):
//   Reads every istanbul `coverage-final.json` under --coverage-dir (jest `json` reporter, vitest
//   `json`, `c8 --reporter=json`, the scenario stand's c8 report ...), keeps only product sources
//   under server/src, client/src and hook/.claude/telemetry_tool (test files dropped), and merges
//   them by LINE: a line counts when a statement starts on it, and is covered when any source ran
//   such a statement. Line sets are tool-agnostic, so a file covered by both a jest run and a stand
//   run merges as a union instead of mixing istanbul statement maps that do not line up.
//
//   --save-baseline  writes <task dir>/coverage-baseline.json (per file and per group).
//   --compare        computes the same from --coverage-dir and writes tmp/coverage/compare.md:
//                    per group (server/src/*, client/src/viewer/*, hook/.claude/telemetry_tool),
//                    baseline vs new line coverage, plus every file whose coverage fell.
//
// Mutation (--kind mutation):
//   Reads a Stryker JSON report (--report, default tmp/stryker/mutation.json).
//   --save-baseline  writes <task dir>/mutation-baseline.json (score per mutated module).
//   --compare        writes tmp/stryker/compare.md and exits 1 when any module's mutation score is
//                    below its baseline (DD L2: the new suite must not score lower).
//
// Usage:
//   node scripts/scenarios/coverage-compare.mjs --save-baseline [--coverage-dir tmp/coverage/baseline]
//   node scripts/scenarios/coverage-compare.mjs --compare [--coverage-dir tmp/coverage/new]
//   node scripts/scenarios/coverage-compare.mjs --kind mutation --save-baseline|--compare [--report <json>]
//   [--baseline <file>] overrides the baseline path, [--out <file>] the compare report path.
// Exit codes: 0 ok, 1 mutation score below baseline, 2 usage or input error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TASK_DIR = path.join(ROOT, 'docs', 'tasks', 'todo', '2026-10-14-qaa-test-suite-cleanup');
export const COVERAGE_BASELINE = path.join(TASK_DIR, 'coverage-baseline.json');
export const MUTATION_BASELINE = path.join(TASK_DIR, 'mutation-baseline.json');
export const DEFAULT_MUTATION_REPORT = path.join(ROOT, 'tmp', 'stryker', 'mutation.json');

/** Product source roots that are measured; everything else in a report is ignored. */
export const MEASURED_ROOTS = ['server/src/', 'client/src/', 'hook/.claude/telemetry_tool/'];

const TEST_FILE_RE = /(?:\.spec\.ts|\.e2e-spec\.ts|\.test\.[cm]?[jt]sx?)$|\/__tests__\//;

/** Absolute or relative report path → repo-relative POSIX path, or null when outside the repo. */
export function toRepoPath(file, root = ROOT) {
  const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) return null;
  return rel;
}

/** True for a product source file that belongs in the measurement. */
export function isMeasured(repoPath) {
  if (!repoPath) return false;
  if (!MEASURED_ROOTS.some((r) => repoPath.startsWith(r))) return false;
  return !TEST_FILE_RE.test(repoPath);
}

/**
 * Comparison group of a file: server/src/<dir>, client/src/viewer/<dir> (other client files fall
 * into client/src/(other)), hook/.claude/telemetry_tool. Files directly in a root use "(root)".
 */
export function groupOf(repoPath) {
  if (repoPath.startsWith('hook/.claude/telemetry_tool/')) return 'hook/.claude/telemetry_tool';
  if (repoPath.startsWith('server/src/')) {
    const rest = repoPath.slice('server/src/'.length).split('/');
    return rest.length > 1 ? `server/src/${rest[0]}` : 'server/src/(root)';
  }
  if (repoPath.startsWith('client/src/viewer/')) {
    const rest = repoPath.slice('client/src/viewer/'.length).split('/');
    return rest.length > 1 ? `client/src/viewer/${rest[0]}` : 'client/src/viewer/(root)';
  }
  if (repoPath.startsWith('client/src/')) return 'client/src/(other)';
  return null;
}

/** Statement lines of one istanbul file entry: Map<line, hits>. */
export function linesOfFileCoverage(entry) {
  const lines = new Map();
  const statementMap = (entry && entry.statementMap) || {};
  const counts = (entry && entry.s) || {};
  for (const [id, loc] of Object.entries(statementMap)) {
    const line = loc && loc.start && loc.start.line;
    if (!Number.isInteger(line)) continue;
    const hits = Number(counts[id]) || 0;
    lines.set(line, Math.max(lines.get(line) || 0, hits));
  }
  return lines;
}

/**
 * Merges istanbul coverage maps (objects of path → file coverage) into
 * Map<repoPath, { lines: Set<number>, covered: Set<number> }>.
 */
export function mergeCoverageMaps(maps, root = ROOT) {
  const merged = new Map();
  for (const map of maps) {
    for (const [key, entry] of Object.entries(map || {})) {
      const repoPath = toRepoPath((entry && entry.path) || key, root);
      if (!isMeasured(repoPath)) continue;
      let acc = merged.get(repoPath);
      if (!acc) {
        acc = { lines: new Set(), covered: new Set() };
        merged.set(repoPath, acc);
      }
      for (const [line, hits] of linesOfFileCoverage(entry)) {
        acc.lines.add(line);
        if (hits > 0) acc.covered.add(line);
      }
    }
  }
  return merged;
}

const pct = (covered, total) => (total === 0 ? 100 : Math.round((covered / total) * 10000) / 100);

/** Per-file and per-group line totals of a merged coverage map. */
export function summarizeCoverage(merged) {
  const files = {};
  const groups = {};
  const total = { lines: 0, covered: 0, pct: 100 };
  for (const repoPath of [...merged.keys()].sort()) {
    const { lines, covered } = merged.get(repoPath);
    files[repoPath] = { lines: lines.size, covered: covered.size, pct: pct(covered.size, lines.size) };
    const g = groupOf(repoPath);
    if (!groups[g]) groups[g] = { files: 0, lines: 0, covered: 0, pct: 100 };
    groups[g].files += 1;
    groups[g].lines += lines.size;
    groups[g].covered += covered.size;
    total.lines += lines.size;
    total.covered += covered.size;
  }
  for (const g of Object.values(groups)) g.pct = pct(g.covered, g.lines);
  total.pct = pct(total.covered, total.lines);
  const sortedGroups = Object.fromEntries(Object.keys(groups).sort().map((k) => [k, groups[k]]));
  return { total, groups: sortedGroups, files };
}

/** Every coverage-final.json below `dir` (sorted, absolute). */
export function findCoverageFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name === 'coverage-final.json') out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

export function collectCoverage(dir, root = ROOT) {
  const files = findCoverageFiles(dir);
  if (files.length === 0) throw new UsageError(`no coverage-final.json under ${dir}`);
  const maps = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const summary = summarizeCoverage(mergeCoverageMaps(maps, root));
  return { sources: files.map((f) => toRepoPath(f, root) || f), ...summary };
}

const fmtPct = (v) => (v === undefined || v === null ? '—' : `${v.toFixed(2)}%`);
const fmtDelta = (d) => (d === null ? '—' : `${d > 0 ? '+' : ''}${d.toFixed(2)}`);

/** Markdown comparison of two coverage summaries (baseline vs new). */
export function coverageCompareMarkdown(baseline, current) {
  const lines = [];
  lines.push('# Coverage comparison (lines)', '');
  lines.push(`Baseline: ${baseline.generatedAt || '?'} · new: ${current.generatedAt || '?'}`, '');
  lines.push(`Total: ${fmtPct(baseline.total.pct)} → ${fmtPct(current.total.pct)} (${fmtDelta(current.total.pct - baseline.total.pct)})`, '');
  lines.push('| Group | Baseline | New | Δ | Lines (base → new) |', '|---|---|---|---|---|');
  const groups = [...new Set([...Object.keys(baseline.groups), ...Object.keys(current.groups)])].sort();
  for (const g of groups) {
    const b = baseline.groups[g];
    const c = current.groups[g];
    const delta = b && c ? c.pct - b.pct : null;
    const mark = delta !== null && delta < 0 ? ' ↓' : '';
    lines.push(`| \`${g}\`${mark} | ${fmtPct(b && b.pct)} | ${fmtPct(c && c.pct)} | ${fmtDelta(delta)} | ${b ? b.lines : 0} → ${c ? c.lines : 0} |`);
  }
  const dropped = Object.keys(baseline.files)
    .map((f) => ({ f, b: baseline.files[f], c: current.files[f] }))
    .filter(({ b, c }) => b.covered > 0 && (!c || c.pct < b.pct))
    .sort((x, y) => x.f.localeCompare(y.f));
  lines.push('', `## Files whose coverage fell (${dropped.length})`, '');
  if (dropped.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| File | Baseline | New |', '|---|---|---|');
    for (const { f, b, c } of dropped) lines.push(`| \`${f}\` | ${fmtPct(b.pct)} | ${c ? fmtPct(c.pct) : 'not measured'} |`);
  }
  return `${lines.join('\n')}\n`;
}

// --- mutation -------------------------------------------------------------------------------

/**
 * Per-module mutation scores from a Stryker JSON report (mutation-testing-report-schema). File keys
 * are relative to the report's projectRoot (server/ for server/stryker.config.json).
 * score = (killed + timeout) / (killed + timeout + survived + noCoverage); coveredScore leaves out
 * noCoverage. Ignored, CompileError and RuntimeError mutants count as "excluded" only.
 */
export function summarizeMutation(report, root = ROOT) {
  const projectRoot = (report && report.projectRoot) || path.join(root, 'server');
  const modules = {};
  const all = { killed: 0, timeout: 0, survived: 0, noCoverage: 0, excluded: 0 };
  for (const [file, data] of Object.entries((report && report.files) || {})) {
    const repoPath = toRepoPath(path.resolve(projectRoot, file), root) || file;
    const m = { killed: 0, timeout: 0, survived: 0, noCoverage: 0, excluded: 0 };
    for (const mutant of data.mutants || []) {
      if (mutant.status === 'Killed') m.killed += 1;
      else if (mutant.status === 'Timeout') m.timeout += 1;
      else if (mutant.status === 'Survived') m.survived += 1;
      else if (mutant.status === 'NoCoverage') m.noCoverage += 1;
      else m.excluded += 1;
    }
    for (const k of Object.keys(all)) all[k] += m[k];
    modules[repoPath] = withScores(m);
  }
  const sorted = Object.fromEntries(Object.keys(modules).sort().map((k) => [k, modules[k]]));
  return { total: withScores(all), modules: sorted };
}

function withScores(m) {
  const detected = m.killed + m.timeout;
  const valid = detected + m.survived + m.noCoverage;
  const covered = detected + m.survived;
  return {
    ...m,
    mutants: valid,
    score: pct(detected, valid),
    coveredScore: pct(detected, covered),
  };
}

/** Markdown comparison of mutation summaries plus the modules that scored below the baseline. */
export function mutationCompareMarkdown(baseline, current) {
  const lines = ['# Mutation score comparison (Stryker)', ''];
  lines.push('| Module | Baseline | New | Δ |', '|---|---|---|---|');
  const regressions = [];
  const modules = [...new Set([...Object.keys(baseline.modules), ...Object.keys(current.modules)])].sort();
  for (const mod of modules) {
    const b = baseline.modules[mod];
    const c = current.modules[mod];
    const delta = b && c ? c.score - b.score : null;
    if (b && (!c || c.score < b.score)) regressions.push(mod);
    lines.push(`| \`${mod}\`${regressions.includes(mod) ? ' ↓' : ''} | ${fmtPct(b && b.score)} | ${fmtPct(c && c.score)} | ${fmtDelta(delta)} |`);
  }
  lines.push('', `Total: ${fmtPct(baseline.total.score)} → ${fmtPct(current.total.score)}`, '');
  lines.push(regressions.length ? `Below baseline: ${regressions.join(', ')}` : 'No module below baseline.');
  return { markdown: `${lines.join('\n')}\n`, regressions };
}

// --- CLI ------------------------------------------------------------------------------------

export class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { kind: 'coverage', action: null, coverageDir: null, report: null, baseline: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => {
      if (inline !== undefined) return inline;
      if (i + 1 >= argv.length) throw new UsageError(`${flag} needs a value`);
      return argv[++i];
    };
    if (flag === '--save-baseline' || flag === '--compare') {
      if (opts.action) throw new UsageError('pass exactly one of --save-baseline / --compare');
      opts.action = flag === '--save-baseline' ? 'save' : 'compare';
    } else if (flag === '--kind') {
      opts.kind = value();
      if (!['coverage', 'mutation'].includes(opts.kind)) throw new UsageError(`unknown --kind "${opts.kind}"`);
    } else if (flag === '--coverage-dir') opts.coverageDir = value();
    else if (flag === '--report') opts.report = value();
    else if (flag === '--baseline') opts.baseline = value();
    else if (flag === '--out') opts.out = value();
    else throw new UsageError(`unknown argument "${argv[i]}"`);
  }
  if (!opts.action) throw new UsageError('pass --save-baseline or --compare');
  return opts;
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function readJson(file) {
  if (!fs.existsSync(file)) throw new UsageError(`${file} not found`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function main(argv, root = ROOT) {
  const opts = parseArgs(argv);
  const generatedAt = new Date().toISOString();
  if (opts.kind === 'coverage') {
    const dir = path.resolve(root, opts.coverageDir || path.join('tmp', 'coverage', opts.action === 'save' ? 'baseline' : 'new'));
    const current = { generatedAt, metric: 'lines', ...collectCoverage(dir, root) };
    const baselineFile = path.resolve(root, opts.baseline || COVERAGE_BASELINE);
    if (opts.action === 'save') {
      writeFile(baselineFile, `${JSON.stringify(current, null, 2)}\n`);
      process.stdout.write(`coverage baseline ${fmtPct(current.total.pct)} (${current.total.covered}/${current.total.lines} lines) → ${baselineFile}\n`);
      return 0;
    }
    const out = path.resolve(root, opts.out || path.join('tmp', 'coverage', 'compare.md'));
    writeFile(out, coverageCompareMarkdown(readJson(baselineFile), current));
    process.stdout.write(`coverage comparison → ${out}\n`);
    return 0;
  }
  const reportFile = path.resolve(root, opts.report || DEFAULT_MUTATION_REPORT);
  const current = { generatedAt, tool: 'stryker', ...summarizeMutation(readJson(reportFile), root) };
  const baselineFile = path.resolve(root, opts.baseline || MUTATION_BASELINE);
  if (opts.action === 'save') {
    writeFile(baselineFile, `${JSON.stringify(current, null, 2)}\n`);
    process.stdout.write(`mutation baseline ${fmtPct(current.total.score)} → ${baselineFile}\n`);
    return 0;
  }
  const out = path.resolve(root, opts.out || path.join('tmp', 'stryker', 'compare.md'));
  const { markdown, regressions } = mutationCompareMarkdown(readJson(baselineFile), current);
  writeFile(out, markdown);
  process.stdout.write(`mutation comparison → ${out}\n`);
  if (regressions.length) {
    process.stderr.write(`mutation score below baseline: ${regressions.join(', ')}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`coverage-compare error: ${err.message}\n`);
    process.exit(2);
  }
}
