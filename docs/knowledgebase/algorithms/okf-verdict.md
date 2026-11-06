---
reviewed: no
reviewer: none
---

# OKF verdict: session and repository KB-use rules

## Purpose

The OKF tabs open with a one-line verdict — OK, Something to fix, Mess, KB not used, Not enough
data — and the "Why" lines behind it. The verdict judges **how the KB is laid out for agents**,
not what a session cost: an agent that has to read a quarter of a bundle to do one task, an
article every session reads (its facts probably belong in `index.md` / `CLAUDE.md`), a bundle
agents flood, a big article read in small slices (it should be split or get section pointers).
The rules are pure functions over `session_okf_access` aggregates and snapshot file lists, so a
reader can recompute every verdict by hand.

## Code

- Implementation: `server/src/logs/okf/okf-verdict.ts` — `computeSessionVerdict`,
  `computeRepoVerdict`, `agentEntry`, `startedFromIndex`, `bundleOfPath`, `shareBin`, `median`,
  `withoutUpkeep` / `upkeepPredicate`, and the fixed list sizes.
- Thresholds: `server/src/logs/okf/okf-thresholds.ts` — `DEFAULT_OKF_THRESHOLDS`,
  `resolveOkfThresholds` (read-side merge), `validateOkfThresholds` (settings PUT check); resolved
  per repo by `RepositoriesService.resolveOkfThresholds` (see [../okf-usage.md](../okf-usage.md)).
- Share histogram guard (FR-6): `okf-usage.service.ts` (repo route).
- Team filter applied before the verdict: `server/src/logs/okf/okf-usage-tree.ts`
  (`applyOkfTeamFilter`).
- Caller: `server/src/logs/okf/okf-usage.service.ts` (both routes).
- Verdict text (client): `client/src/viewer/lib/okf/okf-verdict-text.ts` renders rule ids +
  params (unknown rule ids render as the id plus raw params).
- Twins: none.
- Test: `server/src/logs/okf/okf-verdict.algo.spec.ts` (jest).

## Input and output

- A **row** is `{pathKey, op, afterOwnEdit, bytes, calls, seq, rangedCalls?, rangedBytes?,
  searchHits?, nodeId?}` (a `session_okf_access` row or a sum of them; see
  [okf-access-extraction](okf-access-extraction.md)). A *read row* has op `read` or `grep`.
  `nodeId` names the tree node in tree-wide (repo) rows; rows without it count as one node.
- **Thresholds** `t`: the resolved `OkfThresholds` of the view (defaults below), passed as the
  second argument of `computeSessionVerdict` / `computeRepoVerdict`.
- **Hash maps** (repo verdict, optional, DD-18a): `sessionFiles` = per root session, `path →
  {hash, size}` from its bound snapshot; `latestFiles` = the same for the latest snapshot.
- A **bundle** is `{root, index, files: [{path, size}]}` from the snapshot, already team-filtered.
  A path belongs to the bundle with the **deepest** root containing it (`bundleOfPath`).
- Output `OkfVerdict` = `{level, qualifiers, partialData?, findings, checks}`; a finding is `{rule,
  severity: 'fix' | 'mess' | 'info', params, node: {bundle, path?}, stale?, removed?}`; findings
  are ordered worst first (`mess`, then `fix`, then `info`, otherwise in the order below). The
  repo verdict also returns `upkeepOnlySessions` when it is above 0. `checks` (rules 13–14) is one
  `{rule, status: 'ok' | 'finding' | 'na', params}` per structure rule of the level, always
  present — also when the rule found nothing.

## Rules

**Thresholds** (DD-19; they replace the former DD-23 constants). Per-repo settings in
`RepoConfigJson.okf`; every field is optional and falls back to its default. The defaults were
calibrated on the Log Hub repo itself — the probe numbers are in
[`docs/tasks/todo/2026-11-03-okf-view-kb-value/notes.md`](../../tasks/todo/2026-11-03-okf-view-kb-value/notes.md)
(the task folder moves to `docs/tasks/done/` once archived).

| Field | Default | Used by |
|---|---|---|
| `shareMinBundleFiles` | 10 | rules 4, 8 and the repo share histogram (FR-6) |
| `sessionShareFix` | 0.25 | rule 4 |
| `sessionShareMess` | 0.5 | rule 4 |
| `repoMinKbSessions` | 5 | rule 10; the FR-10 minimum of rule 7 |
| `alwaysReadShare` | 0.8 | rule 7 |
| `floodShare` | 0.25 | rule 8 |
| `floodMessSessionShare` | 0.2 | rule 8 |
| `floodMinSessions` | 3 | rule 8 (FR-7) |
| `coarseMinSizeBytes` | 51200 | rule 9 |
| `coarseMinSessions` | 5 | rule 9 |
| `coarseMaxReadRatio` | 0.1 | rule 9 |
| `exploredMinSearches`, `routingMinSearches`, `routingMinAgents`, `pointerMaxArticles`, `areaMaxFiles`, `deadPointerMinShown`, `codeRoots` | — | value signals, see [okf-value-signals](okf-value-signals.md) |

- **Validation on save** (`validateOkfThresholds`, 400 `okf.<field> …`): share fields
  (`sessionShareFix`, `sessionShareMess`, `alwaysReadShare`, `floodShare`,
  `floodMessSessionShare`, `coarseMaxReadRatio`) are numbers in (0, 1]; every other numeric field
  is an integer ≥ 1; `codeRoots` is a non-empty array of at most 50 relative paths without `..`,
  normalised to end in `/`; an unknown field is rejected.
- **Merge on read** (`resolveOkfThresholds`): field by field over the defaults; a stored field
  that fails the save check falls back to its default, so a bad row never fails a read.

**Fixed limits** (not settings): `READ_TOP_N` = 5, `HOT_FILES_TOP_N` = 10, `SHARE_BINS` =
`[0, 0.10, 0.25, 0.50]` (bins `0-10`, `10-25`, `25-50`, `50+`, lower bound inclusive),
`TASK_HEAD_MAX_CHARS` = 200.

**Upkeep** (FR-5, DD-15, `withoutUpkeep`): a `read` / `grep` row is an *upkeep* row when the same
node has a `write` row on the same path — the node is maintaining that article, not using it.
Both verdicts drop upkeep rows first; `write` and `list` rows stay. So an upkeep-only session is
`kb_not_used` (rule 2), and in the repo verdict a tree whose only bundle rows are upkeep reads and
writes is no KB session but counts in `upkeepOnlySessions` (rule 6). Upkeep is computed at read
time from the stored rows.

**Articles** (`bundleArticles`): a bundle's snapshot-listed files without its `index.md`. The index
is the entry point and read by design, so **no analysis counts it**: the share rules (4, 8), the
per-file rules (7, 9), the repo tab's share histogram, the bundle cards' "files read" and the hot
files all work on articles only. It still counts as KB access (rules 1, 6), names the `index`
entry and shows up in plain read lists ("Read · top 5", the tree).

**Session verdict** (`computeSessionVerdict`, DD-24), over the tree's nodes (agents):

1. *KB access* = a read row in a visible bundle, or — when the tree has no snapshot — any read row.
2. No KB access: `null` when there is no bundle (no snapshot, or a snapshot with no bundle);
   otherwise `kb_not_used`.
3. KB access but no snapshot: level `ok`, qualifier `partial_data`, the share rule is skipped.
4. **`session_share`**: for each node and each bundle with ≥ `t.shareMinBundleFiles` articles:
   W = bundle articles the node wrote (`write` rows); total = articles − |W|; read = distinct
   articles not in W with a read row of the node; share = read ÷ total (skipped when total is 0).
   share > `t.sessionShareMess` → `mess`; else share > `t.sessionShareFix` → `fix`; params
   `{agentId, bundle, read, total, share}`.
5. Level = `mess` if any finding is `mess`, else `fix` if any finding, else `ok`. Findings of the
   same severity are ordered by share, highest first.

**Agent entry** (`agentEntry`, DD-26), per node: take the node's non-`write` rows in bundles; the
first by `seq` names the bundle. `index` if that row is the bundle's `index.md`; else `search` if a
`grep` / `list` row of that bundle has `seq` ≤ the `seq` of its first non-index `read`; else
`given`. No such row → `null`.

When any row of the node carries `searchHits` (extracted at `okf_extract_version` ≥ `OKF_SEARCH_HITS_MIN_VERSION` = 2, DD-6), the
`search` test is stricter: the first bundle row must itself be a `grep` / `list` row on a
**folder** key (ending `/`) with `searchHits > 0`, and the node must have a later (`seq` greater)
`read` row in that bundle; otherwise `given`. Rows of an older extraction keep the rule above.

**Repo verdict** (`computeRepoVerdict`, DD-25, DD-38), over the filtered root trees (each tree's
rows from all its nodes):

6. Upkeep rows are dropped first. *KB sessions* = trees with a read row in a visible bundle (any
   read row when no snapshot exists anywhere). A tree with no such row but a `write` row in a
   bundle (an upkeep-only tree) adds 1 to `upkeepOnlySessions` instead. B sessions = KB sessions
   with a read row in bundle B. Rules 7–9 see articles only.
7. **`always_read`** (`fix`): an article f of B with (sessions with a read row on f) ÷ (sessions)
   ≥ `t.alwaysReadShare`, over the FR-10 session set of f (rule 11, minimum
   `t.repoMinKbSessions`); params `{bundle, path, sessions, kbSessions, share}`, where
   `kbSessions` is the size of that set. Snapshot-less trees count.
8. **`kb_flood`**: only for B with ≥ `t.shareMinBundleFiles` articles, only over
   **snapshot-bound** B sessions. A tree is *flooded* when (distinct B articles with a read row) ÷
   (B articles) > `t.floodShare`. Any flooded tree → one finding for B:
   - flooded ≥ `t.floodMinSessions` (FR-7): `mess` when flooded ÷ snapshot-bound B sessions ≥
     `t.floodMessSessionShare`, else `fix`;
   - fewer flooded trees: severity `info` — listed, but it never changes the level.
   Params `{bundle, sessions: flooded, bundleSessions, share, flooded, kbSessions}`.
9. **`coarse_article`** (`fix`), **whole-file reads only** (FR-4, DD-16): per `read` row, whole
   calls = `calls − rangedCalls` and whole bytes = `bytes − rangedBytes`. An article f of B with
   size ≥ `t.coarseMinSizeBytes`; its readers = KB sessions with a `read` row on f that has whole
   calls > 0; over the FR-10 session set of the readers (minimum `t.coarseMinSessions`) with ≥
   `t.coarseMinSessions` sessions, avgReadBytes = Σ whole bytes ÷ Σ whole calls, ratio =
   avgReadBytes ÷ size < `t.coarseMaxReadRatio`. Section (ranged) reads never make an article
   coarse; `grep` rows are ignored; snapshot-less trees count. Params `{bundle, path, size,
   sessions, avgReadBytes (rounded), ratio}`.
10. Level: 0 KB sessions → `kb_not_used`; 1 … `t.repoMinKbSessions` − 1 → `not_enough_data`
    (findings still listed); otherwise the worst severity among findings that are not `info` and
    not `removed`, `ok` when none. Any snapshot-less KB session adds qualifier `partial_data` and
    `partialData = {withoutSnapshot, total: kbSessions}`.
11. **Stale and removed files** (FR-10, DD-17; only when both hash maps are given). For the
    per-file rules 7 and 9, with the file's latest hash `h` (none → all sessions, no marks):
    - *current* = the sessions whose bound snapshot has the file with hash `h`;
    - |current| ≥ the rule's minimum → the rule runs over *current*;
    - |current| < minimum ≤ |all| → the rule runs over all sessions and the finding carries
      `stale: {sessions: |current|, total: |all|, oldSize}`, `oldSize` = the most common size of
      the file among sessions bound to another version (`null` if unknown);
    - otherwise (too few sessions in any case) → all sessions, no mark.
    - **Removed:** a read article under B's root that the latest snapshot no longer lists, but a
      KB session's own snapshot does, is also judged (size from that older snapshot); its findings
      carry `removed: true` and never count for the level.
12. **Share histogram** (FR-6, repo route): bundles with fewer than `t.shareMinBundleFiles`
    articles are skipped, like rule 8; the tab captions it "bundles of ≥ N files".

**Checks** (2026-11-05): the verdict lists one check per structure rule, so the tab can say what
was counted even when nothing fired — the nearest actual value next to its threshold. They are
computed in the same pass as the rules, from the same inputs. `ok` = the rule did not fire,
`finding` = it did, `na` = it could not run, with `params.reason` (`no_snapshot`, `kb_not_used`,
`small_bundles`, `no_big_articles`). A `null` session verdict has no checks.

13. **Session checks**, in this order:
    - `kb_used`: `{agentsWithKb, agents, folders, articles}` — nodes with KB access (rule 1, after
      upkeep) of all nodes; `folders` = the roots of the bundles some node read (read / grep of a
      path under the root), in bundle order, joined by `, `, and `articles` = their article count
      (both `null` without a snapshot) — OV-21. `finding` when no node has KB access; `folders` /
      `articles` then cover every bundle of the snapshot.
    - `entry`: `{index, search, given, agents}` — nodes per `agentEntry` (on the node's rows as
      given, like `agents[].entry`); always `ok`; `na` when no node entered a bundle.
    - `session_share`: the highest share of rule 4 over (node, bundle) pairs with read > 0 —
      `{agentId, bundle, read, total, share, fix, mess, minFiles}` (thresholds `t.sessionShareFix`,
      `t.sessionShareMess`, `t.shareMinBundleFiles`); when no node read a judged bundle,
      `agentId: null`, read 0, the first judged bundle. `finding` when rule 4 produced a finding;
      `na`: `no_snapshot` (rule 3), `kb_not_used` (rule 2), `small_bundles` (no bundle reaches
      `t.shareMinBundleFiles`).
    - `upkeep`: `{agents, articles, agentId, path}` — nodes with upkeep pairs, distinct upkeep
      articles, the first such node and its first article (sorted); always `ok`.
14. **Repo checks**, in this order:
    - `kb_sessions`: `{kbSessions, sessions, minimum, upkeepOnly}` — `sessions` = all root trees
      of the view, `minimum` = `t.repoMinKbSessions`. `finding` at 0 KB sessions, `na` below the
      minimum (`not_enough_data`), else `ok`.
    - `kb_flood`: over bundles judged by rule 8, the one with the most flooded trees (ties: the
      higher single-tree share) — `{bundle, flooded, bundleSessions, maxShare, floodShare,
      minSessions, minFiles}`, `maxShare` = the highest single-tree article share in it.
      `finding` when flooded ≥ `t.floodMinSessions` (the rule's `fix` / `mess`), `ok` otherwise
      (an `info` flood is `ok` here); `na` `small_bundles` when no bundle is judged.
    - `always_read`: the article with the highest rule-7 share (ties: more sessions) —
      `{bundle, path, sessions, kbSessions, share, threshold}`; `path: null` when no article was
      read. `finding` when that article has the rule-7 finding.
    - `coarse_article`: `bigArticles` = articles of ≥ `t.coarseMinSizeBytes`; `na`
      `no_big_articles` when 0. Otherwise the coarse article, else the big article read whole
      with the lowest ratio, whatever its session count — `{bundle, path, size, sessions,
      avgReadBytes, ratio, bigArticles, minSize, maxRatio, minSessions}` (all `null` / 0 when no
      big article was read whole). `finding` when it is a rule-9 finding.
    - Without a snapshot anywhere the last three are `na` `no_snapshot`; at 0 KB sessions all
      three are `na` `kb_not_used`.

**Team view** (DD-30, `applyOkfTeamFilter`, applied before the verdict): a row stays only when the
accessing tree's own snapshot lists its path `ignored: false` and no contributing snapshot lists it
ignored (a folder row stays when a visible file lies under it); snapshot-less trees contribute
nothing; ignored bundles are dropped and ignored files leave the bundle file lists.

## Edge cases

- Session share boundaries: 0.6 → mess OV-01, 0.3 → fix OV-02, 0.2 → ok OV-03, exactly 0.25 → ok
  OV-04, exactly 0.5 → fix OV-05.
- A bundle under 10 articles is never judged by share: OV-06; the index is not an article: OV-16.
- Own writes leave numerator and denominator: OV-07.
- Many agents each reading one article of a big bundle: OV-08.
- Entry `search` / `index` / `given` / `null`: OV-09, OV-10; a `list` row only, a `write` and a
  read outside the bundle: OV-11.
- No snapshot and no access → `null` OV-12; empty snapshot → `null` OV-13; access without a
  snapshot → `ok` + `partial_data` OV-14.
- Worst finding first across agents: OV-15.
- Repo: 0 KB sessions RV-01; under 5 → `not_enough_data` with the finding kept RV-02;
  `always_read` 44/49 RV-03, 39/49 none RV-04, exactly 0.8 RV-05.
- `coarse_article` RV-06 (grep bytes ignored), file under 50 KB RV-07, ratio exactly 0.10 RV-08.
- `kb_flood` 1 of 20 → `info`, level `ok` (FR-7) RV-09, 4 of 20 → mess RV-10, flooded trees
  without a snapshot not counted RV-11.
- Whole-only coarse ratio, a ranged-only session not a reader (FR-4): RV-15.
- Upkeep: an upkeep-only session is `kb_not_used` OV-17; repo upkeep exclusion, upkeep pairs per
  node and `upkeepOnlySessions` RV-16.
- Three floods → `fix` (FR-7): RV-17; `info` never changing the level: RV-09.
- FR-10: stale finding over all sessions RV-20; a file gone from the latest snapshot is
  `removed` and leaves the level RV-21.
- Threshold overrides: `sessionShareFix` OV-18, `shareMinBundleFiles` (FR-6 guard) OV-19,
  `floodMinSessions` RV-18; an invalid stored field falls back to its default while a valid one
  applies: RV-19.
- Personal vs team view of an ignored file: RV-12, RV-13.
- Nested bundles — the finding names the deepest: RV-14.
- Checks: session `finding` OV-01, OV-15 (highest agent named), `ok` with the nearest share
  OV-03, OV-20 (several agents, upkeep, an agent without KB reads), `na` OV-06, OV-14, OV-17
  (`kb_used` finding); repo `kb_not_used` RV-01, `not_enough_data` RV-02, `ok` nearest
  `always_read` RV-04, `coarse_article` finding RV-06 / ratio at the bar RV-08 / below the
  session minimum RV-22, `info` flood is `ok` RV-09, flood `finding` RV-17, upkeep-only RV-16.

## Examples

`kind` is `session` or `repo`.

- **Bundles** (`input.bundles`, `null` = no snapshot): `{root, files}` with `index` =
  `<root>/index.md`. `files` is either a number N of articles — then the files are
  `<root>/index.md` plus `<root>/a1.md` … `<root>/a<N>.md`, each of size 1000 — or a list of
  `{path, size, ignored?}`.
  Every file is `ignored: false` unless listed so; bundles are never ignored here.
- **Rows** are `{pathKey, op}` plus optional `bytes` (default 0), `calls` (default 1),
  `afterOwnEdit` (default false), `seq` (default: the row's 1-based position in its list), and
  `rangedCalls`, `rangedBytes`, `searchHits`, `nodeId` (absent when not given).
- **Thresholds:** `input.okf` is a raw stored `okf` section; the test passes
  `resolveOkfThresholds(input.okf)` to both verdicts (absent = the defaults).
- `session` rows: `input.nodes` = `[{agentId, rows, count?}]`; a node with `count` N stands for N
  nodes `<agentId>-1` … `<agentId>-N` with the same rows. The test runs
  `computeSessionVerdict({nodes, bundles})` and `agentEntry(rows, bundles)` per node.
  `expected.verdict` is `null` or `{level, qualifiers, findings}`; `expected.entries` (when
  present) lists the entries per node in order.
- `repo` rows: `input.sessions` = `[{count?, hasSnapshot, rows, files?}]`, expanded like nodes.
  When `input.latestFiles` (`{path: {hash, size}}`) is given, it is passed as `latestFiles` and
  each session's `files` (same shape) as its `sessionFiles` entry (FR-10). With
  `"team": true` the test first runs `applyOkfTeamFilter` with each snapshot-bound session's
  snapshot = the input bundles (with their `ignored` flags) and passes the filtered rows and
  bundles on. The test runs `computeRepoVerdict({sessions, bundles})`; `expected.verdict` is
  `{level, qualifiers, partialData?, upkeepOnlySessions?, findings}`.
- Findings compare exactly on `rule`, `severity`, `stale`, `removed` (absent = false) and the
  listed `params` (shares within 1e-9).
- `expected.verdict.checks` (optional): the checks in order, `rule` and `status` exact, the
  listed `params` compared (non-integer numbers within 1e-9, `null` exact). Every non-null
  verdict must carry `checks`.

Rows (43): [`docs/algorithm-examples/okf-verdict.json`](../../algorithm-examples/okf-verdict.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- `>=` instead of `>` for the session thresholds -> OV-04 (fix), OV-05 (mess).
- No `t.shareMinBundleFiles` check -> OV-06 (mess).
- Own writes kept in the denominator or the numerator -> OV-07 (0.4 or 4/6).
- Share computed over the whole tree instead of per agent -> OV-15 (one finding instead of two).
- `list` rows counted as KB access -> OV-11 (`ok` instead of `kb_not_used`), RV-01.
- `null` vs `kb_not_used` swapped, or an empty snapshot treated as one with bundles -> OV-12,
  OV-13.
- The share rule run without a snapshot -> OV-14 (finding / no `partial_data`).
- Findings not ordered worst first -> OV-15.
- Entry: grep after the first read still counted as `search` -> OV-10 (`sub1`); index not
  recognised -> OV-06, OV-10.
- `not_enough_data` dropping the findings -> RV-02.
- `>` instead of `>=` for `t.alwaysReadShare` -> RV-05; index files judged -> RV-03 (`index.md`).
- `grep` bytes or calls counted by `coarse_article` -> RV-06 (ratio over 0.1); no size threshold ->
  RV-07; `<=` instead of `<` -> RV-08.
- `kb_flood` severity by `>` instead of `>=` -> RV-10 (fix); snapshot-less trees counted -> RV-11;
  a single flooded tree changing the level -> RV-09 (`fix` instead of `ok`).
- Team filter not applied before the verdict -> RV-13.
- Shallowest bundle owning a nested path -> RV-14.
- Ranged calls or bytes kept in the coarse ratio -> RV-15 (no finding); a ranged-only session
  counted as a reader -> RV-15 (`sessions` 6).
- Upkeep not dropped -> OV-17 (`ok`), RV-16 (no finding); upkeep keyed by path only, not by
  (node, path) -> RV-16 (`kbSessions` 5).
- `floodMinSessions` ignored -> RV-09 (`fix`); `>` instead of `>=` -> RV-17 (`info`).
- Stale sessions not used when the current ones are too few -> RV-20 (no finding); a removed file
  counted in the level -> RV-21 (`fix`).
- The stored `okf` section applied whole, or an invalid field taken as is -> RV-19.
- Checks: the first agent kept instead of the highest share -> OV-15 (`aaaa1111`); upkeep reads
  kept in the share -> OV-20 (main 2/9); `kb_used` listing every snapshot folder instead of the
  read ones -> OV-21 (`docs/kb, docs/kb-local, docs/watch`); `kb_used` counting upkeep reads -> OV-17 (`ok`); an
  `info` flood reported as `finding` -> RV-09; the nearest coarse candidate limited to
  `t.coarseMinSessions` sessions -> RV-22 (`path: null`); `kb_sessions` `ok` below the minimum
  -> RV-02.

## Where the result is visible

- Session pane → **OKF** tab, section "A · How the KB was navigated": the verdict card (badge,
  "partial data" chip, Why lines, the Checks block from `verdict.checks`) and the "How agents
  reached the KB" chips (`✓ index` / `grep` / `given`).
- Repository → **OKF** tab, section A: the verdict card with the Checks block, the structure
  findings; value-signal findings merged into the same level render under section B. The anomaly list (`info` findings grey, a `stale ·
  now X KB` chip, the "custom thresholds" chip), `coarse` / `hot` / `upkeep` / `stale` tree
  markers, the upkeep-only count on the KB sessions tile, the histogram caption.
- Settings → Analysis → **OKF thresholds** (the thresholds table above).
- API: `verdict` of `GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage` and
  `GET /api/v1/repositories/:repoId/reports/okf-usage`; `agents[].entry`.
