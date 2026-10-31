// The per-OS-user OTEL state dir `~/.artisyn/otel/` (DD-4, DD-5) — installer side.
//
// TS twin of `hook/.claude/telemetry_tool/user-state.js`: the two packages cannot import each
// other, so the shapes, the hashing and the token rules are repeated here. Keep both identical.
// Erasable TypeScript syntax only (no enums, namespaces or parameter properties).
//
//   port.json            installer   {version:1, port, allocatedAt}
//   token                installer, or the hook if missing — 64 lowercase hex chars, no newline
//   repos.json           installer   {version:1, repos:[RepoEntry]}
//   registry.json        receiver    (never written here)
//   forward.json         installer   {version:1, mode, fingerprint, signals, original, savedAt}
//   receiver.log         receiver
//   claude-version.json  hook
//   bin/                 installer   otel-receiver.js, version.json, otel-ensure-receiver.js
//
// The dir is resolved per call from `os.homedir()` — never cached — so a fake HOME/USERPROFILE (the
// scenario suite) isolates it. Files are written tmp + rename, mode 0o600 on POSIX; on Windows the
// profile dir is already user-only, so no ACL is applied. Readers fail soft (null / an empty shape).

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const STATE_FILE_NAMES = {
  port: 'port.json',
  token: 'token',
  repos: 'repos.json',
  registry: 'registry.json',
  forward: 'forward.json',
  receiverLog: 'receiver.log',
  claudeVersion: 'claude-version.json',
  binDir: 'bin',
} as const;

export type StateFileName = keyof typeof STATE_FILE_NAMES;

export const FORWARD_MODES = ['proxy', 'keep', 'replace', 'none'] as const;
export type ForwardMode = typeof FORWARD_MODES[number];

const TOKEN_RE = /^[0-9a-f]{64}$/;

export type StateDirOpts = { stateDir?: string; homeDir?: string };

export type PortFile = { version: number; port: number; allocatedAt: string | null };

export type RepoEntry = {
  repoKey: string;
  gitRoot: string;
  otelDir: string;
  uploader: string;
  traces: boolean;
  installedAt: string;
  hookVersion: string;
};

export type ReposFile = { version: 1; repos: RepoEntry[] };

/** `<home>/.artisyn/otel`. `homeDir` defaults to `os.homedir()`, read per call. */
export function otelStateDir(homeDir?: string): string {
  return path.join(homeDir || os.homedir(), '.artisyn', 'otel');
}

/** Absolute path of one state file (or of `bin/`). */
export function stateFilePath(name: StateFileName, opts: StateDirOpts = {}): string {
  return path.join(opts.stateDir || otelStateDir(opts.homeDir), STATE_FILE_NAMES[name]);
}

/** Parse a JSON object file; `null` when missing, unreadable, not JSON or not a plain object. */
export function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Write `content` to `file` atomically: a sibling tmp file, then rename over the target. Creates the
 * parent dir (mode 0o700). Throws on failure, after removing the tmp file — the installer reports it.
 */
export function atomicWriteFile(file: string, content: string | Buffer): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

/** `atomicWriteFile` of pretty-printed JSON. */
export function atomicWriteJson(file: string, value: unknown): void {
  atomicWriteFile(file, JSON.stringify(value, null, 2) + '\n');
}

/** `port.json`, validated: an integer port in 1..65535, else `null`. */
export function readPortFile(opts: StateDirOpts = {}): PortFile | null {
  const parsed = readJsonObject(stateFilePath('port', opts));
  if (!parsed) return null;
  const port = Number(parsed['port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    version: typeof parsed['version'] === 'number' ? parsed['version'] : 1,
    port,
    allocatedAt: typeof parsed['allocatedAt'] === 'string' ? parsed['allocatedAt'] : null,
  };
}

/** Write `port.json` with a fresh `allocatedAt`. */
export function writePortFile(port: number, opts: StateDirOpts = {}): void {
  atomicWriteJson(stateFilePath('port', opts), { version: 1, port, allocatedAt: new Date().toISOString() });
}

/**
 * Read `token`; with `create` (default) generate one when it is missing. The file is created with
 * the `wx` flag, so of two racing creators exactly one wins and the loser reads the winner's token.
 * An existing but malformed token is never overwritten — `null` then.
 */
export function readOrCreateToken(opts: StateDirOpts & { create?: boolean } = {}): string | null {
  const file = stateFilePath('token', opts);
  const read = (): string | null | undefined => {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      return TOKEN_RE.test(value) ? value : null;
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? undefined : null;
    }
  };
  const existing = read();
  if (existing !== undefined || opts.create === false) return existing === undefined ? null : existing;
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      const winner = read();
      return winner === undefined ? null : winner;
    }
    return null;
  }
}

function isRepoEntry(entry: unknown): entry is Record<string, unknown> {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  return typeof e['repoKey'] === 'string' && e['repoKey'] !== ''
    && typeof e['gitRoot'] === 'string' && e['gitRoot'] !== ''
    && typeof e['otelDir'] === 'string' && e['otelDir'] !== '';
}

function toRepoEntry(e: Record<string, unknown>): RepoEntry {
  return {
    repoKey: e['repoKey'] as string,
    gitRoot: e['gitRoot'] as string,
    otelDir: e['otelDir'] as string,
    uploader: typeof e['uploader'] === 'string' ? e['uploader'] : '',
    traces: e['traces'] === true,
    installedAt: typeof e['installedAt'] === 'string' ? e['installedAt'] : '',
    hookVersion: typeof e['hookVersion'] === 'string' ? e['hookVersion'] : '',
  };
}

/** `repos.json`; a missing or malformed file reads as no repos. Malformed entries are dropped. */
export function readRepos(opts: StateDirOpts = {}): ReposFile {
  const parsed = readJsonObject(stateFilePath('repos', opts));
  const raw = parsed && Array.isArray(parsed['repos']) ? (parsed['repos'] as unknown[]) : [];
  return { version: 1, repos: raw.filter(isRepoEntry).map(toRepoEntry) };
}

/**
 * Insert or replace this repo's `repos.json` entry (matched by `repoKey`). An existing
 * `installedAt` is kept, so it records the first install. Returns the written entry.
 */
export function upsertRepoEntry(entry: Omit<RepoEntry, 'installedAt'>, opts: StateDirOpts = {}): RepoEntry {
  const current = readRepos(opts);
  const previous = current.repos.find(r => r.repoKey === entry.repoKey);
  const next: RepoEntry = { ...entry, installedAt: previous?.installedAt || new Date().toISOString() };
  const repos = current.repos.filter(r => r.repoKey !== entry.repoKey);
  repos.push(next);
  atomicWriteJson(stateFilePath('repos', opts), { version: 1, repos });
  return next;
}

/** `forward.json` when it has a known `mode`, else `null`. */
export function readForward(opts: StateDirOpts = {}): Record<string, unknown> | null {
  const parsed = readJsonObject(stateFilePath('forward', opts));
  if (!parsed || !(FORWARD_MODES as readonly unknown[]).includes(parsed['mode'])) return null;
  return parsed;
}

/**
 * The path form both hashes are taken over (DD-5): resolved, forward slashes, no trailing slash
 * (except a bare root), lowercased on win32.
 */
export function normalizeForKey(value: string, platform: string = process.platform): string {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  let resolved = impl.resolve(String(value)).replace(/\\/g, '/');
  if (resolved.length > 1 && !/^[A-Za-z]:\/$/.test(resolved)) resolved = resolved.replace(/\/+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The repo identifier carried in OTLP resource attributes: first 16 hex chars of
 * sha256(normalized git root). Twins: `user-state.js`, `otel-receiver.js`.
 */
export function repoKey(gitRoot: string, platform: string = process.platform): string {
  return crypto.createHash('sha256').update(normalizeForKey(gitRoot, platform)).digest('hex').slice(0, 16);
}

/**
 * sha256 hex of the normalized home dir — the hello `ownerHash` (DD-9).
 * Twins: `user-state.js`, `otel-receiver.js`, `otel-ensure-receiver.js`.
 */
export function ownerHash(home: string, platform: string = process.platform): string {
  return crypto.createHash('sha256').update(normalizeForKey(home, platform)).digest('hex');
}

/**
 * Drop this repo's `repos.json` entry (uninstall, DD-27). Installer only — the hook never removes
 * entries. Returns the entries that remain. A missing file stays missing.
 */
export function removeRepoEntry(key: string, opts: StateDirOpts = {}): RepoEntry[] {
  const file = stateFilePath('repos', opts);
  const current = readRepos(opts);
  const repos = current.repos.filter(r => r.repoKey !== key);
  if (fs.existsSync(file) && repos.length !== current.repos.length) {
    atomicWriteJson(file, { version: 1, repos });
  }
  return repos;
}
