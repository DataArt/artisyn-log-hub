---
type: "Algorithm"
title: "OKF metadata: version hint, stale_after, deprecated and format hints"
description: "How the server turns the front-matter metadata the hook sends (bundle okfVersion / title / description, per-file meta) into the OKF tabs' newer-format hint, deprecated / superseded-by and past-stale_after chips and can-improve hints."
tags: [algorithm, okf]
generated: { by: "human:denistsyplakov", at: "2026-11-20T22:18:32+04:00" }
reviewed: no
reviewer: none
---

# OKF metadata: version hint, stale_after, deprecated and format hints

## Purpose

Hook 3.1.0+ sends each KB bundle's `okf_version` / `title` / `description` and each file's
front-matter facts ([okf-snapshot](okf-snapshot.md) rules 3a-3b). The OKF tabs use them to warn
that an article is deprecated (and where its replacement is), that it is past its `stale_after`
re-check date, that its front matter could be improved, and that the bundle declares an OKF
format older than the current one. A wrong rule either nags a well-kept KB or hides a stale one;
a missing "old hook" guard would show every article of an old-hook session as "no front matter".

## Code

- Implementation: `server/src/logs/okf/okf-metadata.ts` — `OKF_CURRENT_FORMAT_VERSION` = `'0.3'`,
  `hasHookMeta`, `okfVersionHint`, `parseStaleAfter`, `resolveSupersededBy`, `articleMetaFlags`,
  `bundleMetaSummary`.
- Inputs come from `normaliseSnapshot` (`okf-snapshot.ts`: `superseded_by` → `supersededBy`,
  `stale_after` → `staleAfter`, strings capped at 200); articles from `bundleArticles`
  (`okf-verdict.ts`, see [okf-verdict](okf-verdict.md)); path collapsing from
  `collapseRepoRelative` (`server/src/logs/change-surface/path-normalise.ts`).
- Callers: `okf-usage.service.ts` (session and repo OKF routes, trail).
- Twins: none (the client only renders the flags).
- Test: `server/src/logs/okf/okf-metadata.algo.spec.ts` (jest).

## Rules

1. **Newer-format hint** (`okfVersionHint(okfVersion)`): absent → `true`. Otherwise trim and
   strip one pair of matching surrounding quotes; a value not matching `^\d+\.\d+(\.\d+)?$` →
   `true`; else `true` exactly when `(major, minor)` is numerically below `(0, 3)` (major first,
   then minor; the patch part is ignored). So `0.3`, `0.3.1`, `0.10`, `1.0` → `false`; absent,
   `0.1`, `0.2`, `1`, `foo` → `true`.
2. **`stale_after`** (`parseStaleAfter(v)`, trimmed): `YYYY-MM-DD` → `Date.UTC` of that day
   00:00, `null` when the date does not exist (no roll-over); `YYYY-MM-DD[T|t| ]hh:mm:ss[.fff]`
   followed by `Z`/`z` or `±hh:mm` → that instant (`Date.parse`); anything else (free text, a
   date-time without a zone) → `null`.
3. **Per-article flags** (`articleMetaFlags(file, bundle, refMs)`): a file without `meta` (hook
   older than 3.1.0) → `{deprecated: false, supersededBy: null, pastStaleAfter: false,
   formatHints: []}`. Otherwise `deprecated` = `status` trimmed and lower-cased equals
   `deprecated`; `supersededBy` = rule 6 applied to `meta.supersededBy` **only when deprecated**
   and the key is present, else `null`.
4. `pastStaleAfter` = `staleAfter` present and (rule 2 gives `null` **or** a time `< refMs`). The
   reference time `refMs` is the root session's start (fallback now) on the session route and the
   trail, and now on the repo route.
5. `formatHints`, in this order: `no_front_matter` when `!frontMatter`; `no_type` when
   `frontMatter` and `type` absent; `v01_timestamp` when `hasTimestamp && !hasGenerated`.
6. **`superseded_by` resolution** (`resolveSupersededBy(value, articlePath, bundleRoot)`): a value
   starting with `/` is joined (leading slashes dropped) onto the bundle root (`''` / `.` = repo
   root); any other value onto the article's folder. The join is collapsed with
   `collapseRepoRelative` (drop `''` and `.`, `..` pops, popping an empty stack = escape). An
   escape or an empty result → the raw value is returned unchanged.
7. **Bundle summary** (`bundleMetaSummary(bundle, refMs)`): `null` when no file of the bundle
   has `meta` (`hasHookMeta` false, FR-9: an old hook shows nothing new). Otherwise over
   `bundleArticles(bundle)` only — never the bundle's own index, any `index.md` / `log.md`, or a
   path with a dot segment under the root — `articlesWithHints` = number of articles with at
   least one rule-5 hint, `hintReasons` = the distinct hints in rule-5 order,
   `newerFormatHint` = rule 1 of `bundle.okfVersion`; `title`, `description`, `okfVersion` are
   copied only when present (no key otherwise).

## Edge cases

- Version: absent OM-01; older OM-02, OM-03; current OM-04; quoted OM-05; patch OM-06; numeric
  not lexical OM-07; no minor OM-08; newer major OM-09; not a version OM-10.
- `stale_after`: date only OM-11; `Z` OM-12; offset OM-13; fractional OM-14; free text OM-15;
  impossible date OM-16; no zone OM-17.
- Past / future / unparseable `stale_after` vs `refMs`: OM-18, OM-19, OM-20.
- Deprecated case-insensitive with a relative `superseded_by`: OM-21; rooted (bundle root):
  OM-22; `..`: OM-23; escaping the repo (raw kept): OM-24; not deprecated → no `supersededBy`:
  OM-25.
- Hints: no front matter only OM-26; `no_type` + `v01_timestamp` OM-27; `timestamp` with
  `generated` OM-28; no `meta` at all OM-29.
- Summary: old hook → `null` OM-30; index / `log.md` / nested index / dot path not counted OM-31;
  current version, clean OM-32; no `okf_version`, no articles OM-33.

## Examples

Rows carry a `kind` picking the function. Bundles default to root `kb`, index `kb/index.md`,
`ignored: false`; files to `ignored: false`, `size: 1` and a dummy hash (none of them enter the
rules); `meta` uses the server names (`supersededBy`, `staleAfter`).

- **`versionHint`**: `okfVersionHint(input.okfVersion)` (key omitted = absent);
  `expected.hint`.
- **`staleAfter`**: `parseStaleAfter(input.value)`; `expected.ms` (epoch ms or `null`).
- **`flags`**: `articleMetaFlags(input.file, <default bundle>, input.refMs)`; `expected` is the
  whole `{deprecated, supersededBy, pastStaleAfter, formatHints}`.
- **`summary`**: `bundleMetaSummary(input.bundle, input.refMs)`; `expected` is the whole summary
  or `null`.

Rows (33): [`docs/algorithm-examples/okf-metadata.json`](../../algorithm-examples/okf-metadata.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Lexical version compare (`"0.10" < "0.3"`) -> OM-07; quotes not stripped -> OM-05; a bare
  major accepted as a version -> OM-08.
- A date-time without a zone parsed as local time -> OM-17; roll-over of impossible dates
  accepted -> OM-16; unparseable `stale_after` treated as "not past" -> OM-20.
- `status` compared case-sensitively -> OM-21; `superseded_by` resolved for non-deprecated
  articles -> OM-25; a leading `/` resolved against the repo root -> OM-22; an escape returned as
  `null` instead of the raw value -> OM-24.
- `no_type` also added without front matter -> OM-26; `v01_timestamp` ignoring `generated` ->
  OM-28.
- Summary over all files instead of `bundleArticles` -> OM-31; a summary for old-hook bundles ->
  OM-30.

## Where the result is visible

- Session pane → **OKF** tab and Repository → **OKF** tab: bundle card title / description /
  "OKF x.y" chip and the "newer OKF format" and "can improve" lines; tree chips "deprecated"
  (with the superseded-by target), "past stale_after", "can improve"; the deprecated chip in the
  trail.
- API: the session / repo okf-usage routes' bundle summary and per-file flags, the trail items'
  `deprecated` / `supersededBy`.
