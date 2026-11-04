---
reviewed: no
reviewer: none
---

# All views map filter match

## Purpose

The "All views" map lists every screen, tab, Analytics view, report, setting and help article of
Log Hub as one tree. The filter box finds a view by what the user has in mind ("cost",
"expensive", "fail"), not only by its exact label, so it also matches synonyms and the "What it
answers" description, and it opens the branches that hold a match.

## Code

- Implementation: `client/src/viewer/pages/map/nav-tree.ts` (`matchNavFilter`, `fieldMatches`,
  `WORD_SPLIT`, `SUBSTRING_MIN_CHARS`).
- Callers (not part of the rule): `MapPage.tsx` / `MapTree.tsx` highlight `matches`, expand
  `expand` without touching the stored expand state, show a synonym chip from `synonymHit`, and the
  counter "N of M views" from `matches.length` and `total`.
- Twins: none.
- Test: `client/src/viewer/pages/map/nav-tree.algo.test.ts`.

## Input and output

- `nodes` is the tree: each node has an `id`, a `kind` (`container` or `leaf`), a `label`, a
  `description` and `synonyms` (a list of strings); a container has `children`.
- `query` is the filter text.
- The output is `{matches, expand, total, synonymHit}`: `matches` is a list of leaf ids, `expand`
  a list of container ids, `total` a number and `synonymHit` a map from leaf id to a synonym.

## Rules

1. **Words.** The query is lower-cased and split on whitespace; empty pieces are dropped.
2. **Field words.** A field (a label, one synonym, a description) is lower-cased and split into
   field words on every run of characters that are neither letters nor digits (`WORD_SPLIT`), so
   `claude.md` gives `claude`, `md`, and `Tools/MCP` gives `tools`, `mcp`.
3. **Word match.** A query word matches a field when it is a prefix of one of the field words, or,
   when the query word has at least `SUBSTRING_MIN_CHARS` = 3 characters, when it occurs anywhere
   in the lower-cased field.
4. **Field order.** For each query word the fields are tried in this order: the label, then each
   synonym in list order, then the description. The first field that matches is used.
5. **All words.** A leaf matches when every query word matches one of its fields (different words
   may match different fields).
6. **Synonym hit.** For a matching leaf, `synonymHit[id]` is the synonym used by the first query
   word that matched a synonym (rule 4). A leaf whose words all matched the label or the
   description has no entry.
7. **Only leaves.** Containers are never matched themselves; they are walked into.
8. **Output.**
   - `matches` = the ids of the matching leaves, in depth-first tree order.
   - `expand` = the ids of all containers on the path from the top to a matching leaf, each once,
     in the order they are first reached by a match.
   - `total` = the number of leaves in the whole tree, whatever the query.
9. **Empty query.** A query with no words matches nothing: `matches`, `expand` and `synonymHit`
   are empty and only `total` is set.

## Edge cases

- Label, synonym and description matches of one word in one query: NF-01 ("cost").
- Label wins over a synonym, so no synonym chip: NF-04 ("co", System context also has the
  synonym "context"), NF-06; a label match on a leaf whose synonyms miss: NF-02 ("expensive").
- The first matching synonym in list order is reported: NF-03 ("fail").
- A 2-character word matches only as a prefix, never inside a word: NF-04 ("co").
- Several words must all match; a leaf matching only one is out: NF-05 ("cl md").
- A 3+-character word inside a field word: NF-06 ("ntext").
- Upper-case query: NF-07. Empty and whitespace-only queries: NF-08, NF-09.
- Containers are not counted in `total` and never matched (the container "Cost & context" in
  NF-04): NF-04, NF-08.

## Examples

Every row uses the same small tree in `input.nodes`. A node is
`{"id", "label", "synonyms"?, "description"?, "children"?}`: a node with `children` is a
container, any other node is a leaf; missing `synonyms` is `[]`, missing `description` is `""`.
`input.query` is the filter text. `expected` is the whole result
`{"matches", "expand", "total", "synonymHit"}`.

The tree (6 leaves). It is an illustrative fixture, not the live map: it keeps a nested `Charts`
container from an earlier layout (the charts are plain session tabs now, so the real map has no
`…/tab:charts/chart:*` nodes) because a leaf three containers deep is what exercises the
ancestor expansion of the rules above.

- `questions` "Start from a question"
  - `question:expensive` "Why was this session expensive?" (cost, spend, why, money)
- `repo:1` "log-hub"
  - `repo:1/view:cost` "Cost" (expensive, spend, money) "Cost per day, model and user over a period."
  - `repo:1/session` "Session"
    - `repo:1/session/group:cost-context` "Cost & context"
      - `…/tab:charts` "Charts"
        - `…/chart:call-tree` "Call tree" (cost, calls, expensive, spend) "Cost of every call in the session tree."
        - `…/chart:timeline` "Timeline" (time, gantt, duration) "When each agent worked, to the second."
      - `…/tab:sysctx` "System context" (system prompt, startup, claude.md, context, loaded) "What Claude loads at startup and how many tokens each part costs."
    - `repo:1/session/group:effects` "Effects"
      - `…/tab:tools` "Tools/MCP" (mcp, tools, failed, errors, fail) "MCP and monitored CLI tool calls of this session, with failures."

Rows (9): [`docs/algorithm-examples/nav-filter-match.json`](../../algorithm-examples/nav-filter-match.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- "Substring match for every word length" -> NF-04 (timeline would match 'co' through 'second').
- "Any word may match instead of all words" -> NF-05 (tools would match through 'cli').
- "Synonyms tried before the label" -> NF-04, NF-06 (System context would get the synonym hit
  'context' although its label matches).
- "Last matching synonym reported instead of the first" -> NF-03 ('fail' instead of 'failed').
- "Containers matched or counted" -> NF-04, NF-08 ('Cost & context' in matches, total 13).
- "Query not lower-cased" -> NF-07.
- "Whitespace query treated as one empty word that matches everything" -> NF-09.

## Where the result is visible

All views map (`#/map`): the filter box (`map-filter`), the highlighted rows (`map-node-<id>`),
the synonym chip on a row matched by a synonym, the auto-expanded branches, and the counter
"N of M views" (`map-counter`). Tour 05 and scenario S-NAV-01 type into it.
