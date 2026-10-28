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

**Session verdict** (`computeSessionVerdict`, DD-24), over the tree's nodes (agents):

1. *KB access* = a read row in a visible bundle, or — when the tree has no snapshot — any read row.
2. No KB access: `null` when there is no bundle (no snapshot, or a snapshot with no bundle);
   otherwise `kb_not_used`.
3. KB access but no snapshot: level `ok`, qualifier `partial_data`, the share rule is skipped.
4. **`session_share`**: for each node and each bundle with ≥ `SHARE_MIN_BUNDLE_FILES` files:
   W = bundle files the node wrote (`write` rows); total = files − |W|; read = distinct bundle
   files not in W with a read row of the node; share = read ÷ total (skipped when total is 0).
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
   anywhere). B sessions = KB sessions with a read row in bundle B. Index files are excluded from
   the per-file rules.
7. **`always_read`** (`fix`): a non-index file f of B with (KB sessions with a read row on f) ÷
   (KB sessions) ≥ `ALWAYS_READ_SHARE`; params `{bundle, path, sessions, kbSessions, share}`.
   Snapshot-less trees count.
8. **`kb_flood`**: only for B with ≥ `SHARE_MIN_BUNDLE_FILES` files, only over **snapshot-bound**
   B sessions. A tree is *flooded* when (distinct B files with a read row) ÷ (B files) >
   `FLOOD_SHARE`. Any flooded tree → one finding for B, `mess` when flooded ÷ snapshot-bound B
   sessions ≥ `FLOOD_MESS_SESSION_SHARE`, else `fix`; params `{bundle, sessions: flooded,
   bundleSessions, share}`.
9. **`coarse_article`** (`fix`): a non-index file f of B with size ≥ `COARSE_MIN_SIZE_BYTES`,
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
- A bundle under 10 files is never judged by share: OV-06.
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
  `<root>/index.md`. `files` is either a number N — then the files are `<root>/index.md` followed by
  `<root>/a1.md` … `<root>/a<N−1>.md`, each of size 1000 — or a list of `{path, size, ignored?}`.
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

```examples
[
  {
    "id": "OV-01",
    "kind": "session",
    "input": {"bundles": [{"root": "docs/kb", "files": 10}], "nodes": [{"agentId": "a1b2c3", "rows": [
      {"pathKey": "docs/kb/a1.md", "op": "read"}, {"pathKey": "docs/kb/a2.md", "op": "read"}, {"pathKey": "docs/kb/a3.md", "op": "read"},
      {"pathKey": "docs/kb/a4.md", "op": "read"}, {"pathKey": "docs/kb/a5.md", "op": "grep"}, {"pathKey": "docs/kb/a6.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "mess", "qualifiers": [], "findings": [
      {"rule": "session_share", "severity": "mess", "params": {"agentId": "a1b2c3", "bundle": "docs/kb", "read": 6, "total": 10, "share": 0.6}}]}, "entries": ["given"]},
    "note": "Rule 4: 10 files, no writes; 6 distinct files with read rows (grep counts) -> 6/10 = 0.6 > 0.5 -> mess. Entry: first row a1.md is a non-index read and no grep/list comes before it -> given."
  },
  {
    "id": "OV-02",
    "kind": "session",
    "input": {"bundles": [{"root": "docs/kb", "files": 10}], "nodes": [{"agentId": "a1b2c3", "rows": [
      {"pathKey": "docs/kb/a1.md", "op": "read"}, {"pathKey": "docs/kb/a2.md", "op": "read"}, {"pathKey": "docs/kb/a3.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "fix", "qualifiers": [], "findings": [
      {"rule": "session_share", "severity": "fix", "params": {"agentId": "a1b2c3", "bundle": "docs/kb", "read": 3, "total": 10, "share": 0.3}}]}},
    "note": "Rule 4: 3/10 = 0.3: not > 0.5, but > 0.25 -> fix."
  },
  {
    "id": "OV-03",
    "kind": "session",
    "input": {"bundles": [{"root": "docs/kb", "files": 10}], "nodes": [{"agentId": "a1b2c3", "rows": [
      {"pathKey": "docs/kb/a1.md", "op": "read"}, {"pathKey": "docs/kb/a2.md", "op": "read"}, {"pathKey": "docs/kb/", "op": "list"}]}]},
    "expected": {"verdict": {"level": "ok", "qualifiers": [], "findings": []}},
    "note": "Rule 4: the folder list row is no file read; 2/10 = 0.2 <= 0.25 -> no finding -> ok."
  },
  {
    "id": "OV-04",
    "kind": "session",
    "input": {"bundles": [{"root": "docs/kb", "files": 20}], "nodes": [{"agentId": "a1b2c3", "rows": [
      {"pathKey": "docs/kb/a1.md", "op": "read"}, {"pathKey": "docs/kb/a2.md", "op": "read"}, {"pathKey": "docs/kb/a3.md", "op": "read"},
      {"pathKey": "docs/kb/a4.md", "op": "read"}, {"pathKey": "docs/kb/a5.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "ok", "qualifiers": [], "findings": []}},
    "note": "Rule 4: 5/20 = 0.25 exactly; the fix threshold is strictly greater -> ok."
  },
  {
    "id": "OV-05",
    "kind": "session",
    "input": {"bundles": [{"root": "docs/kb", "files": 10}], "nodes": [{"agentId": "a1b2c3", "rows": [
      {"pathKey": "docs/kb/a1.md", "op": "read"}, {"pathKey": "docs/kb/a2.md", "op": "read"}, {"pathKey": "docs/kb/a3.md", "op": "read"},
      {"pathKey": "docs/kb/a4.md", "op": "read"}, {"pathKey": "docs/kb/a5.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "fix", "qualifiers": [], "findings": [
      {"rule": "session_share", "severity": "fix", "params": {"read": 5, "total": 10, "share": 0.5}}]}},
    "note": "Rule 4: 5/10 = 0.5 exactly: not > 0.5 (no mess), > 0.25 -> fix."
  },
  {
    "id": "OV-06",
    "kind": "session",
    "input": {"bundles": [{"root": "docs/kb", "files": 9}], "nodes": [{"agentId": "a1b2c3", "rows": [
      {"pathKey": "docs/kb/index.md", "op": "read"}, {"pathKey": "docs/kb/a1.md", "op": "read"}, {"pathKey": "docs/kb/a2.md", "op": "read"},
      {"pathKey": "docs/kb/a3.md", "op": "read"}, {"pathKey": "docs/kb/a4.md", "op": "read"}, {"pathKey": "docs/kb/a5.md", "op": "read"},
      {"pathKey": "docs/kb/a6.md", "op": "read"}, {"pathKey": "docs/kb/a7.md", "op": "read"}, {"pathKey": "docs/kb/a8.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "ok", "qualifiers": [], "findings": []}, "entries": ["index"]},
    "note": "Rule 4: 9 files < SHARE_MIN_BUNDLE_FILES 10 -> the bundle is skipped even at 9/9 -> ok. Entry: the first row is the index -> index."
  },
  {
    "id": "OV-07",
    "kind": "session",
    "input": {"bundles": [{"root": "docs/kb", "files": 10}], "nodes": [{"agentId": "a1b2c3", "rows": [
      {"pathKey": "docs/kb/a1.md", "op": "write"}, {"pathKey": "docs/kb/a2.md", "op": "write"}, {"pathKey": "docs/kb/a3.md", "op": "write"}, {"pathKey": "docs/kb/a4.md", "op": "write"},
      {"pathKey": "docs/kb/a1.md", "op": "read", "afterOwnEdit": true},
      {"pathKey": "docs/kb/a5.md", "op": "read"}, {"pathKey": "docs/kb/a6.md", "op": "read"}, {"pathKey": "docs/kb/a7.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "fix", "qualifiers": [], "findings": [
      {"rule": "session_share", "severity": "fix", "params": {"read": 3, "total": 6, "share": 0.5}}]}},
    "note": "Rule 4: W = {a1..a4}, total = 10 - 4 = 6; read = {a5, a6, a7} (a1 is in W) = 3; 3/6 = 0.5 -> fix."
  },
  {
    "id": "OV-08",
    "kind": "session",
    "input": {"bundles": [{"root": "docs/kb", "files": 82}], "nodes": [{"agentId": "n", "count": 12, "rows": [
      {"pathKey": "docs/kb/a7.md", "op": "read", "bytes": 100000}]}]},
    "expected": {"verdict": {"level": "ok", "qualifiers": [], "findings": []}},
    "note": "Rule 4 per node: each of the 12 agents read 1 of 82 files = 0.012 -> no finding. Many agents reading the same article is a cost, not a KB layout problem -> ok."
  },
  {
    "id": "OV-09",
    "kind": "session",
    "input": {"bundles": [{"root": "docs/kb", "files": 10}], "nodes": [{"agentId": "a1b2c3", "rows": [
      {"pathKey": "docs/kb/", "op": "grep", "seq": 1}, {"pathKey": "docs/kb/a1.md", "op": "read", "seq": 2}, {"pathKey": "docs/kb/a2.md", "op": "read", "seq": 3}]}]},
    "expected": {"verdict": {"level": "ok", "qualifiers": [], "findings": []}, "entries": ["search"]},
    "note": "Rule 4: 2/10 = 0.2 -> ok. Entry: the first in-bundle row (seq 1) is a grep on the folder, not the index; the first non-index read has seq 2 and the grep's seq 1 <= 2 -> search."
  },
  {
    "id": "OV-10",
    "kind": "session",
    "input": {"bundles": [{"root": "docs/kb", "files": 10}], "nodes": [
      {"agentId": "main", "rows": [{"pathKey": "docs/kb/index.md", "op": "read", "seq": 1}, {"pathKey": "docs/kb/a1.md", "op": "read", "seq": 2}]},
      {"agentId": "sub1", "rows": [{"pathKey": "docs/kb/a2.md", "op": "read", "seq": 1}, {"pathKey": "docs/kb/", "op": "grep", "seq": 2}]},
      {"agentId": "sub2", "rows": [{"pathKey": "src/", "op": "list", "seq": 1}]}]},
    "expected": {"verdict": {"level": "ok", "qualifiers": [], "findings": []}, "entries": ["index", "given", null]},
    "note": "Entry: main's first row is the index -> index; sub1's first non-index read (seq 1) comes before its grep (seq 2) -> given; sub2 never touched a bundle -> null. Shares 2/10 and 1/10 -> ok."
  },
  {
    "id": "OV-11",
    "kind": "session",
    "input": {"bundles": [{"root": "docs/kb", "files": 10}], "nodes": [{"agentId": "a1b2c3", "rows": [
      {"pathKey": "docs/kb/", "op": "list"}, {"pathKey": "docs/kb/a1.md", "op": "write"}, {"pathKey": "docs/other.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "kb_not_used", "qualifiers": [], "findings": []}, "entries": ["search"]},
    "note": "Rule 1: a list row and a write are no read rows, and docs/other.md is outside the bundle -> no KB access; rule 2: a bundle exists -> kb_not_used. Entry: the list row is the first non-write in-bundle row and not the index; no read follows (seq infinity) -> search."
  },
  {
    "id": "OV-12",
    "kind": "session",
    "input": {"bundles": null, "nodes": [{"agentId": "a1b2c3", "rows": []}]},
    "expected": {"verdict": null},
    "note": "Rule 2: no snapshot and no KB access -> null (the tab shows no verdict)."
  },
  {
    "id": "OV-13",
    "kind": "session",
    "input": {"bundles": [], "nodes": [{"agentId": "a1b2c3", "rows": []}]},
    "expected": {"verdict": null},
    "note": "Rule 2: a snapshot with no bundle and no access -> null, like no snapshot."
  },
  {
    "id": "OV-14",
    "kind": "session",
    "input": {"bundles": null, "nodes": [{"agentId": "a1b2c3", "rows": [{"pathKey": "docs/kb/a1.md", "op": "read", "bytes": 900}]}]},
    "expected": {"verdict": {"level": "ok", "qualifiers": ["partial_data"], "findings": []}},
    "note": "Rule 1: without a snapshot any read row is KB access. Rule 3: no file list -> the share rule is skipped -> ok + partial_data."
  },
  {
    "id": "OV-15",
    "kind": "session",
    "input": {"bundles": [{"root": "docs/kb", "files": 10}], "nodes": [
      {"agentId": "aaaa1111", "rows": [{"pathKey": "docs/kb/a1.md", "op": "read"}, {"pathKey": "docs/kb/a2.md", "op": "read"}, {"pathKey": "docs/kb/a3.md", "op": "read"}]},
      {"agentId": "bbbb2222", "rows": [{"pathKey": "docs/kb/a1.md", "op": "read"}, {"pathKey": "docs/kb/a2.md", "op": "read"}, {"pathKey": "docs/kb/a3.md", "op": "read"},
        {"pathKey": "docs/kb/a4.md", "op": "read"}, {"pathKey": "docs/kb/a5.md", "op": "read"}, {"pathKey": "docs/kb/a6.md", "op": "read"}, {"pathKey": "docs/kb/a7.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "mess", "qualifiers": [], "findings": [
      {"rule": "session_share", "severity": "mess", "params": {"agentId": "bbbb2222", "read": 7, "share": 0.7}},
      {"rule": "session_share", "severity": "fix", "params": {"agentId": "aaaa1111", "read": 3, "share": 0.3}}]}},
    "note": "Rule 4: aaaa1111 3/10 = 0.3 -> fix, bbbb2222 7/10 = 0.7 -> mess. Rule 5: worst first (mess before fix) and level mess."
  },
  {
    "id": "RV-01",
    "kind": "repo",
    "input": {"bundles": [{"root": "docs/kb", "files": 10}], "sessions": [
      {"count": 3, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/", "op": "list"}, {"pathKey": "src/main.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "kb_not_used", "qualifiers": [], "findings": []}},
    "note": "Rule 6: a list row is no read row and src/main.md lies in no bundle -> 0 KB sessions. Rule 10 -> kb_not_used."
  },
  {
    "id": "RV-02",
    "kind": "repo",
    "input": {"bundles": [{"root": "docs/kb", "files": 3}], "sessions": [
      {"count": 3, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/a1.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "not_enough_data", "qualifiers": [], "findings": [
      {"rule": "always_read", "severity": "fix", "params": {"bundle": "docs/kb", "path": "docs/kb/a1.md", "sessions": 3, "kbSessions": 3, "share": 1}}]}},
    "note": "Rule 7: a1.md in 3 of 3 KB sessions = 1.0 >= 0.8 -> finding. Rule 10: 3 < REPO_MIN_KB_SESSIONS 5 -> level not_enough_data, the finding stays listed."
  },
  {
    "id": "RV-03",
    "kind": "repo",
    "input": {"bundles": [{"root": "docs/kb", "files": 3}], "sessions": [
      {"count": 44, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/index.md", "op": "read"}, {"pathKey": "docs/kb/a1.md", "op": "read"}]},
      {"count": 5, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/index.md", "op": "read"}, {"pathKey": "docs/kb/a2.md", "op": "grep"}]}]},
    "expected": {"verdict": {"level": "fix", "qualifiers": [], "findings": [
      {"rule": "always_read", "severity": "fix", "params": {"path": "docs/kb/a1.md", "sessions": 44, "kbSessions": 49, "share": 0.8979591836734694}}]}},
    "note": "Rule 7: a1.md in 44 of 49 KB sessions = 0.898 >= 0.8 -> fix; a2.md 5/49 no; index.md is excluded although read in 49/49. 49 >= 5 -> level fix. Bundle of 3 files -> no kb_flood."
  },
  {
    "id": "RV-04",
    "kind": "repo",
    "input": {"bundles": [{"root": "docs/kb", "files": 3}], "sessions": [
      {"count": 39, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/index.md", "op": "read"}, {"pathKey": "docs/kb/a1.md", "op": "read"}]},
      {"count": 10, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/index.md", "op": "read"}, {"pathKey": "docs/kb/a2.md", "op": "grep"}]}]},
    "expected": {"verdict": {"level": "ok", "qualifiers": [], "findings": []}},
    "note": "Rule 7: 39/49 = 0.796 < 0.8 -> no finding; a2.md 10/49 no -> ok."
  },
  {
    "id": "RV-05",
    "kind": "repo",
    "input": {"bundles": [{"root": "docs/kb", "files": 3}], "sessions": [
      {"count": 4, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/a1.md", "op": "read"}]},
      {"count": 1, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/a2.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "fix", "qualifiers": [], "findings": [
      {"rule": "always_read", "severity": "fix", "params": {"path": "docs/kb/a1.md", "sessions": 4, "kbSessions": 5, "share": 0.8}}]}},
    "note": "Rule 7: 4/5 = 0.8 exactly, the threshold is >= -> fix; 5 KB sessions -> level fix."
  },
  {
    "id": "RV-06",
    "kind": "repo",
    "input": {"bundles": [{"root": "docs/kb", "files": [{"path": "docs/kb/index.md", "size": 2000}, {"path": "docs/kb/big.md", "size": 164864}, {"path": "docs/kb/a2.md", "size": 1000}]}], "sessions": [
      {"count": 14, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/big.md", "op": "read", "bytes": 16384, "calls": 4}, {"pathKey": "docs/kb/big.md", "op": "grep", "bytes": 900000, "calls": 1}]},
      {"count": 6, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/a2.md", "op": "read", "bytes": 1000}]}]},
    "expected": {"verdict": {"level": "fix", "qualifiers": [], "findings": [
      {"rule": "coarse_article", "severity": "fix", "params": {"bundle": "docs/kb", "path": "docs/kb/big.md", "size": 164864, "sessions": 14, "avgReadBytes": 4096, "ratio": 0.024844720496894408}}]}},
    "note": "Rule 9: big.md (161 KB = 164864 B >= 51200) read in 14 >= 5 KB sessions; read bytes 14 x 16384 = 229376 over 14 x 4 = 56 calls -> 4096 B/call; 4096 / 164864 = 0.0248 < 0.10 -> fix. The grep rows (900000 B) are ignored. Rule 7: big.md 14/20 = 0.7 and a2.md 6/20 -> no always_read."
  },
  {
    "id": "RV-07",
    "kind": "repo",
    "input": {"bundles": [{"root": "docs/kb", "files": [{"path": "docs/kb/index.md", "size": 2000}, {"path": "docs/kb/big.md", "size": 50176}, {"path": "docs/kb/a2.md", "size": 1000}]}], "sessions": [
      {"count": 14, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/big.md", "op": "read", "bytes": 16384, "calls": 4}]},
      {"count": 6, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/a2.md", "op": "read", "bytes": 1000}]}]},
    "expected": {"verdict": {"level": "ok", "qualifiers": [], "findings": []}},
    "note": "Rule 9: the same reads, but the file is 49 KB = 50176 B < 51200 -> not judged -> ok."
  },
  {
    "id": "RV-08",
    "kind": "repo",
    "input": {"bundles": [{"root": "docs/kb", "files": [{"path": "docs/kb/index.md", "size": 2000}, {"path": "docs/kb/big.md", "size": 100000}, {"path": "docs/kb/a2.md", "size": 1000}]}], "sessions": [
      {"count": 5, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/big.md", "op": "read", "bytes": 20000, "calls": 2}]},
      {"count": 2, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/a2.md", "op": "read", "bytes": 1000}]}]},
    "expected": {"verdict": {"level": "ok", "qualifiers": [], "findings": []}},
    "note": "Rule 9: 5 sessions, 100000 B over 10 calls = 10000 B/call; 10000 / 100000 = 0.10, not < 0.10 -> no finding. Rule 7: big.md 5/7 = 0.714 -> no always_read."
  },
  {
    "id": "RV-09",
    "kind": "repo",
    "input": {"bundles": [{"root": "docs/kb", "files": 10}], "sessions": [
      {"count": 1, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/a1.md", "op": "read"}, {"pathKey": "docs/kb/a2.md", "op": "read"}, {"pathKey": "docs/kb/a3.md", "op": "read"}]},
      {"count": 19, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/index.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "fix", "qualifiers": [], "findings": [
      {"rule": "kb_flood", "severity": "fix", "params": {"bundle": "docs/kb", "sessions": 1, "bundleSessions": 20, "share": 0.05}}]}},
    "note": "Rule 8: 20 snapshot-bound docs/kb sessions; one read 3/10 = 0.3 > 0.25 -> flooded, the others 1/10. 1/20 = 0.05 < 0.20 -> fix. Rule 7: a1..a3 1/20 each; index excluded."
  },
  {
    "id": "RV-10",
    "kind": "repo",
    "input": {"bundles": [{"root": "docs/kb", "files": 10}], "sessions": [
      {"count": 4, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/a1.md", "op": "read"}, {"pathKey": "docs/kb/a2.md", "op": "read"}, {"pathKey": "docs/kb/a3.md", "op": "read"}]},
      {"count": 16, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/index.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "mess", "qualifiers": [], "findings": [
      {"rule": "kb_flood", "severity": "mess", "params": {"bundle": "docs/kb", "sessions": 4, "bundleSessions": 20, "share": 0.2}}]}},
    "note": "Rule 8: 4 of 20 flooded = 0.2 >= FLOOD_MESS_SESSION_SHARE 0.20 -> mess. Rule 7: a1..a3 4/20 = 0.2 -> no always_read."
  },
  {
    "id": "RV-11",
    "kind": "repo",
    "input": {"bundles": [{"root": "docs/kb", "files": 10}], "sessions": [
      {"count": 4, "hasSnapshot": false, "rows": [{"pathKey": "docs/kb/a1.md", "op": "read"}, {"pathKey": "docs/kb/a2.md", "op": "read"}, {"pathKey": "docs/kb/a3.md", "op": "read"}]},
      {"count": 16, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/index.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "ok", "qualifiers": ["partial_data"], "partialData": {"withoutSnapshot": 4, "total": 20}, "findings": []}},
    "note": "Rule 8 counts only snapshot-bound trees: the 4 flooding trees have no snapshot, the 16 bound ones read 1/10 -> no kb_flood. Rule 10: 4 of 20 KB sessions without a snapshot -> partial_data {4, 20}."
  },
  {
    "id": "RV-12",
    "kind": "repo",
    "input": {"bundles": [{"root": "docs/kb", "files": [{"path": "docs/kb/index.md", "size": 1000}, {"path": "docs/kb/secret.md", "size": 1000, "ignored": true}, {"path": "docs/kb/a2.md", "size": 1000}]}], "sessions": [
      {"count": 5, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/index.md", "op": "read"}, {"pathKey": "docs/kb/secret.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "fix", "qualifiers": [], "findings": [
      {"rule": "always_read", "severity": "fix", "params": {"path": "docs/kb/secret.md", "sessions": 5, "kbSessions": 5, "share": 1}}]}},
    "note": "Personal view (no team filter): the gitignored secret.md is read in 5/5 -> always_read fix."
  },
  {
    "id": "RV-13",
    "kind": "repo",
    "team": true,
    "input": {"bundles": [{"root": "docs/kb", "files": [{"path": "docs/kb/index.md", "size": 1000}, {"path": "docs/kb/secret.md", "size": 1000, "ignored": true}, {"path": "docs/kb/a2.md", "size": 1000}]}], "sessions": [
      {"count": 5, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/index.md", "op": "read"}, {"pathKey": "docs/kb/secret.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "ok", "qualifiers": [], "findings": []}},
    "note": "Team view: secret.md is ignored, so its rows and its file-list entry are removed before the verdict; the sessions stay KB sessions through index.md (5 >= 5), and no finding names the ignored file -> ok."
  },
  {
    "id": "RV-14",
    "kind": "repo",
    "input": {"bundles": [{"root": "docs/kb", "files": 3}, {"root": "docs/kb/api", "files": 3}], "sessions": [
      {"count": 5, "hasSnapshot": true, "rows": [{"pathKey": "docs/kb/api/a1.md", "op": "read"}]}]},
    "expected": {"verdict": {"level": "fix", "qualifiers": [], "findings": [
      {"rule": "always_read", "severity": "fix", "params": {"bundle": "docs/kb/api", "path": "docs/kb/api/a1.md", "sessions": 5, "kbSessions": 5, "share": 1}}]}},
    "note": "docs/kb/api/a1.md lies under both roots; the deepest, docs/kb/api, owns it, and only that bundle's file list contains it -> one always_read naming docs/kb/api."
  }
]
```

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
