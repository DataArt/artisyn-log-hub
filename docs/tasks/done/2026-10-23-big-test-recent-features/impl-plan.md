# Implementation plan — 2026-10-23 Big Pre-Prod E2E Test: cover recent features

## TL;DR

- Scope is test tooling only: `.claude/skills/big-prod-e2e-test/` (scripts, prompts, a new `fixtures/legacy-hook/`, SKILL.md) plus the KB article. Also touched: a PoC folder `docs/pocs/2026-10-23-big-test-probes/`, and the task's `notes.md` / `requirements.md` (AC ticks). No product code, no DB, no API, no new npm packages.
- **New orchestrator phase P5b** (`p5bLegacyHook`): builds and installs the previous-release hook.
- **Verifier redesign** (`scripts/lib/verify.mjs` + `scripts/prompts/`): a fixed 7-field verdict becomes a per-scenario list of **checks**. Each check is a prompt fragment under `prompts/checks/`, has its own fields, screenshots and call budget, and can return the new status `skipped`. The orchestrator judges `cost` and `workTime` in JS (`judgeCost`, `judgeWorkTime`), not through the LLM.
- **Four new haiku sessions S8–S11** plus a **legacy session L1**:
  - New scenario fields: `permissionArgs`, `cwdRel`, `env`, `useWorktree`, `rootSettings`, `owner` override, `verifyChecks`, the `{{REPO_ROOT}}` prompt placeholder, and the `requires` keys `bash`, `bashError`, `denied`, `background`, `cwd`, `noHarness`.
  - L1 is kept outside `SCENARIOS`, in its own `LEGACY_SCENARIO` constant.
- **New helpers:**
  - `lib/legacy.mjs`: `buildPrevInstaller()` and `installPrevHook()` run `git archive` + `npm ci` + the old `build-hooks-installer.js`.
  - `lib/worktree.mjs`: `prepareWorktree()` and `aiWorkDirHasSession()`.
  - `lib/hooks.mjs`: `readLogHubConfig()` and `checkLocalConfig()`.
  - `lib/repos.mjs`: `seedLegacyLogHub()` (the FR-12 seed commit), and a `createRepos` `beforeCommit` hook that writes `GENERATED_CLAUDE_MD` into the run-dir `js-cli` (FR-4a).
  - `lib/sessions.mjs`: per-scenario permission args, cwd, env and prompt fill; `costUsd` in expected/result.
  - `lib/visibility.mjs`: `evaluateDirectSession()` for V8.
  - `lib/evidence.mjs`: `workTimeWindow()`.
  - `lib/verify.mjs`: `applyScriptedJudgements()`.
  - `lib/api.mjs`: `getSessions()` and `waitForTelemetry()`.
- **Visibility:** a new row V8 (admin sees no repo, and a direct S1 URL gets 403 with no session data). S8 joins V4/V7. `legacy-hook` joins V1/V2/V3/V8.
- **New AC rows:** `FR-LC` (local config, FR-11), `FR-UP` (upgrade, FR-12), `FR-OLD` (old hook, FR-13), `FR-WT` (S11 `ai_work_dir`). The `FR-6` (P3, CLAUDE.md), `FR-9b` and `FR-10` details change.
- Chunk 1 is a set of **PoC probes** (Claude Code behaviour under `-p`). Their results fix the constants marked "per PoC" before any wiring.
- Prompts that need absolute paths use `{{REPO_ROOT}}`, filled at run time from the run's repo dir in forward-slash form. Nothing machine-specific is hardcoded, so the test runs on Windows, macOS, Linux and CI.

## Reference

- Requirements: [requirements.md](requirements.md)
- Research archive: [research/findings-1.md](research/findings-1.md)

## Design Decisions

1. **Bash-view expectations follow the product algorithm** (`docs/knowledgebase/algorithms/bash-command-view.md` §3, §5.5, §6). The view never uses the session cwd:
   - "Working dir" appears only for a leading plain `cd <dir>` statement.
   - A relative path is shown relative to the first `cd` target.
   - Only an absolute path under the repo root is shortened to a repo-relative path.

   So prompts that check paths give the absolute path through the `{{REPO_ROOT}}` placeholder (user decision, 2026-10-23). It must never be a hardcoded path.
2. **`{{REPO_ROOT}}` contract:**
   - `promptFor(scenario, rootAbs)` replaces every `{{REPO_ROOT}}` with `rootAbs`, where backslashes become `/`.
   - `rootAbs` is the session's repo dir: `runPaths.repoDir(repo)`, or the worktree dir for S11.
   - The filled prompt is what goes on stdin, into `expected.prompt` and into the visibility prefix match.
   - The placeholder must not appear in a prompt's first `PROMPT_PREFIX_LEN` (40) characters, and a test asserts this.
   - Prompts always quote it: `"{{REPO_ROOT}}"`.
3. **S1 / FR-2 command:** the prompt ends with "run exactly this Bash command: `cd "{{REPO_ROOT}}"; node --test tests/calc.test.js`". The Bash tab must then show:
   - a row whose command contains `node --test tests/calc.test.js`;
   - Working dir `.`;
   - FILES runs including `node`;
   - no absolute repo path anywhere in that row (this proves the repo-relative display).
4. **S10 / S11 command:** "run exactly this Bash command: `cat "{{REPO_ROOT}}/packages/core/src/index.ts"`, then say how many exported functions it has".
   - Expected FILES read: `packages/core/src/index.ts`, with no absolute path shown.
   - `cwdRel` = `packages/web`.
   - S11 fills `{{REPO_ROOT}}` with the worktree root.
   - **Settings from the root (PoC 2026-10-23, `notes.md`).** Claude Code reads project settings
     only from `<cwd>/.claude/`, so a session started in `packages/web` gets no plugin, no hooks
     and no OTEL env. S10 and S11 therefore get the scenario field `rootSettings: true`.
     - For such a scenario the runner writes `runPaths.sessionSettings(id)`
       (`_verify/settings-<id>.json`). The file is the session root's `.claude/settings.json` with
       the `extraKnownMarketplaces.*.source.path` made absolute (forward slashes, `<root>/.artisyn/marketplace`)
       plus the `env` of its `.claude/settings.local.json`.
     - The runner then appends `--settings "<file>"` to the argv.
     - The session root is the repo dir, or the worktree for S11.
     - Nothing is written into the repo.
5. **Per-scenario verifier checks.** `verify.mjs` exports `CHECKS`, a frozen map. Each check id maps to `{ fields: string[], shots: string[], calls: number, fragment: 'checks/<id>.md' }`:

   | check | fields | shots | calls | used by |
   |---|---|---|---|---|
   | `model` | model | summary.png | 3 | S1–S11, L1 |
   | `harness` | skills, rules, workflows, subagents, mcp | harness-usage.png | 8 | S1–S11 |
   | `prompt` | prompt | logs.png | 3 | S1–S11, L1 |
   | `cost` | cost | cost.png | 4 | S1–S11 |
   | `bashTab` | bash | bash.png | 5 | S1, S8 |
   | `contextGrowth` | contextGrowth | context-growth.png | 5 | S1 |
   | `agentsTable` | agentsTable | agents-table.png, agent-modal.png | 6 | S4 |
   | `systemContext` | systemContext | sysctx.png | 7 | S2, S5 |
   | `denied` | denied | denied.png | 4 | S8 |
   | `workTime` | workTime | work-time.png | 3 | S9 |
   | `bashPaths` | bashPaths | bash-paths.png | 4 | S10, S11 |

   - Default `verifyChecks` = `['model','harness','prompt','cost']`. Scenarios append their extra checks; L1 = `['model','prompt']`.
   - Budget: `verifierCallBudget(checks)` = `VERIFIER_TOOL_BUDGET_BASE` (login, 4 calls) + Σ `calls` + Σ `shots.length` + 2. This replaces the fixed `VERIFIER_CALL_BUDGET` and raises the budget explicitly (NFR). The old `VERIFIER_TOOL_BUDGET = 25` in `config.mjs` is removed together with its import.
   - Session tree: the `harness` check already counts `Agent` tree rows (`subagents`). For S9, `expected.subagents` = 1 proves the background agent is in the tree (FR-7).
   - Attribution (FR-8, S10/S11): P9 looks the session up under `STORED_URL('ts-webapp')` via `waitForIngestion`, and the verifier opens it under that repo id. A session attributed elsewhere fails as `not ingested`. No extra field is needed.
   - AC coverage (FR-14): the new verifier checks report through the existing per-session `FR-9` row and the session sections of `index.md` (one field and screenshot per check). New AC ids are only for checks outside sessions (Design Decision 23).
6. **Fragment file format** (`prompts/checks/<id>.md`): three `##` sections with these exact headings:
   - `## Step`: navigation and reading instructions, with selectors from Design Decision 13.
   - `## Judge`: the pass/fail rule.
   - `## Fields`: one verdict-example line per field, in the existing JSON line style.

   `composeVerifyPrompt(checks, vars)` numbers the steps after login, joins the sections into `verify-session.md` placeholders `{{STEPS}}`, `{{JUDGE}}` and `{{VERDICT_FIELDS}}`, and then runs `fillTemplate`.

   Screenshot variables are named per shot file:
   - The three existing variables `SHOT_SUMMARY`, `SHOT_HARNESS` and `SHOT_LOGS` keep their names.
   - Every new shot gets `SHOT_` + its file stem upper-snake-cased: `SHOT_COST`, `SHOT_BASH`, `SHOT_CONTEXT_GROWTH`, `SHOT_AGENTS_TABLE`, `SHOT_AGENT_MODAL`, `SHOT_SYSCTX`, `SHOT_DENIED`, `SHOT_WORK_TIME`, `SHOT_BASH_PATHS`.
   - A fragment refers only to its own variables.

   **Fragment rules** (the `## Step` / `## Judge` content of each check):
   - `cost`: Info tab, `cost-reconciliation` table; report the "Telemetry total" row text verbatim, or "none".
   - `bashTab`: Bash tab. For each `expected.bash` row there is a `bash-call-row` with that command. Opening it shows the status (no badge for ok, "✗ error" for error), `bash-workdir` equal to `workDir` (absent when null), and `bash-files-runs` containing `node`. No text in the row contains the absolute repo path.
   - `contextGrowth`: Charts → `context-growth`; open the first `growth-step-row` that has tool calls; `step-details-modal` lists ≥ 1 `step-call-block`.
   - `agentsTable`: Logs tab, workflow block; `workflow-agent-row` rows numbered `1`..`count`, each with non-empty Duration and Tokens; open row 1; the `workflow-agent-logs` and `workflow-agent-raw-logs` tabs are both non-empty.
   - `systemContext`: Logs tab; press "Show details" on `sysctx-panel`; on `sysctx-tab-rules`, `-skills` and `-files`, every expected entry is present (skill source badge per expected).
   - `denied`: Logs tab; the `expected.denied` call shows `tool-status-badge` "⊘ rejected" plus a denial text with "requested permissions" or a non-empty badge `title`.
   - `workTime`: Logs tab, turn-1 `PromptTurnHeader` duration; also record the Summary work-time tile.
   - `bashPaths`: Bash tab; the row's `bash-files-reads` shows `expected.bashPaths.read`, and no absolute path appears.
7. **Verdict validation:**
   - `validateVerdict(json, fieldKeys = fieldsFor(DEFAULT_CHECKS))` requires exactly the given keys. `DEFAULT_CHECKS = ['model','harness','prompt','cost']` is exported. The existing one-argument tests are updated to include a `cost` field.
   - Field status is `pass|fail|skipped`. Only `cost` may be `skipped`; that list is the constant `SKIPPABLE_FIELDS = ['cost']`.
   - `overall` is `fail` iff any field is `fail`.
   - Each check's screenshots are mandatory evidence (`EVIDENCE_SHOTS` is replaced by `shotsFor(checks)`).
8. **Expected values sent to the verifier.** `EXPECTED_JSON` = the base fields plus a per-check block from `expected`. The blocks are static per scenario, declared in `scenarios.mjs` as `scenario.expect` and copied by `buildExpected`:
   - `bash`: a list of rows `{ command, status:'ok'|'error', workDir }`:
     - S1: `[{ command:'node --test tests/calc.test.js', status:'ok', workDir:'.' }]`.
     - S8: `[{ command:'node --version', status:'ok', workDir:null }, { command:'node -e "process.exit(3)"', status:'error', workDir:null }]`.
     - `workDir:null` means no Working dir line is expected.
     - Every row: FILES runs include `node`, no absolute repo path is shown, and an `error` row shows `tool-status-badge` "✗ error".
   - `sysctx`:
     - S5: `{ rules:['cli-flags'], skills:[], files:[{ name:'CLAUDE.md', type:'Project' }] }`.
     - S2: `{ rules:[], skills:[{ name:'add-jsdoc', source:'project' }], files:[] }`.
     - These are lists of things that must be present. Other rows are allowed.
   - `agents: { count: 2 }` (S4).
   - `costUsd` (from the stream).
   - `workTime: { minSeconds }` (S9, computed).
   - `bashPaths: { read:'packages/core/src/index.ts' }` (S10, S11).
   - `denied`: `{ tool: S8_DENIED.tool, target: S8_DENIED.target, status:'rejected' }`. Pass iff that call shows `tool-status-badge` "⊘ rejected" plus a denial text containing "requested permissions" or a non-empty badge `title` (denial kind).
9. **Cost judgement (FR-5).** The verifier only reports the "Telemetry total" text. `judgeCost(observedText, costUsd)` works as follows:
   - It parses `$x.xxxx`.
   - If `costUsd` is null or the row text is missing or unparseable, the result is `skipped`.
   - It passes iff `|Δ| < max(0.05, 0.01 × T)`, with T = the parsed telemetry total. This is the inverse of `costMismatch`, `server/src/logs/otel-cost.sql.ts`.
   - The orchestrator overwrites the `cost` field status and recomputes `overall`.
10. **Work time (FR-7).** The verifier reads the turn-1 header duration on the Logs tab (`PromptTurnHeader`, `h:mm:ss`, floored), plus the Summary session work time for the record.
    - `judgeWorkTime(observed, minSeconds)` passes iff the parsed seconds are ≥ `minSeconds`.
    - `minSeconds` = `endTs − startTs − 2`:
      - start = the initial prompt's user entry;
      - end = the last **non-sidechain assistant** entry after the `<task-notification>` user entry (`docs/knowledgebase/algorithms/work-time.md` rules 1–5: a turn ends at an assistant event, never at a tool_result).
    - The turn header is the per-turn value. The Summary tile shows only the session total.
11. **Telemetry wait.** `api.waitForTelemetry({ rid, sid })` polls `GET /api/v1/repositories/:rid/sessions` every `INGEST_POLL_MS` until the session's `costBreakdown.telemetryCost` is non-null, for up to `TELEMETRY_WAIT_MS` = 120000. A timeout is logged, not fatal: the cost then ends `skipped`.
12. **"Exercised" evidence.** `extractHarness(lines, subagentFileCount)` gains:
    - `bashCalls`: count of `Bash` tool_use.
    - `bashErrors`: Bash tool_results with `is_error: true`.
    - `denials`: the tool names whose tool_result has `toolDenialKind` or whose text matches `PERMISSION_DENIAL_RE` = `/requested permissions to (use|write|read|edit)/i`.
    - `backgroundAgent`: an `Agent`/`Task` tool_use with `input.run_in_background === true`.
    - `toolUseAfterNotification`: a main-thread (non-sidechain) tool_use after a user entry whose content (string or text block) starts with `<task-notification>`.
    - `cwd`: the `cwd` of the first entry that has one, with forward slashes. Per the PoC, a
      transcript starts with `queue-operation` lines that have no `cwd`.
    - Confirmed by the PoC: the notification is a main-thread `user` line with **string** content
      (the line also has `origin.kind === 'task-notification'`), and `-p` waits for it. The
      stream has two `result` events; the last one's `total_cost_usd` equals the server
      `telemetryCost`.

    The `requires` keys are:
    - `bash: n` (minimum);
    - `bashError: true`;
    - `denied: [tool]`;
    - `background: true` (needs both background flags);
    - `cwd: true`: the runner sets `actual.cwdOk` iff three things hold: the transcript cwd equals the session's cwd (`root/cwdRel`, compared case-insensitively on Windows), it is not `root`, and, when `scenario.env.ARTISYN_PROJECT_ROOT` is set, the child env passed it with the value `root`. For S11 this means the cwd is inside the worktree and is not its root.
    - `noHarness: true` (the old empty-`requires` rule).
13. **Product selectors given to the verifier fragments:**
    - Bash tab: `tab=bash`, `session-bash-tab`, `bash-call-row`, `bash-workdir`, `bash-files`, `bash-files-reads`, `bash-files-changes`, `bash-files-runs`, `bash-files-inline`.
    - Tool status: `tool-status-badge` (text "✗ error" / "⊘ rejected", `title` = denial kind) and `tool-status-mark`.
    - Context Growth: Charts sub-tab `context-growth`, `growth-step-row`, `step-details-modal`, `step-call-block`.
    - System Context: `sysctx-panel` with its "Show details" button, `sysctx-tab-files|skills|rules`, `sysctx-file-row`, `sysctx-rule-row`, `sysctx-skill-row[data-skill-name]`, source badge text `project|user|plugin`.
    - Workflow agents: `workflow-agent-row`, modal tabs `workflow-agent-logs` and `workflow-agent-raw-logs`.
    - Cost: the `cost-reconciliation` table, row "Telemetry total".
14. **S8 denied call:** `S8_DENIED = { tool:'Write', target:'denied.txt' }` in `scenarios.mjs`.
    This is decided by the PoC (2026-10-23, `notes.md`):
    - The denied `Write` result line has a top-level `toolDenialKind: "user-rejected"` and `is_error: true`.
    - The server keeps it.
    - The UI shows `tool-status-badge` "⊘ rejected" with `title` "rejected by the user".
    - The Bash fallback is dropped: `git status` is auto-allowed in `default` mode, so it is never denied.

    The prompt is built from it. `requires.denied` = `[S8_DENIED.tool]`.

    `permissionArgs` = `['--permission-mode','default','--allowedTools','"Read"','"Bash(node:*)"']`.
    The PoC confirmed that this quoting works in the joined `shell: true` string.
15. **Admin row V8:** `{ id:'V8', viewer:'admin', view:'personal', see:[], notSee:[...REPO_NAMES, LEGACY_REPO], directSession:'S1' }`.
    - `evaluatePersonal` judges My Repos.
    - Then `evaluateDirectSession` opens S1's session URL as admin. It takes the repo id from `state.repos['node-service'].repoId`, the sid from `sessionIndex`, and the credentials from `state.users.admin` (email/password, as in `pageFor`). It checks two things: (a) `GET /api/v1/repositories/<rid>/sessions/<sid>/logs` through an admin `ApiClient` returns 403, and (b) after load the page shows no `logs` turn content, i.e. the first-prompt prefix is absent.
16. **Legacy hook (FR-13):**
    - `config.mjs` constants:
      - `PREV_RELEASE_REF='25146c8'`
      - `PREV_INSTALLER_VERSION='1.0.69'`
      - `PREV_HOOK_VERSION='2.21.1'`
      - `LEGACY_REPO='legacy-hook'`, `LEGACY_OWNER='U3'`
    - `buildPrevInstaller(runPaths)` does the following, all with cwd outside the git root:
      1. `git -C <gitRoot> archive --format=tar <ref>` piped into `tar -x` under `<runDir>/_prev-src`;
      2. `npm ci --ignore-scripts --no-audit --no-fund` there;
      3. `node scripts/build-hooks-installer.js --static-dir <runDir>/_prev-hook`;
      4. it reads `_prev-hook/installer-version.json` (expects `version` === `PREV_HOOK_VERSION`) and `git show <ref>:artisyn-hooks-installer/package.json` (expects `PREV_INSTALLER_VERSION`).

      Each step throws `infra: <step>: <error>`.
    - `installPrevHook(repoDir, tgz, apiKey, env)` runs `npx --yes "<tgzUrl>" install --server-url <STAND_URL> --api-key <key>` and expects `serverUrl` in the merged config.
      - `tgzUrl` = `pathToFileURL(tgz).href`. Per the PoC, `npx` with a bare Windows path (`D:/…/x.tgz`) hangs with no output until it is killed, and a relative path resolves against the npm workspace root.
      - PoC timings: archive 0.5 s, `npm ci` 2.3 s (warm cache), build 1.3 s. `installer-version.json` = `{"version":"2.21.1"}`.
      - The 1.0.69 installer writes `serverUrl` and `otelReceiverPort` into `log-hub.json`, only `apiKey` into `log-hub.local.json`, and the OTEL env into `.claude/settings.json`. So `checkLocalConfig` is never applied to `legacy-hook`.
17. **Legacy session:**
    - `scenario()` takes `owner: s.owner ?? REPOS[s.repo]`, so a repo outside `REPOS` can carry its owner.
    - `createRepos` needs only `REMOTE_URL(repo)`, so the legacy repo goes through it unchanged.
    - P3 writes `ctx.state.repos['legacy-hook'] = { owner: LEGACY_OWNER, dir, remoteUrl, storedUrl: STORED_URL(LEGACY_REPO), repoId: null }`.
    - P5b takes U3's API key from `ctx.state.users[LEGACY_OWNER].apiKey`, set in P4.
    - L1 runs the normal `checkIsolation`. The PoC confirmed that the 2.21.1 plugin id (`log-hub-hooks@artisyn-<8 hex>`) matches `ALLOWED_PLUGIN_SOURCE_RE`, so the regex stays unchanged.
    - P6 teams never list it.
    - `LEGACY_SCENARIO` = `scenario({ id:'L1', repo:LEGACY_REPO, owner:LEGACY_OWNER, model:'haiku', prompt:'Read `index.js` and say in one sentence what it prints.', requires:{ noHarness:true }, verifyChecks:['model','prompt'] })`.
    - It runs in P8 after `SCENARIOS`, only when `FR-OLD` P5 succeeded.
    - It is excluded from the FR-8 model/harness coverage check.
18. **Config files (FR-11 / FR-12):**
    - `readLogHubConfig(repoDir)` returns `{ base, local, merged }`, with `merged = {...base, ...local}`.
    - `readServerUrl` returns `merged.serverUrl`, which the P5 install success check uses.
    - `checkLocalConfig(repoDir, { legacy })` passes iff `local.serverUrl === STAND_URL` and `Number.isInteger(local.otelReceiverPort)` and `base.otelReceiverPort === undefined`, and, unless `legacy`, `!base.serverUrl` (absent or empty string; the tracked template keeps `"serverUrl": ""`).
    - FR-12: `LEGACY_LOG_HUB_JSON = { serverUrl: STAND_URL, otelReceiverPort: 4318 }`.
19. **Generated CLAUDE.md (FR-4a):**
    - `GENERATED_CLAUDE_MD` constant in `config.mjs`: `# js-cli\n\nSmall Node.js CLI used by the Log Hub pre-prod test. Source lives in lib/, the entry point in bin/.\n`.
    - `CLAUDE_MD_REPO = 'js-cli'`.
    - `createRepos` gets the option `beforeCommit(repo, dir)`, called between `copyFixture` and `gitSetup`.
    - The fixture CLAUDE.md assert moves to before that call.
20. **Worktree (S11):** `prepareWorktree(runPaths, repo='ts-webapp')` does the following:
    1. It runs `git -C <repoDir> worktree add -q -b big-test-wt <runDir>/ts-webapp-wt`.
    2. It creates `<wt>/.claude/` first: the worktree checkout has none when the fixture tracks nothing under `.claude/`, as with ts-webapp. Then it copies `.claude/settings.json`, `.claude/settings.local.json`, the whole `.artisyn/` tree (minus `ai_work_dir`) and `.artisyn/config/log-hub.local.json`.
    3. It allocates a fresh free port, writes it into the worktree's `log-hub.local.json` `otelReceiverPort` and into every OTEL endpoint value in its `settings.local.json` `env`. This avoids the receiver's `409 owner-mismatch`, `docs/knowledgebase/otel-receiver.md`. The PoC showed that this is needed:
       - With the copied port, `otel-register.js` logs "the OTEL receiver on port … belongs to another project", and the OTEL records land in the main checkout's `ai_work_dir`.
       - With a fresh port, everything lands in the worktree's `ai_work_dir`.
    4. It returns `{ dir, port }`, stored in `ctx.state.worktree`. The S11 `--settings` file (Design Decision 4) is built from these worktree copies after the port rewrite.
21. **S11 override proof (`FR-WT`):** `aiWorkDirHasSession(dir, sid)` is true iff `<dir>/.artisyn/ai_work_dir/hook.log` contains `sid`. Pass iff it is true for the worktree and false for the main `ts-webapp` checkout.
    - The PoC confirmed `hook.log`. The sid also appears in `attribution.log`, `analysis.log`, `harness-state.json` and `telemetry/<sid>.jsonl`.
    - **Ordering constraint (PoC):** a later session in the main `ts-webapp` root sweeps linked-worktree transcripts that are not in its own `.claude-logs.sent` (`session-files.js` prefix rule). It then logs `claude/<sid>.jsonl: uploaded` in the **main** `hook.log`.
    - So the FR-WT check runs right after S11 in P8, and S11 stays the last session on ts-webapp.
22. **Report:** session rows S8–S11 and L1 reuse `recordSession`. `FR-LC`/`FR-UP` details carry the JSON of both config files. `FR-OLD` names `PREV_RELEASE_REF`, the installer and hook versions, and the L1 status.
    - The P11 completeness ids are `[...SCENARIOS ids, 'L1', 'FC', ...VISIBILITY_ROWS ids]` plus the AC ids `FR-LC`, `FR-UP`, `FR-OLD`, `FR-WT`.
23. **AC phase map additions:** `'FR-LC': ['P5']`, `'FR-UP': ['P5']`, `'FR-OLD': ['P5b', 'P9']`, `'FR-WT': ['P8']`. The new phase P5b runs `p5bLegacyHook` right after P5. It is registered in the run's phase list and log step names like the other phases.
24. **Run-dir additions:** `_prev-src/`, `_prev-hook/`, `legacy-hook/`, `ts-webapp-wt/`. `runPaths` gains `prevSrcDir`, `prevHookDir`, `worktreeDir` and `sessionSettings(id)` (`_verify/settings-<id>.json`, Design Decision 4). All of these live under the run-dir and never under the git root.

## Files to create/modify

All paths are relative to `.claude/skills/big-prod-e2e-test/` unless rooted.

| Path | Purpose | Note |
|---|---|---|
| `scripts/lib/config.mjs` | constants | Design Decisions 11, 16, 18, 19, 24; `VERIFIER_TOOL_BUDGET_BASE`; `runPaths` additions |
| `scripts/scenarios.mjs` | S1 prompt, S2/S4/S5 checks, S8–S11, `LEGACY_SCENARIO`, `S8_DENIED`, `promptFor` | new fields per Design Decisions 2, 12, 14 |
| `scripts/lib/evidence.mjs` | new evidence keys, `isExercised` / `exercisedGap` | Design Decision 12 |
| `scripts/lib/sessions.mjs` | `sessionArgs(scenario, mcpFile)`, cwd/env/prompt fill, `costUsd`, S9 timestamps | `buildExpected` adds `costUsd`, `workTime`, check blocks |
| `scripts/lib/repos.mjs` | `beforeCommit` hook, legacy log-hub seed commit | Design Decisions 18, 19 |
| `scripts/lib/hooks.mjs` | `readLogHubConfig`, `checkLocalConfig`, merged `readServerUrl` | Design Decision 18 |
| `scripts/lib/legacy.mjs` (new) | build and install the previous-release installer | Design Decision 16 |
| `scripts/lib/worktree.mjs` (new) | `prepareWorktree`, `aiWorkDirHasSession` | Design Decisions 20, 21 |
| `scripts/lib/api.mjs` | `getSessions(rid)`, `waitForTelemetry` | Design Decision 11 |
| `scripts/lib/verify.mjs` | `CHECKS`, `composeVerifyPrompt`, `validateVerdict(json, keys)`, `judgeCost`, `judgeWorkTime`, budget | Design Decisions 5–10 |
| `scripts/prompts/verify-session.md` | becomes a frame with `{{STEPS}}`, `{{JUDGE}}`, `{{VERDICT_FIELDS}}` | the existing login step stays inline |
| `scripts/prompts/checks/*.md` (new, 11 files) | one fragment per check id | Design Decisions 6, 13 |
| `scripts/lib/visibility.mjs` | V8 row, `directSession`, S8 / legacy in rows, owner check over legacy repo | Design Decision 15 |
| `scripts/lib/report.mjs` | V8 / L1 / new AC rows render; `skipped` field status | Design Decision 22 |
| `scripts/run.mjs` | P3/P5/P8/P9/P10/P11 wiring, `AC_PHASES` | Design Decisions 17, 21–23 |
| `fixtures/legacy-hook/package.json`, `fixtures/legacy-hook/index.js` (new) | minimal legacy repo | `index.js` prints one line |
| `SKILL.md` | description, phases, sessions | FR-15 |
| `/docs/knowledgebase/test/big-prod-e2e-test.md` | phases, matrix, V rows, run-dir, troubleshooting, Files | FR-15 |
| `/scripts/__tests__/big-prod-e2e-test.test.js` | extend the helper tests | Test coverage plan |
| `/docs/pocs/2026-10-23-big-test-probes/` (new) | PoC probes plus `.gitignore` | per the `review-poc` skill |
| `notes.md` (task folder) | PoC results | evidence trail |

## Test coverage plan

- **Build-script tests** (`npm run test:scripts`, the existing file `scripts/__tests__/big-prod-e2e-test.test.js`). This is the skill's only test file, and requirements AC demands it. These are tests in the `test:scripts` static check that CLAUDE.md already lists, not a new kind of test. Extend the existing describe blocks; add no new file. I/O helpers (`legacy.mjs`, `worktree.mjs`, `waitForTelemetry`, `evaluateDirectSession`) are covered only by the full run.
  - `scenarios`: the count is 11 plus L1 is separate; the S8–S11 fields; the `{{REPO_ROOT}}` placement rule; `promptFor`.
  - `evidence`: the new `extractHarness` keys and `isExercised` / `exercisedGap` for `bash`, `bashError`, `denied`, `background`, `cwd`, `noHarness` (transcript-line fixtures inline).
  - `verify`: `validateVerdict` with per-check keys and `skipped`; `composeVerifyPrompt` leaves no placeholders; `judgeCost` boundary rows (Δ = 0.0499 / 0.05 at T = 1, Δ < 1 % at T = 10); `judgeWorkTime`; budget arithmetic.
  - `repos.createRepos`: the `beforeCommit` CLAUDE.md lands in the commit; a fixture CLAUDE.md still throws.
  - `hooks`: `checkLocalConfig` over the template, installed and legacy shapes.
  - `visibility`: V8 `judgePersonal`; owner coverage includes `legacy-hook`.
- **Not added:** no algorithm doc, API route or `tests/scenarios/` scenario is touched (test tooling only). Behaviour is proved by one full `/big-prod-e2e-test` run (the last requirement AC).

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | PoC probes | 7 | Fixes the "per PoC" constants; everything after depends on them |
| 2 | Config + scenarios | 7 | Data only; needs chunk 1 results |
| 3 | Evidence + session runner | 6 | Uses the chunk 2 fields |
| 4 | Repos, hook config, legacy, worktree libs | 7 | Independent of chunk 3, ordered before wiring |
| 5 | Verifier checks + prompts | 8 | Uses the chunk 2/3 expected shape |
| 6 | API + visibility | 5 | Telemetry wait, V8 |
| 7 | Orchestrator wiring | 8 | Needs chunks 3–6 |
| 8 | Report + docs | 5 | After the wiring is final |
| 9 | Helper tests | 6 | Extends the existing test file |
| 10 | Full run + verification | 4 | Last; classify every failure |

### Chunk 1 — PoC probes
- [x] Create `docs/pocs/2026-10-23-big-test-probes/` with a `.gitignore` covering every non-source file, per the `review-poc` skill. Probes run against throwaway copies of the `js-cli` / `ts-webapp` fixtures with the hook installed from a local `npm run build:hooks-installer` tgz, never in the git root.
- [x] Probe S8: `claude -p --permission-mode default --allowedTools "Read" "Bash(node:*)"` via a joined `shell: true` string. Record whether the `Write` denial transcript line has `toolDenialKind` and how the UI marks it. Set `S8_DENIED` and the `permissionArgs` quoting per Design Decision 14.
- [x] Probe S9: a haiku `claude -p` session with a `run_in_background: true` Agent. Record whether `-p` waits for the notification, the exact `<task-notification>` entry shape (string or text block), and whether the stream has more than one `result` event.
- [x] Probe S10/S11: start `claude -p` from `packages/web`, and from a linked-worktree subdirectory with `ARTISYN_PROJECT_ROOT`. Record whether project settings and the plugin load, whether the OTEL port conflicts (409), and which `ai_work_dir` file holds the session id.
- [x] Probe FR-13: time `git archive 25146c8` + `npm ci --ignore-scripts` + the old `build-hooks-installer.js --static-dir`, and confirm `installer-version.json` content, that the old tgz installs against the current stand, and that its plugin id matches `ALLOWED_PLUGIN_SOURCE_RE`.
- [x] Create or append the task `notes.md` with the dated results of every probe; mark which Design Decisions (14, 17, 20, 21) they confirm or change, and update those decisions in this plan.
- [x] If the probe picks the `S8_DENIED` Bash fallback, change requirements.md FR-6 and its AC from "denied `Write`" to "denied Bash call outside the allow list". — N/A: the probe picked `Write` (2026-10-23, `notes.md`).

### Chunk 2 — Config + scenarios
- [ ] `scripts/lib/config.mjs`: add the constants from Design Decisions 11, 16, 18 and 19, plus `VERIFIER_TOOL_BUDGET_BASE = 4`. Add `runPaths` keys `prevSrcDir`, `prevHookDir` and `worktreeDir` per Design Decision 24.
- [ ] `scripts/scenarios.mjs`: extend the `scenario()` wrapper to freeze `permissionArgs`, `cwdRel`, `env`, `useWorktree` (default false), `rootSettings` (default false, Design Decision 4), `expect` (Design Decision 8), `owner` override (Design Decision 17) and `verifyChecks` (default per Design Decision 5). Update the header comment for the new fields and `requires` keys (Design Decision 12).
- [ ] `scenarios.mjs`: in S1, append the Design Decision 3 command to the prompt and set `requires: { bash: 1, noHarness: true }` and `verifyChecks` + `bashTab`, `contextGrowth`. In S2 and S5 add `systemContext`; in S4 add `agentsTable`. Set the `expect` blocks for S1, S2, S4 and S5 per Design Decision 8.
- [ ] `scenarios.mjs`: add S8 (`js-cli`, haiku). Use `permissionArgs` and `S8_DENIED` from Design Decision 14. The prompt asks for three calls in order without retrying: `node --version`, `node -e "process.exit(3)"`, then the denied call. Set `requires: { bash: 2, bashError: true, denied: [S8_DENIED.tool] }`, add the checks `bashTab` and `denied`, and set `expect.bash` / `expect.denied` per Design Decision 8.
- [ ] `scenarios.mjs`: add S9 (`ts-webapp`, haiku). The prompt spawns one Agent with `run_in_background: true` to count the lines of `packages/core/src/index.ts`, waits for its notification, then writes the number to `packages/core/LINES.txt`. Set `requires: { background: true, subagent: 1 }` and add the `workTime` check.
- [ ] `scenarios.mjs`: add S10 and S11 (`ts-webapp`, haiku) with the Design Decision 4 prompt, `cwdRel: 'packages/web'`, `rootSettings: true`, `requires: { bash: 1, cwd: true }`, the `bashPaths` check and `expect.bashPaths`. S11 also gets `useWorktree: true` and `env: { ARTISYN_PROJECT_ROOT: '{{REPO_ROOT}}' }`.
- [ ] `scenarios.mjs`: add `LEGACY_SCENARIO` per Design Decision 17 and export `promptFor(scenario, rootAbs)` per Design Decision 2 (it also fills `{{REPO_ROOT}}` in `env` values). Create `fixtures/legacy-hook/package.json` (`name`, `version`, `type: commonjs`) and `fixtures/legacy-hook/index.js` (prints one line).

### Chunk 3 — Evidence + session runner
- [ ] `scripts/lib/evidence.mjs`: extend `extractHarness` with `bashCalls`, `bashErrors`, `denials`, `backgroundAgent`, `toolUseAfterNotification` and `cwd`, per Design Decision 12. Add `PERMISSION_DENIAL_RE`.
- [ ] `evidence.mjs`: in `isExercised` / `exercisedGap`, handle the `requires` keys `bash`, `bashError`, `denied`, `background`, `cwd` and `noHarness`. The empty-object branch becomes `noHarness`. A gap message is produced for each unmet key.
- [ ] `evidence.mjs`: add `workTimeWindow(lines)`. It returns `{ startTs, endTs, seconds }` per Design Decision 10, or null when there is no notification or no later assistant entry.
- [ ] `scripts/lib/sessions.mjs`: change `sessionArgs(scenario, mcpFile)` to use `scenario.permissionArgs ?? ['--permission-mode','bypassPermissions']`. Update the call site in `runAttempt`.
- [ ] `sessions.mjs` `runAttempt`: resolve the root (the `runScenario` option `rootDir`, defaulting to `repoDir(repo)`). Set cwd to `root/cwdRel`, set env to `{...env, ...filled scenario.env}` and the input to `promptFor(scenario, root)`. Set `harness.cwdOk` per Design Decision 12. For `rootSettings`, write the `--settings` file and append `--settings "<file>"` to the argv (Design Decision 4).
- [ ] `sessions.mjs` `buildExpected`: add `costUsd` (`stream.finalResult?.total_cost_usd ?? null`), `workTime` (`workTimeWindow`, S9 only, with `minSeconds` per Design Decision 10) and copies of the `scenario.expect` blocks (Design Decision 8). The prompt is the filled prompt. Persist `costUsd` in `result.json` as well.

### Chunk 4 — Repos, hook config, legacy, worktree libs
- [ ] `scripts/lib/repos.mjs`: add the `beforeCommit(repo, dir)` option to `createRepos`. Move the fixture CLAUDE.md assert to run right after `copyFixture` and before the hook (Design Decision 19).
- [ ] `repos.mjs`: export `seedLegacyLogHub(dir, json)`. It writes `.artisyn/config/log-hub.json` and makes a second commit, `legacy log-hub config` (FR-12).
- [ ] `scripts/lib/hooks.mjs`: add `readLogHubConfig` and `checkLocalConfig` per Design Decision 18. Make `readServerUrl` return the merged value, and update the `installHook` error text to name both files.
- [ ] Create `scripts/lib/legacy.mjs` with `buildPrevInstaller(runPaths)` and `installPrevHook(repoDir, tgz, apiKey, env)` per Design Decision 16. Use `run` / `runAsync` from `proc.mjs`, and log every step to `_state/prev-hook-build.log`.
- [ ] `legacy.mjs`: export `prevInstallerTgz(runPaths)`, which returns the `_prev-hook/artisyn-hooks-installer.tgz` path. Every thrown error must start with `infra: <step>:`, using the steps `archive`, `npm ci`, `build`, `version` and `install`.
- [ ] Create `scripts/lib/worktree.mjs` with `prepareWorktree(runPaths, repo)` per Design Decision 20, using a free port from `net.createServer().listen(0)`.
- [ ] `worktree.mjs`: add `aiWorkDirHasSession(dir, sid)` per Design Decision 21, reading the file the chunk 1 PoC confirmed.

### Chunk 5 — Verifier checks + prompts
- [ ] `scripts/lib/verify.mjs`: replace `VERDICT_FIELDS`, `EVIDENCE_SHOTS` and `VERIFIER_CALL_BUDGET` with `CHECKS`, `fieldsFor(checks)`, `shotsFor(checks)` and `verifierCallBudget(checks)` per Design Decision 5. Export `SKIPPABLE_FIELDS`. Remove `VERIFIER_TOOL_BUDGET` from `config.mjs` and from the import.
- [ ] `verify.mjs`: change `validateVerdict(json, fieldKeys)` per Design Decision 7. Update the `verifySession` loops (screenshot resolution, mismatches, evidence) to use the scenario's field and shot sets.
- [ ] `verify.mjs`: add `composeVerifyPrompt(checks, vars)` per Design Decision 6. Build `EXPECTED_JSON` from the base fields plus the check blocks (Design Decision 8), and add a `SHOT_<CHECK>` absolute-path var for each check shot.
- [ ] `verify.mjs`: add `judgeCost` (Design Decision 9) and `judgeWorkTime` (Design Decision 10). Add `applyScriptedJudgements(verdict, expected)`, which overwrites the `cost` / `workTime` statuses and notes and recomputes `overall`.
- [ ] `scripts/prompts/verify-session.md`: keep the login step and the screenshot and verdict rules. Replace the step list, the judge list and the verdict example with `{{STEPS}}`, `{{JUDGE}}` and `{{VERDICT_FIELDS}}`, and allow `"skipped"` only for `cost`.
- [ ] Create `prompts/checks/model.md`, `harness.md` and `prompt.md` by moving the existing steps 2–4 and their judge lines verbatim into the Design Decision 6 format.
- [ ] Create `prompts/checks/cost.md`, `bashTab.md`, `contextGrowth.md` and `agentsTable.md`, following the Fragment rules in Design Decision 6 and the selectors in Design Decision 13.
- [ ] Create `prompts/checks/systemContext.md`, `denied.md`, `workTime.md` and `bashPaths.md`, following the Fragment rules in Design Decision 6 and the selectors in Design Decision 13.

### Chunk 6 — API + visibility
- [ ] `scripts/lib/api.mjs`: add `getSessions(rid)` (`GET /api/v1/repositories/:rid/sessions`) and `waitForTelemetry({ rid, sid })` per Design Decision 11. It resolves `{ telemetryCost }` or `{ telemetryCost: null, timedOut: true }`.
- [ ] `scripts/lib/visibility.mjs`: add S8 to the `see` and `prompts` lists of V4 and V7. Add `LEGACY_REPO` to V3 `see` and to V1/V2 `notSee`. Add row V8 per Design Decision 15.
- [ ] `visibility.mjs`: `ownerVisibilityCheck` iterates `{...REPOS, [LEGACY_REPO]: LEGACY_OWNER}`, and `OWNER_VISIBILITY_ROWS` stays V1–V3.
- [ ] `visibility.mjs`: add `evaluateDirectSession(page, def, state, sessionIndex, baseURL)` per Design Decision 15. It uses an admin `ApiClient` from `api.mjs` for the 403 check. `runVisibility` calls it after `evaluatePersonal` when `def.directSession` is set and merges the problems.
- [ ] `visibility.mjs`: `promptPrefix` callers use `sessions[i].expected?.prompt ?? scenario.prompt`, so that filled prompts match. `indexSessions` keeps `expected.prompt`.

### Chunk 7 — Orchestrator wiring
- [ ] `scripts/run.mjs` `AC_PHASES`: add the Design Decision 23 entries. Import `LEGACY_SCENARIO`, the legacy and worktree helpers, and the new config constants.
- [ ] `run.mjs` `p3Repos`: call `createRepos` with `beforeCommit` that writes `GENERATED_CLAUDE_MD` into `CLAUDE_MD_REPO`. Then call `seedLegacyLogHub(java-lib, LEGACY_LOG_HUB_JSON)` and `createRepos(…, { repos: [LEGACY_REPO] })`, and add `legacy-hook` to `ctx.state.repos` with `owner: LEGACY_OWNER`.
- [ ] `run.mjs` `p3Repos` FR-6 check: no fixture source has a CLAUDE.md (`findClaudeMd(FIXTURES_DIR)`); only `js-cli` in the run-dir has one; its content equals `GENERATED_CLAUDE_MD`. Write a detail per the check.
- [ ] `run.mjs` `p5Hooks`: after the loop, record `FR-LC` (`checkLocalConfig` over `REPO_NAMES` minus `java-lib`) and `FR-UP` (`java-lib` with `legacy: true`), with both files' JSON as the detail. Then call `prepareWorktree` and save it to state.
- [ ] `run.mjs`: add phase P5b `p5bLegacyHook` after P5 (Design Decision 23). It runs `buildPrevInstaller` then `installPrevHook` with U3's API key. On error it records `FR-OLD` P5b `fail` with the `infra:` detail and continues. On success it stores the tgz path and versions in state.
- [ ] `run.mjs` `p8Sessions`: pass `rootDir: ctx.state.worktree.dir` for `useWorktree` scenarios. After S11, record `FR-WT` per Design Decision 21. Run `LEGACY_SCENARIO` when `FR-OLD` P5b passed. Exclude L1 from the FR-8 coverage loop and update the detail to "S1–S11".
- [ ] `run.mjs` `p9Verify`: iterate `[...SCENARIOS, LEGACY_SCENARIO]`. Call `waitForTelemetry` before `verifySession` when the checks include `cost`, then `applyScriptedJudgements`. Record `FR-OLD` P9 from L1's status, with the detail naming the ref and versions.
- [ ] `run.mjs` `p10Visibility` and `p11Final`: pass the L1 result into `runVisibility`. Change the `FR-9b` detail to "V1–V8". Extend the completeness ids per Design Decision 22.

### Chunk 8 — Report + docs
- [ ] `scripts/lib/report.mjs`: render the `skipped` field status (neither pass nor fail in the counts) and the per-check evidence galleries. Make sure L1 and V8 appear in `index.md` and `report.json`.
- [ ] `SKILL.md`: update the description and the phase list (P5b, the new AC rows), the session matrix (S8–S11, L1), the V rows (V8) and the run-dir layout. Keep it within the existing structure.
- [ ] `docs/knowledgebase/test/big-prod-e2e-test.md`: update the phase table (P5b), the session matrix (S8–S11, L1, verify checks), the V rows (V8), the run-dir (`_prev-src`, `_prev-hook`, `legacy-hook`, `ts-webapp-wt`), the report sections and the Files list.
- [ ] Same KB article: add troubleshooting entries for a `FR-OLD` infra fail, a cost `skipped` because of the telemetry wait, an S11 OTEL 409, an S8 denial shown as ✗ error, and `{{REPO_ROOT}}` path forms on Windows (`D:/…` or `/d/…`, both matched by `toRepoRelative`).
- [ ] Check that `docs/knowledgebase/index.md` still describes the big-test article accurately, and update its one-line hook if the scope wording changed.

### Chunk 9 — Helper tests
- [ ] `scripts/__tests__/big-prod-e2e-test.test.js` `scenarios` block: replace the "seven entries" assertion with 11 ids S1–S11 and L1 kept separate. Assert the new fields, `promptFor` filling, and that `{{REPO_ROOT}}` never appears within the first 40 characters.
- [ ] `evidence` block: add inline transcript-line cases for each new `extractHarness` key, `isExercised` / `exercisedGap` for `bash`, `bashError`, `denied`, `background`, `cwd` and `noHarness`, and `workTimeWindow` (using a sidechain entry and a tool_result after the last assistant).
- [ ] `verify` block: replace the "VERDICT_FIELDS has seven fields" test. Cover `fieldsFor` / `shotsFor` / budget for S1, S4 and L1, `validateVerdict` with `skipped`, and `composeVerifyPrompt` leaving no `{{…}}` for every scenario.
- [ ] `verify` block: add `judgeCost` table rows (null → skipped; T = 1.0000 with Δ 0.0499 pass and Δ 0.0500 fail; T = 10.0000 with Δ 0.0999 pass and Δ 0.1000 fail) and `judgeWorkTime` rows (`0:00:41` against minSeconds 41 passes, against 42 fails).
- [ ] `repos.createRepos` block: `beforeCommit` writes CLAUDE.md into the committed tree, and a fixture CLAUDE.md still throws. Add `seedLegacyLogHub` (makes a second commit) and `hooks.checkLocalConfig` (template, installed and legacy shapes).
- [ ] `visibility` block: V8 `judgePersonal` with all repos `notSee`, and `ownerVisibilityCheck` covering `legacy-hook`. Run `npm run test:scripts` from the repo root until it is green.

### Chunk 10 — Full run + verification
- [ ] Run the fast set via `adlc-lh:check-health` (`finalRun: false`) and fix every failure.
- [ ] Run one full `/big-prod-e2e-test` in the background and wait for its report.
- [ ] Classify every failed row in `_report/index.md` as a test-tooling bug (fix and re-run), a product defect (open a task via `adlc-lh:tracker`) or an infrastructure failure. Record the classification in `notes.md`.
- [ ] Check every requirements AC against the final report (`index.md`, `report.json`, screenshots), and tick the ACs in `requirements.md` that the run proves.
