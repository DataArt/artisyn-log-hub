---
reviewed: no
reviewer: none
---

# Security scan summary: row validation, PR block, results file and badge

## Purpose

Turns the scan rows of the CI security scans into what people see: the security block in a pull
request description (FR-23), the `security-scan-results.json` file and the README badge on the
`ci-reports` branch (FR-24). Rows can come from fork-PR artifacts, so they are validated before
anything is rendered, and the PR author's own description text around the block must never change.

## Code

- Implementation: `scripts/ci/security-summary.js` (`normalizeRows`, `renderSummary`,
  `replaceBlock`, `badgeFor`, `buildResults`, `carryOverRows`, `snykIssues`, `renderReport`); its CLI modes
  `results` (`security-scans.yml`, job `publish-results`) and `apply-pr` (`security-report.yml`)
  call them.
- Twins: none.
- Test: `scripts/__tests__/security-scan-summary.algo.test.js` (`npm run test:scripts`).

## Input and output

A row (one scanner result) is `{ tool, scope, version?, status, counts?: {critical, high, medium,
low}, fixable?, link?, note? }`. A normalized row is
`{ tool, scope, label, status, counts, fixable, note }` plus `version` and `link` when they pass
the checks below.

The label table (`LABELS`), in order: `gitleaks/scan` Gitleaks (secrets); `snyk-oss/prod` Snyk Open
Source (prod); `snyk-oss/dev` Snyk Open Source (dev); `snyk-oss/kit` Snyk — installer tarballs;
`dependency-review/pr` Dependency review; `config-guard/repo` Executable-config guard;
`lockfile-lint/npm` Lock-file registry; `npm-signatures/npm` npm registry signatures;
`actionlint/workflows` actionlint; `zizmor/workflows` zizmor; `hadolint/dockerfiles` hadolint;
`compose/config` docker compose config; `snyk-container/image` Snyk Container;
`node-runtime/dockerfile` Node runtime (Dockerfile); `node-runtime/docker-dev` Node runtime
(docker-dev); `virustotal/installer-tgz` VirusTotal — artisyn-hooks-installer.tgz;
`virustotal/hooks-tgz` VirusTotal — hooks.tar.gz.

Status text (`STATUS_TEXT`): `pass` ✅ pass, `warning` ⚠️ warning, `findings` ❌ findings,
`neutral` ⚪ neutral, `skipped` ⏭️ skipped, `error` 💥 tool error, `pending` ⏳ pending.

## Rules

**`normalizeRows(rows)`**

1. Skip anything that is not a plain object, and any row whose `tool` or `scope` does not match
   `^[a-z0-9-]{1,40}$` or whose `tool/scope` pair is not in the label table (dropped silently).
2. The row is invalid when `status` is not in the enum, a present `counts` is not an object, a
   present count (`critical`, `high`, `medium`, `low`) or `fixable` is not an integer from 0 to
   1,000,000, or a present `note` is not a string. An invalid row becomes
   `{tool, scope, label, status: 'error', counts: all 0, fixable: 0, note: 'invalid row'}`.
3. A valid row keeps its status; missing counts are 0; `fixable` defaults to 0; `label` comes
   from the table, never from the row.
4. `note`: every character outside `[A-Za-z0-9 .,:;()/_@#+=%'-]` is removed, then it is cut to 200
   characters. A missing note is `''`.
5. `link` is kept only when it starts with `https://github.com/DataArt/artisyn-log-hub/`,
   `https://www.virustotal.com/gui/file/` or `https://app.snyk.io/` **and** contains only URL
   characters `[A-Za-z0-9._~:/?#@!$&*+,;=%-]` (no spaces, quotes, brackets or parentheses, so it
   cannot break out of the Markdown link); otherwise the key is dropped.
6. `version` is kept only when it is a string matching `^[A-Za-z0-9._+-]{1,40}$`.
7. When a `tool/scope` pair repeats, the last occurrence wins. Output is sorted by label-table
   order.

**`renderSummary(rows, meta)`**, `meta = {sha, date, runUrl, pending}`; rows are normalized first.
Lines, joined with `\n`:

1. `<!-- security-scan:start -->`
2. `## Security scan`
3. ``_Commit `<sha7>` · updated <YYYY-MM-DD HH:MM> UTC · [runs](<runUrl>)_`` where `sha7` is the
   first 7 hex characters of `sha` and the date is UTC. The ` · [runs](…)` part is left out when
   `runUrl` fails the link rule 5.
4. Only when `pending` is non-empty: `_Still running: <names joined by ", ">_`.
5. An empty line.
6. With rows: `| Tool | Status | Critical | High | Medium | Low | Details |`, then
   `|---|---|---|---|---|---|---|`, then one line per row:
   `| <label> | <status text> | <critical> | <high> | <medium> | <low> | <details> |`, where
   details is `[link](<link>)` when there is a link, then a space and the note when there is one
   (empty when neither). Without rows: the single line `_No scan results yet._`.
7. `<!-- security-scan:end -->`

**`replaceBlock(body, block)`**, with `START` = `<!-- security-scan:start -->`, `END` =
`<!-- security-scan:end -->`, `BODY_MAX` = 65,536:

1. A `null` body is `''`.
2. No `START` in the body: the result is `body.trimEnd()`, plus `\n\n` when that is non-empty,
   plus `block`.
3. `START` present and the **last** `END` lies after the **first** `START`: the text from the first
   `START` to the end of that last `END` is replaced by `block`; everything before and after is
   kept byte for byte (CRLF included).
4. `START` without a later `END`: everything from `START` to the end is replaced by `block`.
5. When the result is longer than `BODY_MAX`, steps 2-4 are redone with the fallback block
   `<!-- security-scan:start -->\n## Security scan\n_Summary too long — see the workflow runs._\n<!-- security-scan:end -->`.
   A result of exactly `BODY_MAX` characters is kept.

Applying the same block twice gives the same body (idempotent).

**`badgeFor(rows)`**: rows are normalized; rows with scope `dev` or status `skipped` are ignored.
Returns `{schemaVersion: 1, label: 'security scan', message, color}` by the first matching rule:

1. any `findings`: `<n> failing`, `red` (n = number of `findings` rows);
2. any `error`: `scan error`, `lightgrey`;
3. any `warning` or `neutral`: `<n> warnings`, `yellow` (n = number of those rows);
4. otherwise `passing`, `brightgreen`.

**`buildResults(rows, meta)`** returns `{schema: 1, commit: meta.sha, date: meta.date, ref: 'main',
rows: normalizeRows(rows)}`.

**`carryOverRows(rows, previous)`** — the rows of this run plus the rows of the previously
published `security-scan-results.json` that this run did not produce (a push to `main` runs no
Snyk Container and no VirusTotal):

1. When `previous` is not an object with a `rows` array, the result is `normalizeRows(rows)`.
2. Otherwise every normalized previous row whose `tool/scope` is not among this run's rows is
   carried. Its note becomes `as of <YYYY-MM-DD HH:MM> UTC: <note>` (`as of <date> UTC` when the
   note is empty), with the date of `previous.date`; a note that already starts with `as of ` is
   kept unchanged, so a row carried again keeps its original date.
3. A row this run produced always wins over the previous one. The result is normalized (sorted by
   the label table).

**`snykIssues(result)`** — the critical and high issues of one raw Snyk `--json` result (one
project object or an array of them):

1. Projects that are not objects or have no `vulnerabilities` array are skipped. `project` is the
   project's `displayTargetFile` when it matches `^[A-Za-z0-9._/-]{1,200}$`, otherwise `''`.
2. Only `severity` `critical` or `high` is kept; the `id` must match `^[A-Za-z0-9:_.-]{1,100}$`
   (otherwise the issue is dropped).
3. `package` and `version` are kept when they match `^[A-Za-z0-9@/._+:~-]{1,214}$`, otherwise `''`;
   `fixedIn` keeps only the entries matching that pattern; `title` is sanitised like a row note.
4. One entry per `id` + `package`; the first occurrence wins.
5. Sorted critical first, then by `package`, then by `id` (plain string order).

Entry: `{severity, id, title, package, version, fixedIn, project}`.

**`renderReport(rows, meta, issues)`** — the `REPORT.md` page the README badge links to; rows are
normalized, `meta = {sha, date, runUrl}`, `issues` maps `snyk-oss/prod`, `snyk-oss/dev`,
`snyk-oss/kit` and `snyk-container/image` to a `snykIssues` list. Sections, joined with `\n`:

1. `# Security scan report`, then the line
   ``_Commit [`<sha7>`](https://github.com/DataArt/artisyn-log-hub/commit/<sha>) on `main` · updated <date> UTC · [workflow run](<runUrl>)_``;
   `sha` keeps lowercase hex only (none: `` `unknown` `` without a link), the run link is left out
   when `runUrl` fails link rule 5; then the badge note and the KB link.
2. `## Summary` with the same table as `renderSummary` (or `_No scan results yet._`).
3. `## Snyk — critical and high issues`, then one `### <label>` per Snyk row present, in that key
   order: a skipped row shows `_Skipped: <note>._`; a key missing from `issues` shows
   `_Issue list not available — see the workflow run._`; an empty list
   `_No critical or high issues._`; otherwise the table
   `| Severity | Issue | Package | Fixed in | Project |` with the id linked to
   `https://security.snyk.io/vuln/<id>`, `` `<package>@<version>` ``, the fixed-in versions joined by
   `, ` (or `no fix yet`) and `` `<project>` ``; at most 50 lines, then `_…and <n> more — see the
   workflow run._`.
4. `## VirusTotal`: one `- <label>: <status text> · <note> · [report](<link>)` line per
   VirusTotal row (empty parts left out), or `_Not scanned in this run._`.
5. `## More` with the Code scanning and Dependabot alerts links, and a final empty line.

## Edge cases

- `replaceBlock`: empty and `null` body: SS-01, SS-02; author text with trailing blank lines:
  SS-03; existing block: SS-04; CRLF author text and text after `END`: SS-05, SS-06; `START`
  without `END`: SS-07; two blocks collapse into one: SS-08; idempotence: SS-09; the 65,536 limit
  on both sides: SS-10 (kept), SS-11 (fallback).
- `normalizeRows`: unknown pair dropped: SS-12; bad status and fractional count become `error`:
  SS-13, SS-14; links allowed, foreign and with a parenthesis: SS-15; note characters and the
  200-character cut: SS-16, SS-17; bad version dropped: SS-18; last wins: SS-19; sort order and
  non-object entries: SS-20.
- `renderSummary`: two rows with link, note and an empty details cell: SS-21; the pending line:
  SS-22; no rows and a foreign run URL: SS-23.
- `badgeFor`: the four outcomes: SS-24 to SS-27; dev rows ignored: SS-28; no rows: SS-29.
- `buildResults`: SS-30.
- `snykIssues`: filtering, dedupe across projects, bad id/package/fixedIn, sort: SS-31; no
  vulnerabilities array: SS-32.
- `renderReport`: issue table, missing list, skipped row and VirusTotal line: SS-33; no rows, bad
  sha and date, foreign run URL: SS-34.
- `carryOverRows`: own row wins, note prefixes, already-carried note kept: SS-35; previous without
  rows: SS-36.

## Examples

`input.fn` is the exported function to call and `input.args` its argument list;
`expected.result` is its exact return value. In `args` and `result`, an object of the exact shape
`{"$repeat": ["<text>", <n>]}` stands for `<text>` repeated `n` times (used for the long-body
rows). In the `replaceBlock` rows the new block is
`<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->` (called "the new block" in the
notes).

Rows (36): [`docs/algorithm-examples/security-scan-summary.json`](../../algorithm-examples/security-scan-summary.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- `replaceBlock` replacing up to the first `END` instead of the last -> SS-08; trimming the text
  after the block or rewriting CRLF -> SS-05; no separator logic (always `\n\n`) -> SS-01;
  keeping the text after a dangling `START` instead of replacing it -> SS-07; `>=` instead of
  `>` for the length limit -> SS-10; no fallback -> SS-11.
- `normalizeRows` taking the label from the row or keeping unknown pairs -> SS-12; dropping
  invalid rows instead of turning them into `error` -> SS-13, SS-14; checking only the link
  prefix -> SS-15; no note sanitising or no cut -> SS-16, SS-17; first occurrence wins -> SS-19;
  input order kept -> SS-20.
- `renderSummary` keeping a foreign `runUrl` -> SS-23; no pending line -> SS-22; full sha or
  seconds in the date -> SS-21.
- `badgeFor` counting dev rows -> SS-28; counting skipped rows or checking warnings before errors
  -> SS-25, SS-27; counting only `warning`, not `neutral` -> SS-26.
- `snykIssues` keeping medium issues, last occurrence winning, keeping an invalid id or package,
  or sorting high before critical -> SS-31.
- `renderReport` showing "no issues" for a missing list, ignoring a skipped row's note, or
  keeping a foreign run URL -> SS-33, SS-34.
- `carryOverRows` letting the previous row win, re-prefixing an already-carried note, or failing
  on a malformed previous file -> SS-35, SS-36.

## Where the result is visible

The `## Security scan` block in the pull request description (written by `security-report.yml`),
`security-scan-results.json`, `badges/security.json` and `REPORT.md` on the `ci-reports` branch
(written by the `publish-results` job), and the security badge in `README.md`, which links to
`REPORT.md`. Safe behaviour: an untrusted
row can at worst show as `💥 tool error`; it cannot add a foreign link or Markdown to the PR.
