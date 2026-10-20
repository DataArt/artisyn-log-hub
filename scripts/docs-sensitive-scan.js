#!/usr/bin/env node
'use strict';

// Docs sensitive-data scanner (one-off check before the open-source release).
//
// Scans every file under docs/ that git knows about (tracked plus untracked,
// not ignored) for proper-name terms, generic sensitive patterns (personal
// mail, local paths, private IPs, token prefixes, known passwords, Azure ids),
// high-entropy strings, mentions of deleted doc paths and broken relative
// markdown links.
//
// Proper names (company, client, user names) are NOT in this file: they live in
// a gitignored terms file, so the published script names nobody.
//
// Modes:
//   node scripts/docs-sensitive-scan.js
//     Scans docs/ except docs/tasks/todo/, terms from <root>/tmp/docs-sensitive-terms.json.
//   node scripts/docs-sensitive-scan.js --include-todo
//     Also scans docs/tasks/todo/.
//   node scripts/docs-sensitive-scan.js --terms <file>
//     Terms file, resolved against the current directory.
//   node scripts/docs-sensitive-scan.js --root <dir>
//     Repository root (default: git rev-parse --show-toplevel).
//
// Terms file: { "terms": [ { "rule": "<name>", "re": "<regex source>" } ] },
// each regex compiled with the flags `iu`.
//
// Output: findings on stdout as `<file>:<line>: [<rule>] <excerpt>`, a summary
// on stderr. Exit 0 when clean, 1 when there are findings, 2 on a usage,
// terms or git error.
//
// The pure helpers are exported; all CLI work sits behind `require.main === module`.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---- Built-in generic rules (applied one line at a time) -----------------------------------------
const RULES = [
  { rule: 'personal-mail',   re: /@(yandex|gmail|mail\.ru|outlook|hotmail|icloud)\./i },
  { rule: 'drive-work-path', re: /[A-Za-z]:[\\/]+_work\b|\/mnt\/[a-z]\/(_work|Development)\b/i },
  { rule: 'windows-user',    re: /[\\/]Users[\\/]+(?!(?:alice|user|dev|foo|Public|<)(?:[\\/>\s]|$))[A-Za-z0-9._-]+/ },
  { rule: 'home-user',       re: /\/home\/(?!(?:user|dev|u|e2e|alice|node|runner|<)(?:[\/\s'"`]|$))[A-Za-z0-9._-]+/ },
  { rule: 'private-ip',      re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/ },
  { rule: 'token-prefix',    re: /\b(?:sk-ant-|glpat-|ghp_|gho_|github_pat_|xox[bp]-|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,})/ },
  { rule: 'known-password',  re: /123123123|PerfTest#1234/ },
  { rule: 'azure-id',        re: /(?:tenant|client.?id|AZURE_[A-Z_]+|api:\/\/).{0,40}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
];
const ENTROPY_TOKEN = /[A-Za-z0-9+\/_=-]{32,}/g;
const ENTROPY_MIN = 4.5; // bits per char

// Mentions (backtick or prose) of doc paths that the docs cleanup deletes or moves.
const DELETED_PATH_RE = /docs\/(?:archive\/|research\/|sample logs|tasks\/done\/\d|qaa-overview\/(?:\d{2}-(?!new-test-suite|algorithm-units)|README|analysis\/|scenarios\/07)|claude-devtools-comparison|copilot-session-tracking|otel-parity|preflight-comparison|skill-refactoring|suggested-indices|api-sql-summary)/;

// ---- Allowlist -----------------------------------------------------------------------------------
// Each entry: { rule, file: RegExp on the repo-relative posix path, match?: RegExp on the excerpt,
// reason }. Only confirmed false positives go here, scoped as narrowly as possible (file + match).
// Real data is always replaced, never allowlisted.
const ALLOW = [
  // category: documented example IPs of the local-request detection algorithm
  { rule: 'private-ip', file: /^docs\/knowledgebase\/algorithms\/local-request-detection\.md$/,
    reason: 'example private IPs are the algorithm\'s documented inputs' },
  { rule: 'private-ip', file: /^docs\/knowledgebase\/authorization-and-authentificaiton\.md$/,
    match: /172\.17\.0\.1\b/,
    reason: 'Docker default bridge gateway, a well-known address, not a real host' },
  // category: synthetic placeholder UUIDs (11111111-2222-…, aaaaaaaa-bbbb-…), not real Azure ids
  { rule: 'azure-id', file: /^docs\/knowledgebase\/algorithms\/auth-startup-config\.md$/,
    reason: 'synthetic placeholder UUIDs in the algorithm examples' },
  { rule: 'high-entropy', file: /^docs\/knowledgebase\/algorithms\/auth-startup-config\.md$/,
    reason: 'synthetic placeholder secrets in the algorithm examples' },
  // category: open-source checklists that describe the very patterns being removed
  { rule: '*', file: /^docs\/open-source-readiness\.md$/,
    reason: 'readiness checklist quotes the patterns it asks to remove' },
  { rule: '*', file: /^docs\/todo-pre-opensource\.md$/,
    reason: 'pre-open-source todo quotes the patterns it asks to remove' },
];

// ---- Helpers -------------------------------------------------------------------------------------

/** Shannon entropy of a string, in bits per character: H = -sum(p_c * log2 p_c). */
function shannonEntropy(str) {
  if (!str) return 0;
  const counts = new Map();
  for (const ch of str) counts.set(ch, (counts.get(ch) || 0) + 1);
  const len = [...str].length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / len;
    h -= p * Math.log2(p);
  }
  return h;
}

/** First token of a line that is high-entropy (letter + digit, entropy >= ENTROPY_MIN), or null. */
function findHighEntropy(line) {
  const re = new RegExp(ENTROPY_TOKEN.source, 'g');
  let m;
  while ((m = re.exec(line)) !== null) {
    const tok = m[0];
    if (/[A-Za-z]/.test(tok) && /\d/.test(tok) && shannonEntropy(tok) >= ENTROPY_MIN) {
      return { index: m.index, text: tok };
    }
  }
  return null;
}

/** Excerpt of at most 120 chars around a match position. */
function excerptOf(line, index) {
  const t = line.replace(/\t/g, ' ');
  if (t.trim().length <= 120) return t.trim();
  const start = Math.max(0, Math.min(index - 40, t.length - 120));
  return t.slice(start, start + 120).trim();
}

/** Compile terms-file JSON text into rules; throws with a readable message when invalid. */
function parseTerms(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON: ${err.message}`);
  }
  if (!data || !Array.isArray(data.terms)) throw new Error('expected { "terms": [ ... ] }');
  return data.terms.map((t, i) => {
    if (!t || typeof t.rule !== 'string' || !t.rule || typeof t.re !== 'string' || !t.re) {
      throw new Error(`terms[${i}] needs non-empty string "rule" and "re"`);
    }
    try {
      return { rule: t.rule, re: new RegExp(t.re, 'iu') };
    } catch (err) {
      throw new Error(`terms[${i}] (${t.rule}): ${err.message}`);
    }
  });
}

/** True when an ALLOW entry suppresses the finding. */
function isAllowed(finding, allow = ALLOW) {
  return allow.some((a) =>
    (a.rule === '*' || a.rule === finding.rule) &&
    a.file.test(finding.file) &&
    (!a.match || a.match.test(finding.excerpt)));
}

/** Line findings (before the allowlist) for one line: one per rule. */
function scanLine(file, n, line, termRules) {
  const out = [];
  for (const r of [...termRules, ...RULES, { rule: 'deleted-path', re: DELETED_PATH_RE }]) {
    const m = r.re.exec(line);
    if (m) out.push({ file, line: n, rule: r.rule, excerpt: excerptOf(line, m.index) });
  }
  const he = findHighEntropy(line);
  if (he) out.push({ file, line: n, rule: 'high-entropy', excerpt: excerptOf(line, he.index) });
  return out;
}

/** Lines of a markdown text, each flagged when it sits inside a fenced code block. */
function mdLines(text) {
  let fence = null;
  return text.split(/\r?\n/).map((t, i) => {
    const m = t.match(/^\s*(```+|~~~+)/);
    let inFence = fence !== null;
    if (m) {
      if (fence === null) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      inFence = true;
    }
    return { n: i + 1, text: t, inFence };
  });
}

/** Markdown link targets `](target)` on a line, ignoring inline code spans. */
function linksOf(text) {
  const clean = text.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length));
  const out = [];
  const re = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  let m;
  while ((m = re.exec(clean)) !== null) out.push({ target: m[1], index: m.index });
  return out;
}

/** Repo-relative path a relative link target points at, or null when it is not checked. */
function linkPath(fileRel, target) {
  if (/^(?:https?:|mailto:)/i.test(target) || target.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null;
  let p = target.replace(/[#?].*$/, '');
  if (!p) return null;
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep the raw target when it is not valid percent-encoding
  }
  if (p.startsWith('/')) return path.posix.normalize(p.slice(1));
  return path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), p));
}

/** broken-link findings of one markdown file. */
function brokenLinks(root, fileRel, text) {
  const out = [];
  for (const { n, text: line, inFence } of mdLines(text)) {
    if (inFence) continue;
    for (const { target, index } of linksOf(line)) {
      const p = linkPath(fileRel, target);
      if (p === null) continue;
      if (!fs.existsSync(path.join(root, ...p.split('/')))) {
        out.push({ file: fileRel, line: n, rule: 'broken-link', excerpt: excerptOf(line, index) });
      }
    }
  }
  return out;
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function parseArgs(argv) {
  const opts = { terms: null, includeTodo: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--include-todo') opts.includeTodo = true;
    else if (a === '--terms' || a === '--root') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

// ---- CLI -----------------------------------------------------------------------------------------

function usageExit(msg) {
  process.stderr.write(`docs-sensitive-scan: ${msg}\n`);
  process.stderr.write('usage: node scripts/docs-sensitive-scan.js [--terms <file>] [--include-todo] [--root <dir>]\n');
  process.exit(2);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    usageExit(err.message);
  }

  let root;
  try {
    root = opts.root
      ? path.resolve(opts.root)
      : execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch (err) {
    usageExit(`cannot find the repository root: ${err.message}`);
  }

  const termsFile = opts.terms
    ? path.resolve(process.cwd(), opts.terms)
    : path.join(root, 'tmp', 'docs-sensitive-terms.json');
  let termRules;
  try {
    termRules = parseTerms(fs.readFileSync(termsFile, 'utf8'));
  } catch (err) {
    usageExit(`terms file ${termsFile}: ${err.code === 'ENOENT' ? 'not found' : err.message}`);
  }

  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard', '--', 'docs'], {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    }).split('\0').filter(Boolean);
  } catch (err) {
    usageExit(`git ls-files failed: ${err.message}`);
  }
  files = [...new Set(files)].sort();
  if (!opts.includeTodo) files = files.filter((f) => !f.startsWith('docs/tasks/todo/'));

  let scanned = 0;
  let binary = 0;
  const findings = [];
  for (const rel of files) {
    const abs = path.join(root, ...rel.split('/'));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const buf = fs.readFileSync(abs);
    if (isBinary(buf)) {
      binary++;
      continue;
    }
    scanned++;
    const text = buf.toString('utf8');
    text.split(/\r?\n/).forEach((line, i) => findings.push(...scanLine(rel, i + 1, line, termRules)));
    if (rel.toLowerCase().endsWith('.md')) findings.push(...brokenLinks(root, rel, text));
  }

  const kept = findings
    .filter((f) => !isAllowed(f))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const perRule = {};
  const lines = [];
  for (const f of kept) {
    lines.push(`${f.file}:${f.line}: [${f.rule}] ${f.excerpt}\n`);
    perRule[f.rule] = (perRule[f.rule] || 0) + 1;
  }
  // Synchronous write, so nothing is lost on a pipe before process.exit.
  if (lines.length > 0) fs.writeSync(1, lines.join(''));
  process.stderr.write(`scanned ${scanned}, binary ${binary}, findings ${kept.length}\n`);
  for (const r of Object.keys(perRule).sort()) process.stderr.write(`  ${r}: ${perRule[r]}\n`);
  process.exit(kept.length > 0 ? 1 : 0);
}

module.exports = {
  RULES,
  ENTROPY_TOKEN,
  ENTROPY_MIN,
  DELETED_PATH_RE,
  ALLOW,
  shannonEntropy,
  findHighEntropy,
  excerptOf,
  parseTerms,
  isAllowed,
  scanLine,
  mdLines,
  linksOf,
  linkPath,
  brokenLinks,
  isBinary,
  parseArgs,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`docs-sensitive-scan error: ${err.message}\n`);
    process.exit(2);
  }
}
