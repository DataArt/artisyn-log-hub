---
reviewed: no
reviewer: none
---

# Executable-config guard: which repo config may make a developer's machine run code

## Purpose

Flags the repo files that make a developer's machine run code or send data to a server as soon as
the repo is opened in Claude Code (`.artisyn/config/log-hub.json`, `.claude/settings.json`,
`.mcp.json`), and a tracked personal `log-hub.local.json`. A pull request that points telemetry at a
foreign server, adds a hook, enables a plugin from an unknown marketplace or adds an MCP server
outside the allowlist gets a `config-guard/repo` finding row in the PR security block (FR-4).

## Code

- Implementation: `scripts/ci/config-guard.js` (`checkConfigGuard`); its CLI (`--out <dir>`) runs it
  in the `config-guard` job of `.github/workflows/security-scans.yml`.
- Twins: none.
- Test: `scripts/__tests__/executable-config-guard.algo.test.js` (`npm run test:scripts`).

## Input and output

`checkConfigGuard({ files, tracked, allowlist })`, pure, no I/O:

- `files`: maps a repo path to its content, a string, or `null` (or an absent key) when the file is
  missing. Only the three guarded paths are read: `.artisyn/config/log-hub.json`,
  `.claude/settings.json`, `.mcp.json`.
- `tracked`: the `git ls-files` list (an array of repo paths; a newline-separated string is also
  accepted).
- `allowlist`: `.github/security/config-guard-allowlist.json`, `{ "mcpStdio": [ { "commands": [...],
  "package": "<name>@<version>" } ] }`.

It returns `{ findings: [{ file, key, rule }] }`.

## Rules

1. **Parse.** Each guarded file that is present is parsed as JSON. Content that does not parse, or
   parses to anything other than a plain object (an array, a string, `null`), is `invalid-json`
   with `key: ''`, and that file gets no other finding. A missing file passes every rule.
2. **Checks**, one table row after another; within a row the keys are taken in file order:

   | # | File | Key | Passes when | `rule` on failure |
   |---|---|---|---|---|
   | 1 | `.artisyn/config/log-hub.json` | `serverUrl` | Absent or `''`, or matches `^http://(localhost\|127\.0\.0\.1):\d+/?$` (`LOCAL_SERVER_URL`). | `server-url-not-local` |
   | 2 | `.artisyn/config/log-hub.json` | `turnEndCostAdvisorModel`, `sessionAttributionLlmModel` | Absent, or a string matching `^[A-Za-z0-9._:\-\[\]]+$` (`MODEL_NAME`). | `model-name-invalid` |
   | 3 | `.artisyn/config/log-hub.json` | `telemetryDir` | Absent or `''`, or a string that does not start with `/`, `\` or `~`, does not match `^[A-Za-z]:`, and has no `..` segment (segments split on `/` and `\`). | `telemetry-dir-not-relative` |
   | 4 | `.claude/settings.json` | `hooks` | The key is absent. | `hooks-present` |
   | 5 | `.claude/settings.json` | `env.<name>`, each `env` key matching `^OTEL_EXPORTER_OTLP_([A-Z]+_)?ENDPOINT$` | The value parses as a URL whose hostname is `localhost` or `127.0.0.1`. | `otel-endpoint-not-local` |
   | 6 | `.claude/settings.json` | `extraKnownMarketplaces.<name>` | `source.source === 'directory'` and `source.path === './.artisyn/marketplace'`. | `marketplace-not-local` |
   | 7 | `.claude/settings.json` | `enabledPlugins.<name>` | The suffix after the last `@` names a marketplace that passed row 6, or is `claude-plugins-official`. A name without `@` has no suffix and fails. | `plugin-marketplace-unknown` |
   | 8 | `.mcp.json` | `mcpServers.<name>` | For a server with `command`: some allowlist entry lists the command in `commands`, and the first argument not starting with `-` equals that entry's `package`. | `mcp-command-not-allowed` |
   | 9 | `.mcp.json` | `mcpServers.<name>` | For a server with `url` and no `command`: the URL's hostname is `localhost` or `127.0.0.1`. | `mcp-url-not-local` |
   | 10 | `.mcp.json` | `mcpServers.<name>` | The server has `command` or `url`. | `mcp-server-invalid` |
   | 11 | `.artisyn/config/log-hub.local.json` | `''` | The path is not in `tracked`. | `local-config-tracked` |
   | 12 | each guarded file, in the order above | `''` | The content parses (rule 1). | `invalid-json` |

3. **Order.** Findings are listed by table row, then by key in file order. So every
   `invalid-json` finding comes last, after `local-config-tracked`.

The rule ids above are the complete set.

## Edge cases

- The current tracked files produce no findings: CG-01.
- Every file missing: CG-02.
- `serverUrl` only over plain `http` to a local host with a port: CG-03 (pass), CG-04 and CG-05 (fail).
- `sonnet & calc` as a model name (acceptance criterion): CG-07; both model keys invalid, in file
  order, including an empty string and a number: CG-08.
- `telemetryDir`: a name merely containing `..` is not a `..` segment: CG-10; parent, drive and
  home paths fail: CG-11, CG-12, CG-13.
- A non-endpoint `OTEL_*` key is not checked even with a remote URL: CG-15.
- A directory marketplace with the wrong path fails, and a plugin of that marketplace fails too:
  CG-17, CG-18; a plugin of a marketplace that is not declared: CG-19.
- `npx` and `npx.cmd` are both allowed when listed; `-y` before the package is skipped: CG-01,
  CG-22; an unpinned package version fails: CG-21.
- A server with neither `command` nor `url`: CG-24.
- `invalid-json` suppresses the file's other findings: CG-26; a top-level array is invalid: CG-27;
  order across files with `invalid-json` last: CG-28.

## Examples

`input` is the argument object of `checkConfigGuard` as described above; file contents are JSON
text inside a JSON string. `allowlist` is given only where an `.mcp.json` is present and is the
committed allowlist. `expected.findings` is the exact `findings` array.

Rows (28): [`docs/algorithm-examples/executable-config-guard.json`](../../algorithm-examples/executable-config-guard.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- `serverUrl` checked with `https?` or without the port -> CG-05; any URL accepted -> CG-04.
- Model name checked for presence only -> CG-07; an empty string accepted -> CG-08.
- `..` matched as a substring instead of a segment -> CG-10; `..` not checked -> CG-11; drive or
  `~` not checked -> CG-12, CG-13.
- Every `OTEL_*` env key checked instead of the endpoint pattern -> CG-15; endpoints not checked
  -> CG-16.
- A directory marketplace accepted with any path -> CG-17; plugins checked against every declared
  marketplace instead of only the passing ones -> CG-18.
- The command alone checked against the allowlist, not the package -> CG-21; the first argument
  taken as-is instead of the first non-dash one -> CG-22 (and CG-01).
- `invalid-json` not suppressing other findings -> CG-26; non-object JSON accepted -> CG-27;
  findings emitted per file instead of per table row -> CG-28.

## Where the result is visible

The `Executable-config guard` row of the PR security block and of `security-scan-results.json`
(status `findings`, `counts.high` = number of findings, note `file:key` pairs), and one
`::warning file=<file>::<key> <rule>` annotation per finding in the `config-guard` job of
`security-scans`. Safe behaviour: report-only, the job never fails the PR.
