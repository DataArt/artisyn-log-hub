---
type: "Log Schema Reference"
title: "Claude Log Message Types"
description: "Auto-generated reference for all message types in Claude telemetry logs: field schemas, types, sample values, and prevalence percentages."
tags:
  - logs
  - schema
  - claude
timestamp: "2026-06-15T14:10:06+04:00"
---

# Claude Log Message Types

> **Auto-generated** from live database on 2026-06-15.
> Filtered to Claude version **2.1.175** (latest found in logs).
> Based on 2219 log sessions, 10,345 entries.

## Overview

Each log session is stored as a JSONB array in `logs.body` where `log_type = 'claude'`.
Each array element is a log entry with a `type` field that determines its shape.

## Message Types

- [`ai-title`](#type-ai-title) — 679 entries
- [`assistant`](#type-assistant) — 4252 entries
- [`attachment`](#type-attachment) — 783 entries
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
| `sessionId` | string | "5b7c77b5-3133-482f-8420-4b74520c9e10", "a7828a67-db3a-4b3a-8e00-7b866d85b10e", "feae86fa-9846-4424-a292-1ce313606d66" |
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
| `parentUuid` | string | "1594e816-933f-48cf-a880-05b2021a7b3f", "45b9ade0-23df-4ca7-a6ec-fedc308ea29a", "a3a1eadb-f11a-4850-87d1-6cad89d1ad93" |
| `sessionId` | string | "5b7c77b5-3133-482f-8420-4b74520c9e10", "a7828a67-db3a-4b3a-8e00-7b866d85b10e", "feae86fa-9846-4424-a292-1ce313606d66" |
| `timestamp` | string | "2026-06-12T10:22:23.321Z", "2026-06-12T10:22:23.338Z", "2026-06-12T10:22:43.196Z" |
| `type` | string | "assistant" |
| `userType` | string | "external" |
| `uuid` | string | "45b9ade0-23df-4ca7-a6ec-fedc308ea29a", "a83999fd-5db8-471a-8cca-83cd79d6cd9b", "110e4648-95c3-41bd-87f8-7039ddc400cf" |
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
| `parentUuid` | string | "02860673-f577-4433-ad76-57126dd067a0", "99e23f48-7b58-496e-972e-da9e27ae502f", "f6c13ef3-50c4-4650-b8b1-b2088ee2da42" |
| `sessionId` | string | "5b7c77b5-3133-482f-8420-4b74520c9e10", "a7828a67-db3a-4b3a-8e00-7b866d85b10e", "feae86fa-9846-4424-a292-1ce313606d66" |
| `timestamp` | string | "2026-06-12T10:22:19.527Z", "2026-06-12T10:22:23.726Z", "2026-06-12T10:22:53.251Z" |
| `type` | string | "attachment" |
| `userType` | string | "external" |
| `uuid` | string | "99e23f48-7b58-496e-972e-da9e27ae502f", "f6c13ef3-50c4-4650-b8b1-b2088ee2da42", "1594e816-933f-48cf-a880-05b2021a7b3f" |
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

---

## Type: `file-history-snapshot`

**Entries analyzed:** 262

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `isSnapshotUpdate` | boolean | false, true |
| `messageId` | string | "f0e4e1a3-9fd3-45b9-88ed-19b38dcc8bbb", "02860673-f577-4433-ad76-57126dd067a0", "4fac4f2b-e867-45d1-bc3e-400aa570a053" |
| `snapshot` | object | see object samples below |
| `type` | string | "file-history-snapshot" |

#### `snapshot` object samples

**Sample 1:**
```json
{
  "messageId": "\"f0e4e1a3-9fd3-45b9-88ed-19b38dcc8bbb\"",
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
| `leafUuid` | string | "a3a1eadb-f11a-4850-87d1-6cad89d1ad93", "03c93863-50d5-4023-8b2b-b26bfbbb49cc", "d6eb7825-0bad-4350-b684-e09bd8390554" |
| `sessionId` | string | "5b7c77b5-3133-482f-8420-4b74520c9e10", "a7828a67-db3a-4b3a-8e00-7b866d85b10e", "feae86fa-9846-4424-a292-1ce313606d66" |
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
| `sessionId` | string | "5b7c77b5-3133-482f-8420-4b74520c9e10", "a7828a67-db3a-4b3a-8e00-7b866d85b10e", "feae86fa-9846-4424-a292-1ce313606d66" |
| `type` | string | "mode" |

---

## Type: `permission-mode`

**Entries analyzed:** 148

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `permissionMode` | string | "bypassPermissions" |
| `sessionId` | string | "5b7c77b5-3133-482f-8420-4b74520c9e10", "cb3d623f-824a-4732-8a8d-60cdf9266ca4", "b13721da-28c2-445a-99ca-3ffaab39dca3" |
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
| `sessionId` | string | "0273b885-c530-4b71-9575-f38d3782b51d", "efdf0a8c-9410-4ff6-9477-dcefff9ce868" |
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
| `parentUuid` | string \| null | "990e06c1-0dec-4846-ada5-4edd0794979a", "ea9c5c74-2645-41b4-958d-d9466032b1a3", "ff281a65-977e-418e-9349-1fafb623a093" |
| `sessionId` | string | "5b7c77b5-3133-482f-8420-4b74520c9e10", "a7828a67-db3a-4b3a-8e00-7b866d85b10e", "feae86fa-9846-4424-a292-1ce313606d66" |
| `subtype` | string | "stop_hook_summary", "turn_duration", "local_command" |
| `timestamp` | string | "2026-06-12T10:23:27.360Z", "2026-06-12T10:23:27.362Z", "2026-06-12T10:23:59.426Z" |
| `type` | string | "system" |
| `userType` | string | "external" |
| `uuid` | string | "ea9c5c74-2645-41b4-958d-d9466032b1a3", "514d11f2-cff6-4324-8bdd-ffc55d3be5e2", "348d2ad4-166a-4eb5-ae3c-aeed6577e26f" |
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
| `logicalParentUuid` | string | 10/248 (4%) | "823727d6-091b-4ee8-851f-961ca2a578f4", "c0242138-e202-4d7b-94f0-54ba0d58c278", "eb01da5e-3e8a-49c6-9b46-77308b20c22b" |
| `messageCount` | number | 97/248 (39%) | 40, 69, 56 |
| `pendingBackgroundAgentCount` | number | 1/248 (0%) | 1 |
| `preventedContinuation` | boolean | 97/248 (39%) | false |
| `slug` | string | 42/248 (17%) | "linear-cooking-robin", "sequential-meandering-mitten", "enchanted-watching-teacup" |
| `stopReason` | string | 97/248 (39%) | "" |
| `toolUseID` | string | 97/248 (39%) | "eafbd71c-7365-488b-afaf-d457d0c1a69e", "9535b817-98ca-4f88-a1a5-d6ea335c51e1", "978005d5-1844-47d4-b58b-25a01e169714" |

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
| `parentUuid` | null \| string | null, "829cf7c2-3bdb-477e-8fd7-adcee5deb313", "f0e4e1a3-9fd3-45b9-88ed-19b38dcc8bbb" |
| `sessionId` | string | "5b7c77b5-3133-482f-8420-4b74520c9e10", "a7828a67-db3a-4b3a-8e00-7b866d85b10e", "feae86fa-9846-4424-a292-1ce313606d66" |
| `timestamp` | string | "2026-06-12T10:21:20.578Z", "2026-06-12T10:22:19.527Z", "2026-06-12T10:22:23.727Z" |
| `type` | string | "user" |
| `uuid` | string | "829cf7c2-3bdb-477e-8fd7-adcee5deb313", "f0e4e1a3-9fd3-45b9-88ed-19b38dcc8bbb", "bc48037c-e0c4-426b-9ae7-f72a31b6bd2e" |

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
| `promptId` | string | 2586/2587 (100%) | "8913838d-8f48-412a-b56b-6235b570aa48", "0ad4181f-37d2-4bba-bc39-2f10a97698f9", "c407563e-6462-4004-8295-2dd6b89f3466" |
| `promptSource` | string | 110/2587 (4%) | "typed", "system" |
| `slug` | string | 669/2587 (26%) | "linear-cooking-robin", "sequential-meandering-mitten", "enchanted-watching-teacup" |
| `sourceToolAssistantUUID` | string | 2296/2587 (89%) | "a83999fd-5db8-471a-8cca-83cd79d6cd9b", "2e3f2c52-ec8c-46cb-899c-be020c11f350", "8f093a79-6ecb-4d96-90b7-f3bb0b6d9812" |
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
