# New test suite: ~150 human-readable blocks instead of ~4260

This is the target picture after the owner's decision: nobody will meaningfully maintain thousands of tests; 100–200 is maintainable. So the suite is built from **large multi-step stories**, each of which can be read, repeated by hand (in a browser or with `curl`) and checked against concrete numbers. The old tests are replaced rather than cleaned up one by one (the test-by-test cleanup plan from the earlier test audit remained the fallback if the replacement did not work out; that audit has since been deleted, for the current test setup see [KB test](../knowledgebase/test/index.md)).

Basis: four scenario design documents and three layer design documents in [scenarios/](scenarios/). All of this is a design, not finished code: the scenarios have not been run, and some of the numbers and steps are taken from the code and old tests and need checking during implementation.

## Accepted (2026-10-13)

**Target suite size: about 400 tests** (instead of ~4260 now). This is a fixed reference point; the figures will be refined as implementation proceeds.

| Composition | Tests |
|---|---|
| Scenarios (111: P0 56, P1 48, P2 7) | 111 |
| API vs DB contracts (table-driven, by family) | ~27 |
| Tab tours by role | 10 |
| Corpus of real sessions (table tests) | ~5 |
| Algorithm units (35 algorithms, ~30 documents): P0 ~110, together with P1 ~240 | ~240 |
| **Total** | **~390–400** |

Additionally, not counted: the monthly live corpus run and the doc audit via `claude -p` (both are pipelines, run by hand).

Decisions made: full data capture is deliberate; the data-collection consent blocks only the UI; mode 2 issues a session after signup, mode 3 must not (the current code violates this, the defect is recorded); three runs by auth mode, plus Mailpit; the doc audit runs on a machine where Claude Code is already logged in, and stops without it; unit tests only for documented and reviewed algorithms (`14-algorithm-units.md`). See the decisions below in the "Owner's decisions" section (struck-through items are closed).

The rollout order has not changed (below): the runner and the stand come first.

## Suite composition

| Layer | What it is | Tests | Design |
|---|---|---|---|
| **Scenarios** | Stories of 5–15 steps through the UI, the API or the hook/installer processes, with concrete expected numbers | **111** (P0 — 56, P1 — 48, P2 — 7) | [01 auth and access](scenarios/01-auth-access-admin.md) (27), [02 repositories and sessions](scenarios/02-repos-sessions.md) (26), [03 session view, reports, cost](scenarios/03-session-view-reports-golden.md) (30), [04 log ingest, hook, installer, platform](scenarios/04-ingest-hook-installer-platform.md) (28) |
| **Group 1: API vs DB** | Every endpoint is called, and the response is checked against an independent SQL query on the same test DB; for writes, before and after. A registry table, and a meta-test fails when an endpoint appears in the router without a row | **~27** (`it.each` over 23 families; 130 endpoints, ~230–260 registry rows) | [05](scenarios/05-api-db-contract.md) |
| **Group 2: tab walk** | Large tours by role (admin, repo owner, member, outsider, login pages, session details with all tabs, help), the list of screens in a registry, a meta-test for missed screens | **10** (~104 registry rows, ~98 screens, 1.5–3 min) | [06](scenarios/06-ui-tab-walk.md) |
| **Group 3: doc check via `claude -p`** | A screenshot of a screen and an excerpt from the docs are sent to `claude -p`: "is this it? are there mismatches or anything new?". This is an **audit with a report**, run by hand | 1 pipeline, ~56 screens, ~$0.07 per screen, $6–12 per full run | 07, the LLM doc audit design, since deleted (see [KB test](../knowledgebase/test/index.md)) |
| **Corpus of real sessions** | Real recorded sessions per Claude Code version are kept in the repository, and old versions are checked for not being broken; once a month a live generation of a new full set on the latest Claude Code version in an isolated environment, a run, and freezing after a human review | **~5 table tests** + 1 monthly pipeline, run by hand | [08](scenarios/08-session-corpus.md) |
| **Algorithm units** | Unit tests stay only for well-understood algorithms; each has its own documentation with worked examples (the table rows are the test cases) and a separate review that the tests make sense | ~125 tests in ~10 table files (an estimate, to be refined) | [14](14-algorithm-units.md) |
| **Total automated tests** | | **~153 + ~240 units ≈ 400** (111 + 27 + 10 + 5, plus the P0 and P1 algorithm units; P0 only: ~265) | |

Pure-logic units that scenarios do not replace are kept as the "algorithm layer" (about 100 for auth: backoff, password policy, config validator, localhost and container detection; ~25 for the hook: worker backoff, line-count parity, the NDJSON broken-line threshold, and others found in the [14](14-algorithm-units.md) registry). They are packed into table files, one per documented algorithm. To fit into 200, some can be moved into run-B scenarios or deleted (the owner's decision).

## "Golden" sessions instead of thousands of unit tests

The log parser, cost, tokens, work time, change-surface, cache ratio, harness usage and context are checked today by ~2000 unit tests. Instead of them (design in [scenarios/03](scenarios/03-session-view-reports-golden.md)):

- **9 hand-written realistic session fixtures** (10 root sessions; one is generated): a simple one, a delegator with sub-agents 3 levels deep, context compaction, skills/rules/MCP/workflow, 5m and 1h cache, several models, edits in different folders for change-surface, sidechain and tool refusals, Windows paths.
- For each, a **table of expected numbers** is computed (cost, tokens by type, work time, call count, lines, change-surface score, cache ratio).
- The scenario loads the session and checks the numbers both in the API response and on screen. One test checks what dozens used to check.
- What is lost: rare edge cases of the parser and the formulas; every scenario has a "What we lose" item that lists them honestly.

**Addition: real sessions per version.** The hand-written golden sessions (above) give exact numbers computed by hand, but they are synthetic. On top of them comes a corpus of real recorded sessions ([08](scenarios/08-session-corpus.md)): a set per Claude Code version is frozen in the repository and run as a regression (old log versions must not break), and once a month a fresh full set is generated on the latest version (several repositories, several scenarios, an isolated environment; the owner's generation skill is not committed yet). The reference for real sessions is built from a snapshot of API responses, an independent invariant oracle and the scenario's structural expectations. A side benefit: a format drift detector and a "what is new in Claude Code logs" report.

## What gets replaced (with a caveat)

The numbers of replaced old tests claimed by the groups: auth and access ~650–700, repositories and sessions ~400–450, session view and cost ~1550 of ~1990, log ingest and hook ~860, API vs DB ~430–460, tab walk ~40 e2e and ~30 component. **These numbers overlap and must not be added up** (the sum is more than 4260). A realistic estimate: the scenarios and the contract suite make about **85–90%** of the old ~4260 tests redundant; the remaining 10–15% are the units left above and deliberately dropped cases (the "Not covered by scenarios" section in each design document).

## What is needed from the infrastructure

Without this some scenarios are impossible ([04](scenarios/04-ingest-hook-installer-platform.md), [01](scenarios/01-auth-access-admin.md), [05](scenarios/05-api-db-contract.md)):

1. **The runner brings up its own server and built client** on separate ports with an isolated DB schema, so the suite runs on a clean checkout. Today e2e runs against someone else's dev server and a shared DB, and `global-setup` fails on a clean DB.
2. **Several runs by auth mode:** A (`AUTH_MODE=none`), B (`password-confirm`, Mailpit, `PASSWORD_POLICY=long`, `NODE_ENV` not `test`), C (password). Some scenarios work in any mode, some only in B (emails, backoff).
3. **One runner** (Playwright handles the browser, the API and child processes), one command `test:scenarios`, everything else is launched from it.
4. **Frozen old hooks by git tag**, otherwise backward compatibility (the `S-COMPAT` scenarios) cannot be proven.
5. **Small client changes:** export the tab constants and add `data-testid` to the tabs (for the tab-walk meta-test).
6. A helper that shifts dates in the DB and a fast scheduler tick for retention (or one jest test as an exception).

## Rollout order

1. The runner and the isolated stand (items 1–3 above). Nothing else starts without it.
2. Golden sessions and tables of expected numbers (the figures in GS-08 and GS-09 need checking against real behaviour during the build).
3. **P0 only first: 56 scenarios** plus the contract suite and the 10 tours. This is the minimum that covers security, privacy, data loss and the main numbers.
4. P1 and P2 as capacity allows.
5. Group 3 (doc audit) as a separate pipeline; after the first run, fix the mismatches in the docs or accept them as the baseline.
6. **Delete old tests only by the "Replaces" table** and only after a green run of the new scenario. Before deleting, compare the code coverage of the old and the new suite (and, for critical modules, mutation testing): code coverage was not measured in this session.
7. In parallel: remove internal data from the tests (phase 1 of the test-by-test cleanup plan from the earlier, since deleted, test audit; see [KB test](../knowledgebase/test/index.md)), fix how hook and installer are launched.

Only the contract suite has an effort estimate: 19–25 person-days. There are no estimates for the other layers.

## Owner's decisions

1. **Privacy:** full data capture, including `tool_input`, is deliberate (recorded in the [KB](../knowledgebase/product-purpose-and-data-capture.md)); the privacy scenarios check who sees the data, not that fields are stripped.
2. Does **Token Flow** ship? It is hidden behind the `VITE_ENABLE_TOKEN_FLOW` flag and has no scenarios; the tab walk proposes a build-dependent row.
3. ~~Signup of an unconfirmed account immediately gives a live session~~ **Decided.** Mode 2 (`password`, closed networks): a session after signup is normal. Mode 3 (`password-confirm`): the user must not get a login until they confirm their e-mail; they only see the "check your e-mail" page. **In the code this is a defect:** `AuthController.signup` calls `req.logIn` for every mode, and the session never checks the e-mail confirmation (`emailConfirmedAt` is checked only in `local.strategy.ts` at login). Whether to fix it in the code is the owner's call; the `S-AUTH-01` scenario must stay red until it is fixed. The existing tests do not pin this defect: `auth-email-confirmation.e2e-spec` checks only the DB row and does not touch the session.
4. ~~The data-collection consent blocks only the UI, the server does not block the API~~ **Decided: this is by design** (whoever calls the API around the UI deliberately bypasses the consent too). Scenarios must not require server-side blocking; recorded in the KB.
5. **The legacy route `PATCH /api/v1/users/:id/role`**: is it needed (a duplicate of `/admin/users/:id/role`)?
6. ~~Do you agree to three runs by auth mode (A/B/C) and Mailpit?~~ **Decided: yes, OK at this stage.**
7. Does the new hook need a fallback to `/api/v1/logs` if the server answers 404 on v2?
8. Keep the ~125 exception units (or move some into scenarios/delete them)?
9. Allow small client changes (`data-testid`, exporting the tab constants)?
10. SSO (Azure): out of scope, or is a fake OIDC needed?
11. Doc audit via `claude -p`: **decided** to assume that Claude Code is already installed and logged in on the machine that runs it; if not, the audit stops with a clear error (a stop, not a skip). Still open: the model, the mode (the design defaults to report only), whether to fix the docs before the first run or accept them as the baseline, and whether to include the API audit.
12. The work time documentation disagrees with the code: what counts as the truth (needed for the golden sessions).
13. How to seed attribution: through the public API or by writing straight to the DB; whether lines of a file outside the repository count in change-surface.
14. What a team member sees on the hook state page of someone else's repo.
15. **Corpus of real sessions** ([08](scenarios/08-session-corpus.md)): where the generation skill lives (in this repository or a separate one; you have it on another machine and it is not committed, at least its interface is needed), the storage policy (`.gz`, one format epoch plus two months, LFS or a separate repository), how many repositories and scenarios per month, whether publishing transcripts is acceptable, whether a Windows repository is needed.
16. **Algorithm units** ([14](14-algorithm-units.md)): the format of the algorithm documentation, who reviews for meaningfulness (a human, an AI or both), where the documents are kept.

## Scenario index (generated from the design files)

The ids are made unique (impl-plan of the task `2026-10-14-qaa-test-suite-cleanup`, DD SC2): in file 02, `S-SESS-NN` were renamed to `S-SLIFE-NN` (session life) and `S-HOOK-NN` to `S-HSTATE-NN` (hook state); files 03 and 04 keep `S-SESS-NN` and `S-HOOK-NN`.


### File 01: auth-access-admin

| ID | Story | Layer | Priority |
|---|---|---|---|
| S-AUTH-01 | A new person signs up, confirms the e-mail from the message and logs in | UI+API | P0 |
| S-AUTH-02 | First login: the data-collection consent screen cannot be bypassed | UI+API | P0 |
| S-AUTH-03 | Login, logout, a live and a dead session, form errors, password policy | UI+API | P0 |
| S-AUTH-04 | Forgot password: the e-mail, a new password, repeated and expired links | UI+API | P0 |
| S-AUTH-05 | A password change in one browser logs out the second one | UI+API | P0 |
| S-AUTH-06 | Password guessing runs into a growing delay | API | P0 |
| S-AUTH-07 | Mode matrix: what exists in this mode and what answers 404 | API | P0 |
| S-AUTH-08 | Passwordless mode: local login, auto-creation, the first user becomes admin | UI+API | P1 |
| S-AUTH-09 | A person deletes their account, and everything of theirs goes, while other people's data stays | UI+API | P0 |
| S-KEY-01 | API key life: create, see once, upload logs, revoke, expired | UI+API | P0 |
| S-KEY-02 | A newcomer with no keys: install, "Give Me String", the left menu | UI | P1 |
| S-TEAM-01 | An owner creates a team and invites a colleague, the colleague accepts through the bell | UI+API | P0 |
| S-TEAM-02 | A `restricted` team: who sees what (member, owner, trainer, manager) | UI+API | P0 |
| S-TEAM-03 | A `transparent` team: everyone sees everyone, raw logs are still closed, a lock on switching | UI+API | P0 |
| S-TEAM-04 | Inviting an unregistered e-mail and the disclosure gate at the first login | UI+API | P0 |
| S-TEAM-05 | Roles, delegated invitation, leaving, ownership transfer, team deletion | UI+API | P1 |
| S-TEAM-06 | Team repositories: add, duplicate, remove, a shared URL is not lost | UI+API | P1 |
| S-TEAM-07 | The application admin and someone else's team: what they can and cannot do | UI+API | P1 |
| S-ACC-01 | Someone else's personal repository is closed, and route guarding does not depend on the credential type | API | P0 |
| S-ADM-01 | The admin panel is visible only to an admin, the tabs and deep links work | UI+API | P0 |
| S-ADM-02 | An admin manages users: role, reset link, e-mail change, deletion | UI+API | P0 |
| S-ADM-03 | Unconfirmed signups and the Auth tab (password-confirm mode) | UI+API | P1 |
| S-ADM-04 | The Repos and Teams tabs: numbers, filter, sorting, repository deletion | UI+API | P1 |
| S-ADM-05 | System Info, the log archive and the error log | UI+API | P1 |
| S-ADM-06 | Data Retention: the retention period matches the consent text, a chart with an empty day | UI+API | P1 |
| S-ADM-07 | Upload queue: a broken file, Reprocess, Clear, counters | UI+API | P1 |
| S-ADM-08 | Releases: a signed link, a forgery, an expired one, and the public installer | UI+API | P1 |

### File 02: repos-sessions

| ID | Story | Layer | Priority |
|---|---|---|---|
| S-REPO-01 | One project uploaded with different remote URLs shows up as one repository | API | P0 |
| S-REPO-02 | The left panel shows personal and team repositories, and you can navigate them | UI | P1 |
| S-REPO-03 | The repo summary is correct, and someone else's repo is off limits | API | P0 |
| S-REPO-04 | Deep link and hash router: a session link survives a reload, an unknown route goes to main | UI | P1 |
| S-REPO-05 | Until the user agrees to data collection, they see neither the application nor the repositories | UI+API | P0 |
| S-REPO-06 | Custom file categories: added, seen in the session and in analytics, deleted, bad values are rejected | UI+API | P1 |
| S-REPO-07 | Team settings apply to all its members, and personal ones override them; a non-owner of the team cannot write | API | P0 |
| S-REPO-08 | Analysis and attribute settings: the cache threshold survives a reload, bad values are rejected, a non-owner sees read-only | UI+API | P2 |
| S-REPO-09 | The owner exports the repo to a zip and imports the archive into another repo through the UI | UI | P0 |
| S-REPO-10 | Export by date range and by selected sessions returns exactly the right sessions; broken archives are rejected | API | P1 |
| S-REPO-11 | Import: a session conflict is resolved by "the longer one wins"; a bootstrap import creates the repo and the team | API | P0 |
| S-REPO-12 | Export and import are forbidden to non-owners | API | P0 |
| S-REPO-13 | Statistical session export and "Recompute all sessions" | UI+API | P2 |
| S-SLIFE-01 | A repo's session list: order, fields, hidden sessions, grouping, a new session appearing | UI+API | P1 |
| S-SLIFE-02 | Branches: the numbers in the selector match the list, an empty branch is visible, the filter narrows | UI+API | P1 |
| S-SLIFE-03 | In a personal repo the default is "my sessions"; hook sessions can be hidden; a banner says what is hidden | UI | P1 |
| S-SLIFE-04 | The session attribute filter narrows the list and the counters | API+UI | P2 |
| S-SLIFE-05 | Favourites: the star, a reload, isolation between users, the team route | UI+API | P1 |
| S-SLIFE-06 | The owner deletes their session from the interface, someone else cannot, a repeated upload is ignored | UI+API | P0 |
| S-SLIFE-07 | Deleting a root session removes the sub-agent and grandchildren, their data and orphaned contexts | API | P0 |
| S-SLIFE-08 | Automatic deletion by age (retention): an old session disappears together with its tree, a young and an already deleted one are not touched | API | P0 |
| S-SLIFE-09 | Session metrics are computed over the whole agent tree, not just the root | UI+API | P0 |
| S-SLIFE-10 | What team members see: transparent shows sessions, restricted only their own; raw logs always only to the owner | API | P0 |
| S-HSTATE-01 | The user has an installed hook: the "Installed Hooks" menu, issues, the state page and the upgrade command | UI+API | P1 |
| S-HSTATE-02 | After a hook upgrade the problems disappear; an upload without a status does not erase them | API+UI | P1 |
| S-HSTATE-03 | Hook state does not leak to others and returns clear errors | API | P0 |

### File 03: session-view-reports-golden

| ID | Story | Layer | Priority |
|---|---|---|---|
| S-SESS-01 | A simple session: Summary, Info and Statistics show the same numbers as the API | UI+API | P0 |
| S-SESS-02 | Session tabs: deep link, garbage in the URL, a session without a transcript, tab permissions | UI | P1 |
| S-SESS-03 | Logs: what counts as a prompt, what is hidden, how a turn reads | UI+API | P0 |
| S-SESS-04 | A delegator with sub-agents 3 levels deep: nesting and cost over the tree | UI+API | P0 |
| S-SESS-05 | Context compaction and the ceiling: Context Growth, the Summary detectors | UI | P1 |
| S-SESS-06 | Skills, rules, MCP and workflow in Logs and Info | UI | P1 |
| S-SESS-07 | Harness usage: the session tree, counters, slash commands | UI | P1 |
| S-SESS-08 | Statistics: refusals and unresolved calls, deduplication, sidechain | UI+API | P1 |
| S-SESS-09 | Change surface of a Windows session: a scattered edit, a file outside the repo, three warnings | UI+API | P0 |
| S-SESS-10 | Change surface: a focused edit and merging files over the tree | UI+API | P1 |
| S-SESS-11 | Change surface on 400 files: filter, collapsing, sorting | UI+API | P1 |
| S-SESS-12 | Raw Logs are visible only to the owner; the API answers 403 to anyone else | UI+API | P0 |
| S-SESS-13 | Advisor: the hook's result appears as a tab and as spend | UI+API | P1 |
| S-CHART-01 | Charts: Dashboard, Agent Tree, Timeline, Tool Heatmap, Call Tree on an agent tree | UI | P1 |
| S-CHART-02 | Charts: Context Usage and Context Growth count the same tokens | UI | P1 |
| S-COST-01 | One session, one cost everywhere | UI+API | P0 |
| S-COST-02 | 5m and 1h cache, fast mode, web search: the price by formula | UI+API | P0 |
| S-COST-03 | First model, unknown model, public prices | UI+API | P0 |
| S-COST-04 | Cost from OTEL vs the computed one | UI+API | P2 |
| S-ANLT-01 | Analytics: timeline, cost, work time on the golden repository | UI+API | P0 |
| S-ANLT-02 | Analytics: tokens, tools, productivity counters, active sessions | UI+API | P1 |
| S-ANLT-03 | Analytics: productivity, files, cache ratio, the horizontal view and state in the URL | UI | P1 |
| S-REPT-01 | Executive Summary: totals, filters, period, PDF | UI+API | P0 |
| S-REPT-02 | Cache Read Ratio: a ratio of sums, the "root / with descendants" pair, reasons, threshold | UI+API | P0 |
| S-REPT-03 | The Tool Analytics, Token Usage, Productivity Counters and Active Sessions reports equal the Analytics views | UI+API | P1 |
| S-REPT-04 | Harness Usage report: inventory vs usage | UI+API | P1 |
| S-REPT-05 | Change Surface: the Analytics chart and the report give the same numbers | UI+API | P1 |
| S-REPT-06 | Claude Code versions: outdated sessions | UI+API | P2 |
| S-REPT-07 | Session attributes: filter, Attribute Breakdown, Extraction Usage, Advisor tiles | UI+API | P2 |
| S-REPT-08 | The reports shell: all 17 reports open, the URL lives, the PDF is not empty | UI | P1 |

### File 04: ingest-hook-installer-platform

| ID | Story | Layer | Priority |
|---|---|---|---|
| S-INGEST-01 | API key life: created, works, expired, revoked (v1 and v2) | API | P0 |
| S-INGEST-02 | First session upload over v1: repository, branch, user, context, repeats without duplicates | UI+API | P0 |
| S-INGEST-03 | Hostile and huge bodies: empty, broken, NUL bytes, gzip in four forms, the size limit | API | P0 |
| S-INGEST-04 | A large session over v2 in chunks: a repeated chunk, foreign parameters, byte-exact assembly | API | P0 |
| S-INGEST-05 | A broken file over v2: a warning in the next upload and the admin's work with the queue | UI+API | P1 |
| S-INGEST-06 | The queue survives failures: lease, a stuck processing, abandoned chunks, a write error, a "torn" file | API | P1 |
| S-INGEST-07 | OTEL chunks on the server: idempotency, accumulation, invisibility in the UI | API | P2 |
| S-HOOK-01 | A full Stop run: what exactly goes to the server, in what order, and what is not sent again | hook | P0 |
| S-HOOK-02 | A broken line and privacy: the hook repairs NDJSON and does not expose secrets | hook | P0 |
| S-HOOK-03 | A large file: chunks, gzip, resuming after a break, the server refusing gzip, 413 | hook | P1 |
| S-HOOK-04 | The hook never blocks Claude: the server is down, hangs, answers 500; background upload does not slow the prompt | hook | P0 |
| ~~S-HOOK-05~~ | **Dropped: the guardrail was removed in 2.19.0.** ~~Guardrail: reading outside the project is forbidden, inside is allowed, switches, fail-open~~ | hook | — |
| S-HOOK-06 | Two-level config, a subfolder and a worktree: where telemetry is written, what the server sees | hook | P1 |
| S-HOOK-07 | The OTEL receiver as a local attack surface: a browser, someone else's project, `../evil`, a huge body | hook | P0 |
| S-HOOK-08 | OTEL end to end: SessionStart, receiving, uploading and deleting chunks, disabling, restart | hook | P1 |
| S-HOOK-09 | The main end-to-end scenario: an installed hook, a real server, the session is visible in the UI | UI+API | P0 |
| S-COMPAT-01 | Old hooks (before 1.7.0 and 1.7-2.7) against the new server | API | P0 |
| S-COMPAT-02 | The new hook against "non-native" servers and the old OTEL receiver | hook | P1 |
| S-INST-01 | A clean install into a project with user settings, and the installed hook working | installer | P0 |
| S-INST-02 | Secrets: the key only in the local config, 0o600, a tracked file blocks, a server change warns | installer | P0 |
| S-INST-03 | Reinstall, upgrade and migration from the old format are idempotent | installer | P1 |
| S-INST-04 | Uninstall cuts out only its own parts and does not break anything else | installer | P0 |
| S-INST-05 | OTEL port: allocation, pinning, `--otel-port`, stopping the old receiver, a foreign owner | installer | P1 |
| S-REL-01 | Build artifacts: a clean dist, consistent versions, the installer downloads and remembers its version | installer | P1 |
| S-REL-02 | A signed release link: from the admin panel to an anonymous download and every refusal | UI+API | P0 |
| S-PLAT-01 | Health, build version and security headers everywhere | API | P0 |
| S-PLAT-02 | Static files of the built application: br/gzip/identity, Vary, cache, SPA fallback | API | P1 |
| S-PLAT-03 | The server through an operator's eyes: cluster, System Info, worker restart, file logs, Error Logs, archive | UI+API | P1 |
