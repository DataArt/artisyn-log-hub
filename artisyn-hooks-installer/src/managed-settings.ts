// Reader of the admin-managed Claude Code settings that touch OTEL (DD-12) — installer side.
//
// TS twin of `hook/.claude/telemetry_tool/managed-settings.js`; keep both identical. Erasable
// TypeScript syntax only.
//
// Sources, highest precedence first:
//   remote   `<claudeConfigDir>/remote-settings.json` — the server-managed settings cache
//   policy   win32: `reg query HKLM\SOFTWARE\Policies\ClaudeCode /v Settings` (a JSON string)
//            darwin: `/Library/Managed Preferences/com.anthropic.claudecode.plist` via `plutil`
//   file     win32: `%ProgramFiles%\ClaudeCode\managed-settings.json`
//            darwin: `/Library/Application Support/ClaudeCode/managed-settings.json`
//            linux: `/etc/claude-code/managed-settings.json`
//   policy   win32 only: `HKCU\SOFTWARE\Policies\ClaudeCode` value `Settings` (lowest)
//
// `ARTISYN_MANAGED_SETTINGS_DIR` (test-only) replaces the file location with
// `<dir>/managed-settings.json` and disables both OS-policy reads.
//
// Per-signal rules (PoC items 7–8): pinned = the managed scope sets the signal's endpoint or the
// generic `OTEL_EXPORTER_OTLP_ENDPOINT`; disabled = managed `CLAUDE_CODE_ENABLE_TELEMETRY` is
// `0`/`false` (every signal) or the signal's managed exporter is `none`. A disabled signal is never
// also pinned. Fail-silent per source; never throws.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Each OS-policy probe is bounded so a slow `reg`/`plutil` can never stall the installer. Twin:
// `managed-settings.js`.
export const OS_POLICY_TIMEOUT_MS = 1500;

const MANAGED_FILE_NAME = 'managed-settings.json';
const REMOTE_SETTINGS_FILE_NAME = 'remote-settings.json';
const WIN_POLICY_KEY_SUFFIX = 'SOFTWARE\\Policies\\ClaudeCode';
const DARWIN_POLICY_PLIST = '/Library/Managed Preferences/com.anthropic.claudecode.plist';

export const SIGNALS = ['logs', 'metrics', 'spans'] as const;
export type OtelSignal = typeof SIGNALS[number];

export const SIGNAL_ENDPOINT_KEYS: Record<OtelSignal, string> = {
  logs: 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  metrics: 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  spans: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
};
export const SIGNAL_EXPORTER_KEYS: Record<OtelSignal, string> = {
  logs: 'OTEL_LOGS_EXPORTER',
  metrics: 'OTEL_METRICS_EXPORTER',
  spans: 'OTEL_TRACES_EXPORTER',
};
export const GENERIC_ENDPOINT_KEY = 'OTEL_EXPORTER_OTLP_ENDPOINT';
export const ENABLE_TELEMETRY_KEY = 'CLAUDE_CODE_ENABLE_TELEMETRY';

export type ManagedSource = { kind: 'remote' | 'policy' | 'file'; label: string; env: Record<string, string> };

export type ManagedOtel = {
  sources: ManagedSource[];
  env: Record<string, string>;
  pinnedSignals: OtelSignal[];
  disabledSignals: OtelSignal[];
};

type EnvLike = Record<string, string | undefined>;

/** Whether an env key is one this reader reports: every `OTEL_*` key plus the telemetry switch. */
export function isOtelKey(key: string): boolean {
  return key === ENABLE_TELEMETRY_KEY || key.startsWith('OTEL_');
}

/** The OTEL subset of a settings object's `env`, string values only (numbers/booleans stringified). */
export function otelEnvOf(settings: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const env = settings && typeof settings === 'object' ? (settings as Record<string, unknown>)['env'] : null;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return out;
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (!isOtelKey(key)) continue;
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readSettingsFile(file: string): Record<string, unknown> | null {
  try {
    return parseObject(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The `Settings` value out of `reg query … /v Settings` output, parsed as JSON. */
export function parseRegQueryOutput(output: string): Record<string, unknown> | null {
  const match = /^\s*Settings\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/m.exec(String(output || ''));
  return match ? parseObject(match[1].trim()) : null;
}

function readWindowsPolicy(hive: 'HKLM' | 'HKCU'): Record<string, unknown> | null {
  try {
    const output = execFileSync('reg', ['query', `${hive}\\${WIN_POLICY_KEY_SUFFIX}`, '/v', 'Settings'], {
      encoding: 'utf8',
      timeout: OS_POLICY_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseRegQueryOutput(output);
  } catch {
    return null;
  }
}

function readDarwinPolicy(): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(DARWIN_POLICY_PLIST)) return null;
    const output = execFileSync('plutil', ['-convert', 'json', '-o', '-', DARWIN_POLICY_PLIST], {
      encoding: 'utf8',
      timeout: OS_POLICY_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseObject(output);
  } catch {
    return null;
  }
}

/** The managed-settings.json location for this platform. */
export function managedFilePath(platform: string, env: EnvLike): string | null {
  const override = typeof env['ARTISYN_MANAGED_SETTINGS_DIR'] === 'string' ? env['ARTISYN_MANAGED_SETTINGS_DIR'].trim() : '';
  if (override) return path.join(path.resolve(override), MANAGED_FILE_NAME);
  if (platform === 'win32') {
    const programFiles = (env['ProgramFiles'] || env['PROGRAMFILES'] || 'C:\\Program Files').trim();
    return path.win32.join(programFiles, 'ClaudeCode', MANAGED_FILE_NAME);
  }
  if (platform === 'darwin') return path.posix.join('/Library/Application Support/ClaudeCode', MANAGED_FILE_NAME);
  if (platform === 'linux') return path.posix.join('/etc/claude-code', MANAGED_FILE_NAME);
  return null;
}

function claudeDirFor(homeDir: string | undefined, env: EnvLike): string {
  const custom = typeof env['CLAUDE_CONFIG_DIR'] === 'string' ? env['CLAUDE_CONFIG_DIR'].trim() : '';
  return custom ? path.resolve(custom) : path.join(homeDir || os.homedir(), '.claude');
}

function isFalsy(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === '0' || v === 'false';
}

/** Pinned and disabled signals of a merged managed OTEL env (pure). */
export function classifyManagedEnv(managedEnv: Record<string, string>): { pinnedSignals: OtelSignal[]; disabledSignals: OtelSignal[] } {
  const env = managedEnv || {};
  const allOff = isFalsy(env[ENABLE_TELEMETRY_KEY]);
  const disabledSignals = SIGNALS.filter((signal) => {
    if (allOff) return true;
    const exporter = env[SIGNAL_EXPORTER_KEYS[signal]];
    return typeof exporter === 'string' && exporter.trim().toLowerCase() === 'none';
  });
  const hasValue = (key: string): boolean => typeof env[key] === 'string' && env[key].trim() !== '';
  const pinnedSignals = SIGNALS.filter(signal => !disabledSignals.includes(signal)
    && (hasValue(SIGNAL_ENDPOINT_KEYS[signal]) || hasValue(GENERIC_ENDPOINT_KEY)));
  return { pinnedSignals, disabledSignals };
}

/** Read every managed source and merge their OTEL keys (higher source wins per key). */
export function readManagedOtel(opts: { homeDir?: string; env?: EnvLike; platform?: string } = {}): ManagedOtel {
  const env: EnvLike = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const overrideValue = env['ARTISYN_MANAGED_SETTINGS_DIR'];
  const override = typeof overrideValue === 'string' && overrideValue.trim() !== '';
  const sources: ManagedSource[] = [];
  const add = (kind: ManagedSource['kind'], label: string, settings: Record<string, unknown> | null): void => {
    try {
      if (!settings) return;
      const otel = otelEnvOf(settings);
      if (Object.keys(otel).length > 0) sources.push({ kind, label, env: otel });
    } catch {
      // fail-silent per source
    }
  };

  add('remote', `${REMOTE_SETTINGS_FILE_NAME} (server-managed)`,
    readSettingsFile(path.join(claudeDirFor(opts.homeDir, env), REMOTE_SETTINGS_FILE_NAME)));
  if (!override && platform === 'win32') add('policy', 'HKLM policy', readWindowsPolicy('HKLM'));
  if (!override && platform === 'darwin') add('policy', 'macOS managed preferences', readDarwinPolicy());
  const file = managedFilePath(platform, env);
  if (file) add('file', MANAGED_FILE_NAME, readSettingsFile(file));
  if (!override && platform === 'win32') add('policy', 'HKCU policy', readWindowsPolicy('HKCU'));

  const merged: Record<string, string> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source.env)) {
      if (!(key in merged)) merged[key] = value;
    }
  }
  return { sources, env: merged, ...classifyManagedEnv(merged) };
}
