#!/usr/bin/env node
'use strict';

// Security-scan summary library and CLI for the security-scans / security-report
// CI workflows (FR-23, FR-24). Design Decisions 9-16 of
// docs/tasks/todo/2026-10-23-ci-cd-scans/impl-plan.md.
//
// A "row" is one scanner result in the unified row format (Decision 9):
//   { tool, scope, version?, status, counts: {critical, high, medium, low},
//     fixable?, link?, note? }
// Rows can come from fork-PR artifacts, so they are untrusted: every function
// below runs them through normalizeRows() first.
//
// Modes:
//   require('scripts/ci/security-summary.js') exports the pure functions
//     normalizeRows(rows)          validate, sanitise, dedupe, sort
//     renderSummary(rows, meta)    PR-description block, meta = {sha, date, runUrl, pending}
//     replaceBlock(body, block)    put the block into a PR body (idempotent)
//     badgeFor(rows)               shields.io endpoint JSON
//     buildResults(rows, meta)     security-scan-results.json content, meta = {sha, date}
//   node scripts/ci/security-summary.js results --rows <dir> --out <dir> --sha <sha>
//     Reads every row-*.json under <dir> (recursively), writes
//     <out>/security-scan-results.json and <out>/badges/security.json.
//   node scripts/ci/security-summary.js apply-pr
//     Env: GH_TOKEN, REPO (owner/name), RUN_ID (the triggering workflow run),
//     HEAD_SHA (its head SHA). Reads the pr-meta artifact of RUN_ID, checks the
//     PR is open on HEAD_SHA, collects the scan-row-* artifacts of the latest
//     security-scans and virustotal runs for HEAD_SHA plus the gitleaks `scan`
//     check run, PATCHes the PR body when the block changed and creates or
//     updates the `VirusTotal verdict` check run when VirusTotal rows exist.
//     Uses `gh api` / `gh run download` through execFileSync.
//
// Exit codes: 0 on success and on runtime failures (report-only; failures are
// printed as ::warning:: annotations), 1 only on a usage error.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const START = '<!-- security-scan:start -->';
const END = '<!-- security-scan:end -->';
const FALLBACK_BLOCK = `${START}\n## Security scan\n_Summary too long — see the workflow runs._\n${END}`;
const BODY_MAX = 65536;

/** Display labels in table order, keyed by `tool/scope` (Decision 11). */
const LABELS = [
  ['gitleaks/scan', 'Gitleaks (secrets)'],
  ['snyk-oss/prod', 'Snyk Open Source (prod)'],
  ['snyk-oss/dev', 'Snyk Open Source (dev)'],
  ['snyk-oss/kit', 'Snyk — installer tarballs'],
  ['dependency-review/pr', 'Dependency review'],
  ['config-guard/repo', 'Executable-config guard'],
  ['lockfile-lint/npm', 'Lock-file registry'],
  ['npm-signatures/npm', 'npm registry signatures'],
  ['actionlint/workflows', 'actionlint'],
  ['zizmor/workflows', 'zizmor'],
  ['hadolint/dockerfiles', 'hadolint'],
  ['compose/config', 'docker compose config'],
  ['snyk-container/image', 'Snyk Container'],
  ['node-runtime/dockerfile', 'Node runtime (Dockerfile)'],
  ['node-runtime/docker-dev', 'Node runtime (docker-dev)'],
  ['virustotal/installer-tgz', 'VirusTotal — artisyn-hooks-installer.tgz'],
  ['virustotal/hooks-tgz', 'VirusTotal — hooks.tar.gz'],
];
const LABEL_INDEX = new Map(LABELS.map(([key], i) => [key, i]));
const LABEL_TEXT = new Map(LABELS);

/** Row status enum and its rendering (Decision 9). */
const STATUS_TEXT = {
  pass: '✅ pass',
  warning: '⚠️ warning',
  findings: '❌ findings',
  neutral: '⚪ neutral',
  skipped: '⏭️ skipped',
  error: '💥 tool error',
  pending: '⏳ pending',
};

const ID_RE = /^[a-z0-9-]{1,40}$/;
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const COUNT_MAX = 1000000;
const NOTE_MAX = 200;
const LINK_PREFIXES = [
  'https://github.com/DataArt/artisyn-log-hub/',
  'https://www.virustotal.com/gui/file/',
  'https://app.snyk.io/',
];
// Characters a kept link may contain: no whitespace, quotes, brackets or
// parentheses, so it cannot break out of the Markdown `[link](...)`.
const LINK_CHARS = /^[A-Za-z0-9._~:/?#@!$&*+,;=%-]+$/;
const NOTE_DISALLOWED = /[^A-Za-z0-9 .,:;()/_@#+=%'-]/g;
const VERSION_RE = /^[A-Za-z0-9._+-]{1,40}$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isCount(v) {
  return Number.isInteger(v) && v >= 0 && v <= COUNT_MAX;
}

/** The link when it passes the Decision 10 link rule, otherwise null. */
function safeLink(link) {
  if (typeof link !== 'string' || !LINK_CHARS.test(link)) return null;
  return LINK_PREFIXES.some((p) => link.startsWith(p)) ? link : null;
}

function sanitizeNote(note) {
  if (typeof note !== 'string') return '';
  return note.replace(NOTE_DISALLOWED, '').slice(0, NOTE_MAX);
}

function zeroCounts() {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

/** Validates one row whose tool/scope pair is known; returns the clean row or null. */
function validRow(row, tool, scope) {
  if (!Object.prototype.hasOwnProperty.call(STATUS_TEXT, row.status)) return null;
  const counts = zeroCounts();
  if (row.counts !== undefined) {
    if (!isPlainObject(row.counts)) return null;
    for (const sev of SEVERITIES) {
      const v = row.counts[sev];
      if (v === undefined) continue;
      if (!isCount(v)) return null;
      counts[sev] = v;
    }
  }
  let fixable = 0;
  if (row.fixable !== undefined) {
    if (!isCount(row.fixable)) return null;
    fixable = row.fixable;
  }
  if (row.note !== undefined && typeof row.note !== 'string') return null;
  const out = {
    tool,
    scope,
    label: LABEL_TEXT.get(`${tool}/${scope}`),
    status: row.status,
    counts,
    fixable,
    note: sanitizeNote(row.note),
  };
  if (typeof row.version === 'string' && VERSION_RE.test(row.version)) out.version = row.version;
  const link = safeLink(row.link);
  if (link) out.link = link;
  return out;
}

/**
 * Decision 10: drops rows with an unknown tool/scope pair, turns any other
 * invalid row into an `error` row with the note `invalid row`, keeps the last
 * occurrence of a repeated pair and sorts by label-table order. The output
 * rows carry `label` from the table; normalizing them again is a no-op.
 */
function normalizeRows(rows) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isPlainObject(row)) continue;
    const { tool, scope } = row;
    if (typeof tool !== 'string' || typeof scope !== 'string' || !ID_RE.test(tool) || !ID_RE.test(scope)) continue;
    const key = `${tool}/${scope}`;
    if (!LABEL_INDEX.has(key)) continue;
    const clean = validRow(row, tool, scope) || {
      tool, scope, label: LABEL_TEXT.get(key), status: 'error', counts: zeroCounts(), fixable: 0, note: 'invalid row',
    };
    byKey.delete(key);
    byKey.set(key, clean);
  }
  return [...byKey.entries()]
    .sort((a, b) => LABEL_INDEX.get(a[0]) - LABEL_INDEX.get(b[0]))
    .map(([, row]) => row);
}

function formatDate(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/** Decision 14: the PR-description block, lines joined with `\n`. */
function renderSummary(rows, meta = {}) {
  const clean = normalizeRows(rows);
  const sha7 = String(meta.sha || '').replace(/[^0-9A-Fa-f]/g, '').slice(0, 7);
  const runUrl = safeLink(meta.runUrl);
  const lines = [
    START,
    '## Security scan',
    `_Commit \`${sha7}\` · updated ${formatDate(meta.date)} UTC${runUrl ? ` · [runs](${runUrl})` : ''}_`,
  ];
  const pending = Array.isArray(meta.pending) ? meta.pending.map((p) => sanitizeNote(String(p))).filter(Boolean) : [];
  if (pending.length > 0) lines.push(`_Still running: ${pending.join(', ')}_`);
  lines.push('');
  if (clean.length === 0) {
    lines.push('_No scan results yet._');
  } else {
    lines.push('| Tool | Status | Critical | High | Medium | Low | Details |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const r of clean) {
      const details = [r.link ? `[link](${r.link})` : '', r.note].filter(Boolean).join(' ');
      const c = r.counts;
      lines.push(`| ${r.label} | ${STATUS_TEXT[r.status]} | ${c.critical} | ${c.high} | ${c.medium} | ${c.low} | ${details} |`);
    }
  }
  lines.push(END);
  return lines.join('\n');
}

function placeBlock(body, block) {
  const start = body.indexOf(START);
  if (start < 0) {
    const kept = body.trimEnd();
    return kept ? `${kept}\n\n${block}` : block;
  }
  const end = body.lastIndexOf(END);
  if (end > start) return body.slice(0, start) + block + body.slice(end + END.length);
  return body.slice(0, start) + block;
}

/** Decision 15: puts `block` into a PR body; idempotent. */
function replaceBlock(body, block) {
  const text = body === null || body === undefined ? '' : String(body);
  const result = placeBlock(text, block);
  return result.length > BODY_MAX ? placeBlock(text, FALLBACK_BLOCK) : result;
}

/** Decision 16: shields.io endpoint badge; dev and skipped rows are ignored. */
function badgeFor(rows) {
  const counted = normalizeRows(rows).filter((r) => r.scope !== 'dev' && r.status !== 'skipped');
  const n = (...statuses) => counted.filter((r) => statuses.includes(r.status)).length;
  const badge = (message, color) => ({ schemaVersion: 1, label: 'security scan', message, color });
  if (n('findings') > 0) return badge(`${n('findings')} failing`, 'red');
  if (n('error') > 0) return badge('scan error', 'lightgrey');
  if (n('warning', 'neutral') > 0) return badge(`${n('warning', 'neutral')} warnings`, 'yellow');
  return badge('passing', 'brightgreen');
}

/** Decision 16: content of security-scan-results.json. */
function buildResults(rows, meta = {}) {
  return { schema: 1, commit: meta.sha, date: meta.date, ref: 'main', rows: normalizeRows(rows) };
}

// ---------------------------------------------------------------- CLI ----

const ROW_FILE_MAX_BYTES = 256 * 1024;
const ROW_FILES_MAX = 200;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_ID_RE = /^[0-9]{1,20}$/;
const WORKFLOWS = [
  { name: 'security-scans', file: 'security-scans.yml' },
  { name: 'virustotal', file: 'virustotal.yml' },
];
const GITLEAKS_CHECK = 'scan';
const VT_CHECK = 'VirusTotal verdict';

class UsageError extends Error {}

function parseArgs(argv, allowed) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const name = a.startsWith('--') ? a.slice(2) : null;
    if (name && allowed.includes(name) && i + 1 < argv.length) {
      args[name] = argv[i + 1];
      i += 1;
    } else {
      throw new UsageError(`unknown or incomplete argument: ${a}`);
    }
  }
  return args;
}

/** Every row-*.json under `dir`, recursively (download-artifact makes one subdir per artifact). */
function findRowFiles(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && /^row-.*\.json$/.test(entry.name)) found.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found.sort();
}

/** Parsed rows from the row files; unreadable, oversized or invalid JSON files are skipped. */
function readRows(dir) {
  const rows = [];
  for (const file of findRowFiles(dir).slice(0, ROW_FILES_MAX)) {
    try {
      if (fs.statSync(file).size > ROW_FILE_MAX_BYTES) throw new Error('file too large');
      rows.push(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      process.stderr.write(`security-summary: skipping ${file}: ${err.message}\n`);
    }
  }
  return rows;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function runResults(argv) {
  const args = parseArgs(argv, ['rows', 'out', 'sha']);
  if (!args.rows || !args.out || !args.sha) throw new UsageError('results needs --rows <dir> --out <dir> --sha <sha>');
  if (!SHA_RE.test(args.sha)) throw new UsageError('--sha must be a lowercase hex commit SHA');
  const rows = readRows(path.resolve(args.rows));
  const meta = { sha: args.sha, date: new Date().toISOString() };
  const out = path.resolve(args.out);
  const results = buildResults(rows, meta);
  writeJson(path.join(out, 'security-scan-results.json'), results);
  const badge = badgeFor(rows);
  writeJson(path.join(out, 'badges', 'security.json'), badge);
  process.stdout.write(`security-summary: ${results.rows.length} row(s), badge "${badge.message}"\n`);
}

function gh(args, input) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function ghJson(endpoint) {
  return JSON.parse(gh(['api', '-H', 'Accept: application/vnd.github+json', endpoint]));
}

function ghSend(method, endpoint, body) {
  return gh(['api', '-X', method, '-H', 'Accept: application/vnd.github+json', endpoint, '--input', '-'], JSON.stringify(body));
}

/** Downloads the artifacts matching `pattern` of `runId` into `dir`; false when none match. */
function downloadArtifacts(repo, runId, pattern, dir) {
  try {
    gh(['run', 'download', String(runId), '-R', repo, '-p', pattern, '-D', dir]);
    return true;
  } catch (err) {
    process.stderr.write(`security-summary: no ${pattern} artifacts in run ${runId}: ${(err.stderr || err.message || '').toString().trim()}\n`);
    return false;
  }
}

/** The PR number from the pr-meta artifact of the triggering run, or null. */
function readPrMeta(repo, runId, headSha, tmp) {
  const dir = path.join(tmp, 'pr-meta');
  if (!downloadArtifacts(repo, runId, 'pr-meta', dir)) return null;
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.json')) files.push(p);
    }
  };
  walk(dir);
  for (const file of files) {
    try {
      if (fs.statSync(file).size > ROW_FILE_MAX_BYTES) continue;
      const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (isPlainObject(meta) && Number.isInteger(meta.pr) && meta.pr > 0 && meta.sha === headSha) return meta.pr;
    } catch {
      // Not a pr-meta file; keep looking.
    }
  }
  return null;
}

function gitleaksRow(repo, sha) {
  const data = ghJson(`repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(GITLEAKS_CHECK)}&per_page=100`);
  const runs = Array.isArray(data.check_runs) ? data.check_runs : [];
  const run = runs.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')))[0];
  const row = { tool: 'gitleaks', scope: 'scan', status: 'pending', counts: zeroCounts(), note: '' };
  if (!run) return row;
  if (run.html_url) row.link = run.html_url;
  if (run.status !== 'completed') return row;
  const map = { success: 'pass', failure: 'findings', neutral: 'neutral', skipped: 'skipped' };
  row.status = map[run.conclusion] || 'error';
  if (row.status === 'error') row.note = `check ${run.conclusion}`;
  return row;
}

/** Rows of the latest run of each workflow for `sha`, and the names of workflows still running. */
function collectWorkflowRows(repo, sha, tmp) {
  const rows = [];
  const pending = [];
  for (const wf of WORKFLOWS) {
    const data = ghJson(`repos/${repo}/actions/workflows/${wf.file}/runs?head_sha=${sha}&per_page=100`);
    const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
    const latest = runs.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
    if (!latest) continue;
    if (latest.status !== 'completed') {
      pending.push(wf.name);
      continue;
    }
    const dir = path.join(tmp, `rows-${wf.name}`);
    if (downloadArtifacts(repo, latest.id, 'scan-row-*', dir)) rows.push(...readRows(dir));
  }
  return { rows, pending };
}

function upsertVtCheck(repo, sha, rows) {
  const vt = rows.filter((r) => r.tool === 'virustotal');
  if (vt.length === 0) return;
  const neutral = vt.some((r) => r.status === 'neutral');
  const summary = vt.map((r) => {
    const parts = [`- ${r.label}: ${STATUS_TEXT[r.status]}`];
    if (r.note) parts.push(r.note);
    if (r.link) parts.push(r.link);
    return parts.join(' — ');
  }).join('\n');
  const body = {
    status: 'completed',
    conclusion: neutral ? 'neutral' : 'success',
    output: {
      title: neutral ? 'VirusTotal reported detections' : 'VirusTotal: no detections',
      summary,
    },
  };
  const data = ghJson(`repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(VT_CHECK)}&per_page=100`);
  const existing = Array.isArray(data.check_runs) ? data.check_runs[0] : null;
  if (existing) {
    ghSend('PATCH', `repos/${repo}/check-runs/${existing.id}`, body);
  } else {
    ghSend('POST', `repos/${repo}/check-runs`, { name: VT_CHECK, head_sha: sha, ...body });
  }
  process.stdout.write(`security-summary: ${VT_CHECK} -> ${body.conclusion}\n`);
}

function runApplyPr(argv) {
  if (argv.length > 0) throw new UsageError(`apply-pr takes no arguments: ${argv[0]}`);
  const { GH_TOKEN, REPO, RUN_ID, HEAD_SHA } = process.env;
  if (!GH_TOKEN) throw new UsageError('GH_TOKEN is required');
  if (!REPO || !REPO_RE.test(REPO)) throw new UsageError('REPO must be owner/name');
  if (!RUN_ID || !RUN_ID_RE.test(RUN_ID)) throw new UsageError('RUN_ID must be a workflow run id');
  if (!HEAD_SHA || !/^[0-9a-f]{40}$/.test(HEAD_SHA)) throw new UsageError('HEAD_SHA must be a full commit SHA');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'security-summary-'));
  try {
    const prNumber = readPrMeta(REPO, RUN_ID, HEAD_SHA, tmp);
    if (!prNumber) {
      process.stdout.write('security-summary: no pr-meta for this run, nothing to do\n');
      return;
    }
    const pr = ghJson(`repos/${REPO}/pulls/${prNumber}`);
    if (pr.state !== 'open' || !pr.head || pr.head.sha !== HEAD_SHA) {
      process.stdout.write(`security-summary: PR #${prNumber} is not open on ${HEAD_SHA}, skipping\n`);
      return;
    }

    const { rows, pending } = collectWorkflowRows(REPO, HEAD_SHA, tmp);
    rows.push(gitleaksRow(REPO, HEAD_SHA));
    const clean = normalizeRows(rows);
    const block = renderSummary(clean, {
      sha: HEAD_SHA,
      date: new Date().toISOString(),
      runUrl: `https://github.com/${REPO}/pull/${prNumber}/checks`,
      pending,
    });
    const body = pr.body === null || pr.body === undefined ? '' : pr.body;
    const next = replaceBlock(body, block);
    if (next !== body) {
      ghSend('PATCH', `repos/${REPO}/pulls/${prNumber}`, { body: next });
      process.stdout.write(`security-summary: updated PR #${prNumber} (${clean.length} row(s))\n`);
    } else {
      process.stdout.write(`security-summary: PR #${prNumber} body unchanged\n`);
    }
    upsertVtCheck(REPO, HEAD_SHA, clean);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${block}\n`, 'utf8');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const USAGE = 'Usage:\n'
  + '  node scripts/ci/security-summary.js results --rows <dir> --out <dir> --sha <sha>\n'
  + '  GH_TOKEN=... REPO=owner/name RUN_ID=<id> HEAD_SHA=<sha> node scripts/ci/security-summary.js apply-pr\n';

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  try {
    if (mode === 'results') runResults(rest);
    else if (mode === 'apply-pr') runApplyPr(rest);
    else throw new UsageError(`unknown mode: ${mode === undefined ? '(none)' : mode}`);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`security-summary: ${err.message}\n${USAGE}`);
      process.exit(1);
    }
    process.stdout.write(`::warning::security-summary ${mode} failed: ${String(err.message).split('\n')[0]}\n`);
    process.stderr.write(`${err.stack || err.message}\n`);
  }
  process.exit(0);
}

module.exports = {
  START,
  END,
  FALLBACK_BLOCK,
  LABELS,
  STATUS_TEXT,
  normalizeRows,
  renderSummary,
  replaceBlock,
  badgeFor,
  buildResults,
};

if (require.main === module) main();
