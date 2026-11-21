# Notes: OKF Tab Support for v0.3 and Any-Version Bundles

## 2026-11-19 (moved from requirements.md)

**Spec sources.** The current spec is v0.3 at
https://github.com/open-knowledge-format/open-knowledge-format (SPEC.md). The former home,
https://github.com/GoogleCloudPlatform/open-knowledge-format, holds v0.2 and was marked deprecated
on 2026-11-18. Secondary reading: Google Cloud post "OKF v0.2 adds trust signals"
(https://cloud.google.com/blog/products/data-analytics/okf-v0-2-adds-trust-signals), Taskade's
explainer (https://www.taskade.com/blog/open-knowledge-format-explained.md), the `okf` Rust crate
(https://docs.rs/crate/okf/0.2.5).

**What changed between versions** (Log Hub was built against v0.1).
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

**Already done outside this task** (branch `adhoc/archive-done-tasks-2026-11-19`), so the
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

## 2026-11-19 (code-analysis findings, moved from requirements.md Description)

1. Pointer resolution: back-ticked pointers are treated as repo-relative only
   (`server/src/logs/okf/okf-pointers.ts:44-64`, `okf-access-extractor.ts:810-820`); v0.3 §6
   resolves paths without a leading `/` from the article's own folder, `/x` from the bundle root.
   Bare article-relative pointers become false dead pointers (`okf-value-signals.ts:788`); `/x`
   pointers are dropped by `toAbsolute` (`okf-access-extractor.ts:192-206`). Fix direction: bump
   `OKF_EXTRACT_VERSION` (`okf-constants.ts:13`) to 4, resolve `/x` from bundle root, `./`/`../`
   from the article folder, bare paths match either the repo path or the article-folder path;
   optionally extract markdown link targets; recompute via `recompute-all-sessions`.
2. Which files are articles: `bundleArticles` drops only the root `index.md`
   (`okf-verdict.ts:356-365`), hot files skip only bundle indexes (`okf-usage.service.ts:1377-1380`),
   the hook lists every `.md` incl. dot-folders (`okf-snapshot.js:244-258`). v0.3 §3.1/§3.2:
   `index.md` and `log.md` at any depth are reserved, dot-paths are not part of the bundle. The fix
   is server-only and works with every hook.
3. Bundle detection reads only the first 512 bytes of `index.md` (`okf-snapshot.js:52,188`); v0.3
   §8.1 allows `title` / `description` / `license` in the bundle-root front matter in any order, so
   `okf_version` can fall outside the window.
