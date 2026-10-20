---
type: "Log Schema Reference"
title: "User Message Structure in Claude Logs"
description: "Auto-generated schema for type=user log entries: top-level fields, content structure, block types, and sample payloads."
tags:
  - logs
  - schema
  - claude
timestamp: "2026-06-15T14:10:06+04:00"
---

# User Message Structure in Claude Logs

> **Auto-generated** from live database on 2026-06-15.
> Based on 2222 log sessions, 11550 user entries.

## 1. Top-level Entry Fields

**Entries analyzed:** 11550

#### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `type` | string | "user" |

#### Optional Fields

| Field | Type | Present in | Sample Values |
|-------|------|------------|---------------|
| `content` | string | 2000/11550 (17%) | "Step 0: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" |
| `cost` | number | 2000/11550 (17%) | 0.0001 |
| `cwd` | string | 9547/11550 (83%) | "C:\\work\\project", "C:\\work\\project\\server", "C:\\work\\project\\dist", "C:\\work\\project\\client", "C:\\work\\project\\hook" |
| `entrypoint` | string | 9256/11550 (80%) | "cli" |
| `gitBranch` | string | 9547/11550 (83%) | "dev", "feature/log-view-initial", "feature/repo-analytics-v1", "feature/agents-nested", "fix/work-time-calc" |
| `interruptedMessageId` | string | 19/11550 (0%) | "msg_016U4QVwofXGdHCUnsXPV9Cj", "msg_01LN5dqdypYCZ2Ux9AxsVbwL", "msg_01SuPxysSMihQjo5LZzAphMF", "msg_01XH9ydG35ug4SAkVPuya6zM", "msg_016PjS27QYnVx1zB9XcUpMEs" |
| `isCompactSummary` | boolean | 11/11550 (0%) | true |
| `isMeta` | boolean | 347/11550 (3%) | true, false |
| `isSidechain` | boolean | 9550/11550 (83%) | false |
| `isVisibleInTranscriptOnly` | boolean | 11/11550 (0%) | true |
| `mcpMeta` | object | 4/11550 (0%) | see object samples below |
| `message` | object | 9550/11550 (83%) | see object samples below |
| `origin` | object | 14/11550 (0%) | see object samples below |
| `parentUuid` | null \| string | 9550/11550 (83%) | null, "1b61aff8-2f95-46ac-ba4f-02262cfed56f", "a45b8c98-05ae-4209-9828-d7c49cbb1b74", "554483cb-3d12-425a-b901-6776633d2d0e", "083a0bf5-1c4f-4917-84f1-f8cf07c6fe23" |
| `permissionMode` | string | 498/11550 (4%) | "bypassPermissions", "plan", "default", "acceptEdits" |
| `promptId` | string | 9547/11550 (83%) | "78dc42bf-5003-41f1-980a-ccd0caae3620", "b681382d-920c-48c2-8476-33422a82fa7d", "f091011d-0451-43dc-a939-37f818e7a33b", "ae60f152-7233-4914-8c42-9fb53b59e445", "457ce1bf-5e56-47cf-b541-a4a13b992136" |
| `promptSource` | string | 117/11550 (1%) | "typed", "system" |
| `sessionId` | string | 9550/11550 (83%) | "9a5e99bc-ba24-412e-9f80-67d73451ff97", "f6497ddf-faab-4f5d-84a5-189b8ede90da", "fae63feb-1ae7-47ad-af79-81636ae71af7", "6a1cf771-ae11-44aa-b682-d7c5d733358f", "a40eeb7e-c4af-4e49-96ef-ce1dd0869993" |
| `slug` | string | 1129/11550 (10%) | "open-http-localhost-5173-repos-1-session-silly-zebra", "wise-knitting-cocke", "precious-inventing-wall", "splendid-finding-fountain", "fizzy-whistling-mitten" |
| `sourceToolAssistantUUID` | string | 8410/11550 (73%) | "554483cb-3d12-425a-b901-6776633d2d0e", "29330d4f-df56-4de3-b19d-7acd9316ec54", "6a2f246b-3c83-4ee2-90dd-04d24c903961", "ac08a1f6-fe69-4a67-9777-518c420f6c54", "35901561-3cc5-47b2-9d06-ba3855061512" |
| `sourceToolUseID` | string | 129/11550 (1%) | "toolu_01HLARhcsA1uA95V8FzvvXib", "toolu_01FyHYszpsCEAq7CeDQRwK8S", "toolu_011qnqNB5RuXZieCToJEak1v", "toolu_01XFdd8QepQAquCpeckmrFq1", "toolu_01CtYfZBRX5oeqt7ZSf8qPZA" |
| `timestamp` | string | 11548/11550 (100%) | "2026-06-05T10:01:27.066Z", "2026-06-05T10:01:27.064Z", "2026-06-05T10:01:28.925Z", "2026-06-05T10:01:32.667Z", "2026-06-05T10:01:36.184Z" |
| `tokens` | number | 2000/11550 (17%) | 40 |
| `toolUseResult` | object \| string \| array | 8410/11550 (73%) | see object samples below |
| `userType` | string | 9547/11550 (83%) | "external" |
| `uuid` | string | 9550/11550 (83%) | "1b61aff8-2f95-46ac-ba4f-02262cfed56f", "43892274-7c29-4490-a624-3fd58a07675a", "b87d758d-b08b-4e4f-8eaa-7f12e58a70d2", "083a0bf5-1c4f-4917-84f1-f8cf07c6fe23", "60c88f00-d311-4b08-97ad-83956666b0c4" |
| `version` | string | 9547/11550 (83%) | "2.1.160", "2.1.76", "2.1.84", "2.1.175" |

##### `mcpMeta` object samples

**Sample 1:**
```json
{
  "_meta": "{object}"
}
```

##### `message` object samples

**Sample 1:**
```json
{
  "role": "\"user\"",
  "content": "\"<local-command-caveat>Caveat: The messa…"
}
```

##### `origin` object samples

**Sample 1:**
```json
{
  "kind": "\"task-notification\""
}
```

##### `toolUseResult` object samples

**Sample 1:**
```json
{
  "success": "true",
  "commandName": "\"requirement-fixer\""
}
```

**Sample 2:**
```json
{
  "file": "{object}",
  "type": "\"text\""
}
```

**Sample 3:**
```json
{
  "numFiles": "5",
  "filenames": "[array]",
  "truncated": "false",
  "durationMs": "238"
}
```

**Sample 4:**
```json
{
  "usage": "{object}",
  "prompt": "\"Read the requirements file at C:\\\\work\\\\project…",
  "status": "\"completed\"",
  "agentId": "\"a03933bf7e09e2bde\"",
  "content": "[array]",
  "agentType": "\"general-purpose\"",
  "toolStats": "{object}",
  "totalTokens": "19265",
  "totalDurationMs": "54839",
  "totalToolUseCount": "3"
}
```

**Sample 5:**
```json
{
  "type": "\"update\"",
  "content": "\"# Requirements: Optimize Slow API Endpo…",
  "filePath": "\"C:\\\\work\\\\project…",
  "originalFile": "\"read performance run results from docs/p…",
  "userModified": "false",
  "structuredPatch": "[array]"
}
```

---

## 2. `message` Object Fields

**Entries analyzed:** 9550

#### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `content` | string \| array | "<local-command-caveat>Caveat: The messages below were generated by the user whi…; "<command-name>/clear</command-name>\n            <command-message>clear</comman…; "refine requirements in docs/requirements/req-optimize-api-endpoints.md"; "something was in logging hook .claude/telemetry_tool/hook-log.js\nit should sav…; "<command-name>/model</command-name>\n            <command-message>model</comman… |
| `role` | string | "user" |

---

## 3. `message.content[]` Block Types

- Entries with string content: 970
- Entries with array content: 8580

### String content (plain text)

**Count:** 970

**Samples:**
- `<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond`
- `<command-name>/clear</command-name>
            <command-message>clear</command-message>
            <command-args></com`
- `refine requirements in docs/requirements/req-optimize-api-endpoints.md`

- [`tool_result`](#block-type-tool_result) — 8411 blocks
- [`text`](#block-type-text) — 179 blocks

---

### Block type: `tool_result`

**Blocks analyzed:** 8411

#### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `content` | string \| array | "Launching skill: requirement-fixer"; "1\t# Requirements: Optimize Slow API Endpoints\n2\t\n3\t## Overview\n4\t\n5\tPe…; "doc\\knowledgebase\\db_structure.md\ndoc\\knowledgebase\\api.md\ndoc\\knowledge…; "1\t# API Specification\n2\t\n3\tBase URL: `/api/v1`\n4\t\n5\t## Shared types\n6…; "1\t# Database Structure\n2\t\n3\t## Entity-Relationship Diagram\n4\t\n5\t```\n6… |
| `tool_use_id` | string | "toolu_01HLARhcsA1uA95V8FzvvXib", "toolu_01RAmLiVAeQYzkLCapDo72Zx", "toolu_017YD9PuZfTXvan6FbJsrMFE", "toolu_01WS29Wh6S3J4v2L1kob1Q3Z", "toolu_01ACZ8mCDD7maEbsN84FBwci" |
| `type` | string | "tool_result" |

#### Optional Fields

| Field | Type | Present in | Sample Values |
|-------|------|------------|---------------|
| `is_error` | boolean | 1741/8411 (21%) | false, true |

---

### Block type: `text`

**Blocks analyzed:** 179

#### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `text` | string | "Base directory for this skill: C:\\work\\project…, "[Request interrupted by user for tool use]", "[Request interrupted by user]", "look at Analytics for git repository in client\nI want to add one more display …, "[@send-logs-hook.js](file:///C:/work/project… |
| `type` | string | "text" |

---

*Generated by `tmp/analyze-user-messages.js`*
