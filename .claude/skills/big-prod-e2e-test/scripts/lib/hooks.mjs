// Hook install per test repo: run the UI's one-liner with the isolated
// CLAUDE_CONFIG_DIR env and stdin closed, then verify the installer's output and config file.
import fs from 'node:fs';
import path from 'node:path';
import { STAND_URL, TIMEOUTS } from './config.mjs';
import { runAsync } from './proc.mjs';
import { redactOneLiner } from './browser.mjs';

export const HOOKS_INSTALLED_MARKER = 'Hooks installed';
export const LOG_HUB_CONFIG_REL = path.join('.artisyn', 'config', 'log-hub.json');
// Per-machine overrides (serverUrl, otelReceiverPort, apiKey) written by the current installer.
export const LOG_HUB_LOCAL_CONFIG_REL = path.join('.artisyn', 'config', 'log-hub.local.json');

/** Adds `--yes` after a leading `npx` so npx never waits for an install confirmation. */
export function withNpxYes(command) {
  const trimmed = String(command).trim();
  if (!/^npx\s/.test(trimmed)) throw new Error(`hook install command must start with npx: ${redactOneLiner(trimmed)}`);
  return /^npx\s+(--yes|-y)\b/.test(trimmed) ? trimmed : trimmed.replace(/^npx\s+/, 'npx --yes ');
}

/** Installer output lines that look like warnings (e.g. the marketplace-collision note). */
export function installerWarnings(output) {
  return String(output)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /\bwarn(ing)?\b/i.test(l) || /marketplace.*(collision|already|conflict)/i.test(l));
}

function readJsonObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Both hook config files of a repo: `base` = `log-hub.json` (tracked), `local` =
 * `log-hub.local.json` (per machine), each null when missing or unreadable, and
 * `merged = {...base, ...local}` — the value the hook itself uses.
 */
export function readLogHubConfig(repoDir) {
  const base = readJsonObject(path.join(repoDir, LOG_HUB_CONFIG_REL));
  const local = readJsonObject(path.join(repoDir, LOG_HUB_LOCAL_CONFIG_REL));
  return { base, local, merged: { ...(base || {}), ...(local || {}) } };
}

/** The merged `serverUrl` of the repo's hook config (local overrides base), or null. */
export function readServerUrl(repoDir) {
  const { merged } = readLogHubConfig(repoDir);
  return typeof merged.serverUrl === 'string' ? merged.serverUrl : null;
}

/**
 * FR-11 / FR-12: the per-machine values must live in `log-hub.local.json` only.
 * Pass iff local.serverUrl === serverUrl, local.otelReceiverPort is an integer, base has no
 * otelReceiverPort and — unless `legacy` (FR-12: the committed pre-split file keeps its
 * serverUrl) — base.serverUrl is absent or empty (the tracked template keeps `"serverUrl": ""`).
 * Returns { ok, problems: string[], base, local }.
 */
export function checkLocalConfig(repoDir, { legacy = false, serverUrl = STAND_URL } = {}) {
  const { base, local } = readLogHubConfig(repoDir);
  const problems = [];
  if (!local) {
    problems.push(`${LOG_HUB_LOCAL_CONFIG_REL} is missing or unreadable`);
  } else {
    if (local.serverUrl !== serverUrl) {
      problems.push(`${LOG_HUB_LOCAL_CONFIG_REL} serverUrl is ${JSON.stringify(local.serverUrl)}, expected "${serverUrl}"`);
    }
    if (!Number.isInteger(local.otelReceiverPort)) {
      problems.push(`${LOG_HUB_LOCAL_CONFIG_REL} otelReceiverPort is ${JSON.stringify(local.otelReceiverPort)}, expected an integer`);
    }
  }
  const b = base || {};
  if (b.otelReceiverPort !== undefined) {
    problems.push(`${LOG_HUB_CONFIG_REL} has otelReceiverPort ${JSON.stringify(b.otelReceiverPort)}, expected none`);
  }
  if (!legacy && b.serverUrl) {
    problems.push(`${LOG_HUB_CONFIG_REL} has serverUrl ${JSON.stringify(b.serverUrl)}, expected none or empty`);
  }
  return { ok: problems.length === 0, problems, base, local };
}

/**
 * Runs the installer one-liner in `repoDir` (`shell: true`, stdin closed, `env` = childEnv()).
 * Success needs exit 0, "Hooks installed" in the output and the merged serverUrl of
 * `log-hub.json` + `log-hub.local.json` === STAND_URL;
 * anything else throws (infra step `hooks`). Warnings are logged and returned, never fatal.
 * opts: { logFile, timeoutMs, expectedServerUrl }
 * Returns { exitCode, serverUrl, warnings }.
 */
export async function installHook(repoDir, command, env, opts = {}) {
  const { logFile = null, timeoutMs = TIMEOUTS.installerMs, expectedServerUrl = STAND_URL } = opts;
  const cmd = withNpxYes(command);
  const started = Date.now();
  const res = await runAsync(cmd, [], { cwd: repoDir, env, shell: true, timeoutMs });
  const output = `${res.stdout || ''}\n${res.stderr || ''}`;
  const warnings = installerWarnings(output);

  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(
      logFile,
      [
        `command: ${redactOneLiner(cmd)}`,
        `cwd: ${repoDir}`,
        `exit: ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}`,
        `duration: ${Math.round((Date.now() - started) / 1000)}s`,
        '===== stdout =====',
        res.stdout || '',
        '===== stderr =====',
        res.stderr || '',
      ].join('\n'),
    );
  }

  const repo = path.basename(repoDir);
  const where = logFile ? ` (see ${logFile})` : '';
  if (res.timedOut) {
    throw new Error(`hook install in ${repo} timed out after ${Math.round(timeoutMs / 1000)}s${where}`);
  }
  if (res.exitCode !== 0) {
    throw new Error(`hook install in ${repo} exited with ${res.exitCode}${where}`);
  }
  if (!output.includes(HOOKS_INSTALLED_MARKER)) {
    throw new Error(`hook install in ${repo}: output has no "${HOOKS_INSTALLED_MARKER}"${where}`);
  }
  const serverUrl = readServerUrl(repoDir);
  if (serverUrl !== expectedServerUrl) {
    throw new Error(
      `hook install in ${repo}: serverUrl merged from ${LOG_HUB_CONFIG_REL} and ${LOG_HUB_LOCAL_CONFIG_REL} is ${JSON.stringify(serverUrl)}, expected "${expectedServerUrl}"${where}`,
    );
  }
  return { exitCode: res.exitCode, serverUrl, warnings };
}
