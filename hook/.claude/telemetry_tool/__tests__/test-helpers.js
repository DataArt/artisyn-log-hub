'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { getGitRoot } = require('../git-context');

const TOOL_DIR = path.join(__dirname, '..');

/**
 * Recursively copy a directory, skipping the given top-level entry names.
 * @param {string} src
 * @param {string} dest
 * @param {Set<string>} excludeNames
 */
function copyDirExcluding(src, dest, excludeNames) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (excludeNames.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirExcluding(s, d, excludeNames);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * Copy the telemetry_tool source directory (hook-log.js, recommendations.js,
 * send-logs-hook.js, version.json, etc.) into a fresh temp dir, so a test can
 * run a hook script as a child process without ever touching the real
 * source-of-truth files under hook/.claude/telemetry_tool/.
 * @returns {string} path to the copied directory
 */
function copyToolDir() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-tool-'));
  copyDirExcluding(TOOL_DIR, dest, new Set(['__tests__', '.env', '.env.local', 'node_modules']));
  return dest;
}

/** Create a throwaway git repository to use as the hook's `cwd`. */
function makeFakeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

/** Create a throwaway "home" directory so the hook never reads/writes the real ~/.claude. */
function makeFakeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hook-home-'));
}

/**
 * Create a linked git worktree off `mainRepoDir`. `git worktree add`
 * requires at least one commit to branch from, so if `mainRepoDir` has none yet, one is created
 * first (a marker file committed with explicit GIT_AUTHOR_ and GIT_COMMITTER_ env vars, so the
 * commit succeeds without relying on any global git config being set on the machine running the
 * tests). The worktree itself is created at a not-yet-existing `<parent>/wt` path inside a fresh
 * `fs.mkdtempSync`'d parent directory — `git worktree add` requires the target not already exist,
 * and mkdtemp's unique suffix also doubles as a unique branch-name suffix.
 * @param {string} mainRepoDir - a git repo dir (e.g. from makeFakeGitRepo())
 * @returns {string} the worktree's own directory path (distinct from mainRepoDir)
 */
function makeFakeGitWorktree(mainRepoDir) {
  const hasCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: mainRepoDir }).status === 0;
  if (!hasCommit) {
    fs.writeFileSync(path.join(mainRepoDir, '.worktree-marker'), 'seed\n', 'utf8');
    spawnSync('git', ['add', '.worktree-marker'], { cwd: mainRepoDir });
    spawnSync('git', ['commit', '-q', '-m', 'seed commit for worktree tests'], {
      cwd: mainRepoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@arrakis.test',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@arrakis.test',
      },
    });
  }

  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-worktree-'));
  const worktreeDir = path.join(parentDir, 'wt');
  const branchName = `wt-${path.basename(parentDir)}`;
  spawnSync('git', ['worktree', 'add', '-q', '-b', branchName, worktreeDir], { cwd: mainRepoDir });
  return worktreeDir;
}

/**
 * Computes the same `~/.claude/projects/<slug>` directory name send-logs-hook.js derives from a
 * repo's git root (see its "Claude files" section: `gitRoot.replace(/[^a-zA-Z0-9-]/g, '-')`).
 * Reuses the same `getGitRoot` the hook itself uses, so this stays correct even if the hook's
 * slugify regex ever changes.
 * @param {string} repoDir
 * @returns {string}
 */
/**
 * Env overrides that make a child hook resolve its user-level Claude dir to `<fakeHome>/.claude`:
 * `os.homedir()` reads `HOME`/`USERPROFILE`, and a blank `CLAUDE_CONFIG_DIR` neutralises one the
 * developer's own shell may export (`claudeConfigDir()` treats blank as unset). A test that wants
 * `CLAUDE_CONFIG_DIR` passes it through `opts.env`, which is spread after this.
 * @param {string} fakeHome
 * @returns {Record<string, string>}
 */
function fakeHomeEnv(fakeHome) {
  return { HOME: fakeHome, USERPROFILE: fakeHome, CLAUDE_CONFIG_DIR: '' };
}

function projectSlugFor(repoDir) {
  const gitRoot = getGitRoot(repoDir);
  return gitRoot.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * Creates `<fakeHome>/.claude/projects/<slug>/<sessionId>/subagents/` — the directory layout
 * send-logs-hook.js scans for `claude-subagent` uploads — and returns its path.
 * @param {string} fakeHome
 * @param {string} repoDir
 * @param {string} sessionId
 * @returns {string} the created `subagents` directory path
 */
function makeSubagentsDir(fakeHome, repoDir, sessionId) {
  const slug = projectSlugFor(repoDir);
  const dir = path.join(fakeHome, '.claude', 'projects', slug, sessionId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write `.artisyn/config/log-hub.json` (from `base`) and/or `log-hub.local.json` (from
 * `local`) under `configRootDir`. This is the *git-root-anchored* config location
 * env-context.js's `loadConfig(cwd)` resolves via `getGitRoot(cwd)` — NOT the tool install
 * directory — so callers driving a hook end-to-end (via `runHook`/`runScript`) must pass the
 * fake git repo dir used as that run's `cwd` (e.g. `makeFakeGitRepo()`'s return value), while
 * callers unit-testing `loadConfig()` directly may pass any directory (git repo or not —
 * `getGitRoot` falls back to the directory itself when it isn't inside a git repo).
 * @param {string} configRootDir
 * @param {{base?: Record<string, *>, local?: Record<string, *>}} [config]
 */
function writeConfig(configRootDir, { base, local } = {}) {
  const configDir = path.join(configRootDir, '.artisyn', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  if (base !== undefined) {
    fs.writeFileSync(path.join(configDir, 'log-hub.json'), JSON.stringify(base, null, 2), 'utf8');
  }
  if (local !== undefined) {
    fs.writeFileSync(path.join(configDir, 'log-hub.local.json'), JSON.stringify(local, null, 2), 'utf8');
  }
}

/**
 * Run a hook script (from a copied tool dir) as a child process, feeding the given object as
 * its stdin JSON payload (matching Claude Code's hook invocation contract:
 * {hook_event_name, cwd, session_id, ...}).
 * @param {string} toolDirCopy
 * @param {string} scriptFile - e.g. 'send-logs-hook.js', 'lifecycle-hook.js'
 * @param {object} input
 * @param {{fakeHome?: string, timeoutMs?: number, env?: Record<string, string>, rawStdin?: string}} [opts]
 *   `env` is merged over the inherited environment, last-wins. It exists so a test can neutralise
 *   a variable the developer's own shell may export — notably the `OTEL_EXPORTER_OTLP_*` endpoints
 *   Claude Code exposes to hooks from `.claude/settings.json`, which `resolveOtelPort` treats as
 *   the authority and which would otherwise silently override the port the test configured.
 *
 *   `rawStdin` writes that exact string to the child's stdin instead of `JSON.stringify(input)`,
 *   which is the only way to exercise a hook's "stdin was not JSON" branch — `input` is still used
 *   for the child's `cwd`, since a payload that does not parse cannot supply one.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runScript(toolDirCopy, scriptFile, input, opts = {}) {
  const { fakeHome, timeoutMs = 15000, env: extraEnv, rawStdin } = opts;

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(toolDirCopy, scriptFile)],
      {
        cwd: input.cwd || process.cwd(),
        env: {
          ...process.env,
          ...(fakeHome ? fakeHomeEnv(fakeHome) : {}),
          ...(extraEnv || {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${scriptFile} child process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });

    child.stdin.write(rawStdin !== undefined ? rawStdin : JSON.stringify(input));
    child.stdin.end();
  });
}

/**
 * Run send-logs-hook.js as a child process — thin wrapper over `runScript`.
 * @param {string} toolDirCopy
 * @param {object} input
 * @param {{fakeHome?: string, timeoutMs?: number, env?: Record<string, string>, rawStdin?: string}} [opts]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runHook(toolDirCopy, input, opts = {}) {
  return runScript(toolDirCopy, 'send-logs-hook.js', input, opts);
}

/**
 * Local HTTP server that records every request's query params + raw body,
 * then replies 201 — used to observe exactly what the hook uploads.
 * @returns {{server: import('http').Server, requests: Array<{type: string|null, sessionId: string|null, parentSessionId: string|null, workflowRunId: string|null, body: string}>}}
 */
function startRecordingServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({
        type: url.searchParams.get('type'),
        sessionId: url.searchParams.get('sessionId'),
        parentSessionId: url.searchParams.get('parentSessionId'),
        workflowRunId: url.searchParams.get('workflowRunId'),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(201);
      res.end();
    });
  });
  return { server, requests };
}

/**
 * Local HTTP server that records requests like startRecordingServer, but replies 201 with a
 * caller-controlled response body (or no body) instead of an always-empty one — used to
 * exercise uploadFile()'s `{ warnings: string[] }` response-body parsing.
 * @param {(sessionId: string|null) => string|undefined} responseBodyFor
 *   Returns the raw response body text to send for a given sessionId, or undefined for no body.
 * @returns {{server: import('http').Server, requests: Array<{type: string|null, sessionId: string|null, body: string}>}}
 */
function startRecordingServerWithResponse(responseBodyFor) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const sessionId = url.searchParams.get('sessionId');
      requests.push({
        type: url.searchParams.get('type'),
        sessionId,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const responseBody = responseBodyFor ? responseBodyFor(sessionId) : undefined;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(responseBody !== undefined ? responseBody : '');
    });
  });
  return { server, requests };
}

/**
 * Local HTTP server that accepts the connection but never responds — forces
 * the client's req.setTimeout(timeoutMs) branch to fire.
 * @returns {import('http').Server}
 */
function startHangingServer() {
  return http.createServer(() => {
    // Intentionally never call res.end().
  });
}

/**
 * Chunk-aware recording server: records every request's query params — including the
 * chunked-upload params `uploadId`/`chunkIndex`/`totalChunks`/`totalSize` — and lets the caller
 * override the per-request JSON response (status code + body, e.g. `{complete: true}` or a 400),
 * defaulting to sensible auto-replies so most tests don't need a custom `responseFor` at all:
 *   - a non-chunked request (no `uploadId`) gets `{ warnings: [] }`, matching the real server's
 *     unchanged non-chunked-path response shape;
 *   - a chunked request gets `{ complete: false }` for every chunk except the last
 *     (`chunkIndex === totalChunks - 1`), which gets `{ complete: true, warnings: [] }`.
 *
 * Each record also carries the request's `headers` and the raw, undecoded `bodyBuf`: once a
 * body can arrive gzipped, `body` — which is still the utf8 decoding of those same bytes, kept so
 * every pre-gzip assertion reads unchanged — is mojibake for a compressed request, and the only
 * way to check the encoding, the declared `Content-Length` or what the body actually inflates to is
 * to hold the bytes and the headers the client really sent.
 * @param {(record: {type: string|null, sessionId: string|null, parentSessionId: string|null, workflowRunId: string|null, uploadId: string|null, chunkIndex: number|null, totalChunks: number|null, totalSize: number|null, bodyBytes: number, body: string, bodyBuf: Buffer, headers: import('http').IncomingHttpHeaders}, requestIndex: number) => ({statusCode?: number, body?: string}|undefined)} [responseFor]
 *   Optional per-request response override. Return `undefined` (or omit) to use the default
 *   auto-reply described above; return `{statusCode, body}` (either field optional) to override
 *   just that piece for this one request.
 * @returns {{server: import('http').Server, requests: Array<object>}}
 */
function startChunkAwareRecordingServer(responseFor) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const getInt = (name) => {
        const raw = url.searchParams.get(name);
        return raw !== null ? parseInt(raw, 10) : null;
      };
      const bodyBuf = Buffer.concat(chunks);
      const record = {
        type: url.searchParams.get('type'),
        sessionId: url.searchParams.get('sessionId'),
        parentSessionId: url.searchParams.get('parentSessionId'),
        workflowRunId: url.searchParams.get('workflowRunId'),
        uploadId: url.searchParams.get('uploadId'),
        chunkIndex: getInt('chunkIndex'),
        totalChunks: getInt('totalChunks'),
        totalSize: getInt('totalSize'),
        bodyBytes: bodyBuf.length,
        body: bodyBuf.toString('utf8'),
        bodyBuf,
        headers: req.headers,
      };
      requests.push(record);

      const custom = responseFor ? responseFor(record, requests.length - 1) : undefined;
      const statusCode = (custom && custom.statusCode) || 201;
      let responseBody;
      if (custom && custom.body !== undefined) {
        responseBody = custom.body;
      } else if (record.chunkIndex !== null && record.totalChunks !== null) {
        const complete = record.chunkIndex >= record.totalChunks - 1;
        responseBody = JSON.stringify(complete ? { complete: true, warnings: [] } : { complete: false });
      } else {
        responseBody = JSON.stringify({ warnings: [] });
      }
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(responseBody);
    });
  });
  return { server, requests };
}

/**
 * Run `prompt-upload-hook.js` (from a copied tool dir) as a child process, passing
 * `--cwd`/`--sessionId` as argv (its actual invocation contract — it has no
 * stdin pipe when spawned detached by telemetry-hook.js, so unlike `runScript`/`runHook` this
 * never writes to the child's stdin).
 *
 * Pass `opts.viaEnv: true` to omit the argv flags and instead set
 * `ARTISYN_PROMPT_UPLOAD_CWD`/`ARTISYN_PROMPT_UPLOAD_SESSION_ID` env vars, exercising the same
 * fallback contract a hook <= 2.5.1 relies on: its Windows VBScript launch path could pass values
 * only that way (see spawn-hidden.js), so both forms must keep working across versions.
 * @param {string} toolDirCopy
 * @param {{cwd?: string, sessionId?: string}} [args]
 * @param {{fakeHome?: string, timeoutMs?: number, viaEnv?: boolean}} [opts]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, elapsedMs: number}>}
 */
function runPromptUploadHook(toolDirCopy, { cwd, sessionId } = {}, opts = {}) {
  const { fakeHome, timeoutMs = 15000, viaEnv = false } = opts;

  return new Promise((resolve, reject) => {
    const argv = [path.join(toolDirCopy, 'prompt-upload-hook.js')];
    if (!viaEnv) {
      if (cwd) argv.push('--cwd', cwd);
      if (sessionId) argv.push('--sessionId', sessionId);
    }

    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      argv,
      {
        cwd: cwd || process.cwd(),
        env: {
          ...process.env,
          ...(fakeHome ? fakeHomeEnv(fakeHome) : {}),
          ...(viaEnv ? {
            ARTISYN_PROMPT_UPLOAD_CWD: cwd || '',
            ARTISYN_PROMPT_UPLOAD_SESSION_ID: sessionId || '',
          } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`prompt-upload-hook.js child process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - startedAt });
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

/**
 * Build the on-disk fixture an OTEL test needs, laid out exactly as production does it:
 *
 *   <root>/                 a throwaway sandbox — nothing may ever be written directly here
 *     telemetry/            the project's `telemetryDir`
 *       otel/               `resolveOtelDir()`'s result — the receiver's `--dir`
 *
 * The two enclosing directories are not decoration: they are what makes "a malicious `session.id`
 * escaped the otel directory" observable. A `../evil` id would land in `telemetryDir`, a
 * `../../evil` one in `root`, so a test asserting nothing leaked only has to check that `root`
 * contains exactly `telemetry` and `telemetry` exactly `otel`.
 *
 * Passing `repoDir` (a `makeFakeGitRepo()` result) also writes `telemetryDir` into that repo's
 * `.artisyn/config/log-hub.json`, so a hook driven end-to-end resolves this same otel directory
 * through the real `resolveTelemetryDir` → `resolveOtelDir` path rather than through an env
 * override — which by design does not exist.
 * @param {{repoDir?: string, config?: Record<string, *>}} [opts]
 *   `config` is merged into the written `log-hub.json` alongside `telemetryDir` (e.g.
 *   `{otelEnabled: false}`); ignored when `repoDir` is absent.
 * @returns {{root: string, telemetryDir: string, otelDir: string, repoDir: string|null}}
 */
function makeOtelFixture(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-otel-'));
  const telemetryDir = path.join(root, 'telemetry');
  const otelDir = path.join(telemetryDir, 'otel');
  fs.mkdirSync(otelDir, { recursive: true });
  if (opts.repoDir) {
    writeConfig(opts.repoDir, { base: Object.assign({ telemetryDir }, opts.config || {}) });
  }
  return { root, telemetryDir, otelDir, repoDir: opts.repoDir || null };
}

/**
 * Resolve once a TCP listener is accepting connections on `127.0.0.1:<port>`, retrying until the
 * deadline. Used to wait for a spawned `otel-receiver.js` to finish binding — the process exists
 * long before it listens, so posting immediately after `spawn()` is a race.
 *
 * A bare connect-and-close is deliberate: it neither writes anything nor re-arms the receiver's
 * idle timer (which only a real request does), so a timing test can wait for readiness without
 * perturbing the very timer it is about to measure.
 * @param {number} port
 * @param {{timeoutMs?: number, intervalMs?: number}} [opts]
 * @returns {Promise<void>}
 */
function waitForReceiver(port, { timeoutMs = 5000, intervalMs = 50 } = {}) {
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
          reject(new Error(`nothing accepted a connection on 127.0.0.1:${port} within ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, intervalMs);
      });
    };
    attempt();
  });
}

/**
 * Bind an ephemeral loopback port, then release it and return the number — the only portable way
 * to pick a port for a child process that must be told its port up front. Inherently racy in
 * theory; in practice the OS does not immediately re-hand out a just-closed ephemeral port, and a
 * receiver that loses the race exits 0 on EADDRINUSE, which the test's readiness wait reports as a
 * clean timeout rather than a mystery.
 * @returns {Promise<number>}
 */
async function freeLoopbackPort() {
  const server = net.createServer();
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(/** @type {import('net').AddressInfo} */ (server.address()).port);
    });
  });
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** @param {import('http').Server} server @returns {Promise<number>} bound port */
function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(/** @type {import('net').AddressInfo} */ (server.address()).port);
    });
  });
}

/**
 * Write a throwaway Node script that acts as a minimal stdio JSON-RPC MCP server, for testing
 * `send-logs-hook.js`'s `probeMcpServerTools()` end-to-end.
 *
 * `behavior: 'respond'` (default) replies to `initialize` and then `tools/list` with one tool
 * (`fake_tool`), exactly the two-message handshake the probe performs.
 * `behavior: 'hang'` never writes anything to stdout, forcing the probe's timeout branch.
 *
 * @param {string} dir - directory to write the script into (e.g. a fake repo dir)
 * @param {'respond'|'hang'} [behavior]
 * @returns {string} absolute path to the written script
 */
function writeFakeMcpServer(dir, behavior = 'respond') {
  const scriptPath = path.join(dir, `fake-mcp-server-${behavior}.js`);
  const body = behavior === 'hang'
    ? "'use strict';\nprocess.stdin.resume();\nsetInterval(() => {}, 60000);\n"
    : [
      "'use strict';",
      'process.stdin.setEncoding(\'utf8\');',
      'let buf = \'\';',
      'process.stdin.on(\'data\', (chunk) => {',
      '  buf += chunk;',
      '  let idx;',
      '  while ((idx = buf.indexOf(\'\\n\')) !== -1) {',
      '    const line = buf.slice(0, idx).trim();',
      '    buf = buf.slice(idx + 1);',
      '    if (!line) continue;',
      '    let msg;',
      '    try { msg = JSON.parse(line); } catch { continue; }',
      '    if (msg.method === \'initialize\') {',
      '      process.stdout.write(JSON.stringify({ jsonrpc: \'2.0\', id: msg.id, result: { protocolVersion: \'2024-11-05\', capabilities: {}, serverInfo: { name: \'fake-mcp\', version: \'1.0.0\' } } }) + \'\\n\');',
      '    } else if (msg.method === \'tools/list\') {',
      '      process.stdout.write(JSON.stringify({ jsonrpc: \'2.0\', id: msg.id, result: { tools: [{ name: \'fake_tool\', description: \'a fake tool for tests\', inputSchema: { type: \'object\', properties: { x: { type: \'string\' } } } }] } }) + \'\\n\');',
      '    }',
      '  }',
      '});',
      '',
    ].join('\n');
  fs.writeFileSync(scriptPath, body, 'utf8');
  return scriptPath;
}

// ---------------------------------------------------------------------------
// spawning and driving a real otel-receiver.js child process
// ---------------------------------------------------------------------------

/**
 * Spawn `otel-receiver.js` from a copied tool dir (shared with otel-restart.test.js and
 * otel-register.test.js's real-process restart coverage).
 *
 * `useEnv` swaps every argv flag for its `ARTISYN_OTEL_*` twin — a hook <= 2.5.1 launches the
 * receiver through a Windows VBScript command line carrying env only, so both forms are production
 * paths across versions and both must keep working.
 * @param {string} toolDir
 * @param {{port?: number, dir?: string, owner?: *, idleTimeoutMs?: number, maxBodyBytes?: number}} params
 *   A key left `undefined` is passed neither way, which is how the "missing --dir/--owner" cases
 *   are expressed.
 * @param {{useEnv?: boolean}} [opts]
 * @returns {{child: import('child_process').ChildProcess, exited: Promise<number|null>,
 *   exitCode: number|null|undefined, stderr: string}}
 */
function spawnReceiver(toolDir, params, opts = {}) {
  const argv = [path.join(toolDir, 'otel-receiver.js')];
  const env = Object.assign({}, process.env);
  // A developer shell that happens to export these must not leak into the child.
  for (const name of ['ARTISYN_OTEL_PORT', 'ARTISYN_OTEL_DIR', 'ARTISYN_OTEL_OWNER_JSON',
    'ARTISYN_OTEL_IDLE_TIMEOUT_MS', 'ARTISYN_OTEL_MAX_BODY_BYTES']) {
    delete env[name];
  }

  const put = (flag, envName, value) => {
    if (value === undefined) return;
    if (opts.useEnv) env[envName] = String(value);
    else argv.push(flag, String(value));
  };
  put('--port', 'ARTISYN_OTEL_PORT', params.port);
  put('--dir', 'ARTISYN_OTEL_DIR', params.dir);
  put('--owner', 'ARTISYN_OTEL_OWNER_JSON', params.owner === undefined ? undefined : JSON.stringify(params.owner));
  put('--idleTimeoutMs', 'ARTISYN_OTEL_IDLE_TIMEOUT_MS', params.idleTimeoutMs);
  put('--maxBodyBytes', 'ARTISYN_OTEL_MAX_BODY_BYTES', params.maxBodyBytes);

  const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'], env });
  const state = { child, exitCode: undefined, stderr: '' };
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk.toString('utf8');
  });
  // Registered eagerly, so a child that exits before anyone waits is still observed — attaching an
  // `once('exit')` afterwards would hang forever.
  state.exited = new Promise((resolve) => {
    child.on('exit', (code) => {
      state.exitCode = code;
      resolve(code);
    });
  });
  return state;
}

/**
 * Spawn a receiver on a free port and wait until it is actually listening.
 * @param {string} toolDir
 * @param {Record<string, *>} params
 * @param {{useEnv?: boolean}} [opts]
 * @returns {Promise<{state: *, port: number}>}
 */
async function startReceiver(toolDir, params, opts = {}) {
  const port = params.port === undefined ? await freeLoopbackPort() : params.port;
  const state = spawnReceiver(toolDir, Object.assign({ idleTimeoutMs: 30000 }, params, { port }), opts);
  await waitForReceiver(port);
  return { state, port };
}

/**
 * Resolve when the receiver exits, or reject at the deadline. The timer is `unref()`'d and cleared
 * on the happy path so a finished test never leaves the runner waiting on it.
 * @param {*} state @param {number} [timeoutMs] @returns {Promise<number|null>}
 */
function waitForExit(state, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`receiver did not exit within ${timeoutMs}ms`)), timeoutMs);
    timer.unref();
    state.exited.then((code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** @param {{child: import('child_process').ChildProcess, exitCode: *, exited: Promise<*>}} state */
async function stopReceiver(state) {
  if (!state || state.exitCode !== undefined) return;
  try {
    state.child.kill();
  } catch {
    // already gone
  }
  await waitForExit(state, 3000).catch(() => {
    // a receiver that ignores the kill is the OS's problem, not this test's
  });
}

/**
 * Send one request to a (real or fake) receiver and read the whole response — shared so
 * otel-restart.test.js and otel-register.test.js's real-process coverage can drive a receiver
 * without re-implementing this.
 * @param {number} port
 * @param {string} routePath
 * @param {*} body - object (JSON-stringified), string or Buffer; ignored for GET
 * @param {{headers?: Record<string, *>, method?: string}} [opts]
 * @returns {Promise<{status: number, body: string, json: *}>}
 */
function requestJson(port, routePath, body, opts = {}) {
  const method = opts.method || 'POST';
  let payload = Buffer.alloc(0);
  if (body !== undefined && body !== null) {
    if (Buffer.isBuffer(body)) payload = body;
    else if (typeof body === 'string') payload = Buffer.from(body, 'utf8');
    else payload = Buffer.from(JSON.stringify(body), 'utf8');
  }

  const headers = Object.assign(
    { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    opts.headers || {},
  );

  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: routePath, method, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, body: raw, json });
      });
    });
    req.on('error', reject);
    if (method === 'POST') req.end(payload);
    else req.end();
  });
}

/** @param {string} p */
function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

module.exports = {
  copyToolDir,
  makeFakeGitRepo,
  makeFakeGitWorktree,
  makeFakeHome,
  makeSubagentsDir,
  makeOtelFixture,
  writeFakeMcpServer,
  projectSlugFor,
  writeConfig,
  runHook,
  runScript,
  runPromptUploadHook,
  startRecordingServer,
  startRecordingServerWithResponse,
  startChunkAwareRecordingServer,
  startHangingServer,
  listen,
  waitForReceiver,
  freeLoopbackPort,
  spawnReceiver,
  startReceiver,
  waitForExit,
  stopReceiver,
  requestJson,
  rmrf,
};
