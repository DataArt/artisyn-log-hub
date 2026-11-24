---
type: "Algorithm"
title: "Hook upload skip: when a collected file is not re-sent"
description: "Decides whether the hook's full upload scan may skip a collected file because the old size manifest and the v2 manifest (size, pre-read mtime, params hash, tool-calls fingerprint) prove the same content was already uploaded with the same params; also when a pending chunked upload may be resumed."
tags: [algorithm, hook, upload, manifest]
generated: { by: "claude-code", at: "2026-11-23T22:00:00+04:00" }
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
  `readManifestV1` / `writeManifestV1`, `recordScopedClaudeUpload`.
- Callers: `send-logs-hook.js` `runUpload` → `processFile` (the skip test, adoption, recording
  and pruning of both manifests) and the `tool-calls` collection (assemble only when not skipped);
  `runSessionEndFlush` and `prompt-upload-hook.js` (`recordScopedClaudeUpload`);
  `upload-logs.js` (`canResumePending`, pending-file resume).
- `tool-calls` fingerprint: `tool-wrap-records.js` `toolCallsFingerprint` (sha256 of the sorted
  `relativeName\tsize\tmtimeMs` lines of `calls/*`, `breaker/*`, `preflight.json`);
  `toolCallsSourceSize` (Σ(size+1) of the same files) stays the old manifest's number.
- Design: task `docs/tasks/todo/2026-11-23-session-logs-streaming/` (FR-7, DD-26); pipeline:
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

- `oldSize`: the `.claude-logs.sent` number of the file's manifest key.
- `v2`: the `.claude-logs.sent.v2` entry `{size, mtimeMs, paramsSha256, fp?}`.
- `statSize` / `statMtimeMs`: a stat of the file taken before the read. For `tool-calls`,
  `statSize` is Σ(size+1), `statMtimeMs` is 0 (ignored) and `fp` the fingerprint.
- `adopt`: record the v2 entry from the current stat (the old manifest alone proved the upload).

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

Recording (not table-tested, pipeline behaviour): after a successful upload both manifests get the
key — the old one the read byte length (Σ for `tool-calls`), v2 `{size: read length, mtimeMs:
pre-read mtime, paramsSha256, fp?}` — and both are written in the same flush and pruned by the
same rule. `claude-otel` chunks are deleted after upload and never get a v2 entry. The scoped
paths (`UserPromptSubmit` background upload, `SessionEnd` flush) record only the current session's
`claude` transcript, only after a 201 and only when `sanitizeNdjson` dropped no line.

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

## Examples

Rows (24): [`docs/algorithm-examples/hook-upload-skip.json`](../../algorithm-examples/hook-upload-skip.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- mtime not compared → US-05.
- Params hash not compared → US-06.
- Only `v2.size === statSize` checked (old manifest ignored) → US-07.
- `fp` ignored → US-11, US-12.
- Adoption without the old-size check → US-02.
- Current artisyn exemption dropped → US-14.
- Resume on size alone (the pre-3.2.0 rule) → US-17, US-18.
- Params joined without positions (e.g. concatenated non-empty values) → US-24.
