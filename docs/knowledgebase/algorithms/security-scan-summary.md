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
  `replaceBlock`, `badgeFor`, `buildResults`, `snykIssues`, `renderReport`); its CLI modes
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

## Examples

`input.fn` is the exported function to call and `input.args` its argument list;
`expected.result` is its exact return value. In `args` and `result`, an object of the exact shape
`{"$repeat": ["<text>", <n>]}` stands for `<text>` repeated `n` times (used for the long-body
rows). In the `replaceBlock` rows the new block is
`<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->` (called "the new block" in the
notes).

```examples
[
  {
    "id": "SS-01",
    "input": {"fn": "replaceBlock", "args": ["", "<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->"]},
    "expected": {"result": "<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->"},
    "note": "No START; ''.trimEnd() is empty, so no separator: the result is the new block alone."
  },
  {
    "id": "SS-02",
    "input": {"fn": "replaceBlock", "args": [null, "<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->"]},
    "expected": {"result": "<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->"},
    "note": "Rule 1: null body is ''; then as SS-01."
  },
  {
    "id": "SS-03",
    "input": {"fn": "replaceBlock", "args": ["Fixes #12\n\n\n", "<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->"]},
    "expected": {"result": "Fixes #12\n\n<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->"},
    "note": "No START: trimEnd gives 'Fixes #12', non-empty, so + '\\n\\n' + the new block."
  },
  {
    "id": "SS-04",
    "input": {"fn": "replaceBlock", "args": ["Intro\n\n<!-- security-scan:start -->\nOLD\n<!-- security-scan:end -->", "<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->"]},
    "expected": {"result": "Intro\n\n<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->"},
    "note": "Rule 3: START..END replaced by the new block; 'Intro\\n\\n' before it kept."
  },
  {
    "id": "SS-05",
    "input": {"fn": "replaceBlock", "args": ["Intro\r\nline 2\r\n\r\n<!-- security-scan:start -->\nOLD\n<!-- security-scan:end -->\r\nOutro\r\n", "<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->"]},
    "expected": {"result": "Intro\r\nline 2\r\n\r\n<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->\r\nOutro\r\n"},
    "note": "Rule 3: only START..END is replaced; the CRLF text before ('Intro\\r\\nline 2\\r\\n\\r\\n') and after ('\\r\\nOutro\\r\\n') is kept byte for byte, no trimming."
  },
  {
    "id": "SS-06",
    "input": {"fn": "replaceBlock", "args": ["<!-- security-scan:start -->\nOLD\n<!-- security-scan:end -->\nPlease review the migration.", "<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->"]},
    "expected": {"result": "<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->\nPlease review the migration."},
    "note": "Rule 3: the block at the top is replaced; the author text after END is kept."
  },
  {
    "id": "SS-07",
    "input": {"fn": "replaceBlock", "args": ["Intro\n<!-- security-scan:start -->\nOLD, cut off", "<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->"]},
    "expected": {"result": "Intro\n<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->"},
    "note": "Rule 4: START without END; everything from START to the end is replaced, 'Intro\\n' kept."
  },
  {
    "id": "SS-08",
    "input": {"fn": "replaceBlock", "args": ["A\n<!-- security-scan:start -->1<!-- security-scan:end -->\nB\n<!-- security-scan:start -->2<!-- security-scan:end -->\nC", "<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->"]},
    "expected": {"result": "A\n<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->\nC"},
    "note": "Rule 3: from the first START to the end of the last END (both old blocks and the 'B' between them) becomes one new block; 'A\\n' and '\\nC' kept."
  },
  {
    "id": "SS-09",
    "input": {"fn": "replaceBlock", "args": ["Intro\n\n<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->", "<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->"]},
    "expected": {"result": "Intro\n\n<!-- security-scan:start -->\nNEW\n<!-- security-scan:end -->"},
    "note": "Idempotence: the body is the SS-04 result; replacing the block with itself gives the same body."
  },
  {
    "id": "SS-10",
    "input": {"fn": "replaceBlock", "args": ["", {"$repeat": ["y", 65536]}]},
    "expected": {"result": {"$repeat": ["y", 65536]}},
    "note": "Rule 2 gives the block itself, 65,536 characters; not longer than BODY_MAX, so it is kept."
  },
  {
    "id": "SS-11",
    "input": {"fn": "replaceBlock", "args": ["", {"$repeat": ["y", 65537]}]},
    "expected": {"result": "<!-- security-scan:start -->\n## Security scan\n_Summary too long — see the workflow runs._\n<!-- security-scan:end -->"},
    "note": "Rule 2 gives 65,537 characters > BODY_MAX; rule 5 redoes rule 2 with the fallback block: '' + fallback."
  },
  {
    "id": "SS-12",
    "input": {"fn": "normalizeRows", "args": [[{"tool": "foo", "scope": "bar", "status": "pass"}, {"tool": "config-guard", "scope": "repo", "status": "pass"}]]},
    "expected": {"result": [{"tool": "config-guard", "scope": "repo", "label": "Executable-config guard", "status": "pass", "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0}, "fixable": 0, "note": ""}]},
    "note": "Rule 1: foo/bar is not in the label table and is dropped. config-guard/repo is valid: counts 0, fixable 0, note '', label from the table."
  },
  {
    "id": "SS-13",
    "input": {"fn": "normalizeRows", "args": [[{"tool": "zizmor", "scope": "workflows", "status": "broken", "counts": {"high": 3}, "note": "x"}]]},
    "expected": {"result": [{"tool": "zizmor", "scope": "workflows", "label": "zizmor", "status": "error", "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0}, "fixable": 0, "note": "invalid row"}]},
    "note": "Rule 2: status 'broken' is not in the enum -> error row with zero counts and note 'invalid row'; the row's own counts and note are discarded."
  },
  {
    "id": "SS-14",
    "input": {"fn": "normalizeRows", "args": [[{"tool": "hadolint", "scope": "dockerfiles", "status": "warning", "counts": {"medium": 1.5}}]]},
    "expected": {"result": [{"tool": "hadolint", "scope": "dockerfiles", "label": "hadolint", "status": "error", "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0}, "fixable": 0, "note": "invalid row"}]},
    "note": "Rule 2: medium = 1.5 is not an integer -> error row, note 'invalid row'."
  },
  {
    "id": "SS-15",
    "input": {"fn": "normalizeRows", "args": [[
      {"tool": "virustotal", "scope": "installer-tgz", "status": "pass", "link": "https://www.virustotal.com/gui/file/abc123"},
      {"tool": "virustotal", "scope": "hooks-tgz", "status": "pass", "link": "https://evil.example.com/x"},
      {"tool": "snyk-oss", "scope": "prod", "status": "pass", "link": "https://github.com/DataArt/artisyn-log-hub/x) [y](https://evil.example.com"}
    ]]},
    "expected": {"result": [
      {"tool": "snyk-oss", "scope": "prod", "label": "Snyk Open Source (prod)", "status": "pass", "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0}, "fixable": 0, "note": ""},
      {"tool": "virustotal", "scope": "installer-tgz", "label": "VirusTotal — artisyn-hooks-installer.tgz", "status": "pass", "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0}, "fixable": 0, "note": "", "link": "https://www.virustotal.com/gui/file/abc123"},
      {"tool": "virustotal", "scope": "hooks-tgz", "label": "VirusTotal — hooks.tar.gz", "status": "pass", "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0}, "fixable": 0, "note": ""}
    ]},
    "note": "Rule 5: the VirusTotal permalink has an allowed prefix and only URL characters -> kept. evil.example.com has no allowed prefix -> dropped. The snyk link has the GitHub prefix but holds ')', '[', ']' and a space -> dropped. The rows stay valid. Rule 7 sorts snyk-oss/prod (row 2 of the table) before the two VirusTotal rows (16, 17)."
  },
  {
    "id": "SS-16",
    "input": {"fn": "normalizeRows", "args": [[{"tool": "snyk-oss", "scope": "dev", "status": "findings", "counts": {"high": 2}, "fixable": 1, "note": "2 <b>high</b> | `x` ok"}]]},
    "expected": {"result": [{"tool": "snyk-oss", "scope": "dev", "label": "Snyk Open Source (dev)", "status": "findings", "counts": {"critical": 0, "high": 2, "medium": 0, "low": 0}, "fixable": 1, "note": "2 bhigh/b  x ok"}]},
    "note": "Rule 4: '<', '>', '|' and backticks are removed: '2 ' + 'b' + 'high' + '/b' + ' ' + ' ' + 'x' + ' ok' = '2 bhigh/b  x ok' (two spaces where ' | ' was). Counts high 2, fixable 1 kept."
  },
  {
    "id": "SS-17",
    "input": {"fn": "normalizeRows", "args": [[{"tool": "compose", "scope": "config", "status": "findings", "note": {"$repeat": ["a", 205]}}]]},
    "expected": {"result": [{"tool": "compose", "scope": "config", "label": "docker compose config", "status": "findings", "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0}, "fixable": 0, "note": {"$repeat": ["a", 200]}}]},
    "note": "Rule 4: 205 allowed characters are cut to 200."
  },
  {
    "id": "SS-18",
    "input": {"fn": "normalizeRows", "args": [[{"tool": "actionlint", "scope": "workflows", "status": "pass", "version": "1.7.7"}, {"tool": "zizmor", "scope": "workflows", "status": "pass", "version": "1.0 <script>"}]]},
    "expected": {"result": [
      {"tool": "actionlint", "scope": "workflows", "label": "actionlint", "status": "pass", "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0}, "fixable": 0, "note": "", "version": "1.7.7"},
      {"tool": "zizmor", "scope": "workflows", "label": "zizmor", "status": "pass", "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0}, "fixable": 0, "note": ""}
    ]},
    "note": "Rule 6: 1.7.7 matches ^[A-Za-z0-9._+-]{1,40}$ and is kept; '1.0 <script>' holds a space and '<', so the key is dropped (the row stays valid)."
  },
  {
    "id": "SS-19",
    "input": {"fn": "normalizeRows", "args": [[{"tool": "snyk-oss", "scope": "prod", "status": "findings", "counts": {"high": 4}}, {"tool": "snyk-oss", "scope": "prod", "status": "pass"}]]},
    "expected": {"result": [{"tool": "snyk-oss", "scope": "prod", "label": "Snyk Open Source (prod)", "status": "pass", "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0}, "fixable": 0, "note": ""}]},
    "note": "Rule 7: snyk-oss/prod appears twice; the last one (pass, no counts) wins."
  },
  {
    "id": "SS-20",
    "input": {"fn": "normalizeRows", "args": [[{"tool": "virustotal", "scope": "hooks-tgz", "status": "pass"}, null, "row", {"tool": "gitleaks", "scope": "scan", "status": "pass"}, {"tool": "snyk-oss", "scope": "dev", "status": "skipped"}]]},
    "expected": {"result": [
      {"tool": "gitleaks", "scope": "scan", "label": "Gitleaks (secrets)", "status": "pass", "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0}, "fixable": 0, "note": ""},
      {"tool": "snyk-oss", "scope": "dev", "label": "Snyk Open Source (dev)", "status": "skipped", "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0}, "fixable": 0, "note": ""},
      {"tool": "virustotal", "scope": "hooks-tgz", "label": "VirusTotal — hooks.tar.gz", "status": "pass", "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0}, "fixable": 0, "note": ""}
    ]},
    "note": "Rule 1 skips null and the string. Rule 7 sorts by table position: gitleaks/scan (1), snyk-oss/dev (3), virustotal/hooks-tgz (17)."
  },
  {
    "id": "SS-21",
    "input": {"fn": "renderSummary", "args": [
      [
        {"tool": "config-guard", "scope": "repo", "status": "pass"},
        {"tool": "snyk-oss", "scope": "prod", "status": "findings", "counts": {"critical": 0, "high": 2, "medium": 1, "low": 0}, "fixable": 2, "link": "https://github.com/DataArt/artisyn-log-hub/actions/runs/123", "note": "2 fixable high/critical"}
      ],
      {"sha": "0123456789abcdef", "date": "2026-10-23T16:27:45Z", "runUrl": "https://github.com/DataArt/artisyn-log-hub/actions/runs/123", "pending": []}
    ]},
    "expected": {"result": "<!-- security-scan:start -->\n## Security scan\n_Commit `0123456` · updated 2026-10-23 16:27 UTC · [runs](https://github.com/DataArt/artisyn-log-hub/actions/runs/123)_\n\n| Tool | Status | Critical | High | Medium | Low | Details |\n|---|---|---|---|---|---|---|\n| Snyk Open Source (prod) | ❌ findings | 0 | 2 | 1 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/123) 2 fixable high/critical |\n| Executable-config guard | ✅ pass | 0 | 0 | 0 | 0 |  |\n<!-- security-scan:end -->"},
    "note": "Lines 1-3: markers, heading, sha7 0123456, date 16:27 UTC (seconds dropped), runs link allowed. Pending empty: no line 4. Blank line, header, separator. Rows sorted: snyk-oss/prod (2) before config-guard/repo (6). Snyk details = '[link](...)' + ' ' + note. config-guard has no link and note '' -> empty cell '|  |'. End marker."
  },
  {
    "id": "SS-22",
    "input": {"fn": "renderSummary", "args": [
      [{"tool": "gitleaks", "scope": "scan", "status": "pending"}],
      {"sha": "fedcba9876543210", "date": "2026-10-23T08:05:00Z", "runUrl": "https://github.com/DataArt/artisyn-log-hub/actions/runs/7", "pending": ["security-scans", "virustotal"]}
    ]},
    "expected": {"result": "<!-- security-scan:start -->\n## Security scan\n_Commit `fedcba9` · updated 2026-10-23 08:05 UTC · [runs](https://github.com/DataArt/artisyn-log-hub/actions/runs/7)_\n_Still running: security-scans, virustotal_\n\n| Tool | Status | Critical | High | Medium | Low | Details |\n|---|---|---|---|---|---|---|\n| Gitleaks (secrets) | ⏳ pending | 0 | 0 | 0 | 0 |  |\n<!-- security-scan:end -->"},
    "note": "Pending non-empty: line 4 '_Still running: security-scans, virustotal_' after the commit line. One row with status text '⏳ pending' and zero counts."
  },
  {
    "id": "SS-23",
    "input": {"fn": "renderSummary", "args": [[], {"sha": "abcdef1234", "date": "2026-10-23T08:05:00Z", "runUrl": "https://evil.example.com/run", "pending": []}]},
    "expected": {"result": "<!-- security-scan:start -->\n## Security scan\n_Commit `abcdef1` · updated 2026-10-23 08:05 UTC_\n\n_No scan results yet._\n<!-- security-scan:end -->"},
    "note": "runUrl fails link rule 5, so ' · [runs](...)' is left out. No rows: the table is replaced by '_No scan results yet._'."
  },
  {
    "id": "SS-24",
    "input": {"fn": "badgeFor", "args": [[
      {"tool": "snyk-oss", "scope": "prod", "status": "findings"},
      {"tool": "zizmor", "scope": "workflows", "status": "findings"},
      {"tool": "hadolint", "scope": "dockerfiles", "status": "warning"},
      {"tool": "config-guard", "scope": "repo", "status": "error"}
    ]]},
    "expected": {"result": {"schemaVersion": 1, "label": "security scan", "message": "2 failing", "color": "red"}},
    "note": "Rule 1 matches first: two findings rows -> '2 failing', red; the error and warning rows do not matter."
  },
  {
    "id": "SS-25",
    "input": {"fn": "badgeFor", "args": [[{"tool": "config-guard", "scope": "repo", "status": "error"}, {"tool": "hadolint", "scope": "dockerfiles", "status": "warning"}]]},
    "expected": {"result": {"schemaVersion": 1, "label": "security scan", "message": "scan error", "color": "lightgrey"}},
    "note": "No findings; rule 2: one error row -> 'scan error', lightgrey, before the warning rule."
  },
  {
    "id": "SS-26",
    "input": {"fn": "badgeFor", "args": [[{"tool": "hadolint", "scope": "dockerfiles", "status": "warning"}, {"tool": "virustotal", "scope": "hooks-tgz", "status": "neutral"}, {"tool": "config-guard", "scope": "repo", "status": "pass"}]]},
    "expected": {"result": {"schemaVersion": 1, "label": "security scan", "message": "2 warnings", "color": "yellow"}},
    "note": "No findings, no error; rule 3: one warning + one neutral = 2 -> '2 warnings', yellow."
  },
  {
    "id": "SS-27",
    "input": {"fn": "badgeFor", "args": [[{"tool": "config-guard", "scope": "repo", "status": "pass"}, {"tool": "actionlint", "scope": "workflows", "status": "skipped"}]]},
    "expected": {"result": {"schemaVersion": 1, "label": "security scan", "message": "passing", "color": "brightgreen"}},
    "note": "The skipped row is ignored; one pass row matches none of rules 1-3 -> 'passing', brightgreen."
  },
  {
    "id": "SS-28",
    "input": {"fn": "badgeFor", "args": [[{"tool": "snyk-oss", "scope": "dev", "status": "findings"}, {"tool": "snyk-oss", "scope": "prod", "status": "pass"}]]},
    "expected": {"result": {"schemaVersion": 1, "label": "security scan", "message": "passing", "color": "brightgreen"}},
    "note": "The dev row is ignored (devDependencies do not ship); the prod pass row alone -> 'passing'."
  },
  {
    "id": "SS-29",
    "input": {"fn": "badgeFor", "args": [[]]},
    "expected": {"result": {"schemaVersion": 1, "label": "security scan", "message": "passing", "color": "brightgreen"}},
    "note": "No rows: none of rules 1-3 match -> 'passing'."
  },
  {
    "id": "SS-30",
    "input": {"fn": "buildResults", "args": [
      [{"tool": "config-guard", "scope": "repo", "status": "findings", "counts": {"high": 1}, "note": ".mcp.json:mcpServers.evil"}, {"tool": "gitleaks", "scope": "scan", "status": "pass"}, {"tool": "foo", "scope": "bar", "status": "pass"}],
      {"sha": "0123456789abcdef0123456789abcdef01234567", "date": "2026-10-24T03:17:00.000Z"}
    ]},
    "expected": {"result": {"schema": 1, "commit": "0123456789abcdef0123456789abcdef01234567", "date": "2026-10-24T03:17:00.000Z", "ref": "main", "rows": [
      {"tool": "gitleaks", "scope": "scan", "label": "Gitleaks (secrets)", "status": "pass", "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0}, "fixable": 0, "note": ""},
      {"tool": "config-guard", "scope": "repo", "label": "Executable-config guard", "status": "findings", "counts": {"critical": 0, "high": 1, "medium": 0, "low": 0}, "fixable": 0, "note": ".mcp.json:mcpServers.evil"}
    ]}},
    "note": "schema 1, commit = meta.sha, date = meta.date, ref 'main'. rows = normalizeRows: foo/bar dropped, gitleaks/scan (1) sorted before config-guard/repo (6); the note's characters are all allowed."
  },
  {"id":"SS-31","input":{"fn":"snykIssues","args":[[{"displayTargetFile":"client/package.json","vulnerabilities":[{"id":"SNYK-JS-B-2","severity":"high","packageName":"zeta","version":"1.0.0","title":"ReDoS | bad","fixedIn":["1.0.1"]},{"id":"SNYK-JS-A-1","severity":"critical","packageName":"alpha","version":"2.0.0","title":"RCE","fixedIn":[]},{"id":"SNYK-JS-C-3","severity":"medium","packageName":"beta","version":"1.0.0","title":"x","fixedIn":[]},{"id":"bad id!","severity":"high","packageName":"gamma","version":"1","title":"x"}]},{"displayTargetFile":"server/package-lock.json","vulnerabilities":[{"id":"SNYK-JS-B-2","severity":"high","packageName":"zeta","version":"1.0.0","title":"dup","fixedIn":["1.0.1"]},{"id":"SNYK-JS-D-4","severity":"high","packageName":"a b","version":"<x>","title":"odd","fixedIn":["ok","b ad"]}]}]]},"expected":{"result":[{"severity":"critical","id":"SNYK-JS-A-1","title":"RCE","package":"alpha","version":"2.0.0","fixedIn":[],"project":"client/package.json"},{"severity":"high","id":"SNYK-JS-D-4","title":"odd","package":"","version":"","fixedIn":["ok"],"project":"server/package-lock.json"},{"severity":"high","id":"SNYK-JS-B-2","title":"ReDoS  bad","package":"zeta","version":"1.0.0","fixedIn":["1.0.1"],"project":"client/package.json"}]},"note":"Two projects: medium dropped; the id with a space dropped; SNYK-JS-B-2 repeated in the second project kept once (first project wins); the package and version failing their pattern become empty, the bad fixedIn entry is dropped; the | in the title is removed; critical first, then by package (empty sorts first) and id."},
  {"id":"SS-32","input":{"fn":"snykIssues","args":[{"ok":true}]},"expected":{"result":[]},"note":"A project without a vulnerabilities array gives no issues."},
  {"id":"SS-33","input":{"fn":"renderReport","args":[[{"tool":"virustotal","scope":"hooks-tgz","status":"pass","note":"0/75 engines","link":"https://www.virustotal.com/gui/file/abc"},{"tool":"snyk-container","scope":"image","status":"skipped","note":"docs-only change"},{"tool":"snyk-oss","scope":"dev","status":"findings","counts":{"high":1}},{"tool":"snyk-oss","scope":"prod","status":"findings","counts":{"critical":1},"link":"https://github.com/DataArt/artisyn-log-hub/actions/runs/1"}],{"sha":"0123456789abcdef0123456789abcdef01234567","date":"2026-10-24T03:17:00.000Z","runUrl":"https://github.com/DataArt/artisyn-log-hub/actions/runs/1"},{"snyk-oss/prod":[{"severity":"critical","id":"SNYK-JS-A-1","title":"RCE","package":"alpha","version":"2.0.0","fixedIn":[],"project":"server/package-lock.json"}]}]},"expected":{"result":"# Security scan report\n\n_Commit [`0123456`](https://github.com/DataArt/artisyn-log-hub/commit/0123456789abcdef0123456789abcdef01234567) on `main` · updated 2026-10-24 03:17 UTC · [workflow run](https://github.com/DataArt/artisyn-log-hub/actions/runs/1)_\n\nThe README badge counts every row below except Snyk Open Source (dev) — devDependencies do not\nship — and skipped rows. How the scans work: [ci-security-scans.md](https://github.com/DataArt/artisyn-log-hub/blob/main/docs/knowledgebase/ci-security-scans.md).\n\n## Summary\n\n| Tool | Status | Critical | High | Medium | Low | Details |\n|---|---|---|---|---|---|---|\n| Snyk Open Source (prod) | ❌ findings | 1 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/1) |\n| Snyk Open Source (dev) | ❌ findings | 0 | 1 | 0 | 0 |  |\n| Snyk Container | ⏭️ skipped | 0 | 0 | 0 | 0 | docs-only change |\n| VirusTotal — hooks.tar.gz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/abc) 0/75 engines |\n\n## Snyk — critical and high issues\n\n### Snyk Open Source (prod)\n\n| Severity | Issue | Package | Fixed in | Project |\n|---|---|---|---|---|\n| critical | [SNYK-JS-A-1](https://security.snyk.io/vuln/SNYK-JS-A-1) RCE | `alpha@2.0.0` | no fix yet | `server/package-lock.json` |\n\n### Snyk Open Source (dev)\n\n_Issue list not available — see the workflow run._\n\n### Snyk Container\n\n_Skipped: docs-only change._\n\n## VirusTotal\n\n- VirusTotal — hooks.tar.gz: ✅ pass · 0/75 engines · [report](https://www.virustotal.com/gui/file/abc)\n\n## More\n\n- [Code scanning alerts](https://github.com/DataArt/artisyn-log-hub/security/code-scanning) — Snyk and zizmor findings with file and line\n- [Dependabot alerts](https://github.com/DataArt/artisyn-log-hub/security/dependabot)\n"},"note":"Rows sorted by the label table; prod has an issue list (table with project), dev has none (not available), the container row is skipped (its note), the VirusTotal row lists its verdict and permalink."},
  {"id":"SS-34","input":{"fn":"renderReport","args":[[],{"sha":"zz","date":"x","runUrl":"https://evil.example/"},{}]},"expected":{"result":"# Security scan report\n\n_Commit `unknown` on `main` · updated unknown UTC_\n\nThe README badge counts every row below except Snyk Open Source (dev) — devDependencies do not\nship — and skipped rows. How the scans work: [ci-security-scans.md](https://github.com/DataArt/artisyn-log-hub/blob/main/docs/knowledgebase/ci-security-scans.md).\n\n## Summary\n\n_No scan results yet._\n\n## Snyk — critical and high issues\n\n## VirusTotal\n\n_Not scanned in this run._\n\n## More\n\n- [Code scanning alerts](https://github.com/DataArt/artisyn-log-hub/security/code-scanning) — Snyk and zizmor findings with file and line\n- [Dependabot alerts](https://github.com/DataArt/artisyn-log-hub/security/dependabot)\n"},"note":"No rows: no Snyk sections, VirusTotal not scanned; a non-hex sha gives `unknown`, a bad date `unknown`, a foreign run URL is left out."}
]
```

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

## Where the result is visible

The `## Security scan` block in the pull request description (written by `security-report.yml`),
`security-scan-results.json`, `badges/security.json` and `REPORT.md` on the `ci-reports` branch
(written by the `publish-results` job), and the security badge in `README.md`, which links to
`REPORT.md`. Safe behaviour: an untrusted
row can at worst show as `💥 tool error`; it cannot add a foreign link or Markdown to the PR.
