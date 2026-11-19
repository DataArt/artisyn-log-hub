---
type: "Task"
title: "OKF Tab Support for v0.3 and Any-Version Bundles"
description: "Resolve KB pointers the OKF v0.3 way (article folder / bundle root), stop counting reserved index.md / log.md and dot-paths as articles, detect bundles whose okf_version sits past 512 bytes — and never crash or drop a bundle of any version or a partly broken one."
---

# 2026-11-19: OKF Tab Support for v0.3 and Any-Version Bundles

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** server | hook
**Owner:** denis.tsyplakov
**Created:** 2026-11-19
**Tracker:** GH-156 https://github.com/DataArt/artisyn-log-hub/issues/156

## Description

Raw idea: OKF tab: support OKF v0.2/v0.3 bundles (and any version, including slightly broken
bundles). Findings from a code analysis on 2026-11-19 (spec:
https://github.com/open-knowledge-format/open-knowledge-format SPEC.md v0.3; the old
GoogleCloudPlatform repo is deprecated):

1. Server, must: pointer resolution — back-ticked pointers are treated as repo-relative only
   (`server/src/logs/okf/okf-pointers.ts:44-64`, `okf-access-extractor.ts:810-820`); v0.3 §6
   resolves paths without a leading `/` from the article's own folder, `/x` from the bundle root.
   Bare article-relative pointers become false dead pointers (`okf-value-signals.ts:788`); `/x`
   pointers are dropped by `toAbsolute` (`okf-access-extractor.ts:192-206`). Fix: bump
   `OKF_EXTRACT_VERSION` (`okf-constants.ts:13`) to 4, resolve `/x` from bundle root, `./`/`../`
   from the article folder, bare paths match either the repo path or the article-folder path;
   optionally extract markdown link targets; recompute via `recompute-all-sessions`. Size M.
2. Server, should: which files are articles — `bundleArticles` drops only the root `index.md`
   (`okf-verdict.ts:356-365`), hot files skip only bundle indexes (`okf-usage.service.ts:1377-1380`),
   the hook lists every `.md` incl. dot-folders (`okf-snapshot.js:244-258`). v0.3 §3.1/§3.2:
   `index.md` and `log.md` at any depth are reserved, dot-paths are not part of the bundle. Treat
   them as non-articles (still KB access for entry-point logic). Server-only, works with every hook.
   Size S.
3. Hook, should: bundle detection reads only the first 512 bytes of `index.md`
   (`okf-snapshot.js:52,188`); v0.3 §8.1 allows `title` / `description` / `license` in the
   bundle-root front matter in any order, so `okf_version` can fall outside the window. Read until
   the closing `---`, capped at ~8 KB. Size S.
4. Optional ideas (hook + server + client): bundle title/description on bundle cards; `status:
   deprecated` + `superseded_by` (flag reads of retired knowledge); `stale_after` chip; trust tier
   from `generated` / `verified` (only current verifications count). Needs the hook to read full
   article front matter — additive optional fields, no `schemaVersion` bump, server falls back to
   today's rules.
5. Optional: a `.md` without `type` is not a concept (needs a hook content read; debatable).

Hard requirement from the user: users may have OKF bundles of ANY version (none, 0.1, 0.2, 0.3,
unknown, numeric `okf_version: 1`) and partly broken ones (malformed YAML front matter, missing
`type`, broken links, unparseable dates, missing `index.md` files) — nothing may crash or drop a
bundle; the consumer rules of v0.3 §11.2 apply. Tests must cover these cases. Backward
compatibility with old hooks is mandatory. Log Hub's own KBs were migrated to OKF v0.3 on
2026-11-19 (`timestamp` → `generated.at`, `okf_version: "0.3"`).

## Functional Requirements

- FR-1: KB pointers resolve per OKF v0.3 §6: `/x` from the bundle root, `./` and `../` from the
  article's folder, and a bare path matches either the repo-relative path (this repo's convention)
  or the path from the article's folder. The extraction version is bumped so stored sessions show
  the existing "extracted by an older version" state until recomputed.
- FR-2: `index.md` and `log.md` at any depth, and any path with a segment starting with `.`, are not
  counted as articles (shares, not-read list, hot files), but reads of them still count as KB
  access for the entry-point logic.
- FR-3: The hook detects a bundle whose `okf_version` key appears anywhere inside the bundle-root
  `index.md` front matter, up to a cap of about 8 KB.
- FR-4: A bundle of any declared version (absent, `0.1`, `0.2`, `0.3`, unknown, numeric) and a
  partly broken bundle (malformed front matter, missing `type`, broken links, unparseable dates,
  missing nested `index.md`) is processed without error and without being dropped; malformed parts
  are skipped, not fatal.
- FR-5: Server-side changes (FR-1, FR-2, FR-4) work with every existing hook version; new hook
  fields, if any, are optional and absent fields fall back to today's behaviour.
- FR-6 (optional, decide in review): surface v0.3 metadata — bundle title/description, deprecated +
  `superseded_by`, `stale_after`, trust tier.

## Non-Functional Requirements

- No `schemaVersion` bump of the OKF snapshot for additive fields; an old hook keeps uploading
  unchanged snapshots.

## Acceptance Criteria

- [ ] An article in `kb/algorithms/x.md` with the pointer `` `../okf-usage.md` `` that the agent
      then reads is counted as a followed pointer, not as a dead pointer (FR-1).
- [ ] A `/tables/x.md` pointer in a bundle rooted at `kb/` resolves to `kb/tables/x.md` (FR-1).
- [ ] Nested `index.md`, `log.md` and `.hidden/a.md` do not appear in article shares, the not-read
      list or hot files (FR-2).
- [ ] A bundle-root `index.md` with 1 KB of `description` before `okf_version` is detected by the
      new hook (FR-3).
- [ ] Algorithm rows / scenario steps cover bundles with no, `0.1`, `0.2`, `0.3`, unknown and
      numeric `okf_version`, malformed YAML front matter, missing `type`, broken links and
      unparseable dates — each processes without error (FR-4).
- [ ] A session uploaded by the previous released hook still gets an OKF tab on the new server
      (FR-5).

## Notes

- Tests per the repo test policy: algorithm rows in `docs/algorithm-examples/` for the `okf-*`
  algorithm docs (`okf-access-extraction`, `okf-verdict`, `okf-value-signals`, `okf-snapshot`) and
  steps in the existing OKF scenarios — no new unit tests.

**2026-11-19:** Spec sources. The current spec is v0.3 at
https://github.com/open-knowledge-format/open-knowledge-format (SPEC.md). The former home,
https://github.com/GoogleCloudPlatform/open-knowledge-format, holds v0.2 and was marked deprecated
on 2026-11-18. Secondary reading: Google Cloud post "OKF v0.2 adds trust signals"
(https://cloud.google.com/blog/products/data-analytics/okf-v0-2-adds-trust-signals), Taskade's
explainer (https://www.taskade.com/blog/open-knowledge-format-explained.md), the `okf` Rust crate
(https://docs.rs/crate/okf/0.2.5).

**2026-11-19:** What changed between versions (Log Hub was built against v0.1).
- v0.1 → v0.2 (breaking): `timestamp` → `generated: { by, at }` (consumers MAY fall back to
  `timestamp`); the body `# Citations` list → front-matter `sources`. Additive: `sources` credibility
  signals (`author`, `usage_count`, `last_modified`, `usage_window`), `verified: [{ by, at }]`,
  `status: draft|stable|deprecated`, `stale_after`, the `Attested Computation` type, the actor
  convention (`human:<id>`, `agent:<name>`, `team:<id>`).
- v0.2 → v0.3 (breaking): a path without a leading `/` resolves from the file's own directory
  (fallback for ≤ 0.2 bundles: try the bundle root, §12.1); the trust tier counts only verification
  events at or after `generated.at`. Clarifications: a `.md` without `type` is not a concept but
  does not break conformance; `index.md` / `log.md` are reserved at any depth; dot-paths are outside
  the bundle; nested `index.md` has no front matter; timestamps are RFC 3339 date-time with offset
  or date only (start of that day, UTC); unparseable `stale_after` is never fresh. Additive:
  `superseded_by`, bundle-root `title` / `description` / `license` (a regenerating producer must
  keep that front matter), `x-<producer>-<name>` extension keys.
- Consumer rules relevant to FR-4 (§11.2): never reject a bundle for missing optional fields,
  unknown `type`, unknown keys, broken links or missing `index.md`; null / empty = absent; a scalar
  where a list is expected is a one-item list; unknown vocabulary values are kept.

**2026-11-19:** Already done outside this task (branch `adhoc/archive-done-tasks-2026-11-19`), so the
product work here has real v0.3 bundles to test against in this repo:
- Log Hub's own bundles (`docs/knowledgebase`, `docs/product-kb`, the personal `docs/kb-local`)
  moved to v0.3: `okf_version: "0.3"` in the 4 bundle-root `index.md` (one had a numeric
  `okf_version: 1`), and `timestamp` → `generated: { by: "human:denistsyplakov", at: … }` in 92
  articles. Algorithm docs keep their own `reviewed` / `reviewer` front matter and no `type` — legal
  in v0.3 (not concepts).
- Authoring rules updated: `CLAUDE.md` (Knowledgebase section), `CLAUDE.local.md`, the
  `morning-check` and `session-kb-suggest` skills now write `generated`, never `timestamp`.
- Task docs carry OKF concept front matter (`type: "Task"`, `title`, `description`); the todo index
  is generated from it by `npm run tasks:index` (`scripts/tasks-index.js`). `docs/tasks/todo` is
  deliberately NOT declared a bundle (no `okf_version` in its `index.md`), so the OKF tab does not
  count task reads as KB use.
- Product code (hook, server, client) is unchanged: today it reads no article front matter and only
  checks that `okf_version:` exists, so the migration itself needed no product change.
