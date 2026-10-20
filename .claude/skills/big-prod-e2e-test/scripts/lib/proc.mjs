// Process helpers: a throwing sync runner, an async runner with stdin, log files, timeout and
// process-tree kill, and a PATH lookup.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';
const MAX_BUFFER = 64 * 1024 * 1024;

function describe(cmd, args) {
  return [cmd, ...(args || [])].join(' ');
}

/**
 * Synchronous spawn that throws on spawn error, timeout or a non-zero exit.
 * opts: { cwd, env, input, shell, timeoutMs, allowFail }
 * Returns { status, stdout, stderr }.
 */
export function run(cmd, args = [], opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    shell: Boolean(opts.shell),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: opts.timeoutMs,
    windowsHide: true,
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const out = { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
  if (res.error) {
    throw new Error(`${describe(cmd, args)} failed to run: ${res.error.message}`);
  }
  if (res.status !== 0 && !opts.allowFail) {
    const tail = (out.stderr || out.stdout).trim().split(/\r?\n/).slice(-20).join('\n');
    const err = new Error(`${describe(cmd, args)} exited with ${res.status ?? res.signal}${tail ? `:\n${tail}` : ''}`);
    err.status = res.status;
    err.stdout = out.stdout;
    err.stderr = out.stderr;
    throw err;
  }
  return out;
}

/** Kill a process and all its descendants. Best effort; never throws. */
export function killTree(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      // The child was spawned detached, so it leads its own process group.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function openSink(file) {
  if (!file) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return fs.createWriteStream(file);
}

function finished(stream) {
  return new Promise((resolve) => {
    if (!stream) return resolve();
    stream.end(resolve);
  });
}

/**
 * Asynchronous spawn. Resolves to { exitCode, timedOut, pid } plus { stdout, stderr } for every
 * stream not redirected to a file. Rejects only when the process cannot be spawned.
 * opts: { cwd, env, input, timeoutMs, stdoutFile, stderrFile, shell }
 * stdin is closed when `input` is undefined.
 */
export function runAsync(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const stdoutSink = openSink(opts.stdoutFile);
    const stderrSink = openSink(opts.stderrFile);
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        shell: Boolean(opts.shell),
        detached: !IS_WIN,
        windowsHide: true,
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      Promise.all([finished(stdoutSink), finished(stderrSink)]).then(() => reject(err));
      return;
    }

    const chunks = { stdout: [], stderr: [] };
    const wire = (stream, sink, key) => {
      stream.on('data', (d) => {
        if (sink) sink.write(d);
        else chunks[key].push(d);
      });
    };
    wire(child.stdout, stdoutSink, 'stdout');
    wire(child.stderr, stderrSink, 'stderr');

    let timedOut = false;
    let timer = null;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, opts.timeoutMs);
    }

    let spawnError = null;
    child.on('error', (err) => {
      spawnError = err;
    });

    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        /* child closed stdin early (EPIPE) — nothing to do */
      });
      child.stdin.end(opts.input);
    }

    child.on('close', async (code) => {
      if (timer) clearTimeout(timer);
      await Promise.all([finished(stdoutSink), finished(stderrSink)]);
      if (spawnError && child.pid === undefined) {
        reject(new Error(`${describe(cmd, args)} failed to spawn: ${spawnError.message}`));
        return;
      }
      const result = { exitCode: code, timedOut, pid: child.pid };
      if (!stdoutSink) result.stdout = Buffer.concat(chunks.stdout).toString('utf8');
      if (!stderrSink) result.stderr = Buffer.concat(chunks.stderr).toString('utf8');
      resolve(result);
    });
  });
}

/** First match of `name` on PATH, or null. */
export function which(name) {
  const res = spawnSync(IS_WIN ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0 || !res.stdout) return null;
  const first = res.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return first || null;
}
