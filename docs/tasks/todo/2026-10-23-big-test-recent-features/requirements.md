# 2026-10-23: Big Pre-Prod E2E Test — Cover Recent Features

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** test tooling (`.claude/skills/big-prod-e2e-test/`)
**Owner:** denis.tsyplakov
**Created:** 2026-10-23

## Description

The `big-prod-e2e-test` skill has not changed since the initial public release (2026-10-20). Since then
the product gained several features that the pre-prod run does not exercise at all. The run also
covers only the happy path: every session uses `--permission-mode bypassPermissions` and has no
failing tool call. The verifier checks only model, skills / rules / workflows / MCP, subagent count
and the first prompt.

Extend the run to cover the recent changes. Do the cheap work first: extend the verifier on existing
sessions and add visibility/installer checks. Add new paid sessions only where no existing one can
carry the check.

Features that need coverage and where they came from:

- Tool call details: Bash tab, Bash view (cwd, touched files, repo-relative paths), Context Growth
  step modal, precise call statuses, permission events with reason, hook 2.24.0 `tool_use_id` on
  `PostToolUseFailure` / `PermissionDenied` (3f51816).
- `<task-notification>` no longer ends a turn's work time (68ba4c2).
- Workflow "Agents (N)" table and the per-agent Logs / Raw logs modal (3c521f8).
- Admin role grants no session-data access (2c2b2d2).
- System Context Files/Rules from the instructions attachment, and the correct skill source
  (1235862, 043b650).
- Installer writes `serverUrl` / `otelReceiverPort` into `log-hub.local.json` and removes the legacy
  `otelReceiverPort` from `log-hub.json` (9396f80).
- `ARTISYN_PROJECT_ROOT` root override, hook 2.23.0 (8058799).
- Hook API backward compatibility: an older hook must keep working against the new server
  (a CLAUDE.md requirement).

## Functional Requirements

**Verifier extensions on existing sessions (no new sessions)**

- FR-1: For S4 (saved workflow), the verifier checks the workflow "Agents (N)" table: one row per
  workflow agent of `java-refactor` (2 agents, numbered `1`, `2`), each with a non-empty Duration and
  Tokens. Opening a row shows the agent modal, and both its Logs and Raw logs tabs are non-empty.
- FR-2: S1's prompt ends with an explicit `node --test tests/calc.test.js` run, and S1 gains a
  `requires.bash: 1` (minimum Bash calls) key so retries enforce it. The verifier checks the S1 Bash
  tab: it lists the Bash calls with their command, working directory and touched files, and
  `tests/calc.test.js` is shown relative to the repo.
- FR-3: For at least one session, the verifier opens a Context Growth step and checks that the step
  modal lists that step's tool calls.
- FR-4: For S5 (path-scoped rule) and a skill session (S2 or S6), the verifier checks the System
  Context panel: on the Logs tab, expand `sysctx-panel` ("Show details"). The Rules sub-tab lists
  `cli-flags` (role rule, `.claude/rules/cli-flags.md`); the Skills sub-tab lists the project skill
  (`add-jsdoc` / `api-endpoint`) with source badge "project". For S5 the Files sub-tab also lists
  `CLAUDE.md` (type Project) — the generated file from FR-4a.
- FR-4a (emulated CLAUDE.md): the fixtures under `.claude/skills/big-prod-e2e-test/fixtures/` still
  contain no CLAUDE.md. P3 writes a CLAUDE.md into the run-dir copy of `js-cli` (S5's repo) after
  copying the fixture and before its git commit. The content is a fixed, harmless text kept as a
  constant in the skill's scripts (a short project note, no instructions that change what S5
  does). The P3 FR-6 check asserts: no fixture source has a CLAUDE.md, only `js-cli` in the run-dir
  has one, and its content equals the constant.
- FR-5: Each session run persists the verified attempt's `stream.finalResult.total_cost_usd` (the
  session stream, not the verifier) as `costUsd` in `<S#>.result.json` and `<S#>.expected.json`, and
  passes it to the verifier. For every session S1–S11 the verifier compares it with the "Telemetry
  total" row of the Info tab's Tokens & Cost section (`data-testid="cost-reconciliation"`) — the same
  client-side metering as `total_cost_usd`, not the calculated totals. Pass rule: the product's
  `costMismatch()` tolerance (within $0.05 or within 1 %). Each `claude -p` run has one final `result`
  event with the cumulative cost; that value is used. A null `costUsd` or a missing Telemetry total
  row makes the field `skipped`, not failed.

**New sessions**

- FR-6 (S8, permissions and errors, repo `js-cli`, owner U2): a session that does not use `bypassPermissions`. It runs with
  `--permission-mode default --allowedTools "Read" "Bash(node:*)"`. Under `claude -p` no one can
  answer a permission prompt, so any tool outside the allow list is denied at once, every time.
  The prompt makes three calls: one Bash call that succeeds (`node --version`), one Bash call that
  fails on purpose (`node -e "process.exit(3)"`, non-zero exit), and one `Write` of a new file
  (`denied.txt`), which is the denied call. The verifier checks the ok and error Bash calls in the
  Bash tab, and the denied `Write` call in the Logs tab: status "rejected" (⊘) with its denial text
  or denial-kind tooltip.
  - Why this setup: `--disallowedTools` hides the tool from the model, so the model never calls it
    and no denial is recorded. `--permission-mode auto` depends on the classifier's verdict, so the
    result can change from run to run. The `PermissionDenied` hook event (hook 2.24.0 `tool_use_id`
    and `reason`) fires only for auto-mode classifier denials (`hook/HOW_HOOK_WORKS.md`), so this run
    does not cover it. The run covers the failure path instead: `PostToolUseFailure` with
    `tool_use_id` (the failing Bash call) and the denied call's rejected status.
- FR-7 (S9, background agent, repo `ts-webapp`, owner U1): a session spawns an agent with
  `run_in_background: true`. The prompt tells the main thread to wait for the agent's result and then
  run one more tool call that uses it, so there is main-thread work after the `<task-notification>`.
  The verifier checks that the agent is shown in the session tree and that the work time of the turn
  started by the initial prompt (Summary tab) includes the work done after the notification.
  Timestamps come from the main session transcript JSONL (the run's isolated Claude config):
  start = the initial prompt's user entry, end = the last main-thread (non-sidechain)
  assistant/tool_result entry after the `<task-notification>` user entry. `S9.expected.json` stores
  both timestamps and their difference in seconds; the check passes when the UI work time is at least
  that difference minus 2 s.
- FR-8 (subdirectory cwd and root override — two sessions):
  - S10 (plain subdirectory cwd): a session on `ts-webapp` started from a subdirectory (for example
    `packages/web`), with no `ARTISYN_PROJECT_ROOT`. The session is attributed to `ts-webapp`, and
    paths in the Bash view are relative to the repo root: the prompt runs a Bash command that touches
    a file outside the cwd (e.g. reads `../core/src/index.ts`), and the verifier expects
    `packages/core/src/index.ts`.
  - S11 (`ARTISYN_PROJECT_ROOT` override, hook 2.23.0+): the override matters only when git would
    resolve another root, i.e. in a linked worktree. The run creates a linked worktree of
    `ts-webapp` in the run-dir (`git worktree add`, run in the run-dir copy, never in the git root).
    It copies every install file that is not in git (`.claude/settings*.json`, the `.artisyn/`
    plugin and config including `.artisyn/config/log-hub.local.json`) into the worktree, and starts
    the session from a subdirectory of the worktree with `env.ARTISYN_PROJECT_ROOT` set to the
    worktree path. The verifier checks that the session is attributed to `ts-webapp` and that paths
    in the Bash view are relative to the worktree root (same Bash-touching prompt and expected path as
    S10). Because attribution and relative paths already work in a worktree without the override
    (hook 2.16.0+), the run also checks that the override took effect: after the session,
    `<worktree>/.artisyn/ai_work_dir/` holds S11's telemetry and the main checkout's
    `ts-webapp/.artisyn/ai_work_dir/` does not.
- FR-9: The new sessions follow the existing matrix rules: retry until exercised, isolation check,
  expected params, evidence screenshots, and a report section like S1–S7.
  - The scenario definition gains optional `permissionArgs` (replaces the hardcoded
    `bypassPermissions` when set), `cwdRel` (working subdirectory relative to the repo root) and `env`
    (extra environment variables, e.g. `ARTISYN_PROJECT_ROOT`).
  - New sessions use haiku. Each is added to the `see` / `notSee` lists of the V rows according to
    its owner. Each gets a fixed prompt constant in `scenarios.mjs`, like S1–S7. S10 and S11 get
    `requires.bash: 1`.
  - S1 keeps its "no skill, rule, workflow, MCP, zero subagents" check through an explicit flag
    (`requires: { bash: 1, noHarness: true }`), because `bash` makes its `requires` non-empty.
  - "Exercised" evidence, as new `requires` keys extracted in `extractHarness()` from the local
    transcripts like the existing keys (with `exercisedGap()` updated to match): S8 — a Bash `tool_result`
    with `is_error: true` plus a `Write` `tool_result` that is a permission denial (the denial text or
    the transcript's `toolDenialKind`); S9 — an agent `tool_use` with `run_in_background: true`, then
    a user message with `<task-notification>`, then at least one main-thread `tool_use` after it;
    S10 — the session cwd is not the repo root; S11 — the session cwd is inside the linked worktree
    and not its root, and `ARTISYN_PROJECT_ROOT` was set.

**Checks outside sessions**

- FR-10 (V8, admin): a visibility row for the admin user. Admin's My Repos lists none of the S1–S11
  repos, and opening the S1 session by its direct URL shows no session data once the page has
  loaded (the API answers 403). Team views are not checked: admin is in no team.
- FR-11 (installer config): P5's success check reads `serverUrl` from `log-hub.local.json` (not from
  the tracked `log-hub.json`). After P5, every repo installed from the working-tree installer has
  `serverUrl` and a numeric `otelReceiverPort` in `.artisyn/config/log-hub.local.json`, and the
  tracked `log-hub.json` holds neither. The FR-13 repo is excluded. For the FR-12 repo FR-11 checks
  only that `log-hub.local.json` holds `serverUrl` and a numeric `otelReceiverPort` and that
  `log-hub.json` has no `otelReceiverPort` (its legacy `serverUrl` may stay, FR-12).
- FR-12 (installer upgrade): `java-lib` is seeded with a legacy `log-hub.json`
  `{ "serverUrl": <stand URL>, "otelReceiverPort": 4318 }` (a constant in `lib/config.mjs`), written
  and committed in P3 right after the fixture commit, so it is tracked before P5. Pass rule after
  the installer runs: `otelReceiverPort` is absent from `log-hub.json` and is a number in
  `log-hub.local.json` (a legacy `serverUrl` may stay in `log-hub.json` as a fallback).
- FR-13 (old hook compatibility): a separate extra fixture repo `legacy-hook` (a minimal
  `package.json` plus one JS file under `fixtures/legacy-hook/`, owned by U3, in no team) gets the
  hook from the previous release instead of the working tree. It is kept in its own constant, not in
  `REPOS`: the working-tree P5 install loop and FR-11 skip it. It joins the V rows by owner (U3's
  `see`, every other row's `notSee`, including V8). A short haiku session there with a fixed one-line
  prompt, under the FR-9 retry and isolation rules, is ingested by the new server and shown in the UI
  (model, prompt).
  - Source of the previous-release hook: the run builds the installer tarball (the form users get,
    `npx <server-origin>/static/artisyn-hooks-installer.tgz install`) from a pinned git commit,
    because the repo has no git tags, the installer is not on npm, and `release/` bundles are
    git-ignored and machine-local. The pin is a constant `PREV_RELEASE_REF` in the skill config.
    Its initial value is `25146c8` ("Initial public release": installer `1.0.69`, bundled hook
    `2.21.1`). It is changed by hand when a newer release becomes "previous".
  - Build: export the pinned commit's tree into the run-dir with a read-only git command
    (`git archive <ref>`), never touching the git root or the working tree. Run `npm ci` at the
    export root (that commit's build runs `tsc` from the root `node_modules/.bin`; TypeScript is a
    root devDependency), then run that commit's own `scripts/build-hooks-installer.js
    --static-dir <run-dir>/_prev-hook`, and check that `_prev-hook/installer-version.json` reports
    the expected installer / hook versions (`1.0.69` / `2.21.1` for the initial pin). Install into
    the extra repo with `npx <that tgz> install --server-url <stand> --api-key <U3 key>`.
  - If a step of this pipeline fails for a non-product reason (export, `npm ci`, the old build
    script, `npx` install), the FR-13 row is `fail` with detail `infra: <step>: <error>`, and the rest
    of the run continues.
  - What it checks: hook 2.21.1 is older than 2.22.0, so it sends no harness snapshot, and its
    sessions have no Skills / Agents / MCP / Files / Rules tabs (an accepted exception, see
    `docs/knowledgebase/session-log-view.md`). The verifier checks only that the session is listed,
    plus its model and first prompt. It does not treat the missing System Context tabs as a
    failure.

**Report and docs**

- FR-14: Every new check gets an AC row, report entries (index.md, report.json, evidence screenshots)
  and appears in the FR-10 completeness check of `index.md`.
- FR-15: The KB article `docs/knowledgebase/test/big-prod-e2e-test.md` and the skill description in
  `SKILL.md` are updated: phases, session matrix, V rows, run-dir layout, troubleshooting.

## Non-Functional Requirements

- Keep the added Claude spend and run time small. Prefer cheap models (haiku) for the new sessions and
  verifier extensions over new sessions.
- New verifier steps stay within the verifier's tool budget, or the budget is raised explicitly.
- The isolation guarantees (dev ports, dev DB, `:latest` image, git root untouched) still hold.

## Acceptance Criteria

- [ ] FR-1: an S4 verdict has a field for the Agents table and the agent modal, with screenshot evidence; it fails when the table is missing or a modal tab is empty.
- [ ] FR-2: an S1 verdict has a Bash-tab field with screenshot evidence listing the command, cwd and the repo-relative `tests/calc.test.js`.
- [ ] FR-3: a verdict has a Context Growth step-modal field with screenshot evidence.
- [ ] FR-4: S5 and the chosen skill session have a System Context field that checks the rule/skill and its source; for S5 it also checks the generated `CLAUDE.md` on the Files sub-tab.
- [ ] FR-4a: no fixture source has a CLAUDE.md; P3 writes the generated one only into the run-dir `js-cli`, and the P3 FR-6 row checks that.
- [ ] FR-5: a cost field passes when UI cost and `costUsd` agree within tolerance, fails otherwise, and is `skipped` when `costUsd` is null.
- [ ] FR-6: S8 runs with `--permission-mode default` and the `Read` / `Bash(node:*)` allow list, is retried until both a failed Bash call and a denied `Write` happen, and its verdict checks the error and rejected statuses and the denial text.
- [ ] FR-7: S9 is retried until a background agent and its task-notification happen; its verdict checks the agent in the tree and the work time against `S9.expected.json`.
- [ ] FR-8: S10 runs from a repo subdirectory and S11 from a linked-worktree subdirectory with `ARTISYN_PROJECT_ROOT`; each verdict checks the repo attribution and root-relative paths.
- [ ] FR-10: row V8 is in the report and fails if admin sees any U1–U3 repo or session data.
- [ ] FR-11 / FR-12: AC rows for the local-config and upgrade checks are in the report, with the file contents as detail.
- [ ] FR-13: a session from the previous-release hook, built from `PREV_RELEASE_REF`, is ingested and verified in the UI; the report names the commit and the hook version used.
- [ ] FR-14: `index.md` lists every new session, check and V row, and the FR-10 completeness check covers them.
- [ ] FR-15: the KB article and SKILL.md describe the new phases, sessions and rows.
- [ ] `npm run test:scripts` passes, including any new helper-lib tests in `scripts/__tests__/big-prod-e2e-test.test.js`.
- [ ] One full `/big-prod-e2e-test` run passes, or every failure is classified as a product defect or an infrastructure failure and reported.

## Common sense considerations

- Priority: medium.
- FR-1 checks rows `1..N` of the existing 2-agent workflow; the fixture workflow gets no nested agents.
- FR-2 is carried by S1 with an explicit `node --test tests/calc.test.js` and `requires.bash: 1`.
- FR-4: the verifier is given the exact path — Logs tab → System Context panel → Rules / Skills / Files sub-tabs.
- FR-4a: the CLAUDE.md is generated in the run-dir `js-cli` only; fixtures stay CLAUDE.md-free.
- FR-5: cost comes from the session stream's final `result` event, is compared with the "Telemetry total" under the `costMismatch()` tolerance; null cost or no Telemetry row → skipped.
- New sessions get scenario fields `permissionArgs`, `cwdRel`, `env`, fixed prompt constants, use haiku, and join the V rows by owner.
- "Exercised" evidence for S8–S11 is extracted in `extractHarness()` from transcripts; S1 keeps its no-harness check via `noHarness: true`.
- S8 → `js-cli` (U2), S9 → `ts-webapp` (U1); `node-service` (FC_REPO) gets no new sessions.
- S9 work time: turn of the initial prompt, timestamps from the main transcript JSONL, both stored in `S9.expected.json`.
- S10/S11: `requires.bash: 1`, a Bash command touching `../core/src/index.ts`; expected path `packages/core/src/index.ts`.
- S11 proves the override by the `ai_work_dir` location; the worktree gets every non-git install file.
- FR-12 seed: `java-lib`, constant legacy `log-hub.json` with `serverUrl` + `otelReceiverPort`, committed in P3.
- FR-11 for the FR-12 repo checks `log-hub.local.json` and the absence of `otelReceiverPort` in `log-hub.json` only.
- FR-13 repo: `legacy-hook`, owner U3, no team, own constant outside `REPOS`, joins V rows by owner.
- FR-13 build: `npm ci` at the export root, version check on `installer-version.json`; pipeline failures are `infra:` fails, run continues.
- S8: `--permission-mode default` + allow list `Read`, `Bash(node:*)`; the denied call is a `Write`; the Bash tab shows the ok/error Bash calls; the denied call's rejected status and denial text are checked in Logs. The auto-mode-only `PermissionDenied` hook event is not covered.
- S10 = plain subdirectory cwd; S11 = linked worktree + `ARTISYN_PROJECT_ROOT`.
- S9 work time is compared with the post-notification end time from `S9.expected.json`, 2 s slack.
- P5 reads `serverUrl` from `log-hub.local.json`; FR-12 asserts only that `otelReceiverPort` moves.
- FR-13: previous-release hook = installer tarball built from the pinned commit `PREV_RELEASE_REF` (initially `25146c8`, hook 2.21.1) exported with `git archive` into the run-dir.
- V8 opens the S1 session URL; pass = no session data after load (API 403); team views are not checked.

## Open Questions

- S8's denied `Write`: under `claude -p --permission-mode default --allowedTools Read "Bash(node:*)"` the denial text is "Claude requested permissions to write to <path>, but you haven't granted it yet". The UI marks a call rejected (⊘) only when the transcript line has a `toolDenialKind` or the error text contains "requested permissions to use" (`tool-outcome.ts`), so this denial may show as `✗ error`. If a PoC shows no `toolDenialKind` is recorded, which way: (a) treat it as a product defect — the UI should show any permission denial as rejected, and S8 keeps the `Write`; or (b) change S8's denied call to a Bash command outside the allow list (e.g. `git status`, whose text matches the marker) and keep the UI as is?

## Notes

- Origin: a gap review of the skill against the commits since 2026-10-20 (session of 2026-10-23).
