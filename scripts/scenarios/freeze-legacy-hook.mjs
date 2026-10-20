#!/usr/bin/env node
// Freezes one historical version of the hook for S-COMPAT-01 (impl-plan DD SC5).
//
// The repository has no release tags, so a legacy hook is identified by a commit. The script reads
// `hook/.claude/telemetry_tool/` at that commit through `git archive` (read-only: nothing in the
// working tree or the index is touched) and writes it to `tests/fixtures/legacy-hooks/<label>/`,
// plus a `FROZEN.json` with `{ commit, version, frozenFrom }`. Tests (`__tests__/`) and env files
// (`.env`, `.env.local`) are left out: a scenario writes its own config.
//
// A frozen hook is never refreshed — it stands for what users who never upgrade still run.
//
// Finding the commit: every commit that touched the version file, with the version it set:
//   git log --format=%h -- hook/.claude/telemetry_tool/version.json
// (DD SC5 names `git log -S'"version"'`, but -S only reports commits that change the NUMBER of
// occurrences of the string, i.e. just the file's creation.) The last commit of a version is the
// parent of the commit that bumped past it, e.g. `<sha of 1.7.0>^` for the last 1.6.x.
//
// Usage:
//   node scripts/scenarios/freeze-legacy-hook.mjs --commit <sha> [--label <ver>] [--force]
//
//   --commit  any commit-ish git understands (`4d4e6d9^` works);
//   --label   directory name; defaults to the version.json at that commit. When given it must
//             equal that version, so a label can never lie about what was frozen;
//   --force   replace an existing frozen directory (otherwise an existing one is an error).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_DIR = 'hook/.claude/telemetry_tool';
export const LEGACY_HOOKS_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'legacy-hooks');
const EXCLUDED_TOP_LEVEL = new Set(['__tests__', '.env', '.env.local', 'node_modules']);

function fail(message) {
  process.stderr.write(`freeze-legacy-hook: ${message}\n`);
  process.exit(1);
}

/** `--commit`, `--label`, `--force` from argv. */
export function parseArgs(argv) {
  const out = { commit: '', label: '', force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      out.force = true;
    } else if (arg === '--commit' || arg === '--label') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      out[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!out.commit) throw new Error('--commit <sha> is required');
  if (out.label && !/^[0-9A-Za-z._-]+$/.test(out.label)) throw new Error(`--label "${out.label}" is not a plain directory name`);
  return out;
}

function git(args, { binary = false } = {}) {
  const res = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: binary ? 'buffer' : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const stderr = Buffer.isBuffer(res.stderr) ? res.stderr.toString('utf8') : res.stderr;
    throw new Error(`git ${args.join(' ')} failed: ${String(stderr).trim()}`);
  }
  return res.stdout;
}

/** Parses a pax header block (`<len> key=value\n` records). */
function parsePax(data) {
  const out = {};
  let rest = data.toString('utf8');
  while (rest.length > 0) {
    const space = rest.indexOf(' ');
    if (space <= 0) break;
    const len = Number(rest.slice(0, space));
    if (!Number.isInteger(len) || len <= 0) break;
    const record = rest.slice(space + 1, len - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    rest = rest.slice(len);
  }
  return out;
}

/**
 * Regular-file entries of the tar stream `git archive` writes (ustar with a global pax header;
 * per-entry pax headers only for long names). Returns `[name, data]` pairs.
 */
export function untarEntries(buffer) {
  const entries = [];
  let offset = 0;
  let paxPath = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) break;
    const field = (start, len) => {
      const slice = header.subarray(start, start + len);
      const nul = slice.indexOf(0);
      return slice.subarray(0, nul < 0 ? len : nul).toString('utf8');
    };
    const size = parseInt(field(124, 12).trim(), 8) || 0;
    const type = String.fromCharCode(header[156]);
    const data = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === 'x') {
      paxPath = parsePax(data).path ?? null;
      continue;
    }
    if (type === 'g') continue;
    const prefix = field(345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    paxPath = null;
    if (type === '0' || type === '\0') entries.push([name, Buffer.from(data)]);
  }
  return entries;
}

/** Keeps the hook files below HOOK_DIR, relative to it, minus the excluded top-level names. */
export function selectHookFiles(entries) {
  const prefix = `${HOOK_DIR}/`;
  return entries
    .filter(([name]) => name.startsWith(prefix))
    .map(([name, data]) => [name.slice(prefix.length), data])
    .filter(([rel]) => rel !== '' && !EXCLUDED_TOP_LEVEL.has(rel.split('/')[0]));
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err.message);
  }

  const commit = git(['rev-parse', '--verify', `${args.commit}^{commit}`]).trim();
  const files = selectHookFiles(untarEntries(git(['archive', '--format=tar', commit, '--', HOOK_DIR], { binary: true })));
  const versionFile = files.find(([rel]) => rel === 'version.json');
  if (!versionFile) fail(`${HOOK_DIR}/version.json does not exist at ${commit}`);
  const version = JSON.parse(versionFile[1].toString('utf8')).version;
  if (typeof version !== 'string' || version === '') fail(`version.json at ${commit} has no version`);
  if (args.label && args.label !== version) {
    fail(`--label ${args.label} does not match version.json at ${commit} (${version})`);
  }
  const label = args.label || version;

  const dest = path.join(LEGACY_HOOKS_DIR, label);
  if (fs.existsSync(dest)) {
    if (!args.force) fail(`${path.relative(REPO_ROOT, dest)} already exists — frozen hooks are never refreshed (use --force to replace)`);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  for (const [rel, data] of files) {
    const target = path.join(dest, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  const frozen = { commit, version, frozenFrom: HOOK_DIR };
  fs.writeFileSync(path.join(dest, 'FROZEN.json'), `${JSON.stringify(frozen, null, 2)}\n`, 'utf8');
  process.stdout.write(`Frozen hook ${version} (${commit.slice(0, 10)}): ${files.length} files → ${path.relative(REPO_ROOT, dest)}\n`);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
