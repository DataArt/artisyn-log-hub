/**
 * installer.ts — running the hooks installer CLI the way a user does, for the S-INST scenarios
 * (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §5).
 *
 * The CLI is the stand's own `GET /static/artisyn-hooks-installer.tgz` — the npm tarball
 * `npx <server>/static/artisyn-hooks-installer.tgz install` runs — unpacked into a throwaway dir
 * and started with `node package/dist/index.js`. Every run gets:
 *  - a fake HOME (the installer reads `~/.claude/settings.json` for collision/duplicate warnings);
 *  - a PATH with every directory holding a real `claude` removed and, optionally, a fake `claude`
 *    in front (`writeFakeClaude` of hook-process.ts records its argv in `calls.log`);
 *  - `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` blanked, so the «running inside Claude Code» notice
 *    does not depend on who launched the suite;
 *  - stdin as a pipe (never a TTY): the installer's TTY-only connection check, confirmation
 *    prompt and `claude -p` smoke test never run; a `.claude/` prompt reads the given `stdin`.
 */
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { fakeHomeEnv, untar, type TempDirs } from './hook-process';

export interface InstallerCli {
  /** `<dir>/package/dist/index.js`. */
  entry: string;
  /** `package/package.json` of the tarball. */
  version: string;
}

/** Downloads the installer tarball from the stand and unpacks it into a fresh temp dir. */
export async function unpackInstaller(standUrl: string, dirs: TempDirs): Promise<InstallerCli> {
  const res = await fetch(`${standUrl}/static/artisyn-hooks-installer.tgz`);
  if (res.status !== 200) throw new Error(`GET /static/artisyn-hooks-installer.tgz → ${res.status}`);
  const dir = dirs.make('installer');
  const root = path.resolve(dir);
  for (const [name, data] of untar(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())))) {
    const dest = path.resolve(root, name);
    if (!dest.startsWith(root + path.sep)) throw new Error(`installer tarball entry escapes: ${name}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package', 'package.json'), 'utf8')) as { version: string };
  return { entry: path.join(dir, 'package', 'dist', 'index.js'), version: pkg.version };
}

function pathKey(): string {
  return Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
}

/** PATH without any directory that holds a `claude` / `claude.<ext>`, optionally with `front` first. */
export function pathWithoutClaude(front?: string): Record<string, string> {
  const dirs = (process.env[pathKey()] ?? '').split(path.delimiter).filter((dir) => {
    if (!dir) return false;
    try {
      return !fs.readdirSync(dir).some((e) => /^claude(\.\w+)?$/i.test(e));
    } catch {
      return true;
    }
  });
  return { [pathKey()]: [...(front ? [front] : []), ...dirs].join(path.delimiter) };
}

export interface InstallerRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr, for «the output contains». */
  output: string;
}

export interface InstallerRunOptions {
  home: string;
  /** Directory of a fake `claude` to put first on PATH; none → no `claude` on PATH at all. */
  fakeClaudeDir?: string;
  /** Written to stdin, which is then closed. */
  stdin?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** `node <entry> ...args` in `cwd`. */
export function runInstaller(cli: InstallerCli, cwd: string, args: string[], opts: InstallerRunOptions): Promise<InstallerRun> {
  const { home, fakeClaudeDir, stdin = '', env = {}, timeoutMs = 90_000 } = opts;
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...fakeHomeEnv(home),
    ...pathWithoutClaude(fakeClaudeDir),
    CLAUDECODE: '',
    CLAUDE_CODE_ENTRYPOINT: '',
  };
  // The installer reads the archive from ARTISYN_HOOKS_ARCHIVE_PATH when it is set at all (even
  // empty), so one inherited from the launching shell is removed rather than blanked.
  delete childEnv.ARTISYN_HOOKS_ARCHIVE_PATH;
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli.entry, ...args], {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`installer ${args.join(' ')} did not exit within ${timeoutMs} ms\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
    child.stdin.end(stdin);
  });
}

function tarHeader(name: string, size: number): Buffer {
  const buf = Buffer.alloc(512, 0);
  const octal = (n: number, width: number) => `${n.toString(8).padStart(width - 1, '0')}\0`;
  Buffer.from(name, 'utf8').copy(buf, 0, 0, 100);
  Buffer.from(octal(0o644, 8)).copy(buf, 100);
  Buffer.from(octal(0, 8)).copy(buf, 108);
  Buffer.from(octal(0, 8)).copy(buf, 116);
  Buffer.from(octal(size, 12)).copy(buf, 124);
  Buffer.from(octal(0, 12)).copy(buf, 136);
  buf[156] = 0x30;
  Buffer.from('ustar\0').copy(buf, 257);
  Buffer.from('00').copy(buf, 263);
  buf.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of buf) sum += b;
  Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `).copy(buf, 148);
  return buf;
}

/**
 * The plugin archive (`hooks.tar.gz`) bundled in the unpacked installer, with the entries of
 * `replace` overwritten, written to a new file — for ARTISYN_HOOKS_ARCHIVE_PATH.
 */
export function patchedPluginArchive(cli: InstallerCli, dirs: TempDirs, replace: Record<string, string>): string {
  const entries = untar(zlib.gunzipSync(fs.readFileSync(path.join(path.dirname(cli.entry), 'hooks.tar.gz'))));
  for (const [name, content] of Object.entries(replace)) {
    if (!entries.has(name)) throw new Error(`the plugin archive has no ${name}`);
    entries.set(name, Buffer.from(content, 'utf8'));
  }
  const parts: Buffer[] = [];
  for (const [name, data] of entries) {
    parts.push(tarHeader(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  const file = path.join(dirs.make('archive'), 'hooks.tar.gz');
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(parts)));
  return file;
}

/** Parsed JSON file. */
export function readJson<T = Record<string, unknown>>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** Every regular file under `root` except `.git/`, as `relative/posix/path → sha256`. */
export function treeHashes(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        out.set(path.relative(root, full).split(path.sep).join('/'), createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
      }
    }
  };
  walk(root);
  return out;
}

/** Every regular file under `root` (except `.git/`) whose content contains `needle`. */
export function filesContaining(root: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && fs.readFileSync(full).includes(needle)) {
        hits.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return hits;
}

/** argv lists the fake `claude` recorded, in call order. */
export function fakeClaudeCalls(callsLog: string): string[][] {
  try {
    return fs
      .readFileSync(callsLog, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  } catch {
    return [];
  }
}

/** The settings the S-INST scenarios start from (design §S-INST-01, «Данные/окружение»). */
export const USER_SETTINGS = {
  permissions: { allow: ['Bash(git status)'] },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-guard.sh' }] }] },
  customKey: { a: [1, 2] },
};

/** Writes `<repo>/.claude/settings.json`. */
export function writeClaudeSettings(repo: string, settings: object): string {
  const file = path.join(repo, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return file;
}
