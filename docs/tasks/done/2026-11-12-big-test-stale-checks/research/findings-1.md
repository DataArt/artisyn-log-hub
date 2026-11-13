I found every piece the plan needs: all six failures trace to known lines, and the matching UI hooks (test ids, attributes, labels) are confirmed in the client code. No product code needs to change. The plan has to settle two things the requirements do not cover: the verifier call budgets for the longer checks, and one existing build-script test that the S5 rewrite breaks.

## Requirements summary
GH-138 fixes test-script defects in `/big-prod-e2e-test` (run `20261112-090440`, FAIL with exit 1, no product defects):
- **FR-1:** the P5c Node LTS container must also get `docs/algorithm-examples/`.
- **FR-2:** drop the P11 "no new path in the git root" check, along with its P0 baseline, `gitStatusPaths`, `AC_PHASES['FR-3']` → `['P0']`, and the KB line.
- **FR-3:** rewrite `systemContext.md` for the Anatomy tab (`&tab=sysctx`, clicks on partition rows, "Show all", skill and file-row matching).
- **FR-4:** rewrite the S2 and S5 `expect.sysctx` blocks in Anatomy terms.
- **FR-5:** `bashTab.md` reads the badge in the detail pane: `✓ ok` means ok, `✗ error` means error, a permission prefix is allowed.
- **FR-6:** `denied.md` opens the call and reads the `tool-call-view` badge for `⊘ rejected`, plus the existing second condition (result text or label title).
- **FR-7:** sweep for any other selector still pointing at the removed `sysctx-panel`.
- **Done when:** a re-run exits 0 and the KB article matches the new checks.

## Wireframes
None referenced.

## Knowledgebase
- `docs/knowledgebase/test/big-prod-e2e-test.md` is the article to update:
  - line 81: the P11 row says "no new path in the git root". Remove that phrase only; P11 keeps dev ports and `index.md`.
  - line 74: the P5c row says "the hook algorithm tests". It could name the copied directories.
  - lines 114, 117, 118: the check table rows for `bashTab` ("status (`✗ error`)"), `systemContext` ("rules / skills / files tabs") and `denied`.
  - lines 296-301 and 313-317: troubleshooting for `FR-NODE` and for the S8 denial.
  - line 27: the helper libs' unit tests are `scripts/__tests__/big-prod-e2e-test.test.js`, run by `npm run test:scripts`.
- `docs/knowledgebase/sysctx-anatomy-tab.md` is the UI contract for the tab:
  - tab id `sysctx`. Clicking a partition row selects and expands it. The expand is add-only, so clicking an open row again keeps it open (`SessionSysctxAnatomyTab.tsx:188-201`); the chevron button toggles it.
  - the skills drill-down shows the first 10 rows (`SKILLS_PREVIEW = 10`, `sysctx-anatomy-constants.ts:157`), then a "Show all N skills" toggle.
  - the files drill-down has an "On demand — 0 at start" subgroup.
  - test-id table at lines 230-250.
- `docs/knowledgebase/algorithms/sysctx-anatomy.md:142-150` (rule 16): file rows are startup `instructions` files plus snapshot `systemContext.files`. A snapshot file with no match becomes an on-demand row. `fileKind` comes from `classifyInstructionRole`. Display paths are repo-relative, and user files show as `~/.claude/...`.
- `docs/knowledgebase/session-log-view.md:30,34,646-649`: clicking a file row on Logs opens `ToolCallDetailModal`, which wraps `ToolCallView`. Tool rows use `StatusBadge` with `showOk`.
- `docs/knowledgebase/algorithms/README.md`: algorithm rows live in `docs/algorithm-examples/<name>.json`.

## Existing patterns

**FR-1 (Node LTS tarball)**
- `.claude/skills/big-prod-e2e-test/scripts/lib/node-lts.mjs:74-76`: the tar list is `./hook ./scripts/algo-docs ./docs/knowledgebase/algorithms`. Add `./docs/algorithm-examples`.
- The doc comment at line 72 should be updated to match.
- Keep `docs/knowledgebase/algorithms`. `scripts/algo-docs/load-examples.cjs:41-49` finds the repo root by `.git` first, and the tarball has none, so it falls back to looking for `docs/knowledgebase/algorithms/`. It then reads `docs/algorithm-examples/<name>.json` (line 188).
- All 11 hook test files require only `../../../../scripts/algo-docs/load-examples.cjs` from outside `hook/`. Nothing else is needed.
- Evidence: `_state/node-lts.json` shows `tests 11, fail 10` on 18.19.0, 22, 24 and 26.

**FR-2 (git-root check)**
- `scripts/run.mjs:50`: `'FR-3': ['P0', 'P11']` becomes `['P0']`.
- `run.mjs:124`: `gitStatusBefore: null` in `ctx` goes.
- `run.mjs:186-190`: `gitStatusPaths()` goes.
- `run.mjs:221`: the baseline assignment goes.
- `run.mjs:906-913`: the P11 FR-3 block goes. The rest of `p11Final` (FR-4 dev ports, FR-10 `index.md`) stays.
- `run.mjs:16` imports `{ run, runAsync }`. Its only `run(` call is in `gitStatusPaths` (line 187), so `run` becomes an unused import and should be dropped.
- `run.mjs:238`: the P0 FR-3 check stays.
- `SKILL.md`: line 24 lists P11 only as a phase name and line 25 says "`FR-2` … `FR-11`". There is no git-root text, so no SKILL.md change is needed.

**FR-3 / FR-4 (Anatomy tab check)**
- `scripts/prompts/checks/systemContext.md`: the whole file needs rewriting, in the `## Step / ## Judge / ## Fields` format that `verify.mjs:126-140` `parseFragment` requires.
- `scripts/scenarios.mjs:94`: S2 `sysctx: { rules: [], skills: [{name:'add-jsdoc',source:'project'}], files: [] }`.
- `scenarios.mjs:128`: S5 `sysctx: { rules: ['cli-flags'], skills: [], files: [{ name:'CLAUDE.md', type:'Project' }] }`.
- `scenarios.mjs:27-28`: the header comment that lists the `expect` keys.
- `scripts/lib/verify.mjs:48`: `systemContext: check(['systemContext'], ['sysctx.png'], 7, ['sysctx'])`. The `sysctx` key and the `sysctx.png` shot stay; the budget is 7 calls.
- Client test ids (no client change needed):
  - `AnatomyPartitionTable.tsx:153-156`: `anatomy-partition-row` with `data-kind` (`skills`, `instruction-file`), selected on click.
  - `AnatomyDrilldowns.tsx:52-54`: `anatomy-skill-row` with `data-skill-name` and `data-source` (`project`, `user`, `plugin`, …).
  - `AnatomyDrilldowns.tsx:69-75` and `AnatomyCells.tsx:146`: the toggle text is `Show all ${total} skills`.
  - `AnatomyDrilldowns.tsx:84-91`: `anatomy-file-row` with `data-path` and `data-git`. The second `td` is the Kind cell (`r.fileKind`). Columns: Path, Kind, Git, File size, Loaded B, ≈ Tokens, Share.
  - `AnatomyDrilldowns.tsx:120-133`: the "On demand — 0 at start" header row.
- `client/.../session-log/instruction-files.ts:22-32`: `classifyInstructionRole` returns `rule` for any path containing `.claude/rules/`, `user-md` for type user, `local-md` for `CLAUDE.local.md`, and `claude-md` otherwise.
- `tests/scenarios/view/s-sess-03.spec.ts:445-533` is the model for navigation and matching. It opens with `{ tab: 'sysctx' }`, clicks `row('skills')`, reads `data-path`, and expects paths such as `'CLAUDE.md'`, `'~/.claude/CLAUDE.md'` and `'.claude/rules/db.md'`. The suffix `CLAUDE.md` alone also matches `~/.claude/CLAUDE.md`, so the Kind check is needed.
- Fixtures behind the S5 expectations:
  - the S5 `CLAUDE.md` is generated into the js-cli run copy (`lib/config.mjs:167-169`, `CLAUDE_MD_REPO = 'js-cli'`).
  - the rule comes from `fixtures/js-cli/dot-claude/rules/cli-flags.md` (`paths: ["lib/**/*.js"]`), copied to `.claude/rules/cli-flags.md` (`lib/repos.mjs`).

**FR-5 (Bash tab badge)**
- `scripts/prompts/checks/bashTab.md:4` and `:10`(b) are the lines that need changing.
- `client/.../bash-tab/BashCallList.tsx:95`: the `bash-call-row` list item shows only `StatusMark` (`tool-status-mark`), never `tool-status-badge`.
- `bash-tab/SessionBashTab.tsx:67-98`: the `bash-call-details` pane renders `ToolCallView`. `tool-call-view/ToolCallView.tsx:96,116` renders `<StatusBadge showOk/>` inside `data-testid="tool-call-view"`.
- `tool-call-view/StatusBadge.tsx:42-111`: `tool-status-badge` is an outer span holding an optional `⚠ denied` / `⚠ requested` span followed by the status (`✗ error`, `⊘ rejected` with a `title`, `⏸ interrupted`, `output not captured`, `⧗ background`, `✓ ok`).
- Selector to use: `[data-testid="bash-call-details"] [data-testid="tool-status-badge"]`.
- `verify.mjs:45`: the `bashTab` budget is 5.

**FR-6 (denied call)**
- `scripts/prompts/checks/denied.md` needs the step and judge rewritten.
- `client/.../session-log/prompt-turn-helpers.tsx:234-272`: the Logs `file-row` (`data-tool-use-id`) shows `StatusMark` `⊘` plus a `StatusBadge` forced to `status:'success'`, so only permission flags appear. Clicking it calls `onOpen(call)`, which opens `ToolCallDetailModal.tsx:23-53` (a Dialog around `ToolCallView`).
- The Write call is listed in the turn's Files section under "Code" (`PromptTurnItem.tsx:211-216`).
- `StatusBadge.tsx:8-12`: the title for `user-rejected` is "rejected by the user", so the "title non-empty" half of the existing condition can be met.
- `verify.mjs:49`: the `denied` budget is 4.
- `scenarios.mjs:174`: S8 `expect.denied = { tool, target, status:'rejected' }`. Unchanged.

**FR-7 (other sysctx-panel selectors)**
- A grep of `.claude/skills/big-prod-e2e-test/**` (all check prompts, `verify-session.md`, the libs, `run.mjs`) finds `sysctx-panel` and `sysctx-tab-*` only in `checks/systemContext.md`.
- Elsewhere they appear only in `docs/pocs/2026-10-27-1950-okf-analysis-cost/out-runs/...`, which are historical outputs to leave alone.

**Build-script tests touched (existing file, not a new test)**
- `scripts/__tests__/big-prod-e2e-test.test.js:833`: `assert.deepEqual(byId.S5.expect.sysctx.rules, ['cli-flags'])` breaks under FR-4. Change it to the new shape (`[{ pathSuffix: '.claude/rules/cli-flags.md', kind: 'rule' }]`) and possibly assert the S2 skills and S5 files too.
- `:997-1020`: `verifierCallBudget` asserts S1 = 40 (it includes `bashTab`), S4 = 36 and L1 = 14. If the `bashTab` budget changes, S1's expected 40 changes by the same delta. S2, S5 and S8 budgets are not asserted.
- `:1408-1450`: the node-lts tests cover only `liveLtsLines`, `nodeTags` and `judgeNodeMatrix`. The tar command is untested.
- Run them with `npm run test:scripts` (root).

## Open gaps
1. **Verifier call budgets.** The new `systemContext` flow (navigate, snapshot, click Skills, maybe "Show all", click Instruction files, snapshot or evaluate) may not fit in 7 calls. The new `denied` flow (navigate, find the row in Files, click it to open the modal, read the badge and title, read the result) is likely tight at 4. The plan must decide whether to raise them in `verify.mjs:48-49`. The S1 budget test is unaffected unless `bashTab` (5) changes.
2. **New `sysctx` shape.** The requirements give only the S2 and S5 values. The plan must fix the exact keys (`skills: [{name, source}]`, `files: [{pathSuffix, kind}]`, `rules: [{pathSuffix, kind}]`), decide whether empty lists stay or are omitted, and mirror the keys in the Judge and Fields sections and the scenarios.mjs header comment.
3. **Rule may be missing from both groups.** The on-demand row exists only when the hook's harness snapshot lists `.claude/rules/cli-flags.md`. If it does not, the rule appears in neither group. That would be a real failure, but the plan may want troubleshooting text for it in the KB.
4. **Turn layout for FR-6.** No existing check prompt opens a Logs file row into the modal, so the step wording (find the `file-row` whose text has `denied.txt`, click it, then read the selector inside the dialog) is written from scratch. Whether the turn and its Files section are expanded by default was not checked.
5. **Screenshot wording.** The `{{SHOT_SYSCTX}}` text must now describe the open Anatomy drill-downs, and `{{SHOT_DENIED}}` the open modal.
