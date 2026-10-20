#!/usr/bin/env node
// "What's new in the Claude Code logs" (impl-plan DD I1, docs/qaa-overview/scenarios/08-session-corpus.md):
// compares the line types, keys per line type, content-block types and attachment types of one
// corpus set with the previous set, and with the approved format in tests/corpus/known-format.json.
//
// Writes tmp/corpus/<set>/whats-new.md. With --approve it also merges the set's format into
// known-format.json — the list S-CORPUS-03 checks every set against — so run it only after a human
// has read the report.
//
// Usage: node scripts/corpus/diff-format.mjs <set> [--against <previous-set>] [--sets-dir <dir>] [--approve]
//        (<set> defaults to the newest set; --against defaults to the set just before it)
// Exit codes: 0 report written, 2 usage error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatDrift,
  formatSummary,
  listSets,
  mergeSummaries,
  readSetManifest,
  setTranscriptLines,
} from '../../tests/scenarios/helpers/corpus.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPORT_ROOT = path.join(ROOT, 'tmp', 'corpus');
// Resolved from this file, not from corpus.ts (whose fallback under Node's type stripping is the cwd).
export const SETS_DIR = path.join(ROOT, 'tests', 'corpus', 'sets');
export const KNOWN_FORMAT_FILE = path.join(ROOT, 'tests', 'corpus', 'known-format.json');

export function parseArgs(argv) {
  const opts = { set: null, against: null, setsDir: SETS_DIR, approve: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v === '') throw new Error(`${arg} requires a value`);
      return v;
    };
    if (arg === '--against') opts.against = value();
    else if (arg === '--sets-dir') opts.setsDir = path.resolve(value());
    else if (arg === '--approve') opts.approve = true;
    else if (!arg.startsWith('--') && opts.set === null) opts.set = arg;
    else throw new Error(`Unknown argument "${arg}"`);
  }
  return opts;
}

/** The set just before `set` in name order (names start with YYYY-MM), or null. */
export function previousSet(sets, set) {
  const before = sets.filter((s) => s < set);
  return before.length ? before[before.length - 1] : null;
}

function counts(lines) {
  const byType = {};
  for (const line of lines) {
    let type = '<unparsable>';
    try {
      const row = JSON.parse(line);
      type = row && typeof row.type === 'string' ? (row.type === 'system' && row.subtype ? `system:${row.subtype}` : row.type) : '<none>';
    } catch {
      /* counted as unparsable */
    }
    byType[type] = (byType[type] || 0) + 1;
  }
  return byType;
}

function section(title, items) {
  return [`## ${title}`, '', ...(items.length ? items.map((i) => `- ${i}`) : ['- nothing']), ''];
}

/** Markdown report of `set` against `prev` (a set name or null) and the approved format. */
export function renderReport({ set, prev, manifest, prevManifest, summary, prevSummary, known, lineCounts }) {
  const newVsPrev = prevSummary ? formatDrift(summary, prevSummary) : [];
  const goneVsPrev = prevSummary ? formatDrift(prevSummary, summary) : [];
  const newVsKnown = known ? formatDrift(summary, known) : [];
  const out = [
    `# What's new in the Claude Code logs: ${set}`,
    '',
    `- Claude Code: ${manifest.claudeCodeVersion}${prevManifest ? ` (previous set ${prev}: ${prevManifest.claudeCodeVersion})` : ''}`,
    `- Hook: ${manifest.hookVersion}`,
    `- Sessions: ${manifest.sessions.length}`,
    `- Generated: ${manifest.generatedAt}`,
    '',
    ...section(prev ? `New since ${prev}` : 'New since the previous set (there is none)', newVsPrev),
    ...section(prev ? `Gone since ${prev}` : 'Gone since the previous set (there is none)', goneVsPrev),
    ...section('Not in tests/corpus/known-format.json (S-CORPUS-03 fails on these until approved)', newVsKnown),
    '## Lines per type',
    '',
    '| Type | Lines |',
    '|---|---|',
    ...Object.keys(lineCounts).sort().map((t) => `| \`${t}\` | ${lineCounts[t]} |`),
    '',
    'After review: `node scripts/corpus/diff-format.mjs ' + set + ' --approve` merges this set into',
    'known-format.json; then update docs/knowledgebase/log-schema/ with what is new.',
    '',
  ];
  return out.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`diff-format: ${err.message}\n`);
    return 2;
  }
  const sets = listSets(opts.setsDir);
  const set = opts.set ?? sets[sets.length - 1];
  if (!set || !sets.includes(set)) {
    process.stderr.write(`diff-format: no set "${set ?? ''}" under ${opts.setsDir} (have: ${sets.join(', ') || 'none'})\n`);
    return 2;
  }
  const prev = opts.against ?? previousSet(sets, set);
  if (prev && !sets.includes(prev)) {
    process.stderr.write(`diff-format: no set "${prev}" under ${opts.setsDir}\n`);
    return 2;
  }

  const lines = setTranscriptLines(set, opts.setsDir);
  const summary = formatSummary(lines);
  const prevSummary = prev ? formatSummary(setTranscriptLines(prev, opts.setsDir)) : null;
  const known = fs.existsSync(KNOWN_FORMAT_FILE) ? JSON.parse(fs.readFileSync(KNOWN_FORMAT_FILE, 'utf8')) : null;
  const report = renderReport({
    set,
    prev,
    manifest: readSetManifest(set, opts.setsDir),
    prevManifest: prev ? readSetManifest(prev, opts.setsDir) : null,
    summary,
    prevSummary,
    known,
    lineCounts: counts(lines),
  });

  const outDir = path.join(REPORT_ROOT, set);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'whats-new.md');
  fs.writeFileSync(outFile, report);
  process.stdout.write(`diff-format: ${path.relative(ROOT, outFile)}\n`);

  if (opts.approve) {
    const merged = known ? mergeSummaries([known, summary]) : summary;
    fs.writeFileSync(KNOWN_FORMAT_FILE, `${JSON.stringify(merged, null, 2)}\n`);
    process.stdout.write(`diff-format: merged ${set} into ${path.relative(ROOT, KNOWN_FORMAT_FILE)}\n`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
