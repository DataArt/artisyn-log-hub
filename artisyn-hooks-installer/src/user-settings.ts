// The user-scope Claude Code settings file (`~/.claude/settings.json`, or
// `$CLAUDE_CONFIG_DIR/settings.json`) — read, validate, back up, merge and write (DD-23).
//
// High blast radius: Claude Code skips the WHOLE user file when a known key has the wrong type, so
// every write is validated first and refused (file untouched) on a violation, and the previous
// content is copied to `<settings>.artisyn-bak` before the write. An unparsable file aborts with no
// write at all.
//
// It also owns the OTEL-key ownership rules shared with the project-file merge in `install.ts`
// (`isArtisynOwnedOtelValue`, `mergeOwnedOtelKey`), so both files are judged identically.
// Erasable TypeScript syntax only.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OTEL_ENV_KEYS, OTEL_ENDPOINT_KEYS, OTEL_TRACE_ENV_KEYS, OTEL_TRACE_ENDPOINT_KEY } from './otel-env';
import { atomicWriteFile } from './user-state';

// The allocation range of receiver ports — a loopback endpoint on a port in it is ours.
export const OTEL_PORT_MIN = 25000;
export const OTEL_PORT_MAX = 65535;

// A loopback OTLP logs/metrics/traces endpoint — the shape the installer writes. Capture group 1 is
// the port. Matching it is necessary but not sufficient for ownership: see `isArtisynOwnedOtelValue`.
export const OTEL_LOOPBACK_ENDPOINT_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})\/v1\/(?:logs|metrics|traces)$/;

// Every OTEL env key carrying a receiver endpoint — the base two plus the opt-in traces one.
export const ALL_OTEL_ENDPOINT_KEYS: readonly string[] = [...OTEL_ENDPOINT_KEYS, OTEL_TRACE_ENDPOINT_KEY];

// The value the installer writes for each port-independent OTEL key (base and trace).
export const ALL_OTEL_EXPECTED_VALUES: Record<string, string> = { ...OTEL_ENV_KEYS(0), ...OTEL_TRACE_ENV_KEYS(0) };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isOtelEndpointKey(key: string): boolean {
  return ALL_OTEL_ENDPOINT_KEYS.includes(key);
}

// Whether `env[key]` (one file's `env` object) holds a value this installer wrote, judged per key
// and per file:
//  - an endpoint key is ours while it is a loopback endpoint whose port is in the allocation range
//    or is one of `ownedPorts` (the project's recorded ports and the per-user shared port, which
//    `--otel-port` may have pinned below the range);
//  - any other OTEL key is ours while it carries exactly the value the installer writes AND every
//    endpoint key present in the same `env` is ours — a file whose endpoint points at the user's
//    own collector keeps its exporter/protocol keys, because they are the user's too.
export function isArtisynOwnedOtelValue(key: string, env: Record<string, unknown>, ownedPorts: Set<number>): boolean {
  if (isOtelEndpointKey(key)) {
    const value = env[key];
    if (typeof value !== 'string') return false;
    const match = OTEL_LOOPBACK_ENDPOINT_RE.exec(value);
    if (!match) return false;
    const port = Number(match[1]);
    return (port >= OTEL_PORT_MIN && port <= OTEL_PORT_MAX) || ownedPorts.has(port);
  }

  const expected = ALL_OTEL_EXPECTED_VALUES[key];
  if (expected === undefined || env[key] !== expected) return false;
  return ALL_OTEL_ENDPOINT_KEYS.every(
    endpointKey => env[endpointKey] === undefined || isArtisynOwnedOtelValue(endpointKey, env, ownedPorts),
  );
}

// Port of a loopback OTEL endpoint value, for a rewrite Note; the raw value when it has none.
export function otelEndpointPortLabel(value: unknown): string {
  const match = typeof value === 'string' ? OTEL_LOOPBACK_ENDPOINT_RE.exec(value) : null;
  return match ? match[1] : String(value);
}

// The per-key decision of an owned-key merge into one `env` (ownership judged on `env` as read):
//  - an endpoint key is (re)written while it is absent or still ours — which is what repoints a
//    stale Artisyn port — and a user value is kept;
//  - any other key is filled only when absent; a different present value is the user's and kept.
// `set` means write `desired`; `rewrite` is set when an owned value with a different port is replaced.
export function mergeOwnedOtelKey(
  env: Record<string, unknown>,
  key: string,
  desired: string,
  ownedPorts: Set<number>,
): { action: 'set' | 'keep' | 'unchanged'; rewrite?: string } {
  const present = Object.prototype.hasOwnProperty.call(env, key);
  if (isOtelEndpointKey(key)) {
    if (!present) return { action: 'set' };
    if (!isArtisynOwnedOtelValue(key, env, ownedPorts)) return { action: 'keep' };
    if (env[key] === desired) return { action: 'unchanged' };
    return { action: 'set', rewrite: `${key}: ${otelEndpointPortLabel(env[key])} → ${otelEndpointPortLabel(desired)}` };
  }
  if (!present) return { action: 'set' };
  return env[key] === desired ? { action: 'unchanged' } : { action: 'keep' };
}

// The owned-key merge of the user-scope `env` (DD-23): `desired` keys are merged per
// `mergeOwnedOtelKey`; `stripKeys` (the trace keys when no installed repo wants traces) are removed
// while still Artisyn-owned. Pure; the caller writes the file and prints the Notes.
export function mergeUserOtelEnv(
  env: Record<string, unknown>,
  desired: Record<string, string>,
  ownedPorts: Set<number>,
  stripKeys: readonly string[] = [],
): { env: Record<string, unknown>; rewritten: string[]; kept: string[]; stripped: string[] } {
  const next: Record<string, unknown> = { ...env };
  const rewritten: string[] = [];
  const kept: string[] = [];
  const stripped: string[] = [];
  for (const key of stripKeys) {
    if (Object.prototype.hasOwnProperty.call(env, key) && isArtisynOwnedOtelValue(key, env, ownedPorts)) {
      delete next[key];
      stripped.push(key);
    }
  }
  for (const [key, value] of Object.entries(desired)) {
    const decision = mergeOwnedOtelKey(env, key, value, ownedPorts);
    if (decision.action === 'set') {
      next[key] = value;
      if (decision.rewrite) rewritten.push(decision.rewrite);
    } else if (decision.action === 'keep') {
      kept.push(key);
    }
  }
  return { env: next, rewritten, kept, stripped };
}

// ---------------------------------------------------------------------------
// The file itself
// ---------------------------------------------------------------------------

// Claude Code's user-level config dir: `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`.
export function getCustomClaudeConfigDir(): string | null {
  const custom = (process.env['CLAUDE_CONFIG_DIR'] ?? '').trim();
  return custom ? path.resolve(custom) : null;
}

export function getUserSettingsPath(): string {
  return path.join(getCustomClaudeConfigDir() ?? path.join(os.homedir(), '.claude'), 'settings.json');
}

export function getUserSettingsLabel(): string {
  return getCustomClaudeConfigDir() ? '$CLAUDE_CONFIG_DIR/settings.json' : '~/.claude/settings.json';
}

export type UserSettingsRead = { settingsPath: string; existing: Record<string, unknown>; raw: string | null };

// Reads the user file for a mutation. A missing file reads as `{}` (raw `null`). Malformed JSON or a
// non-object root aborts the installer (exit 1) with no write — there is no safe way to merge into
// a file we cannot parse, and Claude Code itself would be ignoring it.
export function readUserSettingsForMutation(settingsPath: string = getUserSettingsPath()): UserSettingsRead {
  if (!fs.existsSync(settingsPath)) return { settingsPath, existing: {}, raw: null };
  const raw = fs.readFileSync(settingsPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isPlainObject(parsed)) {
    console.error(`Error: ${getUserSettingsLabel()} is not valid JSON - fix it and re-run. Nothing was written.`);
    process.exit(1);
  }
  return { settingsPath, existing: parsed, raw };
}

// The known keys whose wrong type would make Claude Code skip the whole file (DD-23). Returns one
// human-readable line per violation; empty when the shape is fine.
export function validateUserSettingsShape(settings: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const env = settings['env'];
  if (env !== undefined) {
    if (!isPlainObject(env)) {
      problems.push('"env" must be an object');
    } else {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== 'string') problems.push(`"env.${key}" must be a string (got ${Array.isArray(value) ? 'array' : typeof value})`);
      }
    }
  }
  const hooks = settings['hooks'];
  if (hooks !== undefined) {
    if (!isPlainObject(hooks)) {
      problems.push('"hooks" must be an object');
    } else {
      for (const [event, entries] of Object.entries(hooks)) {
        if (!Array.isArray(entries)) problems.push(`"hooks.${event}" must be an array`);
      }
    }
  }
  if (settings['otelHeadersHelper'] !== undefined && typeof settings['otelHeadersHelper'] !== 'string') {
    problems.push('"otelHeadersHelper" must be a string');
  }
  if (settings['_artisynOtel'] !== undefined && !isPlainObject(settings['_artisynOtel'])) {
    problems.push('"_artisynOtel" must be an object');
  }
  return problems;
}

// Aborts (exit 1, file untouched) when the shape is invalid. Used both as a pre-flight before the
// installer touches anything and again on the merged result right before the write.
export function assertUserSettingsShape(settings: Record<string, unknown>, when: 'existing' | 'merged'): void {
  const problems = validateUserSettingsShape(settings);
  if (problems.length === 0) return;
  const label = getUserSettingsLabel();
  console.error(
    when === 'existing'
      ? `Error: ${label} has values of the wrong type, so Claude Code skips the whole file:`
      : `Error: refusing to write ${label} — the merged result would have values of the wrong type:`,
  );
  for (const p of problems) console.error(`  - ${p}`);
  console.error('Fix the file and re-run the installer. Nothing was written to it.');
  process.exit(1);
}

export function userSettingsBackupPath(settingsPath: string): string {
  return `${settingsPath}.artisyn-bak`;
}

// The pre-write safety copy `<settings>.artisyn-bak` of the content about to be replaced.
export function backupUserSettings(settingsPath: string, raw: string): void {
  atomicWriteFile(userSettingsBackupPath(settingsPath), raw);
}

// Validates, backs up (when the file existed) and atomically writes the user file. Returns false
// (and writes nothing) when the serialized result equals what is on disk.
export function writeUserSettings(read: UserSettingsRead, next: Record<string, unknown>): boolean {
  assertUserSettingsShape(next, 'merged');
  const serialized = JSON.stringify(next, null, 2) + '\n';
  if (read.raw !== null && serialized === read.raw) return false;
  if (read.raw === null && Object.keys(next).length === 0) return false;
  if (read.raw !== null) backupUserSettings(read.settingsPath, read.raw);
  atomicWriteFile(read.settingsPath, serialized);
  return true;
}

// ---------------------------------------------------------------------------
// The user-level SessionStart hook (DD-21)
// ---------------------------------------------------------------------------

// Recognises the DD-21 entry, whatever the home path and slash style it was written with.
export const USER_ENSURE_HOOK_MARKER = '.artisyn/otel/bin/otel-ensure-receiver.js';

// Timeout (seconds) of the user-level hook entry — the script itself gives up after 500 ms.
export const USER_ENSURE_HOOK_TIMEOUT_S = 5;

export function isUserEnsureHookCommand(command: unknown): boolean {
  return typeof command === 'string' && command.replace(/\\/g, '/').includes(USER_ENSURE_HOOK_MARKER);
}

// `node "<home>/.artisyn/otel/bin/otel-ensure-receiver.js"` — forward slashes, so the command reads
// the same in the POSIX shell Claude Code runs hooks in on every OS.
export function userEnsureHookCommand(scriptPath: string): string {
  return `node "${scriptPath.replace(/\\/g, '/')}"`;
}

// Whether a parsed `hooks` block already holds the DD-21 entry (the `settingsHasInstallerHooks`
// recognition pattern of install.ts, keyed on `USER_ENSURE_HOOK_MARKER`).
export function hooksHaveUserEnsureHook(hooks: unknown): boolean {
  if (!isPlainObject(hooks)) return false;
  for (const matcherEntries of Object.values(hooks)) {
    if (!Array.isArray(matcherEntries)) continue;
    for (const matcherEntry of matcherEntries) {
      const hooksArr = isPlainObject(matcherEntry) ? matcherEntry['hooks'] : undefined;
      if (!Array.isArray(hooksArr)) continue;
      if (hooksArr.some(hook => isPlainObject(hook) && isUserEnsureHookCommand(hook['command']))) return true;
    }
  }
  return false;
}

function hooksHaveExactCommand(hooks: Record<string, unknown>, command: string): boolean {
  const entries = hooks['SessionStart'];
  if (!Array.isArray(entries)) return false;
  let found = 0;
  for (const entry of entries) {
    const hooksArr = isPlainObject(entry) ? entry['hooks'] : undefined;
    if (!Array.isArray(hooksArr)) continue;
    for (const hook of hooksArr) {
      if (isPlainObject(hook) && isUserEnsureHookCommand(hook['command'])) {
        if (hook['command'] !== command) return false;
        found++;
      }
    }
  }
  // Exactly one entry, and none under another event.
  return found === 1 && Object.entries(hooks).every(([event, list]) =>
    event === 'SessionStart' || !hooksHaveUserEnsureHook({ [event]: list }));
}

// Removes only the DD-21 entries from a parsed `hooks` block, pruning matcher/event entries left
// empty (the `removeInstallerHookEntries` pattern of install.ts). Every other hook survives as is.
// Returns `undefined` when nothing is left in the block.
export function removeUserEnsureHook(hooks: Record<string, unknown>): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  for (const [eventName, matcherEntries] of Object.entries(hooks)) {
    if (!Array.isArray(matcherEntries)) {
      result[eventName] = matcherEntries;
      continue;
    }
    const pruned = matcherEntries
      .map((matcherEntry: unknown) => {
        if (!isPlainObject(matcherEntry) || !Array.isArray(matcherEntry['hooks'])) return matcherEntry;
        const kept = (matcherEntry['hooks'] as unknown[]).filter(
          hook => !(isPlainObject(hook) && isUserEnsureHookCommand(hook['command'])),
        );
        return { ...matcherEntry, hooks: kept };
      })
      .filter((matcherEntry: unknown) =>
        !isPlainObject(matcherEntry) || !Array.isArray(matcherEntry['hooks']) || (matcherEntry['hooks'] as unknown[]).length > 0);
    if (pruned.length > 0) result[eventName] = pruned;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// The settings object with the DD-21 entry present (`want`) or absent. Pure; an existing entry is
// replaced, so a moved home dir gets the current path. A non-object `hooks` is left untouched.
export function withUserEnsureHook(settings: Record<string, unknown>, want: boolean, scriptPath: string): Record<string, unknown> {
  const hooks = settings['hooks'];
  if (hooks !== undefined && !isPlainObject(hooks)) return settings;
  if (want && isPlainObject(hooks) && hooksHaveExactCommand(hooks, userEnsureHookCommand(scriptPath))) return settings;
  const next: Record<string, unknown> = { ...settings };
  const cleaned = isPlainObject(hooks) ? removeUserEnsureHook(hooks) : undefined;
  if (!want) {
    if (cleaned) next['hooks'] = cleaned;
    else delete next['hooks'];
    return next;
  }
  const base: Record<string, unknown> = cleaned ?? {};
  const sessionStart = Array.isArray(base['SessionStart']) ? (base['SessionStart'] as unknown[]) : [];
  next['hooks'] = {
    ...base,
    SessionStart: [
      ...sessionStart,
      { hooks: [{ type: 'command', command: userEnsureHookCommand(scriptPath), timeout: USER_ENSURE_HOOK_TIMEOUT_S }] },
    ],
  };
  return next;
}
