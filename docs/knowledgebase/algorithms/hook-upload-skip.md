---
type: "Algorithm"
title: "Hook upload skip: when a collected file is not re-sent"
description: "Decides whether the hook's full upload scan may skip a collected file because the old size manifest and the v2 manifest (size, pre-read mtime, params hash, tool-calls fingerprint) prove the same content was already uploaded with the same params; when a pending chunked upload may be resumed; and, for claude / claude-subagent transcripts, whether only the new complete lines may be sent as an append (planAppend, stateAfterFull, chooseAppendEncoding)."
tags: [algorithm, hook, upload, manifest]
generated: { by: "claude-code", at: "2026-11-24T20:00:00+04:00" }
reviewed: no
reviewer: none
---

# Hook upload skip: when a collected file is not re-sent

## Purpose

The `Stop` full scan collects every transcript, sub-agent log, backlog `artisyn` file and
`tool-calls` upload of the repo. Re-sending them all on every `Stop` costs bandwidth and server
CPU, so the hook skips a file it has provably already uploaded. Hook `3.1.0` and older judged that
by byte size alone (`.claude-logs.sent`), which misses a same-length rewrite, a late
`<agent>.meta.json` that changes the upload's params, and a same-size change of a `tool-calls`
source file. The v2 manifest adds those, and the rule below never skips a file whose upload could
differ from the last one. A missed skip costs one redundant upload (the server's hash skip absorbs
it); a wrong skip loses data, so every doubt resolves to "send".

## Code

- Implementation: `hook/.claude/telemetry_tool/upload-skip.js` — `decideUploadSkip`,
  `canResumePending`, `paramsSha256`, `readManifestV2` / `writeManifestV2` (temp + rename),
  `readManifestV1` / `writeManifestV1`, `recordScopedClaudeUpload`; append path:
  `hook/.claude/telemetry_tool/append-upload.js` — `planAppend`, `stateAfterFull`,
  `chooseAppendEncoding` (the orchestrator `uploadWithAppend` is pipeline behaviour, not
  table-tested), with the record count from `ndjson-sanitize.js` `sanitizeNdjson().records`.
- Callers: `send-logs-hook.js` `runUpload` → `processFile` (the skip test, adoption, recording
  and pruning of both manifests) and the `tool-calls` collection (assemble only when not skipped);
  `runSessionEndFlush` and `prompt-upload-hook.js` (`recordScopedClaudeUpload`);
  `upload-logs.js` (`canResumePending`, pending-file resume); `uploadWithAppend` is called by the
  `Stop` scan's `processFile`, the `SessionEnd` flush and `prompt-upload-hook.js` for `claude` /
  `claude-subagent` only.
- `tool-calls` fingerprint: `tool-wrap-records.js` `toolCallsFingerprint` (sha256 of the sorted
  `relativeName\tsize\tmtimeMs` lines of `calls/*`, `breaker/*`, `preflight.json`);
  `toolCallsSourceSize` (Σ(size+1) of the same files) stays the old manifest's number.
- Design: task `docs/tasks/todo/2026-11-23-session-logs-streaming/` (FR-7, DD-26); append:
  task `docs/tasks/todo/2026-11-24-traffic-optimization/` (DD-12 to DD-16); pipeline:
  [../hook-system-overview.md](../hook-system-overview.md) § "Upload pipeline".
- Twins: none.
- Test: `hook/.claude/telemetry_tool/__tests__/upload-skip.algo.test.js`.

## Input and output

Every row has `input.kind`; a JSON `null` stands for an absent value.

| `kind` | Call | Compared |
|---|---|---|
| `skip` | `decideUploadSkip({isCurrentArtisyn, oldSize, v2, statSize, statMtimeMs, paramsSha256, fp?})` | `{skip, adopt}` |
| `resume` | `canResumePending(entry, totalSize, sha256)` | `{resume}` |
| `params` | `paramsSha256(params) === paramsSha256(other)` | `{equal}` |
| `append` | `planAppend({buf, state, appendOff, pendingChunked})` | `{kind, reason?, startLine?, delta?, newState?}` |
| `append-state` | `stateAfterFull(buf)` | `{state}` |
| `append-encoding` | `chooseAppendEncoding({plainBytes, gzipBytes, gzipUnsupported, loopback})` | `{encoding}` |

- `oldSize`: the `.claude-logs.sent` number of the file's manifest key.
- `v2`: the `.claude-logs.sent.v2` entry `{size, mtimeMs, paramsSha256, fp?}`.
- `statSize` / `statMtimeMs`: a stat of the file taken before the read. For `tool-calls`,
  `statSize` is Σ(size+1), `statMtimeMs` is 0 (ignored) and `fp` the fingerprint.
- `adopt`: record the v2 entry from the current stat (the old manifest alone proved the upload).
- Append state (`AppendState`): `{bytes, lines, sha256}` — stored on a v2 entry as
  `appendBytes` / `appendLines` / `appendSha256`: the server holds the file's raw bytes
  `[0, bytes)` as `lines` records, and `sha256` is the sha256 hex of exactly those raw bytes.
  `readManifestV2` keeps the three only when all three are valid (integers ≥ 0, 64 lowercase
  hex), otherwise it drops them and the entry stays valid. A call site passes no state when the
  entry's `paramsSha256` differs from the current one (`appendStateForEntry`).
- `buf`: the raw file bytes as read. In the rows, `file` is UTF-8 text and `state.sha256Of` is
  the text whose sha256 the test puts into `state.sha256`.
- `newState`: the append state to store after this step; the test also checks
  `newState.sha256 === sha256(file[0, newState.bytes))`.
- `records` (from `sanitizeNdjson`): the number of non-blank lines that parse as JSON — what the
  server's tolerant parser adds to `jsonb_array_length`.

## Rules

1. The current session's own `artisyn` file → send, never adopt (its body carries per-run
   prepends the on-disk file does not reflect).
2. No old manifest number → send.
3. No v2 entry and `oldSize === statSize` → skip and adopt.
4. A v2 entry → skip (no adopt) only when all hold, else send:
   a. `oldSize === v2.size === statSize`;
   b. `v2.mtimeMs === statMtimeMs`;
   c. `v2.paramsSha256 === paramsSha256`;
   d. when `fp` is given, `v2.fp === fp` (a missing `v2.fp` differs).
5. Anything else (no v2 entry and a different size) → send.
6. **Resume**: `canResumePending` is true only when the pending entry has a non-empty `sha256`
   equal to the body's, the same `totalSize`, and `nextChunkIndex < totalChunks`. A legacy entry
   without `sha256` is never resumed — the upload restarts with a new `uploadId`.
7. **Params hash**: sha256 hex of `JSON.stringify([type, sessionId, parentSessionId||'',
   workflowRunId||'', agentDescription||'', workflowPhase||''])` — positional, absent = null =
   `''`.
8. **Append plan** (`planAppend`), in order; the first that matches decides. `full` means the
   caller runs its normal full upload; `none` means no request:
   a. no `state` → `{kind:'full', reason:'no-state'}`;
   b. `appendOff` (404 cooldown for this server) → `full`, `'append-off'`;
   c. `pendingChunked` (`.claude-logs.pending` has an entry for this key) → `full`,
      `'pending-chunked'`;
   d. `buf.length < state.bytes` → `full`, `'shorter'`;
   e. `sha256(buf[0, state.bytes)) ≠ state.sha256` → `full`, `'hash-changed'`;
   f. `end = buf.lastIndexOf(0x0a) + 1` (just past the last newline; 0 when there is none). If
      `end ≤ state.bytes` → `{kind:'none', newState: state}` (no new complete line — a partial
      last line waits for its newline);
   g. `s = sanitizeNdjson(buf[state.bytes, end))`, `newState = {bytes: end, lines: state.lines +
      s.records, sha256: sha256(buf[0, end))}`;
   h. `s.records === 0` (only blank or malformed lines were added) → `{kind:'none', newState}`;
   i. otherwise → `{kind:'append', startLine: state.lines, delta: s.body, records: s.records,
      newState}`. `delta` is the sanitized text of the new complete lines only (malformed lines
      dropped, as the server would drop them).
9. **State after a full upload** (`stateAfterFull`): `end = buf.lastIndexOf(0x0a) + 1`. If the
   bytes after `end`, trimmed, are non-blank and `JSON.parse` accepts them → `null` (the full
   body carried a record after the last newline that the line counter cannot place, so the next
   upload is a full one again). Otherwise → `{bytes: end, lines:
   sanitizeNdjson(buf[0, end)).records, sha256: sha256(buf[0, end))}` (an unparseable tail is a
   torn line the server dropped too).
10. **Delta encoding** (`chooseAppendEncoding`): `'gzip'` only when all hold, else `'identity'`:
    `plainBytes ≥ APPEND_GZIP_MIN_BYTES` (16384); `gzipUnsupported` is false; `loopback` is
    false; `gzipBytes` is a number and `gzipBytes < plainBytes`.

Recording (not table-tested, pipeline behaviour): after a successful upload both manifests get the
key — the old one the read byte length (Σ for `tool-calls`), v2 `{size: read length, mtimeMs:
pre-read mtime, paramsSha256, fp?}` — and both are written in the same flush and pruned by the
same rule. `claude-otel` chunks are deleted after upload and never get a v2 entry. The scoped
paths (`UserPromptSubmit` background upload, `SessionEnd` flush) record only the current session's
`claude` transcript, only after a 201 and only when `sanitizeNdjson` dropped no line.

Append recording (pipeline behaviour): after an append `none` or a 2xx the v2 entry gets `size` =
read length plus `newState` as the three append fields; after a full upload it gets
`stateAfterFull(buf)` (none when that is `null`, or when the answer's `failedUploads` names this
file). An append 2xx whose `failedUploads` names this file is followed by a full upload at once
(reason `failed-feedback`). The scoped paths pass the state as the 5th argument of
`recordScopedClaudeUpload`.

## Edge cases

- Adoption on the first run of the new hook: US-01, US-13 (`tool-calls`).
- Never uploaded: US-03; v2 without an old entry: US-09.
- Same-length rewrite: US-05; late `.meta.json`: US-06, US-23.
- Size disagreements: old vs v2 US-07, both vs stat US-08, growth without v2 US-02.
- `tool-calls`: equal US-10, rewritten source US-11, v2 without `fp` US-12.
- Current artisyn: US-14, US-15.
- Resume: equal US-16, body changed US-17, legacy entry US-18, size US-19, finished US-20,
  none US-21.
- Params hash normalisation: US-22; positional: US-24.
- Append plan fallbacks: no state US-25, append off US-26, pending chunked US-27, shorter file
  US-28, changed prefix US-29.
- Append plan without a request: no growth US-30, only a partial last line added US-31, only
  blank / malformed lines added (state still advances) US-32.
- Append plan deltas: a normal delta US-33, a delta after a blank and a torn line in the prefix
  (`startLine` counts only parsed records) US-34, CRLF line ends US-35.
- State after a full upload: ends with a newline US-36, parseable partial tail (`null`) US-37,
  unparseable partial tail US-38, blank lines US-39.
- Delta encoding: 16383 bytes US-40, 16384 bytes US-41, gzip latched off US-42, loopback US-43,
  gzip not smaller US-44.

## Examples

Rows of kind `append` give `input` `{kind:'append', file, state: null | {bytes, lines,
sha256Of}, appendOff, pendingChunked}` and `expected` `{kind, reason?, startLine?, delta?,
newState?: {bytes, lines}}`; kind `append-state` gives `{kind:'append-state', file}` →
`{state: null | {bytes, lines}}`; kind `append-encoding` gives `{kind:'append-encoding',
plainBytes, gzipBytes, gzipUnsupported, loopback}` → `{encoding}`.

Rows (44): [`docs/algorithm-examples/hook-upload-skip.json`](../../algorithm-examples/hook-upload-skip.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- mtime not compared → US-05.
- Params hash not compared → US-06.
- Only `v2.size === statSize` checked (old manifest ignored) → US-07.
- `fp` ignored → US-11, US-12.
- Adoption without the old-size check → US-02.
- Current artisyn exemption dropped → US-14.
- Resume on size alone (the pre-3.2.0 rule) → US-17, US-18.
- Params joined without positions (e.g. concatenated non-empty values) → US-24.
- Prefix hash not checked (only the length) → US-29.
- Delta cut at the end of the buffer instead of the last newline (a partial line sent) → US-31.
- `startLine` counted as raw newlines instead of parsed records → US-34.
- `newState` not advanced when the added lines hold no record → US-32.
- `stateAfterFull` ignoring a parseable tail → US-37.
- Gzip threshold `>` instead of `≥` → US-41.
