#!/usr/bin/env node
'use strict';

// Scanner output -> unified scan row (security-scans CI workflow).
// Design Decisions 9, 12 and 27 of docs/tasks/todo/2026-10-23-ci-cd-scans/impl-plan.md.
//
// Every subcommand writes one file, <out>/row-<tool>-<scope>.json:
//   { tool, scope, version?, status, counts: {critical, high, medium, low},
//     fixable, link?, note }
//
// Modes:
//   node scripts/ci/scan-rows.js <subcommand> --tool <t> --scope <s> --out <dir>
//        [--version <v>] [--link <url>] <subcommand arguments>
//
//   Subcommand        Input                                   Status rule
//   snyk-oss          --json <file> (snyk test --json-file-output)
//                                                             findings when fixable high/critical > 0
//   snyk-container    --json <file> (snyk container test)     findings when critical+high > 0
//   dependency-review env DR_VULNERABLE_CHANGES, DR_INVALID_LICENSE_CHANGES
//                                                             findings when high+critical > 0 or a denied licence
//   outcome           --outcome <steps.x.outcome> [--failed <n>] [--note <text>]
//                                                             success -> pass, failure -> findings (high = n)
//   zizmor            --sarif <file>                          findings when any result
//   hadolint          --json <file> (hadolint --format json)  findings on error, warning on warning
//   skipped           --note <text>                           skipped
//   warning           --note <text>                           warning (the scan could not run, e.g. a
//                                                             transient tool/API failure)
//
//   A missing or unreadable input file gives an `error` row with the note `no output`.
//
//   require('scripts/ci/scan-rows.js') exports the row mappers (snykOssRow,
//   snykContainerRow, dependencyReviewRow, outcomeRow, zizmorRow, hadolintRow,
//   skippedRow, warningRow) and the helpers makeRow / writeRow / rowFileName used by the
//   other scripts in scripts/ci/.
//
// Exit codes: 0 after writing the row (report-only, findings never fail the
// job), 1 only on a usage error.

const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-z0-9-]{1,40}$/;
const NOTE_MAX = 200;
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

// ------------------------------------------------------------- helpers ----

function truncateNote(note) {
  const text = String(note || '').replace(/\s+/g, ' ').trim();
  return text.length <= NOTE_MAX ? text : `${text.slice(0, NOTE_MAX - 3)}...`;
}

function zeroCounts() {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

/** Builds a row in the unified format (Decision 9). */
function makeRow({ tool, scope, status, counts, fixable, note, version, link }) {
  const row = { tool, scope };
  if (version) row.version = String(version);
  row.status = status;
  row.counts = { ...zeroCounts(), ...(counts || {}) };
  row.fixable = fixable || 0;
  if (link) row.link = link;
  row.note = truncateNote(note);
  return row;
}

function rowFileName(tool, scope) {
  return `row-${tool}-${scope}.json`;
}

function writeRow(outDir, row) {
  const dir = path.resolve(outDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, rowFileName(row.tool, row.scope));
  fs.writeFileSync(file, `${JSON.stringify(row, null, 2)}\n`, 'utf8');
  return file;
}

/** Reads and parses a JSON file; returns undefined when missing or unreadable. */
function readJson(file) {
  if (!file) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function countsNote(counts) {
  const parts = SEVERITIES.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  return parts.length > 0 ? parts.join(', ') : 'no issues';
}

function noOutput(base) {
  return makeRow({ ...base, status: 'error', note: 'no output' });
}

// -------------------------------------------------------------- Snyk ----

/** Snyk severity -> row severity key. */
function snykSeverity(sev) {
  const s = String(sev || '').toLowerCase();
  return SEVERITIES.includes(s) ? s : 'low';
}

/** Flattens Snyk JSON (an object, or an array with --all-projects) into projects. */
function snykProjects(json) {
  if (Array.isArray(json)) return json.filter((p) => p && typeof p === 'object');
  if (json && typeof json === 'object') return [json];
  return [];
}

const NO_MANIFEST = /could not detect supported target files|no supported target files|could not find any/i;

/** Collects unique issues (id + packageName); returns { counts, fixable, errors }. */
function snykIssues(json) {
  const seen = new Map();
  const errors = [];
  for (const project of snykProjects(json)) {
    if (project.error && !Array.isArray(project.vulnerabilities)) {
      errors.push(String(project.error));
      continue;
    }
    for (const v of Array.isArray(project.vulnerabilities) ? project.vulnerabilities : []) {
      if (!v || typeof v !== 'object') continue;
      const key = `${v.id}|${v.packageName}`;
      const prev = seen.get(key);
      const fixable = Boolean(v.isUpgradable || v.isPatchable);
      seen.set(key, { severity: snykSeverity(v.severity), fixable: fixable || Boolean(prev && prev.fixable) });
    }
  }
  const counts = zeroCounts();
  let fixable = 0;
  for (const issue of seen.values()) {
    counts[issue.severity] += 1;
    if (issue.fixable && (issue.severity === 'critical' || issue.severity === 'high')) fixable += 1;
  }
  return { counts, fixable, errors, projects: snykProjects(json).length };
}

function snykOssRow(base, json) {
  if (json === undefined) return noOutput(base);
  const { counts, fixable, errors, projects } = snykIssues(json);
  if (errors.length === projects) {
    if (errors.length > 0 && errors.every((e) => NO_MANIFEST.test(e))) {
      const note = base.scope === 'kit' ? 'no manifests in tarballs' : 'no manifests found';
      return makeRow({ ...base, status: 'pass', note });
    }
    return makeRow({ ...base, status: 'error', note: errors[0] || 'no projects in output' });
  }
  const status = fixable > 0 ? 'findings' : 'pass';
  const note = fixable > 0 ? `${fixable} fixable high/critical` : countsNote(counts);
  return makeRow({ ...base, status, counts, fixable, note });
}

function snykContainerRow(base, json) {
  if (json === undefined) return noOutput(base);
  const { counts, errors, projects } = snykIssues(json);
  if (errors.length === projects) {
    return makeRow({ ...base, status: 'error', note: errors[0] || 'no projects in output' });
  }
  const status = counts.critical + counts.high > 0 ? 'findings' : 'pass';
  return makeRow({ ...base, status, counts, note: countsNote(counts) });
}

// --------------------------------------------------- dependency review ----

/** GitHub advisory severity -> row severity key. */
function ghSeverity(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'moderate') return 'medium';
  return SEVERITIES.includes(s) ? s : 'low';
}

function parseEnvJson(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * `vulnerable-changes` is an array of changes, each with `vulnerabilities`;
 * `invalid-license-changes` is { forbidden: [], unresolved: [], unlicensed: [] }.
 * Only `forbidden` (a deny-licenses hit) makes the row fail; the others are
 * reported in the note.
 */
function dependencyReviewRow(base, vulnerableRaw, licenseRaw) {
  const changes = parseEnvJson(vulnerableRaw);
  if (!Array.isArray(changes)) return noOutput(base);
  const licenses = parseEnvJson(licenseRaw);
  const counts = zeroCounts();
  const seen = new Set();
  for (const change of changes) {
    if (!change || typeof change !== 'object') continue;
    for (const v of Array.isArray(change.vulnerabilities) ? change.vulnerabilities : []) {
      if (!v || typeof v !== 'object') continue;
      const key = `${v.advisory_ghsa_id}|${change.name}|${change.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts[ghSeverity(v.severity)] += 1;
    }
  }
  const listLen = (k) => (licenses && Array.isArray(licenses[k]) ? licenses[k].length : 0);
  const forbidden = listLen('forbidden');
  const unknown = listLen('unresolved') + listLen('unlicensed');
  const failing = counts.critical + counts.high > 0 || forbidden > 0;
  const note = `${countsNote(counts)}; ${forbidden} denied licence(s), ${unknown} unknown licence(s)`;
  return makeRow({ ...base, status: failing ? 'findings' : 'pass', counts, note });
}

// -------------------------------------------------------------- outcome ----

/** Maps a step outcome (success|failure|cancelled|skipped) to a row. */
function outcomeRow(base, outcome, failed, extraNote) {
  const n = Number.parseInt(failed, 10);
  const failedFiles = Number.isInteger(n) && n > 0 ? n : 1;
  const suffix = extraNote ? `; ${extraNote}` : '';
  switch (outcome) {
    case 'success':
      return makeRow({ ...base, status: 'pass', note: extraNote || 'ok' });
    case 'failure':
      return makeRow({
        ...base,
        status: 'findings',
        counts: { high: failedFiles },
        note: `${failedFiles} failing file(s)${suffix}`,
      });
    case 'skipped':
      return makeRow({ ...base, status: 'skipped', note: extraNote || 'step skipped' });
    default:
      return makeRow({ ...base, status: 'error', note: `step outcome: ${outcome || 'none'}${suffix}` });
  }
}

// --------------------------------------------------------------- zizmor ----

function sarifLevel(level) {
  if (level === 'error') return 'high';
  if (level === 'warning') return 'medium';
  return 'low';
}

/** Counts SARIF results by level (rule default level, then `warning`). */
function zizmorRow(base, sarif) {
  if (!sarif || typeof sarif !== 'object' || !Array.isArray(sarif.runs)) return noOutput(base);
  const counts = zeroCounts();
  for (const run of sarif.runs) {
    const rules = (run && run.tool && run.tool.driver && Array.isArray(run.tool.driver.rules)) ? run.tool.driver.rules : [];
    const ruleLevel = new Map(rules.map((r) => [r && r.id,
      r && r.defaultConfiguration && r.defaultConfiguration.level]));
    for (const result of run && Array.isArray(run.results) ? run.results : []) {
      if (!result || typeof result !== 'object') continue;
      const level = result.level || ruleLevel.get(result.ruleId) || 'warning';
      counts[sarifLevel(level)] += 1;
    }
  }
  const total = counts.high + counts.medium + counts.low;
  return makeRow({ ...base, status: total > 0 ? 'findings' : 'pass', counts, note: countsNote(counts) });
}

// ------------------------------------------------------------- hadolint ----

/** hadolint --format json: an array of { code, level, file, line }. */
function hadolintRow(base, json) {
  if (!Array.isArray(json)) return noOutput(base);
  const counts = zeroCounts();
  const codes = new Set();
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    if (item.level === 'error') counts.high += 1;
    else if (item.level === 'warning') counts.medium += 1;
    else counts.low += 1;
    if (item.level === 'error' || item.level === 'warning') codes.add(String(item.code));
  }
  let status = 'pass';
  if (counts.high > 0) status = 'findings';
  else if (counts.medium > 0) status = 'warning';
  const note = codes.size > 0 ? `${countsNote(counts)}: ${[...codes].join(', ')}` : countsNote(counts);
  return makeRow({ ...base, status, counts, note });
}

// -------------------------------------------------------------- skipped ----

function skippedRow(base, note) {
  return makeRow({ ...base, status: 'skipped', note: note || 'skipped' });
}

// -------------------------------------------------------------- warning ----

function warningRow(base, note) {
  return makeRow({ ...base, status: 'warning', note: note || 'warning' });
}

// ------------------------------------------------------------------ CLI ----

const SUBCOMMANDS = {
  'snyk-oss': ['json'],
  'snyk-container': ['json'],
  'dependency-review': [],
  outcome: ['outcome', 'failed', 'note'],
  zizmor: ['sarif'],
  hadolint: ['json'],
  skipped: ['note'],
  warning: ['note'],
};
const COMMON = ['tool', 'scope', 'out', 'version', 'link'];

function parseArgs(argv) {
  const [sub, ...rest] = argv;
  if (!sub || !Object.prototype.hasOwnProperty.call(SUBCOMMANDS, sub)) {
    throw new Error(`unknown subcommand: ${sub || '(none)'}`);
  }
  const allowed = new Set([...COMMON, ...SUBCOMMANDS[sub]]);
  const args = { sub };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    const name = a.startsWith('--') ? a.slice(2) : '';
    if (!allowed.has(name) || i + 1 >= rest.length) throw new Error(`unknown or incomplete argument: ${a}`);
    args[name] = rest[i + 1];
    i += 1;
  }
  for (const req of ['tool', 'scope', 'out']) {
    if (!args[req]) throw new Error(`--${req} is required`);
  }
  if (!ID_RE.test(args.tool) || !ID_RE.test(args.scope)) {
    throw new Error('--tool and --scope must match ^[a-z0-9-]{1,40}$');
  }
  return args;
}

function buildRowFor(args, env) {
  const base = { tool: args.tool, scope: args.scope, version: args.version, link: args.link };
  switch (args.sub) {
    case 'snyk-oss': return snykOssRow(base, readJson(args.json));
    case 'snyk-container': return snykContainerRow(base, readJson(args.json));
    case 'dependency-review':
      return dependencyReviewRow(base, env.DR_VULNERABLE_CHANGES, env.DR_INVALID_LICENSE_CHANGES);
    case 'outcome': return outcomeRow(base, args.outcome, args.failed, args.note);
    case 'zizmor': return zizmorRow(base, readJson(args.sarif));
    case 'hadolint': return hadolintRow(base, readJson(args.json));
    case 'skipped': return skippedRow(base, args.note);
    case 'warning': return warningRow(base, args.note);
    default: throw new Error(`unknown subcommand: ${args.sub}`);
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`scan-rows: ${err.message}\n`
      + 'Usage: node scripts/ci/scan-rows.js <snyk-oss|snyk-container|dependency-review|outcome|zizmor|hadolint|skipped|warning>'
      + ' --tool <t> --scope <s> --out <dir> [--version <v>] [--link <url>] ...\n');
    process.exit(1);
  }
  let row;
  try {
    row = buildRowFor(args, process.env);
  } catch (err) {
    row = makeRow({ tool: args.tool, scope: args.scope, version: args.version, link: args.link,
      status: 'error', note: `row mapping failed: ${err.message}` });
  }
  const file = writeRow(args.out, row);
  process.stdout.write(`scan-rows: ${row.tool}/${row.scope} ${row.status} -> ${file}\n`);
  process.exit(0);
}

module.exports = {
  makeRow,
  writeRow,
  rowFileName,
  truncateNote,
  snykOssRow,
  snykContainerRow,
  dependencyReviewRow,
  outcomeRow,
  zizmorRow,
  hadolintRow,
  skippedRow,
  warningRow,
};

if (require.main === module) main();
