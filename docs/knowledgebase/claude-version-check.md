---
type: "Reference"
title: "Claude Code Version Check"
description: "How Log Hub tells whether a session ran an outdated Claude Code: the npm dist-tag fetch and release history, the per-session version extraction (transcript first, OTEL fallback), matching a session to the releases current at its start, the session Summary detector, and the per-user Claude Code Version Usage report."
tags:
  - server
  - client
  - analytics
timestamp: "2026-10-14T00:00:00+04:00"
---

# Claude Code Version Check

Log Hub compares the Claude Code CLI version each session ran against the npm `stable` and `latest`
releases of `@anthropic-ai/claude-code` that were current **when that session started**, and shows
the result in two places: a finding on the session Summary tab and the "Claude Code Version Usage"
report.

| Piece | File |
|---|---|
| Release fetch and history | `server/src/ai-tool-versions/` (`AiToolVersionsService`, `AiToolVersionsScheduler`, `ai-tool-versions.constants.ts`) |
| Release lookup by time | `server/src/ai-tool-versions/release-at.ts` (`pickReleaseVersionsAt`) |
| History endpoint | `GET /api/v1/ai-tool-versions/:toolName` (`ai-tool-versions.controller.ts`) |
| Transcript version | `server/src/logs/claude-extractor.ts` |
| OTEL version | `server/src/logs/otel-chunk.ts` |
| Usage report | `server/src/logs/analytics/claude-version-usage.service.ts` (`buildClaudeVersionUsageRows`) |
| Summary detector | `client/src/viewer/pages/repository/session-log/summary/detectors/claude-version.ts` |
| Report page | `client/src/viewer/pages/repository/reports/ClaudeVersionUsageReport.tsx` |

## Version check

**Release fetch.** The server fetches the npm dist-tags of `@anthropic-ai/claude-code` once at start
and then on an hourly tick. A cluster-safe claim makes sure only one worker calls npm, at most once
per 24 h after a success and no sooner than 1 h after a failure. Only `stable` and `latest` are kept
(`ai_tool_version.version_map`). A new row is appended to `ai_tool_version_history` only when one
of them changed, with `effective_from` set to the fetch time. The claim SQL, the env flags
(`AI_TOOL_VERSION_CHECK_ENABLED`, `AI_TOOL_VERSION_CHECK_INTERVAL_MS`) and the outbound
`registry.npmjs.org` dependency are described in
[system-info-and-cluster.md](system-info-and-cluster.md); the tables in
[db-tables.md](db-tables.md#ai_tool_version).

**Per-session version.** `session_stats` stores two nullable columns:

- `claude_version` — the highest valid version found in the `version` field of the session's own
  transcript lines (`maxVersion` in `claude-extractor.ts`), written with the rest of the session
  stats.
- `claude_version_otel` — the highest OTEL `service.version` seen on the session's `claude-otel`
  chunks (`otel-chunk.ts`). It is only ever raised.

Readers use `COALESCE(claude_version, claude_version_otel)`, so the transcript value wins and OTEL
is the fallback for a session whose transcript carries no version.

**Matching a session to releases.** `pickReleaseVersionsAt(history, startTime)` picks the newest
history entry whose `effective_from` is at or before the session's start. A session is **checked**
only when its version parses and such an entry exists. Everything else — no version, an unparseable
version, a session older than the first history row, or a deployment that cannot reach npm (empty
history) — is "unchecked": no finding and not counted, never an error.

## Summary detector

The `claude-version` detector on the session Summary tab reads the session version and the release
history (`useAiToolVersions`, from `GET /api/v1/ai-tool-versions/claude-code`):

| Session version `v` | Finding |
|---|---|
| `v < stable` | red (`critical`) "Outdated Claude Code version" |
| `stable ≤ v < latest` | green (`success`) "Newer Claude Code was available: `<latest>`" |
| `v ≥ latest`, or any value missing or unparseable | none |

It is a whole-session finding. Its evidence lists the session version, `stable`, `latest` and the
time the releases were recorded.

## Claude Code Version Usage report

A per-user report in the repository Reports tab (`claude-version-usage` in `report-catalog.ts`),
served by `GET /api/v1/repositories/:repoId/reports/claude-versions` and its twin
`…/analytics/claude-versions`. Both call `ClaudeVersionUsageService.build()`.

- It counts in-scope **root** sessions only, with the usual branch, user, attribute and team-scope
  filters.
- Per user: `sessionsChecked` and `outdatedSessions` (checked sessions whose version is below the
  `stable` release current at their start).
- Users with no checked session are left out. Users with outdated sessions sort first, then by
  email.
