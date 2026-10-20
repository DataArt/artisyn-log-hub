---
type: "Log Schema Reference"
title: "Attachment Types in Claude Logs"
description: "Auto-generated reference for all 20 attachment.type sub-types: field schemas, sample values, and UI display strategies."
tags:
  - logs
  - schema
  - claude
timestamp: "2026-06-15T14:10:06+04:00"
---

# Attachment Types in Claude Logs

> **Auto-generated** from live database on 2026-06-15.
> Based on 2219 log sessions, 2435 attachment entries.

## Overview

Each `type=attachment` log entry has an `attachment` object with a `type` sub-field.
The `attachment.type` determines the shape of the attachment.

All top-level keys seen across all attachment types:

`addedLines`, `addedNames`, `addedTypes`, `allowedTools`, `command`, `commandMode`, `content`, `displayPath`, `durationMs`, `exitCode`, `filename`, `files`, `hookEvent`, `hookName`, `ideName`, `isInitial`, `isNew`, `isSubAgent`, `itemCount`, `lineEnd`, `lineStart`, `names`, `newDate`, `path`, `pendingMcpServers`, `planExists`, `planFilePath`, `prompt`, `readdedNames`, `reminderType`, `removedNames`, `removedTypes`, `showConcurrencyNote`, `skillCount`, `skillDir`, `skillNames`, `skills`, `snippet`, `stderr`, `stdout`, `toolUseID`, `type`

## Attachment Types

- [`agent_listing_delta`](#attachment-type-agent_listing_delta) — 213 entries
- [`auto_mode`](#attachment-type-auto_mode) — 1 entries
- [`command_permissions`](#attachment-type-command_permissions) — 129 entries
- [`compact_file_reference`](#attachment-type-compact_file_reference) — 21 entries
- [`date_change`](#attachment-type-date_change) — 8 entries
- [`deferred_tools_delta`](#attachment-type-deferred_tools_delta) — 214 entries
- [`diagnostics`](#attachment-type-diagnostics) — 149 entries
- [`dynamic_skill`](#attachment-type-dynamic_skill) — 12 entries
- [`edited_text_file`](#attachment-type-edited_text_file) — 109 entries
- [`file`](#attachment-type-file) — 29 entries
- [`hook_success`](#attachment-type-hook_success) — 19 entries
- [`invoked_skills`](#attachment-type-invoked_skills) — 9 entries
- [`nested_memory`](#attachment-type-nested_memory) — 160 entries
- [`opened_file_in_ide`](#attachment-type-opened_file_in_ide) — 125 entries
- [`plan_mode`](#attachment-type-plan_mode) — 1 entries
- [`plan_mode_exit`](#attachment-type-plan_mode_exit) — 1 entries
- [`queued_command`](#attachment-type-queued_command) — 5 entries
- [`selected_lines_in_ide`](#attachment-type-selected_lines_in_ide) — 15 entries
- [`skill_listing`](#attachment-type-skill_listing) — 200 entries
- [`task_reminder`](#attachment-type-task_reminder) — 1015 entries

---

## Attachment type: `agent_listing_delta`

**Entries analyzed:** 213

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `addedLines` | array | ["- claude: Catch-all for any task that doesn't fit a more specific agent. FleetView's default when no agent name is typ…, ["- implement: Implement a plan file chunk-by-chunk using sequential subagents. ALWAYS invoke when the user says 'implem… |
| `addedTypes` | array | ["claude","claude-code-guide","Explore","general-purpose","implementation-plan-sonnet","Plan","statusline-setup"], ["claude","claude-code-guide","Explore","general-purpose","Plan","statusline-setup"], ["claude","claude-code-guide","Explore","general-purpose","implement","implementation-plan-sonnet","Plan","statusline-se… |
| `isInitial` | boolean | true, false |
| `removedTypes` | array | [] |
| `showConcurrencyNote` | boolean | true |
| `type` | string | "agent_listing_delta" |

---

## Attachment type: `auto_mode`

**Entries analyzed:** 1

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `type` | string | "auto_mode" |

---

## Attachment type: `command_permissions`

**Entries analyzed:** 129

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `allowedTools` | array | [], ["Read"], ["Read","Grep","Glob","WebFetch"] |
| `type` | string | "command_permissions" |

---

## Attachment type: `compact_file_reference`

**Entries analyzed:** 21

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `displayPath` | string | "src\\logs\\repositories.controller.ts", "server\\src\\logs\\repositories.controller.ts", "client\\src\\viewer\\pages\\repository\\analytics\\RepositoryAnalytics.tsx", "..\\client\\src\\viewer\\pages\\repository\\RepositorySettings.tsx", "..\\client\\src\\viewer\\pages\\repository\\RepositoryView.tsx" |
| `filename` | string | "C:\\work\\project\\server\\src\\logs\\…, "C:\\work\\project\\client\\src\\viewer… |
| `type` | string | "compact_file_reference" |

---

## Attachment type: `date_change`

**Entries analyzed:** 8

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `newDate` | string | "2026-06-06", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-15" |
| `type` | string | "date_change" |

---

## Attachment type: `deferred_tools_delta`

**Entries analyzed:** 214

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `addedLines` | array | ["CronCreate","CronDelete","CronList","EnterPlanMode","EnterWorktree","ExitPlanMode","ExitWorktree","LSP","ListMcpResour…, ["CronCreate","CronDelete","CronList","DesignSync","EnterPlanMode","EnterWorktree","ExitPlanMode","ExitWorktree","LSP","…, [] |
| `addedNames` | array | ["CronCreate","CronDelete","CronList","EnterPlanMode","EnterWorktree","ExitPlanMode","ExitWorktree","LSP","ListMcpResour…, ["CronCreate","CronDelete","CronList","DesignSync","EnterPlanMode","EnterWorktree","ExitPlanMode","ExitWorktree","LSP","…, [] |
| `readdedNames` | array | [] |
| `removedNames` | array | [], ["mcp__claude_ai_Artisyn_Transform__authenticate","mcp__claude_ai_Artisyn_Transform__complete_authentication","mcp__clau… |
| `type` | string | "deferred_tools_delta" |

### Optional Fields

| Field | Type | Present in | Sample Values |
|-------|------|------------|---------------|
| `pendingMcpServers` | array | 204/214 (95%) | [], ["postgres"] |

---

## Attachment type: `diagnostics`

**Entries analyzed:** 149

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `files` | array | [{"uri":"file://C:/work/project/docs/requirements/req-optimize-api-endpoints.md","…, [{"uri":"file://C:/work/project/docs/implementation/plan-optimize-api-endpoints.md…, [{"uri":"file://C:/work/project/docs/requirements/req-session-log.md","diagnostics… |
| `isNew` | boolean | true |
| `type` | string | "diagnostics" |

---

## Attachment type: `dynamic_skill`

**Entries analyzed:** 12

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `displayPath` | string | "hook\\.claude\\skills" |
| `skillDir` | string | "C:\\work\\project\\hook\\.claude\\skil… |
| `skillNames` | array | ["nodejs-script"], ["nodejs-script","task-tracker"] |
| `type` | string | "dynamic_skill" |

---

## Attachment type: `edited_text_file`

**Entries analyzed:** 109

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `filename` | string | "C:\\work\\project\\doc\\requirements\\…, "C:\\work\\project\\server\\src\\common…, "C:\\work\\project\\client\\src\\viewer…, "C:\\work\\project\\server\\src\\databa…, "C:\\work\\project\\client\\CLAUDE.md" |
| `snippet` | string | "1\t# Requirements: Optimize Slow API Endpoints\n2\t\n3\t## Overview\n4\t\n5\tPe…, "1\timport { LoggerService } from '@nestjs/common';\n2\timport { createLogger, f…, "1\timport type {\n2\t  AssistantEvent,\n3\t  ClaudeMdContext,\n4\t  FileAccess,…, "26\t        const pool = new Pool({\n27\t          connectionString: process.en…, "55\t  sql: string,\n56\t  durationMs: number,\n57\t  error?: unknown,\n58\t): v… |
| `type` | string | "edited_text_file" |

---

## Attachment type: `file`

**Entries analyzed:** 29

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `content` | object | see object samples below |
| `displayPath` | string | "drizzle\\migrations\\meta\\_journal.json", "drizzle\\migrations\\0011_subagent_stats_backfill.sql", "src\\logs\\logs.service.ts", "..\\.claude\\rules\\server.md", "server\\drizzle\\migrations\\meta\\_journal.json" |
| `filename` | string | "C:\\work\\project\\server\\drizzle\\mi…, "C:\\work\\project\\server\\src\\logs\\…, "C:\\work\\project\\.claude\\rules\\ser…, "C:\\work\\project\\.claude\\rules\\cli…, "C:\\work\\project\\client\\src\\viewer… |
| `type` | string | "file" |

#### `content` object samples

**Sample 1:**
```json
{
  "file": "{object}",
  "type": "\"text\""
}
```

---

## Attachment type: `hook_success`

**Entries analyzed:** 19

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `command` | string | "Uploading logs..." |
| `content` | string | "" |
| `durationMs` | number | 397, 319, 440, 314, 577 |
| `exitCode` | number | 0 |
| `hookEvent` | string | "Stop" |
| `hookName` | string | "Stop" |
| `stderr` | string | "send-logs-hook: upload failed for artisyn/9a5e99bc-ba24-412e-9f80-67d73451ff97:…, "send-logs-hook: upload failed for artisyn/f6497ddf-faab-4f5d-84a5-189b8ede90da:…, "send-logs-hook: network error for artisyn/09f29a59-6894-41af-ad0f-c1b0c6a95ae6:…, "send-logs-hook: network error for artisyn/29c65f85-ea22-4013-be3c-62394bc5a95b:…, "send-logs-hook: network error for artisyn/e691fc5c-1033-4e9e-a76b-ea9013802bb2:… |
| `stdout` | string | "" |
| `toolUseID` | string | "d2291489-ecf2-45b4-aa42-7e8a29492091", "7850b701-6d41-402e-a5d4-8990f9ef812e", "0081ea3c-1095-4b03-9483-35d555211822", "2c8b3b79-2022-48d1-87ed-43bfc449a68b", "58d09afe-afc2-454d-ac98-b113ab8c418b" |
| `type` | string | "hook_success" |

---

## Attachment type: `invoked_skills`

**Entries analyzed:** 9

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `skills` | array | [{"name":"use-playwright","path":"projectSettings:use-playwright","content":"Base directory for this skill: C:\\work\\project… |
| `type` | string | "invoked_skills" |

---

## Attachment type: `nested_memory`

**Entries analyzed:** 160

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `content` | object | see object samples below |
| `displayPath` | string | "server\\CLAUDE.md", "client\\CLAUDE.md", "..\\server\\CLAUDE.md", "hook\\CLAUDE.md", "..\\hook\\CLAUDE.md" |
| `path` | string | "C:\\work\\project\\server\\CLAUDE.md", "C:\\work\\project\\client\\CLAUDE.md", "C:\\work\\project\\hook\\CLAUDE.md", "C:\\work\\project\\.claude\\rules\\ser…, "C:\\work\\project\\.claude\\rules\\cli… |
| `type` | string | "nested_memory" |

#### `content` object samples

**Sample 1:**
```json
{
  "path": "\"C:\\\\work\\\\project…",
  "type": "\"Project\"",
  "content": "\"This is NestJS application.\\r\\n\\r\\n\\r\\n…",
  "contentDiffersFromDisk": "false"
}
```

**Sample 2:**
```json
{
  "path": "\"C:\\\\work\\\\project…",
  "type": "\"Project\"",
  "globs": "[array]",
  "content": "\"This is a NestJS application.\\r\\n\\r\\n# …",
  "rawContent": "\"---\\r\\npaths:\\r\\n  - \\\"server/**\\\"\\r\\n-…",
  "contentDiffersFromDisk": "true"
}
```

**Sample 3:**
```json
{
  "type": "\"Project\"",
  "content": "\"This is a NestJS application test rule …",
  "contentDiffersFromDisk": "false"
}
```

---

## Attachment type: `opened_file_in_ide`

**Entries analyzed:** 125

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `filename` | string | "/home/user/project/.claude/settings.jso…, "/home/user/project/docs/implementation/p…, "/home/user/project/server/logs/.d37bbde…, "/home/user/project/Claude.md", "/home/user/project/package.json" |
| `type` | string | "opened_file_in_ide" |

---

## Attachment type: `plan_mode`

**Entries analyzed:** 1

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `isSubAgent` | boolean | false |
| `planExists` | boolean | false |
| `planFilePath` | string | "C:\\Users\\alice\\.claude\\plans\\open-http-localhost-5173-repos-1-session-silly-… |
| `reminderType` | string | "full" |
| `type` | string | "plan_mode" |

---

## Attachment type: `plan_mode_exit`

**Entries analyzed:** 1

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `planExists` | boolean | true |
| `planFilePath` | string | "C:\\Users\\alice\\.claude\\plans\\open-http-localhost-5173-repos-1-session-silly-… |
| `type` | string | "plan_mode_exit" |

---

## Attachment type: `queued_command`

**Entries analyzed:** 5

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `commandMode` | string | "prompt", "task-notification" |
| `prompt` | string | "where is controller that return logs", "<task-notification>\n<task-id>bk7osmflx</task-id>\n<tool-use-id>toolu_01Ez3jTGb…, "<task-notification>\n<task-id>boo8p0nkg</task-id>\n<tool-use-id>toolu_01AKtKwz6…, "<task-notification>\n<task-id>buqfq9bs6</task-id>\n<tool-use-id>toolu_01HrNA6rM…, "make default view for  tools, code, docs view - collapsed" |
| `type` | string | "queued_command" |

---

## Attachment type: `selected_lines_in_ide`

**Entries analyzed:** 15

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `content` | string | "update server configs. save server logs,\nuse roling logs, cut each hour. \nupd…, "check-fix-build", "DRIZZLE", "start:dev", "### Extracted columns on `logs`" |
| `displayPath` | string | "..\\..\\..\\..\\..\\home\\user\\project…, "..\\..\\..\\..\\home\\user\\project\… |
| `filename` | string | "/home/user/project/docs/requirements/req…, "/home/user/project/.claude/skills/check…, "/home/user/project/server/src/logs/repo…, "/home/user/project/server/package.json", "/home/user/project/.claude/telemetry_to… |
| `ideName` | string | "WebStorm" |
| `lineEnd` | number | 2, 1, 27, 12, 71 |
| `lineStart` | number | 0, 1, 27, 12, 71 |
| `type` | string | "selected_lines_in_ide" |

---

## Attachment type: `skill_listing`

**Entries analyzed:** 200

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `content` | string | "- architect-assistant: Run an architectural assistant. Use this skill only when…, "- task-tracker: ALWAYS use this skill once user ask to do something with issues…, "- task-tracker: ALWAYS use this skill when the user asks to do something with i… |
| `isInitial` | boolean | true, false |
| `names` | array | ["architect-assistant","archive-requirements","implement","implementation-plan","nodejs-script","requirement-fixer","ser…, ["architect-assistant","archive-requirements","check-fix-build","implement","implementation-plan","nodejs-script","requi…, ["architect-assistant","archive-requirements","check-fix-build","implementation-plan","nodejs-script","requirement-fixer… |
| `skillCount` | number | 23, 24, 25, 1, 26 |
| `type` | string | "skill_listing" |

---

## Attachment type: `task_reminder`

**Entries analyzed:** 1015

### Mandatory Fields

| Field | Type | Sample Values |
|-------|------|---------------|
| `content` | array | [], [{"id":"1","blocks":[],"status":"in_progress","subject":"Fix session cost discrepancy: header shows ~$21 (main only) vs … |
| `itemCount` | number | 0, 1 |
| `type` | string | "task_reminder" |

---

## Suggested Display Strategy

Based on the field analysis, here is how each attachment type can be rendered in a structured way instead of a raw JSON dump:

### `agent_listing_delta`

| Field | Suggested Rendering |
|-------|---------------------|
| `addedLines` | Collapsible list or badge count |
| `addedTypes` | Collapsible list or badge count |
| `isInitial` | Badge (green/gray) or ✓/✗ icon |
| `removedTypes` | Collapsible list or badge count |
| `showConcurrencyNote` | Badge (green/gray) or ✓/✗ icon |

### `auto_mode`

| Field | Suggested Rendering |
|-------|---------------------|

### `command_permissions`

| Field | Suggested Rendering |
|-------|---------------------|
| `allowedTools` | Collapsible list or badge count |

### `compact_file_reference`

| Field | Suggested Rendering |
|-------|---------------------|
| `displayPath` | Monospace path label, truncate long paths from the left |
| `filename` | Monospace label row |

### `date_change`

| Field | Suggested Rendering |
|-------|---------------------|
| `newDate` | Monospace label row |

### `deferred_tools_delta`

| Field | Suggested Rendering |
|-------|---------------------|
| `addedLines` | Collapsible list or badge count |
| `addedNames` | Collapsible list or badge count |
| `pendingMcpServers` | Collapsible list or badge count |
| `readdedNames` | Collapsible list or badge count |
| `removedNames` | Collapsible list or badge count |

### `diagnostics`

| Field | Suggested Rendering |
|-------|---------------------|
| `files` | Collapsible list or badge count |
| `isNew` | Badge (green/gray) or ✓/✗ icon |

### `dynamic_skill`

| Field | Suggested Rendering |
|-------|---------------------|
| `displayPath` | Monospace path label, truncate long paths from the left |
| `skillDir` | Monospace label row |
| `skillNames` | Collapsible list or badge count |

### `edited_text_file`

| Field | Suggested Rendering |
|-------|---------------------|
| `filename` | Monospace label row |
| `snippet` | Monospace label row |

### `file`

| Field | Suggested Rendering |
|-------|---------------------|
| `content` | Scrollable pre block (max-height), with syntax hint if language known |
| `displayPath` | Monospace path label, truncate long paths from the left |
| `filename` | Monospace label row |

### `hook_success`

| Field | Suggested Rendering |
|-------|---------------------|
| `command` | Monospace label row |
| `content` | Scrollable pre block (max-height), with syntax hint if language known |
| `durationMs` | Plain number, right-aligned; format large numbers with commas |
| `exitCode` | Plain number, right-aligned; format large numbers with commas |
| `hookEvent` | Monospace label row |
| `hookName` | Monospace label row |
| `stderr` | Monospace label row |
| `stdout` | Monospace label row |
| `toolUseID` | Monospace label row |

### `invoked_skills`

| Field | Suggested Rendering |
|-------|---------------------|
| `skills` | Collapsible list or badge count |

### `nested_memory`

| Field | Suggested Rendering |
|-------|---------------------|
| `content` | Scrollable pre block (max-height), with syntax hint if language known |
| `displayPath` | Monospace path label, truncate long paths from the left |
| `path` | Monospace path label, truncate long paths from the left |

### `opened_file_in_ide`

| Field | Suggested Rendering |
|-------|---------------------|
| `filename` | Monospace label row |

### `plan_mode`

| Field | Suggested Rendering |
|-------|---------------------|
| `isSubAgent` | Badge (green/gray) or ✓/✗ icon |
| `planExists` | Badge (green/gray) or ✓/✗ icon |
| `planFilePath` | Monospace path label, truncate long paths from the left |
| `reminderType` | Monospace label row |

### `plan_mode_exit`

| Field | Suggested Rendering |
|-------|---------------------|
| `planExists` | Badge (green/gray) or ✓/✗ icon |
| `planFilePath` | Monospace path label, truncate long paths from the left |

### `queued_command`

| Field | Suggested Rendering |
|-------|---------------------|
| `commandMode` | Monospace label row |
| `prompt` | Monospace label row |

### `selected_lines_in_ide`

| Field | Suggested Rendering |
|-------|---------------------|
| `content` | Scrollable pre block (max-height), with syntax hint if language known |
| `displayPath` | Monospace path label, truncate long paths from the left |
| `filename` | Monospace label row |
| `ideName` | Monospace label row |
| `lineEnd` | Plain number, right-aligned; format large numbers with commas |
| `lineStart` | Plain number, right-aligned; format large numbers with commas |

### `skill_listing`

| Field | Suggested Rendering |
|-------|---------------------|
| `content` | Scrollable pre block (max-height), with syntax hint if language known |
| `isInitial` | Badge (green/gray) or ✓/✗ icon |
| `names` | Collapsible list or badge count |
| `skillCount` | Plain number, right-aligned; format large numbers with commas |

### `task_reminder`

| Field | Suggested Rendering |
|-------|---------------------|
| `content` | Scrollable pre block (max-height), with syntax hint if language known |
| `itemCount` | Plain number, right-aligned; format large numbers with commas |

---

*Generated by `tmp/analyze-attachment-types.js`*
