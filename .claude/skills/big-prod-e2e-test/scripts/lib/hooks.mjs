// Hook install per test repo: run the UI's one-liner with the isolated
// CLAUDE_CONFIG_DIR env and stdin closed, then verify the installer's output and config file.
import fs from 'node:fs';
import path from 'node:path';
import { STAND_URL, TIMEOUTS } from './config.mjs';
import { runAsync } from './proc.mjs';
import { redactOneLiner } from './browser.mjs';

export const HOOKS_INSTALLED_MARKER = 'Hooks installed';
export const LOG_HUB_CONFIG_REL = path.join('.artisyn', 'config', 'log-hub.json');

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

/** `serverUrl` from the repo's `.artisyn/config/log-hub.json`, or null when unreadable. */
export function readServerUrl(repoDir) {
  const file = path.join(repoDir, LOG_HUB_CONFIG_REL);
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof cfg.serverUrl === 'string' ? cfg.serverUrl : null;
  } catch {
    return null;
  }
}

/**
 * Runs the installer one-liner in `repoDir` (`shell: true`, stdin closed, `env` = childEnv()).
 * Success needs exit 0, "Hooks installed" in the output and `log-hub.json` serverUrl === STAND_URL;
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
      `hook install in ${repo}: ${LOG_HUB_CONFIG_REL} serverUrl is ${JSON.stringify(serverUrl)}, expected "${expectedServerUrl}"${where}`,
    );
  }
  return { exitCode: res.exitCode, serverUrl, warnings };
}
