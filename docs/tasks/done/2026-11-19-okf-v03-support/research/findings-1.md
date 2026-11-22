---
type: "Research"
title: "OKF v0.3 support — codebase research (plan-deep, pass 1)"
description: "Research subagent report archived verbatim for the 2026-11-19-okf-v03-support implementation plan."
---

# Research findings 1 (2026-11-20)

## Requirements summary
GH-156 OKF v0.3 support — make the OKF tab handle v0.3 (and any-version / partly broken) bundles. FR-1 (server): resolve back-ticked KB pointers per v0.3 §6 — `./x`/`../x` joined onto the article's folder and collapsed (escape above repo root → drop), `/x` tried as session-root absolute then `<bundleRoot>/x`, bare `p` → candidates `dir(article)/p`, `repo/p`, `<bundleRoot>/p`; "the article's bundle" = deepest snapshot bundle containing it; bundle roots reach the extractor via a new optional field on `ExtractOkfAccessOptions`; one row per span, candidate chosen in the final pass (first present in snapshot or touched by node, else `repo/p`), "followed" = any candidate touched later, "new" judged on the raw span; `OKF_EXTRACT_VERSION` 3→4. FR-2 (server): `index.md`/`log.md` at any depth are not articles (still KB access); a dot-segment path under the bundle root is neither article nor KB access. FR-3 (hook): front-matter scan window → 8192 bytes or the closing `---`. FR-4: any-version/partly-broken bundle never dropped, never fails processing, bad/missing-metadata article still counts. FR-5/FR-9: compat with every old hook (no new fields → no chips/hints). FR-6 (hook→server→client): per-bundle `okfVersion`/`title`/`description`, per-file `meta` (`type`,`status`,`superseded_by`,`stale_after`,bools `frontMatter`,`hasGenerated`,`hasTimestamp`) from a line regex, cached in `okf-state.json` as 4-element entries; snapshot id includes new fields only when present; server derives deprecated / past-`stale_after` / hint flags as new optional fields on `OkfBundleSummary` and `OkfTreeNode`; UI shows title+description, "deprecated" chip (link to `superseded_by`, repeated in trail), "past stale_after" chip. FR-7: "can improve" hint on articles with format problems + per-bundle count. FR-8: "newer format available (0.3)" when `okfVersion` absent / not a version / < 0.3 (user answered "assume semver"). Out of scope: markdown-link pointers, trust tier.

## Wireframes
- `wireframes/okf-bundle-cards.svg` (session `OkfBundleCards`, w-72 cards): title replaces root as heading, description under it, folder path as sub-line; "tracked" chip kept + "OKF 0.3" chip showing raw `okfVersion`; new line "N articles can be improved" with reasons "no type · no front matter · v0.1 timestamp"; new line "ⓘ Newer format available (0.3) — Advice — this bundle still works as is"; old-hook card = exactly today's; idle-bundles line unchanged; hints in sky (info) colours, never red/amber.
- `wireframes/okf-tree-article-chips.svg` (`OkfTreeRow`, repo + session variants, rows stay ROW_HEIGHT): chips after the name like the existing "not in KB at start" chip; "deprecated" + "→ okf-usage.md" and "past stale_after" are amber; "ⓘ can improve" sky, title lists reasons; "⚠ read while deprecated ×2" marker (placement still an open question in the wireframe); old-hook session shows no chips; existing value-signal "stale" marker unchanged.

## Knowledgebase
- `docs/knowledgebase/okf-usage.md` — data flow, marker table (line 66: `NULL`/`< 3` = "no OKF analysis yet"), routes + response types (`okf-usage.types.ts`, mirrored in `client/src/models/repositories.ts`), session/repo tab components; backward-compat table (lines 330–343) — plan must extend with v3→4 and hook-with-meta rows.
- `docs/knowledgebase/algorithms/okf-access-extraction.md` — rule 3 (path resolution), rule 14.2 strips leading `./` (conflicts FR-1), 14.5 drops unresolved absolute; rule 15 followed/new/partial. Rows: `docs/algorithm-examples/okf-access-extraction.json` (35 rows). Harness feeds `input.snapshotFiles` → FR-1 rows need a new `input.bundleRoots` key wired in `okf-access-extractor.algo.spec.ts:120-127`.
- `docs/knowledgebase/algorithms/okf-verdict.md` — **Articles** (lines 101–105): `bundleArticles` = "files without its index.md", index still counts as KB access — FR-2 changes this definition. Rows with `files` number|list (lines 258–288; 43 rows) — OV-16/RV-03 cover index already.
- `docs/knowledgebase/algorithms/okf-value-signals.md` — rule 8 `notFound` on the stored pointer (FR-1 keeps); rows `kind: trail` for `buildOkfTrail` (14 rows).
- `docs/knowledgebase/algorithms/okf-snapshot.md` — rule 3 states the 512-byte window (edit for FR-3); rules 8–9 hash cache + canonical id projection; row kinds `detect`/`compare`/`order` (14 rows); `compare` = tool for "upgraded hook gives a new id / old ids unchanged" rows. **OS-07 `d` must flip** — its `okf_version` sits at byte 521 (beyond 512, inside 8192).
- `docs/knowledgebase/hook-api-versioning.md:730-752` — precedent for additive snapshot field (harness `gitStatus`, 2.28.0): `schemaVersion` stays 1, field enters id only when set, upgraded hook = one full resend. Copy this section format for the new hook version (> current `3.0.0`).
- `.claude/rules/hook.md` — bump `hook/.claude/telemetry_tool/version.json`, `npm run build:hooks-installer`, refresh `.artisyn/marketplace/plugins/log-hub-hooks/`, `update-install-instructions` skill, `npm run lint`.

## Existing patterns
**Extraction (server)**
- `server/src/logs/okf/okf-access-extractor.ts:94-105` — `ExtractOkfAccessOptions` (`isSubagentLog`, `snapshotFiles`); add `bundleRoots?` here.
- `okf-access-extractor.ts:192-206` `toAbsolute` — absolute `p` kept; used by `normalisePointer` for absolute resolution.
- `okf-access-extractor.ts:716-731` — single-article pointer rows; article path `kbReads[0].key` known here → `dir(article)` available. `isNewPointer(pointer, prior)` runs on the normalised string (FR-1 wants raw span).
- `okf-access-extractor.ts:813-822` final pass — `row.followed = lastTouch.get(row.pointer) > readOrd`; place for candidate pick + followed. `lastTouch` keyed by path+ancestors (`pathAndAncestors`).
- `okf-access-extractor.ts:787-789` — `seq` items carry `newPointers`; trail's `followedAt` (`okf-trail.ts:92-99`) matches these strings against later paths → they must carry the chosen candidate (patch in final pass).
- `server/src/logs/okf/okf-pointers.ts:40-65` `normalisePointer` — `while (p.startsWith('./')) p = p.slice(2)` (line 51) loses article-relative signal; absolute unresolved → null (57-60). `extractPointers` returns normalised strings only — would need `{raw, normalised, kind}`.

**Path helpers / constants**
- `server/src/logs/change-surface/path-normalise.ts:220-233` `collapseDots` — private, *clamps* at root rather than failing; FR-1 needs a repo-relative collapse returning null on escape.
- `path-normalise.ts:247` `resolveRepoPath` — abs → repo-relative with msys `/d/` retry.
- `server/src/logs/okf/okf-constants.ts:13` — `OKF_EXTRACT_VERSION = 3`; `OKF_SEARCH_HITS_MIN_VERSION = 2` (stays).

**Callers that must pass bundle roots**
- `okf-access-writer.ts:67-97` `loadSnapshotFilesForNode` (returns files map only) → add roots (return alongside or sibling loader).
- `okf-access-writer.ts:269` `rebuildSessionOkfAccess`.
- `okf-facts.service.ts:330-366` — snapshot bundles already in hand.
- `okf-usage.service.ts:995-1011` (trail) — `loadRootSnapshot` already loaded alongside.
- These three are the only `extractOkfDetail` callers (`ce callers` confirmed), plus `extractOkfAccess` wrapper (`okf-access-extractor.ts:830`).

**Snapshot normalisation**
- `server/src/logs/okf/okf-snapshot.ts:62-102` `normaliseSnapshot` — projects only known keys → new keys must be added here (and to `OkfSnapshotBundle`/`OkfSnapshotFile` interfaces, 31-55).
- `extractOkfSnapshot` (105-145) stores body verbatim; requires `schemaVersion === 1` (confirms no bump).
- Callers of `normaliseSnapshot`: `okf-usage.service.ts:1882`, `:2175`, `okf-access-writer.ts:67`.

**Articles / KB access (FR-2)**
- `okf-verdict.ts:356-365` `bundleArticles` — filters only `bundle.index`. Callers (`ce`): `articleCount` (`okf-usage.service.ts:305`), `computeSessionVerdict`, `computeRepoVerdict`, `readFilesOfBundle`, `ruleFiles`, `sessionHeadChecks`, `sessionShareCheck`.
- `okf-verdict.ts:187-202` `bundleOfPath` — deepest root; reuse for "article's bundle".
- KB-access predicates the dot-path rule must reach: `isKbRead` `okf-verdict.ts:210-216`, `agentEntry` `:239-260`, `isKb` `okf-usage.service.ts:1248-1252`.
- `okf-usage.service.ts:1377-1384` hot files: `isIndexPath` covers bundle index only — FR-2 widens to any `index.md`/`log.md`.
- `okf-usage.service.ts:1431-1442` not-read list built from **all** `b.files` (includes unread `index.md` today).

**Summaries / tree (FR-6/7)**
- `okf-usage.service.ts:800-819` (session) and `:1455-1475` (repo) build `OkfBundleSummary` — add title/description/version/hint counts here.
- `okf-usage-tree.ts:383-446` `finalize` → `fileExtras` (optional per-file fields, `markers.fileFlags`), `OkfTreeFileFlags` (line 215) — pattern for deprecated/stale-after/hint fields on file nodes.
- `server/src/logs/okf/okf-usage.types.ts:74-89` (`OkfBundleSummary`), `:126-165` (`OkfTreeNode`, optional fields, older clients ignore), `:231-250` (`OkfTrailItem`).
- Client mirror: `client/src/models/repositories.ts:993`, `:1045`.

**Hook**
- `hook/.claude/telemetry_tool/okf-snapshot.js:52` `OKF_FRONT_MATTER_READ_BYTES = 512`.
- `okf-snapshot.js:171-181` `hasOkfFrontMatter` — already stops at closing `---`; `readHead` (184-202) — head to parse `okfVersion`/`title`/`description`.
- `okf-snapshot.js:283-298` `computeOkfSnapshotId` — canonical projection to extend "only when present"; precedent `harness-snapshot.js:332-339` (`gitStatus` appended only when set).
- `okf-snapshot.js:318-372` `hashFiles` — cache hit check at 357 (old hooks check `hit[0..2]` only → 4-element entry still a hit for them, safe); `readAndHash` has the full buffer → parse `meta` there; rewrite condition at 368 = tree key/count only → FR-6 needs a "some entry upgraded" flag.
- `okf-snapshot.js:416-445` — bundle/file object assembly.
- `okf-state.js:28` `OKF_STATE_VERSION = 1`; `OkfHashCache` typedef (133-137) says `[mtimeMs,size,sha256]`.

**Client**
- `client/src/viewer/pages/repository/session-log/okf/OkfBundleCards.tsx` (98 lines) — card layout to extend.
- `okf-tree-rows.tsx:221-230` — chip markup to copy (`rounded border px-1 text-[10px]`); markers 78-90.
- `OkfTrailRow.tsx:56` KB index label; `:83` amber chip style.
- `okf-trail.ts:38-41` client `isIndexPath` (heuristic `*/index.md`).
- In-app help: `user-docs/okf-tab.md` sections "Session OKF tab" (line 118), "Repository OKF tab" (49); `npm run build:help`.

**Tests**
- Algorithm rows: `docs/algorithm-examples/okf-{access-extraction,verdict,value-signals,snapshot}.json`; snapshot harness `hook/.claude/telemetry_tool/__tests__/okf-snapshot.algo.test.js` (`compare` kind: `before`/`after` tree).
- Contract: `server/test/contract/registry/f19-change-surface.ts:34-62` `okfBundlesSql` (`article` predicate = `f->>'path' <> b->>'index'` — sync with FR-2); rows `f19-change-surface.ts:229, 389, 406` (session routes). `server/test/contract/registry/f21-reports.ts:382-447` `F21-okf-usage` — `not_read` SQL counts all snapshot files incl. `index.md`; `okf_extract_version < 3` (431) → must become `< 4`. `f23-export-import.ts:290` — `okf_extract_version = 3` → `= 4`. Fixture `server/test/contract/fixtures/world-v1.sql.ts:495-520` snapshot body (add `title`/per-file `meta`), line ~1318 sets s02/s03 `okf_extract_version` 3 → bump to 4 or `without_analysis` changes.
- Scenarios: `tests/scenarios/helpers/okf.ts:37-160` `okfSnapshotBody` (no bundle-level/meta fields in spec yet; extend `OkfBundleSpec`/`OkfSnapshotFileSpec`; id computed over whole bundles JSON). `view/s-sess-09.spec.ts` (steps 7+, session tab), `repos/s-repo-16.spec.ts` (repo tab, recompute, value signals), `view/s-rept-01.spec.ts` (repo verdict). `hook/s-hook-09.spec.ts:161-336` — real hook writes `docs/kb/index.md` and checks the stored body → place for FR-3 (description before `okf_version`) + FR-6 (meta present). `hook/s-compat-01.spec.ts` — old hooks → no chips (FR-9).

## Open gaps
1. No repo-relative collapse that fails on escape — `collapseDots` is private and clamps; a new helper returning null on climb above root is needed.
2. `extractPointers` output shape must carry raw span (for "new"), kind (`./`/`../`, `/x`, bare, absolute) and unnormalised text; current `./` stripping (rule 14.2) changes, as does the algorithm doc's rule 14.
3. Candidate selection: final-pass pick needs pointer rows to carry a candidate list until the end; `seq` items' `newPointers` must be rewritten to the chosen candidate or the trail's `followedAt` disagrees with stored `followed`.
4. Trail deprecated chip source: `OkfTrailItem` has no flag field; trail route doesn't return tree nodes. Options: optional `deprecated?` (+`supersededBy?`) on `OkfTrailItem` vs client join with session `okf-usage` tree. "Server derives, client renders" favours the former. Placement of "read while deprecated ×N" on the tree row is an open question in the wireframe.
5. `stale_after` reference time (open question in requirements.md, unanswered): session start vs view time; repo route has no single session time.
6. Snapshot size: server limit `OKF_SNAPSHOT_MAX_BYTES` = 10 MB; hook allows up to 20 000 files. Worst-case meta ≈ 4 keys × 200 chars + ~100 B JSON ≈ 900 B/file → 20 000 × 900 = 18 MB of meta alone (plus ~160 B/file existing ≈ 3.2 MB) → would exceed 10 MB, body rejected server-side, id stays unknown → hook resends every upload. Hook has no size guard. Realistic meta (~100 B/file) = 2 MB. Plan must decide a hook-side size guard or tighter cap.
7. Dot-path reads in `readBytes`: whether FR-2 dot-path reads (not KB access) still count in bundle `readBytes`/tree — `okfBundlesSql` sums every `root/%` path today.
8. Not-read list / KB FILES tile change after FR-2 for bundles with nested `index.md`/`log.md`; `F21-okf-usage` `kb_files`/`not_read` SQL must be adjusted to match (current fixture has no such files).
9. No per-bundle "hint"/"version" type yet — field names on `OkfBundleSummary`/`OkfTreeNode` must be fixed in the plan (suggested: optional `title`, `description`, `okfVersion`, `formatHint: boolean`, `articlesWithHints: number`; files: `deprecated`, `supersededBy`, `pastStaleAfter`, `hints: string[]`).
10. Repo tab has no bundle cards (session-only) — where FR-7 per-bundle count and FR-8 hint appear on repo tab (if at all) is undecided; wireframe only shows session cards.
11. Hook 4-element cache: meta parse must live inside `hashFiles`'s `readAndHash` so cache hits reuse meta; a legacy 3-element hit with no meta forces a re-read even with unchanged mtime/size (required by FR-6, one-time cost).
