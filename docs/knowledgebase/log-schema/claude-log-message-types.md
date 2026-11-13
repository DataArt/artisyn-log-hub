---
type: "Log Schema Reference"
title: "Claude Log Message Types"
description: "Auto-generated reference for all message types in Claude telemetry logs: field schemas, types, sample values, prevalence percentages, and a hand-maintained list of every `system` subtype seen (turn_duration, stop_hook_summary, compact_boundary, local_command, scheduled_task_fire, informational, model_refusal_fallback)."
tags:
  - logs
  - schema
  - claude
timestamp: "2026-11-11T00:00:00+04:00"
---

# Claude Log Message Types

> **Auto-generated** from live database on 2026-06-15.
> Filtered to Claude version **2.1.175** (latest found in logs).
> Based on 2219 log sessions, 10,345 entries.
>
> **Hand-maintained after the snapshot.** Entries added after the 2026-06-15 snapshot are maintained by hand
> (no generator re-run): `atis-latch` and `cost-state`, first seen in Claude Code 2.1.280. Their counts are not
> part of the snapshot statistics above.

## Overview

Each log session is stored as a JSONB array in `logs.body` where `log_type = 'claude'`.
Each array element is a log entry with a `type` field that determines its shape.

## Message Types

- [`ai-title`](#type-ai-title) — 679 entries
- [`assistant`](#type-assistant) — 4252 entries
- [`atis-latch`](#type-atis-latch) — hand-maintained (Claude Code 2.1.280+)
- [`attachment`](#type-attachment) — 783 entries
- [`cost-state`](#type-cost-state) — hand-maintained (Claude Code 2.1.280+)
- [`file-history-snapshot`](#type-file-history-snapshot) — 262 entries
- [`last-prompt`](#type-last-prompt) — 632 entries
- [`mode`](#type-mode) — 691 entries
- [`permission-mode`](#type-permission-mode) — 148 entries
- [`queue-operation`](#type-queue-operation) — 4 entries
- [`system`](#type-system) — 248 entries
- [`system-context`](#type-system-context) — 59 entries
- [`user`](#type-user) — 2587 entries

---

## Type: `ai-title`

**Entries analyzed:** 679

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `aiTitle` | string | "Add model pricing migration for new Claude models", "Create implementation plan for analytics horizontal view", "Show grep command details in tool call logs" |
| `sessionId` | string | "<uuid>", "<uuid>", "<uuid>" |
| `type` | string | "ai-title" |

---

## Type: `assistant`

**Entries analyzed:** 4252

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `cwd` | string | "C:\\work\\project", "C:\\work\\project\…, "/repo" |
| `entrypoint` | string | "cli" |
| `gitBranch` | string | "feature/req-analytics-horisontal-view.md", "feature/req-repo-file-categories.md", "feature/raw-logs" |
| `isSidechain` | boolean | false |
| `message` | object | see object samples below |
| `parentUuid` | string | "<uuid>", "<uuid>", "<uuid>" |
| `sessionId` | string | "<uuid>", "<uuid>", "<uuid>" |
| `timestamp` | string | "2026-06-12T10:22:23.321Z", "2026-06-12T10:22:23.338Z", "2026-06-12T10:22:43.196Z" |
| `type` | string | "assistant" |
| `userType` | string | "external" |
| `uuid` | string | "<uuid>", "<uuid>", "<uuid>" |
| `version` | string | "2.1.175" |

### Optional Fields

| Field | Type | Present in | Sample Values |
|-------|------|-----------|---------------|
| `attributionMcpServer` | string | 1782/4252 (42%) | "playwright", "postgres" |
| `attributionMcpTool` | string | 1782/4252 (42%) | "browser_navigate", "browser_console_messages", "browser_snapshot" |
| `attributionSkill` | string | 1613/4252 (38%) | "claude-api", "implementation-plan", "nodejs-script" |
| `requestId` | string | 4251/4252 (100%) | "req_011CbyCYxv7c8yMWW8wdB1AV", "req_011CbyCZH8V4VB9usQP3eep6", "req_011CbyCaq6d6RSQUeBTVLkED" |
| `slug` | string | 1144/4252 (27%) | "linear-cooking-robin", "sequential-meandering-mitten", "enchanted-watching-teacup" |

#### `message` object samples

**Sample 1:**
```json
{
  "id": "\"msg_0145EKTrYSPVDqVSuppSrmeh\"",
  "role": "\"assistant\"",
  "type": "\"message\"",
  "model": "\"claude-sonnet-4-6\"",
  "usage": "{object}",
  "content": "[array]",
  "diagnostics": "null",
  "stop_reason": "\"tool_use\"",
  "stop_details": "null",
  "stop_sequence": "null"
}
```

**Sample 2:**
```json
{
  "role": "\"assistant\"",
  "model": "\"claude-sonnet-4-6\"",
  "usage": "{object}",
  "content": "[array]",
  "stop_reason": "\"end_turn\""
}
```

---

## Type: `atis-latch`

**Hand-maintained** — not part of the 2026-06-15 snapshot. First seen in Claude Code 2.1.280.

A session-level marker line. It has **no `timestamp`**, so it never affects a session's time span, and no
extractor reads it: it feeds no metric (tokens, cost, turns, work time). The raw-logs viewer shows it as a
collapsed row through the generic JSON fallback, with no special renderer.

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `atis` | string | opaque value set by Claude Code (present on 10,396/10,396 lines on the dev DB, 2026-10-21) |
| `sessionId` | string | "<uuid>" |
| `type` | string | "atis-latch" |

---

## Type: `attachment`

**Entries analyzed:** 783

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `attachment` | object | see object samples below |
| `cwd` | string | "C:\\work\\project", "C:\\work\\project\… |
| `entrypoint` | string | "cli" |
| `gitBranch` | string | "feature/req-analytics-horisontal-view.md", "feature/req-repo-file-categories.md", "feature/raw-logs" |
| `isSidechain` | boolean | false |
| `parentUuid` | string | "<uuid>", "<uuid>", "<uuid>" |
| `sessionId` | string | "<uuid>", "<uuid>", "<uuid>" |
| `timestamp` | string | "2026-06-12T10:22:19.527Z", "2026-06-12T10:22:23.726Z", "2026-06-12T10:22:53.251Z" |
| `type` | string | "attachment" |
| `userType` | string | "external" |
| `uuid` | string | "<uuid>", "<uuid>", "<uuid>" |
| `version` | string | "2.1.175" |

### Optional Fields

| Field | Type | Present in | Sample Values |
|-------|------|-----------|---------------|
| `slug` | string | 217/783 (28%) | "linear-cooking-robin", "sequential-meandering-mitten", "enchanted-watching-teacup" |

#### `attachment` object samples

**Sample 1:**
```json
{
  "type": "\"deferred_tools_delta\"",
  "addedLines": "[array]",
  "addedNames": "[array]",
  "readdedNames": "[array]",
  "removedNames": "[array]",
  "pendingMcpServers": "[array]"
}
```

**Sample 2:**
```json
{
  "type": "\"agent_listing_delta\"",
  "isInitial": "true",
  "addedLines": "[array]",
  "addedTypes": "[array]",
  "removedTypes": "[array]",
  "showConcurrencyNote": "true"
}
```

**Sample 3:**
```json
{
  "type": "\"skill_listing\"",
  "names": "[array]",
  "content": "\"- architect-assistant: Run an architect…",
  "isInitial": "true",
  "skillCount": "25"
}
```

**Sample 4:**
```json
{
  "type": "\"command_permissions\"",
  "allowedTools": "[array]"
}
```

**Sample 5:**
```json
{
  "path": "\"C:\\\\work\\\\project…",
  "type": "\"nested_memory\"",
  "content": "{object}",
  "displayPath": "\".claude\\\\rules\\\\server.md\""
}
```

`content` here is `{ path, type, content }` — `type` is `Project` / `User` / `Local`; the client
keeps it as `RuleInjection.type` (never the text).

**Sample 6 (hand-maintained, Claude Code ≥ ~2.1.280):** the initial instruction files.
```json
{
  "type": "\"instructions\"",
  "files": [
    { "path": "C:\\Users\\<name>\\.claude\\CLAUDE.md", "type": "User", "content": "…" },
    { "path": "C:\\work\\project\\CLAUDE.md", "type": "Project", "content": "…" },
    { "path": "C:\\work\\project\\CLAUDE.local.md", "type": "Local", "content": "…" }
  ]
}
```

Read by the client only for the System Context Files/Rules tabs (path, type, UTF-8 size of
`content`; the text is dropped, a `User` path becomes `~/.claude/…`) — see
`docs/knowledgebase/session-log-view.md` § "System Context Files / Rules — sources and merge".

---

## Type: `cost-state`

**Hand-maintained** — not part of the 2026-06-15 snapshot. First seen in Claude Code 2.1.280.

Claude Code's own running cost/usage counters for the session. It has **no `timestamp`**, so it never affects a
session's time span.

**Never a cost source.** Log Hub computes tokens and cost only from `assistant` `message.usage` (and OTEL cost
where configured); `totalCostUSD` / `modelUsage` here are Claude Code's client-side estimate and must never be read
into any metric, cost total or token count. No extractor reads this line. The raw-logs viewer shows it as a
collapsed row through the generic JSON fallback, with no special renderer.

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `modelUsage` | object | per-model usage counters (`{ "<model-id>": { … } }`) |
| `sessionId` | string | "<uuid>" |
| `startTime` | number | session start as recorded by Claude Code (epoch ms) |
| `totalCostUSD` | number | 0.4213 |
| `totalDuration` | number | wall-clock duration in ms |
| `type` | string | "cost-state" |

Also present on every line seen so far (404/404 on the dev DB, 2026-10-21; same list in
`tests/corpus/known-format.json` → `keysByType`): `hasUnknownModelCost` (boolean), `totalAPIDuration`,
`totalAPIDurationWithoutRetries`, `totalLinesAdded`, `totalLinesRemoved`, `totalToolDuration` (numbers).

---

## Type: `file-history-snapshot`

**Entries analyzed:** 262

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `isSnapshotUpdate` | boolean | false, true |
| `messageId` | string | "<uuid>", "<uuid>", "<uuid>" |
| `snapshot` | object | see object samples below |
| `type` | string | "file-history-snapshot" |

#### `snapshot` object samples

**Sample 1:**
```json
{
  "messageId": "\"<uuid>\"",
  "timestamp": "\"2026-06-12T10:21:20.579Z\"",
  "trackedFileBackups": "{object}"
}
```

---

## Type: `last-prompt`

**Entries analyzed:** 632

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `leafUuid` | string | "<uuid>", "<uuid>", "<uuid>" |
| `sessionId` | string | "<uuid>", "<uuid>", "<uuid>" |
| `type` | string | "last-prompt" |

### Optional Fields

| Field | Type | Present in | Sample Values |
|-------|------|-----------|---------------|
| `lastPrompt` | string | 626/632 (99%) | "I have updated cladue, is has new model     1. Default (rec…, "make implementation plan for docs/requirements/req-analytics…, "in client for session for log for tool call grep show detai… |

---

## Type: `mode`

**Entries analyzed:** 691

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `mode` | string | "normal" |
| `sessionId` | string | "<uuid>", "<uuid>", "<uuid>" |
| `type` | string | "mode" |

---

## Type: `permission-mode`

**Entries analyzed:** 148

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `permissionMode` | string | "bypassPermissions" |
| `sessionId` | string | "<uuid>", "<uuid>", "<uuid>" |
| `type` | string | "permission-mode" |

### Optional Fields

| Field | Type | Present in | Sample Values |
|-------|------|-----------|---------------|
| `timestamp` | string | 1/148 (1%) | "2026-06-15T10:00:01.000Z" |

---

## Type: `queue-operation`

**Entries analyzed:** 4

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `operation` | string | "enqueue", "remove", "dequeue" |
| `sessionId` | string | "<uuid>", "<uuid>" |
| `timestamp` | string | "2026-06-15T08:33:18.612Z", "2026-06-15T08:33:23.744Z", "2026-06-12T11:11:23.090Z" |
| `type` | string | "queue-operation" |

### Optional Fields

| Field | Type | Present in | Sample Values |
|-------|------|-----------|---------------|
| `content` | string | 2/4 (50%) | "<task-notification>\n<task-id>bgek8tefn</task-id>\n<tool-us…, "<task-notification>\n<task-id>ada0e3374c21f7934</task-id>\n… |

---

## Type: `system`

**Entries analyzed:** 248

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `cwd` | string | "C:\\work\\project", "C:\\work\\project\… |
| `entrypoint` | string | "cli" |
| `gitBranch` | string | "feature/req-analytics-horisontal-view.md", "feature/req-repo-file-categories.md", "feature/raw-logs" |
| `isSidechain` | boolean | false |
| `parentUuid` | string \| null | "<uuid>", "<uuid>", "<uuid>" |
| `sessionId` | string | "<uuid>", "<uuid>", "<uuid>" |
| `subtype` | string | "stop_hook_summary", "turn_duration", "local_command" |
| `timestamp` | string | "2026-06-12T10:23:27.360Z", "2026-06-12T10:23:27.362Z", "2026-06-12T10:23:59.426Z" |
| `type` | string | "system" |
| `userType` | string | "external" |
| `uuid` | string | "<uuid>", "<uuid>", "<uuid>" |
| `version` | string | "2.1.175" |

### Optional Fields

| Field | Type | Present in | Sample Values |
|-------|------|-----------|---------------|
| `compactMetadata` | object | 10/248 (4%) | see object samples below |
| `content` | string | 54/248 (22%) | "<local-command-stdout></local-command-stdout>", "Conversation compacted", "<command-name>/doctor</command-name>\n            <command-… |
| `durationMs` | number | 97/248 (39%) | 67573, 345723, 120647 |
| `hasOutput` | boolean | 97/248 (39%) | false, true |
| `hookAdditionalContext` | array | 97/248 (39%) |  |
| `hookCount` | number | 97/248 (39%) | 1 |
| `hookErrors` | array | 97/248 (39%) |  |
| `hookInfos` | array | 97/248 (39%) |  |
| `isMeta` | boolean | 151/248 (61%) | false |
| `level` | string | 151/248 (61%) | "suggestion", "info" |
| `logicalParentUuid` | string | 10/248 (4%) | "<uuid>", "<uuid>", "<uuid>" |
| `messageCount` | number | 97/248 (39%) | 40, 69, 56 |
| `pendingBackgroundAgentCount` | number | 1/248 (0%) | 1 |
| `preventedContinuation` | boolean | 97/248 (39%) | false |
| `slug` | string | 42/248 (17%) | "linear-cooking-robin", "sequential-meandering-mitten", "enchanted-watching-teacup" |
| `stopReason` | string | 97/248 (39%) | "" |
| `toolUseID` | string | 97/248 (39%) | "<uuid>", "<uuid>", "<uuid>" |

#### `compactMetadata` object samples

**Sample 1:**
```json
{
  "trigger": "\"auto\"",
  "preTokens": "167443",
  "durationMs": "111082",
  "postTokens": "9888",
  "preservedSegment": "{object}",
  "preservedMessages": "{object}",
  "preCompactDiscoveredTools": "[array]"
}
```

### `system` subtypes

**Hand-maintained** — from the read-only harness-entries survey of the local-prod DB (cutoff 2026-11-11, 291 root
sessions with their sub-agent transcripts, Claude Code 2.1.211–2.1.319; generated table in the task folder
`docs/tasks/*/2026-11-10-harness-entries-ui-review/research/survey-table.md`). Key fields are the line's keys outside
the common envelope (`cwd`, `sessionId`, `timestamp`, `uuid`, …). Count / sessions are entries and root sessions
with at least one; line chars are the whole JSON line (median · p95 · max). No payload text is recorded here.

| Subtype | Key fields | When it is written | Count / sessions | Line chars |
|---|---|---|---|---|
| `turn_duration` | `durationMs`, `messageCount`, `pendingWorkflowCount`, `pendingBackgroundAgentCount`, `isMeta` | At the end of every interactive turn: Claude Code's own turn duration and message count. Never written in `claude -p` (0 of 18 sessions). Being a Stop-time line, the last turn's one reaches Log Hub only on a later upload or the SessionEnd flush (hook ≥ 2.8.0). | 2033 / 252 | 490 · 537 · 597 |
| `stop_hook_summary` | `hookCount`, `hookInfos` (per hook: `command`, …), `hookErrors`, `hookAdditionalContext`, `hasOutput`, `preventedContinuation`, `stopReason`, `toolUseID` | After the Stop hooks of a turn ran; only with Stop hooks configured. Same Stop-time upload caveat as `turn_duration`. Written in `claude -p` too. | 1996 / 248 | 815 · 852 · 1202 |
| `compact_boundary` | `compactMetadata` (`trigger` `auto` / `manual`, `preTokens`, `postTokens`, `durationMs`, `preservedSegment`, `preservedMessages`, `preCompactDiscoveredTools`), `logicalParentUuid`, `content` ("Conversation compacted"), `isMeta` | At a manual (`/compact`) or automatic compaction; the compaction summary follows as a `user` line with `isCompactSummary: true`. | 13 / 13 | 1488 · 1855 · 1855 |
| `local_command` | `content` (the command and its stdout, wrapped in `<command-name>` / `<local-command-stdout>` tags), `commandRun`, `level`, `isMeta` | When a local slash command (e.g. `/doctor`, `/model`) runs in the REPL; the command text is also the turn's prompt. Not seen in `claude -p`. | 230 / 221 | 559 · 577 · 22781 |
| `scheduled_task_fire` | `taskId`, `cron`, `prompt`, `content`, `isMeta` | When a scheduled task (cron or `/loop`) fires and starts a turn; only in sessions with scheduled tasks. | 170 / 30 | 770 · 778 · 830 |
| `informational` | `content`, `level`, `isMeta` | A free-text notice from Claude Code (e.g. a suggestion). | 15 / 14 | 622 · 681 · 681 |
| `model_refusal_fallback` | `originalModel`, `fallbackModel`, `direction`, `scope`, `trigger`, `apiRefusalCategory`, `apiRefusalExplanation`, `refusedUserMessageUuid`, `retractedMessageUuids`, `content`, `isMeta` | When a request was refused and retried on a fallback model; the retracted assistant messages are named by uuid. | 1 / 1 | 1531 · 1531 · 1531 |

- Log Hub reads only `compact_boundary` today (client compaction divider and context tokens, server `walkTurns` →
  `session_cause_stats`, the hook's post-turn analysis). The others are shown only by the Raw Logs system renderer.
- `stop_hook_summary.hookInfos[].command`, like `hook_success.command` (see
  [attachment-types.md](attachment-types.md)), holds the hook's command line or its status message.

---

## Type: `system-context`

**Entries analyzed:** 59

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `claudeMd` | object | see object samples below |
| `type` | string | "system-context" |

### Optional Fields

| Field | Type | Present in | Sample Values |
|-------|------|-----------|---------------|
| `timestamp` | string | 1/59 (2%) | "2026-06-15T10:00:02.000Z" |

#### `claudeMd` object samples

**Sample 1:**
```json
{
  "files": "[array]",
  "totalBytes": "3757"
}
```

---

## Type: `user`

**Entries analyzed:** 2587

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `isSidechain` | boolean | false |
| `message` | object | see object samples below |
| `parentUuid` | null \| string | null, "<uuid>", "<uuid>" |
| `sessionId` | string | "<uuid>", "<uuid>", "<uuid>" |
| `timestamp` | string | "2026-06-12T10:21:20.578Z", "2026-06-12T10:22:19.527Z", "2026-06-12T10:22:23.727Z" |
| `type` | string | "user" |
| `uuid` | string | "<uuid>", "<uuid>", "<uuid>" |

### Optional Fields

| Field | Type | Present in | Sample Values |
|-------|------|-----------|---------------|
| `cwd` | string | 2586/2587 (100%) | "C:\\work\\project", "C:\\work\\project\… |
| `entrypoint` | string | 2586/2587 (100%) | "cli" |
| `gitBranch` | string | 2586/2587 (100%) | "feature/req-analytics-horisontal-view.md", "feature/req-repo-file-categories.md", "feature/raw-logs" |
| `interruptedMessageId` | string | 7/2587 (0%) | "msg_015LxVwHUZJVEW5DTtCKb5nn", "msg_018NRvR8bniUmMcCTGVZzhgX", "msg_015o7DD7JDGhW97YPrm6wC63" |
| `isCompactSummary` | boolean | 10/2587 (0%) | true |
| `isMeta` | boolean | 97/2587 (4%) | true, false |
| `isVisibleInTranscriptOnly` | boolean | 10/2587 (0%) | true |
| `origin` | object | 1/2587 (0%) | see object samples below |
| `permissionMode` | string | 106/2587 (4%) | "bypassPermissions" |
| `promptId` | string | 2586/2587 (100%) | "<uuid>", "<uuid>", "<uuid>" |
| `promptSource` | string | 110/2587 (4%) | "typed", "system" |
| `slug` | string | 669/2587 (26%) | "linear-cooking-robin", "sequential-meandering-mitten", "enchanted-watching-teacup" |
| `sourceToolAssistantUUID` | string | 2296/2587 (89%) | "<uuid>", "<uuid>", "<uuid>" |
| `sourceToolUseID` | string | 38/2587 (1%) | "toolu_018eHYzKxBYvB1PcmmuUnub7", "toolu_01QNJHbqRV93CYPnssZCvRnF", "toolu_0181WYPo4VWzLdZh7rX1bogs" |
| `toolUseResult` | object \| string \| array | 2296/2587 (89%) | see object samples below |
| `userType` | string | 2586/2587 (100%) | "external" |
| `version` | string | 2586/2587 (100%) | "2.1.175" |

#### `message` object samples

**Sample 1:**
```json
{
  "role": "\"user\"",
  "content": "\"<local-command-caveat>Caveat: The messa…"
}
```

#### `origin` object samples

**Sample 1:**
```json
{
  "kind": "\"task-notification\""
}
```

#### `toolUseResult` object samples

**Sample 1:**
```json
{
  "success": "true",
  "commandName": "\"claude-api\"",
  "allowedTools": "[array]"
}
```

**Sample 2:**
```json
{
  "numFiles": "0",
  "filenames": "[array]",
  "truncated": "false",
  "durationMs": "427"
}
```

**Sample 3:**
```json
{
  "file": "{object}",
  "type": "\"text\""
}
```

**Sample 4:**
```json
{
  "type": "\"create\"",
  "content": "\"INSERT INTO model_pricing (model_id, pr…",
  "filePath": "\"C:\\\\work\\\\project…",
  "originalFile": "null",
  "userModified": "false",
  "structuredPatch": "[array]"
}
```

**Sample 5:**
```json
{
  "filePath": "\"C:\\\\work\\\\project…",
  "newString": "\"    {\\n      \\\"idx\\\": 9,\\n      \\\"versi…",
  "oldString": "\"    {\\n      \\\"idx\\\": 9,\\n      \\\"versi…",
  "replaceAll": "false",
  "originalFile": "\"{\\n  \\\"version\\\": \\\"7\\\",\\n  \\\"dialect\\\"…",
  "userModified": "false",
  "structuredPatch": "[array]"
}
```

---

*Generated by `tmp/analyze-claude-log-types.js`*
