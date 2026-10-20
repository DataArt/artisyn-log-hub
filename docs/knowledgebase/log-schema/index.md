# Log Schema Reference

Auto-generated schema references for Claude telemetry log entries, by message/attachment kind. Entries added after
the 2026-06-15 snapshot (Claude Code 2.1.280 types) are hand-maintained and marked as such in each file.

* [Claude Log Message Types](claude-log-message-types.md) - Reference for all message types in Claude telemetry logs (including the hand-maintained `atis-latch` and `cost-state`): field schemas, types, sample values, and prevalence percentages per type
* [Assistant Message Structure in Claude Logs](assistant-message-types.md) - Reference for `type=assistant` log entries: top-level fields, `message` structure, `usage` breakdown, content block types, model/stop-reason distributions, and UI rendering strategies
* [User Message Structure in Claude Logs](user-message-types.md) - Schema for `type=user` log entries: top-level fields, `message.content` string vs array structure, block types (`text`, `tool_result`), and sample `toolUseResult` payloads
* [Attachment Types in Claude Logs](attachment-types.md) - Reference for all 25 `attachment.type` sub-types (20 auto-generated, 5 hand-maintained): field schemas, sample values, and UI display strategies per sub-type
