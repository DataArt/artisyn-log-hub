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
  and the DD-23 constants.
- Team filter applied before the verdict: `server/src/logs/okf/okf-usage-tree.ts`
  (`applyOkfTeamFilter`).
- Caller: `server/src/logs/okf/okf-usage.service.ts` (both routes).
- Verdict text (client): `client/src/viewer/lib/okf/okf-verdict-text.ts` renders rule ids +
  params (unknown rule ids render as the id plus raw params).
- Twins: none.
- Test: `server/src/logs/okf/okf-verdict.algo.spec.ts` (jest).

## Input and output

- A **row** is `{pathKey, op, afterOwnEdit, bytes, calls, seq}` (a `session_okf_access` row or a
  sum of them; see [okf-access-extraction](okf-access-extraction.md)). A *read row* has op `read`
  or `grep`.
- A **bundle** is `{root, index, files: [{path, size}]}` from the snapshot, already team-filtered.
  A path belongs to the bundle with the **deepest** root containing it (`bundleOfPath`).
- Output `OkfVerdict` = `{level, qualifiers, partialData?, findings}`; a finding is `{rule,
  severity: 'fix' | 'mess', params, node: {bundle, path?}}`; findings are ordered worst first
  (`mess` before `fix`, otherwise in the order below).

## Rules

**Constants** (DD-23): `SHARE_MIN_BUNDLE_FILES` = 10, `SESSION_SHARE_FIX` = 0.25,
`SESSION_SHARE_MESS` = 0.50, `REPO_MIN_KB_SESSIONS` = 5, `ALWAYS_READ_SHARE` = 0.80,
`FLOOD_SHARE` = 0.25, `FLOOD_MESS_SESSION_SHARE` = 0.20, `COARSE_MIN_SIZE_BYTES` = 51200,
`COARSE_MIN_SESSIONS` = 5, `COARSE_MAX_READ_RATIO` = 0.10, `READ_TOP_N` = 5, `HOT_FILES_TOP_N` =
10, `SHARE_BINS` = `[0, 0.10, 0.25, 0.50]` (bins `0-10`, `10-25`, `25-50`, `50+`, lower bound
inclusive), `TASK_HEAD_MAX_CHARS` = 200.

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
4. **`session_share`**: for each node and each bundle with ≥ `SHARE_MIN_BUNDLE_FILES` articles:
   W = bundle articles the node wrote (`write` rows); total = articles − |W|; read = distinct
   articles not in W with a read row of the node; share = read ÷ total (skipped when total is 0).
   share > `SESSION_SHARE_MESS` → `mess`; else share > `SESSION_SHARE_FIX` → `fix`; params
   `{agentId, bundle, read, total, share}`.
5. Level = `mess` if any finding is `mess`, else `fix` if any finding, else `ok`. Findings of the
   same severity are ordered by share, highest first.

**Agent entry** (`agentEntry`, DD-26), per node: take the node's non-`write` rows in bundles; the
first by `seq` names the bundle. `index` if that row is the bundle's `index.md`; else `search` if a
`grep` / `list` row of that bundle has `seq` ≤ the `seq` of its first non-index `read`; else
`given`. No such row → `null`.

**Repo verdict** (`computeRepoVerdict`, DD-25, DD-38), over the filtered root trees (each tree's
rows from all its nodes):

6. *KB sessions* = trees with a read row in a visible bundle (any read row when no snapshot exists
   anywhere). B sessions = KB sessions with a read row in bundle B. Rules 7–9 see articles only.
7. **`always_read`** (`fix`): an article f of B with (KB sessions with a read row on f) ÷
   (KB sessions) ≥ `ALWAYS_READ_SHARE`; params `{bundle, path, sessions, kbSessions, share}`.
   Snapshot-less trees count.
8. **`kb_flood`**: only for B with ≥ `SHARE_MIN_BUNDLE_FILES` articles, only over
   **snapshot-bound** B sessions. A tree is *flooded* when (distinct B articles with a read row) ÷
   (B articles) >
   `FLOOD_SHARE`. Any flooded tree → one finding for B, `mess` when flooded ÷ snapshot-bound B
   sessions ≥ `FLOOD_MESS_SESSION_SHARE`, else `fix`; params `{bundle, sessions: flooded,
   bundleSessions, share}`.
9. **`coarse_article`** (`fix`): an article f of B with size ≥ `COARSE_MIN_SIZE_BYTES`,
   with a `read`-op row in ≥ `COARSE_MIN_SESSIONS` KB sessions, and avgReadBytes = Σ `read` bytes
   ÷ Σ `read` calls over those sessions, ratio = avgReadBytes ÷ size < `COARSE_MAX_READ_RATIO`.
   `grep` rows are ignored; snapshot-less trees count. params `{bundle, path, size, sessions,
   avgReadBytes (rounded), ratio}`.
10. Level: 0 KB sessions → `kb_not_used`; 1 … `REPO_MIN_KB_SESSIONS` − 1 → `not_enough_data`
    (findings still listed); otherwise the worst severity, `ok` when none. Any snapshot-less KB
    session adds qualifier `partial_data` and `partialData = {withoutSnapshot, total: kbSessions}`.

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
- `kb_flood` 1 of 20 → fix RV-09, 4 of 20 → mess RV-10, flooded trees without a snapshot not
  counted RV-11.
- Personal vs team view of an ignored file: RV-12, RV-13.
- Nested bundles — the finding names the deepest: RV-14.

## Examples

`kind` is `session` or `repo`.

- **Bundles** (`input.bundles`, `null` = no snapshot): `{root, files}` with `index` =
  `<root>/index.md`. `files` is either a number N of articles — then the files are
  `<root>/index.md` plus `<root>/a1.md` … `<root>/a<N>.md`, each of size 1000 — or a list of
  `{path, size, ignored?}`.
  Every file is `ignored: false` unless listed so; bundles are never ignored here.
- **Rows** are `{pathKey, op}` plus optional `bytes` (default 0), `calls` (default 1),
  `afterOwnEdit` (default false) and `seq` (default: the row's 1-based position in its list).
- `session` rows: `input.nodes` = `[{agentId, rows, count?}]`; a node with `count` N stands for N
  nodes `<agentId>-1` … `<agentId>-N` with the same rows. The test runs
  `computeSessionVerdict({nodes, bundles})` and `agentEntry(rows, bundles)` per node.
  `expected.verdict` is `null` or `{level, qualifiers, findings}`; `expected.entries` (when
  present) lists the entries per node in order.
- `repo` rows: `input.sessions` = `[{count?, hasSnapshot, rows}]`, expanded like nodes. With
  `"team": true` the test first runs `applyOkfTeamFilter` with each snapshot-bound session's
  snapshot = the input bundles (with their `ignored` flags) and passes the filtered rows and
  bundles on. The test runs `computeRepoVerdict({sessions, bundles})`; `expected.verdict` is
  `{level, qualifiers, partialData?, findings}`.
- Findings compare exactly on `rule`, `severity` and the listed `params` (shares within 1e-9).

Rows (30): [`docs/algorithm-examples/okf-verdict.json`](../../algorithm-examples/okf-verdict.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- `>=` instead of `>` for the session thresholds -> OV-04 (fix), OV-05 (mess).
- No `SHARE_MIN_BUNDLE_FILES` check -> OV-06 (mess).
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
- `>` instead of `>=` for `ALWAYS_READ_SHARE` -> RV-05; index files judged -> RV-03 (`index.md`).
- `grep` bytes or calls counted by `coarse_article` -> RV-06 (ratio over 0.1); no size threshold ->
  RV-07; `<=` instead of `<` -> RV-08.
- `kb_flood` severity by `>` instead of `>=` -> RV-10 (fix); snapshot-less trees counted -> RV-11.
- Team filter not applied before the verdict -> RV-13.
- Shallowest bundle owning a nested path -> RV-14.

## Where the result is visible

- Session pane → **OKF** tab: the verdict card (badge, "partial data" chip, Why lines) and the
  "How agents reached the KB" chips (`✓ index` / `grep` / `given`).
- Repository → **OKF** tab: the verdict card and anomaly list, `coarse` / `hot` tree markers.
- API: `verdict` of `GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage` and
  `GET /api/v1/repositories/:repoId/reports/okf-usage`; `agents[].entry`.
