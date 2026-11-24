#!/usr/bin/env node
'use strict';
/**
 * Claude Code Hook helper — the stdout tee of the Bash tool wrapper (not a hook entry point; run by
 * the generated shims of tool-wrap-shims.js, one process per wrapped call).
 *
 *   "$real" "$@" | node tool-wrap-tee.js <callsDir> <callId> <full|meta>
 *
 * The shell runs the real tool itself; this process only sits on the tool's stdout:
 *   - forwards every stdout byte unchanged (raw Buffers, no decoding), honouring back-pressure;
 *   - with capture `full`, copies the first CAPTURE_LIMIT_BYTES into `<callsDir>/<callId>.out`;
 *   - when the consumer closes the pipe (`| head -1`, EPIPE), stops forwarding but keeps draining —
 *     and capturing — until CAPTURE_LIMIT_BYTES have been read (`consumerClosed`), then exits so the
 *     tool gets SIGPIPE exactly as it would have without the wrapper (`truncated`);
 *   - on end of input appends one `stream_end` record to `<callsDir>/<callId>.jsonl` (the call's own
 *     record file; the shim wrote `start` before and writes `exit` after, so the file is only ever
 *     written by one process at a time).
 *
 * Every logging error is swallowed: a failed capture or record never stops the forwarding. SIGINT is
 * ignored, so a Ctrl-C that kills the tool still lets this process drain and write `stream_end`.
 * The process always exits 0.
 *
 * `--self-test` prints SELF_TEST_OUTPUT (`loghub-selftest-ok`) and exits 0 — the SessionStart
 * pre-flight runs it through the `__selftest` shim. `--self-check` is the installer's load check.
 *
 * `stream_end` record (one JSON line): `{ type:'stream_end', schema:1, callId, stdoutBytes,
 * capturedBytes, stderrBytes|null, consumerClosed, truncated, captureFailed, endedAtMs, durationMs }`.
 * `stderrBytes` is the size of `<callId>.err` at that moment (best effort: the stderr tee may still
 * be flushing; the uploader re-reads the file size).
 */

const fs = require('fs');
const path = require('path');
const { CAPTURE_LIMIT_BYTES, SELF_TEST_OUTPUT } = require('./tool-wrap-names');

const HOOK_FILE = 'tool-wrap-tee.js';

// `--self-check`: the installer's post-install load check — every require above has run.
require('./hook-log').exitIfSelfCheck(HOOK_FILE);

if (process.argv.includes('--self-test')) {
  process.stdout.write(`${SELF_TEST_OUTPUT}\n`);
  process.exit(0);
}

const [callsDir, callId, captureArg] = process.argv.slice(2);
const capture = captureArg === 'meta' ? 'meta' : 'full';
const startedAtMs = Date.now();

/** Whether the call's files can be written at all (a usable dir and a safe call id). */
const canLog = typeof callsDir === 'string' && callsDir.length > 0
  && typeof callId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(callId);

let stdoutBytes = 0;
let capturedBytes = 0;
let consumerClosed = false;
let truncated = false;
let captureFailed = false;
let finished = false;
let outFd = null;

if (canLog && capture === 'full') {
  try {
    outFd = fs.openSync(path.join(callsDir, `${callId}.out`), 'a');
  } catch {
    outFd = null;
    captureFailed = true;
  }
}

/** Ctrl-C reaches the whole process group: let the tool die, keep draining and log stream_end. */
try {
  process.on('SIGINT', () => {});
} catch {
  // signal handlers are best-effort (not every platform supports every signal)
}

/**
 * Copy (part of) a chunk into the `.out` capture, up to CAPTURE_LIMIT_BYTES in total.
 * @param {Buffer} buf
 */
function captureChunk(buf) {
  const room = CAPTURE_LIMIT_BYTES - capturedBytes;
  if (room <= 0) {
    truncated = true;
    return;
  }
  const part = buf.length > room ? buf.subarray(0, room) : buf;
  if (part.length < buf.length) truncated = true;
  capturedBytes += part.length;
  if (outFd === null) return;
  try {
    fs.writeSync(outFd, part);
  } catch {
    captureFailed = true;
    try { fs.closeSync(outFd); } catch { /* already closed */ }
    outFd = null;
  }
}

/** Size of `<callId>.err` right now, or null. */
function stderrSize() {
  if (!canLog) return null;
  try {
    return fs.statSync(path.join(callsDir, `${callId}.err`)).size;
  } catch {
    return null;
  }
}

/** Append the `stream_end` record once. Never throws. */
function writeStreamEnd() {
  if (finished) return;
  finished = true;
  if (outFd !== null) {
    try { fs.closeSync(outFd); } catch { /* ignore */ }
    outFd = null;
  }
  if (!canLog) return;
  try {
    const endedAtMs = Date.now();
    const rec = {
      type: 'stream_end',
      schema: 1,
      callId,
      stdoutBytes,
      capturedBytes,
      stderrBytes: stderrSize(),
      consumerClosed,
      truncated,
      captureFailed,
      endedAtMs,
      durationMs: endedAtMs - startedAtMs,
    };
    fs.appendFileSync(path.join(callsDir, `${callId}.jsonl`), JSON.stringify(rec) + '\n');
  } catch {
    // logging must never affect the tool
  }
}

/** The consumer is gone: stop forwarding, keep reading until the capture limit. */
function onConsumerClosed() {
  if (consumerClosed) return;
  consumerClosed = true;
  try { process.stdin.resume(); } catch { /* ignore */ }
  maybeStopDraining();
}

/** After the consumer closed, stop once CAPTURE_LIMIT_BYTES have been read: the tool gets SIGPIPE. */
function maybeStopDraining() {
  if (!consumerClosed || stdoutBytes < CAPTURE_LIMIT_BYTES) return;
  truncated = true;
  writeStreamEnd();
  process.exit(0);
}

process.stdout.on('error', onConsumerClosed);

process.stdin.on('data', (buf) => {
  stdoutBytes += buf.length;
  if (capture === 'full') {
    try {
      captureChunk(buf);
    } catch {
      captureFailed = true;
    }
  }
  if (!consumerClosed) {
    let flushed = true;
    try {
      flushed = process.stdout.write(buf);
    } catch {
      onConsumerClosed();
      return;
    }
    if (!flushed && !consumerClosed) {
      process.stdin.pause();
      process.stdout.once('drain', () => {
        try { process.stdin.resume(); } catch { /* ignore */ }
      });
    }
    return;
  }
  maybeStopDraining();
});

process.stdin.on('end', writeStreamEnd);
process.stdin.on('error', writeStreamEnd);
