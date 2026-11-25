import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { extractTarGz } from './tar';

/**
 * Downgrade guard of `install` / `upgrade` (installer 1.1.6+).
 *
 * `npx <server>/static/artisyn-hooks-installer.tgz upgrade` keeps one exec-cache entry per command
 * spec: once a bare URL (no `?v=` suffix) was run, npx re-runs that first downloaded installer
 * forever, and an upgrade silently installs its old bundled hook over a newer one. So when the
 * bundled hook is older than the installed one, the installer asks the server which hook it
 * currently serves (`/static/installer-version.json`):
 *   - the server serves a newer hook than this installer bundles → this copy is stale: download the
 *     server's current installer and re-run the same command with it (once — `REFRESHED_ENV`);
 *   - otherwise it is a real downgrade → a terminal asks "are you sure"; a non-interactive run
 *     needs `--allow-downgrade`.
 */

/** Set on the re-run of a freshly downloaded installer, so a still-stale server never loops. */
export const REFRESHED_ENV = 'ARTISYN_INSTALLER_REFRESHED';

/**
 * Compares two dotted numeric versions: < 0 when `a` is older, 0 equal, > 0 newer; `null` when
 * either side is not a plain dotted version (e.g. `unknown`).
 */
export function compareHookVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => (/^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** What to do about the bundled hook version vs the installed one. */
export type DowngradeDecision = 'none' | 'refresh' | 'confirm';

/**
 * - `none`: nothing installed, an unknown version on either side, or the bundled hook is not older;
 * - `refresh`: a downgrade, and the server serves a newer hook than this installer bundles (a stale
 *   cached installer) — unless this run already is the refreshed one;
 * - `confirm`: any other downgrade (the user must confirm).
 */
export function decideDowngrade(input: {
  installed: string | null;
  bundled: string;
  server: string | null;
  refreshed: boolean;
}): DowngradeDecision {
  if (!input.installed) return 'none';
  const cmp = compareHookVersions(input.bundled, input.installed);
  if (cmp === null || cmp >= 0) return 'none';
  if (!input.refreshed && input.server && (compareHookVersions(input.server, input.bundled) ?? 0) > 0) {
    return 'refresh';
  }
  return 'confirm';
}

function httpGet(url: URL, timeoutMs: number): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Connection timed out')); });
  });
}

/**
 * The hook version the server currently serves (`/static/installer-version.json`), or `null` when
 * it cannot be read (an older server, a network error, a malformed answer).
 */
export async function fetchServerHookVersion(serverUrl: string): Promise<string | null> {
  try {
    const res = await httpGet(new URL('/static/installer-version.json', serverUrl), 10_000);
    if (res.status !== 200) return null;
    const parsed = JSON.parse(res.body.toString('utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim() !== '' ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Downloads the server's current installer (`?v=<version>`, so no cache in between serves an old
 * copy) and unpacks it into `~/.artisyn/installer/<version>/`. Returns its entry script.
 */
export async function fetchFreshInstaller(serverUrl: string, version: string): Promise<string> {
  const url = new URL('/static/artisyn-hooks-installer.tgz', serverUrl);
  url.searchParams.set('v', version);
  const res = await httpGet(url, 120_000);
  if (res.status !== 200) throw new Error(`GET ${url.pathname} answered ${res.status}`);
  const dir = path.join(os.homedir(), '.artisyn', 'installer', version.replace(/[^0-9A-Za-z.-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  extractTarGz(zlib.gunzipSync(res.body), dir);
  const entry = path.join(dir, 'package', 'dist', 'index.js');
  if (!fs.existsSync(entry)) throw new Error('the downloaded installer has no package/dist/index.js');
  return entry;
}

/** Re-runs the same command line with another installer entry script and exits with its code. */
export function rerunWithInstaller(entry: string): never {
  const res = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, [REFRESHED_ENV]: '1' },
  });
  if (res.error) {
    console.error(`Error: could not run the downloaded installer: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}
