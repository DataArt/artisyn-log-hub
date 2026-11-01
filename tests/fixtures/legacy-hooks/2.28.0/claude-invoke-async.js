'use strict';
/**
 * Claude Code Hook helper — async `claude -p` invocation (not a hook entry point itself).
 *
 * A `--print --no-session-persistence --output-format json` call in
 * async, spawn-based, Promise-returning form, so `post-turn-analysis-worker.js` can run its advisor
 * and attribution branches CONCURRENTLY (`Promise.allSettled`). Fail-open:
 * never throws, resolves `{ ok: false }` on any failure (spawn error, timeout, non-zero exit), and
 * falls back to treating stdout as plain text (no session id / cost) when the envelope isn't valid
 * JSON.
 *
 * This is the ONE helper module genuinely shared between Part A (advisor, Sonnet) and Part B
 * (attribution, Haiku) — every other hook helper in this codebase stays copied per script, but
 * both call sites here live in the same worker file by construction (`post-turn-analysis-worker.js`),
 * so there is no cross-script coupling to avoid.
 *
 * This helper also extracts `total_cost_usd`/`usage` from the envelope: both branches need `costUsd`/token counts for their `POST` bodies' `cost` block, and `model` is
 * already known to the caller (it's the very parameter passed in), so it isn't re-derived here.
 *
 * Result shape (both branches must check `.ok` before touching anything else):
 *   success: `{ ok: true, text, sessionId, costUsd, inputTokens, outputTokens,
 *              cacheReadTokens, cacheWriteTokens }`
 *   failure: `{ ok: false, failureKind: 'timeout'|'nonzero-exit'|'spawn-error',
 *              exitCode: number|null, stderrTail: string|null, errorMessage: string|null }`
 * `failureKind`/`exitCode`/`stderrTail` exist so a caller's `failureReason` string can say WHICH
 * of the three fail-open cases actually happened — before this, every one collapsed into the same
 * generic "timed out or exited non-zero" message and a stuck child (the common case in practice —
 * see `describeLlmFailure()`) was indistinguishable from a fast crash.
 */
const { spawn } = require('child_process');
const { buildProcessMarkerEnv, killProcessTree } = require('./process-marker');

/**
 * Marker exported into every `claude -p` session this helper spawns, and inherited from there by
 * that session's OWN hooks (Claude Code runs hooks as child processes of the CLI, so the whole
 * environment propagates).
 *
 * Without it the classifier/advisor session's `Stop` re-enters `post-turn-analysis-hook.js` and
 * spawns yet another pair of `claude -p` evaluations, which do the same again: one real user turn
 * fans out into an unbounded chain of LLM calls.
 */
const HOOK_SERVICE_ENV_VAR = 'ARTISYN_HOOK_SERVICE';
const HOOK_SERVICE_NAME = 'post-turn-analysis';

// Caps how much stdout is buffered from the child, mirroring the response-body caps
// `upload-logs.js` applies on the receiving side — a runaway/looping child must never grow this
// process's memory unbounded. Far larger than any real `--output-format json` envelope needs.
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;

// stderr is only ever used for a diagnostic tail on a failure path, never parsed — a few KB is
// plenty and keeps a chatty/looping child from growing this process's memory over it.
const MAX_STDERR_BYTES = 4 * 1024;

/**
 * Parse the `--output-format json` envelope: on a valid envelope, `result` is the LLM's text and
 * `session_id` is the spawned session id; on anything else (plain text, malformed JSON), the raw stdout is used as-is and the
 * session/cost fields stay at their "unknown" defaults — this is a plain-text FALLBACK, not a
 * failure, so it never resolves `callLlmAsync()` to `null`.
 * @param {string} raw
 * @returns {{ text: string, sessionId: string|null, costUsd: number|null, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }}
 */
function parseEnvelope(raw) {
  let text = raw;
  let sessionId = null;
  let costUsd = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.result === 'string') {
      text = parsed.result;
      sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null;
      costUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null;
      const usage = (parsed && typeof parsed.usage === 'object' && parsed.usage) || {};
      inputTokens = Number(usage.input_tokens) || 0;
      outputTokens = Number(usage.output_tokens) || 0;
      cacheReadTokens = Number(usage.cache_read_input_tokens) || 0;
      cacheWriteTokens = Number(usage.cache_creation_input_tokens) || 0;
    }
  } catch {
    // plain-text fallback — session id/cost stay unknown
  }

  return { text, sessionId, costUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/**
 * Invoke `claude --print` with `prompt` on stdin, async. Fail-open: never throws, and a spawn
 * error / timeout / non-zero exit code all resolve `{ ok: false, ... }` rather than rejecting —
 * the caller is expected to check `.ok` and, on `false`, skip this evaluation attempt.
 *
 * @param {string} prompt
 * @param {string} model - e.g. `'sonnet'` (advisor) or `'haiku'` (attribution)
 * @param {number} timeoutMs
 * @param {string} claudeBin - resolved claude executable (`'claude'` or `'claude.cmd'` on
 *   Windows) — resolution itself is the caller's job (`resolveClaude()` in the worker).
 * @returns {Promise<
 *   { ok: true, text: string, sessionId: string|null, costUsd: number|null, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number } |
 *   { ok: false, failureKind: 'timeout'|'nonzero-exit'|'spawn-error', exitCode: number|null, stderrTail: string|null, errorMessage: string|null }
 * >}
 */
function callLlmAsync(prompt, model, timeoutMs, claudeBin) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const stderrChunks = [];
    let stderrBytes = 0;
    const stderrTail = () => {
      const text = Buffer.concat(stderrChunks).toString('utf8').trim();
      return text.length > 0 ? text : null;
    };

    let child;
    try {
      child = spawn(
        claudeBin,
        ['--model', model, '--print', '--no-session-persistence', '--output-format', 'json'],
        {
          // shell: true on Windows so a `claude.cmd` shim resolves.
          shell: process.platform === 'win32',
          // windowsHide: see the note in git-context.js — this worker is itself launched
          // detached/console-less (spawn-hidden.js), so any console-subsystem grandchild it
          // spawns would otherwise get a visible console allocated for it. Pinned by
          // __tests__/no-visible-window.test.js — do not drop it.
          windowsHide: true,
          // Inherit the caller's environment (spawn's default when `env` is omitted) plus the
          // hook-service marker — see HOOK_SERVICE_ENV_VAR above. Pinned by
          // __tests__/claude-invoke-async.test.js. The ARTISYN_PROC_* markers merged in after it
          // are inert provenance (process-marker.js), never branched on — unlike
          // ARTISYN_HOOK_SERVICE, which is a re-entrancy guard that changes behaviour.
          env: Object.assign(
            {},
            process.env,
            { [HOOK_SERVICE_ENV_VAR]: HOOK_SERVICE_NAME },
            buildProcessMarkerEnv(`claude-invoke:${model}`, { hookFile: 'claude-invoke-async.js' }),
          ),
        }
      );
    } catch (err) {
      settle({ ok: false, failureKind: 'spawn-error', exitCode: null, stderrTail: null, errorMessage: err.message });
      return;
    }

    const timer = setTimeout(() => {
      // killProcessTree, not child.kill(): `shell: true` on Windows makes `child` a `cmd.exe`
      // wrapper whose grandchild is the real `claude` process, so killing the child alone leaves
      // a timed-out LLM call running. Best-effort either way — the 'close'/'error' handlers below
      // still fire.
      killProcessTree(child);
      settle({ ok: false, failureKind: 'timeout', exitCode: null, stderrTail: stderrTail(), errorMessage: null });
    }, timeoutMs);
    // Doesn't keep the process alive on its own merit — the child process itself does that,
    // and this timer is always cleared on 'close'/'error'. Explicit unref() is unnecessary here
    // since a live child already holds the event loop open, but costs nothing to be defensive.

    const stdoutChunks = [];
    let stdoutBytes = 0;

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes >= MAX_STDOUT_BYTES) return;
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      settle({ ok: false, failureKind: 'spawn-error', exitCode: null, stderrTail: stderrTail(), errorMessage: err.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        settle({ ok: false, failureKind: 'nonzero-exit', exitCode: code, stderrTail: stderrTail(), errorMessage: null });
        return;
      }
      const raw = Buffer.concat(stdoutChunks).toString('utf8').trim();
      settle({ ok: true, ...parseEnvelope(raw) });
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch {
      // a write failure here still resolves via the 'error'/'close' handlers above
    }
  });
}

// Caps how much of a captured stderr tail rides along in a one-line log message — the full
// (already-bounded-to-MAX_STDERR_BYTES) tail stays available on the failure object itself for
// anything that wants more.
const MAX_STDERR_TAIL_IN_MESSAGE = 200;

/**
 * Turn a `callLlmAsync()` failure result into the single human-readable string both branches of
 * `post-turn-analysis-worker.js` use as their `failureReason` (POSTed to the server and written to
 * the local `.artisyn/ai_work_dir/*.log` line) — one shared implementation so "timeout" vs.
 * "non-zero exit" vs. "spawn error" read the same way regardless of which branch hit it.
 * @param {{ ok: false, failureKind: 'timeout'|'nonzero-exit'|'spawn-error', exitCode: number|null, stderrTail: string|null, errorMessage: string|null }} result
 * @param {number} timeoutMs - the timeout this particular call was invoked with, for the 'timeout' message.
 * @returns {string}
 */
function describeLlmFailure(result, timeoutMs) {
  const stderrSuffix = result.stderrTail
    ? ` — stderr: ${result.stderrTail.slice(0, MAX_STDERR_TAIL_IN_MESSAGE).replace(/\s+/g, ' ')}`
    : '';
  switch (result.failureKind) {
    case 'timeout':
      return `LLM call timed out after ${timeoutMs}ms (child process killed)${stderrSuffix}`;
    case 'nonzero-exit':
      return `LLM call exited with code ${result.exitCode}${stderrSuffix}`;
    case 'spawn-error':
      return `LLM call failed to spawn: ${result.errorMessage}${stderrSuffix}`;
    default:
      return `LLM call failed for an unrecognized reason (${result.failureKind})${stderrSuffix}`;
  }
}

module.exports = { callLlmAsync, describeLlmFailure };
