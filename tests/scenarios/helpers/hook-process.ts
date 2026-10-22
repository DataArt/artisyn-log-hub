/**
 * hook-process.ts — running the real hook scripts as child processes, for the S-HOOK scenarios
 * (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §0 «Общие фикстуры»).
 *
 * Ported from hook/.claude/telemetry_tool/__tests__/test-helpers.js, typed and extended with what
 * the scenarios need on top of it:
 *
 *  - sandboxes: `tempDirs()` (every dir lives under os.tmpdir(), never inside this repository — a
 *    hook run from a non-git directory under the repo would resolve this repo's git root and write
 *    into its `.artisyn/`), `copyToolDir`, `makeFakeGitRepo`, `makeFakeHome`;
 *  - running: `runScript` / `runHook` (stdin JSON, exit code, stdout, elapsed time),
 *    `runPromptUpload` (argv, no stdin), `writeConfig` / `writeStandConfig` (the project's
 *    `.artisyn/config/log-hub{,.local}.json` pointed at a fake log hub or at the stand);
 *  - observing: `startFakeLogHub` (records every request: method, path, query, headers, raw body;
 *    answers 201 `{warnings: []}`, a scripted status, silence or a dropped connection),
 *    `readHookLog`, `readManifest`, `readRecommendations`;
 *  - the OTEL receiver: `freeLoopbackPort`, `waitForPort`, `spawnReceiver`, `startReceiver`,
 *    `stopReceiver`, `waitForExit`, `rawRequest`;
 *  - the built plugin: `installBuiltPlugin` unpacks the plugin tree from the stand's own installer
 *    tarball, `pluginHookCommands` reads its `hooks/hooks.json`;
 *  - `normalizePath` (impl-plan DD SC6): every path a hook or installer scenario compares goes
 *    through it — Windows hands out 8.3 short TEMP paths (`C:\Users\ABCDEF~1\…`) that the hook,
 *    which resolves its own git root, reports in long form.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

/** Repository root (this file is tests/scenarios/helpers/hook-process.ts). */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** The hook's source of truth (CLAUDE.md: hook/ is the source, never a copy of it). */
export const HOOK_SOURCE_DIR = path.join(REPO_ROOT, 'hook', '.claude', 'telemetry_tool');

/**
 * `public/static` of the stand bundle the runner builds (tmp/scenarios/stand, impl-plan DD C1).
 * The installer controller writes its `latest-hook-version.json` baseline here, not into the dev
 * server's server/src/public/static.
 */
export const STAND_STATIC_DIR = path.join(REPO_ROOT, 'tmp', 'scenarios', 'stand', 'public', 'static');

// ---------------------------------------------------------------------------
// paths and sandboxes
// ---------------------------------------------------------------------------

/**
 * DD SC6: `fs.realpathSync.native` (8.3 short names → long names, symlinks resolved) plus forward
 * slashes, so two spellings of one path compare equal. A path that does not exist is returned with
 * slashes normalised only.
 */
export function normalizePath(p: string): string {
  let resolved = p;
  try {
    resolved = fs.realpathSync.native(p);
  } catch {
    resolved = path.resolve(p);
  }
  return resolved.replace(/\\/g, '/');
}

/** `fs.rmSync` that never throws (a detached child may still hold a file on Windows). */
export function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best-effort cleanup
  }
}

export interface TempDirs {
  /** A fresh directory under os.tmpdir(), in its long (realpath) form. */
  make(prefix: string): string;
  /** Removes every directory `make` created. */
  cleanup(): void;
}

/** A per-scenario set of throwaway directories, removed together in the scenario's `finally`. */
export function tempDirs(): TempDirs {
  const made: string[] = [];
  return {
    make(prefix: string) {
      const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `scn-${prefix}-`)));
      made.push(dir);
      return dir;
    },
    cleanup() {
      for (const dir of made.splice(0)) rmrf(dir);
    },
  };
}

/** Recursive copy that skips the given entry names at every level. */
function copyDirExcluding(src: string, dest: string, exclude: ReadonlySet<string>): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (exclude.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirExcluding(s, d, exclude);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * Copies hook/.claude/telemetry_tool (without tests, env files and node_modules) into a fresh
 * sandbox dir, so a scenario runs the source hook without ever touching the source files.
 */
export function copyToolDir(dirs: TempDirs): string {
  const dest = dirs.make('hook-tool');
  copyDirExcluding(HOOK_SOURCE_DIR, dest, new Set(['__tests__', '.env', '.env.local', 'node_modules']));
  return dest;
}

/** Env that makes git work without the machine's global config. */
const GIT_IDENTITY_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'Scenario',
  GIT_AUTHOR_EMAIL: 'scenario@arrakis.test',
  GIT_COMMITTER_NAME: 'Scenario',
  GIT_COMMITTER_EMAIL: 'scenario@arrakis.test',
};

function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_IDENTITY_ENV } });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${res.stderr || res.error?.message || res.status}`);
  }
  return res.stdout.trim();
}

export interface FakeRepoOptions {
  /** `remote.origin.url`; no remote when absent. */
  remote?: string;
  /** Branch checked out after the first commit (default `main`). */
  branch?: string;
  /** `user.name` the hook reports as `git.user`. */
  userName?: string;
  /** Create one commit (default true): code-inventory and `git worktree` need a HEAD. */
  commit?: boolean;
}

/** A throwaway git repository used as the hook's `cwd` (the temp-project fixture). */
export function makeFakeGitRepo(dirs: TempDirs, opts: FakeRepoOptions = {}): string {
  const dir = dirs.make('hook-repo');
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', opts.userName ?? 'Scenario Dev']);
  git(dir, ['config', 'user.email', 'scenario-dev@arrakis.test']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  if (opts.commit !== false) {
    fs.writeFileSync(path.join(dir, 'README.md'), '# scenario project\n', 'utf8');
    git(dir, ['add', 'README.md']);
    git(dir, ['commit', '-q', '-m', 'seed']);
    git(dir, ['checkout', '-q', '-B', opts.branch ?? 'main']);
  }
  if (opts.remote) git(dir, ['remote', 'add', 'origin', opts.remote]);
  return dir;
}

/** A throwaway HOME, so the hook never reads or writes the developer's real ~/.claude. */
export function makeFakeHome(dirs: TempDirs): string {
  return dirs.make('hook-home');
}

/**
 * Env that points a child hook at `<fakeHome>/.claude`: `os.homedir()` reads HOME / USERPROFILE,
 * and a blank CLAUDE_CONFIG_DIR neutralises one the developer's shell may export. The OTEL
 * endpoint variables Claude Code exports to hooks are blanked for the same reason, and so is
 * ARTISYN_PROJECT_ROOT (a dev sandbox container sets it container-wide; a scenario that tests the
 * override passes it explicitly through `env`).
 */
export function fakeHomeEnv(fakeHome: string): Record<string, string> {
  return {
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    CLAUDE_CONFIG_DIR: '',
    OTEL_EXPORTER_OTLP_ENDPOINT: '',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '',
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: '',
    ARTISYN_HOOK_SERVICE: '',
    ARTISYN_PROJECT_ROOT: '',
  };
}

interface GitContextModule {
  getGitRoot(cwd: string): string;
}

/** The hook's own git-root resolution, loaded from the source tree (plain CommonJS). */
function hookGitRoot(dir: string): string {
  const mod: GitContextModule = require(path.join(HOOK_SOURCE_DIR, 'git-context.js'));
  return mod.getGitRoot(dir);
}

/** `~/.claude/projects/<slug>` dir name the hook derives from the repo's git root. */
export function projectSlugFor(repoDir: string): string {
  return hookGitRoot(repoDir).replace(/[^a-zA-Z0-9-]/g, '-');
}

/** `<home>/.claude/projects/<slug>` of `repoDir`, created. */
export function claudeProjectDir(home: string, repoDir: string): string {
  const dir = path.join(home, '.claude', 'projects', projectSlugFor(repoDir));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** `<home>/.claude/projects/<slug>/<sessionId>/subagents`, created. */
export function subagentsDir(home: string, repoDir: string, sessionId: string): string {
  const dir = path.join(claudeProjectDir(home, repoDir), sessionId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** `<repo>/.artisyn/ai_work_dir` — hook.log, recommendations, harness state. */
export function workDir(repoDir: string): string {
  return path.join(repoDir, '.artisyn', 'ai_work_dir');
}

/** The default telemetry dir `<repo>/.artisyn/ai_work_dir/telemetry`, created. */
export function telemetryDir(repoDir: string): string {
  const dir = path.join(workDir(repoDir), 'telemetry');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// project config
// ---------------------------------------------------------------------------

export type HookConfig = Record<string, unknown>;

/**
 * Writes `.artisyn/config/log-hub.json` (`base`) and/or `log-hub.local.json` (`local`) under the
 * repo — the git-root-anchored config every hook reads through `loadConfig(cwd)`.
 */
export function writeConfig(repoDir: string, { base, local }: { base?: HookConfig; local?: HookConfig }): void {
  const dir = path.join(repoDir, '.artisyn', 'config');
  fs.mkdirSync(dir, { recursive: true });
  if (base !== undefined) fs.writeFileSync(path.join(dir, 'log-hub.json'), JSON.stringify(base, null, 2), 'utf8');
  if (local !== undefined) fs.writeFileSync(path.join(dir, 'log-hub.local.json'), JSON.stringify(local, null, 2), 'utf8');
}

/**
 * Defaults every scenario config starts from: OTEL off (a Stop or SessionStart would otherwise
 * spawn a detached receiver on the project's OTEL port that outlives the scenario) and the
 * prompt-triggered background upload off unless a scenario turns it on.
 */
export const QUIET_HOOK_CONFIG: Readonly<HookConfig> = {
  otelEnabled: false,
  sendLogsOnPromptEnabled: false,
};

/**
 * The `ARTISYN` config a real install writes: `serverUrl` (and the rest) in the tracked
 * `log-hub.json`, the API key only in the git-ignored `log-hub.local.json`.
 */
export function writeStandConfig(repoDir: string, serverUrl: string, apiKey: string, extra: HookConfig = {}): void {
  writeConfig(repoDir, {
    base: { ...QUIET_HOOK_CONFIG, serverUrl, sendLogsTimeoutMs: 5000, ...extra },
    local: { apiKey },
  });
}

// ---------------------------------------------------------------------------
// running hook scripts
// ---------------------------------------------------------------------------

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd: string;
  [key: string]: unknown;
}

export interface RunOptions {
  /** Fake HOME (see {@link fakeHomeEnv}). */
  home?: string;
  /** Extra env, last wins. */
  env?: Record<string, string>;
  /** Written to stdin verbatim instead of `JSON.stringify(input)`; `input.cwd` is still the child's cwd. */
  rawStdin?: string;
  /** Kill the child and reject after this long (default 30 s). */
  timeoutMs?: number;
  /** Extra argv after the script path. */
  argv?: string[];
}

export interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

/** Spawns `node <script>` and collects its exit code, output and wall time. */
function runNode(script: string, cwd: string, stdin: string | null, opts: RunOptions): Promise<HookRun> {
  const { home, env, timeoutMs = 30_000, argv = [] } = opts;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [script, ...argv], {
      cwd,
      env: { ...process.env, ...(home ? fakeHomeEnv(home) : {}), ...(env ?? {}) },
      stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(script)} did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - startedAt });
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    if (stdin !== null && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

/** `node <script>` in `cwd` with `stdin` (null → no stdin), e.g. a command from an installed hooks.json. */
export function runNodeScript(script: string, cwd: string, stdin: string | null, opts: RunOptions = {}): Promise<HookRun> {
  return runNode(script, cwd, stdin, opts);
}

/** Runs one hook script of `toolDir` with `input` as the stdin JSON (Claude Code's hook contract). */
export function runScript(toolDir: string, scriptFile: string, input: HookInput, opts: RunOptions = {}): Promise<HookRun> {
  const stdin = opts.rawStdin !== undefined ? opts.rawStdin : JSON.stringify(input);
  return runNode(path.join(toolDir, scriptFile), input.cwd, stdin, opts);
}

/** `send-logs-hook.js` (Stop / SessionEnd). */
export function runHook(toolDir: string, input: HookInput, opts: RunOptions = {}): Promise<HookRun> {
  return runScript(toolDir, 'send-logs-hook.js', input, opts);
}

/**
 * `prompt-upload-hook.js` the way telemetry-hook.js launches it: `--cwd`/`--sessionId` argv, no
 * stdin.
 */
export function runPromptUpload(
  toolDir: string,
  args: { cwd: string; sessionId: string },
  opts: RunOptions = {},
): Promise<HookRun> {
  return runNode(path.join(toolDir, 'prompt-upload-hook.js'), args.cwd, null, {
    ...opts,
    argv: ['--cwd', args.cwd, '--sessionId', args.sessionId],
  });
}

// ---------------------------------------------------------------------------
// reading hook state
// ---------------------------------------------------------------------------

/** Lines of `<repo>/.artisyn/ai_work_dir/hook.log` (empty when absent), optionally of one script. */
export function readHookLog(repoDir: string, scriptFile?: string): string[] {
  let raw = '';
  try {
    raw = fs.readFileSync(path.join(workDir(repoDir), 'hook.log'), 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  return scriptFile ? lines.filter((l) => l.includes(`[${scriptFile}]`)) : lines;
}

/** `.claude-logs.sent` of a telemetry dir as `manifestKey → size` (empty when absent). */
export function readManifest(telemetry: string): Map<string, number> {
  const map = new Map<string, number>();
  let raw = '';
  try {
    raw = fs.readFileSync(path.join(telemetry, '.claude-logs.sent'), 'utf8');
  } catch {
    return map;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    const idx = t.lastIndexOf(' ');
    if (idx <= 0) continue;
    map.set(t.slice(0, idx), Number(t.slice(idx + 1)));
  }
  return map;
}

export interface HookRecommendation {
  rule: string;
  message: string;
  detectedAt: string;
}

/** `hook-recommendations.json` of the repo (empty list when absent). */
export function readRecommendations(repoDir: string): HookRecommendation[] {
  try {
    const parsed: { recommendations?: HookRecommendation[] } = JSON.parse(
      fs.readFileSync(path.join(workDir(repoDir), 'hook-recommendations.json'), 'utf8'),
    );
    return parsed.recommendations ?? [];
  } catch {
    return [];
  }
}

/** A JSON object (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parsed NDJSON lines of a body (blank lines skipped; a non-object line throws). */
export function ndjsonLines(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const parsed: unknown = JSON.parse(l);
      if (!isRecord(parsed)) throw new Error(`NDJSON line is not an object: ${l.slice(0, 120)}`);
      return parsed;
    });
}

// ---------------------------------------------------------------------------
// fake log hub
// ---------------------------------------------------------------------------

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** `type` / `sessionId` query params, for short assertions. */
  type: string | null;
  sessionId: string | null;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** Arrival order, 0-based. */
  index: number;
  receivedAt: number;
}

/** What the hub does with one request. */
export type FakeReply =
  | { status: number; body?: string }
  /** Accept the connection, never answer (the client's timeout must fire). */
  | 'hang'
  /** Destroy the socket without a response. */
  | 'drop';

export type FakeResponder = (req: FakeRequest) => FakeReply | Promise<FakeReply>;

export interface FakeLogHub {
  url: string;
  port: number;
  requests: FakeRequest[];
  /** Replaces the responder (default: 201 `{"warnings":[]}`). */
  respond(responder: FakeResponder): void;
  /** `type/sessionId` of every request, in arrival order. */
  uploads(): string[];
  close(): Promise<void>;
}

const OK_REPLY: FakeReply = { status: 201, body: JSON.stringify({ warnings: [] }) };

/**
 * The fake-log-hub fixture: a loopback HTTP server that records every request and answers by a
 * swappable responder. Hanging sockets are destroyed on `close()`.
 */
export async function startFakeLogHub(responder: FakeResponder = () => OK_REPLY): Promise<FakeLogHub> {
  let current = responder;
  const requests: FakeRequest[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const record: FakeRequest = {
        method: req.method ?? '',
        path: url.pathname,
        query: url.searchParams,
        type: url.searchParams.get('type'),
        sessionId: url.searchParams.get('sessionId'),
        headers: req.headers,
        body: Buffer.concat(chunks),
        index: requests.length,
        receivedAt: Date.now(),
      };
      requests.push(record);
      void Promise.resolve(current(record)).then((reply) => {
        if (reply === 'hang') return;
        if (reply === 'drop') {
          req.socket.destroy();
          return;
        }
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(reply.body ?? '');
      });
    });
  });
  server.on('connection', (s: net.Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  const port = await listenLoopback(server);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    respond(next) {
      current = next;
    },
    uploads: () => requests.map((r) => `${r.type}/${r.sessionId}`),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function listenLoopback(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('server has no TCP address'));
        return;
      }
      resolve(addr.port);
    });
  });
}

// ---------------------------------------------------------------------------
// OTEL receiver and raw HTTP
// ---------------------------------------------------------------------------

/**
 * Binds an ephemeral loopback port, releases it and returns the number — the portable way to pick
 * a port for a child that must be told it up front. Also a port with nothing listening on it.
 */
export async function freeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  const port = await listenLoopback(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Resolves once something accepts a TCP connection on 127.0.0.1:`port`. A bare connect-and-close
 * writes nothing, so it does not re-arm the receiver's idle timer.
 */
export function waitForPort(port: number, { timeoutMs = 5000, intervalMs = 50 } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`nothing accepted a connection on 127.0.0.1:${port} within ${timeoutMs} ms`));
          return;
        }
        setTimeout(attempt, intervalMs);
      });
    };
    attempt();
  });
}

export interface ReceiverParams {
  port?: number;
  dir?: string;
  owner?: { gitRoot: string; repo: string };
  idleTimeoutMs?: number;
  maxBodyBytes?: number;
}

export interface ReceiverProcess {
  child: ChildProcess;
  /** Resolves with the exit code; registered eagerly, so an early exit is never missed. */
  exited: Promise<number | null>;
  /** `undefined` while running. */
  exitCode(): number | null | undefined;
  stderr(): string;
}

/**
 * Spawns `otel-receiver.js` of `toolDir` with the given argv (`useEnv` passes them as the
 * `ARTISYN_OTEL_*` variables instead — the launch form of hooks ≤ 2.5.1). A param left undefined
 * is passed neither way, which is how «missing --dir/--owner» is expressed.
 */
export function spawnReceiver(toolDir: string, params: ReceiverParams, { useEnv = false } = {}): ReceiverProcess {
  const argv = [path.join(toolDir, 'otel-receiver.js')];
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of [
    'ARTISYN_OTEL_PORT',
    'ARTISYN_OTEL_DIR',
    'ARTISYN_OTEL_OWNER_JSON',
    'ARTISYN_OTEL_IDLE_TIMEOUT_MS',
    'ARTISYN_OTEL_MAX_BODY_BYTES',
  ]) {
    delete env[name];
  }
  const put = (flag: string, envName: string, value: string | number | undefined) => {
    if (value === undefined) return;
    if (useEnv) env[envName] = String(value);
    else argv.push(flag, String(value));
  };
  put('--port', 'ARTISYN_OTEL_PORT', params.port);
  put('--dir', 'ARTISYN_OTEL_DIR', params.dir);
  put('--owner', 'ARTISYN_OTEL_OWNER_JSON', params.owner === undefined ? undefined : JSON.stringify(params.owner));
  put('--idleTimeoutMs', 'ARTISYN_OTEL_IDLE_TIMEOUT_MS', params.idleTimeoutMs);
  put('--maxBodyBytes', 'ARTISYN_OTEL_MAX_BODY_BYTES', params.maxBodyBytes);

  const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true });
  let stderr = '';
  let code: number | null | undefined;
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
  child.stdout?.resume();
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (c) => {
      code = c;
      resolve(c);
    });
  });
  return { child, exited, exitCode: () => code, stderr: () => stderr };
}

/** Spawns a receiver on a free port (idle timeout 30 s unless given) and waits until it listens. */
export async function startReceiver(
  toolDir: string,
  params: ReceiverParams,
): Promise<{ receiver: ReceiverProcess; port: number }> {
  const port = params.port ?? (await freeLoopbackPort());
  const receiver = spawnReceiver(toolDir, { idleTimeoutMs: 30_000, ...params, port });
  await waitForPort(port);
  return { receiver, port };
}

/** Resolves with the exit code, or rejects after `timeoutMs`. */
export function waitForExit(receiver: ReceiverProcess, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process did not exit within ${timeoutMs} ms`)), timeoutMs);
    timer.unref();
    void receiver.exited.then((c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
}

/** Kills a still-running receiver and waits for it (best-effort). */
export async function stopReceiver(receiver: ReceiverProcess | undefined): Promise<void> {
  if (!receiver || receiver.exitCode() !== undefined) return;
  try {
    receiver.child.kill();
  } catch {
    // already gone
  }
  await waitForExit(receiver, 3000).catch(() => undefined);
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** Parsed JSON body, or null. */
  json: Record<string, unknown> | null;
}

export interface RawRequestOptions {
  method?: string;
  headers?: Record<string, string | number>;
  /** Target host (default 127.0.0.1). */
  host?: string;
}

/**
 * One HTTP request from Node's own client (no browser, no Playwright): an object body is sent as
 * JSON, a string/Buffer as is. `Content-Type: application/json` unless overridden.
 */
export function rawRequest(
  port: number,
  routePath: string,
  body?: unknown,
  { method = 'POST', headers = {}, host = '127.0.0.1' }: RawRequestOptions = {},
): Promise<RawResponse> {
  let payload: Buffer = Buffer.alloc(0);
  if (body !== undefined && body !== null) {
    if (Buffer.isBuffer(body)) payload = body;
    else if (typeof body === 'string') payload = Buffer.from(body, 'utf8');
    else payload = Buffer.from(JSON.stringify(body), 'utf8');
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path: routePath,
        method,
        // A fresh connection per request: the receiver tears a socket down after some rejections
        // (a 413), and a pooled keep-alive socket reused after that fails with ECONNRESET.
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (raw += c));
        res.on('end', () => {
          let json: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = JSON.parse(raw);
            if (isRecord(parsed)) json = parsed;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw, json });
        });
      },
    );
    // An oversized-body 413 is followed by a socket teardown; by then the promise has settled.
    req.on('error', reject);
    if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD') req.end();
    else req.end(payload);
  });
}

// ---------------------------------------------------------------------------
// fake programs
// ---------------------------------------------------------------------------

/**
 * A stdio MCP server that answers `initialize` and `tools/list` with one tool (`fake_tool`) — the
 * handshake the hook's MCP probe performs.
 */
export function writeFakeMcpServer(dir: string): string {
  const file = path.join(dir, 'fake-mcp.js');
  fs.writeFileSync(
    file,
    [
      "'use strict';",
      "process.stdin.setEncoding('utf8');",
      "let buf = '';",
      "process.stdin.on('data', (chunk) => {",
      '  buf += chunk;',
      '  let idx;',
      "  while ((idx = buf.indexOf('\\n')) !== -1) {",
      '    const line = buf.slice(0, idx).trim();',
      '    buf = buf.slice(idx + 1);',
      '    if (!line) continue;',
      '    let msg;',
      '    try { msg = JSON.parse(line); } catch { continue; }',
      "    if (msg.method === 'initialize') {",
      "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-mcp', version: '1.0.0' } } }) + '\\n');",
      "    } else if (msg.method === 'tools/list') {",
      "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'fake_tool', description: 'a fake tool', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } }] } }) + '\\n');",
      '    }',
      '  }',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  return file;
}

/** How a fake `claude` binary behaves. */
export type FakeClaudeBehavior = 'ok' | 'fail' | 'hang' | 'garbage';

/**
 * A fake `claude` in its own directory (`claude` with a shebang on POSIX, `claude.cmd` on Windows)
 * that appends its argv to `calls.log` next to it and then behaves as asked. Prepend the returned
 * `dir` to PATH so a hook that shells out to `claude` never reaches a real one.
 */
export function writeFakeClaude(dirs: TempDirs, behavior: FakeClaudeBehavior = 'ok'): { dir: string; bin: string; callsLog: string } {
  const dir = dirs.make(`fake-claude-${behavior}`);
  const callsLog = path.join(dir, 'calls.log');
  const impl = path.join(dir, 'fake-claude.js');
  const body: Record<FakeClaudeBehavior, string> = {
    ok: "process.stdout.write(JSON.stringify({ type: 'result', result: '{}', session_id: 'fake' }));",
    fail: "process.stderr.write('fake claude failed'); process.exitCode = 3;",
    hang: 'setInterval(() => {}, 60000);',
    garbage: "process.stdout.write('\\u0000not json at all <<<');",
  };
  fs.writeFileSync(
    impl,
    [
      "'use strict';",
      "const fs = require('fs');",
      `fs.appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      'process.stdin.resume();',
      "process.stdin.on('end', () => {});",
      body[behavior],
      '',
    ].join('\n'),
    'utf8',
  );
  let bin: string;
  if (process.platform === 'win32') {
    bin = path.join(dir, 'claude.cmd');
    fs.writeFileSync(bin, `@"${process.execPath}" "${impl}" %*\r\n`, 'utf8');
  } else {
    bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`, { encoding: 'utf8', mode: 0o755 });
  }
  return { dir, bin, callsLog };
}

/**
 * [win] Ids of the processes whose command line contains `marker` (the PowerShell process asking
 * is excluded). Always empty on other platforms.
 */
export function windowsProcessesMatching(marker: string): number[] {
  if (process.platform !== 'win32') return [];
  const res = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${marker.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  return res.stdout
    .split(/\r?\n/)
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** [win] Force-kills every process whose command line contains `marker`; no-op elsewhere. */
export function killWindowsProcessesMatching(marker: string): void {
  for (const pid of windowsProcessesMatching(marker)) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
}

/** PATH with `dir` in front (keeps the platform's own PATH variable name). */
export function pathWith(dir: string): Record<string, string> {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return { [key]: `${dir}${path.delimiter}${process.env[key] ?? ''}` };
}

// ---------------------------------------------------------------------------
// the built plugin (S-HOOK-09)
// ---------------------------------------------------------------------------

/** Regular-file entries of an uncompressed ustar/GNU tar buffer, by name. */
export function untar(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) break;
    const field = (start: number, len: number) => {
      const slice = header.subarray(start, start + len);
      const nul = slice.indexOf(0);
      return slice.subarray(0, nul < 0 ? len : nul).toString('utf8');
    };
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim(), 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    if (typeflag === '0' || typeflag === '\0') {
      entries.set(prefix ? `${prefix}/${name}` : name, buffer.subarray(offset, offset + size));
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** `.artisyn/marketplace/plugins/log-hub-hooks` under a project root. */
export function pluginRoot(repoDir: string): string {
  return path.join(repoDir, '.artisyn', 'marketplace', 'plugins', 'log-hub-hooks');
}

/**
 * Downloads `artisyn-hooks-installer.tgz` from the stand (the very file `npx <stand>/static/…`
 * runs), takes the plugin archive `hooks.tar.gz` bundled in it and extracts it over the project
 * root — the extraction step of `install`. Returns the plugin root. The installer's other steps
 * (config conversion, settings merge, `claude plugin` activation) belong to S-INST-01.
 */
export async function installBuiltPlugin(standUrl: string, repoDir: string): Promise<string> {
  const res = await fetch(`${standUrl}/static/artisyn-hooks-installer.tgz`);
  if (res.status !== 200) throw new Error(`GET /static/artisyn-hooks-installer.tgz → ${res.status}`);
  const installer = untar(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())));
  const archive = installer.get('package/dist/hooks.tar.gz');
  if (!archive) throw new Error(`the installer tarball has no package/dist/hooks.tar.gz: ${[...installer.keys()].join(', ')}`);
  const root = path.resolve(repoDir);
  for (const [name, data] of untar(zlib.gunzipSync(archive))) {
    const dest = path.resolve(root, name);
    if (!dest.startsWith(root + path.sep)) throw new Error(`plugin archive entry escapes the project: ${name}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  return pluginRoot(repoDir);
}

export interface PluginHookCommand {
  command: string;
  args: string[];
}

interface HooksJson {
  hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; args?: string[] }> }>>;
}

/**
 * The commands `hooks/hooks.json` of an installed plugin registers for `event`, in order, with
 * `${CLAUDE_PLUGIN_ROOT}` resolved the way Claude Code resolves it.
 */
export function pluginHookCommands(root: string, event: string): PluginHookCommand[] {
  const parsed: HooksJson = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
  return (parsed.hooks[event] ?? []).flatMap((group) =>
    group.hooks
      .filter((h) => h.type === 'command')
      .map((h) => ({
        command: h.command,
        args: (h.args ?? []).map((a) => a.split('${CLAUDE_PLUGIN_ROOT}').join(root)),
      })),
  );
}

/**
 * Runs every command the installed plugin registers for `input.hook_event_name`, one after the
 * other like Claude Code does, each with the stdin JSON and `CLAUDE_PLUGIN_ROOT` set. Only `node`
 * commands are expected; anything else fails the scenario.
 */
export async function runPluginEvent(root: string, input: HookInput, opts: RunOptions = {}): Promise<HookRun[]> {
  const event = input.hook_event_name ?? '';
  const commands = pluginHookCommands(root, event);
  if (commands.length === 0) throw new Error(`the plugin registers no hook for ${event}`);
  const runs: HookRun[] = [];
  for (const { command, args } of commands) {
    if (command !== 'node' || args.length === 0) throw new Error(`unexpected hook command for ${event}: ${command} ${args.join(' ')}`);
    runs.push(
      await runNode(args[0], input.cwd, JSON.stringify(input), {
        ...opts,
        argv: args.slice(1),
        env: { CLAUDE_PLUGIN_ROOT: root, ...(opts.env ?? {}) },
      }),
    );
  }
  return runs;
}

/** A short random id for session ids and repo paths of one scenario run. */
export function runToken(): string {
  return randomBytes(4).toString('hex');
}
