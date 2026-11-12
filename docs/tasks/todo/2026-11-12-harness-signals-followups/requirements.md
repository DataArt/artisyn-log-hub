# 2026-11-12: Harness Signals in the Logs Tab, Hook and Diagnostics Reports, Setup-Neutral Counts

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** client | server
**Owner:** denis.tsyplakov
**Created:** 2026-11-12
**Tracker:** GH-136 https://github.com/DataArt/artisyn-log-hub/issues/136

## Description

Implement the follow-ups picked from the harness-entries review
([2026-11-10-harness-entries-ui-review](../../done/2026-11-10-harness-entries-ui-review/harness-entries-analysis.md),
§ 6 Follow-up list): F1–F14, F16–F24 and F26–F31. The hook-change items F15, F25 and F32 are out of scope —
**no hook code changes** in this task.

Raw idea, as given:

> Implement the follow-ups picked from the harness-entries review: F1–F14, F16–F24, F26–F31 — everything except
> the hook-change items F15, F25, F32. In short: (1) Logs tab per-turn harness markup — shared per-turn
> assignment of harness entries (F1), a Signals section (hooks, IDE diagnostics, truncated reads, IDE context)
> with an issues-only toolbar filter and Signal sources strip, turn header chips (turn timing, session mode,
> scheduled, model fallback), mid-turn interjection/interrupt markers, a richer compaction divider, Signals in
> SubAgentDetail, Logs tidy-ups (one Agents block, tokens in tooltip, workflow wall-clock span); (2) other
> session tabs — Hooks kind in Harness usage, "After startup" section and separate IDE/diagnostics rows in
> System context anatomy and Context Growth, Info rows "Pull requests" and "Budget", repo-relative paths in
> nested tool input; (3) repo/team level — setup facet columns and session-mode segment, hook-health report,
> diagnostics report filterable by source/entrypoint/IDE/OS/CC version; (4) fix setup-dependent counts —
> commits/PRs/KB reads from every shell tool and forge CLI, fair per-hour/per-line metrics, path-normalised
> re-read detection, CC version check per install channel, repo identity across URL spellings and local paths,
> strip IDE context tags from prompts/titles, give the client the repo root in /logs, document Agent SDK
> sessions without hooks. No hook code changes.

Every item has a card in the review's analysis (shown content, fields read, client vs server, degraded
behaviour, privacy, producer, test kind and target) and the Logs-tab and report layouts are in the review's
`wireframes/` folder. Those cards are the detailed spec; this doc lists the scope.

## Functional Requirements

**Group 1 — Logs tab, per-turn harness markup (client only)**

- FR-1 (F1): one shared derivation assigns every harness entry to a turn (latest user prompt at or before the
  entry; Stop-time entries after the last assistant line stay in that turn) and derives per-turn signals; all
  Group 1 items consume it.
- FR-2 (F2): a turn-timing chip in the turn header from `turn_duration`; "≈" fallback for `claude -p`; "not
  recorded yet" when the entry is missing, never zero.
- FR-3 (F3): turn-header chips for silent turn, session mode, scheduled fire and model refusal fallback.
- FR-4 (F6, F7, F27, F28): a Signals section in each turn (after Tools, before Files) with Hooks, Diagnostics,
  Context (truncated reads) and IDE groups; a precise `StopFailureBanner`.
- FR-5 (F8): a Signals toolbar (`signals=issues` URL param, default shows all) and a "Signal sources" strip that
  explains which groups are hidden because their producer is absent.
- FR-6 (F17): mid-turn interjection and interrupt markers inside the turn instead of separate empty turns.
- FR-7 (F26): the compaction divider shows trigger, files re-read and re-injected context size; the
  compaction summary is folded behind "view summary".
- FR-8 (F31): Signals inside `SubAgentDetail`.
- FR-9 (F30): Logs tidy-ups — one Agents block, raw token counts moved into the cost tooltip, workflow chip
  shows the wall-clock span with the sum in the tooltip.

**Group 2 — other session tabs**

- FR-10 (F4): a Hooks kind in the Harness usage tab from per-invocation `hook_success` /
  `hook_non_blocking_error` records.
- FR-11 (F5, F18): an "After startup" section in the System context anatomy; IDE and diagnostics context as
  separate rows there and in Context Growth.
- FR-12 (F16, F29): Info tab rows "Pull requests" and "Budget".
- FR-13 (F19): repo-relative paths inside nested JSON tool input.

**Group 3 — repo / team level (server extractor + derived table + route)**

- FR-14 (F10): setup facet columns (entrypoint, IDE, OS family, CC version) and a session-mode segment per
  session; old sessions get them by re-extraction.
- FR-15 (F12): a repo/team hook-health report (runs, failures, duration per hook command).
- FR-16 (F13): a repo/team diagnostics report filterable by `source`, entrypoint, IDE, OS and CC version.

**Group 4 — setup-neutral counts and data fixes**

- FR-17 (F14): count commits, PRs and KB reads from every shell tool and forge CLI, not only Bash.
- FR-18 (F20): per-hour and per-line metrics comparable across setups.
- FR-19 (F24): path-normalised file re-read detection.
- FR-20 (F23): Claude Code version check per install channel.
- FR-21 (F11): one repo identity across URL spellings and local paths, with a re-key migration of existing data.
- FR-22 (F22): strip every IDE context tag from prompts and session titles.
- FR-23 (F21): the `/logs` payload gives the client the repo root (additive field).
- FR-24 (F9): document Agent SDK sessions that run without hooks (hook README, `user-docs/`).

## Non-Functional Requirements

- No hook code changes; server changes stay backward compatible with old hooks and old clients (`/logs` change
  is additive).
- Setup-neutral: no label, heuristic or priority names a specific IDE, OS, language toolchain or this repo's
  hooks; diagnostics are grouped by raw `source`.
- Privacy: repo/team items carry only counts, durations, codes and repo-relative paths; no emails or absolute
  paths in any new UI.
- Missing harness entries read "not recorded yet", never zero; aggregates count such turns as unknown.

## Acceptance Criteria

- [ ] AC-1 (FR-1): every harness entry of a session is assigned to exactly one turn by the shared derivation,
      covered by an algorithm doc and rows file.
- [ ] AC-2 (FR-2, FR-3): turn-header chips render per the review cards, including "≈" for `claude -p` and "not
      recorded yet" for a missing last-turn entry.
- [ ] AC-3 (FR-4, FR-5, FR-8): the Signals section shows Hooks, Diagnostics, Context and IDE groups where present,
      in turns and in `SubAgentDetail`; `?signals=issues` filters to turns with issues; the strip names absent
      producers.
- [ ] AC-4 (FR-6, FR-7, FR-9): interjections and interrupts render as in-turn markers; the compaction divider
      shows its data with the summary folded; the Logs tidy-ups are in place.
- [ ] AC-5 (FR-10–FR-13): Harness usage has a Hooks kind; anatomy has "After startup" and separate IDE /
      diagnostics rows (also in Context Growth); Info shows Pull requests and Budget; nested tool-input paths are
      repo-relative.
- [ ] AC-6 (FR-14–FR-16): facet columns and session mode are stored for new and re-extracted sessions; both
      repo/team reports exist with the listed filters and have contract registry rows.
- [ ] AC-7 (FR-17–FR-23): each count fix changes its metric as described in its review card, with algorithm rows
      or scenario steps; the repo re-key migration keeps every existing session reachable; `/logs` returns the
      repo root and old clients still work.
- [ ] AC-8 (FR-24): Agent SDK sessions without hooks are documented in the hook README and `user-docs/`.
- [ ] AC-9: no hook code changed; every item is covered by the test kind its review card names (scenario
      `s-sess-03` / `s-sess-12`, golden sessions, algorithm rows, contract rows).

## Notes

- Source: [harness-entries-analysis.md](../../done/2026-11-10-harness-entries-ui-review/harness-entries-analysis.md)
  § 2 Decision table, § 3 Item details, § 4 Logs tab review, § 6 Follow-up list (order and dependencies:
  F1 blocks the per-turn items, F10 blocks F12/F13, F21 soft-blocks path display in Signals).
- This is a large scope; `/adlc-lh:review-deep` may split it into several tasks.
