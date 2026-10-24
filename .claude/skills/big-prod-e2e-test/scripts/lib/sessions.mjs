// Runs one scenario as an isolated `claude -p` session, collects the actual
// evidence, retries a session that did not exercise its scenario
// and writes `<S#>.expected.json` + `<S#>.result.json`.
import fs from 'node:fs';
import path from 'node:path';
import { MAX_SESSION_ATTEMPTS, SESSION_EXTRA_ARGS, TIMEOUTS, USERS } from './config.mjs';
import { runAsync } from './proc.mjs';
import { mcpServerConfig, writeSessionMcpConfig } from './mcpdb.mjs';
import {
  checkIsolation,
  exercisedGap,
  extractHarness,
  findTranscripts,
  fixtureHarnessNames,
  globalHarnessNames,
  isExercised,
  parseStream,
  readTranscriptLines,
  workTimeWindow,
} from './evidence.mjs';
import { envFor, promptFor } from '../scenarios.mjs';

/** Statuses runScenario can leave in result.json; verification (P9) settles the final one. */
export const SESSION_STATUS = Object.freeze({
  pendingVerification: 'pending verification',
  notExercised: 'scenario not exercised',
  sessionError: 'fail: session error',
  // Set in P9 when the session never reached the server.
  notIngested: 'fail: not ingested',
});

/** Permission flags of a scenario without its own `permissionArgs`. */
export const DEFAULT_PERMISSION_ARGS = Object.freeze(['--permission-mode', 'bypassPermissions']);

/** Seconds a verified turn header may be below the transcript window (Design Decision 10). */
const WORK_TIME_SLACK_S = 2;

/**
 * `claude -p` argv for a scenario session (the prompt goes on stdin). The permission flags are the
 * scenario's `permissionArgs` (S8) or DEFAULT_PERMISSION_ARGS. `mcpConfigFile` is given only for a
 * scenario with its own MCP server (S7); `--strict-mcp-config` stays, so that file is the only MCP
 * source the session sees. `settingsFile` is given for a `rootSettings` scenario (S10/S11).
 */
export function sessionArgs(scenario, mcpConfigFile = null, settingsFile = null) {
  return [
    '-p',
    '--model',
    scenario.model,
    ...(scenario.permissionArgs ?? DEFAULT_PERMISSION_ARGS),
    '--output-format',
    'stream-json',
    '--verbose',
    ...(mcpConfigFile ? ['--mcp-config', `"${mcpConfigFile}"`] : []),
    ...(settingsFile ? ['--settings', `"${settingsFile}"`] : []),
    ...SESSION_EXTRA_ARGS,
  ];
}

/**
 * FR-8 fixed-format expected params (API changes → "Expected params") plus the verifier's per-check
 * blocks: `costUsd` (from the stream), the scenario's static `expect` blocks (bash, sysctx, agents,
 * bashPaths, denied) and, for a scenario with the `workTime` check (S9), `workTime`.
 * `extra` = { prompt (the filled prompt), costUsd, workWindow (workTimeWindow() or null) }.
 */
export function buildExpected(scenario, sessionId, model, harness, extra = {}) {
  const expected = {
    repo: scenario.repo,
    owner: USERS[scenario.owner]?.email ?? scenario.owner,
    session_id: sessionId,
    model,
    skills: harness.skills,
    rules: harness.rules,
    workflows: harness.workflows,
    subagents: harness.subagents,
    mcp: harness.mcp ?? [],
    prompt: extra.prompt ?? scenario.prompt,
    costUsd: extra.costUsd ?? null,
    ...structuredClone(scenario.expect ?? {}),
  };
  if ((scenario.verifyChecks ?? []).includes('workTime')) {
    const w = extra.workWindow ?? null;
    expected.workTime = w
      ? {
          minSeconds: Math.max(0, Math.floor(w.seconds - WORK_TIME_SLACK_S)),
          startTs: w.startTs,
          endTs: w.endTs,
          seconds: w.seconds,
        }
      : null;
  }
  return expected;
}

/** Path form used for comparisons: forward slashes, no trailing slash, lower-case on Windows. */
function samePathKey(p) {
  const fwd = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? fwd.toLowerCase() : fwd;
}

/**
 * `cwd: true` evidence (Design Decision 12): the transcript cwd is the session cwd, it is not the
 * session root, and — when the scenario sets ARTISYN_PROJECT_ROOT — the child env carried it with
 * the root as its value.
 */
export function cwdOk({ transcriptCwd, sessionCwd, root, scenarioEnv = {}, childEnv = {} }) {
  if (!transcriptCwd) return false;
  const got = samePathKey(transcriptCwd);
  if (got !== samePathKey(sessionCwd) || got === samePathKey(root)) return false;
  if (Object.prototype.hasOwnProperty.call(scenarioEnv, 'ARTISYN_PROJECT_ROOT')) {
    return samePathKey(childEnv.ARTISYN_PROJECT_ROOT) === samePathKey(root);
  }
  return true;
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * `--settings` file for a session started below its root (Design Decision 4): the root's
 * `.claude/settings.json` with every `extraKnownMarketplaces.*.source.path` made absolute
 * (`<root>/.artisyn/marketplace`, forward slashes) plus the `env` of its `settings.local.json`.
 * Nothing is written into the repo. Returns the written file path.
 */
export function writeRootSettings(root, file) {
  const claudeDir = path.join(root, '.claude');
  const base = readJsonFile(path.join(claudeDir, 'settings.json'));
  const localFile = path.join(claudeDir, 'settings.local.json');
  const local = fs.existsSync(localFile) ? readJsonFile(localFile) : {};
  const marketplace = path.join(root, '.artisyn', 'marketplace').replace(/\\/g, '/');
  for (const mp of Object.values(base.extraKnownMarketplaces ?? {})) {
    if (mp?.source && typeof mp.source.path === 'string') mp.source.path = marketplace;
  }
  const settings = { ...base, env: { ...(base.env ?? {}), ...(local.env ?? {}) } };
  writeJson(file, settings);
  return file;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

/**
 * One `claude -p` attempt: spawn (shell, cwd = `root/cwdRel`, isolated env plus the scenario's
 * filled env, filled prompt on stdin, tree-kill on timeout), then parse the stream and the local
 * transcripts. The root is `o.rootDir` (the worktree for S11) or the run's repo dir.
 */
async function runAttempt(scenario, n, runPaths, env, o) {
  const streamFile = runPaths.attemptStream(scenario.id, n);
  const stderrFile = runPaths.attemptStderr(scenario.id, n);
  const root = o.rootDir ?? runPaths.repoDir(scenario.repo);
  const sessionCwd = scenario.cwdRel ? path.join(root, scenario.cwdRel) : root;
  const childEnv = { ...env, ...envFor(scenario, root) };
  const prompt = promptFor(scenario, root);
  // One command string: with `shell: true` node only concatenates args anyway (DEP0190); args with
  // a path are quoted; the prompt goes on stdin to avoid cmd.exe quoting.
  let mcpFile = null;
  if (scenario.mcp && scenario.mcp.length) {
    if (!o.mcpDbUrl) throw new Error(`${scenario.id} needs an MCP database URL (opts.mcpDbUrl)`);
    mcpFile = writeSessionMcpConfig(runPaths.sessionMcpConfig(scenario.id), mcpServerConfig(o.mcpDbUrl));
  }
  const settingsFile = scenario.rootSettings ? writeRootSettings(root, runPaths.sessionSettings(scenario.id)) : null;
  const command = [o.claudeCmd, ...sessionArgs(scenario, mcpFile, settingsFile)].join(' ');
  const res = await runAsync(command, [], {
    cwd: sessionCwd,
    env: childEnv,
    input: prompt,
    shell: true,
    timeoutMs: o.timeoutMs,
    stdoutFile: streamFile,
    stderrFile,
  });

  const stream = parseStream(readLines(streamFile));
  const attempt = {
    n,
    session_id: stream.sessionId,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    exercised: false,
    model: stream.model,
    stream: path.basename(streamFile),
    stderr: path.basename(stderrFile),
  };

  let error = null;
  if (res.timedOut) error = `timed out after ${Math.round(o.timeoutMs / 1000)}s (process tree killed)`;
  else if (res.exitCode !== 0) error = `claude -p exited with ${res.exitCode}`;
  else if (!stream.init) error = 'no system/init event in stream-json';
  else if (!stream.sessionId) error = 'no session_id in stream-json';
  if (error) attempt.error = error;

  const isolation = checkIsolation(stream.init, o.globalNames, o.fixtureNames, scenario.mcp ?? []);

  let harness = {
    skills: [],
    rules: [],
    workflows: [],
    subagents: 0,
    mcp: [],
    reads: [],
    bashCalls: 0,
    bashErrors: 0,
    denials: [],
    backgroundAgent: false,
    toolUseAfterNotification: false,
    cwd: null,
    cwdOk: false,
  };
  let workWindow = null;
  const costUsd = stream.finalResult?.total_cost_usd ?? null;
  attempt.costUsd = costUsd;
  if (stream.sessionId) {
    const transcripts = findTranscripts(runPaths.claudeConfigDir, stream.sessionId);
    if (transcripts) {
      harness = extractHarness(readTranscriptLines(transcripts), transcripts.subagents.length);
      harness.cwdOk = cwdOk({
        transcriptCwd: harness.cwd,
        sessionCwd,
        root,
        scenarioEnv: scenario.env,
        childEnv,
      });
      workWindow = workTimeWindow(readTranscriptLines({ main: transcripts.main, subagents: [] }));
      attempt.transcript = transcripts.main;
    } else {
      attempt.gap = `no local transcript for ${stream.sessionId} under ${path.join(runPaths.claudeConfigDir, 'projects')}`;
    }
    if (transcripts && !error) {
      attempt.exercised = isExercised(scenario.requires, harness);
      if (!attempt.exercised) attempt.gap = exercisedGap(scenario.requires, harness);
    }
  }
  attempt.actual = harness;

  return { attempt, stream, harness, isolation, error, prompt, costUsd, workWindow };
}

/**
 * Runs a scenario: up to MAX_SESSION_ATTEMPTS sessions while the scenario is not exercised; a
 * session error (non-zero exit, timeout, unparsable stream) stops immediately with no retry.
 * Writes `<S#>.expected.json` for the last attempt that produced a session_id (the one to be
 * UI-verified) and `<S#>.result.json` with every attempt's session_id.
 *
 * opts (all optional, mainly for tests): { claudeCmd, timeoutMs, maxAttempts, globalNames,
 *   fixtureNames, mcpDbUrl, rootDir, log } — `mcpDbUrl` is required for a scenario with `mcp` (S7);
 *   `rootDir` is the session root (the worktree for a `useWorktree` scenario), default the repo dir.
 * result.json carries `costUsd` (the last stream `result` event's total_cost_usd, or null).
 * Returns the result object (also written to result.json) plus `expected` (or null).
 */
export async function runScenario(scenario, runPaths, env, opts = {}) {
  const o = {
    claudeCmd: opts.claudeCmd ?? 'claude',
    timeoutMs: opts.timeoutMs ?? TIMEOUTS.sessionMs,
    maxAttempts: opts.maxAttempts ?? MAX_SESSION_ATTEMPTS,
    globalNames: opts.globalNames ?? globalHarnessNames(),
    fixtureNames: opts.fixtureNames ?? fixtureHarnessNames(),
    mcpDbUrl: opts.mcpDbUrl ?? null,
    rootDir: opts.rootDir ?? null,
    log: opts.log ?? (() => {}),
  };

  const result = {
    id: scenario.id,
    repo: scenario.repo,
    owner: USERS[scenario.owner]?.email ?? scenario.owner,
    model: scenario.model,
    status: SESSION_STATUS.sessionError,
    attempts: [],
    isolation: { status: 'fail', detail: 'not checked' },
    costUsd: null,
    verdict: null,
  };
  let expected = null;
  fs.mkdirSync(runPaths.sessionsDir, { recursive: true });

  for (let n = 1; n <= o.maxAttempts; n++) {
    o.log(`${scenario.id}: attempt ${n}/${o.maxAttempts} (${scenario.repo}, ${scenario.model})`);
    const { attempt, stream, harness, isolation, error, prompt, costUsd, workWindow } = await runAttempt(
      scenario,
      n,
      runPaths,
      env,
      o,
    );
    result.attempts.push(attempt);
    result.isolation = isolation;

    if (stream.sessionId) {
      result.costUsd = costUsd;
      expected = buildExpected(scenario, stream.sessionId, stream.model, harness, { prompt, costUsd, workWindow });
      writeJson(runPaths.expectedFile(scenario.id), expected);
    }

    if (error) {
      result.status = SESSION_STATUS.sessionError;
      result.error = error;
      o.log(`${scenario.id}: session error — ${error}`);
      break;
    }
    if (attempt.exercised) {
      result.status = SESSION_STATUS.pendingVerification;
      o.log(`${scenario.id}: exercised (session ${stream.sessionId})`);
      break;
    }
    result.status = SESSION_STATUS.notExercised;
    o.log(`${scenario.id}: not exercised — ${attempt.gap}`);
    writeJson(runPaths.resultFile(scenario.id), result);
  }

  writeJson(runPaths.resultFile(scenario.id), result);
  return { ...result, expected };
}

/** True when the scenario's last session should go on to ingestion + UI verification (P9). */
export function needsVerification(result) {
  return result.status === SESSION_STATUS.pendingVerification || result.status === SESSION_STATUS.notExercised;
}
