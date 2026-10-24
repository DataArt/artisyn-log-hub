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

```examples
[
  {
    "id": "CG-01",
    "input": {
      "files": {
        ".artisyn/config/log-hub.json": "{\"serverUrl\":\"\",\"telemetryDir\":\"\",\"context\":[]}",
        ".claude/settings.json": "{\"env\":{\"MCP_TIMEOUT\":\"90000\"},\"enabledPlugins\":{\"typescript-lsp@claude-plugins-official\":true,\"log-hub-hooks@artisyn-e798dd87\":true,\"adlc-lh@artisyn-e798dd87\":true},\"extraKnownMarketplaces\":{\"artisyn-e798dd87\":{\"source\":{\"source\":\"directory\",\"path\":\"./.artisyn/marketplace\"}}}}",
        ".mcp.json": "{\"mcpServers\":{\"postgres\":{\"type\":\"stdio\",\"command\":\"npx.cmd\",\"args\":[\"-y\",\"@modelcontextprotocol/server-postgres@0.6.2\",\"postgresql://postgres:pw@localhost:5432/a-log\"]},\"playwright\":{\"type\":\"stdio\",\"command\":\"npx.cmd\",\"args\":[\"-y\",\"@playwright/mcp@0.0.83\",\"--isolated\",\"--headless\"],\"env\":{}},\"webstorm\":{\"url\":\"http://127.0.0.1:64542/stream\",\"type\":\"http\"}}}"
      },
      "tracked": [".artisyn/config/log-hub.json", ".claude/settings.json", ".mcp.json", "README.md"],
      "allowlist": {"mcpStdio": [{"commands": ["npx", "npx.cmd"], "package": "@modelcontextprotocol/server-postgres@0.6.2"}, {"commands": ["npx", "npx.cmd"], "package": "@playwright/mcp@0.0.83"}]}
    },
    "expected": {"findings": []},
    "note": "The committed files. log-hub.json: serverUrl '' and telemetryDir '' pass rows 1 and 3, no model keys. settings.json: no hooks; MCP_TIMEOUT is not an OTEL endpoint key; marketplace artisyn-e798dd87 is directory + ./.artisyn/marketplace (row 6 pass); plugins end in @claude-plugins-official or @artisyn-e798dd87 (row 7 pass). .mcp.json: postgres and playwright run npx.cmd, first non-dash args are the two allowlisted packages (row 8 pass); webstorm has url host 127.0.0.1 (row 9 pass). log-hub.local.json is not tracked. No findings."
  },
  {
    "id": "CG-02",
    "input": {"files": {".artisyn/config/log-hub.json": null, ".claude/settings.json": null, ".mcp.json": null}, "tracked": []},
    "expected": {"findings": []},
    "note": "Every guarded file missing: a missing file passes every rule; nothing tracked. No findings."
  },
  {
    "id": "CG-03",
    "input": {"files": {".artisyn/config/log-hub.json": "{\"serverUrl\":\"http://localhost:3000/\"}"}, "tracked": []},
    "expected": {"findings": []},
    "note": "Row 1: http://localhost:3000/ matches ^http://(localhost|127.0.0.1):\\d+/?$. No findings."
  },
  {
    "id": "CG-04",
    "input": {"files": {".artisyn/config/log-hub.json": "{\"serverUrl\":\"https://loghub.example.com\"}"}, "tracked": []},
    "expected": {"findings": [{"file": ".artisyn/config/log-hub.json", "key": "serverUrl", "rule": "server-url-not-local"}]},
    "note": "Acceptance criterion, non-localhost serverUrl. Row 1: https scheme and a foreign host do not match LOCAL_SERVER_URL -> server-url-not-local."
  },
  {
    "id": "CG-05",
    "input": {"files": {".artisyn/config/log-hub.json": "{\"serverUrl\":\"https://localhost:3000\"}"}, "tracked": []},
    "expected": {"findings": [{"file": ".artisyn/config/log-hub.json", "key": "serverUrl", "rule": "server-url-not-local"}]},
    "note": "Row 1 requires the http scheme; https://localhost:3000 does not match -> server-url-not-local."
  },
  {
    "id": "CG-06",
    "input": {"files": {".artisyn/config/log-hub.json": "{\"turnEndCostAdvisorModel\":\"claude-sonnet-4-6[1m]\",\"sessionAttributionLlmModel\":\"us.anthropic.claude-haiku-4-5:1\"}"}, "tracked": []},
    "expected": {"findings": []},
    "note": "Row 2: both names use only letters, digits, '.', '-', ':', '[', ']'. No findings."
  },
  {
    "id": "CG-07",
    "input": {"files": {".artisyn/config/log-hub.json": "{\"turnEndCostAdvisorModel\":\"sonnet & calc\"}"}, "tracked": []},
    "expected": {"findings": [{"file": ".artisyn/config/log-hub.json", "key": "turnEndCostAdvisorModel", "rule": "model-name-invalid"}]},
    "note": "Acceptance criterion. Row 2: 'sonnet & calc' holds spaces and '&', outside the MODEL_NAME set -> model-name-invalid."
  },
  {
    "id": "CG-08",
    "input": {"files": {".artisyn/config/log-hub.json": "{\"sessionAttributionLlmModel\":\"\",\"turnEndCostAdvisorModel\":7}"}, "tracked": []},
    "expected": {"findings": [{"file": ".artisyn/config/log-hub.json", "key": "sessionAttributionLlmModel", "rule": "model-name-invalid"}, {"file": ".artisyn/config/log-hub.json", "key": "turnEndCostAdvisorModel", "rule": "model-name-invalid"}]},
    "note": "Row 2: '' does not match (the pattern needs at least one character) and 7 is not a string -> two findings, sessionAttributionLlmModel first because it comes first in the file."
  },
  {
    "id": "CG-09",
    "input": {"files": {".artisyn/config/log-hub.json": "{\"telemetryDir\":\"tmp/telemetry\"}"}, "tracked": []},
    "expected": {"findings": []},
    "note": "Row 3: relative, no leading / \\ ~, no drive, segments tmp and telemetry. No findings."
  },
  {
    "id": "CG-10",
    "input": {"files": {".artisyn/config/log-hub.json": "{\"telemetryDir\":\"data/..hidden\"}"}, "tracked": []},
    "expected": {"findings": []},
    "note": "Row 3: segments are data and ..hidden; neither is exactly '..'. No findings."
  },
  {
    "id": "CG-11",
    "input": {"files": {".artisyn/config/log-hub.json": "{\"telemetryDir\":\"../outside\"}"}, "tracked": []},
    "expected": {"findings": [{"file": ".artisyn/config/log-hub.json", "key": "telemetryDir", "rule": "telemetry-dir-not-relative"}]},
    "note": "Row 3: first segment is '..' -> telemetry-dir-not-relative."
  },
  {
    "id": "CG-12",
    "input": {"files": {".artisyn/config/log-hub.json": "{\"telemetryDir\":\"C:/data\"}"}, "tracked": []},
    "expected": {"findings": [{"file": ".artisyn/config/log-hub.json", "key": "telemetryDir", "rule": "telemetry-dir-not-relative"}]},
    "note": "Row 3: matches ^[A-Za-z]: (a drive path) -> telemetry-dir-not-relative."
  },
  {
    "id": "CG-13",
    "input": {"files": {".artisyn/config/log-hub.json": "{\"telemetryDir\":\"~/telemetry\"}"}, "tracked": []},
    "expected": {"findings": [{"file": ".artisyn/config/log-hub.json", "key": "telemetryDir", "rule": "telemetry-dir-not-relative"}]},
    "note": "Row 3: starts with ~ -> telemetry-dir-not-relative."
  },
  {
    "id": "CG-14",
    "input": {"files": {".claude/settings.json": "{\"hooks\":{}}"}, "tracked": []},
    "expected": {"findings": [{"file": ".claude/settings.json", "key": "hooks", "rule": "hooks-present"}]},
    "note": "Row 4: the hooks key is present (even empty) -> hooks-present."
  },
  {
    "id": "CG-15",
    "input": {"files": {".claude/settings.json": "{\"env\":{\"OTEL_EXPORTER_OTLP_ENDPOINT\":\"http://localhost:4318\",\"OTEL_EXPORTER_OTLP_HEADERS\":\"x=https://a.example.com\"}}"}, "tracked": []},
    "expected": {"findings": []},
    "note": "Row 5: OTEL_EXPORTER_OTLP_ENDPOINT matches the key pattern, host localhost passes; OTEL_EXPORTER_OTLP_HEADERS does not match the key pattern, so it is not checked. No findings."
  },
  {
    "id": "CG-16",
    "input": {"files": {".claude/settings.json": "{\"env\":{\"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT\":\"https://collector.example.com\"}}"}, "tracked": []},
    "expected": {"findings": [{"file": ".claude/settings.json", "key": "env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "rule": "otel-endpoint-not-local"}]},
    "note": "Row 5: key matches with the LOGS_ infix; host collector.example.com is not local -> otel-endpoint-not-local."
  },
  {
    "id": "CG-17",
    "input": {"files": {".claude/settings.json": "{\"extraKnownMarketplaces\":{\"m\":{\"source\":{\"source\":\"directory\",\"path\":\"../other\"}}}}"}, "tracked": []},
    "expected": {"findings": [{"file": ".claude/settings.json", "key": "extraKnownMarketplaces.m", "rule": "marketplace-not-local"}]},
    "note": "Row 6: source is directory but path is ../other, not ./.artisyn/marketplace -> marketplace-not-local."
  },
  {
    "id": "CG-18",
    "input": {"files": {".claude/settings.json": "{\"extraKnownMarketplaces\":{\"evil\":{\"source\":{\"source\":\"github\",\"repo\":\"evil/plugins\"}}},\"enabledPlugins\":{\"tool@evil\":true}}"}, "tracked": []},
    "expected": {"findings": [{"file": ".claude/settings.json", "key": "extraKnownMarketplaces.evil", "rule": "marketplace-not-local"}, {"file": ".claude/settings.json", "key": "enabledPlugins.tool@evil", "rule": "plugin-marketplace-unknown"}]},
    "note": "Row 6: a github source fails -> marketplace-not-local. Row 7: suffix evil names a marketplace that did not pass row 6 -> plugin-marketplace-unknown. Row 6 before row 7."
  },
  {
    "id": "CG-19",
    "input": {"files": {".claude/settings.json": "{\"enabledPlugins\":{\"typescript-lsp@claude-plugins-official\":true,\"x@nowhere\":true}}"}, "tracked": []},
    "expected": {"findings": [{"file": ".claude/settings.json", "key": "enabledPlugins.x@nowhere", "rule": "plugin-marketplace-unknown"}]},
    "note": "Row 7: claude-plugins-official passes; nowhere is not declared at all -> plugin-marketplace-unknown for x@nowhere only."
  },
  {
    "id": "CG-20",
    "input": {
      "files": {".mcp.json": "{\"mcpServers\":{\"evil\":{\"command\":\"node\",\"args\":[\"evil.js\"]}}}"},
      "tracked": [],
      "allowlist": {"mcpStdio": [{"commands": ["npx", "npx.cmd"], "package": "@modelcontextprotocol/server-postgres@0.6.2"}, {"commands": ["npx", "npx.cmd"], "package": "@playwright/mcp@0.0.83"}]}
    },
    "expected": {"findings": [{"file": ".mcp.json", "key": "mcpServers.evil", "rule": "mcp-command-not-allowed"}]},
    "note": "Row 8: command node is in no allowlist entry's commands -> mcp-command-not-allowed."
  },
  {
    "id": "CG-21",
    "input": {
      "files": {".mcp.json": "{\"mcpServers\":{\"pw\":{\"command\":\"npx\",\"args\":[\"-y\",\"@playwright/mcp@latest\"]}}}"},
      "tracked": [],
      "allowlist": {"mcpStdio": [{"commands": ["npx", "npx.cmd"], "package": "@modelcontextprotocol/server-postgres@0.6.2"}, {"commands": ["npx", "npx.cmd"], "package": "@playwright/mcp@0.0.83"}]}
    },
    "expected": {"findings": [{"file": ".mcp.json", "key": "mcpServers.pw", "rule": "mcp-command-not-allowed"}]},
    "note": "Row 8: npx is allowed, but the first non-dash argument @playwright/mcp@latest equals no entry's package -> mcp-command-not-allowed."
  },
  {
    "id": "CG-22",
    "input": {
      "files": {".mcp.json": "{\"mcpServers\":{\"pw\":{\"command\":\"npx\",\"args\":[\"-y\",\"@playwright/mcp@0.0.83\",\"--headless\"]}}}"},
      "tracked": [],
      "allowlist": {"mcpStdio": [{"commands": ["npx", "npx.cmd"], "package": "@modelcontextprotocol/server-postgres@0.6.2"}, {"commands": ["npx", "npx.cmd"], "package": "@playwright/mcp@0.0.83"}]}
    },
    "expected": {"findings": []},
    "note": "Row 8: npx is in the second entry's commands; -y is skipped, first non-dash argument @playwright/mcp@0.0.83 equals its package. No findings."
  },
  {
    "id": "CG-23",
    "input": {
      "files": {".mcp.json": "{\"mcpServers\":{\"r\":{\"type\":\"http\",\"url\":\"https://mcp.example.com/mcp\"}}}"},
      "tracked": [],
      "allowlist": {"mcpStdio": [{"commands": ["npx", "npx.cmd"], "package": "@modelcontextprotocol/server-postgres@0.6.2"}, {"commands": ["npx", "npx.cmd"], "package": "@playwright/mcp@0.0.83"}]}
    },
    "expected": {"findings": [{"file": ".mcp.json", "key": "mcpServers.r", "rule": "mcp-url-not-local"}]},
    "note": "Row 9: url without command, host mcp.example.com is not local -> mcp-url-not-local."
  },
  {
    "id": "CG-24",
    "input": {
      "files": {".mcp.json": "{\"mcpServers\":{\"bad\":{\"type\":\"stdio\"}}}"},
      "tracked": [],
      "allowlist": {"mcpStdio": [{"commands": ["npx", "npx.cmd"], "package": "@modelcontextprotocol/server-postgres@0.6.2"}, {"commands": ["npx", "npx.cmd"], "package": "@playwright/mcp@0.0.83"}]}
    },
    "expected": {"findings": [{"file": ".mcp.json", "key": "mcpServers.bad", "rule": "mcp-server-invalid"}]},
    "note": "Rows 8 and 9 do not apply (no command, no url); row 10: neither command nor url -> mcp-server-invalid."
  },
  {
    "id": "CG-25",
    "input": {"files": {}, "tracked": [".artisyn/config/log-hub.json", ".artisyn/config/log-hub.local.json"]},
    "expected": {"findings": [{"file": ".artisyn/config/log-hub.local.json", "key": "", "rule": "local-config-tracked"}]},
    "note": "Row 11: the personal config path is in the tracked list -> local-config-tracked with key ''."
  },
  {
    "id": "CG-26",
    "input": {"files": {".claude/settings.json": "{\"hooks\": "}, "tracked": []},
    "expected": {"findings": [{"file": ".claude/settings.json", "key": "", "rule": "invalid-json"}]},
    "note": "Rule 1: truncated JSON does not parse -> invalid-json, and the file gets no other finding (no hooks-present although the text names hooks)."
  },
  {
    "id": "CG-27",
    "input": {"files": {".mcp.json": "[]"}, "tracked": []},
    "expected": {"findings": [{"file": ".mcp.json", "key": "", "rule": "invalid-json"}]},
    "note": "Rule 1: [] parses but is not a plain object -> invalid-json."
  },
  {
    "id": "CG-28",
    "input": {"files": {".artisyn/config/log-hub.json": "nope", ".claude/settings.json": "{\"hooks\":{}}"}, "tracked": [".artisyn/config/log-hub.local.json"]},
    "expected": {"findings": [{"file": ".claude/settings.json", "key": "hooks", "rule": "hooks-present"}, {"file": ".artisyn/config/log-hub.local.json", "key": "", "rule": "local-config-tracked"}, {"file": ".artisyn/config/log-hub.json", "key": "", "rule": "invalid-json"}]},
    "note": "log-hub.json does not parse: only invalid-json for it. settings.json: row 4 hooks-present. Row 11: local config tracked. Order by table row: 4, 11, 12."
  }
]
```

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
