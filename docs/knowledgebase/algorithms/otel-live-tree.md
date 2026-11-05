---
reviewed: no
reviewer: none
---

# OTEL Live tree: node keys, placement, retention and totals

## Purpose

The header **Live** view shows what is running right now as a tree: Home → each team (and No
team) → repository → session → agent, every node with its cost, tokens, calls, live counts and
running time. This rule turns the rows the live SQL returns into that tree, and owns the
node-key grammar the `?live=` URL and the `node` / `panel` query params use. It decides where a
session appears (which teams, which repos), which nodes stay visible after their session ended,
and how parents add up without counting a session twice.

## Code

- Implementation: `server/src/logs/otel/otel-live-tree.ts` — `parseOtelLiveNodeKey`,
  `formatOtelLiveNodeKey`, `buildOtelLiveTree` (returns `nodes`, `resolve`, `rootIdsOf`,
  `childrenOf`, `distinctFootnote`), `otelLiveSessionLabel`; constants
  `OTEL_SESSION_ENDED_MS` (`otel-facts.constants.ts`, 600 000) and
  `OTEL_LIVE_PROMPT_EXCERPT_CHARS` (`otel-live.constants.ts`, 80). Input / output shapes:
  `otel-live.types.ts` (`OtelLiveTreeInput`, `OtelLiveTree`, `OtelLiveNode`).
- Callers: `server/src/logs/otel/otel-live.reader.ts` (both `GET /api/v1/otel/live` routes); the
  rows come from `otel-live-read.sql.ts`, which already applies each team's user filter in SQL
  (the tree re-checks it).
- Twins: none. The client never parses or builds keys; `client/src/viewer/live/live-node-key.ts`
  only holds `HOME_LIVE_KEY` and a prefix check for the URL value before the first answer.
- Test: `server/src/logs/otel/otel-live-tree.algo.spec.ts`.

## Input and output

Input (`OtelLiveTreeInput`): `now`; `scopeTeams` (the caller's teams: id, name, `userIds` row
filter or null, `restricted`); `candidates` (`rootId`, `live`); `placements` (one row per root ×
team-or-No-team × repo: `rootId`, `userId`, `userEmail`, `teamId` or null, `repoId`, `repoLabel`,
`firstPrompt` already masked); `rootTotals` (lifetime sums per root, `firstEventAt`,
`lastActivityAt`); `agents` (per root × `agentKey`: label, sums, `calls`, first / last event);
`retainedKeys` (parsed `node` / `panel` keys); `retainedRepoLabels`.

Output: `nodes` in display order (including ended agents with `inTree: false`) and four lookups
over the in-tree nodes: `resolve(key)`, `rootIdsOf(key)`, `childrenOf(key)`,
`distinctFootnote(key)`.

## Rules

**Key grammar (DD-3)**

1. Key forms: `home`; `team:<teamId>`; `noteam`; `repo:<repoId>[@<teamId>|@noteam]`;
   `session:<rootId>[@…]`; `agent:<rootId>:<agentKey>[@…]`. Nodes always carry the
   **qualified** (canonical) form; `repo` / `session` / `agent` keys may also be sent without
   the suffix.

2. The placement suffix is the text after the **last** `@`: a team id or `noteam`. A key with a
   suffix is `qualified: true`, without one `qualified: false`. `team` keys never take a suffix.

3. An agent body is split at its **first** `:` into `<rootId>` and `<agentKey>`, so the agent key
   may contain `:` itself. The main thread's agent key is the literal `main`.

4. Every id is a positive integer without a leading zero and at most 2 147 483 647 (Postgres
   `int`). The agent key is 1–255 characters. Anything else — an unknown prefix, an empty or
   bad id, a bad suffix, a missing agent key — is malformed: the parser returns null (400 at the
   route). `formatOtelLiveNodeKey(parse(k)) = k` for every well-formed `k`.

**Placement (DD-4, DD-5)**

5. Each placement row of a candidate root puts the root under its team and repo node
   (`repo:<repoId>@<teamId>`). A team is shown only if it is in `scopeTeams`. A root of a URL that
   two caller teams link is placed under both teams.

6. A placement with `teamId = null` goes under **No team** (`noteam`, label `No team`), with repo
   key `repo:<repoId>@noteam`.

7. A team whose `userIds` is not null keeps only placements whose `userId` is in it; a
   `restricted` team node carries `restricted: true` (the 🔒). Repo and session nodes never do.

8. Candidates are the live roots plus the retained roots the reader added (`live: false`). A
   retained root is placed and figured exactly like a live one but stays `live: false`.

**Totals (DD-6)**

9. A session node's sums are its `rootTotals` row (session lifetime, hidden calls included);
   `runningMs = lastActivityAt − firstEventAt` (0 when either is null or the span is negative);
   `liveSessions` = 1 if live; `liveAgents` = its live agents. A parent (home, team, No team,
   repo) sums over the **DISTINCT** roots below it; its `liveSessions` / `liveAgents` count only
   live roots; its `runningMs` is the **max over its live sessions** (0 when none is live);
   `firstEventAt` is the min and `lastActivityAt` the max over all its roots. A parent is live
   when its `liveSessions > 0`.

10. A root linked to two repos of one team appears under both repo nodes (same session key,
    different parent); the team and home still count it once.

**Order and lookups (DD-3, DD-9)**

11. Display order: home first; teams by name (then id); No team last; inside a node, children by
    cost descending, ties by label, then key. A session is followed by its agents.

12. `resolve(key)`: a qualified key, `home`, `team:` or `noteam` is looked up exactly; an
    unqualified repo / session / agent key resolves to its first in-tree placement in display
    order. `rootIdsOf` gives the sorted DISTINCT roots of the resolved node (its own root for a
    session or agent). `childrenOf` gives the in-tree direct children (for a repo or session,
    only those of that placement's repo).

13. A placement of a root that is not a candidate is ignored; a key that names nothing in the
    tree resolves to null (the route falls back to `home`).

14. `distinctFootnote(key)` is true for a parent whose cost or call total is less than the sum of
    its children's; never for a session or agent.

**Agents, retention, hidden calls (DD-2, DD-5, DD-9)**

15. Agent rows with `calls <= 0` are skipped. An agent is live when its root is live and
    `now − lastEventAt <= OTEL_SESSION_ENDED_MS` (the boundary is live). The label is
    `agentLabel`, or `agentKey` when the label is empty; `runningMs = lastEventAt − firstEventAt`.
    A live agent is `inTree: true`. An ended one is `inTree: true` too (greyed, `live: false`)
    while `now − lastEventAt <= OTEL_LIVE_RECENT_MS` (2 h, the chart window) or a retained agent
    key names it (unqualified keys match any placement); otherwise `inTree: false` (shown only in
    its session's breakdown). Ended sessions in that window come in as `live: false` candidates
    (the live route's candidate query covers `OTEL_LIVE_RECENT_MS`; the header status does not),
    so they count in their parents' sums but not in `liveSessions` / `liveAgents`.

16. A retained `team:<id>` key keeps that team node (zero totals if nothing is under it) only if
    the team is in `scopeTeams`. A retained `noteam` key keeps the No-team node. A retained repo
    key keeps the repo node and its team only when `retainedRepoLabels` has its label for that
    placement (qualified: its own suffix; unqualified and not placed anywhere: the first team by
    name that has a label, then No team); otherwise it is dropped.

17. Hidden calls (`structure = 'hidden'`) have no agent row, so they count in the session and
    parent totals but get no agent node.

Session label: `userEmail · ` plus the first `OTEL_LIVE_PROMPT_EXCERPT_CHARS` (80) characters of
the whitespace-collapsed prompt, or `prompt hidden` when the prompt is null or empty.

## Edge cases

- Agent id containing `:`: LT-07. Main agent key: LT-08.
- Malformed keys: LT-09 (unknown prefix), LT-10 (zero id), LT-11 (leading zero), LT-12 (above
  int max), LT-13 (bad suffix), LT-14 / LT-15 (missing / empty agent key), LT-16 (suffix on a
  team key).
- One root under two teams, counted once at home; unqualified resolution: LT-20.
- One root under two repos of one team; repo tie by label: LT-21.
- No team sorted last: LT-22. No footnote when children add up: LT-22.
- Restricted team, other user dropped; non-candidate placement; masked prompt label: LT-23.
- Retained ended session; parent `runningMs` 0 with nothing live; ended agent out of the tree:
  LT-24. Retained agent kept in the tree: LT-25.
- Retained repo with nothing live: LT-26; without a label: LT-27. Retained team out of scope:
  LT-28. Retained No team: LT-29.
- Parent `runningMs` = max over live sessions only; min / max times: LT-30.
- Hidden calls in session totals only; agent liveness boundary; zero-call agent skipped: LT-31.

## Examples

Two kinds of row. A `key` row (`{"kind":"key","key":…}`) expects `parsed` (the
`ParsedLiveKey`, or null) and `formatted` (the formatted key, or null). A `tree` row carries the
`OtelLiveTreeInput` with `now` and `retainedKeys` as strings; the test fills fields the rule does
not read (`sessionUuid = uuid-<rootId>`, `startedAt = null`, every token sum `'0'`, the team
`scope`). It expects `nodes`: every node in order (in-tree or not), each matched on the listed
flat fields (`key`, `type`, `parentKey`, `label`, `live`, `inTree`, `restricted`, `cost`,
`calls`, `liveSessions`, `liveAgents`, `runningMs`, `firstEventAt`, `lastActivityAt`), plus
optional `resolve`, `rootIdsOf`, `childrenOf` (child keys) and `distinctFootnote` maps.

Rows (28): [`docs/algorithm-examples/otel-live-tree.json`](../../algorithm-examples/otel-live-tree.json) — test data for the table test; key grammar LT-01…LT-16, tree LT-20…LT-31.

## Mutations

- Home sums placements instead of DISTINCT roots (2000 instead of 1000) -> LT-20.
- Agent split at the last `:` instead of the first -> LT-07.
- Parent `runningMs` taken over every root, not only live ones -> LT-24, LT-30.
- Restricted team filter not applied in the tree -> LT-23.
- Agent liveness with `<` instead of `<=` at `OTEL_SESSION_ENDED_MS` -> LT-31.
- No team sorted with the teams by name -> LT-22.
- A retained repo without a label still emitted -> LT-27.

## Where the result is visible

The Live modal (header **Live** entry): the left tree, the breadcrumb, the KPI tiles and the
breakdown table of `GET /api/v1/otel/live` (`nodes`, `selected`, `view.breakdown`,
`view.distinctFootnote`), and the header dot / tooltip of `GET /api/v1/otel/live/status`
(home's `liveSessions`, `liveAgents`, `costUsdMicros`).
