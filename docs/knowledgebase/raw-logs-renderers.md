---
type: "Architecture Guide"
title: "Raw Logs Renderer Subsystem"
description: "Architectural guide to the raw-logs/ subsystem: layers, dependency graph, and extension patterns."
tags:
  - client
  - logs
timestamp: "2026-07-20T17:04:19+04:00"
---

---
name: raw-logs-renderers
description: File-by-file guide to the raw-logs/ subsystem used by the Raw Logs tab: what each file exports and how they compose
metadata:
  type: project
---

# Raw Logs Renderer Subsystem

All files live under `client/src/viewer/pages/repository/session-log/raw-logs/`.

The subsystem renders the **Raw Logs tab** (`RawLogsTab.tsx`): a Kibana-style table where every log entry can be expanded to show structured field-level detail. It is split into eleven files that mostly follow a layering rule (higher layers import from lower ones) — with one exception: `assistant.tsx` and `assistant-sections.tsx` import from each other (`assistant-sections.tsx` needs `UsageFields`/`ContentBlocks` from `assistant.tsx`, which in turn imports the section components back from `assistant-sections.tsx`).

---

## File Map

### `primitives.tsx`
Lowest layer — pure UI atoms with no knowledge of log entry types.

| Export | Purpose |
|---|---|
| `LogField` | Label + monospace value row |
| `JsonBlock` | Pretty-printed JSON in a scrollable `<pre>` |
| `CopyButton` | Icon button that copies text to clipboard |
| `AdditionalFields` | Renders any entry keys not listed in `knownKeys` as a `JsonBlock` — used by every per-type renderer as a catch-all for future fields |
| `CommonFields` | Collapsible "tech info" section showing UUID, parentUuid, sessionId, version, entrypoint, userType, cwd, gitBranch, isSidechain, slug, requestId |
| `CollapsibleList` | Expandable list of items (skill names, tool names, etc.) |
| `COMMON_KEYS` | String array of top-level field names treated as "known" base fields: type, sessionId, uuid, parentUuid, timestamp, version, entrypoint, userType, cwd, gitBranch, isSidechain, slug, requestId. Passed to `AdditionalFields` by `assistant.tsx`, `attachment.tsx`, `user.tsx`, `system.tsx` to exclude them from the catch-all — **not** read by `CommonFields` itself, which independently renders 11 of these 13 fields (all except `type` and `timestamp`, shown elsewhere) via its own field checks |

### `assistant-sections.tsx`
Sub-sections extracted from `assistant.tsx` to keep file size manageable. Imported only by `assistant.tsx`.

| Export | Purpose |
|---|---|
| `AssistantErrorSection` | Error state block — shown when `entry.isApiErrorMessage` is truthy; renders apiErrorStatus, error, errorDetails |
| `AssistantCompactContent` | Compact entry fallback — no `message` object, just raw content + optional cost/tokens |
| `AssistantMessageSection` | Full message section — ID, model, stop_reason, stop_sequence, usage (`UsageFields`), content blocks (`ContentBlocks`) |

### `assistant.tsx`
Expanded view for `type=assistant` entries.

| Export | Purpose |
|---|---|
| `UsageFields` | Token usage breakdown: input, output, cache read/write, cache buckets (1h/5m), server tool use (web search/fetch), service tier, inference geo |
| `ToolUseBlock` | Collapsible tool call block: name, truncated ID, expandable `input` fields |
| `ThinkingBlock` | Collapsible thinking block with preview text |
| `ContentBlocks` | Maps content array → `ToolUseBlock` / `ThinkingBlock` / text `<pre>` / `JsonBlock` |
| `AssistantExpanded` | Top-level renderer: delegates error/compact/full-message rendering to `assistant-sections.tsx`, plus attribution (skill/MCP server/tool) |

### `attachment-file.tsx`
Renders file-related attachment sub-types. Imported only by `attachment.tsx`.

| Export | Purpose |
|---|---|
| `FileAttachmentBody` | Handles: `file`, `edited_text_file` (path + content/snippet), `compact_file_reference`, `nested_memory` (path + inner content string), `opened_file_in_ide`, `selected_lines_in_ide` (file, IDE name, line range, content). Returns `null` for unrecognised types. |

### `attachment-system.tsx`
Renders system/tool-related attachment sub-types. Imported only by `attachment.tsx`.

| Export | Purpose |
|---|---|
| `SystemAttachmentBody` | Handles: `hook_success`, `task_reminder`, `skill_listing`, `command_permissions`, `agent_listing_delta`, `deferred_tools_delta`, `diagnostics`, `date_change`, `plan_mode`, `plan_mode_exit`, `queued_command`, `dynamic_skill`, `invoked_skills`. Returns `null` for unrecognised types. |

### `attachment.tsx`
Expanded view for `type=attachment` entries. Delegates rendering to `FileAttachmentBody` and `SystemAttachmentBody`.

| Export | Purpose |
|---|---|
| `getAttachmentDetail` | Returns a one-line summary string for the collapsed row (used by `utils.ts`). Handles all attachment sub-types. |
| `AttachmentBody` | Switches on `att.type`: file-category types → `FileAttachmentBody`; system-category types → `SystemAttachmentBody`; fallback → `JsonBlock`. |
| `AttachmentExpanded` | Wraps `CommonFields` + `AttachmentBody` + `AdditionalFields` |

### `user.tsx`
Expanded view for `type=user` entries.

| Export | Purpose |
|---|---|
| `ToolResultBlock` | Renders a `tool_result` content block: ok/error badge, tool_use_id, content (string / array of text blocks / JSON) |
| `UserPromptText` | Prompt text in a scrollable `<pre>` with a `CopyButton` |
| `UserMessageContent` | Switches content blocks: text → `UserPromptText`, tool_result → `ToolResultBlock`, other → `JsonBlock` |
| `UserExpanded` | Full renderer: promptId, isMeta, isCompactSummary, isVisibleInTranscriptOnly, interruptedMessageId, permissionMode, promptSource, sourceToolAssistantUUID/ID, compact-entry fallback, message content, toolUseResult, origin |

### `system.tsx`
Expanded view for `type=system` and `type=system-context` entries.

| Export | Purpose |
|---|---|
| `SystemExpanded` | Renders subtype, isMeta, level, durationMs, hasOutput, hookCount, hookErrors, hookInfos, hookAdditionalContext, messageCount, preventedContinuation, stopReason, toolUseID, logicalParentUuid, pendingBackgroundAgentCount, content `<pre>`, compactMetadata |
| `SystemContextExpanded` | Renders `claudeMd` object: totalBytes + files list |

### `simple-renderers.tsx`
One small renderer per minor entry type — no shared state between them.

| Export | Entry type |
|---|---|
| `AiTitleExpanded` | `ai-title` — aiTitle + sessionId |
| `FileHistorySnapshotExpanded` | `file-history-snapshot` — isSnapshotUpdate, messageId, snapshot JSON |
| `LastPromptExpanded` | `last-prompt` — sessionId, leafUuid, lastPrompt text |
| `ModeExpanded` | `mode` — mode, sessionId |
| `PermissionModeExpanded` | `permission-mode` — permissionMode, sessionId |
| `QueueOperationExpanded` | `queue-operation` — operation, sessionId, content |

### `utils.ts`
Pure logic — no JSX. Used by `RawLogsTab.tsx` to populate the collapsed table rows.

| Export | Purpose |
|---|---|
| `TYPE_ICONS` | Map of entry `type` string → Lucide icon component |
| `getIcon` | Safe lookup into `TYPE_ICONS`, falls back to `HelpCircle` |
| `getCollapsedSummary` | Returns a one-line summary string for each entry type shown in the collapsed row. Handles all known types; falls back to the type string itself. |
| `sortRawLogs` | Stable sort by timestamp. Entries without a timestamp inherit the last-seen timestamp so they stay inline with their neighbours. |

### `renderers.tsx`
Thin dispatcher — the only file imported by `RawLogsTab.tsx` for rendering.

| Export | Purpose |
|---|---|
| `RawLogsExpandedView` | Switches on `entry.type` and returns the matching `*Expanded` component. Falls back to `JsonBlock` (imported directly from `primitives.tsx`) for unknown types. |
| `getAttachmentDetail` | Re-exported from `attachment.tsx`. Currently unused elsewhere — `utils.ts` imports `getAttachmentDetail` directly from `attachment.tsx`, bypassing this re-export. |

---

## Dependency Graph

```
RawLogsTab.tsx
  ├── raw-logs/renderers.tsx   (expanded body)
  └── raw-logs/utils.ts        (icon + collapsed summary + sort)

renderers.tsx
  ├── primitives.tsx      (JsonBlock, for the unknown-type fallback)
  ├── assistant.tsx
  ├── attachment.tsx
  ├── user.tsx
  ├── system.tsx
  └── simple-renderers.tsx

assistant.tsx <──> assistant-sections.tsx   (circular: each imports from the other)
  └── primitives.tsx

attachment.tsx
  ├── primitives.tsx
  ├── attachment-file.tsx
  └── attachment-system.tsx

attachment-file.tsx
  └── primitives.tsx

attachment-system.tsx
  └── primitives.tsx

user.tsx, system.tsx, simple-renderers.tsx
  └── primitives.tsx  (each depends on this, nothing else)

utils.ts
  └── attachment.tsx  (for getAttachmentDetail)
```

---

## Adding a new entry type

1. Add a renderer component in `simple-renderers.tsx` (small) or a new file (large).
2. Import and add a `case` in `renderers.tsx` → `RawLogsExpandedView`.
3. Add the type to `TYPE_ICONS` and `getCollapsedSummary` in `utils.ts`.

## Adding a new attachment sub-type

1. Decide if it is file-like or system/tool-like.
2. Add a `case` in `FileAttachmentBody` (`attachment-file.tsx`) or `SystemAttachmentBody` (`attachment-system.tsx`).
3. Add a `case` in `getAttachmentDetail` (`attachment.tsx`) for the collapsed summary string.
