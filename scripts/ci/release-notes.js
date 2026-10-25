#!/usr/bin/env node
'use strict';

// Release notes of one GitHub Release for the `publish` job of
// .github/workflows/release.yml. Algorithm and examples:
// docs/knowledgebase/algorithms/release-assets.md.
//
// The notes have three sections:
//   ## What's new     every docs/changelog/ entry added since the previous tag (see below),
//                     newest first, one `### <title>` per entry: the human-readable summary
//   ## Commits        `- <subject> (<sha>)` per commit, newest first, at most 500 lines,
//                     then `…and <n> more` linking the compare view <prev>...<tag>; folded
//                     into a <details> block
//   ## Security scan  the image digest, a `File | SHA-256 | VirusTotal` table built from
//                     SHA256SUMS, and the commands to verify checksums and attestations
//
// VirusTotal cell per file (scope from scopeFor of scripts/ci/virustotal-scan.js):
//   artisyn-log-hub-X.Y.Z.zip -> release-zip, install.sh -> install-sh, install.ps1 -> install-ps1
//   row status pass            -> `<note> [permalink](<link>)`
//   any other row status       -> `<status>: <note>`
//   file without a scope       -> `not scanned`
//   scope without a row file   -> `no result`
//
// Changelog entries are the docs/changelog/ files (<YYYY-MM-DD-HHmm>-<slug>.md) added between
// the previous tag and <head> (every entry at <head> on the first release). With --changes-out
// the same entries are also written as CHANGES.md, a release asset.
//
// Modes:
//   node scripts/ci/release-notes.js --version X.Y.Z --tag vX.Y.Z [--previous-tag vA.B.C]
//        --head <sha> --digest <sha256:...> --sums <SHA256SUMS> [--rows <dir>]
//        --repo <owner/name> --out <file> [--changes-out <file>]
//     Commits come from `git log --no-merges --format=%h%x09%s <prev>..<head>`
//     (`<head>` alone without a previous tag). Rows are every row-virustotal-*.json
//     in --rows; a missing directory means no rows. Changelog entries are the files
//     `git diff --name-only --diff-filter=A <prev> <head> -- docs/changelog/` adds
//     (`git ls-tree --name-only <head> docs/changelog/` without a previous tag), read with
//     `git show <head>:<path>`.
//
//   require('scripts/ci/release-notes.js') exports the pure renderNotes, parseSums,
//   parseChangelogEntry and renderChanges.
//
// Exit codes: 0 after writing the notes, 1 on a usage or I/O error.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { scopeFor } = require('./virustotal-scan');

const IMAGE = 'ghcr.io/dataart/artisyn-log-hub';
const COMMIT_CAP = 500;
const ROW_FILE_RE = /^row-virustotal-.+\.json$/;
const CHANGELOG_DIR = 'docs/changelog';
const CHANGELOG_FILE_RE = /^\d{4}-\d{2}-\d{2}-\d{4}-.+\.md$/;

// ------------------------------------------------------------ pure part ----

/** SHA256SUMS text -> [{name, sha256}] in file order; blank and malformed lines are skipped. */
function parseSums(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => /^([0-9a-f]{64}) [ *]?(.+)$/i.exec(line.trim()))
    .filter(Boolean)
    .map((m) => ({ name: m[2], sha256: m[1].toLowerCase() }));
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function vtCell(name, rowsByScope) {
  const scope = scopeFor(name);
  if (!scope) return 'not scanned';
  const row = rowsByScope[scope];
  if (!row) return 'no result';
  if (row.status === 'pass') {
    return row.link ? `${row.note} [permalink](${row.link})` : String(row.note);
  }
  return `${row.status}: ${row.note}`;
}

/**
 * Lines of the changelog entries, newest first by name (the name starts with the timestamp):
 * per entry an empty line, `<heading> <title>` and, when there is a body, an empty line and
 * the body. No entries: an empty line and `No changelog entries.`
 */
function entryLines(entries, heading) {
  const sorted = (entries || []).slice().sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  if (sorted.length === 0) return ['', 'No changelog entries.'];
  const lines = [];
  for (const entry of sorted) {
    const { title, body } = parseChangelogEntry(entry.name, entry.text);
    lines.push('', `${heading} ${title}`);
    if (body) lines.push('', body);
  }
  return lines;
}

/**
 * Markdown body of the release.
 *   entries  [{name, text}] docs/changelog/ files added since the previous tag, any order
 *   commits  [{sha, subject}], newest first
 *   sums     [{name, sha256}] (parseSums)
 *   rows     VirusTotal scan rows ({tool, scope, status, note, link?})
 */
function renderNotes({ version, tag, previousTag, repo, entries, commits, digest, sums, rows }) {
  const lines = ['## What\'s new', ...entryLines(entries, '###'), '', '## Commits', ''];
  const list = commits || [];
  if (list.length === 0) {
    lines.push('No commits.');
  } else {
    lines.push('<details>', `<summary>${list.length} commit${list.length === 1 ? '' : 's'}</summary>`, '');
    for (const c of list.slice(0, COMMIT_CAP)) lines.push(`- ${c.subject} (${c.sha})`);
    if (list.length > COMMIT_CAP) {
      const more = list.length - COMMIT_CAP;
      const href = previousTag
        ? `https://github.com/${repo}/compare/${previousTag}...${tag}`
        : `https://github.com/${repo}/commits/${tag}`;
      lines.push(`- […and ${more} more](${href})`);
    }
    lines.push('', '</details>');
  }

  const rowsByScope = {};
  for (const row of rows || []) {
    if (row && row.scope) rowsByScope[row.scope] = row;
  }

  lines.push('', '## Security scan', '');
  lines.push(`Image \`${IMAGE}:${version}\`, digest \`${digest}\`.`, '');
  lines.push('| File | SHA-256 | VirusTotal |', '|---|---|---|');
  for (const s of sums || []) {
    lines.push(`| \`${cell(s.name)}\` | \`${s.sha256}\` | ${cell(vtCell(s.name, rowsByScope))} |`);
  }
  lines.push(
    '',
    'Verify the downloaded files and the image:',
    '',
    '```sh',
    'sha256sum -c SHA256SUMS --ignore-missing',
    `gh attestation verify <file> -R ${repo}`,
    `gh attestation verify oci://${IMAGE}:${version} -R ${repo}`,
    '```',
    '',
    'On Windows, and for what to do with a scanner warning, see "Verify the downloads" in the '
      + 'release\'s `README.md`.',
    '',
  );
  return lines.join('\n');
}

/**
 * One docs/changelog/ file -> {name, title, body}. The title is the first `# ` heading (the
 * file name without `.md` when there is none); the body is the rest, trimmed.
 */
function parseChangelogEntry(name, text) {
  const lines = String(text || '').split(/\r?\n/);
  const at = lines.findIndex((line) => /^#\s+\S/.test(line));
  const title = at >= 0 ? lines[at].replace(/^#\s+/, '').trim() : name.replace(/\.md$/, '');
  const rest = at >= 0 ? lines.slice(0, at).concat(lines.slice(at + 1)) : lines;
  return { name, title, body: rest.join('\n').trim() };
}

/**
 * CHANGES.md of the release.
 *   entries  [{name, text}] docs/changelog/ files in any order; rendered newest first by name
 *            (the name starts with the timestamp)
 */
function renderChanges({ tag, previousTag, repo, entries }) {
  const lines = [`# What's new in ${tag}`, ''];
  lines.push(previousTag
    ? `Changes since [${previousTag}](https://github.com/${repo}/releases/tag/${previousTag}).`
    : 'First release.');
  lines.push(...entryLines(entries, '##'), '');
  return lines.join('\n');
}

// ----------------------------------------------------------------- I/O ----

const VALUE_ARGS = [
  'version', 'tag', 'previous-tag', 'head', 'digest', 'sums', 'rows', 'repo', 'out', 'changes-out',
];
const REQUIRED_ARGS = ['version', 'tag', 'head', 'digest', 'sums', 'repo', 'out'];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (VALUE_ARGS.includes(name) && i + 1 < argv.length) {
      args[name] = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    }
  }
  for (const name of REQUIRED_ARGS) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  return args;
}

function readCommits(previousTag, head) {
  const range = previousTag ? `${previousTag}..${head}` : head;
  const out = execFileSync('git', ['log', '--no-merges', '--format=%h%x09%s', range], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
  });
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function readChangelog(previousTag, head) {
  const listed = previousTag
    ? git(['diff', '--name-only', '--diff-filter=A', previousTag, head, '--', `${CHANGELOG_DIR}/`])
    : git(['ls-tree', '--name-only', head, `${CHANGELOG_DIR}/`]);
  return listed.split(/\r?\n/)
    .filter((file) => file.startsWith(`${CHANGELOG_DIR}/`))
    .map((file) => ({ file, name: file.slice(CHANGELOG_DIR.length + 1) }))
    .filter(({ name }) => CHANGELOG_FILE_RE.test(name))
    .map(({ file, name }) => ({ name, text: git(['show', `${head}:${file}`]) }));
}

function readRows(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => ROW_FILE_RE.test(name))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const previousTag = args['previous-tag'] || '';
    const entries = readChangelog(previousTag, args.head);
    const notes = renderNotes({
      version: args.version,
      tag: args.tag,
      previousTag,
      repo: args.repo,
      entries,
      commits: readCommits(previousTag, args.head),
      digest: args.digest,
      sums: parseSums(fs.readFileSync(args.sums, 'utf8')),
      rows: readRows(args.rows),
    });
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, notes, 'utf8');
    process.stdout.write(`release-notes: ${args.tag} -> ${args.out}\n`);
    if (args['changes-out']) {
      const changes = renderChanges({
        tag: args.tag,
        previousTag,
        repo: args.repo,
        entries,
      });
      fs.mkdirSync(path.dirname(path.resolve(args['changes-out'])), { recursive: true });
      fs.writeFileSync(args['changes-out'], changes, 'utf8');
      process.stdout.write(`release-notes: ${args.tag} changes -> ${args['changes-out']}\n`);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`release-notes: ${err.message}\n`
      + 'Usage: node scripts/ci/release-notes.js --version X.Y.Z --tag vX.Y.Z [--previous-tag vA.B.C] '
      + '--head <sha> --digest <sha256:...> --sums <SHA256SUMS> [--rows <dir>] --repo <owner/name> '
      + '--out <file> [--changes-out <file>]\n');
    process.exit(1);
  }
}

module.exports = { renderNotes, parseSums, parseChangelogEntry, renderChanges, COMMIT_CAP };

if (require.main === module) main();
