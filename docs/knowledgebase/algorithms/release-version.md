---
reviewed: no
reviewer: none
---

# Release version and run state

## Purpose

Decides, for one run of the release workflow, which version is released and whether the run
builds a new release (`full`), finishes an interrupted one (`resume`) or stops (`fail`). The owner
only bumps the release line X.Y in the root `package.json`; the PATCH number comes from the git
tags, so a release can never be published twice, overwrite an existing tag or go back to a lower
line.

## Code

- Implementation: `scripts/ci/release-version.js` (`parseLine`, `nextVersion`, `planRun`); its CLI
  is the `plan` job of `.github/workflows/release.yml`, which reads the root `package.json`, the
  tags (`git for-each-ref`, peeled commit for annotated tags), `git rev-parse HEAD` and, for a strict
  tag at HEAD, the release state (`gh release view <tag> --json isDraft`; a non-zero exit is `none`).
- Twins: none.
- Test: `scripts/__tests__/release-version.algo.test.js` (`npm run test:scripts`).

## Input and output

- A **strict tag** matches `STRICT_TAG_RE` = `^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`
  (no leading zeros, no suffix). Every other tag name (`v1.0`, `v1.0.0-rc1`, `v01.0.0`, `latest`)
  is ignored by every rule below.
- Tags are given as `[{name, commit}]`; `commit` is the commit the tag points at.
- Strict tags are ordered by semver: MAJOR, then MINOR, then PATCH, each compared as an integer
  (`v1.0.10` > `v1.0.9`).
- `releases` maps a tag name to `none`, `draft` or `published`; a tag missing from the map is `none`.

## Rules

**`parseLine(version)`**: when `version` is a string matching `LINE_RE` = `^[0-9]+\.[0-9]+\.[0-9]+$`,
returns `{major, minor, line: '<major>.<minor>'}` with both fields parsed as integers (the PATCH
field is ignored). Otherwise `null`.

**`nextVersion({major, minor}, tags)`**: among the strict tags with that MAJOR and MINOR, take
the highest PATCH and return `'<major>.<minor>.<PATCH + 1>'`. When the line has no strict tag,
return `'<major>.<minor>.0'`. Tags of other lines do not count.

**`planRun({packageVersion, tags, head, releases})`** returns
`{mode, version, tag, line, previousTag, reason}`; a `fail` result has `version`, `tag`, `line`
and `previousTag` all `''`. The first matching rule wins:

1. `parseLine(packageVersion)` is `null`: `fail`, reason
   `root package.json version must be X.Y.Z, got "<packageVersion>"`.
2. Let T be the highest strict tag whose `commit` equals `head`. When T exists and its release
   is `published`: `fail`, reason `nothing to release: <T> is already published`.
3. When T exists (release `none` or `draft`): `resume` with `version` = T without the `v`,
   `tag` = T, `line` = T's MAJOR.MINOR (the `package.json` line is not used), reason
   `<T> points at HEAD, release is <state>`.
4. When there are strict tags and the line (MAJOR, MINOR) of `packageVersion` is lower than the
   line of the highest strict tag: `fail`, reason
   `version line <X.Y> is lower than <highest tag> — no going back`. The same line is allowed.
5. `version` = `nextVersion(line, tags)`, `tag` = `v<version>`. When that tag already exists as a
   strict tag: `fail`, reason `<tag> already exists on commit <commit> — not overwriting`.
6. Otherwise `full` with that `version` and `tag`, `line` = `<X.Y>` of `packageVersion`, reason
   `new release <tag> on line <X.Y>`.

`previousTag` (modes `resume` and `full`) is the highest strict tag that is lower than `version`
by semver, or `''` when there is none. It may sit on another line.

Rule 5 is a guard: `nextVersion` is always one above the highest PATCH of its line, so with the
input above the computed tag cannot already exist, and no example reaches it. It stays so that a
future change to `nextVersion` can never overwrite a published tag.

## Edge cases

- `parseLine`: valid, short, suffixed and non-string input: RV-01 to RV-04; leading zeros are
  parsed as integers: RV-05.
- `nextVersion`: empty line falls back to `.0`: RV-06; next PATCH: RV-07; integer order
  (`v1.0.10` > `v1.0.9`): RV-08; a gap in PATCH numbers: RV-09; tags of other lines ignored:
  RV-10; non-strict tags ignored: RV-11.
- `planRun` rule 1: RV-12; rule 1 before rule 2: RV-13.
- Rule 2: RV-14. Rule 3 with no release and with a draft: RV-15, RV-16; several strict tags at
  HEAD (the highest wins): RV-17; resume ignores the `package.json` line: RV-18; a non-strict tag
  at HEAD does not resume: RV-24.
- Rule 4, same major and lower major: RV-19, RV-20.
- Rule 6, the acceptance sequence `v1.0.0 → v1.0.1 → v1.0.2 → v1.1.0 → v1.1.1`: RV-21 to RV-23,
  RV-25, RV-26 (RV-21 is also the fall-back to `v1.0.0`); the PATCH of `package.json` ignored:
  RV-26, RV-27; semver order of tags: RV-28; `previousTag` on a lower line: RV-25, RV-29.

## Examples

`input.fn` is the exported function to call and `input.args` its argument list;
`expected.result` is its exact return value. Commit SHAs are shortened to readable words (`h` is
always HEAD).

Rows (29): [`docs/algorithm-examples/release-version.json`](../../algorithm-examples/release-version.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Comparing tags as strings instead of integers -> RV-08, RV-28, RV-29.
- Counting tags of other lines for the PATCH -> RV-10; accepting non-strict tags -> RV-11, RV-24.
- Taking the PATCH from `package.json` -> RV-26, RV-27.
- Resuming from the lowest tag at HEAD, or failing on a published tag that is not the highest at
  HEAD -> RV-17; taking the resume line from `package.json` -> RV-18.
- Checking the tag at HEAD before validating `package.json` -> RV-13.
- Rejecting the same line as the highest tag (`<=` instead of `<`) -> RV-22, RV-23; comparing only
  MINOR -> RV-20.
- `previousTag` limited to the same line -> RV-25, RV-29.

## Where the result is visible

The outputs `mode`, `version`, `tag`, `line` and `previous_tag` of the `plan` job of the release
workflow: the git tag and GitHub Release name, the image tags `X.Y.Z` and `X.Y`, and the commit
range of the release notes. A `fail` shows as `::error::<reason>` on the run. Safe behaviour: a
published release is never rebuilt and an existing tag is never moved.
