---
reviewed: no
reviewer: none
---

# OKF value signals: did an article lead the agent to code, and where it failed to

## Purpose

The access numbers and the verdict ([okf-verdict](okf-verdict.md)) say how much of the KB the
agents read. They do not say whether an article was **worth** reading. These signals answer that
from what the agents did next: did they open the code paths an article pointed them to (yield),
did they still have to search the article's code after reading it (searched after), did agents
search an article's code without ever opening the article (routing miss), which pointers no agent
ever follows (dead pointers), and which articles are mere file catalogs. Each finding comes with
one concrete action for the KB author. The rules are pure functions over the stored pointer and
event rows, so a reader can recompute every number by hand.

## Code

- Implementation: `server/src/logs/okf/okf-value-signals.ts` — `computeArticleSignals`,
  `computeArticleArea`, `topPatterns`, `commonFolder`, `isFilePointer`.
- Thresholds: the value-signal group of `OkfThresholds` (`server/src/logs/okf/okf-thresholds.ts`,
  defaults in the table under Rules); `OKF_TOP_PATTERNS` from `okf-constants.ts`.
- Rows it reads: `session_okf_pointer` and `session_okf_event`, written by the extraction
  ([okf-access-extraction](okf-access-extraction.md) rules 13-16).
- Caller: `server/src/logs/okf/okf-usage.service.ts` (session route, repo route, article route),
  after the team filter (`applyOkfTeamFilter`).
- Action text (client): `client/src/viewer/lib/okf/okf-action-text.ts` (`okfActionText`) maps the
  rule ids and params below to one action line.
- Twins: none.
- Test: `server/src/logs/okf/okf-value-signals.algo.spec.ts` (jest).

## Input and output

`computeArticleSignals(input)` takes:

| Field | Content |
|---|---|
| `pointers` | Period pointer rows `{nodeId, articlePath, articleHash, readOrd, pointer, isNew, followed, partial}`; `pointer = ''` is a partial read with no pointers. |
| `allTimePointers` | All-time pointer aggregates of the same scope, no period: `{articlePath, articleHash, pointer, isNew, partial, lastReadAt}` (the area only). |
| `events` | Period code events `{nodeId, ord, op: 'read'|'search'|'write', path, pattern}`. |
| `allTimeTouchedPaths` | Every path an all-time event or access row touched (folders end in `/`). |
| `reads` | Period KB reads `{nodeId, articlePath, firstReadOrd?}` (a node's `read` access rows of a stored `.md` key). |
| `upkeep` | Period upkeep pairs `{nodeId, articlePath}`: the node also has a `write` row on the article. |
| `latestFiles` | Optional: files of the latest snapshot, `path → {hash, size}`. |
| `thresholds` | The value-signal thresholds (resolved). |

It returns per-article signals (`articles`: area, yield, reads, searchedAfter, routingMiss,
pointers, deadPointers, catalog, findings), per-node signals (`nodes`: yield, searches, pointers,
routingMisses, searchedAfter), the overall `yield`, a `summary` (`readsWithNewPointers`,
`readsFollowed`, `routingMissArticles`, `routingMissPairs`, `searchedAfterPairs`,
`deadPointers`) and all `findings`.

## Rules

**Thresholds** (value-signal group of `OkfThresholds`, per repo, see
[okf-verdict](okf-verdict.md) for the verdict group and how they are resolved):

| Field | Default | Rule |
|---|---|---|
| `exploredMinSearches` | 2 | 5 |
| `routingMinSearches` | 3 | 6 |
| `routingMinAgents` | 3 | 6 |
| `pointerMaxArticles` | 3 | 1 |
| `areaMaxFiles` | 30 | 7 |
| `deadPointerMinShown` | 4 | 8 |
| `codeRoots` | `server/`, `client/`, `hook/`, `scripts/`, `packages/`, `tests/` | 1 |

`OKF_TOP_PATTERNS` = 5 (fixed). The defaults were calibrated on the Log Hub repo itself (see the
probe in `docs/tasks/todo/2026-11-03-okf-view-kb-value/notes.md`, under `done/` once archived).

1. **Area of an article** (DD-12, `computeArticleArea`), over `allTimePointers`:
   - a *qualifying* pointer is new (`isNew`), not partial, not `''`, a file (no trailing `/`, its
     last segment has an extension) and starts with one of `codeRoots`;
   - group the qualifying pointers by (article, hash);
   - *version*: the article's hash in `latestFiles` when that (article, hash) has rows; otherwise
     the version with the latest `lastReadAt` (ties by hash ascending) and, when `latestFiles` is
     given, `areaFromOlderVersion = true`;
   - drop a pointer that is a new, non-partial pointer of more than `pointerMaxArticles` distinct
     articles (counted across all versions) — it is a shared pointer, not this article's area;
   - the area is the sorted rest. An article with no all-time rows has no area.
2. **Upkeep** (DD-15): every per-node rule below skips the rows of upkeep pairs (pointer rows,
   reads and in-area searches of a node on an article it also writes).
3. **In-area search** (DD-13): a `search` event is in an article's area when its path, without a
   trailing `/`, equals an area file or starts with `areaFile + '/'`. `read` / `write` events are
   never in-area searches.
4. **Yield (FR-1).** A *read* = the pointer rows of one (node, article, `readOrd`). A read is
   partial if any of its rows is. Over non-partial, non-upkeep reads: `n` = reads with at least one
   new pointer, `k` = those with at least one `followed` new pointer. Per article, per node and
   overall; `null` when `n` = 0.
5. **Searched after (FR-2).** For each non-upkeep (node, article) read pair, take the node's first
   read ordinal (`firstReadOrd`, else the smallest `readOrd` of its non-partial pointer rows; with
   neither the pair is skipped). Count the node's in-area searches of the article with `ord`
   greater than it. The pair is listed when the count ≥ `exploredMinSearches`. Per article:
   `agents` = listed pairs, `searches` = their summed counts, `patterns` = top patterns of those
   searches. Any listed pair → a `searched_after` finding (`fix`).
6. **Routing miss (FR-3).** Per article (skipped for a catalog article, rule 7): *Y* = non-upkeep
   nodes with ≥ 1 in-area search; *X* = those with ≥ `routingMinSearches` in-area searches and no
   read pair of the article (from `reads` or the pointer rows). `patterns` = top patterns of the X
   nodes' in-area searches. X ≥ `routingMinAgents` → a `routing_miss` finding (`fix`). A
   sub-agent's read does not clear its parent: every node is judged on its own reads.
7. **Catalog (FR-15).** An area of more than `areaMaxFiles` files → `catalog: {files}` and an
   `info` finding `catalog`; FR-3 is not computed for it.
8. **Dead pointers (FR-13).** Per (article, pointer) over non-partial, non-upkeep reads: `shown` =
   distinct nodes that saw it as new, `followed` = distinct of those that followed it. Dead when
   `shown ≥ deadPointerMinShown` and `followed = 0`. For a dead pointer, `notFound` = no path in
   `allTimeTouchedPaths` equals it or lies under it, **and** it is not a file of `latestFiles` —
   a proxy (Log Hub has no repo file list), shown as "path not found in any session". The list is
   sorted dead first, then `shown` descending, then pointer ascending. Any dead pointer → a
   `dead_pointers` finding (`fix`).
9. **Top patterns (FR-14,** `topPatterns`): count each non-empty pattern, sort by count
   descending, ties by pattern ascending, keep `OKF_TOP_PATTERNS`. Patterns are never masked.
10. **Findings.** Per article in path order: `routing_miss`, `searched_after`, `dead_pointers`,
    `catalog`; then all `fix` before all `info`. `node = {bundle, path}`. Params (DD-26):

    | Rule | Params |
    |---|---|
    | `routing_miss` | `file`, `area` (common folder of the area files, `/` when none), `patterns` (comma-joined), `agents`, `areaAgents` |
    | `searched_after` | `file`, `patterns`, `agents`, `searches` |
    | `dead_pointers` | `file`, `path` (the dead pointers, at most 3 comma-joined, then `…`), `dead`, `notFound` |
    | `catalog` | `file`, `files`, `area` |

    The verdict level never reads these findings; they are listed next to it.

## Edge cases

- Area files and the yield of two reads, one followed: VS-01.
- Routing miss: 3 agents with 3 searches, one with 2 (counts in Y only), patterns ranked: VS-02.
- Dead pointer not found anywhere: VS-03; one node short of the threshold: VS-04.
- Area: shared-pointer drop, folder and non-`codeRoots` drop, partial / not-new rows left out,
  older-hash fallback: VS-05.
- Searched after, a search before the first read not counted, and the upkeep exclusion: VS-06.
- A sub-agent's read does not clear the main agent; top patterns cut at 5 with ties by pattern:
  VS-07.
- Catalog suppresses the routing miss: VS-08.
- Partial reads give no yield, no shown count and no area pointer: VS-09.
- Dead pointers found through a touched path under them and through the latest snapshot: VS-10.

## Examples

Each row is one call of `computeArticleSignals`. `input` holds the fields of the input table in
JSON, with these defaults: a pointer row's `articleHash` is `null` and `partial` `false`;
`allTimePointers` defaults to the period `pointers` without node and ordinal (`lastReadAt: null`);
an event's `pattern` defaults to `null`; `allTimeTouchedPaths`, `reads`, `upkeep` default to `[]`;
`latestFiles` is an object `{path: {hash, size}}` (absent = no snapshot); `thresholds` holds only
the fields that differ from the defaults. `expected` is compared as a subset on the listed keys,
nested (arrays exactly, element by element), against `{articles, nodes, summary, findings,
yield}` with the two maps turned into objects keyed by path / node id.

Rows (10): [`docs/algorithm-examples/okf-value-signals.json`](../../algorithm-examples/okf-value-signals.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- A not-followed read counted in `k`, or a read with no new pointer counted in `n` -> VS-01
  (1/2).
- Shown counted per read instead of per distinct node, or `>` instead of `≥` for
  `deadPointerMinShown` -> VS-03 / VS-04.
- `notFound` computed for live pointers -> VS-04.
- Y counting only the nodes over `routingMinSearches` -> VS-02 (`areaAgents` 3).
- Patterns ranked by first occurrence instead of count, or ties not by pattern -> VS-02.
- Area param taken from the article's folder instead of the area files -> VS-02 (`server/svc/`).
- Shared pointers kept, folders or non-`codeRoots` pointers in the area, or the oldest version
  chosen -> VS-05.
- Searches before the first read counted, or upkeep pairs not skipped -> VS-06 (`searches` 3,
  `agents` 2).
- A read by any node of the tree clearing the routing miss -> VS-07 (`agents` 0); no pattern
  limit -> VS-07 (7 patterns).
- FR-3 computed for a catalog article -> VS-08.
- Partial reads counted in yield or `shown` -> VS-09.
- `notFound` ignoring paths under the pointer or the latest snapshot -> VS-10.

## Where the result is visible

- Repository → **OKF** tab: the YIELD / EXPL. AFTER / ROUTE MISS tree columns, the `routing miss`,
  `catalog`, `N dead` markers, the pointer-yield and routing-miss tiles, the hot files' Yield
  column, the "→ action" lines on the verdict card.
- Repository → **OKF** → article drill-down (`okfArticle`): the value-signals strip, the pointer
  table, the routing-miss / searched-after / catalog blocks.
- Session pane → **OKF** tab: the value-signals tile, POINTERS USED / EXPL. AFTER columns, the
  per-agent pointer sub-rows, routing-miss rows, the Agents panel's yield / routing misses /
  searches.
- API: `signals`, tree-node `yield` / `searchedAfter` / `routingMiss` / `deadPointers` /
  `catalogFiles`, `agents[].pointers` / `routingMisses` of the session and repo `okf-usage`
  routes; the whole `GET …/reports/okf-usage/article` response.
