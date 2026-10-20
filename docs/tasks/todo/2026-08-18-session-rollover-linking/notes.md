# T-102 — Notes

## 2026-08-18 — Detection mechanism: measurements and evidence trail

Extracted from `requirements.md` while distilling that document down to its contract.

### How the approach changed

The original idea for this task was to read the snake_case `session_id` field off the new session's
earliest `claude` lines and treat it as a predecessor pointer. Measured against real transcripts,
it **does not identify the predecessor** — it names a chain *root*, not the immediate predecessor.
That is what pushed the design to the layered mechanism (hook fields → uuid containment →
snake_case as a last-resort origin hint).

### Per-signal verification

| Signal | What it actually means | Verified on |
|---|---|---|
| `sessionId` (camelCase) | The session file the line currently lives in. Rewritten on copy, so it can never mark a copied line. | The same uuid `dddd4444` reads `sessionId: aaaa1111` in `aaaa1111.jsonl` and `sessionId: bbbb2222` in `bbbb2222.jsonl`. |
| `session_id` (snake_case) | A per-line stamp of the session the line's content originated in, preserved across copies. | `bbbb2222` carries `session_id: cccc3333` on 23 lines (the root, two hops back) and its own id on 820; `aaaa1111` never appears in it as a `session_id` at all. |
| `uuid` | A stable content id, preserved verbatim when a background fork copies the predecessor's transcript prefix. | All 33 of `aaaa1111`'s uuids appear in `bbbb2222` as a contiguous prefix; `bbbb2222`'s first native line (ordinal 47) has `parentUuid = dddd4444`, which is `aaaa1111`'s last uuid. |

### Transcript survey

Measured on the 383 local transcripts of this project (Claude Code 2.1.215–2.1.227), in the
project's local Claude Code transcripts directory (`~/.claude/projects/<project-slug>/`), plus the
dev DB:

- 12 sessions are `sessionKind: "bg"` (~3%) — routine, not a one-off.
- The uuid rule (predecessor = the session whose uuid set is contained in this one, ranked by
  shared-uuid count) finds **5 pairs, with zero false positives and zero ambiguous candidates**:
  every match is a single, mutually-exclusive counterpart. The 7 unmatched `bg` sessions share no
  uuids with anything (three of them are 3–15-line stubs), so recall is partial but precision is
  total.
- `--resume` does **not** preserve uuids — the 23 lines `aaaa1111` inherited from `cccc3333` were
  re-issued with new uuids, which is why uuid overlap finds nothing there while the snake_case
  field does. The two signals are complementary, not competing.
- The predecessor lookup design (denormalized `last_line_uuid` plus a scan of the new session's own
  body, rather than a full per-line uuid index table) resolved 5 of 5 detectable pairs in this
  measurement.

### Motivating pair — sub-agent accounting

All 30 `sessions` rows with `workflow_run_id = 'wf_example1'` have
`parent_session_id = 'aaaa1111-...'`, so the sub-agents' own rows, their `session_stats` and their
entire cost already roll up under the old session via `descendantSessionsCte`
(`server/src/logs/session-tree.sql.ts:38-44`). What actually moved to the new session id is only
the hook-side `artisyn` event stream: 17 `SubagentStart`, 19 `SubagentStop`, 1210 `PostToolUse`,
1122 `PostToolBatch` lines under `bbbb2222`.

### Documentation cross-check

Field names and hook payload shapes (`SessionStart.source`, `SessionEnd.reason`) were cross-checked
against the official hooks documentation. The transcript JSONL format itself has no published spec,
which is why the uuid layer has to be covered by tests using recorded fixtures.

Re-running the measurements above is the cheapest way to re-validate the approach against a newer
Claude Code release.

## 2026-08-18 — Decision: Option A chosen, full merge deferred; OTEL research

**Decision.** Option A (link + breadcrumb) is the chosen approach for this task. The full-merge
alternative (previously "Option B") was scoped in `requirements.md` but is explicitly deferred, not
rejected outright — see that document's "Deferred: full merge" section for the rationale (measured
~3% continuation rate, 12/383 sessions, doesn't yet justify a chain-aware read path across every
report). The misleading first-prompt problem is folded into this task's scope rather than split off,
so that neither session in a detected pair renders as broken-looking on its own.

**OTEL research** (asked: how does OTEL behave across a rollover?). Read
`docs/knowledgebase/hook-system-overview.md` § "OTEL receiver" and `server/src/logs/otel-cost.sql.ts`:

- The per-project OTEL receiver is one long-lived process (not restarted per session), but it files
  records purely by the `session.id` OTLP attribute the CLI reports — no continuation awareness. A
  rollover therefore splits the OTEL stream exactly like the `claude`/`artisyn` streams: pre-rollover
  records in `<otelDir>/<oldSessionId>.jsonl`, post-rollover in `<otelDir>/<newSessionId>.jsonl`.
- Nothing is lost in transport — `send-logs-hook.js`'s `Stop` collection sweeps every `*.jsonl` in
  `otelDir` unfiltered, regardless of which session's `Stop` triggers the upload.
- `session_stats.telemetry_cost` (T-100) is recomputed per session id from that session's own
  `logs_otel` chunks, so a rollover pair gets two independent OTEL-vs-computed cost reconciliations,
  same as any two ordinary sessions — not a special case for Option A to handle, and consistent with
  Option A's "no changes to cost/analytics aggregation" stance.
- Noted as a residual, accepted risk: a short fragment's own OTEL total could look disproportionately
  low next to its own computed cost and trip the existing `OTEL_INCOMPLETE_RATIO` fallback — generic
  short-session behavior, not rollover-specific.
- Flagged for whoever eventually picks up the deferred full-merge alternative: a combined cost figure
  there must sum each fragment's own OTEL-reconciled cost, not just the computed-cost figures.
