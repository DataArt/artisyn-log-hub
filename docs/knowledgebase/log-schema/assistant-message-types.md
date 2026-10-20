---
type: "Log Schema Reference"
title: "Assistant Message Structure in Claude Logs"
description: "Auto-generated reference for type=assistant log entries: fields, message structure, usage breakdown, content blocks, and rendering strategies."
tags:
  - logs
  - schema
  - claude
timestamp: "2026-06-15T14:10:06+04:00"
---

# Assistant Message Structure in Claude Logs

> **Auto-generated** from live database on 2026-06-15.
> Based on 2221 log sessions, 17430 assistant entries.

## 1. Top-level Entry Fields

**Entries analyzed:** 17430

#### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `type` | string | "assistant" |

#### Optional Fields

| Field | Type | Present in | Sample Values |
|-------|------|------------|---------------|
| `apiErrorStatus` | number | 1/17430 (0%) | 429 |
| `attributionMcpServer` | string | 6138/17430 (35%) | "postgres", "playwright", "ide" |
| `attributionMcpTool` | string | 6138/17430 (35%) | "query", "browser_navigate", "browser_snapshot", "browser_click", "browser_fill_form" |
| `attributionSkill` | string | 6044/17430 (35%) | "requirement-fixer", "implementation-plan", "implement", "use-playwright", "check-fix-build" |
| `content` | string | 2000/17430 (11%) | "Step 3: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" |
| `cost` | number | 2000/17430 (11%) | 0.0004 |
| `cwd` | string | 15429/17430 (89%) | "C:\\work\\project", "C:\\work\\project\\server", "C:\\work\\project\\dist", "C:\\work\\project\\client", "C:\\work\\project\\hook" |
| `entrypoint` | string | 15069/17430 (86%) | "cli" |
| `error` | string | 2/17430 (0%) | "invalid_request", "rate_limit" |
| `errorDetails` | string | 1/17430 (0%) | "400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message… |
| `gitBranch` | string | 15429/17430 (89%) | "dev", "feature/log-view-initial", "feature/repo-analytics-v1", "feature/agents-nested", "fix/work-time-calc" |
| `isApiErrorMessage` | boolean | 2/17430 (0%) | true |
| `isSidechain` | boolean | 15429/17430 (89%) | false |
| `message` | object | 15430/17430 (89%) | see object samples below |
| `parentUuid` | string | 15430/17430 (89%) | "232e9cc2-83d4-4028-88aa-78ca4fc55000", "6afe7be0-a9ec-4c9f-8196-e8c3727e3aca", "beb4a8ff-f232-4544-8c50-1d9640e5af3f", "a7a581ce-2d6d-4272-8ae3-ea6b457a96b1", "c0f8de60-9fd9-4aa7-87a1-116915bd9c85" |
| `requestId` | string | 15427/17430 (89%) | "req_011CbjvJNkFNGAXd46YpctFn", "req_011CbjvJewpmfibDbRbRwQhe", "req_011CbjvJy1Wh3A3e6R7MM3Qz", "req_011CbjvPsvK7hSEtE1vrV23o", "req_011CbjvQKjLp3HqUQNnfxg5A" |
| `sessionId` | string | 15430/17430 (89%) | "9a5e99bc-ba24-412e-9f80-67d73451ff97", "f6497ddf-faab-4f5d-84a5-189b8ede90da", "fae63feb-1ae7-47ad-af79-81636ae71af7", "6a1cf771-ae11-44aa-b682-d7c5d733358f", "a40eeb7e-c4af-4e49-96ef-ce1dd0869993" |
| `slug` | string | 1798/17430 (10%) | "open-http-localhost-5173-repos-1-session-silly-zebra", "wise-knitting-cocke", "precious-inventing-wall", "splendid-finding-fountain", "fizzy-whistling-mitten" |
| `timestamp` | string | 17429/17430 (100%) | "2026-06-05T10:01:31.968Z", "2026-06-05T10:01:32.325Z", "2026-06-05T10:01:34.985Z", "2026-06-05T10:01:35.496Z", "2026-06-05T10:01:36.027Z" |
| `tokens` | number | 2000/17430 (11%) | 49 |
| `userType` | string | 15429/17430 (89%) | "external" |
| `uuid` | string | 15430/17430 (89%) | "6afe7be0-a9ec-4c9f-8196-e8c3727e3aca", "554483cb-3d12-425a-b901-6776633d2d0e", "a7a581ce-2d6d-4272-8ae3-ea6b457a96b1", "c0f8de60-9fd9-4aa7-87a1-116915bd9c85", "29330d4f-df56-4de3-b19d-7acd9316ec54" |
| `version` | string | 15429/17430 (89%) | "2.1.160", "2.1.76", "2.1.84", "2.1.175" |

##### `message` object samples

**Sample 1:**
```json
{
  "id": "\"msg_01XseEPpAbJzCCrBfx8fuCNK\"",
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
  "id": "\"ed03918b-6c85-4aa0-b439-2ebe64de4fa9\"",
  "role": "\"assistant\"",
  "type": "\"message\"",
  "model": "\"<synthetic>\"",
  "usage": "{object}",
  "content": "[array]",
  "container": "null",
  "stop_reason": "\"stop_sequence\"",
  "stop_details": "null",
  "stop_sequence": "\"\"",
  "context_management": "null"
}
```

**Sample 3:**
```json
{
  "id": "\"msg_01LqrhKXjvmoKgckBiWp53fx\"",
  "role": "\"assistant\"",
  "type": "\"message\"",
  "model": "\"claude-sonnet-4-6\"",
  "usage": "{object}",
  "content": "[array]",
  "stop_reason": "null",
  "stop_details": "null",
  "stop_sequence": "null"
}
```

**Sample 4:**
```json
{
  "role": "\"assistant\"",
  "model": "\"claude-sonnet-4-6\"",
  "usage": "{object}",
  "content": "[array]"
}
```

**Sample 5:**
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

## 2. `message` Object Fields

**Entries analyzed:** 15430

#### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `content` | array | [{"type":"thinking","thinking":"","signature":"EoUDCmUIDhgCK…; [{"id":"toolu_01HLARhcsA1uA95V8FzvvXib","name":"Skill","type":"tool_use","input":{"args":"docs/requirements/req-optimize-…; [{"type":"thinking","thinking":"","signature":"EqgCCmUIDhgCK… |
| `model` | string | "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "<synthetic>" |
| `role` | string | "assistant" |
| `usage` | object | see object samples below |

#### Optional Fields

| Field | Type | Present in | Sample Values |
|-------|------|------------|---------------|
| `container` | null | 2/15430 (0%) | null |
| `context_management` | null | 2/15430 (0%) | null |
| `diagnostics` | null \| object | 14836/15430 (96%) | see object samples below |
| `id` | string | 15428/15430 (100%) | "msg_01XseEPpAbJzCCrBfx8fuCNK", "msg_012SovZZiN6z9nTiUqkodLLP", "msg_01SJb3fVoM4h2gcG3QvVcH5a", "msg_01N4qYMfQBeRLwCk39JC8ZVe", "msg_014kdJvpMkxVhA4oCN2sb3Jx" |
| `stop_details` | null | 15428/15430 (100%) | null |
| `stop_reason` | string \| null | 15429/15430 (100%) | "tool_use", "end_turn", "stop_sequence", null |
| `stop_sequence` | null \| string | 15428/15430 (100%) | null, "" |
| `type` | string | 15428/15430 (100%) | "message" |

##### `usage` object samples

**Sample 1:**
```json
{
  "speed": "\"standard\"",
  "iterations": "[array]",
  "input_tokens": "3",
  "service_tier": "\"standard\"",
  "inference_geo": "\"not_available\"",
  "output_tokens": "145",
  "cache_creation": "{object}",
  "server_tool_use": "{object}",
  "cache_read_input_tokens": "15552",
  "cache_creation_input_tokens": "8251"
}
```

**Sample 2:**
```json
{
  "input_tokens": "3",
  "service_tier": "\"standard\"",
  "inference_geo": "\"global\"",
  "output_tokens": "1",
  "cache_creation": "{object}",
  "cache_read_input_tokens": "0",
  "cache_creation_input_tokens": "29855"
}
```

**Sample 3:**
```json
{
  "input_tokens": "100",
  "output_tokens": "50",
  "cache_read_input_tokens": "0",
  "cache_creation_input_tokens": "0"
}
```

##### `diagnostics` object samples

**Sample 1:**
```json
{
  "cache_miss_reason": "{object}"
}
```

### `stop_reason` distribution

| Value | Count |
|-------|-------|
| `tool_use` | 14584 |
| `end_turn` | 592 |
| `stop_sequence` | 2 |

### `model` distribution

| Model | Count |
|-------|-------|
| `claude-sonnet-4-6` | 14875 |
| `claude-haiku-4-5-20251001` | 553 |
| `<synthetic>` | 2 |

---

## 3. `message.usage` Fields

**Entries analyzed:** 15430

#### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `cache_creation_input_tokens` | number | 8251, 1114, 2646, 729, 7151 |
| `cache_read_input_tokens` | number | 15552, 23803, 24917, 27563, 28292 |
| `input_tokens` | number | 3, 2, 1, 10, 8 |
| `output_tokens` | number | 145, 221, 252, 260, 1558 |

#### Optional Fields

| Field | Type | Present in | Sample Values |
|-------|------|------------|---------------|
| `cache_creation` | object | 15428/15430 (100%) | see object samples below |
| `inference_geo` | string \| null | 15428/15430 (100%) | "not_available", null, "global", "" |
| `iterations` | array \| null | 15177/15430 (98%) | [{"type":"message","input_tokens":3,"output_tokens":145,"cache_creation":{"ephemeral_1h_input_tokens":8251,"ephemeral_5m…; [{"type":"message","input_tokens":2,"output_tokens":221,"cache_creation":{"ephemeral_1h_input_tokens":1114,"ephemeral_5m…; [{"type":"message","input_tokens":1,"output_tokens":252,"cache_creation":{"ephemeral_1h_input_tokens":2646,"ephemeral_5m…; null |
| `server_tool_use` | object | 15177/15430 (98%) | see object samples below |
| `service_tier` | string \| null | 15428/15430 (100%) | "standard", null |
| `speed` | string \| null | 15177/15430 (98%) | "standard", null |

##### `cache_creation` object samples

**Sample 1:**
```json
{
  "ephemeral_1h_input_tokens": "8251",
  "ephemeral_5m_input_tokens": "0"
}
```

##### `server_tool_use` object samples

**Sample 1:**
```json
{
  "web_fetch_requests": "0",
  "web_search_requests": "0"
}
```

---

## 4. `message.content[]` Block Types

Each assistant `message.content` is an array of typed blocks.

- [`text`](#block-type-text) — 3668 blocks
- [`thinking`](#block-type-thinking) — 3378 blocks
- [`tool_use`](#block-type-tool_use) — 8384 blocks

---

### Block type: `text`

**Blocks analyzed:** 3668

#### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `text` | string | "I'll read the requirements file and explore the codebase to understand the cont…, "The file has a Q&A section with answered questions. I'll first spawn the Q&A In…, "Q&A answers integrated. Now I'll read the updated file and the knowledgebase to…, "Now I'll spawn the Review subagent to check for remaining gaps and grammar issu…, "Let me verify the final state of the file." |
| `type` | string | "text" |

---

### Block type: `thinking`

**Blocks analyzed:** 3378

#### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `signature` | string | "EoUDCmUIDhgCK…, "EqgCCmUIDhgCK…, "Eq4dCmUIDhgCK…, "EsMCCmUIDhgCK…, "EoQDCmUIDhgCK… |
| `thinking` | string | "", "Let me start by reading the component map and understanding the current analyti…, "Let me read the SessionInfoTab.tsx and RepositoryAnalytics.tsx to understand th…, "Now let me understand the task:\n\nThe user wants to add a new \"display type\"…, "Now I understand the structure. The `TimelineSession` model doesn't currently h… |
| `type` | string | "thinking" |

---

### Block type: `tool_use`

**Blocks analyzed:** 8384

#### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `id` | string | "toolu_01HLARhcsA1uA95V8FzvvXib", "toolu_01RAmLiVAeQYzkLCapDo72Zx", "toolu_017YD9PuZfTXvan6FbJsrMFE", "toolu_01WS29Wh6S3J4v2L1kob1Q3Z", "toolu_01ACZ8mCDD7maEbsN84FBwci" |
| `input` | object | see object samples below |
| `name` | string | "Skill", "Read", "Glob", "Agent", "Write" |
| `type` | string | "tool_use" |

#### Optional Fields

| Field | Type | Present in | Sample Values |
|-------|------|------------|---------------|
| `caller` | object | 8383/8384 (100%) | see object samples below |

##### `input` object samples

**Sample 1:**
```json
{
  "args": "\"docs/requirements/req-optimize-api-endpo…",
  "skill": "\"requirement-fixer\""
}
```

**Sample 2:**
```json
{
  "file_path": "\"C:\\\\work\\\\project…"
}
```

**Sample 3:**
```json
{
  "path": "\"C:\\\\work\\\\project…",
  "pattern": "\"docs/knowledgebase/**/*\""
}
```

**Sample 4:**
```json
{
  "prompt": "\"Read the requirements file at C:\\\\work\\\\project…",
  "description": "\"Q&A Integration into requirements\""
}
```

**Sample 5:**
```json
{
  "prompt": "\"Search in C:\\\\work\\\\project…",
  "description": "\"Explore server code for slow endpoints\"",
  "subagent_type": "\"Explore\""
}
```

##### `caller` object samples

**Sample 1:**
```json
{
  "type": "\"direct\""
}
```

---

## 5. Suggested Display Strategy

How to render each content block type in a structured way:

### `text`

- `text` — render as Markdown or plain pre block. Detect if it contains tool-result XML or code fences and apply syntax highlighting.
- `thinking` — render in a collapsible "thinking" section with a brain icon, distinct background color.

### `thinking`

Suggested field rendering:

| Field | Suggested Rendering |
|-------|---------------------|
| `signature` | Monospace label |
| `thinking` | Monospace label |

### `tool_use`

- Header row: tool name badge + tool use ID (truncated).
- `input` object: render as a key-value table; for large values (file content, commands) use a scrollable pre block.

---

*Generated by `tmp/analyze-assistant-messages.js`*
