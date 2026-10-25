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

```examples
[
  {"id":"RV-01","input":{"fn":"parseLine","args":["1.2.3"]},"expected":{"result":{"major":1,"minor":2,"line":"1.2"}},"note":"Matches LINE_RE; MAJOR 1, MINOR 2, PATCH 3 ignored."},
  {"id":"RV-02","input":{"fn":"parseLine","args":["1.2"]},"expected":{"result":null},"note":"Only two fields: no match, null."},
  {"id":"RV-03","input":{"fn":"parseLine","args":["1.2.3-rc1"]},"expected":{"result":null},"note":"Suffix after the third field: no match, null."},
  {"id":"RV-04","input":{"fn":"parseLine","args":[null]},"expected":{"result":null},"note":"Not a string: null."},
  {"id":"RV-05","input":{"fn":"parseLine","args":["01.02.0"]},"expected":{"result":{"major":1,"minor":2,"line":"1.2"}},"note":"LINE_RE allows leading zeros; the fields are parsed as integers 1 and 2."},
  {"id":"RV-06","input":{"fn":"nextVersion","args":[{"major":1,"minor":0},[]]},"expected":{"result":"1.0.0"},"note":"No strict tag on line 1.0: PATCH 0."},
  {"id":"RV-07","input":{"fn":"nextVersion","args":[{"major":1,"minor":0},[{"name":"v1.0.0","commit":"a"}]]},"expected":{"result":"1.0.1"},"note":"Highest PATCH on 1.0 is 0: 0 + 1 = 1."},
  {"id":"RV-08","input":{"fn":"nextVersion","args":[{"major":1,"minor":0},[{"name":"v1.0.10","commit":"b"},{"name":"v1.0.9","commit":"a"}]]},"expected":{"result":"1.0.11"},"note":"Integers: 10 > 9, so the highest PATCH is 10 and the next is 11 (string order would pick 9)."},
  {"id":"RV-09","input":{"fn":"nextVersion","args":[{"major":1,"minor":0},[{"name":"v1.0.3","commit":"b"},{"name":"v1.0.1","commit":"a"}]]},"expected":{"result":"1.0.4"},"note":"Highest PATCH is 3 regardless of the gap at 2: next is 4."},
  {"id":"RV-10","input":{"fn":"nextVersion","args":[{"major":1,"minor":0},[{"name":"v1.1.0","commit":"a"},{"name":"v2.0.5","commit":"b"}]]},"expected":{"result":"1.0.0"},"note":"No strict tag with MAJOR 1 and MINOR 0: PATCH 0."},
  {"id":"RV-11","input":{"fn":"nextVersion","args":[{"major":1,"minor":0},[{"name":"v1.0","commit":"a"},{"name":"v1.0.0-rc1","commit":"b"},{"name":"v01.0.0","commit":"c"},{"name":"1.0.0","commit":"d"}]]},"expected":{"result":"1.0.0"},"note":"None of the four names matches STRICT_TAG_RE (two fields, suffix, leading zero, no v): the line has no tag, PATCH 0."},
  {"id":"RV-12","input":{"fn":"planRun","args":[{"packageVersion":"1.0","tags":[],"head":"h","releases":{}}]},"expected":{"result":{"mode":"fail","version":"","tag":"","line":"","previousTag":"","reason":"root package.json version must be X.Y.Z, got \"1.0\""}},"note":"Rule 1: parseLine(\"1.0\") is null."},
  {"id":"RV-13","input":{"fn":"planRun","args":[{"packageVersion":"next","tags":[{"name":"v1.0.0","commit":"h"}],"head":"h","releases":{"v1.0.0":"draft"}}]},"expected":{"result":{"mode":"fail","version":"","tag":"","line":"","previousTag":"","reason":"root package.json version must be X.Y.Z, got \"next\""}},"note":"Rule 1 is checked first, even with a resumable tag at HEAD."},
  {"id":"RV-14","input":{"fn":"planRun","args":[{"packageVersion":"1.0.0","tags":[{"name":"v1.0.0","commit":"h"}],"head":"h","releases":{"v1.0.0":"published"}}]},"expected":{"result":{"mode":"fail","version":"","tag":"","line":"","previousTag":"","reason":"nothing to release: v1.0.0 is already published"}},"note":"Rule 2: T = v1.0.0 at HEAD, release published."},
  {"id":"RV-15","input":{"fn":"planRun","args":[{"packageVersion":"1.0.0","tags":[{"name":"v1.0.0","commit":"h"}],"head":"h","releases":{}}]},"expected":{"result":{"mode":"resume","version":"1.0.0","tag":"v1.0.0","line":"1.0","previousTag":"","reason":"v1.0.0 points at HEAD, release is none"}},"note":"Rule 3: T = v1.0.0 at HEAD, missing from releases so none; no strict tag below 1.0.0, previousTag ''."},
  {"id":"RV-16","input":{"fn":"planRun","args":[{"packageVersion":"1.0.0","tags":[{"name":"v1.0.0","commit":"a"},{"name":"v1.0.1","commit":"h"}],"head":"h","releases":{"v1.0.1":"draft"}}]},"expected":{"result":{"mode":"resume","version":"1.0.1","tag":"v1.0.1","line":"1.0","previousTag":"v1.0.0","reason":"v1.0.1 points at HEAD, release is draft"}},"note":"Rule 3: T = v1.0.1, draft; the highest strict tag below 1.0.1 is v1.0.0."},
  {"id":"RV-17","input":{"fn":"planRun","args":[{"packageVersion":"1.1.0","tags":[{"name":"v1.0.0","commit":"a"},{"name":"v1.1.0","commit":"h"},{"name":"v1.0.1","commit":"h"}],"head":"h","releases":{"v1.0.1":"published"}}]},"expected":{"result":{"mode":"resume","version":"1.1.0","tag":"v1.1.0","line":"1.1","previousTag":"v1.0.1","reason":"v1.1.0 points at HEAD, release is none"}},"note":"Two strict tags at HEAD: the highest, v1.1.0, is T (its release none; the published v1.0.1 is not T). previousTag: highest below 1.1.0 is v1.0.1."},
  {"id":"RV-18","input":{"fn":"planRun","args":[{"packageVersion":"2.0.0","tags":[{"name":"v1.3.4","commit":"h"}],"head":"h","releases":{"v1.3.4":"draft"}}]},"expected":{"result":{"mode":"resume","version":"1.3.4","tag":"v1.3.4","line":"1.3","previousTag":"","reason":"v1.3.4 points at HEAD, release is draft"}},"note":"Rule 3 takes version and line from T, not from package.json (2.0)."},
  {"id":"RV-19","input":{"fn":"planRun","args":[{"packageVersion":"1.0.0","tags":[{"name":"v1.1.0","commit":"a"}],"head":"h","releases":{}}]},"expected":{"result":{"mode":"fail","version":"","tag":"","line":"","previousTag":"","reason":"version line 1.0 is lower than v1.1.0 — no going back"}},"note":"Rule 4: no tag at HEAD; line (1,0) < (1,1) of the highest tag v1.1.0."},
  {"id":"RV-20","input":{"fn":"planRun","args":[{"packageVersion":"1.9.0","tags":[{"name":"v2.0.0","commit":"a"},{"name":"v1.9.3","commit":"b"}],"head":"h","releases":{}}]},"expected":{"result":{"mode":"fail","version":"","tag":"","line":"","previousTag":"","reason":"version line 1.9 is lower than v2.0.0 — no going back"}},"note":"Rule 4: MAJOR 1 < 2 decides before MINOR (9 > 0 does not matter)."},
  {"id":"RV-21","input":{"fn":"planRun","args":[{"packageVersion":"1.0.0","tags":[],"head":"h","releases":{}}]},"expected":{"result":{"mode":"full","version":"1.0.0","tag":"v1.0.0","line":"1.0","previousTag":"","reason":"new release v1.0.0 on line 1.0"}},"note":"Acceptance step 1 / fall-back: no tags, nextVersion gives 1.0.0; nothing below it, previousTag ''."},
  {"id":"RV-22","input":{"fn":"planRun","args":[{"packageVersion":"1.0.0","tags":[{"name":"v1.0.0","commit":"a"}],"head":"h","releases":{}}]},"expected":{"result":{"mode":"full","version":"1.0.1","tag":"v1.0.1","line":"1.0","previousTag":"v1.0.0","reason":"new release v1.0.1 on line 1.0"}},"note":"Acceptance step 2: highest PATCH on 1.0 is 0, next 1; same line as the highest tag is allowed."},
  {"id":"RV-23","input":{"fn":"planRun","args":[{"packageVersion":"1.0.0","tags":[{"name":"v1.0.0","commit":"a"},{"name":"v1.0.1","commit":"b"}],"head":"h","releases":{}}]},"expected":{"result":{"mode":"full","version":"1.0.2","tag":"v1.0.2","line":"1.0","previousTag":"v1.0.1","reason":"new release v1.0.2 on line 1.0"}},"note":"Acceptance step 3: highest PATCH 1, next 2; previousTag v1.0.1."},
  {"id":"RV-24","input":{"fn":"planRun","args":[{"packageVersion":"1.0.0","tags":[{"name":"v1.0","commit":"a"},{"name":"v1.0.0-rc1","commit":"h"},{"name":"v01.0.0","commit":"b"}],"head":"h","releases":{}}]},"expected":{"result":{"mode":"full","version":"1.0.0","tag":"v1.0.0","line":"1.0","previousTag":"","reason":"new release v1.0.0 on line 1.0"}},"note":"All three tags are non-strict: the rc tag at HEAD does not resume, none counts for the PATCH or previousTag."},
  {"id":"RV-25","input":{"fn":"planRun","args":[{"packageVersion":"1.1.0","tags":[{"name":"v1.0.0","commit":"a"},{"name":"v1.0.1","commit":"b"},{"name":"v1.0.2","commit":"c"}],"head":"h","releases":{}}]},"expected":{"result":{"mode":"full","version":"1.1.0","tag":"v1.1.0","line":"1.1","previousTag":"v1.0.2","reason":"new release v1.1.0 on line 1.1"}},"note":"Acceptance step 4: line 1.1 > 1.0 allowed; no tag on 1.1, PATCH 0; previousTag is the highest below 1.1.0, v1.0.2 on the lower line."},
  {"id":"RV-26","input":{"fn":"planRun","args":[{"packageVersion":"1.1.7","tags":[{"name":"v1.0.0","commit":"a"},{"name":"v1.0.1","commit":"b"},{"name":"v1.0.2","commit":"c"},{"name":"v1.1.0","commit":"d"}],"head":"h","releases":{}}]},"expected":{"result":{"mode":"full","version":"1.1.1","tag":"v1.1.1","line":"1.1","previousTag":"v1.1.0","reason":"new release v1.1.1 on line 1.1"}},"note":"Acceptance step 5: package PATCH 7 is ignored; highest PATCH on 1.1 is 0, next 1; previousTag v1.1.0."},
  {"id":"RV-27","input":{"fn":"planRun","args":[{"packageVersion":"1.0.5","tags":[],"head":"h","releases":{}}]},"expected":{"result":{"mode":"full","version":"1.0.0","tag":"v1.0.0","line":"1.0","previousTag":"","reason":"new release v1.0.0 on line 1.0"}},"note":"PATCH 5 of package.json is ignored: a line without tags starts at 1.0.0."},
  {"id":"RV-28","input":{"fn":"planRun","args":[{"packageVersion":"1.0.0","tags":[{"name":"v1.0.9","commit":"a"},{"name":"v1.0.10","commit":"b"}],"head":"h","releases":{}}]},"expected":{"result":{"mode":"full","version":"1.0.11","tag":"v1.0.11","line":"1.0","previousTag":"v1.0.10","reason":"new release v1.0.11 on line 1.0"}},"note":"Semver: 10 > 9, so the next is 1.0.11 and the previous v1.0.10."},
  {"id":"RV-29","input":{"fn":"planRun","args":[{"packageVersion":"2.0.0","tags":[{"name":"v1.3.4","commit":"a"},{"name":"v1.10.0","commit":"b"}],"head":"h","releases":{}}]},"expected":{"result":{"mode":"full","version":"2.0.0","tag":"v2.0.0","line":"2.0","previousTag":"v1.10.0","reason":"new release v2.0.0 on line 2.0"}},"note":"New major: line 2.0 > 1.10; previousTag is the highest below 2.0.0: (1,10,0) > (1,3,4)."}
]
```

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
