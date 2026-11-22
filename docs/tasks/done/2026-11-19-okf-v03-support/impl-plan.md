---
type: "Plan"
title: "OKF v0.3 support — implementation plan"
description: "Hook front-matter metadata (8 KB window, per-file meta, hook 3.1.0), server v0.3 pointer resolution (extract version 4), reserved/dot-path article rules, derived metadata flags on the OKF routes and their UI chips."
---

# Implementation plan — 2026-11-19-okf-v03-support

## TL;DR

- **Hook 3.1.0** (`hook/.claude/telemetry_tool/okf-snapshot.js`): front-matter window 512 → 8192 bytes; new
  `parseOkfFrontMatter(head)`; snapshot gains optional per-bundle `okfVersion` / `title` / `description` and
  per-file `meta`; hash cache entries become `[mtimeMs, size, sha256, meta]`; snapshot id projects the new fields
  only when present; 8 MiB size guard drops them. `schemaVersion` and `OKF_STATE_VERSION` stay 1.
- **New server module** `server/src/logs/okf/okf-metadata.ts` (pure): `okfVersionHint`, `parseStaleAfter`,
  `articleMetaFlags`, `bundleMetaSummary`, `hasHookMeta` — with a new algorithm doc `okf-metadata.md`, rows file
  and `okf-metadata.algo.spec.ts`.
- **Pointer resolution v0.3 §6** (`okf-pointers.ts`, `okf-access-extractor.ts`): new `extractPointerSpans` +
  `pointerCandidates`, new `bundleRoots` extractor option, candidate chosen in the final pass;
  `OKF_EXTRACT_VERSION` 3 → 4 (stored sessions show "extracted by an older version" until recompute).
  `loadSnapshotFilesForNode` is replaced by `loadSnapshotForNode` (files + bundle roots); new export
  `collapseRepoRelative` in `server/src/logs/change-surface/path-normalise.ts`.
- **Article rules (FR-2)**: `index.md` / `log.md` at any depth are not articles; dot-path files are dropped from
  bundles in `normaliseSnapshot` and `bundleOfPath` returns `null` for dot-paths (not KB access).
- **API (additive, optional fields only)**: `OkfBundleSummary` + `title`, `description`, `okfVersion`,
  `newerFormatHint`, `articlesWithHints`, `hintReasons`; file `OkfTreeNode` + `deprecated`, `supersededBy`,
  `pastStaleAfter`, `formatHints`; `OkfTrailItem` + `deprecated`, `supersededBy`. No new endpoints.
- **DB**: none (no migration; `sessions.okf_extract_version` values move to 4 via recompute).
- **Client**: `OkfBundleCards`, `OkfTree` / `okf-tree-rows.tsx` (bundle-row title + hint chips, file chips),
  `OkfTrailRow` (deprecated chip); `user-docs/okf-tab.md` + `npm run build:help`.

## Reference

- Requirements: [requirements.md](requirements.md) (answers to its Open Questions are recorded there).
- Analysis done for this plan: [research/meta-scan.md](research/meta-scan.md) (script `research/meta-scan.mjs`).

## Design Decisions

### Hook (DD-H*)

- **DD-H1 — bundle fields.** From the bundle-root `index.md` head (`OKF_FRONT_MATTER_READ_BYTES = 8192`), the
  scalar values of the top-level keys `okf_version`, `title`, `description` become bundle fields `okfVersion`,
  `title`, `description`, each set only when the normalised value is present (DD-H2). Detection itself is
  unchanged except the window (FR-3: a `okf_version:` line before the closing `---` or the window end).
- **DD-H2 — `parseOkfFrontMatter(head: string)`** returns
  `{ frontMatter: boolean, hasGenerated: boolean, hasTimestamp: boolean, fields: Record<string,string> }`:
  drop a UTF-8 BOM; split lines (strip `\r`); line 0 must trim to `---`, else all false / `{}`; scan following
  lines until a line trimming to `---` (→ `frontMatter = true`) or the head ends. Unclosed block → return all
  false and `{}` (metadata ignored). A top-level key line matches `^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$` (no
  leading whitespace). `generated` / `timestamp` keys set the booleans. Scalars of the whitelist
  (`okf_version`, `title`, `description`, `type`, `status`, `superseded_by`, `stale_after`) are normalised:
  trim; if it starts with `"` or `'` and a matching closing quote follows, take the inner text (rest ignored);
  else cut at the first whitespace-preceded `#`, trim; `''`, `null`, `~`, `|`, `|-`, `>`, `>-` → absent;
  cap at `OKF_META_VALUE_MAX_CHARS = 200` chars. First occurrence of a key wins.
- **DD-H3 — per-file `meta`** (every file of a bundle, the `index.md` included):
  `{ frontMatter, hasGenerated, hasTimestamp, type?, status?, superseded_by?, stale_after? }` — the three
  booleans always, each scalar key only when present. Parsed from the first 8192 bytes of the buffer
  `readAndHash` already reads.
- **DD-H4 — snapshot id.** `computeOkfSnapshotId` canon per bundle: `{root, index, ignored, files}` and then
  `okfVersion`, `title`, `description` appended in that order only when they are strings; per file
  `{path, ignored, size, hash}` then `meta` only when it is an object, its keys projected in the fixed order
  `frontMatter, hasGenerated, hasTimestamp, type, status, superseded_by, stale_after` (absent keys omitted).
  Bundles without the new fields give today's id: the old-shape fixture
  `[{root:'kb',index:'kb/index.md',ignored:false,files:[{path:'kb/a.md',ignored:false,size:10,hash:'a'×64},{path:'kb/index.md',ignored:false,size:5,hash:'b'×64}]}]`
  has id `5dd2eb05119fa5d223052331bb88d627516e30cb9acc820f211e92c53a554860` (computed with today's code,
  2026-11-20) and must keep it.
- **DD-H5 — size guard.** After assembling the snapshot, if `Buffer.byteLength(JSON.stringify(snapshot))` exceeds
  `OKF_SNAPSHOT_META_BUDGET_BYTES = 8 * 1024 * 1024`, strip every DD-H1/DD-H3 field, recompute the id and log
  one line through the existing `say` logger of `buildOkfSnapshot`:
  `okf-snapshot: body with metadata is <n> bytes, over the <budget> budget — metadata dropped`. Real KBs cost ~80 B of `meta` per file (meta-scan: 20 000 × 82.4 B ≈ 1.57 MiB); the worst case
  (≈ 900 B/file × 20 000 = 18 MB) would exceed the server's 10 MiB `OKF_SNAPSHOT_MAX_BYTES` and be resent forever.
- **DD-H6 — hash cache.** Entry `[mtimeMs, size, sha256, meta]`; a hit needs mtime/size match, string hash and an
  object 4th element; a legacy 3-element entry is a miss (re-read once). The cache is rewritten when the tree key
  or entry count changed **or** any entry was (re)filled from a legacy entry. Old hooks read only `hit[0..2]`, so
  a 4-element entry stays a hit for them. `OKF_STATE_VERSION` stays 1.
- **DD-H7 — hook version** `3.0.0` → `3.1.0` (additive); documented as a new section in
  `docs/knowledgebase/hook-api-versioning.md` modelled on "Harness snapshot `gitStatus`" (line 730).

### Server snapshot + metadata (DD-S*)

- **DD-S1 — snapshot types / `normaliseSnapshot`.** `OkfSnapshotBundle` gains `okfVersion?`, `title?`,
  `description?` (strings); `OkfSnapshotFile` gains `meta?: OkfSnapshotFileMeta` =
  `{ frontMatter: boolean; hasGenerated: boolean; hasTimestamp: boolean; type?: string; status?: string; supersededBy?: string; staleAfter?: string }`.
  `normaliseSnapshot` copies a string field truncated to 200 chars, ignores non-strings; copies `meta` only when
  it is a non-array object (booleans `=== true`, scalar keys `superseded_by` → `supersededBy`, `stale_after` →
  `staleAfter`, strings only, truncated to 200). Never throws, never drops a bundle or file for bad metadata (FR-4).
- **DD-S2 — `okf-metadata.ts` (pure, no DB):**
  - `OKF_CURRENT_FORMAT_VERSION = '0.3'`.
  - `hasHookMeta(bundle: OkfSnapshotBundle): boolean` — some file has `meta` (the new hook always sends `meta` for
    the bundle's own `index.md`); false → no FR-6..8 output (FR-9).
  - `okfVersionHint(okfVersion: string | undefined): boolean` — strip one pair of quotes; must match
    `^\d+\.\d+(\.\d+)?$`, else `true`; `true` when `(major, minor) < (0, 3)` numerically. So `0.3`, `0.3.1`,
    `0.10`, `1.0` → false; absent, `0.1`, `0.2`, `1`, `foo` → true (meta-scan "FR-8 version rule").
  - `parseStaleAfter(v: string): number | null` — `^\d{4}-\d{2}-\d{2}$` → `Date.UTC` of that day 00:00;
    `^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$` → `Date.parse`; invalid date or any
    other format → `null`.
  - `export interface OkfArticleMetaFlags { deprecated: boolean; supersededBy: string | null; pastStaleAfter: boolean; formatHints: OkfArticleHint[] }`
    (exported from `okf-metadata.ts`; `OkfArticleHint` imported from `okf-usage.types.ts`).
  - `articleMetaFlags(file: OkfSnapshotFile, bundle: OkfSnapshotBundle, refMs: number): OkfArticleMetaFlags`:
    `deprecated` = `status` lower-cased `=== 'deprecated'`; `supersededBy` = DD-S3 resolution of
    `meta.supersededBy`, set only when `deprecated` is true (otherwise `null`; a non-deprecated article's
    `superseded_by` is neither emitted nor rendered); `pastStaleAfter` = `staleAfter` present and (`parseStaleAfter` null or `< refMs`);
    `formatHints` in order `no_front_matter` (`!frontMatter`), `no_type` (`frontMatter && type` absent),
    `v01_timestamp` (`hasTimestamp && !hasGenerated`). A file without `meta` → all false / `[]`.
  - `bundleMetaSummary(bundle: OkfSnapshotBundle, refMs: number)` → `{ title?, description?, okfVersion?, newerFormatHint, articlesWithHints, hintReasons }`
    over `bundleArticles(bundle)` (FR-2 articles); returns `null` when `!hasHookMeta(bundle)`.
- **DD-S3 — `supersededBy` resolution:** value starting with `/` → `<bundleRoot>/<rest>`; otherwise joined onto
  the article's folder; both collapsed with `collapseRepoRelative` (DD-P1); `null` result → the raw value.
- **DD-S4 — dot-paths (FR-2).** `normaliseSnapshot` drops a file whose path relative to its own bundle root has a
  segment starting with `.`; `bundleOfPath` (`okf-verdict.ts:187`) returns `null` when the path relative to the
  deepest containing root has such a segment. So dot-path reads are not KB access anywhere (verdicts, entry
  points, tree, summaries, `readBytes`) and the extractor treats those files as code. Pointer logic unchanged.
- **DD-S5 — reserved names (FR-2).** `isReservedOkfName(path)` = basename lower-cased is `index.md` or `log.md`.
  `bundleArticles` excludes the bundle index, reserved names and (defensively) dot-paths. Hot files skip any
  reserved name (with or without snapshot); the repo not-read list is built from `bundleArticles`. Reserved reads
  still count as KB access; `agentEntry` is unchanged (`index` only for the bundle's own `index.md`). Expected
  effect: article counts, shares and per-file verdict rules change on the next view for every bundle with nested
  `index.md` / `log.md` or dot-path files (computed on read, no recompute needed).
- **DD-S6 — reference time for `pastStaleAfter`:** session route and trail → the root session's start time
  (fallback `Date.now()` when null); repo route → `Date.now()` (user answer 2026-11-20). Session route: the
  `startTime` of the `loadTreeNodes` entry whose `id === sessionDbId` (already loaded). Trail: a new private
  `loadSessionStartMs(sessionDbId): Promise<number | null>` in `okf-usage.service.ts` running
  `SELECT MIN(l.start_time) FROM logs l WHERE l.session_id = $sessionDbId` (same expression as
  `loadTreeNodes`), converted with `toMs`, loaded in the route's existing `Promise.all`.
- **DD-S7 — trail chip.** `buildOkfTrail` input gets optional `deprecated?: ReadonlyMap<string, string | null>`
  (article path → resolved `supersededBy`); each `kb_read` item whose path is in it gets `deprecated: true` and
  `supersededBy` when non-null. No tree counter of deprecated reads (user answer 2026-11-20).
- **DD-S8 — team view (`teamFilter`).** All metadata is derived from the bundles after `applyOkfTeamFilter`
  (summaries, file flags, trail map). Bundle `title` / `description` / version / hints are shown for every bundle
  that stays visible. `supersededBy` is dropped (set to `null`) when its target is not in `visibleArticleSet` of
  the filtered bundles, so a hidden path never leaks.

### Pointer resolution (DD-P*)

- **DD-P1 — `collapseRepoRelative(p: string): string | null`** (exported from
  `server/src/logs/change-surface/path-normalise.ts`): split on `/`, drop `''` and `.`, `..` pops; popping an
  empty stack → `null` (escape above repo root); join with `/`; empty result → `''`.
- **DD-P2 — `extractPointerSpans(text, roots): OkfPointerSpan[]`** replaces `extractPointers`. Same span regex and
  filters as today (`normalisePointer`), except a leading `./` / `../` is kept, and absolute handling moves to
  DD-P3. `OkfPointerSpan = { text: string; kind: 'dot' | 'rooted' | 'bare' | 'absolute'; path: string }`:
  `dot` = starts with `./` or `../`; `absolute` = drive-letter (`^[A-Za-z]:/`); `rooted` = starts with `/`;
  `bare` = otherwise. `text` = the span after trailing `:line`, `#anchor`, glob and trailing-`/` cuts (before
  resolution). De-duplicated on `text`, first occurrence order kept.
- **DD-P3 — `pointerCandidates(span, ctx: { articleDir: string; bundleRoot: string; roots })`: string[]**
  (repo-relative, de-duplicated, `null`s dropped, `''` dropped):
  `dot` → `[collapse(articleDir/text)]`;
  `absolute` → `[resolveRepoPath(text, roots)]`;
  `rooted` → `resolveRepoPath` result if non-null and non-empty, else `[collapse(bundleRoot/rest)]`;
  `bare` → `[collapse(articleDir/p), collapse(p), collapse(bundleRoot/p)]`.
  Empty list → the span is dropped (e.g. a `..` escaping the repo).
- **DD-P4 — bundle root option.** `ExtractOkfAccessOptions.bundleRoots?: readonly string[]` (repo-relative root
  folders, `''` = repo root). Article bundle root = longest root `r` with `r === ''` or
  `articleKey.startsWith(r + '/')`; none / option absent → `''`. `articleDir` = folder of the article key (`''` at
  repo root).
- **DD-P5 — final pass.** Each pointer row carries its candidate list until the end of `extractOkfDetail`. Stored
  `pointer` = first candidate with `snapshotFiles.has(c)` or `lastTouch.has(c)`; else for `bare` the `collapse(p)`
  candidate (`repo/p`), else the first candidate. `followed` = some candidate `c` has `lastTouch.get(c) > readOrd`.
  `isNew` = `isNewPointer(span.text, prior)` (raw span text). Every `seq` item's `newPointers` is rewritten in the
  final pass to the stored `pointer` values of its rows (so the trail's `followedAt` matches `followed`), including
  rows not stored because of `OKF_POINTER_CAP_PER_NODE`.
- **DD-P6 — loader.** `loadSnapshotFilesForNode` becomes
  `loadSnapshotForNode(db, sessionDbId): Promise<{ files: ReadonlyMap<string, OkfSnapshotFileInfo>; bundleRoots: string[] } | undefined>`
  (roots = `bundle.root` of the normalised body). Callers: `rebuildSessionOkfAccess` (`okf-access-writer.ts:276`),
  `getSessionOkfTrail` (`okf-usage.service.ts:1000`); `okf-facts.service.ts:330-366` passes
  `bundles.map(b => b.root)` from its in-hand snapshot.
- **DD-P7 — `OKF_EXTRACT_VERSION = 4`** (`okf-constants.ts:13`); `OKF_SEARCH_HITS_MIN_VERSION` stays 2.

### UI (DD-U*)

- **DD-U1 — bundle card** (`OkfBundleCards.tsx`): heading = `title` ?? `root`; when `title` is set, a muted mono
  sub-line with `root`; `description` under it (`line-clamp-2`, full text in `title` attribute); an "OKF x.y" chip
  (raw `okfVersion`) after the tracked chip; when `articlesWithHints > 0` a sky line "N articles can be improved"
  plus a muted line of `hintReasons` joined with " · " (labels per DD-U4); when `newerFormatHint` a sky line
  "ⓘ Newer format available (0.3)" + "Advice — this bundle still works as is." Without the fields → today's card.
- **DD-U2 — tree.** `OkfTree` gets `bundleInfo?: ReadonlyMap<string, OkfBundleSummary>` (both tabs pass it from
  `data.bundles`); the top (bundle) row shows `title` (root as muted suffix) and sky chips "ⓘ newer format (0.3)"
  and "ⓘ N can improve". File rows: amber chip "deprecated" + "→ <basename of supersededBy>" (button →
  `onOpenArticle(supersededBy)` when `supersededBy` is the path of a file node in the tree data, else plain
  text — `OkfTree` builds `filePaths: ReadonlySet<string>` from its nodes and passes
  `isKnownFile(path): boolean` to `OkfTreeRow`); amber "past stale_after";
  sky "ⓘ can improve" with `title` = reasons joined by ", ". Chip markup as `okf-tree-rows.tsx:226-230`; amber as
  `OkfTrailRow.tsx:83`; rows keep `ROW_HEIGHT`.
- **DD-U3 — trail.** `OkfTrailRow` shows the amber "deprecated" chip (and "→ basename" when `supersededBy`) on
  `kb_read` items with `deprecated`.
- **DD-U4 — hint labels:** `no_front_matter` → "no front matter", `no_type` → "no type", `v01_timestamp` →
  "v0.1 timestamp". Sky palette = existing info colours (`text-sky-700`, `border-sky-300`, dark variants as used
  elsewhere in the OKF tab); never red / amber for hints.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `hook/.claude/telemetry_tool/okf-snapshot.js` | FR-3, FR-6 hook side | DD-H1..H6 |
| `hook/.claude/telemetry_tool/okf-state.js` | cache typedef | 4-element entry; version stays 1 |
| `hook/.claude/telemetry_tool/version.json` | hook version | 3.1.0 |
| `.artisyn/marketplace/plugins/log-hub-hooks/**` | dogfooded install | refreshed per `.claude/rules/hook.md` |
| `server/src/logs/okf/okf-snapshot.ts` | DD-S1, DD-S4 | interfaces + `normaliseSnapshot` |
| `server/src/logs/okf/okf-metadata.ts` (new) | DD-S2, DD-S3 | pure derivation |
| `server/src/logs/okf/okf-usage.types.ts` | API types | per API changes |
| `server/src/logs/okf/okf-verdict.ts` | DD-S4, DD-S5 | `bundleOfPath`, `bundleArticles`, `isReservedOkfName` |
| `server/src/logs/change-surface/path-normalise.ts` | DD-P1 | `collapseRepoRelative` |
| `server/src/logs/okf/okf-pointers.ts` | DD-P2, DD-P3 | spans + candidates |
| `server/src/logs/okf/okf-access-extractor.ts` | DD-P4, DD-P5 | option + final pass |
| `server/src/logs/okf/okf-constants.ts` | DD-P7 | version 4 |
| `server/src/logs/okf/okf-access-writer.ts` | DD-P6 | `loadSnapshotForNode` |
| `server/src/logs/okf/okf-facts.service.ts` | DD-P6 | pass `bundleRoots` |
| `server/src/logs/okf/okf-usage.service.ts` | DD-P6, DD-S5..S7, summaries | session/repo/article/trail routes |
| `server/src/logs/okf/okf-usage-tree.ts` | file flags | `OkfTreeFileFlags` + `finalize` |
| `server/src/logs/okf/okf-trail.ts` | DD-S7 | trail item flags |
| `client/src/models/repositories.ts` | client mirror | lines ~993 / 1045 / 1161 |
| `client/src/viewer/pages/repository/session-log/okf/OkfBundleCards.tsx` | DD-U1 | |
| `client/src/viewer/pages/repository/session-log/okf/OkfTree.tsx` | DD-U2 | `bundleInfo` prop |
| `client/src/viewer/pages/repository/session-log/okf/okf-tree-rows.tsx` | DD-U2 | chips |
| `client/src/viewer/pages/repository/session-log/okf/OkfTrailRow.tsx` | DD-U3 | |
| `client/src/viewer/pages/repository/session-log/okf/SessionOkfTab.tsx` | DD-U2 | pass `bundleInfo` |
| `client/src/viewer/pages/repository/okf/RepoOkfOverview.tsx` | DD-U2 | pass `bundleInfo` (the only repo component rendering `OkfTree`) |
| `docs/knowledgebase/algorithms/okf-metadata.md` (new) | algorithm doc | DD-S2/S3 rules, OKF v0.3 front matter, `type: "Algorithm"` |
| `docs/algorithm-examples/okf-metadata.json` (new) | rows | |
| `server/src/logs/okf/okf-metadata.algo.spec.ts` (new) | table test | pattern of `okf-value-signals.algo.spec.ts` |
| `docs/knowledgebase/algorithms/okf-access-extraction.md` + `docs/algorithm-examples/okf-access-extraction.json` | FR-1 rules/rows | rules 3, 14, 15 |
| `server/src/logs/okf/okf-access-extractor.algo.spec.ts` | harness | wire `input.bundleRoots` (lines 120-127) |
| `docs/knowledgebase/algorithms/okf-verdict.md` + `docs/algorithm-examples/okf-verdict.json` | FR-2 rules/rows | Articles section (lines 101-105) |
| `docs/knowledgebase/algorithms/okf-snapshot.md` + `docs/algorithm-examples/okf-snapshot.json` | FR-3/FR-6 hook rules/rows | rule 3, 8, 9; OS-07 `d` flips |
| `hook/.claude/telemetry_tool/__tests__/okf-snapshot.algo.test.js` | harness | new kinds `meta`, `id` |
| `docs/knowledgebase/algorithms/okf-value-signals.md` | trail rule 11 | `deprecated` item flag |
| `docs/knowledgebase/okf-usage.md` | data flow, compat table (330-343) | v3→4, hook-with-meta rows, new fields |
| `docs/knowledgebase/hook-api-versioning.md` | DD-H7 | new 3.1.0 section |
| `docs/knowledgebase/index.md` | KB index | add `okf-metadata.md` |
| `user-docs/okf-tab.md` → `client/public/help/*.md` | in-app help | `npm run build:help` |
| `server/test/contract/registry/f19-change-surface.ts` | contract | `okfBundlesSql` article predicate; session rows |
| `server/test/contract/registry/f21-reports.ts` | contract | `F21-okf-usage` not_read/kb_files; `< 4` |
| `server/test/contract/registry/f23-export-import.ts` | contract | `okf_extract_version = 4` |
| `server/test/contract/fixtures/world-v1.sql.ts` | fixture | title + meta in one bundle; version 4 |
| `tests/scenarios/helpers/okf.ts` | scenario helper | bundle fields + file `meta` in specs |
| `tests/scenarios/hook/s-hook-09.spec.ts`, `hook/s-compat-01.spec.ts`, `view/s-sess-09.spec.ts`, `repos/s-repo-16.spec.ts` | scenario steps | see Test coverage plan |

## API changes

No new endpoints. Additive optional fields (older clients ignore them; old-hook data never sets them) on every
route that returns these types: `GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage`,
`GET …/sessions/:sessionId/okf-usage/trail?agent=` and the repo OKF usage route (served by `getRepoOkfUsage`).
The repo article route (`getRepoOkfArticle`, `RepoOkfArticleResponse`) is deliberately unchanged: the chips live
on the tree rows.

```ts
export type OkfArticleHint = 'no_front_matter' | 'no_type' | 'v01_timestamp';

interface OkfBundleSummary {            // + optional, all absent when !hasHookMeta(bundle)
  title?: string;
  description?: string;
  okfVersion?: string;                  // raw value, for the "OKF x.y" chip
  newerFormatHint?: boolean;            // FR-8, okfVersionHint()
  articlesWithHints?: number;           // FR-7, articles with >= 1 hint
  hintReasons?: OkfArticleHint[];       // distinct reasons, order of OkfArticleHint
}

interface OkfTreeNode {                 // file nodes only, each key only when true / non-empty
  deprecated?: true;
  supersededBy?: string;                // DD-S3
  pastStaleAfter?: true;                // distinct from the value-signals `stale`
  formatHints?: OkfArticleHint[];
}

interface OkfTrailItem {                // kb_read items only
  deprecated?: true;
  supersededBy?: string;
}
```

Server-side `OkfTreeFileFlags` (`okf-usage-tree.ts:215`) gains the same four optional keys; `finalize` copies them
into `fileExtras` (no new marker values). Client mirror: same shapes in `client/src/models/repositories.ts`.
Snapshot ingest body (hook → server, `okf-snapshot` line): additive optional fields per DD-H1/DD-H3,
`schemaVersion` stays 1.

## Test coverage plan

Per the CLAUDE.md test policy — only algorithm rows, contract registry rows and scenario steps.

- **Algorithm — `okf-access-extraction`** (doc rules 3, 14, 15 + rows): `./x`, `../x`, `..` escaping the repo
  (dropped), `/x` → bundle root, `/abs` inside the session repo (as today), drive-letter path, bare `p` with
  `dir/p` in snapshot, bare with only `repo/p` read (followed 1, stored `repo/p`), bare bundle-root fallback
  (AC `kb/a/x.md` → `tables/y.md`), no `bundleRoots` (repo-root bundle, article-relative first), `isNew` on raw
  span text, `seq.newPointers` carrying the chosen candidate. Harness: `input.bundleRoots`.
- **Algorithm — `okf-verdict`** (Articles section + rows): nested `index.md` / `log.md` not in files / shares;
  `.hidden/a.md` not an article and only-`.hidden` read = no-KB verdict; `kb/sub/index.md` then `kb/sub/a.md`
  keeps KB access and today's entry verdict; FR-4 bundles (malformed / missing metadata) count like well-formed.
- **Algorithm — `okf-snapshot`** (hook; doc rules 3, 8, 9 + new meta rule; rows): OS-07 `d` flips to detected;
  1 KB `description` before `okf_version` detected; `okf_version` past 8192 not; detection for absent-value,
  `0.1`, `0.2`, `0.3`, numeric, unknown and malformed-YAML heads; new kind `meta` (quoted, single-quoted,
  commented, empty, `null`, `~`, block scalar, 200-char cap, unclosed block, BOM, `generated` / `timestamp`
  booleans, nested-key not top-level); new kind `id` pinning DD-H4's legacy id
  `5dd2eb05…a554860` and asserting a meta-bearing variant differs; detect rows assert the new bundle fields and file
  `meta` (harness extended). The 3-element → 4-element cache upgrade is checked in `s-hook-09`, not here (the
  harness has no `workDir` / cache input).
- **Algorithm — `okf-metadata`** (new doc + rows + `okf-metadata.algo.spec.ts`): `okfVersionHint` for absent,
  `0.1`, `0.2`, `0.3`, `"0.3"`, `0.3.1`, `0.10`, `1`, `1.0`, `foo`; `parseStaleAfter` date-only, `Z`, offset,
  fractional, unparseable; `articleMetaFlags` past / future / unparseable `stale_after` vs `refMs`, deprecated
  case-insensitive, `supersededBy` relative / rooted / escaping, hints; `bundleMetaSummary` null without hook
  meta, counts over articles only.
- **Algorithm — `okf-value-signals`**: trail rows (`kind: trail`) for the `deprecated` / `supersededBy` item
  flags; `notFound` unchanged on the stored pointer.
- **API contract**: update the existing rows of the changed routes in `f19-change-surface.ts` (session okf-usage,
  trail) and `f21-reports.ts` (`F21-okf-usage`) for the new fields, FR-2 predicates and extract
  version 4; `f23-export-import.ts` version check; world-v1 fixture adds `title` + `meta` to one bundle.
- **Scenarios** (extend, no new files): `s-hook-09` — real hook stores `okfVersion` / `title` / `description` and
  file `meta`, detects a head with 1 KB `description` first, `okf-state.json` entries are 4-element and an
  unchanged run does not re-read; `s-sess-09` — card title / version chip / newer-format and can-improve lines,
  deprecated + past-stale_after + can-improve chips in tree, deprecated chip in trail, `../x` pointer followed,
  nested index/log/.hidden not counted; `s-repo-16` — repo tree chips, bundle-row hints, not-read without
  reserved files, recompute after the version bump; `s-compat-01` — previous released hook → OKF tab works, no
  chips / hints.

## Visual/UX notes

- Follow the two wireframes: hints sky (info), content warnings (`deprecated`, `past stale_after`) amber, never red.
- Bundle card stays `w-72`; a 200-char description (seen on `docs/product-kb/competitive-watch`) is clamped to two
  lines with the full text in the `title` attribute.
- Tree rows keep `ROW_HEIGHT`; chips are `shrink-0` except the supersededBy link (`min-w-0 truncate`).
- Old-hook data renders exactly as today (no empty chips, no placeholder lines).

## Wireframes

No changes: the "read while deprecated ×N" marker in `okf-tree-article-chips.svg` is dropped (trail chip only,
per the user's answer), which the wireframe already lists as an open question.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Hook: front-matter metadata | 8 | standalone; produces the snapshot fields of DD-H1/H3 |
| 2 | Server: snapshot pass-through + metadata module + types | 5 | consumes the body shape of DD-S1 |
| 3 | Server: v0.3 pointer resolution | 6 | uses `collapseRepoRelative` from chunk 2 |
| 4 | Server: FR-2 rules + route wiring | 8 | uses chunks 2 and 3 |
| 5 | Client: chips, cards, trail | 7 | uses API types of chunk 2 |
| 6 | Docs + in-app help | 5 | after behaviour is final |
| 7 | Tests: hook + metadata algorithm docs/rows | 6 | |
| 8 | Tests: extraction/verdict/value-signals rows | 6 | |
| 9 | Tests: contract + scenarios | 8 | last; ends with the changelog entry |

### Chunk 1 — Hook: front-matter metadata
- [ ] `hook/.claude/telemetry_tool/okf-snapshot.js`: set `OKF_FRONT_MATTER_READ_BYTES = 8192`; add and export `OKF_META_VALUE_MAX_CHARS = 200` and `OKF_SNAPSHOT_META_BUDGET_BYTES = 8 * 1024 * 1024`.
- [ ] Add and export `parseOkfFrontMatter(head)` per DD-H2; keep `hasOkfFrontMatter` behaviour (window only changes).
- [ ] `detectOkfBundles`: parse the bundle-root `index.md` head once and return `okfVersion` / `title` / `description` per bundle per DD-H1.
- [ ] `hashFiles`: `readAndHash` returns `{size, hash, meta}` with `meta` per DD-H3 from the first 8192 bytes; cache entries and hit/miss/rewrite rules per DD-H6 (both the `workDir` and no-cache paths return `meta`).
- [ ] `buildOkfSnapshot`: put DD-H1 fields on bundles and `meta` on files; apply the DD-H5 size guard (strip new fields, recompute id, log once).
- [ ] `computeOkfSnapshotId`: extend the canon per DD-H4 (new fields only when present, fixed key order).
- [ ] `okf-state.js`: update the `OkfHashCache` typedef to `[mtimeMs, size, sha256, meta]` (version stays 1); bump `hook/.claude/telemetry_tool/version.json` to `3.1.0`.
- [ ] Propagate per `.claude/rules/hook.md`: `npm run build:hooks-installer`, refresh `.artisyn/marketplace/plugins/log-hub-hooks/`, run the `update-install-instructions` skill, `npm run lint:fix` + `npm run lint` + `npm test` in `hook/`.

### Chunk 2 — Server: snapshot pass-through + metadata module + types
- [ ] `okf-snapshot.ts`: add `OkfSnapshotFileMeta` and the optional fields to `OkfSnapshotBundle` / `OkfSnapshotFile`; extend `normaliseSnapshot` per DD-S1 and drop dot-path files per DD-S4.
- [ ] `path-normalise.ts`: export `collapseRepoRelative` per DD-P1 (used by DD-S3 here and by chunk 3).
- [ ] `okf-verdict.ts`: export `isReservedOkfName`; `bundleArticles` per DD-S5; `bundleOfPath` returns null for dot-paths per DD-S4; update their doc comments.
- [ ] Create `server/src/logs/okf/okf-metadata.ts` with `OKF_CURRENT_FORMAT_VERSION`, `hasHookMeta`, `okfVersionHint`, `parseStaleAfter`, `articleMetaFlags`, `bundleMetaSummary` per DD-S2/DD-S3.
- [ ] `okf-usage.types.ts`: add `OkfArticleHint` and the optional fields of API changes to `OkfBundleSummary`, `OkfTreeNode`, `OkfTrailItem`.

### Chunk 3 — Server: v0.3 pointer resolution
- [ ] `okf-pointers.ts`: replace `extractPointers` with `extractPointerSpans` and add `pointerCandidates` per DD-P2/DD-P3; update the file header rules comment.
- [ ] `okf-access-extractor.ts`: add `bundleRoots` to `ExtractOkfAccessOptions` and derive article bundle root / `articleDir` per DD-P4 at the single-article pointer block (~line 716).
- [ ] `okf-access-extractor.ts`: pointer rows keep candidates; `isNew` on `span.text`; final pass (~line 813) chooses `pointer`, sets `followed` and rewrites `seq` `newPointers` per DD-P5.
- [ ] `okf-constants.ts`: `OKF_EXTRACT_VERSION = 4` (DD-P7).
- [ ] `okf-access-writer.ts`: replace `loadSnapshotFilesForNode` with `loadSnapshotForNode` per DD-P6; `rebuildSessionOkfAccess` passes `snapshotFiles` and `bundleRoots`.
- [ ] `okf-usage.service.ts` `getSessionOkfTrail` and `okf-facts.service.ts` (~330-366) pass `bundleRoots` per DD-P6.

### Chunk 4 — Server: FR-2 rules + route wiring
- [ ] `okf-usage.service.ts` hot files (~1377): `isIndexPath` → `isReservedOkfName` (with or without snapshot) per DD-S5.
- [ ] `okf-usage.service.ts` repo not-read list (~1431): build from `bundleArticles(b)` per DD-S5.
- [ ] Session summaries (~800) and repo summaries (~1455): spread `bundleMetaSummary(b, refMs)` fields when non-null; `refMs` per DD-S6.
- [ ] `okf-usage-tree.ts`: add `deprecated`, `supersededBy`, `pastStaleAfter`, `formatHints` to `OkfTreeFileFlags`; `finalize` copies them into `fileExtras` (only true / non-empty).
- [ ] `okf-usage.service.ts`: session route passes a new `fileFlags` map (new keys only) to `buildOkfTree` (~835); repo route merges them into `fileFlagsOf` (~1497); values from `articleMetaFlags` for `bundleArticles` of `hasHookMeta` bundles, `refMs` per DD-S6.
- [ ] `okf-trail.ts`: optional `deprecated` map input and item flags per DD-S7.
- [ ] `getSessionOkfTrail`: add `loadSessionStartMs` per DD-S6; build the `deprecated` map from the (team-filtered) bundles with `articleMetaFlags` and pass it to `buildOkfTrail`.
- [ ] Apply DD-S8 in the session, repo and trail paths: derive from filtered bundles and null `supersededBy` whose target is not in `visibleArticleSet`.

### Chunk 5 — Client: chips, cards, trail
- [ ] `client/src/models/repositories.ts`: mirror `OkfArticleHint` and the new optional fields of API changes.
- [ ] Add a small shared label map for hints per DD-U4 as `OKF_HINT_LABELS` exported from `client/src/viewer/pages/repository/session-log/okf/okf-tree.ts`.
- [ ] `OkfBundleCards.tsx`: title / description / version chip / can-improve and newer-format lines per DD-U1; update the header comment.
- [ ] `OkfTree.tsx`: add the `bundleInfo` prop and pass the summary of `entry.top.bundle` and `isKnownFile` (from the tree's file-node paths) to `OkfTreeRow` per DD-U2.
- [ ] `okf-tree-rows.tsx`: bundle-row title and sky hint chips; file-row deprecated / supersededBy link / past stale_after / can-improve chips per DD-U2.
- [ ] `OkfTrailRow.tsx`: deprecated chip and supersededBy label on `kb_read` items per DD-U3.
- [ ] `SessionOkfTab.tsx` and `client/src/viewer/pages/repository/okf/RepoOkfOverview.tsx`: pass `bundleInfo` built from `data.bundles`; run client lint + typecheck.

### Chunk 6 — Docs + in-app help
- [ ] `docs/knowledgebase/okf-usage.md`: document the new snapshot fields, derived API fields, FR-2 article / dot-path rules, extract version 4 marker meaning; add compat-table rows "server v4 + old hook" and "hook 3.1.0 + old server" and note that article counts / shares change for bundles with nested `index.md` / `log.md` or dot-paths (DD-S5).
- [ ] `docs/knowledgebase/hook-api-versioning.md`: new "OKF snapshot metadata (hook `3.1.0`+)" section per DD-H7 (fields, id rule, cache entry, size guard, one full resend after upgrade).
- [ ] `user-docs/okf-tab.md`: explain title/description, deprecated and past stale_after chips, can-improve flag and count, newer-format hint and how to clear each (session and repo tab sections, lines ~49 and ~118).
- [ ] Run `npm run build:help` to regenerate `client/public/help/*.md`.
- [ ] Bump `generated.at` in the front matter of every KB article changed in this chunk.

### Chunk 7 — Tests: hook + metadata algorithm docs/rows
- [ ] `docs/knowledgebase/algorithms/okf-snapshot.md`: rule 3 window 8192; new meta-parse rule (DD-H2/H3); rules 8-9 cache entry and id projection (DD-H4/H6); size guard (DD-H5); document row kinds `meta` and `id`.
- [ ] `okf-snapshot.algo.test.js`: support kind `meta` (`input.head` → `parseOkfFrontMatter` result subset) kind `id` (`input.bundles` → `expected.id` or `expected.differsFrom`); detect rows also compare optional `expected` bundle fields and file `meta` as a subset.
- [ ] `docs/algorithm-examples/okf-snapshot.json`: flip OS-07 `d`; add detection (with bundle fields / file `meta` expectations), `meta` and `id` (legacy id per DD-H4) rows per Test coverage plan.
- [ ] Create `docs/knowledgebase/algorithms/okf-metadata.md` (`type: "Algorithm"`, rules DD-S2/S3, Examples preamble) and add it to `docs/knowledgebase/index.md`.
- [ ] Create `docs/algorithm-examples/okf-metadata.json` with the rows listed in Test coverage plan, and `server/src/logs/okf/okf-metadata.algo.spec.ts` (loader as in `okf-value-signals.algo.spec.ts`, `kind` per function).
- [ ] Bump `generated.at` of `okf-snapshot.md`; run `npm test` in `hook/` and `npm run test` in `server/`.

### Chunk 8 — Tests: extraction / verdict / value-signals rows
- [ ] `docs/knowledgebase/algorithms/okf-access-extraction.md`: rewrite rules 3, 14 (keep `./`, spans + candidates), 15 (followed over candidates, new on raw span) per DD-P1..P5; bump `generated.at`.
- [ ] `okf-access-extractor.algo.spec.ts` (~120-127): pass `input.bundleRoots` into options; add the FR-1 rows of Test coverage plan to `docs/algorithm-examples/okf-access-extraction.json`.
- [ ] `docs/knowledgebase/algorithms/okf-verdict.md` Articles section per DD-S4/S5; add FR-2 and FR-4 rows to `docs/algorithm-examples/okf-verdict.json`.
- [ ] `docs/knowledgebase/algorithms/okf-value-signals.md` rule 11: trail `deprecated` / `supersededBy` flags; add `kind: trail` rows to `docs/algorithm-examples/okf-value-signals.json`.
- [ ] `okf-value-signals.algo.spec.ts` (~59-76): add `deprecated?: Record<string, string | null>` to `TrailInput` and pass it to `buildOkfTrail` as a `Map`.
- [ ] Run `npm run test` in `server/` until the three tables pass.

### Chunk 9 — Tests: contract + scenarios
- [ ] `server/test/contract/fixtures/world-v1.sql.ts`: add `title` / `okfVersion` and file `meta` (one deprecated, one hint) to one snapshot bundle; s02/s03 `okf_extract_version` → 4.
- [ ] `f19-change-surface.ts`: `okfBundlesSql` article predicate excludes reserved names and dot-paths; session okf-usage / trail rows expect the new fields.
- [ ] `f21-reports.ts` `F21-okf-usage`: not_read / kb_files from articles only, `okf_extract_version < 4`, new fields; `f23-export-import.ts:290` → `= 4`; run `npm run test:contract`.
- [ ] `tests/scenarios/helpers/okf.ts`: extend `OkfBundleSpec` / `OkfSnapshotFileSpec` with the bundle fields and file `meta`.
- [ ] `hook/s-hook-09.spec.ts`: steps for 1 KB description before `okf_version`, stored bundle fields + file `meta`, 4-element `okf-state.json` entries, unchanged second run.
- [ ] `view/s-sess-09.spec.ts` and `repos/s-repo-16.spec.ts`: steps per Test coverage plan (cards, chips, trail chip, `../x` followed, reserved/dot not counted, recompute).
- [ ] `hook/s-compat-01.spec.ts`: assert no chips / hints for the previous hook; run each touched scenario with `--grep` in a mode it declares.
- [ ] Write the changelog entry `docs/changelog/<YYYY-MM-DD-HHmm>-okf-v03-support.md` per the `changelog` skill.
