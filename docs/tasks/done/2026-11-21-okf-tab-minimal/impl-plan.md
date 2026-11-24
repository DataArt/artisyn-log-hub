# Implementation plan — 2026-11-21 OKF Tab — Cut Down to Four Clear Views

## TL;DR

- **One response shape for both routes.** `GET …/reports/okf-usage` and
  `GET …/sessions/:id/okf-usage` both return the new `OkfUsageResponse` (see API changes); every
  old field (`verdict`, `tiles`, `tree`, `hotFiles`, `agents`, …) is removed, not deprecated.
- **Two routes deleted:** `GET …/reports/okf-usage/article` and
  `GET …/sessions/:id/okf-usage/trail`.
- **New pure server module** `okf-usage-counting.ts` (`buildOkfUsageView`, `pickReferenceRoot`)
  with a new algorithm doc `okf-usage-counting.md`; `okf-verdict.ts`, `okf-value-signals.ts`,
  `okf-thresholds.ts`, `okf-trail.ts`, `okf-usage-tree.ts` and their docs / rows are deleted. The
  helpers kept code needs move to new `okf-paths.ts` and `okf-team-filter.ts`.
- **Settings contract change:** `okfDefaults` / `okfFixedLimits` leave the settings responses; a
  PUT with an `okf` section is accepted, never validated, and the stored section is kept as it was
  (the contract row that expected 400 now expects 200).
- **DB: no migration.** The writer stops touching `session_okf_event` / `session_okf_pointer`
  (tables stay); `sessions.okf_extract_version` is still written.
- **Client:** 41 OKF files deleted, one shared view (`okf/view/`) used by both tabs; the Settings
  "OKF thresholds" section, `okfArticle` / `okfAgent` URL params and the Bytes/Calls toggle go.
- **Three deviations from the letter of the acceptance criteria** — see Design Decisions 3, 21 and
  22 (definition of T, a new algorithm doc, where the 1600×1000 and old-hook steps live).
- **No hook change, no new npm package.** The marketing site (`site/`) is out of scope (DD-24).

## Reference

- Requirements: [requirements.md](requirements.md)
- Wireframes: [repo tab](wireframes/repo-okf-tab.svg), [session tab](wireframes/session-okf-tab.svg),
  [states and tooltips](wireframes/okf-states-and-tooltip.svg)
- Planning PoC (counting rules and cost on real data): `docs/pocs/2026-11-21-2004-okf-kb-cost-sql/`

## Design Decisions

Numbering is referenced from the chunk items ("DD-n").

### Counting (server)

1. **Read row.** A row of `session_okf_access` counts when `op` is `read` or `grep`, its
   `path_key` has none of `* ? [ ] { }` (regex `/[*?[\]{}]/`; older extractor versions stored glob
   paths — 429 such rows in the PoC period), and `bundleOfPath(pathKey, bundles)` returns a bundle
   of the reference snapshot. `after_own_edit` rows count. `list` / `write` rows, dot-paths under a
   bundle root and paths outside every bundle count nowhere.
2. **Units.** `reads` = Σ `calls`; `tokens` = Σ `bytes` / `OKF_BYTES_PER_TOKEN` (= 4, new
   constant in `okf-constants.ts`), not rounded on the server. Repo route:
   unit = root session, `unitsTotal` (M) = `loadScopedRootSessions(...)` length, `unitsRead` (N) =
   roots with ≥ 1 read row in any node. Session route: unit = tree node (agent); the tree is the opened session and its descendants
   (`loadTreeNodes`, as today — the UI opens root sessions only), `unitsTotal` =
   the opened node plus its descendants that have a `claude` or `claude-subagent` log (the opened
   node always counts), `unitsRead` = nodes with ≥ 1 read row.
3. **T (`summary.spend`).** Σ `session_costs.cost` over every node (root and descendants) of the M
   trees (repo) or of the opened tree (session); `null` when no node has a non-null `cost`. This is
   the basis of the `$3,017` in the requirements (PoC: `$3,020`). It is not the Sessions-list /
   Spend tree total (which adds utility calls and max(transcript, OTEL)), and the Spend tab has no
   branch / user / attribute filters, so "equals the Spend tab's total" of the AC is checked as
   "equals Σ `session_costs.cost` of the same trees" in the contract row.
4. **KB cost (FR-5a).** Per node: `ctxTokens = input_tokens + cache_write_tokens`
   (`session_stats`), `ctxCost = cost_input + cost_cache_write_5m + cost_cache_write_1h +
   cost_cache_read` (`session_costs`, NULL parts as 0), `null` when `session_costs.cost` is NULL or
   the row is missing. Node KB cost = `min(1, kbTokens / ctxTokens) × ctxCost`; no cost when
   `ctxCost` is `null` or `ctxTokens ≤ 0`. A row's cost = node KB cost × row tokens / node KB
   tokens; file, folder-search and summary costs are sums of row costs, so they add up exactly.
   `stale` cost rows are used as they are. `cost` of a file / search / summary is `null` only when
   it has reads and none of them has a cost, and `0` when it has no reads.
   `summary.readsWithoutCost` = Σ `calls` of read rows on nodes without a cost.
5. **Files.** `files[]` = every file of the (team-filtered, bundle-filtered) reference snapshot
   bundles, each under its own bundle root (`inSnapshot: true`, `units: 0` when never opened), plus
   every read file path not in the snapshot (`inSnapshot: false`, `bundle` = deepest root).
   `index: true` for `isReservedOkfName(path)` (`index.md` / `log.md`, any depth, any case). Sorted
   by `path` ascending.
6. **Folders.** `folders[]` has one entry per bundle root and per folder that contains a snapshot
   file or has a folder-level read row. `units` = distinct units with a read row on any in-snapshot
   file under the folder or a folder-level row on it or below it. `search` = the folder-level rows
   whose `path_key` is exactly this folder (any `read` / `grep` row with a folder key), `null` when
   there are none. Folder keys end in `/`; a bundle root is `rootFolderKey(root)`. A folder belongs
   to the deepest bundle, so a nested bundle's files and folders never count in the outer one.
   `notInSnapshotUnits` = distinct units with a read row on a `inSnapshot: false` file.
7. **Reference snapshot.** Repo route: among the scoped roots that have a stored snapshot, the
   newest (`startTime`) whose branch is in `OKF_DEFAULT_BRANCH_NAMES = ['main', 'master']`
   (`okf-constants.ts`); when none, the newest of all. Session route: the snapshot bound to the
   tree's root. `snapshot.branch` = that root's `logs.git_branch` (may be `null`),
   `snapshot.takenAt` = `okf_snapshots.created_at`. No stored "default branch" exists anywhere in
   the product; the name list is the rule.
8. **No snapshot.** `snapshot: null` → every array empty, every number `0`, `cost` / `spend`
   `null`, `format: null`. Also the response for a session the scope cannot see.
9. **Team view.** `applyOkfTeamFilter` runs before counting, unchanged in behaviour: ignored
   bundles and files leave the snapshot, a row is kept only when the tree's own snapshot lists the
   path as not ignored, and a tree without its own snapshot contributes no rows (it still counts in
   M). In the personal view a tree without its own snapshot is counted against the reference
   snapshot like any other.
10. **Bundle filter (`bundle` query param, repo route).** A known root narrows `versions`,
    `format`, `files`, `folders` and every read number to that bundle; `unitsTotal`, `spend` and
    `bundleRoots` stay those of the whole scope. An unknown or empty value means all bundles.
11. **Versions and format.** `snapshot.hasMeta` = some bundle passes `hasHookMeta`. Without it
    `versions` is `[]` and `format` is `null` (the client shows the old-hook line once). With it:
    one `versions` row per bundle (`files` = `bundle.files.length`, index files included;
    `okfVersion` = `bundle.okfVersion ?? null`; `older` = `okfVersionHint(bundle.okfVersion)`;
    `ignored` = `bundle.ignored`), and `format` over `bundleArticles(bundle)` with
    `articleMetaFlags(file, bundle, refMs)` — `refMs` = now (repo) / the opened session's start
    (session). Groups in the fixed order `no_front_matter`, `no_type`, `v01_timestamp`,
    `deprecated`, `past_stale_after`; empty groups are omitted; an article may sit in several
    groups; `withProblems` counts distinct articles.
12. **Order.** `versions` and `bundleRoots` by root ascending; `folders` by path ascending.

### Server structure

13. **Helper homes.** New `server/src/logs/okf/okf-paths.ts` takes, unchanged in behaviour,
    `isDotPathUnderRoot`, `isReservedOkfName`, `bundleOfPath`, `bundleArticles`, the private
    `normaliseRoot` / `isUnderRoot`, plus `isFolderKey`, `rootPrefix`, `rootFolderKey`,
    `isUnderPrefix` (from `okf-usage-tree.ts`) and the row type `OkfUsageRow { pathKey; op;
    afterOwnEdit?; bytes; calls }` (replaces `OkfVerdictRow`; not the wider `OkfAccessRow` of
    `okf-access-extractor.ts`). New `okf-team-filter.ts` takes the
    team filter, behaviour unchanged, without the `pointers` / `events` handling:

    ```ts
    export interface OkfTeamFilterTree {
      /** The tree's own bound snapshot; null = none. */
      snapshot: OkfSnapshotBody | null;
      nodes: { rows: OkfUsageRow[] }[];
    }
    export function applyOkfTeamFilter<T extends OkfTeamFilterTree>(
      trees: readonly T[],
      bundles: readonly OkfSnapshotBundle[] | null,   // reference snapshot bundles
    ): { trees: T[]; bundles: OkfSnapshotBundle[] | null };
    ```

    The service keeps one tree object per root (`{ rootId, snapshot, nodes: { id, rows }[] }`),
    filters them in a team view, then flattens every tree's nodes into `OkfCountingInput.nodes`
    (`unit` = `rootId` on the repo route, the node `id` on the session route), joining
    `ctxTokens` / `ctxCost` by node id. The rules are documented in the new
    `okf-usage-counting.md`.
14. **Pure module seam.** `okf-usage-counting.ts` exports:

    ```ts
    export interface OkfCountingNode {
      /** Root session id (repo route) or node id (session route). */
      unit: number;
      rows: OkfUsageRow[];
      ctxTokens: number;
      /** null = the node has no computed cost. */
      ctxCost: number | null;
    }
    export interface OkfCountingInput {
      unit: OkfUsageUnit;
      /** Reference snapshot bundles after the team filter; null = no snapshot. */
      bundles: OkfSnapshotBundle[] | null;
      snapshot: { branch: string | null; takenAt: string } | null;
      /** Root of the bundle filter; undefined / unknown = all. */
      bundle?: string;
      nodes: OkfCountingNode[];
      unitsTotal: number;
      spend: number | null;
      refMs: number;
    }
    export function buildOkfUsageView(input: OkfCountingInput): OkfUsageResponse;
    export function pickReferenceRoot<R extends { startTime: string; branch: string | null }>(
      roots: readonly R[],   // only roots that have a stored snapshot
    ): R | null;
    ```

    The service only loads rows and calls these; no counting rule lives in the service.
15. **Writer.** `rebuildSessionOkfAccess` keeps `writeSessionOkfAccess` and
    `writeOkfExtractMarker` and no longer calls the event / pointer writers, which are deleted
    with their imports; existing rows in the two tables are left alone (the session-delete path
    keeps deleting them). `extractOkfDetail` and `OKF_EXTRACT_VERSION = 4` are untouched — the
    facts route rebuilds `accessSeq` from transcripts and never reads the tables. The delete of
    those rows in `sessions.service.ts:239-245` stays although no scenario reaches it with data —
    a known exception until the follow-up drops the tables. The contract fixture seed of the two
    tables (`world-v1.sql.ts`) stays.
16. **Settings** (`repositories.service.ts`). The shared config validator no longer validates
    `okf` (remove the block at lines 1060-1062). In both save paths (around 1160-1235), before
    the upsert and when `config` is not `null`: set `config.okf` to the stored row's `okf`
    (delete the key when the stored row has none). `sameConfigIgnoringOkf` stays. Settings
    responses return the stored config as it is and lose `okfDefaults` / `okfFixedLimits`.
    Removed: `resolveOkfThresholds`, `okfCanRecompute`, `OKF_FIXED_LIMITS`, the interfaces
    `OkfFixedLimits` and `ResolvedOkfThresholdsResult` (lines 119-131), the imports from
    `./okf/okf-thresholds` (81-87: `customOkfThresholdFields`, `DEFAULT_OKF_THRESHOLDS`,
    `resolveOkfThresholds`, `validateOkfThresholds`) and from `./okf/okf-verdict` (88-92:
    `HOT_FILES_TOP_N`, `READ_TOP_N`, `TASK_HEAD_MAX_CHARS`). The `OkfThresholds` type in
    `server/src/database/schema/index.ts` stays as the shape of the stored, now unused section
    (comment updated). `POST …/recompute-all-sessions` and `recomputeOkfAccess` stay.

### Client

17. **One view, two tabs.** `client/src/viewer/pages/repository/okf/view/` holds the shared
    components; `RepoOkfTab` and `SessionOkfTab` only fetch and pass `data`. The unit label comes
    from `data.unit` (`sessions` → "Sessions", `agents` → "Agents"). Hot-files sort and the
    explorer filter / open folders are local component state, not URL params. Client constants
    live in `okf/view/okf-view-text.ts`: `OKF_HOT_FILES_TOP = 10` (rows before "Show all") and
    `OKF_FORMAT_FILES_TOP = 10` (files per wrong-format group before "show all"). The stacking
    breakpoint is the Tailwind container variant `@[56rem]:` already used by the session tab.
18. **Explorer tree is built on the client** from `files[]` and `folders[]` (pure
    `okf-explorer-tree.ts`): roots = bundle roots ascending, then "Not in this snapshot" (flat list
    of full paths, shown under All and Opened only, hidden when empty). Inside a folder: the search
    row, sub-folders ascending, files ascending. Folder numbers: "X of Y files opened" and
    ≈ tokens are sums over its in-snapshot files (tokens also add the searches on it and below);
    units come from `folders[].units`. Header X / Y = sums over the bundle roots. The tree build
    only sums server values, so it has no algorithm rows; `@S-REPO-16` checks its sums.
19. **Display formats** (`client/src/viewer/lib/okf/okf-format.ts`, documented and row-tested in
    `okf-usage-counting.md`):

    | Function | Rule | Examples |
    |---|---|---|
    | `formatApproxTokens(n)` | `0` → `0`; ≥ 1,000,000 → two decimals + `M`; ≥ 100,000 → integer + `K`; else one decimal + `K` | `3771600` → `3.77M`, `270000` → `270K`, `55000` → `55.0K`, `600` → `0.6K` |
    | `formatApproxCost(v, withSign)` | `null` → `—`; `0` → `0.00`; `< 0.005` → `< 0.01`; else two decimals; `withSign` prefixes `$` (`< $0.01`) | `52.61` → `$52.61`, `2.59` (no sign) → `2.59` |
    | `formatSpend(v)` | ≥ 1000 → integer with `,` thousands separators; else two decimals; always `$` | `3017.4` → `$3,017`, `45.58` → `$45.58` |
    | `formatKbShare(cost, spend)` | `null` when `cost` or `spend` is `null` or `spend ≤ 0`; `p = cost / spend × 100`; `p ≥ 10` → integer; `p ≥ 0.1` → one decimal; `0 < p < 0.1` → `< 0.1 %`; `0` → `0 %` | `52.61 / 3017` → `1.7 %` |

    The `/ 4` is done by the server; the client never uses `BYTES_PER_TOKEN` (3.5) here.
20. **Test ids and texts** — the contract between the client chunks and the scenario chunks:

    | Element | `data-testid` (attributes) | Text |
    |---|---|---|
    | tab roots | `repo-okf-tab`, `session-okf-tab` | — |
    | filter strip, bundle select | `okf-filter-strip`, `okf-bundle-select` (kept) | — |
    | loading, error | `okf-loading`, `okf-error` (kept) | "No access" / "Error — KB usage could not be loaded." |
    | no snapshot | `okf-no-snapshot` | "No KB snapshot — update the hook." + link "How to update" → `#/api-keys` |
    | summary line | `okf-summary`; parts `okf-summary-ratio`, `okf-summary-tokens`, `okf-summary-cost`, `okf-summary-share`, `okf-summary-snapshot` | repo: "KB read in **N of M** sessions"; session: "KB read by **N of M** agents"; "≈ X tokens of context"; "≈ $Y"; "(≈ P % of $T spend)"; "snapshot from `branch`, date" |
    | versions | `okf-versions` (`data-collapsed`), `okf-versions-toggle`, `okf-version-row` (`data-root`), `okf-version-older` | collapsed: "K KB folders, all on format 0.3"; row: path, "N files", version or "not declared", "older than the current format 0.3"; a gitignored bundle gets the chip "not in git" |
    | old hook | `okf-old-hook-line` | "Update the hook to see versions and format problems." |
    | wrong format | `okf-format`, `okf-format-ok`, `okf-format-group` (`data-problem`), `okf-format-file` | ok: "All N articles are well-formed · K index files are not checked"; header: "Wrong format — P of N articles"; group titles: No front matter / No "type" in the front matter / Old "timestamp" key (format 0.1) / Deprecated / Past its "stale after" date; a deprecated file with a replacement: "path → replaced by X" |
    | hot files | `okf-hot-files`, `okf-hot-row` (`data-path`), `okf-hot-sort-units` / `-reads` / `-tokens` / `-cost` (`aria-sort` on the `th`), `okf-hot-show-all`, `okf-hot-index-line` | columns: File, Sessions / Agents, Reads, ≈ Tokens, ≈ $; "Show all N files"; "K index files are not listed: ≈ X tokens, ≈ $Y — see the explorer" |
    | explorer | `okf-tree`, `okf-tree-header`, `okf-tree-filter-all` / `-opened` / `-never`, `okf-tree-row` (`data-path`, `data-kind` = `bundle` / `folder` / `file` / `search` / `missing-root`, `data-opened`) | header: "X of Y files opened" (session: "… opened in this session"); chips: "All", "Opened (X)", "Never opened (Y − X)"; search row: "searches across this folder"; last root: "Not in this snapshot" |

    More ids: tooltip triggers `okf-tip-cost` (summary and hot-files header), `okf-tip-reads`,
    `okf-tip-tokens`, `okf-tip-snapshot`, `okf-tip-missing`, `okf-tip-search`,
    `okf-tip-format`; the "not in git" chip `okf-version-ignored` (also on the explorer root);
    the per-group "show all" of Wrong format `okf-format-show-all`.

    Tooltips (exact): **≈ $ / share** — "For each agent: the KB share of what it put into its
    context × what that context cost (input + cache write + cache read; output is not included).
    Assumes KB text is carried and re-read from the cache like the rest of the context. Spend =
    total cost of the same sessions." followed by "All reads in this period have a cost." or
    "N reads have no cost (their agent has no computed cost)."; **Reads** — "Read and search (grep)
    calls that returned text of this file."; **≈ Tokens** — "Bytes returned by those calls ÷ 4 —
    not the size of the file."; **snapshot** — "The list of KB files as of this branch and date.
    "Never opened" is measured against it."; **Not in this snapshot** — "Files that were read but
    are not in the snapshot shown: deleted, renamed, or on another branch."; **searches across
    this folder** — "Searches over the whole folder; not included in any file's numbers.";
    **current format** — "The format version each KB folder declares in its index.md
    (okf_version)."

### Tests and scope

21. **New algorithm doc.** The FR-0 / FR-5a rules, the moved helper rules (articles, dot-paths,
    deepest bundle), the team filter, the reference-snapshot choice and the display formats get
    one new doc `docs/knowledgebase/algorithms/okf-usage-counting.md` with rows
    `docs/algorithm-examples/okf-usage-counting.json`, a jest table test and a vitest table test.
    The AC lists only the four remaining docs; this fifth one replaces `okf-verdict` as the home of
    the rules that survive, instead of leaving the cost formula covered only by scenarios.
22. **Scenario homes.** The 1600×1000 fit check is a step of `@S-REPO-16` (the corpus set and the
    golden tour repo carry no OKF snapshot, so the tab there is the one-line state). "Upload from
    hook 2.26" is covered by `@S-COMPAT-01` step 11b (a snapshot without metadata, the shape every
    hook from 2.26.0 to 3.0.x sends); the frozen hooks in the repo are 1.6.2, 2.6.1, 2.28.0 and
    2.32.3 only.
23. **Old clients.** Client and server ship in one build, so the removed response fields have no
    compatibility shim; a browser tab opened before a redeploy shows the OKF tab error until
    reload. Hook-facing routes, the facts route and the upload paths do not change.
24. **Marketing site is out of scope.** `site/pages/features.html`, `site/pages/home.html`,
    `site/deck/index.html` and `site/assets/shots/okf-*.png` keep showing the old tab until a
    follow-up task refreshes them; they use their own image copies, so nothing breaks. The
    in-app help (`user-docs/`) is in scope.
25. **Kept test helper.** `expectOkfTreeFits` stays as it is — the explorer keeps the `okf-tree`
    id — and is still called where the scenarios call it today.

## Files to create/modify

### Server

| Path | Action | Note |
|---|---|---|
| `server/src/logs/okf/okf-paths.ts` | create | DD-13 |
| `server/src/logs/okf/okf-team-filter.ts` | create | DD-13 |
| `server/src/logs/okf/okf-usage-counting.ts` | create | DD-1…12, DD-14 |
| `server/src/logs/okf/okf-usage.types.ts` | rewrite | new types of API changes; `OkfOp`, `OkfArticleHint`, `OkfFactsResponse`, `OkfFactsSeqItem` stay byte-identical |
| `server/src/logs/okf/okf-usage.service.ts` | rewrite | loaders + two public methods + `emptyUsage()` |
| `server/src/logs/okf/okf-constants.ts` | modify | add `OKF_DEFAULT_BRANCH_NAMES`, `OKF_BYTES_PER_TOKEN`; remove `OKF_TRAIL_MAX_ITEMS`, `OKF_TOP_PATTERNS`, `OKF_SEARCH_FOLDER_MIN_DEPTH`, `OKF_CODE_ROOTS_MAX`, `OKF_SEARCH_HITS_MIN_VERSION` |
| `server/src/logs/okf/okf-access-writer.ts` | modify | DD-15 |
| `server/src/logs/okf/okf-metadata.ts`, `okf-snapshot.ts`, `okf-facts.service.ts` | modify | imports → `okf-paths` |
| `server/src/logs/okf/okf-verdict.ts`, `okf-value-signals.ts`, `okf-thresholds.ts`, `okf-trail.ts`, `okf-usage-tree.ts`, `okf-verdict.algo.spec.ts`, `okf-value-signals.algo.spec.ts` | delete | |
| `server/src/logs/okf/okf-usage-counting.algo.spec.ts` | create | table test |
| `server/src/logs/repositories.controller.ts` | modify | session route simplified, `trail` route removed |
| `server/src/logs/reports/reports.controller.ts` | modify | repo route simplified, `article` route removed |
| `server/src/logs/repositories.service.ts` | modify | DD-16 |
| `server/src/database/schema/index.ts` | modify | comment on `RepoConfigJson.okf` only |
| `server/test/contract/registry/f14-repositories.ts`, `f19-change-surface.ts`, `f21-reports.ts`, `f23-export-import.ts` | modify | see Test coverage plan |

### Client

| Path | Action | Note |
|---|---|---|
| `client/src/models/repositories.ts` | modify | mirror of the new types; old OKF types removed |
| `client/src/viewer/api.ts` | modify | return types; drop `fetchSessionOkfTrail`, `getOkfArticle`, `okfDefaults`, `okfFixedLimits`, `OkfFixedLimits` |
| `client/src/viewer/lib/okf/okf-format.ts`, `okf-format.algo.test.ts` | create | DD-19 |
| `client/src/viewer/pages/repository/okf/view/OkfUsageView.tsx`, `OkfSummaryLine.tsx`, `OkfVersionsBlock.tsx`, `OkfWrongFormatBlock.tsx`, `OkfHotFilesTable.tsx`, `OkfExplorer.tsx`, `OkfExplorerRow.tsx`, `OkfNoSnapshotLine.tsx`, `okf-explorer-tree.ts`, `okf-view-text.ts` | create | DD-17, 18, 20 |
| `client/src/viewer/pages/repository/okf/RepoOkfTab.tsx`, `OkfFilterStrip.tsx`, `okf-url-state.ts` | modify | |
| `client/src/viewer/pages/repository/session-log/okf/SessionOkfTab.tsx`, `SessionOkfStates.tsx` | modify | only `LoadingSkeleton` stays in the states file |
| `client/src/viewer/pages/repository/okf/`: `OkfAnalysisCoverageBanner`, `OkfHotFiles`, `OkfKpiTiles`, `OkfNotReadList`, `OkfShareHistogram`, `OkfSignalFindings`, `OkfUpkeepPanel`, `RepoOkfOverview` (`.tsx`), folder `article/` | delete | |
| `client/src/viewer/pages/repository/session-log/okf/`: every file except `SessionOkfTab.tsx` and `SessionOkfStates.tsx` | delete | 22 files |
| `client/src/viewer/lib/okf/okf-action-text.ts`, `okf-agent-label.ts`, `okf-check-text.ts`, `okf-verdict-text.ts` | delete | |
| `client/src/viewer/pages/repository/OkfThresholdsSection.tsx`, `OkfCodeRootsInput.tsx`, `okf-thresholds-form.ts` | delete | |
| `client/src/viewer/pages/repository/RepositorySettings.tsx`, `useRepositoryViewState.ts` | modify | drop the thresholds section and `OKF_AGENT_PARAM` handling |

### Docs

| Path | Action |
|---|---|
| `docs/knowledgebase/okf-usage.md` | rewrite for the four views |
| `docs/knowledgebase/algorithms/okf-usage-counting.md`, `docs/algorithm-examples/okf-usage-counting.json` | create |
| `docs/knowledgebase/algorithms/okf-verdict.md`, `okf-value-signals.md`, `docs/algorithm-examples/okf-verdict.json`, `okf-value-signals.json` | delete |
| `docs/knowledgebase/algorithms/okf-metadata.md`, `okf-access-extraction.md`, `README.md` | modify |
| `docs/knowledgebase/index.md`, `client-component-map.md`, `server-endpoint-map.md`, `db-tables.md`, `user-docs-and-site.md` | modify |
| `user-docs/okf-tab.md`, `user-docs/tuning-your-setup.md`, `user-docs/images/okf-kb-value.png`, `okf-kb-value-heuristic.png`, new `user-docs/images/okf-tab.png` | rewrite / modify / delete / create |
| `client/public/help/*.md` | regenerated by `npm run build:help` |

### Tests

| Path | Action |
|---|---|
| `tests/scenarios/repos/s-repo-16.spec.ts`, `repos/s-repo-09.spec.ts`, `view/s-sess-09.spec.ts`, `view/s-rept-01.spec.ts`, `hook/s-compat-01.spec.ts` | modify |
| `tests/scenarios/tours/screen-registry.ts`, `tours/tour-04-analytics-reports.spec.ts` | modify |
| `tests/scenarios/helpers/okf.ts` | modify (`expectOkfViewFits`) |

## API changes

### Kept, new response

`GET /api/v1/repositories/:repoId/reports/okf-usage` — query unchanged (`teamId`, `startDate`,
`endDate`, `branches`, `users`, `attr`, `bundle`). `GET
/api/v1/repositories/:repoId/sessions/:sessionId/okf-usage` — query unchanged (`teamId`). Guards,
scope resolution and 403 rules unchanged. Both return:

```ts
export type OkfUsageUnit = 'sessions' | 'agents';

export type OkfFormatProblem =
  | 'no_front_matter' | 'no_type' | 'v01_timestamp' | 'deprecated' | 'past_stale_after';

export interface OkfUsageFile {
  /** Deepest bundle root above the file. */
  bundle: string;
  /** Repo-relative path. */
  path: string;
  inSnapshot: boolean;
  /** `index.md` / `log.md`: left out of hot files and of the format checks. */
  index: boolean;
  /** Distinct sessions (repo route) / agents (session route) with a read; 0 = never opened. */
  units: number;
  reads: number;
  /** Bytes returned / 4, not rounded. */
  tokens: number;
  /** USD; null = it has reads and none has a cost. */
  cost: number | null;
}

export interface OkfUsageFolder {
  bundle: string;
  /** Folder key ending in `/`; a bundle root is listed too. */
  path: string;
  units: number;
  /** Folder-level searches on exactly this folder. */
  search: { units: number; reads: number; tokens: number; cost: number | null } | null;
}

export interface OkfUsageVersionRow {
  root: string;
  files: number;
  /** Declared `okf_version`; null = not declared. */
  okfVersion: string | null;
  older: boolean;
  /** Gitignored bundle (owner-only; never present in a team view). */
  ignored: boolean;
}

export interface OkfUsageFormat {
  articles: number;
  indexFiles: number;
  /** Distinct articles with at least one problem. */
  withProblems: number;
  groups: {
    problem: OkfFormatProblem;
    files: { path: string; supersededBy?: string }[];
  }[];
}

export interface OkfUsageResponse {
  unit: OkfUsageUnit;
  /** null = no KB snapshot: the tab is one line and every other field is empty / zero. */
  snapshot: { branch: string | null; takenAt: string; hasMeta: boolean } | null;
  /** Every visible bundle root, also with a `bundle` filter. */
  bundleRoots: string[];
  /** `OKF_CURRENT_FORMAT_VERSION`. */
  currentFormat: string;
  summary: {
    unitsRead: number;
    unitsTotal: number;
    reads: number;
    tokens: number;
    cost: number | null;
    readsWithoutCost: number;
    /** T of DD-3; null = unknown. */
    spend: number | null;
  };
  /** [] when `snapshot.hasMeta` is false. */
  versions: OkfUsageVersionRow[];
  /** null when `snapshot.hasMeta` is false. */
  format: OkfUsageFormat | null;
  files: OkfUsageFile[];
  folders: OkfUsageFolder[];
  notInSnapshotUnits: number;
}
```

Invariants the tests rely on: Σ `files[].tokens` + Σ `folders[].search.tokens` =
`summary.tokens`; the same for `reads` and (within float rounding) `cost`; Σ `versions[].files` =
count of `files` with `inSnapshot`; `format.articles + format.indexFiles` = that same count.

### Removed

- `GET /api/v1/repositories/:repoId/reports/okf-usage/article`
- `GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage/trail`
- Types `SessionOkfUsageResponse`, `RepoOkfUsageResponse`, `SessionOkfTrailResponse`,
  `RepoOkfArticleResponse` and everything only they used.

### Settings routes

`GET …/settings`, `PUT …/settings/user`, `PUT …/settings/team`: responses no longer carry
`okfDefaults` / `okfFixedLimits`; a PUT body with `config.okf` returns 200 and the stored `okf`
is unchanged (DD-16).

### Unchanged

`GET /api/v2/okf-usage/facts` (response byte-identical for the contract fixture, `accessSeq`
included), `POST /api/v2/logs` and the snapshot upload, `POST …/recompute-all-sessions`.

## Database changes

None — no migration. `session_okf_event` and `session_okf_pointer` stay and are no longer written
(DD-15); `repo_config.config.okf` stays where stored and is no longer read. A follow-up task
drops them. `docs/knowledgebase/db-tables.md` notes both as "no longer written / read since
2026-11-21".

## Test coverage plan

**Algorithm** (`okf-usage-counting.md`, rows in `docs/algorithm-examples/okf-usage-counting.json`;
new doc, DD-21). Jest table test `okf-usage-counting.algo.spec.ts` for row kinds `view`
(`buildOkfUsageView`), `teamFilter` (`applyOkfTeamFilter` then `buildOkfUsageView`), `reference`
(`pickReferenceRoot`); vitest table test `okf-format.algo.test.ts` for kind `format`. Rows:

| Id | Kind | Case |
|---|---|---|
| UC-01 | view | `read` and `grep` rows count; `list` and `write` rows change nothing |
| UC-02 | view | a file touched only by `grep` is opened, with tokens |
| UC-03 | view | folder-level `grep`: `folders[].search`, counts in `unitsRead` and totals, in no file |
| UC-04 | view | `.md` outside every bundle and a glob path change nothing |
| UC-05 | view | nested bundle: file goes to the deepest root; Σ `versions[].files` = in-snapshot files |
| UC-06 | view | `index.md` / `log.md`: `index: true`, in totals, not in `format.articles` |
| UC-07 | view | dot-path under a root is not counted |
| UC-08 | view | read file absent from the snapshot: `inSnapshot: false`, `notInSnapshotUnits` |
| UC-09 | view | folder `units` is a union, not a sum |
| UC-10 | view | cost = share × context cost; per-file costs add up to `summary.cost` |
| UC-11 | view | share capped at 1 |
| UC-12 | view | node without a cost: tokens counted, `readsWithoutCost`, `cost: null` when nothing is priced |
| UC-13 | view | `ctxTokens` 0 on a priced node → no cost |
| UC-14 | view | `bundle` filter narrows reads, keeps `unitsTotal` / `spend` / `bundleRoots` |
| UC-15 | view | no snapshot → the empty response of DD-8 |
| UC-16 | view | `unit: 'agents'`: N of M over nodes |
| UC-17 | view | format groups, `withProblems` distinct, deprecated with `supersededBy`, `refMs` for stale |
| UC-18 | view | snapshot without metadata: `hasMeta: false`, `versions: []`, `format: null`, files still counted |
| UC-19 | view | versions: `older` for `0.1` and for an undeclared version, `okfVersion: null` |
| UC-20 | teamFilter | ignored bundle and ignored file leave every number |
| UC-21 | teamFilter | a tree without its own snapshot contributes no reads |
| UC-22 | reference | newest root on `main` wins over a newer root on a feature branch |
| UC-23 | reference | no `main` / `master` root → newest of all; empty list → `null` |
| UC-24…27 | format | one row per function of DD-19, each with its boundary values |

`okf-metadata.json`, `okf-snapshot.json`, `okf-access-extraction.json`, `okf-task-context.json`
keep their rows; `okf-verdict.json` and `okf-value-signals.json` are deleted with their specs.

**API contract** (`server/test/contract/registry/`):

- `f21-reports.ts` — `F21-okf-usage`, `-hot-files`, `-bundles`, `-outsider` rewritten against
  `OkfUsageResponse` (summary numbers and `spend` computed by the row's `read.sql` from
  `session_okf_access`, `session_stats`, `session_costs`); `F21-okf-article*` rows deleted.
- `f19-change-surface.ts` — `F19-okf-session`, `-team`, `-none`, `-outsider` rewritten;
  `-agents`, `-signals` deleted; `-meta-tree`, `-meta-tree-team` rewritten as `versions` /
  `format` expectations; `F19-okf-trail*` deleted.
- `f14-repositories.ts` — `OKF_DEFAULTS` / `OKF_FIXED_LIMITS` leave every settings expectation;
  `F14-put-user-settings-okf` and `F14-put-team-settings-okf` expect 200 and the stored `okf`
  unchanged; `F14-put-user-settings-okf-invalid` expects 200.
- `f23-export-import.ts` — the recompute row no longer lists `session_okf_event` /
  `session_okf_pointer` as rewritten; `okf_extract_version = 4` stays.
- `f16-post-turn.ts` (`F16-okf-facts*`) and `f15-ingest.ts` — untouched; they must pass as they are.

**Scenario** (steps of existing scenarios, no new file):

- `@S-REPO-16` — steps 8–11 rewritten for summary / explorer / bundle filter in team vs personal
  view; steps 12–16 replaced by one FR-0 step (grep-only file, folder grep, `.md` outside the
  bundle, nested bundle, sums) and one hot-files step (sort, index line, same values as the
  explorer, cost column); step 17 rewritten for Versions / Wrong format plus the 1600×1000 fit.
- `@S-SESS-09` — step 8 becomes the session-tab step ("Agents" everywhere, no "Sessions" label,
  removed blocks absent); steps 10, 12 deleted. **S-SESS-09 steps** 9, 11, 13 keep their data:
  - step 9 (tree `ss09okf`): summary "by 2 of 2 agents"; explorer root `docs/kb` expands to a
    `data-kind="search"` row (the `docs/kb` grep), `a03.md` opened (read + file grep),
    `a04.md` opened by the sub-agent, `a06.md` with `data-opened="false"`;
    `expectOkfTreeFits`;
  - step 11 (tree `ss09okf2`): hot files list `a06.md` and `a07.md` with 1 agent each and
    no `server/pay/*` path; summary "by 2 of 2 agents";
  - step 13 (tree `ss09okf3`, bundle `docs/guide`, `okfVersion '0.2'`): `okf-version-row`
    "0.2" with `okf-version-older`; `okf-format-group` `deprecated` (`setup.md` → replaced
    by `install.md`), `past_stale_after` (`install.md`), `no_front_matter` (`old.md`);
    `log.md` and `sub/index.md` in the explorer, not in hot files; `.hidden/notes.md`
    nowhere; the `okf_extract_version = 4` DB check stays.
- `@S-REPT-01` — steps 9–10: summary line "5 of 5" / branch filter "3 of 3", snapshot branch
  `main` although the newest roots are on `feat/okf`.
- `@S-COMPAT-01` — steps 10, 11: one-line no-snapshot state; 11b: old-hook line, hot files and
  explorer populated.
- `@S-REPO-09` — the event / pointer row asserts of steps 5a and 9 and their helper are removed
  (nothing writes those rows any more); the step 5a response asserts move to the new shape. Tours: `screen-registry.ts` empty text, `tour-04` expectation.

## Visual/UX notes

- Layout follows the wireframes: filter strip; summary line with the snapshot on the right;
  one row with Versions (left) and Wrong format (right); below it Hot files (left, wider) and
  Explorer (right). The session pane is narrower than the viewport: below `56rem` of container
  width (container query, as today) the pairs stack — Versions, Wrong format, Hot files, Explorer.
- At 1600×1000 the summary, Versions, Wrong format and the first hot-files row are above the fold;
  Versions is collapsed when every bundle is current, Wrong format is one line when clean, hot
  files shows 10 rows with "Show all N files".
- Hot files: sortable numeric columns with the arrow on the active one (pattern of
  `reports/HarnessUsageTable.tsx`: `aria-sort` on the `th`, a button inside); default ≈ Tokens
  descending, tie-break path ascending; rows are not links; full repo-relative paths, truncated
  from the left with the full path in `title`; ≈ $ cells without the `$` sign.
- Explorer: everything collapsed by default; never-opened file rows are greyed
  (`text-muted-foreground`) with "—" in the number cells; under "Never opened" the only number
  column is "Never opened" and "Not in this snapshot" is hidden; no "N more" cut.
- Tooltips use `ui/tooltip.tsx` (light variant) on an "ⓘ" next to the label; light scheme only;
  no new colours — the "older than the current format" marker and the group counts use the
  existing muted / amber status classes named in `ui-principles.md`.
- **Visual check data.** Dev server and client started per CLAUDE.md "Environment"; log in with
  the test identity of `CLAUDE.local.md`; open the repository returned by
  `SELECT lr.repo_id, count(*) FROM session_okf_access a JOIN logs l ON l.session_id = a.session_id
  JOIN log_repositories lr ON lr.log_id = l.id GROUP BY 1 ORDER BY 2 DESC LIMIT 1` on the dev DB
  (identify as that repository's owner if the list is empty), period "All time"; the session tab
  is checked on that repo's newest session with a snapshot.
- States: loading skeleton, "No access" / "Error — KB usage could not be loaded.", the one-line
  no-snapshot state, the old-hook line in place of Versions and Wrong format.

## Wireframes

No wireframe change. Two notes for the implementer: the session summary uses the wireframe's
wording ("KB read **by** N of M agents"), and the repo filter strip keeps the attribute filter
although the wireframe does not draw it.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Server — pure counting modules | 6 | Additive: new files and new types next to the old ones; the server compiles after it |
| 2 | Server — OKF service and routes | 6 | Consumes chunk 1 through DD-13, DD-14 and API changes |
| 3 | Server — writer, settings, dead code | 5 | Removes what chunk 2 left unused, with its docs, rows and specs |
| 4 | Client — types, formats, shared view | 8 | Additive: builds against API changes and DD-17…20; the client compiles after it |
| 5 | Client — tabs, deletions, settings | 7 | Wires chunk 4's `OkfUsageView` into both tabs; removes the old types |
| 6 | Docs — KB and in-app help | 8 | Describes chunks 1–5; creates the algorithm doc that chunk 7 tests |
| 7 | Tests — algorithm rows and table tests | 5 | Tests chunk 1 and the formats of chunk 4 against the doc of chunk 6 |
| 8 | Tests — contract registry | 5 | Tests chunks 2–3 |
| 9 | Tests — scenario S-REPO-16 | 7 | Uses the test ids of DD-20 |
| 10 | Tests — other scenarios, tours, final run | 6 | Uses the test ids of DD-20 |

### Chunk 1 — Server — pure counting modules

- [ ] Create `server/src/logs/okf/okf-paths.ts` per DD-13: move the listed helpers from `okf-verdict.ts` and `okf-usage-tree.ts` with their doc comments, add `OkfUsageRow`. Do not delete the originals yet; re-export nothing.
- [ ] Create `server/src/logs/okf/okf-team-filter.ts` with the signature of DD-13: `applyOkfTeamFilter` copied from `okf-usage-tree.ts:65-178`, importing from `okf-paths`, without the `pointers` / `events` branches.
- [ ] Append the types of "API changes" to `server/src/logs/okf/okf-usage.types.ts`; leave every existing type in place (chunk 3 removes the old ones).
- [ ] Add `OKF_DEFAULT_BRANCH_NAMES` (DD-7) and `OKF_BYTES_PER_TOKEN` (DD-2) to `okf-constants.ts` and implement `pickReferenceRoot` in new `server/src/logs/okf/okf-usage-counting.ts` with the signature of DD-14.
- [ ] Implement `buildOkfUsageView` in `okf-usage-counting.ts` per DD-1, 2, 4, 5, 6, 8, 10, 12 and DD-14: row filter, per-node KB cost, `files`, `folders`, `notInSnapshotUnits`, `summary`, `bundleRoots`, `currentFormat`.
- [ ] Add versions and format to `buildOkfUsageView` per DD-11, using `hasHookMeta`, `okfVersionHint`, `articleMetaFlags` from `okf-metadata.ts` and `bundleArticles` from `okf-paths.ts`.

### Chunk 2 — Server — OKF service and routes

- [ ] Before any edit, run `npm run perf` from `server/` and save its output to `tmp/okf-perf-baseline.txt` (the baseline for chunk 10).
- [ ] Point the `okf-verdict` imports of `okf-metadata.ts`, `okf-snapshot.ts` and `okf-facts.service.ts` at `okf-paths.ts`.
- [ ] Rewrite `okf-usage.service.ts`: keep `findSessionDbId`, `loadTreeNodes`, `loadRepoTreeRows`, `loadRootSnapshots` (rows reduced to `OkfUsageRow`), add a loader returning per node id `ctxTokens`, `ctxCost` (DD-4) and `cost` from `session_stats` / `session_costs`; delete every signal, trail, article and verdict member.
- [ ] In the service implement `getRepoOkfUsage(repoIds, scope, bundle)`: scoped roots, `pickReferenceRoot` over roots with a snapshot, team filter when `scope.teamId` is set (DD-9, DD-13), `spend` per DD-3, then `buildOkfUsageView` with `unit: 'sessions'`, `refMs: Date.now()`.
- [ ] In the service implement `getSessionOkfUsage(sessionDbId, { teamFilter })` per DD-2, 3, 7 (`unit: 'agents'`, the tree root's snapshot with its `created_at` and branch, `refMs` = opened session start) and `emptyUsage(unit)` per DD-8.
- [ ] Update `repositories.controller.ts` and `reports/reports.controller.ts`: both `okf-usage` handlers return `OkfUsageResponse` and call the new service methods without thresholds / `canRecompute` / prompt mask; delete the `trail` and `article` handlers and their imports.

### Chunk 3 — Server — writer, settings, dead code

- [ ] Apply DD-15 in `okf-access-writer.ts`: remove `writeSessionOkfEvents`, `writeSessionOkfPointers` and their calls; keep the marker write with `detail.truncated`.
- [ ] Apply DD-16 in `repositories.service.ts` (every removal it lists) and the comment in `server/src/database/schema/index.ts`.
- [ ] Delete `okf-verdict.ts`, `okf-value-signals.ts`, `okf-thresholds.ts`, `okf-trail.ts`, `okf-usage-tree.ts`, `okf-verdict.algo.spec.ts`, `okf-value-signals.algo.spec.ts`; their docs `algorithms/okf-verdict.md`, `okf-value-signals.md`; rows `docs/algorithm-examples/okf-verdict.json`, `okf-value-signals.json`; their lines in `algorithms/README.md` and `docs/knowledgebase/index.md`.
- [ ] In `okf-usage.types.ts` remove every type except `OkfOp`, `OkfArticleHint`, `OkfFactsResponse`, `OkfFactsSeqItem` (unchanged) and the types of "API changes"; in `okf-constants.ts` remove the five constants named in "Files to create/modify".
- [ ] Run `npm run lint`, `npm run typecheck` and `npm run test` from `server/`; fix what they report.

### Chunk 4 — Client — types, formats, shared view

- [ ] In `client/src/models/repositories.ts` add a mirror of the types of "API changes" next to the existing OKF types (chunk 5 removes the old ones); do not change `viewer/api.ts` yet.
- [ ] Create `client/src/viewer/lib/okf/okf-format.ts` with the four functions of DD-19.
- [ ] Create `okf/view/okf-view-text.ts` (the two constants of DD-17, labels by `unit`, group titles, every tooltip text of DD-20) and `okf/view/okf-explorer-tree.ts` (pure tree build, filter All / Opened / Never opened, counts) per DD-18.
- [ ] Create `okf/view/OkfSummaryLine.tsx` and `OkfNoSnapshotLine.tsx` with the test ids and texts of DD-20; the share part is omitted when `formatKbShare` returns `null`.
- [ ] Create `okf/view/OkfVersionsBlock.tsx` and `OkfWrongFormatBlock.tsx` per DD-20 and Visual/UX notes: collapsed one-line states, expandable rows / groups, per-group "show all" after `OKF_FORMAT_FILES_TOP` files, the single old-hook line when `snapshot.hasMeta` is false.
- [ ] Create `okf/view/OkfHotFilesTable.tsx`: rows = `files` with `units > 0` and `index` false; sortable columns, top `OKF_HOT_FILES_TOP` with "Show all", the index line computed from `files` with `index` true and `units > 0`; ids of DD-20.
- [ ] Create `okf/view/OkfExplorer.tsx` and `OkfExplorerRow.tsx` over `okf-explorer-tree.ts`: header, three filter chips with counts, collapsed roots, row kinds and attributes of DD-20, greyed never-opened rows.
- [ ] Create `okf/view/OkfUsageView.tsx` (`{ data: OkfUsageResponse }`): the no-snapshot line when `data.snapshot` is null, else the layout of Visual/UX notes with the container-query stacking.

### Chunk 5 — Client — tabs, deletions, settings

- [ ] Rewrite `okf/RepoOkfTab.tsx`: filter strip, loading / error states, `<OkfUsageView>`; bundle select fed from `data.bundleRoots` (drop `knownBundles`, article and settings handlers).
- [ ] Rewrite `session-log/okf/SessionOkfTab.tsx` to fetch and render `<OkfUsageView>`; reduce `SessionOkfStates.tsx` to `LoadingSkeleton`; keep `data-testid="session-okf-tab"`.
- [ ] In `OkfFilterStrip.tsx` remove the Bytes/Calls toggle; in `okf-url-state.ts` remove `heat`, `OKF_ARTICLE_PARAM`, `OKF_AGENT_PARAM`, `okfSessionTrailParams`, `OKF_THRESHOLDS_FOCUS`, `okfThresholdsSettingsParams` and their helpers; keep the filter params and the `okf*` cleanup on leaving the tab.
- [ ] Delete the client files listed as "delete" in "Files to create/modify → Client"; in `viewer/api.ts` make both `okf-usage` fetchers return `OkfUsageResponse` and remove `fetchSessionOkfTrail`, `getOkfArticle`, `okfDefaults`, `okfFixedLimits`, `OkfFixedLimits`; in `models/repositories.ts` remove every old OKF usage type and `OkfThresholds`.
- [ ] Remove the OKF thresholds section and its state from `RepositorySettings.tsx` (lines around 26-29, 161-171, 360-366) and the `OKF_AGENT_PARAM` handling from `useRepositoryViewState.ts`.
- [ ] Run `bun run lint` and `bun run typecheck` from `client/`; remove every import, export and type left unused by the deletions.
- [ ] Visual check per "Visual check data" (Visual/UX notes) with the `use-playwright` skill: both tabs at 1600×1000 and the session tab in the narrow pane against the three wireframes; fix layout differences.

### Chunk 6 — Docs — KB and in-app help

- [ ] Rewrite `docs/knowledgebase/okf-usage.md` for the summary line and four views: data flow, both routes and `OkfUsageResponse`, reference snapshot (DD-7), team filter, compatibility table (DD-15, 16, 23), removed features; set `generated.at`; update its line in `docs/knowledgebase/index.md`.
- [ ] Create `docs/knowledgebase/algorithms/okf-usage-counting.md` (OKF front matter, `type: "Algorithm"`): rules of DD-1…12, the helper rules of DD-13, the team filter, DD-7, the display formats of DD-19, a Code section and the Examples preamble naming the row kinds of "Test coverage plan"; add it to `algorithms/README.md` (jest, vitest) and `index.md`.
- [ ] Edit `algorithms/okf-metadata.md` (Code section → `okf-paths.ts`) and `algorithms/okf-access-extraction.md` (drop the value-signals and trail references near lines 22-24 and 374-378; rules 14-15 now feed only the facts route).
- [ ] Update `server-endpoint-map.md` (removed routes, settings fields), `client-component-map.md` (OKF rows → `okf/view/`), `db-tables.md` (event / pointer tables and `repo_config.config.okf` no longer written / read), and add the DD-24 "outdated until refreshed" note to the OKF shot rows of `user-docs-and-site.md` (lines 227, 235, 352).
- [ ] Rewrite `user-docs/okf-tab.md`: headings "Repository OKF tab" and "Session OKF tab" kept; sections for the summary line, Versions, Wrong format, Hot files, Explorer, the cost estimate, the two one-line states; plain language, no removed terms.
- [ ] Delete `user-docs/images/okf-kb-value.png` and `okf-kb-value-heuristic.png`; add `user-docs/images/okf-tab.png` — an element screenshot of `repo-okf-tab` taken per "Visual check data" (no e-mail or user name in the frame); reference it from `okf-tab.md`.
- [ ] Remove the OKF thresholds part of `user-docs/tuning-your-setup.md` (lines 43-51 and the `okf-tab.md#thresholds` link).
- [ ] Run `npm run build:help` from the repo root and check the generated OKF help page lists only the new sections.

### Chunk 7 — Tests — algorithm rows and table tests

- [ ] Create `docs/algorithm-examples/okf-usage-counting.json` with rows UC-01…UC-23 of "Test coverage plan", expected values computed by hand from the rules of `okf-usage-counting.md`.
- [ ] Create `server/src/logs/okf/okf-usage-counting.algo.spec.ts` following `okf-metadata.algo.spec.ts` (`loadExamples`, spec-to-bundle helpers) for kinds `view`, `teamFilter`, `reference`.
- [ ] Add rows UC-24…UC-27 (kind `format`) and create `client/src/viewer/lib/okf/okf-format.algo.test.ts` following `format.algo.test.ts` (loader through `createRequire`).
- [ ] Run `npm run test` from `server/` and `bun run test` from `client/`; fix code, doc or rows until both pass.
- [ ] Run `npm run test:scripts` from the repo root and fix anything it reports for the new doc and rows file.

### Chunk 8 — Tests — contract registry

- [ ] `f21-reports.ts`: rewrite `F21-okf-usage`, `-hot-files`, `-bundles`, `-outsider` against `OkfUsageResponse` and its invariants; delete the `F21-okf-article*` rows.
- [ ] `f19-change-surface.ts`: rewrite `F19-okf-session`, `-team`, `-none`, `-outsider`, `-meta-tree`, `-meta-tree-team`; delete `-agents`, `-signals` and `F19-okf-trail*`.
- [ ] `f14-repositories.ts`: remove `OKF_DEFAULTS` / `OKF_FIXED_LIMITS`; make the three `okf` PUT rows expect 200 with the stored `okf` unchanged (DD-16).
- [ ] `f23-export-import.ts`: drop `session_okf_event` / `session_okf_pointer` from the recompute row's rewritten tables; keep the `okf_extract_version = 4` check. The fixture seed of those tables in `world-v1.sql.ts` stays.
- [ ] Start Postgres if needed and run `npm run test:contract` from `server/`; fix until the router meta-test and all rows pass, with `F16-okf-facts*` unchanged.

### Chunk 9 — Tests — scenario S-REPO-16

- [ ] In `tests/scenarios/helpers/okf.ts` add `expectOkfViewFits(page)`: at 1600×1000 `okf-summary`, `okf-versions` (or `okf-old-hook-line`), `okf-format` and the first `okf-hot-row` are in the viewport; restore the viewport in `finally` like `expectOkfTreeFits`. Fix the header comment (lines 13-14): no event / pointer rows.
- [ ] `s-repo-16.spec.ts`: update the header comment and local response types; rewrite steps 8–11 with `summary`, `files`, `bundleRoots` and the ids of DD-20 (team view hides `secret.md` and the private bundle everywhere; bundle select narrows files, keeps `unitsTotal`).
- [ ] Replace steps 12–16 with an FR-0 step: a new bundle `docs/clean-<run>` (`okfVersion '0.3'`, well-formed meta) with a nested bundle; one tree with a file grep, a folder grep, a read of `docs/other.md`; a second tree whose own snapshot adds `gone.md` and reads it. Assert the invariants of "API changes".
- [ ] Same step, UI: explorer rows `data-kind="search"`, nested root, `data-kind="missing-root"` holding `gone.md`, a `data-opened="false"` file row, "Never opened" count = Y − X; with the bundle select on `docs/clean-<run>`: `okf-versions[data-collapsed="true"]` expands by `okf-versions-toggle`, `okf-format-ok` is shown.
- [ ] Add a hot-files step on the same data: default sort arrow on ≈ Tokens, click `okf-hot-sort-cost`, no index file in `okf-hot-row`, `okf-hot-index-line` text, a file's units / tokens equal in the table and the explorer, the DD-20 tooltip text after hovering `okf-tip-cost`.
- [ ] Rewrite step 17 (v03 bundle): `okf-version-row` with "0.1" and `okf-version-older`, `okf-format-group` for each of the five problems with counts, `wip.md` absent, `expectOkfViewFits`; keep the `okf_extract_version` DB check, drop `sessionsWithoutAnalysis`.
- [ ] Assert none of the removed ids renders on the repo tab (`okf-verdict-card`, `okf-kpi-tiles`, `okf-section-b`, `okf-upkeep-row`, `okf-analysis-banner`, `okf-thresholds-chip`) and Settings → Analysis has no `okf-thresholds-setting`; run `npm run test:scenarios -- --mode a --only scenarios --grep "@S-REPO-16"`.

### Chunk 10 — Tests — other scenarios, tours, final run

- [ ] `view/s-sess-09.spec.ts`: rewrite step 8 as the session-tab step ("by N of M agents", "Agents" column headers, no "Sessions" text inside `session-okf-tab`, removed ids absent); rewrite steps 9, 11, 13 per "S-SESS-09 steps" (Test coverage plan); delete steps 10, 12 and the pointer / event DB asserts.
- [ ] `view/s-rept-01.spec.ts` steps 9–10: `okf-summary-ratio` "5 of 5" and, with `branches=feat/okf`, "3 of 3"; `okf-summary-snapshot` names `main` in the unfiltered view; hot files list `core.md` and `big.md` with 5 sessions.
- [ ] `hook/s-compat-01.spec.ts`: steps 10, 11 assert `snapshot: null` and `okf-no-snapshot`; step 11b asserts `okf-old-hook-line`, `versions: []`, `format: null`, populated `okf-hot-row` and `okf-tree-row`.
- [ ] `repos/s-repo-09.spec.ts`: remove `okfSignalRows` and its asserts in steps 5a and 9; assert the step 5a session response through `snapshot` and `files`; tours: `screen-registry.ts` empty text "No KB snapshot", `tour-04` expects `okf-summary` or `okf-no-snapshot`.
- [ ] Run the touched scenarios one by one (`@S-SESS-09`, `@S-REPT-01`, `@S-COMPAT-01`, `@S-REPO-09`, mode a; `@S-SESS-09` also mode c) and fix failures.
- [ ] Run the full verification set through `adlc-lh:check-health` with `finalRun: true` and fix what fails; run `npm run perf` from `server/` and stop and report if a metric is more than 20 % worse than `tmp/okf-perf-baseline.txt` (rule of `.claude/rules/server.md`).
