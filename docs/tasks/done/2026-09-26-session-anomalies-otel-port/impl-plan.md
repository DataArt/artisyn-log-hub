# Implementation Plan: 2026-09-26 Session List Anomalies and OTEL Port Drift Fixes

## TL;DR

- **Scope is the remainder only.** FR-1 detection, FR-2 and FR-7 are done; this plan covers FR-6, FR-5, the FR-3 KB/corpus
  entries and the FR-1/FR-3 regression coverage.
- **Installer (FR-6, highest blast radius):** the nine Artisyn OTEL env keys move from the committed `.claude/settings.json`
  to the gitignored `.claude/settings.local.json`. Stale Artisyn-owned loopback endpoints are rewritten to the resolved
  port, with ownership judged per key and per file (Design Decisions 1–6). Uninstall cleans both files, and `upgrade`
  prints a restart note. New helpers in `artisyn-hooks-installer/src/install.ts`: `readRecordedOtelPorts`,
  `isArtisynOwnedOtelValue`, `mergeOtelEnv`, `removeOtelEnvKeys`, plus a file-parameterised `readSettingsForMutation`.
  Patch bump of `artisyn-hooks-installer/package.json`.
- **Server (FR-5):** `extractTimestampRange` (`server/src/logs/artisyn-extractor.ts:106`) now starts the session at the
  first `prompt_start`/`prompt` line. It applies to new ingests and `recompute-all-sessions`, with no backfill.
- **New algorithm doc + table test:** `docs/knowledgebase/algorithms/session-time-span.md` and
  `server/src/logs/artisyn-extractor.algo.spec.ts`.
- **Golden fixtures change:** GS-05's expected start moves from 10:00:00 to 10:00:10 (`durationMs` 210000 → 200000), and
  the oracle in `tests/golden/check-arithmetic.mjs` adopts the FR-5 rule. GS-01 gains the seven new Claude Code event
  types.
- **Contract oracle fix:** the `hasWorkflow` column in `server/test/contract/registry/f17-sessions.ts` adopts the
  controller's real-`tool_use` rule.
- **This repo's own `.claude/settings.json` loses its nine OTEL keys**, which move to `.claude/settings.local.json`
  (dogfood migration).
- **Hook (text only):** the FR-7 warning's "Fix:" text and comments in `otel-endpoint-check.js`/`env-context.js` now
  point at `upgrade` / `.claude/settings.local.json`. Hook version 2.22.0 → 2.22.1, `npm run build:hooks-installer`, a
  dogfood refresh, and the `update-install-instructions` sync of `hook/INSTALL_HOOK.md`/`hook/README.md`.
- **User-visible repo change:** the installer now adds `settings.local.json` and `settings.local.json.bak` to
  `.claude/.gitignore` when they are not already ignored.
- **KB rewrites:** `hook-installation.md`, `otel-receiver.md`, `index.md`, `log-schema/*`, `algorithms/README.md`,
  `test/scenarios.md`, and, if they list types, `session-log-view.md` / `raw-logs-renderers.md`.
- **Tests:** golden-load gains a `hasWorkflow` assertion. S-INST-01 gains steps 6b/6c (port move, legacy migration).
  S-INST-02 step 4 checks that `settings.local.json` and its `.bak` stay out of `git status`. S-INST-04 gains 3b/3c
  (user collectors). The hook Fix text change is not covered by a test.
- **No** DB changes, API changes, new npm packages or client code changes.

## Reference

- Requirements: [requirements.md](requirements.md)
- Evidence and re-review (2026-10-21): [notes.md](notes.md)
- Research archive: [research/findings-1.md](research/findings-1.md)

## Design Decisions

### FR-6 — installer

1. **Ownership predicate.** New constant `OTEL_ENDPOINT_KEYS = ['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
   'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT']`. Ownership is judged per file, given that file's `env` object.
   `isArtisynOwnedOtelValue(key, env, ownedPorts)` returns true when:
   - for a key in `OTEL_ENDPOINT_KEYS`: `env[key]` is a string matching `OTEL_LOOPBACK_ENDPOINT_RE` and its port is in
     `OTEL_PORT_MIN..OTEL_PORT_MAX` (`install.ts:1297-1298`) or in `ownedPorts`;
   - for any of the other seven keys, both of these hold:
     - `env[key] === OTEL_ENV_KEYS(0)[key]` (those values do not depend on the port);
     - every endpoint key present in the same `env` is owned. So a file whose endpoint points at a user's collector
       keeps its exporter/protocol keys: they are the user's.
2. **Endpoint regex.** `OTEL_LOOPBACK_ENDPOINT_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})\/v1\/(?:logs|metrics)$/`
   replaces `OTEL_LOOPBACK_LOGS_ENDPOINT_RE` (`install.ts:1546`). Capture group 1 is the port.
3. **Owned ports.** `readRecordedOtelPorts(cwd): Set<number>` reads `.artisyn/config/otel-port.json` `port` and
   `.artisyn/config/log-hub.json` `otelReceiverPort`. Both are added when they disagree, and only values passing
   `isUsablePortNumber` count. Callers:
   - install/upgrade call it **before** `resolveInstallOtelPort` (`install.ts:693`), because that call overwrites the
     store. The resolved port is added to the set as well.
   - `runUninstall` calls it **before** `removePluginSettingsKeys` (`install.ts:1068`), and the set is passed into that
     function and into the `settings.local.json` cleanup.
4. **Per-key merge on install/upgrade** (`mergeOtelEnv`). Let `shared` be `.claude/settings.json` `env` and `local` be
   `.claude/settings.local.json` `env`. For each key `k` of `OTEL_ENV_KEYS(otelPort)`:
   - **(a)** `shared[k]` is present and owned: delete it from `shared` (migration).
   - **(b)** `shared[k]` is present and not owned: the user's value. Keep it, do not write `local[k]`, delete `local[k]`
     if that one is owned, and list `k` in the existing `Note: kept your existing .claude/settings.json env values for …`
     line.
   - **(c)** Otherwise, for an endpoint key:
     - `local[k]` is absent or owned: set it to the desired value. If it was owned and its value differs, add
       `k: old → new` to the rewrite Note.
     - `local[k]` is not owned: keep it and add `k` to the Note
       `Note: kept your existing .claude/settings.local.json env values for …`.
   - **(d)** Otherwise, for a non-endpoint key: fill it in `local` only if absent. A different existing value goes into
     that same `settings.local.json` Note.
5. **Write order and file contract.**
   - `.claude/settings.local.json` is written first, then `.claude/settings.json`. Both go through
     `readSettingsForMutation(claudeDir, fileName)`: an invalid JSON file aborts with
     `Error: .claude/<fileName> is not valid JSON - fix it and re-run`, and `<file>.bak` is written before any mutation.
   - `settings.local.json` is created when absent.
   - An emptied `env` object is deleted from either file.
   - After the local write, call `ensureConfigIgnored(cwd, p, { secret: false })` for both
     `p = <claudeDir>/settings.local.json` and `p = <claudeDir>/settings.local.json.bak` (`install.ts:1226`). That adds
     each basename to `.claude/.gitignore` when `git check-ignore` misses it, so neither file shows up as untracked.
6. **Uninstall** (`removeOtelEnvKeys(claudeDir, fileName, ownedPorts)`):
   - In each file, delete every key of `OTEL_ENV_KEYS` that is owned per Decision 1. Ownership is evaluated on the
     file's env before any deletion.
   - For `settings.json` this runs inside `removePluginSettingsKeys`, which gains an `ownedPorts` parameter.
   - For `settings.local.json`, `runUninstall` calls it directly, whether or not `settings.json` exists.
   - Rewrite and back up `.claude/settings.local.json` only when at least one key was removed. Never delete the file.
   - For each non-owned endpoint key, print
     `Note: .claude/<file> env.<KEY> is "<value>", which is not an Artisyn loopback receiver — leaving it untouched.`
     (the prefix up to the closing quote is unchanged from today).
7. **Report lines on install/upgrade.**
   - Rewrite Note:
     `Note: rewrote stale Artisyn OTEL endpoints in .claude/settings.local.json (<KEY>: <oldPort> → <newPort>, …).`
   - Migration Note:
     `Note: moved the Artisyn OTEL env keys from .claude/settings.json to .claude/settings.local.json.`
     It is printed when step (a) deleted at least one key.
   - `runUpgrade` always prints, after the success lines:
     `Note: Claude Code sessions that are already running keep their old OTEL endpoint until restarted.`
8. **Dogfood migration.** Move this repo's nine OTEL keys from `.claude/settings.json` to the existing
   `.claude/settings.local.json` by hand. The result is identical to what the new installer produces, and it needs no
   running server. `.claude/settings.local.json` is already ignored by root `.gitignore:16`.

### FR-5 — session time span

9. **Start rule.** In `extractTimestampRange`:
   - `startTime` is the timestamp of the earliest line whose `event` is `prompt_start` or `prompt` and whose `timestamp`
     parses, whatever its prompt text;
   - if there is no such line, `startTime` falls back to the current rule (minimum over activity lines);
   - `endTime` is unchanged (the maximum over activity lines);
   - `NON_ACTIVITY_LINE_TYPES` filtering applies to both.
   It is one loop that tracks `minPromptTs` alongside `minTs`/`maxTs`. "Earliest" means the smallest parsed value, not
   file order.
10. **Golden oracle.** Lines 313-320 of `check-arithmetic.mjs` change:
    - `exp.start` = first artisyn `prompt_start` timestamp (falling back to the minimum artisyn timestamp);
    - `exp.end` = last transcript timestamp = last artisyn timestamp;
    - the transcript's first timestamp must be ≤ `exp.start`;
    - `durationMs` = end − start (unchanged formula).

### FR-3 / FR-1 coverage

11. **GS-01 gains the seven event types.** One line each, inserted into `tests/golden/gs-01-simple/session.jsonl`:
    - `attachment/prompt_snapshot`, with a `tools` array containing `{"name":"Workflow","schema":{}}`;
    - `attachment/total_tokens_reminder`, `attachment/silent_turn_reminder`, `attachment/deferred_tools_record`,
      `attachment/remote_session_change`;
    - top-level `atis-latch` and `cost-state`, with no timestamp.
    Attachments copy the envelope of the existing line `gs01-0001` and use timestamps inside 10:00:00–10:10:30, so the
    span is unchanged. `cost-state` carries `totalCostUSD: 99`, so any leak into cost is visible. Field shapes follow the
    log-schema entries added in chunk 5.
12. **`hasWorkflow` expectation.** In golden-load, a root's expected `hasWorkflow` is
    `e.nodes.some((n) => n.workflow !== undefined)`. That is true only for GS-05, so `expected.json` needs no new field.
13. **Corpus.** Add `deferred_tools_record` and `silent_turn_reminder` to `tests/corpus/known-format.json` →
    `attachmentTypes` by hand, keeping the array sorted. No local set holds them, so `--approve` cannot.

### Hook text

14. **Hook remediation text.** `formatProblems` in `hook/.claude/telemetry_tool/otel-endpoint-check.js` (~L155-164)
    ends with:
    `Fix: re-run the log-hub installer "upgrade" (it writes ${LOGS_KEY}/${METRICS_KEY} for port <receiverPort> to .claude/settings.local.json), then restart Claude Code.`
    The header comment (L8, L18-21) and the `env-context.js` comment (~L309) name `.claude/settings.local.json` as
    where the installer writes the endpoints. Detection logic is unchanged.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `artisyn-hooks-installer/src/install.ts` | FR-6 | Per Decisions 1–7: regex, `readRecordedOtelPorts`, `isArtisynOwnedOtelValue`, `readSettingsForMutation(claudeDir, fileName)`, `mergeOtelEnv`, `removeOtelEnvKeys`, call sites in the install path (~L680-760), `mergeSettings` (~L1938-1960), `removePluginSettingsKeys` (~L2013-2038), `runUpgrade` (~L1034-1043), `runUninstall` (~L1068) |
| `artisyn-hooks-installer/package.json` | patch bump | Per `.claude/rules/installer.md` |
| `.claude/settings.json`, `.claude/settings.local.json` | dogfood migration | Per Decision 8 |
| `server/src/logs/artisyn-extractor.ts` | FR-5 | `extractTimestampRange` per Decision 9; update its doc comment |
| `server/src/logs/artisyn-extractor.algo.spec.ts` | new | FR-5 table test, template `claude-extractor.algo.spec.ts` |
| `docs/knowledgebase/algorithms/session-time-span.md` | new | FR-5 algorithm doc |
| `docs/knowledgebase/algorithms/README.md` | Docs table row | `session-time-span` |
| `docs/knowledgebase/log-schema/claude-log-message-types.md` | FR-3 | `atis-latch`, `cost-state`; hand-maintained header note |
| `docs/knowledgebase/log-schema/attachment-types.md` | FR-3 | 5 attachment types; hand-maintained header note |
| `docs/knowledgebase/log-schema/index.md` | FR-3 | Attachment sub-type count 20 → 25 |
| `tests/corpus/known-format.json` | FR-3 | Per Decision 13 |
| `docs/knowledgebase/hook-installation.md` | FR-6 | env-block section L315-354, uninstall rule L144-147 |
| `docs/knowledgebase/otel-receiver.md` | FR-6 | L100-130, L300: settings file named |
| `docs/knowledgebase/index.md` | FR-6 / FR-5 | L38 wording; algorithms entry if listed |
| `hook/INSTALL_HOOK.md`, `hook/README.md` | FR-6 | Via the `update-install-instructions` skill (L164, L485-513; README L58) |
| `tests/golden/gs-01-simple/session.jsonl` | FR-1/FR-3 | Per Decision 11 |
| `tests/golden/gs-05-skills-rules-mcp-workflow/expected.json` | FR-5 | `start` → `2026-01-08T10:00:10.000Z`, `durationMs` → `200000` |
| `tests/golden/check-arithmetic.mjs` | FR-5 | Per Decision 10 |
| `tests/golden/README.md`, `tests/golden/gs-01-simple/README.md` | docs | GS-05 start 10:00:10; GS-01 lists the new events |
| `tests/scenarios/view/golden-load.spec.ts` | FR-1 | `hasWorkflow` in the sessions-list step |
| `server/test/contract/registry/f17-sessions.ts` | FR-1 | `has_workflow` oracle = controller rule |
| `tests/scenarios/installer/s-inst-01.spec.ts`, `s-inst-02.spec.ts`, `s-inst-04.spec.ts` | FR-6 | Steps per Test coverage plan |
| `docs/knowledgebase/test/scenarios.md` | FR-6 / FR-5 | S-INST step descriptions L246-265; golden lifecycle lines if they quote GS-05's start |
| `tests/golden/repo-gold.expected.json` | FR-5 | Only literals `check-arithmetic.mjs` flags after the GS-05 change |
| `docs/knowledgebase/session-log-view.md`, `docs/knowledgebase/raw-logs-renderers.md` | FR-3 | Only if they list known types |
| `hook/.claude/telemetry_tool/otel-endpoint-check.js`, `env-context.js` | FR-6 | Text/comments per Design Decision 14 |
| `hook/.claude/telemetry_tool/version.json` | hook bump | 2.22.0 → 2.22.1 |
| `.artisyn/marketplace/plugins/log-hub-hooks/` | dogfood refresh | Per `.claude/rules/hook.md` |
| `docs/tasks/todo/2026-09-26-session-anomalies-otel-port/requirements.md` | AC | Tick ACs at the end |

## Test coverage plan

All items use the three kinds the CLAUDE.md test policy allows. No route changes, so no new contract row.

- **Algorithm (FR-5):**
  - New doc `docs/knowledgebase/algorithms/session-time-span.md` and its jest table test
    `server/src/logs/artisyn-extractor.algo.spec.ts` (a new doc, so a new test file is allowed).
  - Rows:

    | Case | Start | End |
    |---|---|---|
    | `/clear` + idle + first prompt (row-A shape: `SessionStart` 17:08:59, `prompt_start` 19:14:02, `prompt_stop` 19:15:10) | 19:14:02 | 19:15:10 |
    | No prompt line | unchanged min | max |
    | Legacy `event: "prompt"` | that line | max |
    | `prompt_start` with an empty prompt | still counts | max |
    | First `prompt_start` with an invalid timestamp | next valid prompt line | max |
    | `prompt_start` lines out of file order | smallest timestamp | max |
    | A `code-inventory` line earlier than everything | ignored | max |
    | Empty input | null | null |
- **Scenario — golden-load (`tests/scenarios/view/golden-load.spec.ts`, tag `GOLDEN-LOAD`, mode a):**
  - The sessions-list step asserts `hasWorkflow` per Decision 12. This is the FR-1 regression: GS-01 carries a
    `prompt_snapshot` listing Workflow and must stay `false`.
  - The existing `startTime` assertion covers FR-5 through GS-05's new expected start.
  - GS-01's existing tokens/cost/turns/work-time assertions, all unchanged, cover FR-3: the seven event types feed no
    metric.
  - `node tests/golden/check-arithmetic.mjs` must stay green.
- **API contract (F17, `server/test/contract/registry/f17-sessions.ts`):** align the `has_workflow` oracle with the
  controller's rule, so the contract no longer passes only by accident. The world fixture is not changed.
- **Scenario — installer:**
  - `@S-INST-01`:
    - step 6 now asserts that `.claude/settings.json` has no OTEL key and that `.claude/settings.local.json` `env` equals
      `OTEL_ENV(port)`;
    - new step 6b (FR-6 core AC): write a different in-range port B to `otel-port.json`, re-run `install`, and assert
      both endpoints in `settings.local.json` are on port B and the rewrite Note is printed;
    - new step 6c: a legacy layout migrates on `install`. Write the nine `OTEL_ENV(stale)` keys (`stale = port === 30001 ? 30002 : 30001`) into
      `.claude/settings.json`; afterwards `settings.json` has none of them, `settings.local.json` has `OTEL_ENV(port)`,
      and the migration Note is printed.
  - `@S-INST-02` step 4: `git status` shows neither `.claude/settings.local.json` nor `.claude/settings.local.json.bak`.
    Step 6 is unchanged: it aborts before any settings write.
  - `@S-INST-04`:
    - step 2 asserts that after `uninstall`, `settings.local.json` holds no OTEL key;
    - step 3 keeps the user's non-loopback logs collector in `settings.json`, with no `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
      in `settings.local.json`;
    - new step 3b: a user loopback collector `http://localhost:4318/v1/logs` in `settings.local.json` survives install
      and uninstall, and the `settings.local.json` Note is printed;
    - new step 3c: all nine keys committed in `settings.json` with both endpoints on `https://collector.corp.test:4318`.
      `settings.json` `env` is byte-identical after install and after uninstall, and `settings.local.json` gets no
      OTEL key;
    - step 5 keeps "only `settings.json.bak` changes".
- **Hook Fix text (Design Decision 14):** no test. It is a message-only change, the detection logic is unchanged, and
  no scenario asserts the FR-7 warning text.
- **FR-8:** no new test. The existing `@S-COMPAT-01` and `s-ingest-0*` scenarios stay green in the final run.

## Wireframes

No changes. `wireframes/session-detail-header.svg` already shows the FR-5 result (START 19:14:02, span 1m 8s), and
`wireframes/sessions-list-workflow-badge.svg` the FR-1 result.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Installer: ownership and settings I/O | 4 | Pure helpers; no behaviour change yet |
| 2 | Installer: install/upgrade/uninstall wiring | 6 | Uses chunk 1 helpers |
| 3 | Hook: remediation text + propagation | 4 | After 1–2 |
| 4 | Server: FR-5 start rule + algorithm doc | 5 | Independent of 1–3 |
| 5 | KB and corpus docs | 7 | After 1–4 |
| 6 | Tests: golden fixtures, oracle, contract | 6 | Needs chunks 4–5 |
| 7 | Tests: installer scenarios + wrap-up | 6 | Needs chunks 2–3 |

### Chunk 1 — Installer: ownership and settings I/O
- [ ] In `artisyn-hooks-installer/src/install.ts`, replace `OTEL_LOOPBACK_LOGS_ENDPOINT_RE` (~L1546) with `OTEL_LOOPBACK_ENDPOINT_RE` per Design Decision 2, add `OTEL_ENDPOINT_KEYS` (the two endpoint key names), and update every reference to the old regex.
- [ ] Add `readRecordedOtelPorts(cwd): Set<number>` per Design Decision 3, reusing `readStoredOtelPort` (~L1342) and `readJsonConfig` on `log-hub.json`, keeping only `isUsablePortNumber` values.
- [ ] Add `isArtisynOwnedOtelValue(key, env, ownedPorts)` per Design Decision 1, including the rule that a non-endpoint key is owned only while every endpoint key present in the same `env` is owned.
- [ ] Change `readSettingsForMutation` (~L1825) to `readSettingsForMutation(claudeDir, fileName: 'settings.json' | 'settings.local.json')`, with the error text and `.bak` path naming the file, per Design Decision 5; update its two existing callers to pass `'settings.json'`.

### Chunk 2 — Installer: install/upgrade/uninstall wiring
- [ ] Add `mergeOtelEnv(cwd, claudeDir, otelPort, ownedPorts, sharedEnv)`, implementing Design Decisions 4, 5 and 7. It writes `.claude/settings.local.json`, calls `ensureConfigIgnored(..., { secret: false })`, and returns the cleaned `.claude/settings.json` env.
- [ ] In `mergeSettings` (~L1938-1960), replace the fill-if-absent env block with a `mergeOtelEnv` call. Delete `env` when it is emptied. Add an `ownedPorts` parameter.
- [ ] In the install/upgrade path, call `readRecordedOtelPorts(cwd)` before `resolveInstallOtelPort` (~L693), add the resolved port to the set, and pass the set into `mergeSettings` (~L753).
- [ ] Add `removeOtelEnvKeys(claudeDir, fileName, ownedPorts)` per Design Decision 6. Give `removePluginSettingsKeys` an `ownedPorts` parameter and replace its env block (~L2013-2038) with it. In `runUninstall`, read `ownedPorts` before `removePluginSettingsKeys` (~L1068), then call it for `settings.local.json` unconditionally.
- [ ] In `runUpgrade` (~L1034-1043), print the restart Note from Design Decision 7 after the success lines. Update the doc comments of `OTEL_ENV_KEYS` (~L1516) and `mergeSettings` to name `.claude/settings.local.json`.
- [ ] Bump `artisyn-hooks-installer/package.json` 1.0.70 → 1.0.71 (keep whatever higher version chunk 3's `build:hooks-installer` auto-bump writes later), then migrate this repo's own settings per Design Decision 8.

### Chunk 3 — Hook: remediation text + propagation
- [ ] In `hook/.claude/telemetry_tool/otel-endpoint-check.js`, change the `formatProblems` Fix text (~L160-163) and the header comment (L8, L18-21) per Design Decision 14; in `env-context.js` (~L309), change the comment to name `.claude/settings.local.json`.
- [ ] Bump `hook/.claude/telemetry_tool/version.json` 2.22.0 → 2.22.1. Run `npm run lint:fix` and `npm run lint` from `hook/` (per `.claude/rules/hook.md`), then `npm test` from `hook/`.
- [ ] Run `npm run build:hooks-installer` (syncs the installer version and tarballs), then refresh the dogfood copy under `.artisyn/marketplace/plugins/log-hub-hooks/` per the steps in `.claude/rules/hook.md`.
- [ ] Run the `update-install-instructions` skill to sync `hook/INSTALL_HOOK.md` (L164, L485-513) and `hook/README.md` L58 with the new env-block location and the new Fix text.

### Chunk 4 — Server: FR-5 start rule + algorithm doc
- [ ] In `server/src/logs/artisyn-extractor.ts`, change `extractTimestampRange` (~L106-128) per Design Decision 9, and add a doc comment naming the rule and `docs/knowledgebase/algorithms/session-time-span.md`.
- [ ] Create `docs/knowledgebase/algorithms/session-time-span.md` in the format of `algorithms/README.md`: front-matter `reviewed: no` / `reviewer: none`, the sections Purpose, Code, Rules, Edge cases, Examples (a single `examples` JSON block with the rows from Test coverage plan → Algorithm), Mutations, and Where visible (list span, session header, date filters, analytics).
- [ ] Create `server/src/logs/artisyn-extractor.algo.spec.ts` on the `claude-extractor.algo.spec.ts` template. Use `loadExamples` for `session-time-span`, turn each row into artisyn lines, and assert `extractTimestampRange`.
- [ ] Add a `session-time-span` row to the Docs table in `docs/knowledgebase/algorithms/README.md` (Code `server/src/logs/artisyn-extractor.ts`, runner jest).
- [ ] Run the AI review of the new doc per `scripts/algo-docs/review-prompt.md` and record the result in its front-matter, as the README requires.

### Chunk 5 — KB and corpus docs
- [ ] In `docs/knowledgebase/log-schema/claude-log-message-types.md`, add `atis-latch` (`atis`, `sessionId`, no timestamp) and `cost-state` (`totalCostUSD`, `modelUsage`, `startTime`, `totalDuration`; never a cost source). Add the header note that entries after the 2026-06-15 snapshot are hand-maintained.
- [ ] In `docs/knowledgebase/log-schema/attachment-types.md`, add `prompt_snapshot`, `total_tokens_reminder`, `silent_turn_reminder`, `deferred_tools_record` and `remote_session_change`, each with Mandatory Fields and a Suggested Display Strategy, using the field lists in `research/findings-1.md` → Prototype result. Add the same header note.
- [ ] Update `docs/knowledgebase/log-schema/index.md` (attachment sub-type count 20 → 25) and add the two types to `tests/corpus/known-format.json` per Design Decision 13.
- [ ] Rewrite `docs/knowledgebase/hook-installation.md` L315-354 (env block now in `.claude/settings.local.json`, ownership per Design Decision 1, the per-key merge, the stale-endpoint rewrite, and delete the "Known gap" paragraph) and L144-147 (per-key uninstall).
- [ ] Update `docs/knowledgebase/otel-receiver.md` (~L100-130, L300) and `docs/knowledgebase/index.md` L38 to name `.claude/settings.local.json`.
- [ ] In `docs/knowledgebase/hook-installation.md`, document the hook's new Fix text and version 2.22.1 wherever FR-7's warning is described.
- [ ] Check `docs/knowledgebase/session-log-view.md` and `raw-logs-renderers.md`. If either lists the known attachment or line types, add the seven new ones as collapsed rows with no special renderer.

### Chunk 6 — Tests: golden fixtures, oracle, contract
- [ ] Insert the seven event lines into `tests/golden/gs-01-simple/session.jsonl` per Design Decision 11, and list them in `tests/golden/gs-01-simple/README.md`.
- [ ] In `tests/golden/gs-05-skills-rules-mcp-workflow/expected.json`, set `start` to `2026-01-08T10:00:10.000Z` and `durationMs` to `200000`. Change the GS-05 row of `tests/golden/README.md` from 10:00:00 to 10:00:10.
- [ ] Change `tests/golden/check-arithmetic.mjs` L313-320 per Design Decision 10. Run `node tests/golden/check-arithmetic.mjs` and correct any derived repo-level literal it flags in `repo-gold.expected.json` (for example `workTimeMinutesByDay`), and nothing else.
- [ ] In `tests/scenarios/view/golden-load.spec.ts`, add `hasWorkflow: boolean` to `SessionRow` in the sessions-list step (~L118-145) and assert it per Design Decision 12.
- [ ] In `server/test/contract/registry/f17-sessions.ts` L34, replace `r.workflow_run_id IS NOT NULL AS has_workflow` with an `EXISTS` over the session's `log_type = 'claude'` logs (`session_id = r.id`), copying the predicate in `server/src/logs/repositories.controller.ts:833-848`.
- [ ] Run `npm run test:scenarios -- --mode a --only scenarios --grep "GOLDEN-LOAD|@S-COST-01|@S-REPT-01|@S-INGEST-0"` and fix any failing start expectation to the FR-5 rule.

### Chunk 7 — Tests: installer scenarios + wrap-up
- [ ] `tests/scenarios/installer/s-inst-01.spec.ts`: change step 6 (L199-208) to assert that `settings.json` has no `OTEL_ENV` key and that `.claude/settings.local.json` `env` equals `OTEL_ENV(port)`.
- [ ] Add steps 6b and 6c to `s-inst-01.spec.ts`, per Test coverage plan → Scenario — installer.
- [ ] `tests/scenarios/installer/s-inst-02.spec.ts` step 4 (L79-84): also assert that no `git status` line mentions `.claude/settings.local.json` or `.claude/settings.local.json.bak`. Leave step 6 unchanged.
- [ ] `tests/scenarios/installer/s-inst-04.spec.ts`: update steps 2 and 3 (L103-137) and add steps 3b and 3c, per Test coverage plan → Scenario — installer. Keep step 5's single `.bak` expectation.
- [ ] Run `npm run test:scenarios -- --mode a --only scenarios --grep "@S-INST-0"`, then update the S-INST step descriptions in `docs/knowledgebase/test/scenarios.md` (L246-265).
- [ ] In `requirements.md`, tick the FR-3, FR-5 and FR-6 ACs that are now covered. The FR-1 audited-repo check and the live upgrade AC stay open for the owner to run manually.
