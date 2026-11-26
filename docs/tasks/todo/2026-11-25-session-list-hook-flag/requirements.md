---
type: "Task"
title: "Session List Without Log-Body Scan for the Hook-Service Flag"
description: "Stop decompressing every log body of a repository to compute isHookService in the session list; find a cheap signal or a stored flag, without a heavy backfill unless confirmed."
---

# 2026-11-25: Session List Without Log-Body Scan for the Hook-Service Flag

**Status:** todo
**Priority:** medium
**Type:** bug
**Module(s):** server
**Owner:** denis.tsyplakov
**Created:** 2026-11-25
**Tracker:** GH-182 https://github.com/DataArt/artisyn-log-hub/issues/182

## Description

Session list: stop decompressing log bodies for the isHookService flag. `GET :repoId/sessions`
computes `isHookService` with `logs.body @> '[{"event":"hook_service"}]'`
(server/src/logs/repositories.controller.ts:649), which detoasts every `artisyn` log body of the
repository (5.8 MB compressed / 16 MB text on a 58-session repo on a Raspberry Pi: 553–1280 ms of
the request; 13 ms without it). Fix: find a cheap way to tell hook-service sessions apart (log
type, missing transcript, an existing column) or store the flag at ingest in session_stats like
has_workflow. If a stored flag needs a backfill over existing log bodies, that is a heavy
migration — estimate it on a Pi-class install and get explicit confirmation
(migrations-data-integrity skill), consider a light/lazy backfill. Measured and diagnosed on
2026-11-25 while profiling the slow sessions list (fixes for utility_costs and the repeated version
check already landed in 2026-11-24-otel-session-tags). Also consider: the Pi's Postgres JIT
(jit_above_cost 100000) can add ~10 s to these queries.

## Functional Requirements

- FR-1: The session list (`GET :repoId/sessions`) determines `isHookService` without reading or
  decompressing `logs.body`.
- FR-2: `isHookService` keeps its current meaning and value for every existing and new session
  (same rows flagged before and after the change).
- FR-3: Prefer a signal that already exists cheaply (log type, absence of a transcript, an existing
  column); only if none is reliable, store the flag at ingest (e.g. in `session_stats`, like
  `has_workflow`).
- FR-4: If a stored flag needs a backfill over existing log bodies, the plan calls it out as a heavy
  migration with an estimate on a Pi-class install and the user confirms it explicitly before
  implementation; a light or lazy backfill is considered first.

## Non-Functional Requirements

- The main session-list query on a 58-session repository on a Raspberry Pi 3B drops from
  0.5–1.3 s to well under 100 ms for this part.
- No startup step that blocks or saturates a small install for minutes.

## Acceptance Criteria

- [ ] The session-list SQL no longer contains a `logs.body` containment / JSON check (EXPLAIN shows no detoasting of `logs.body` for the flag).
- [ ] For a repository with hook-service sessions, the same sessions carry `isHookService: true` before and after (scenario step or contract row).
- [ ] Measured on the Pi: the main session-list query part for the flag is < 100 ms on the same repository.
- [ ] If a backfill exists: the plan has a "Heavy migration" subsection with the estimate and the user's confirmation, and the backfill is batched and resumable.

## Notes

<!-- Append timestamped notes here as work progresses -->
