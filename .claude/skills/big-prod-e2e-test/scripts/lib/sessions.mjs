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
} from './evidence.mjs';

/** Statuses runScenario can leave in result.json; verification (P9) settles the final one. */
export const SESSION_STATUS = Object.freeze({
  pendingVerification: 'pending verification',
  notExercised: 'scenario not exercised',
  sessionError: 'fail: session error',
});

/**
 * `claude -p` argv for a scenario session (the prompt goes on stdin). `mcpConfigFile` is given only
 * for a scenario with its own MCP server (S7); `--strict-mcp-config` stays, so that file is the only
 * MCP source the session sees.
 */
export function sessionArgs(model, mcpConfigFile = null) {
  return [
    '-p',
    '--model',
    model,
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'stream-json',
    '--verbose',
    ...(mcpConfigFile ? ['--mcp-config', `"${mcpConfigFile}"`] : []),
    ...SESSION_EXTRA_ARGS,
  ];
}

/** FR-8 fixed-format expected params (API changes → "Expected params"). */
export function buildExpected(scenario, sessionId, model, harness) {
  return {
    repo: scenario.repo,
    owner: USERS[scenario.owner]?.email ?? scenario.owner,
    session_id: sessionId,
    model,
    skills: harness.skills,
    rules: harness.rules,
    workflows: harness.workflows,
    subagents: harness.subagents,
    mcp: harness.mcp ?? [],
    prompt: scenario.prompt,
  };
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
 * One `claude -p` attempt: spawn (shell, cwd = repo, isolated env, prompt on stdin, tree-kill on
 * timeout), then parse the stream and the local transcripts.
 */
async function runAttempt(scenario, n, runPaths, env, o) {
  const streamFile = runPaths.attemptStream(scenario.id, n);
  const stderrFile = runPaths.attemptStderr(scenario.id, n);
  // One command string: with `shell: true` node only concatenates args anyway (DEP0190), and
  // none of these args contain spaces; the prompt goes on stdin to avoid cmd.exe quoting.
  let mcpFile = null;
  if (scenario.mcp && scenario.mcp.length) {
    if (!o.mcpDbUrl) throw new Error(`${scenario.id} needs an MCP database URL (opts.mcpDbUrl)`);
    mcpFile = writeSessionMcpConfig(runPaths.sessionMcpConfig(scenario.id), mcpServerConfig(o.mcpDbUrl));
  }
  const command = [o.claudeCmd, ...sessionArgs(scenario.model, mcpFile)].join(' ');
  const res = await runAsync(command, [], {
    cwd: runPaths.repoDir(scenario.repo),
    env,
    input: scenario.prompt,
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

  let harness = { skills: [], rules: [], workflows: [], subagents: 0, mcp: [], reads: [] };
  if (stream.sessionId) {
    const transcripts = findTranscripts(runPaths.claudeConfigDir, stream.sessionId);
    if (transcripts) {
      harness = extractHarness(readTranscriptLines(transcripts), transcripts.subagents.length);
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

  return { attempt, stream, harness, isolation, error };
}

/**
 * Runs a scenario: up to MAX_SESSION_ATTEMPTS sessions while the scenario is not exercised; a
 * session error (non-zero exit, timeout, unparsable stream) stops immediately with no retry.
 * Writes `<S#>.expected.json` for the last attempt that produced a session_id (the one to be
 * UI-verified) and `<S#>.result.json` with every attempt's session_id.
 *
 * opts (all optional, mainly for tests): { claudeCmd, timeoutMs, maxAttempts, globalNames,
 *   fixtureNames, mcpDbUrl, log } — `mcpDbUrl` is required for a scenario with `mcp` (S7).
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
    verdict: null,
  };
  let expected = null;
  fs.mkdirSync(runPaths.sessionsDir, { recursive: true });

  for (let n = 1; n <= o.maxAttempts; n++) {
    o.log(`${scenario.id}: attempt ${n}/${o.maxAttempts} (${scenario.repo}, ${scenario.model})`);
    const { attempt, stream, harness, isolation, error } = await runAttempt(scenario, n, runPaths, env, o);
    result.attempts.push(attempt);
    result.isolation = isolation;

    if (stream.sessionId) {
      expected = buildExpected(scenario, stream.sessionId, stream.model, harness);
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
