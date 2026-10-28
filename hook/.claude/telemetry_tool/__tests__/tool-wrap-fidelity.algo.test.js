'use strict';

/**
 * Table test for docs/knowledgebase/algorithms/tool-wrapper-fidelity.md: every row's command runs
 * in a real shell twice — unwrapped, and wrapped exactly as a session would wrap it (Bash: the
 * generated shim dir first on PATH; PowerShell: the PreToolUse prefix) — and both runs must give
 * the same stdout / stderr and exit code. The wrapper's own records are checked against the row.
 *
 * Spawns real processes, so the whole file is skipped unless LOGHUB_FIDELITY_TEST=1 (DD-26); the
 * verification project `<repo>/../loghub-tool-wrap-check` (scripts/tool-wrap-check/create-check-project.mjs)
 * sets it. Environment:
 *   LOGHUB_FIDELITY_PROJECT — the verification project; its `bin/` holds the fixture tools;
 *   LOGHUB_FIDELITY_RUN_DIR — where this run writes shims, records and `fidelity-results.json`
 *                             (default `<project>/runs/<timestamp>`, or a fresh temp dir).
 * Nothing is ever deleted (DD-27): every run writes into a new folder and leaves it for the owner.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ENABLED = process.env.LOGHUB_FIDELITY_TEST === '1';

/** Per-run timeout of one shell invocation (the doc's rule 7). */
const RUN_TIMEOUT_MS = 10000;

if (!ENABLED) {
  test('tool-wrapper fidelity', { skip: 'set LOGHUB_FIDELITY_TEST=1 (run it from the loghub-tool-wrap-check project)' }, () => {});
} else {
  defineRows();
}

function defineRows() {
  const { loadExamples } = require('../../../../scripts/algo-docs/load-examples.cjs');
  const shims = require('../tool-wrap-shims');
  const toolWrapConfig = require('../tool-wrap-config');
  const { planPowerShellWrap } = require('../tool-wrap-powershell');
  const { FIXTURE_TOOLS } = require('./tool-wrap-fixtures');

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const project = process.env.LOGHUB_FIDELITY_PROJECT ? path.resolve(process.env.LOGHUB_FIDELITY_PROJECT) : null;
  const runDir = process.env.LOGHUB_FIDELITY_RUN_DIR
    ? path.resolve(process.env.LOGHUB_FIDELITY_RUN_DIR)
    : project
      ? path.join(project, 'runs', stamp)
      : fs.mkdtempSync(path.join(os.tmpdir(), 'loghub-fidelity-'));
  fs.mkdirSync(runDir, { recursive: true });

  // Each row's project is its own root: git must not climb into the verification project's repo,
  // and no ARTISYN_PROJECT_ROOT of the caller may redirect the work dir.
  process.env.GIT_CEILING_DIRECTORIES = runDir;
  delete process.env.ARTISYN_PROJECT_ROOT;

  const binDir = prepareBin(project, runDir, FIXTURE_TOOLS);
  const base = baseEnvironment();
  const shells = {
    bash: shims.resolveBash(),
    powershell: process.platform === 'win32' ? shims.findOnPath('powershell', base.pathValue) : null,
    pwsh: shims.findOnPath('pwsh', base.pathValue),
  };

  const results = {
    startedAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    runDir,
    binDir,
    shells,
    rows: {},
  };

  after(() => {
    results.finishedAt = new Date().toISOString();
    try {
      fs.writeFileSync(path.join(runDir, 'fidelity-results.json'), JSON.stringify(results, null, 2) + '\n');
    } catch {
      // the table on stdout is still there
    }
  });

  for (const row of loadExamples('tool-wrapper-fidelity')) {
    const skip = skipReason(row.input, shells);
    if (skip) {
      results.rows[row.id] = { status: 'skipped', reason: skip };
      test(`${row.id}: ${row.note}`, { skip }, () => {});
      continue;
    }
    const timeout = (row.input.measure ? (row.input.measure + 1) * 2 : 4) * RUN_TIMEOUT_MS;
    // Created now, so fidelity-results.json lists the rows in doc order.
    const entry = { status: 'not run' };
    results.rows[row.id] = entry;
    test(`${row.id}: ${row.note}`, { timeout }, async () => {
      entry.status = 'fail';
      try {
        await runRow(row, entry);
        entry.status = 'pass';
      } catch (err) {
        entry.reason = String((err && err.message) || err).split('\n').slice(0, 6).join('\n');
        throw err;
      }
    });
  }

  /**
   * Run one row: prepare the wrapped variant, run both, compare, check the records.
   * @param {{ id: string, input: object, expected: object }} row
   * @param {object} entry - this row's slot in fidelity-results.json
   */
  async function runRow(row, entry) {
    const { input, expected } = row;
    const rowDir = path.join(runDir, row.id);
    const projectDir = path.join(rowDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionId = `fidelity-${row.id.toLowerCase()}-${stamp}`;
    const sessionDir = toolWrapConfig.sessionDirPath(projectDir, sessionId);
    assert.ok(sessionDir, 'no session dir path');

    const pathValue = input.setup === 'no-node' ? withoutNode(base.pathValue) : base.pathValue;
    const rowEnv = { ...base.env, ...(input.env || {}) };
    const unwrappedEnv = { ...rowEnv, PATH: joinPath([binDir, pathValue]) };
    const wrappedEnv = { ...unwrappedEnv, CLAUDE_CODE_SESSION_ID: sessionId };
    let wrappedCommand = input.command;
    const tools = input.tools.map((name) => ({ name, capture: 'full' }));

    if (input.setup === 'corrupt-cache') {
      const cacheDir = path.dirname(sessionDir);
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, toolWrapConfig.CONFIG_CACHE_FILE), '{not json');
      const envFile = path.join(rowDir, 'claude-env.sh');
      fs.writeFileSync(envFile, '');
      const res = await shims.setupSessionToolWrap({ cwd: projectDir, sessionId, config: {}, envFile });
      entry.setup = res;
      if (expected.setup) assert.deepEqual(pick(res, Object.keys(expected.setup)), expected.setup);
      assert.equal(fs.readFileSync(envFile, 'utf8'), '', 'SessionStart must not export a PATH without a config');
    } else if (input.shell === 'bash') {
      fs.mkdirSync(sessionDir, { recursive: true });
      const gen = shims.generateShimDir(sessionDir, tools, { envPath: joinPath([binDir, pathValue]) });
      assert.ok(gen, 'the shim dir was not written');
      entry.generated = gen.generated;
      if (expected.generated) assert.deepEqual(gen.generated, expected.generated);
      const pf = shims.runPreflight(gen.shimDir, { bash: shells.bash });
      assert.equal(pf.ok, true, `pre-flight failed: ${pf.reason}`);
      if (input.setup === 'calls-is-file') fs.writeFileSync(path.join(sessionDir, shims.CALLS_DIR), '');
      // The shim dir goes first on PATH the way a session puts it there: Claude Code sources the
      // CLAUDE_ENV_FILE export inside the started bash, after the shell's own startup (Git for
      // Windows' bash.exe prepends /usr/bin first, which would otherwise shadow `find`).
      // Same line, so bash's own messages keep their `line 1:` prefix.
      wrappedCommand = `${shims.envFileExportLine(gen.shimDir)}; ${input.command}`;
      if (input.setup === 'shim-active') wrappedEnv.LOGHUB_SHIM_ACTIVE = '1';
    } else {
      // PowerShell: the PreToolUse hook's own decision, from a cached config and a passed pre-flight.
      toolWrapConfig.writeCache(projectDir, { schemaVersion: 1, paused: false, tools });
      shims.writePreflightFile(sessionDir, { schema: 1, ok: true, reason: null, shells: { bash: false, powershell: true } });
      const plan = planPowerShellWrap({
        tool_name: 'PowerShell',
        tool_input: { command: input.command },
        cwd: projectDir,
        session_id: sessionId,
      });
      assert.ok(plan, 'the PreToolUse hook did not wrap the command');
      wrappedCommand = plan.updatedInput.command;
    }

    const exe = shells[input.shell];
    const unwrapped = runShell(input.shell, exe, input.command, unwrappedEnv, rowDir);
    const wrapped = runShell(input.shell, exe, wrappedCommand, wrappedEnv, rowDir);
    entry.unwrappedMs = unwrapped.ms;
    entry.wrappedMs = wrapped.ms;
    assert.ifError(unwrapped.error);
    assert.ifError(wrapped.error);

    // Rule 2: fidelity.
    assert.equal(wrapped.status, unwrapped.status, `exit code: wrapped ${wrapped.status} vs unwrapped ${unwrapped.status}`);
    if (input.shell === 'bash') {
      assertSameBytes(wrapped.stdout, unwrapped.stdout, 'stdout');
      assertSameBytes(wrapped.stderr, unwrapped.stderr, 'stderr');
    } else {
      assert.equal(wrapped.stdout.toString('utf8'), unwrapped.stdout.toString('utf8'), 'stdout text');
      assert.equal(wrapped.stderr.toString('utf8'), unwrapped.stderr.toString('utf8'), 'stderr text');
    }
    if (expected.exitCode !== undefined) assert.equal(unwrapped.status, expected.exitCode, 'exit code');
    if (expected.stdout !== undefined) assert.equal(unwrapped.stdout.toString('utf8'), expected.stdout, 'stdout');

    // Rule 3: the wrapper's records.
    const calls = readCalls(sessionDir);
    entry.records = calls.length;
    if (expected.records !== undefined) assert.equal(calls.length, expected.records, 'number of recorded calls');
    if (expected.record) {
      assert.ok(calls[0], 'no recorded call');
      assert.deepEqual(pick(calls[0], Object.keys(expected.record)), expected.record);
    }
    if (expected.exitRecord !== undefined) assert.equal(calls[0] && calls[0].hasExit, expected.exitRecord, 'exit record');
    if (expected.outMatchesStdout) assertSameBytes(calls[0] && calls[0].out, unwrapped.stdout, '.out capture');
    if (expected.stdin !== undefined) {
      assert.equal(calls[0] && calls[0].in ? calls[0].in.toString('utf8') : null, expected.stdin, '.in capture');
    }
    if (expected.breaker) assert.deepEqual(shims.readBreakerState(sessionDir).tools.sort(), expected.breaker);

    // Rule 9: overhead.
    if (input.measure) {
      const un = [];
      const wr = [];
      for (let i = 0; i < input.measure; i++) {
        un.push(runShell(input.shell, exe, input.command, unwrappedEnv, rowDir).ms);
        wr.push(runShell(input.shell, exe, wrappedCommand, wrappedEnv, rowDir).ms);
      }
      entry.measure = { runs: input.measure, unwrappedMedianMs: median(un), wrappedMedianMs: median(wr) };
    }
  }

  /**
   * Run `command` in `shell`.
   * @returns {{ stdout: Buffer, stderr: Buffer, status: number|null, error: Error|undefined, ms: number }}
   */
  function runShell(shell, exe, command, env, cwd) {
    const args = shell === 'bash'
      ? ['-c', command]
      : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command];
    const t0 = Date.now();
    const res = spawnSync(exe, args, {
      cwd,
      env,
      timeout: RUN_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      stdout: res.stdout || Buffer.alloc(0),
      stderr: res.stderr || Buffer.alloc(0),
      status: res.status,
      error: res.error,
      ms: Date.now() - t0,
    };
  }

  /**
   * The calls recorded in `<sessionDir>/calls`: `start` + `stream_end` + `exit` merged per call id,
   * with the `.out` / `.in` captures. Ordered by call id (= start time).
   */
  function readCalls(sessionDir) {
    const callsDir = path.join(sessionDir, shims.CALLS_DIR);
    let names;
    try {
      if (!fs.statSync(callsDir).isDirectory()) return [];
      names = fs.readdirSync(callsDir);
    } catch {
      return [];
    }
    return names.filter((n) => n.endsWith('.jsonl')).sort().map((n) => {
      const callId = n.slice(0, -'.jsonl'.length);
      const call = { callId, hasExit: false, exitCode: null };
      for (const line of fs.readFileSync(path.join(callsDir, n), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type === 'start') Object.assign(call, { tool: rec.tool, args: rec.args, capture: rec.capture });
        else if (rec.type === 'stream_end') {
          Object.assign(call, pick(rec, ['stdoutBytes', 'capturedBytes', 'stderrBytes', 'consumerClosed', 'truncated']));
        } else if (rec.type === 'exit') Object.assign(call, { hasExit: true, exitCode: rec.exitCode });
      }
      call.out = readOptional(path.join(callsDir, `${callId}.out`));
      call.in = readOptional(path.join(callsDir, `${callId}.in`));
      return call;
    });
  }
}

/**
 * The fixture tools: `<project>/bin` when the verification project has one, else a copy written
 * into the run dir. Executable bits are set where the filesystem allows it.
 */
function prepareBin(project, runDir, fixtures) {
  const projectBin = project ? path.join(project, 'bin') : null;
  const dir = projectBin && fs.existsSync(projectBin) ? projectBin : path.join(runDir, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, spec] of Object.entries(fixtures)) {
    if (spec.windowsOnly && process.platform !== 'win32') continue;
    const file = path.join(dir, name);
    if (dir !== projectBin || !fs.existsSync(file)) fs.writeFileSync(file, spec.content);
    if (spec.executable) {
      try {
        fs.chmodSync(file, 0o755);
      } catch {
        // a mount that ignores modes (Windows host) — the files are executable there already
      }
    }
  }
  return dir;
}

/** The caller's environment without PATH (any case) and without wrapper state. */
function baseEnvironment() {
  const env = {};
  let pathValue = '';
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() === 'PATH') {
      if (!pathValue) pathValue = value || '';
      continue;
    }
    if (key === 'LOGHUB_SHIM_ACTIVE' || key === 'CLAUDE_CODE_SESSION_ID' || key === 'CLAUDE_ENV_FILE') continue;
    env[key] = value;
  }
  return { env, pathValue };
}

function joinPath(parts) {
  return parts.filter(Boolean).join(path.delimiter);
}

/** `pathValue` without the directories holding a `node` executable. */
function withoutNode(pathValue) {
  const names = process.platform === 'win32' ? ['node.exe', 'node'] : ['node'];
  return pathValue.split(path.delimiter)
    .filter((dir) => dir && !names.some((n) => fs.existsSync(path.join(dir.replace(/^"(.*)"$/, '$1'), n))))
    .join(path.delimiter);
}

/** Why a row cannot run here (rule 7), or null. */
function skipReason(input, shells) {
  const platform = process.platform;
  const osOk = input.os === 'any'
    || (input.os === 'windows' && platform === 'win32')
    || (input.os === 'linux' && platform === 'linux')
    || (input.os === 'posix' && platform !== 'win32');
  if (!osOk) return `os ${input.os} only (this is ${platform})`;
  if (!shells[input.shell]) return `shell ${input.shell} is not installed`;
  return null;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj ? obj[k] : undefined;
  return out;
}

function readOptional(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function assertSameBytes(actual, expected, label) {
  const a = actual || Buffer.alloc(0);
  if (Buffer.compare(a, expected) === 0) return;
  let i = 0;
  while (i < a.length && i < expected.length && a[i] === expected[i]) i++;
  assert.fail(`${label} differs at byte ${i} (lengths ${a.length} vs ${expected.length}): `
    + `${JSON.stringify(a.subarray(i, i + 40).toString('latin1'))} vs ${JSON.stringify(expected.subarray(i, i + 40).toString('latin1'))}`);
}

function median(values) {
  const s = [...values].sort((x, y) => x - y);
  return s.length === 0 ? null : s[Math.floor(s.length / 2)];
}
