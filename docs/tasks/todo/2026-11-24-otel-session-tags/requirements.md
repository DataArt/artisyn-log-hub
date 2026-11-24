---
type: "Task"
title: "Session Tags from OTEL Resource Attributes"
description: "Universal session tags (key=value with a source), first source = user attributes from OTEL_RESOURCE_ATTRIBUTES (e.g. a feature slug); shown on the session, filter/group sessions and cost by tag"
---

# 2026-11-24: Session Tags from OTEL Resource Attributes

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** server | client
**Owner:** denis.tsyplakov
**Created:** 2026-11-24
**Tracker:** GH-174 https://github.com/DataArt/artisyn-log-hub/issues/174

## Description

A user can add custom attributes to `OTEL_RESOURCE_ATTRIBUTES` (e.g. a feature slug:
`feature=checkout-v2`) next to Log Hub's own `artisyn.repo` tag. Log Hub should pick these
attributes up as **session tags**, show them on the session and let the user filter/group sessions
and cost by them (e.g. how many sessions and how much money each feature took).

Tags are a **universal feature**: a generic session-tag model (key, value, source) that other
sources plug into later. This task delivers the model plus its first source — OTEL resource
attributes. Other sources and ways of setting tags are out of scope (see below).

### Current state (2026-11-24)

- The installer writes `OTEL_RESOURCE_ATTRIBUTES` into the repo's `.claude/settings.local.json` as
  user-scope value + existing local value + `artisyn.repo=<repoKey>` (`buildResourceAttributes`,
  `artisyn-hooks-installer/src/otel-env.ts:81`; KB `hook-installation.md` §"OTEL_RESOURCE_ATTRIBUTES
  in the mirror"). A user can already add `feature=<slug>` there by hand and it survives a reinstall.
- The receiver (`hook/.claude/telemetry_tool/otel-receiver.js:535`, `:578`, `:640`) flattens
  resource attributes into each line's `resource` field for logs, metrics and spans.
- The server stores each chunk verbatim in `logs_otel.body` (jsonb). From `resource` it reads only
  `service.version` (`server/src/logs/otel-chunk.ts:194`) and the `anthropic.*` account fields
  (`server/src/logs/otel/otel-records.ts:347`). The client never reads `resource`.

## Functional Requirements

- FR-1: A generic session-tag model: a session has a set of tags, each `key`, `value`, `source`.
  It is not tied to OTEL — the same storage, API and UI serve any future source (e.g. the prompt
  classifier of `2026-06-16-prompt-classifier-session-tags`). This task adds one source: `otel`.
  Tags live in their own table (`session_tags`, keyed on the root session id), separate from the
  typed, team-defined Session Attributes (`session_attribution`); future tag sources write there too.
- FR-2: The server extracts user tags from the `resource` of a session's OTEL lines, inside
  `applyOtelLines` (`server/src/logs/otel/otel-facts-writer.ts`), so both the chunk and the realtime
  channel feed them, as an idempotent upsert on the root session id. A user tag is any resource
  attribute whose key does not start with a prefix on one server-side deny-list constant:
  `artisyn.`, `service.`, `telemetry.`, `host.`, `os.`, `process.`, `anthropic.`, `wsl.`, `user.`,
  `session.`, `organization.`, `terminal.`, `deployment.`, `k8s.`, `cloud.`, `container.`,
  `device.`, `faas.`, `aws.`, `gcp.`, `azure.`. Dotted keys outside the list (e.g. `team.name`) are
  user tags.
- FR-3: If the value of a key changes within one session, every distinct value is kept.
- FR-4: Already ingested `logs_otel` chunks are backfilled by bumping `OTEL_PROJECTION_VERSION`
  (2 → 3), so sessions recorded before this change also get their tags.
- FR-5: The session view shows the session's tags; subagent sessions show their root session's
  tags. Session row and session-detail responses carry `tags: { key, value, source }[]`.
- FR-6: The session list can be filtered by tag and grouped by the values of one chosen tag key.
  Filter parameter: repeatable `tag=<key>:<value>` or `tag=<key>` (any value); filters on
  different keys combine with AND, several values of one key with OR. Groups are the chosen key's
  values plus "untagged" = sessions without that key (they may have other tags).
- FR-7: Cost and session-count analytics can be broken down by a tag key (`groupBy=tag:<key>`,
  e.g. cost per `feature` value). Every Reports and Analytics screen offers a tag filter in its
  filter bar: the `tag=` filter and `groupBy=tag:` dimension are accepted on every route and screen
  that accepts `attr=` / `groupBy=attr:`; tag keys are not validated against team attribute
  definitions.
- FR-8: A tag-discovery endpoint (modelled on `session-attribution/values`) returns the tag keys in
  the current scope and period, each with its values and session counts, under the session access
  rules; the filter and Group-by pickers list only these keys.

![Session detail header with tags](wireframes/session-header-tags.svg)

![Session list tag filter and group-by](wireframes/session-list-tag-filter-group.svg)

![Spend slice and Analytics group-by by tag](wireframes/spend-slice-by-tag.svg)

## Non-Functional Requirements

- Backward compatibility: no hook / installer / hook API change — the receiver already uploads
  `resource`, so old hooks work as is. Sessions without OTEL or without user tags show no tags.
- Tag keys and values are user input, escaped in the UI. Values are coerced to strings and
  trimmed; empty keys or values are ignored; keys are case-sensitive. Limits: key ≤ 64 chars,
  value ≤ 256 chars (an over-length pair is dropped, not truncated), ≤ 20 distinct key=value pairs
  per session (first seen kept, later ones ignored).
- Tags are visible under the same access rules as the session itself.

## Acceptance Criteria

- [ ] AC-1 (FR-1): tags are stored in a source-agnostic structure with `source = otel`; adding a
  second source needs no schema change.
- [ ] AC-2 (FR-2): a session whose OTEL lines carry `feature=checkout-v2` and `team.name=core`
  gets both tags; `artisyn.repo`, `service.version`, `os.type`, `wsl.version` and `anthropic.*` do
  not appear as tags; tags arrive from both chunk and realtime OTEL lines.
- [ ] AC-3 (FR-3): a session whose lines carry `feature=a` and later `feature=b` has both values.
- [ ] AC-4 (FR-4): after the backfill, a session ingested before the change shows its tags.
- [ ] AC-5 (FR-5): the session view shows the tags; a session without tags shows nothing extra.
- [ ] AC-6 (FR-6): filtering the session list by `feature=checkout-v2` returns only those sessions;
  `tag=feature` returns every session with any `feature` value; grouping by `feature` shows one
  group per value plus an "untagged" group that includes sessions with other tags but no `feature`.
- [ ] AC-7 (FR-7): the cost breakdown by `feature` sums to the total cost of the period when no
  session has two `feature` values (multi-value rule: see Open Questions).
- [ ] AC-7a (FR-7): on every Reports and Analytics screen, filtering by `feature=checkout-v2`
  limits every number on the screen to sessions with that tag.
- [ ] AC-8 (FR-8): the discovery endpoint returns only keys/values of sessions the caller may see;
  its row is in the API contract registry.
- [ ] AC-9 (NFR limits): a session whose resource carries a 300-char value and 25 user attributes
  stores 20 pairs and no over-length entry.

## Out of Scope (later tasks)

- Other tag sources (prompt classifier, git branch → feature mapping, hook env var).
- A command / installer option to set or clear a tag; per-session tagging; the Desktop app, which
  drops project `OTEL_RESOURCE_ATTRIBUTES`.
- Sanitising user values in `OTEL_RESOURCE_ATTRIBUTES` in the installer (morning-check 2026-11-19).

## Common sense considerations

- User tags are chosen by a prefix deny-list (FR-2 already defines them as "not standard"), kept as
  one server constant covering Claude Code's and OTel semantic-convention resource namespaces.
- Tags get their own `session_tags` table: Session Attributes are typed and team-defined, so
  free-form keys would fail their validation.
- `tag=` / `groupBy=tag:` mirror `attr=` / `groupBy=attr:` and are offered on the same surfaces.
- Responses carry `tags: { key, value, source }[]`; the client model file is a planning detail.
- A discovery endpoint feeds the pickers, like `session-attribution/values` does for attributes.
- "Untagged" = sessions without the chosen key.
- Tag filters: AND across keys, OR within a key, key-only filter allowed.
- Limits 64 / 256 / 20; over-length pairs are dropped (truncating could merge distinct values).
- Values coerced to strings and trimmed, empty ignored, keys case-sensitive (as in OTel).
- Extraction in `applyOtelLines` on the root session id: the OTEL `session.id` is always the root.
- Backfill via the existing `OTEL_PROJECTION_VERSION` bump — the established idempotent re-projection
  path; no second mechanism.

## Open Questions

- When a session has two values for the grouped key (e.g. `feature=a` and `feature=b`), how are
  its cost and session count assigned: counted in full in both groups with the fan-out caveat shown
  (like `groupBy=attr:`), or its cost split between the values (by the OTEL lines that carried each
  value) so the breakdown still sums to the period total?

## Notes

<!-- Append timestamped notes here as work progresses -->
- **2026-11-24:** Related: `2026-06-16-prompt-classifier-session-tags` (future second tag source),
  `2026-08-13-branch-jira-attribution` (feature attribution via branches).
- **2026-11-24:** Scope narrowed by the user: only OTEL tags now, but the tag model is universal.
