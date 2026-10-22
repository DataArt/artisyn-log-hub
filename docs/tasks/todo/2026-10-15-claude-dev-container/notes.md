# Notes: 2026-10-15-claude-dev-container

## 2026-10-21 (moved from requirements.md)

**History.**
- 2026-10-15: merged with the drafts `2026-10-15-dev-infra-compose` and
  `2026-10-15-hook-in-dev-container`.
- 2026-10-15: requirements simplified by the user's decision: the old DB data is deleted (no
  migration), the whole project is mounted into the container, development happens in the container,
  ports `3000`/`5173` are published to the outside.
- 2026-10-15: the rule "the server and client are already running, do not restart them" was replaced
  in `CLAUDE.md` and `repo-health-checks.json → environmentNotes` with "Claude starts them itself when
  needed".
- 2026-10-20: design notes previously kept in a separate `notes.md` were folded into the FRs and that
  file was removed.

**2026-10-20: worktrees side discussion.** Running several parallel task sessions via `git worktree`
(one branch per worktree) isolates working-tree state so unrelated changes don't get mixed, which
actually happened in one session: two other sessions' edits landed in this checkout and had to be
untangled by hand before committing. The current design (FR-A1/FR-B4: fixed
`log-hub-postgres`/`log-hub-mailpit` container/hostnames, fixed host ports `3000`/`5173`/`5432`/
`1025`/`8025`) assumes one active container for the whole repo, consistent with FR-B10's "only one
watch backend active on port 3000 at a time". If multi-worktree parallel sessions become routine,
each worktree would need its own compose project name + port offset (the `tests/scenarios` stand
already does exactly this per test run — own port, own `scn_*` schema — and is a usable reference
pattern) to avoid the port collision hit directly in that session (`scenarios-postgres-1` failing to
bind 5432 because a manually-run dev-DB container already held it).
Separately, not container-related: the installer's per-repo marketplace name
(`resolveMarketplaceName`, a hash of `git remote get-url origin`) is identical across every worktree
of this same repo, so switching which worktree's Claude session is active will keep re-triggering the
stale-user-level-registration path (now handled automatically by the
`findStaleUserLevelMarketplaceName` fix) — expected friction, not a bug, if worktrees get adopted.

## 2026-10-21 (moved from requirements.md, distillation)

**2026-10-21: scope change by the user.** Every container is a sandbox with its own worktree/branch,
its own DB in the shared Postgres server and its own in-container backend/client; sandboxes run in
parallel. This replaced the earlier single-container design (whole project mounted, fixed host ports
`3000`/`5173`, worktrees out of scope) and removed the shared-`ai_work_dir` problem.

## 2026-10-21 (moved from requirements.md, second distillation)

- Host git version observed when PoC-5 (host git ≥ 2.48) was written: 2.56.0.


## 2026-10-21 — host compose kept in place

User decision: the host workflow must stay exactly as today (`docker compose up -d` in `server/artisyn-log-run-local/`, then server/client on the host), with no knowledge of sandboxes. So the compose is updated in place instead of moving to `local-run/`, and the `log-hub-pgdata` volume is created by compose (not `external`) so no `docker volume create` step is needed. Old data is not needed.

## 2026-10-21 — host compose: cosmetic changes only

User decision (supersedes the entry above): the host compose keeps its bind mount, `PGDATA` and data; only `container_name`/`hostname` `log-hub-postgres`, network `log-hub-net` and `max_connections=300` are added. No named volume, no healthcheck, no Mailpit in it; `tests/scenarios/docker-compose.yml` is untouched. The earlier named-volume rationale (Windows bind mounts and fsync after power loss) was dropped by the user.

## 2026-10-21 — Phase 1 PoC acceptance run (chunk 7)

Run by the implementing agent on the Windows host (Docker 29.7.2, host git 2.56.0), through
`node scripts/claude-docker.mjs`, without a TTY. The image `log-hub-dev:latest` built in about 3 min
(Node 24.18.1, npm 11.16.0, Claude Code 2.1.304, git 2.55.0 in the image, no `python3`). All test
sandboxes, branches, containers and volumes were removed afterwards; the image and the git-ignored
`docker-dev/claude-home/` were left in place.

**Limit of this run.** The agent has no TTY and the shared profile `docker-dev/claude-home/` has no
Claude login, so every launch reached `docker exec … claude --dangerously-skip-permissions` and
Claude exited with `Input must be provided either through stdin or as a prompt argument when using
--print` (with `--continue`: `No deferred tool marker found…`). Everything before and after the
session was verified; the interactive parts below are marked **USER**: they need one run by the
developer in a real terminal after `claude` login inside a sandbox.

| # | Criterion | Result |
|---|---|---|
| 1 | `claude-docker r1` creates worktree + branch `r1` from `HEAD` and opens Claude; `/adlc-lh:review-deep` runs and changes only `docs/` | PARTIAL. Worktree `<repo>-worktrees/r1` on new branch `r1` (base `main`, `createdFrom` = HEAD) created, container started, entrypoint reached `entrypoint-done` in ~15 s: marketplace `artisyn-e798dd87` registered from the worktree, `adlc-lh` and `log-hub-hooks` installed at project scope, `typescript-lsp` skipped (other marketplace), PoC override written (`log-hub-hooks` shown disabled by `claude plugin list`). Inside the container `git status`/`git log` work in the worktree (relative gitdir resolves), `/host-tmp` is read-only. **USER:** the review-deep session itself. |
| 2 | Main checkout untouched; `git worktree list` shows `r1`; `git -C <worktree> status` works from the host | PASS. `git status` of the main checkout identical before/after; `git worktree list` lists `r1`; `git -C ../_repo-worktrees/r1 status` clean. |
| 3 | `--remove r1 --delete-branch` removes container, worktree and branch; nothing left in `--list`, `git worktree list`, `docker ps -a`, `docker volume ls` | PASS (r1 had no commits of its own, so no host merge was needed). Output: container removed, `log-hub-dev-r1-plugins` removed, worktree removed, `deleted branch r1`. Afterwards none of the four listings shows `r1`. |
| 4 | `r3 --branch <existing>` checks the branch out; a branch already checked out is refused | PASS. `r3 --branch feature/2026-10-21-workflow-session-readability` → `existing branch …`, base `-`. `r4 --branch main` → `fatal: 'main' is already used by worktree at '…/_repo'`, exit 1; `r5 --branch r1` → `fatal: 'r1' is already used by worktree at '…/r1'`, exit 1; neither left a worktree or state dir. |
| 5 | A review session produces no hook errors and creates nothing outside the worktree | **USER** (needs a session). Container-side: the hook plugin is disabled for the worktree by the PoC override, the only host writes outside the worktree are the shared `claude-home` profile and the `.sandboxes/` state. |
| 6 | `--remove r2` on an unmerged sandbox removes container and worktree, keeps branch `r2`, refuses on uncommitted changes without `--force` | PASS for the refusal and the branch: with one new file in `docs/`, `--remove r2` → `refused; nothing was removed. Pending: 1 uncommitted change …`, exit 1, container still up; `--remove r2 --force` → container, volume and worktree removed, `kept branch r2`. The "unmerged commits" precondition was not produced: this repo's CLAUDE.md forbids the agent git writes (commit). |
| 7 | No launch removes a sandbox; `docker kill` mid-session; after any number of launches the sandbox exists and `r1 --continue` reopens the conversation | PASS for survival: `docker kill log-hub-dev-r1` → `--list` shows `stopped`; three `r1 --continue` launches each restarted / reused the container, worktree and state unchanged, `--list` shows `running`. **USER:** that `--continue` reopens the same conversation, and the Ctrl+C variant. |
| 8 | Stale threshold via env: the launch lists stale sandboxes with branch, last activity, pending work and the exact `--prune --older-than …` command; the prune shows the plan, confirms, removes nothing-to-lose ones, keeps ones with work unless `--force` | PASS. With `CLAUDE_DOCKER_STALE_AFTER=2m`, `r1` launch printed `r3  branch feature/… · last activity 2m ago · 1 changed file (log-hub-dev-r3)` and `Clean up: scripts/claude-docker.ps1 --prune --older-than 2m`. `--prune --older-than 2m` kept `r3` (`1 uncommitted change · no base branch…`), r1 `Not candidates: running`. With a clean stopped `r6`: `--prune` without TTY and without `--yes` printed the plan and exited 1 (`needs a terminal to confirm, or --yes; nothing was removed`); `--prune --yes` removed r6 including its branch (`clean, merged into main; deletes branch r6`) and kept r3. `--remove r3 --force` then removed r3 and kept its pre-existing branch. **USER:** the interactive `y/N` prompt. |
| 9 | `claude-docker` without arguments opens the menu: list, create, continue, remove, prune with confirmations; Esc/Q leaves without changes | **USER** (needs a TTY). Without a TTY it prints the terminal hint and exits 1, as specified. |

Also observed: `--remove r2 --delete-branch` on a sandbox created with `--branch r2` (no base) is
refused with `branch r2 has no base branch to check it is merged` unless `--force`.

## 2026-10-22 — Phase 2 acceptance run (chunk 17)

Run by the implementing agent on the Windows host (Docker 29.7.2, 32 CPUs / 32 GB in the Docker VM,
host git 2.56.0, image git 2.55.0), through `node scripts/claude-docker.mjs`, without a TTY.

**Host full set first** (inline `adlc-lh:check-health`, `finalRun: true`): every static check,
`build`, `contract` (380/380), `scenarios-a` (83, the one `x` is the declared `test.fail`
GOLDEN-LOAD branch cost), `scenarios-b` (main + backoff), `scenarios-c` (48), `e2e-fast` (27) and
`e2e-full` (88) green, against the recreated `log-hub-postgres`.

**Limits of this run.**
- The whole task is still **uncommitted** (HEAD `e35724a` has only the docs), and the agent may
  run read-only git only. A sandbox branch from HEAD therefore lacks `otel-env.ts`, the Vite
  `LOG_HUB_VITE_HOST`, `TEST_DATABASE_URL` and hook 2.23.0 (observed on the first start of `a`:
  `provision --static: Cannot find module …/otel-env.ts`, client not reachable from the host). Each
  test sandbox therefore got the main checkout's uncommitted files copied in as plain files (a
  scratch overlay script, CRLF → LF) and was restarted; this is why they show "60 changed files".
- The shared profile has no Claude login and there is no TTY, so no real Claude session was
  opened. A **live session** was emulated with a copy of `sleep` named `claude` (what
  `pgrep -x claude` counts), and a **hook upload** by running the worktree's installed
  `telemetry-hook.js` (UserPromptSubmit) and `send-logs-hook.js` (Stop) on a two-line transcript
  under the shared profile's `projects/<slug>/` (deleted afterwards).
- No commits (agent rule), so the "merged" and "unmerged commits" prune states and "a commit made in
  a sandbox has the host author and LF" were not produced; the classifier is covered by the
  algorithm doc rows.
- **USER** below = needs one run by the developer in a real terminal after `claude` login inside a
  sandbox.

| Criterion | Result |
|---|---|
| `claude-docker a` from scratch: compose, image, worktree + branch `a`, DB `log_hub_a`, backend/client/Mailpit, URL opens the UI, second console = second session | PASS for everything but the session (via `--serve a`: compose up, `log_hub_a` + `log_hub_a_test` created, slot 0 → `app :5200 · api :3100 · mailpit :8100`; first start installed all five `node_modules` in ~1 min; after the overlay, from the host: `:5200/` 200, `:5200/api/v1/auth/config` → `{"mode":"none"}`, `:3100` 200, `:8100` 200). **USER:** Claude session, second console. |
| `a`, `b`, `c` in parallel with different ports, branches, DBs; full sets pass concurrently | PARTIAL. `b` and `c` created concurrently (lock + slots 2/1, own DBs). The full set ran in all three at once (`tmp/fullset.sh` in each worktree): every static check, `build`, `contract`, `scenarios-b` passed in all three. Failures, all explained: (1) legacy `e2e-fast`/`e2e-full` failed in all three with `GET /admin/repos failed (403)` — a fresh DB precondition (see findings); with it met, `e2e-fast` 27/27 and `e2e-full` 88/88 passed in `a`, `b` and `c` (`b`/`c` concurrently). (2) Under the 3× load one UI step timed out: `@S-SESS-12` in `scenarios-a` of `a` and `b` and in `scenarios-c` of `c` (page still on the spinner after 10 s); a 2× re-run passed `scenarios-c` in `c` but timed out `@S-SLIFE-06` in `b`; `b` alone then passed 77/77. Classified as load flakiness, documented in the KB. "A change committed in `a` is not visible in `b`" not produced (no commits; the worktrees are separate checkouts). |
| `devctl restart server`, `devctl logs client`; services back after `--stop` + start | PASS. Restart: pid 534 → 17076, healthy; `devctl logs client` tails the Vite log (`ready in 187 ms`, Network `172.27.0.3:5173`). After `--stop a` + `--serve a` all four services `running … healthy/provisioned`. |
| Changing one lockfile reinstalls only that volume; unchanged ones skip | PASS. The overlay changed only `artisyn-hooks-installer/package-lock.json`; the next start logged `installing artisyn-hooks-installer/node_modules` and `… up to date` for root, `server/`, `hook/`, `client/`. |
| `--stop a` stops the stack; worktree readable on the host with `git status`/`git log`; `--serve a` brings the UI back on the same ports with the same data | PASS. `--stop` prints each `devctl` stop then `docker stop`; `git -C <wt> log/status` work on the host; `--serve a` → same `5200/3100/8100`; the uploaded session was still listed. |
| `log_hub_a` + `log_hub_a_test`; contract and scenario runners use only `_test` | PASS. `psql $DATABASE_URL` → `log_hub_a`, `psql $TEST_DATABASE_URL` → `log_hub_a_test`; scenarios end with `dev DB public schema … unchanged` on the test DB while the live backend received uploads. |
| `--list` shows every FR-E6 column; one session → 1; an uncommitted edit shows as pending | PASS. Columns NAME, BRANCH, BASE, STATE, SESSIONS, LAST ACTIVITY, PENDING, URLS / PORTS, DB (`log_hub_a 10 MB`), WORKTREE; the fake `claude` → `SESSIONS 1`; `e` with one new file → pending listed; a worktree without its dir → `(missing)` + "incomplete sandboxes" line. |
| `--remove a` drops both DBs even with an open connection, removes container/volumes/worktree, keeps branch; refuses on uncommitted changes and on a live session without `--force`; re-running an interrupted remove completes it | PASS. With the fake session: `--stop`, `--remove` and `--reset` all exit 1 naming `1 live Claude session` (`--remove` also lists the uncommitted changes) and remove nothing. With a `pg_sleep(900)` connection open on `log_hub_a`, the container and one volume removed by hand first (interruption), `--remove a` (no force) → refused, exit 1; `--remove a --force` → remaining 5 volumes, both DBs, worktree, state; `kept branch a`. |
| Host after only `docker compose up -d`: dev server on `a-log`, contract + scenarios b pass, host postgres MCP returns `a-log` with the old data | PASS. Host full set above; host MCP: `current_database() = a-log`, 18 users (oldest 2026-08-12), 6217 sessions, `max_connections = 300`. |
| Menu highlights stale sandboxes; keys = flags | **USER** (needs a TTY). |
| `typescript-lsp` answers go-to-definition | PARTIAL. Plugin installed and enabled per sandbox (`typescript-lsp@claude-plugins-official`, `typescript-language-server` in the image). **USER:** the LSP query in a session. |
| Prune with sandboxes in every state | PASS for the producible states: `a` running with a session, `d` stopped with no commits, `e` stopped with an uncommitted file, `f` orphan (worktree deleted by hand), `g` running and idle, `b`/`c` running with work. `--prune` (no TTY, no `--yes`) printed the plan and exited 1. `--prune --yes` removed `d` (branch deleted) and `f` (container, 6 volumes, `log_hub_f` + `_test`, branch), kept `e` (`2 uncommitted changes`), left every other DB incl. all `_test` DBs. `--prune --include-running --yes` removed `g`, kept `a` (`1 live Claude session; never pruned, even with --force`) and `b`/`c`/`e` with reasons. `--prune --force --yes` removed `e` and `kept branch e`. Not produced: merged / unmerged-commit states (no commits). |
| Host compose differs only by name/hostname, network, `max_connections`; `show max_connections` = 300 | PASS (`git diff`: the five additive lines plus comments). |
| Fast set and full set pass in a sandbox; `npm run build` does not drop the watch backend | PASS with the two documented data preconditions for legacy e2e (see row 2). The backend log shows no restart during or after the in-sandbox build (last start 21:13, build ~21:19). |
| Pasted image readable through `/host-tmp` | PASS for the mechanism: a file in the host temp dir is readable via the guide's exact `HOST_TEMP` → `/host-tmp` translation snippet; `/host-tmp` is read-only. **USER:** an actual Ctrl+V paste. |
| Playwright and postgres MCP; `select current_database()` = `log_hub_a`; login shared and survives `--reset` | PARTIAL. `claude mcp list` in `a`: `postgres … /log_hub_a ✔ Connected` (local scope overrides the tracked `a-log` entry; Claude prints a "conflicting scopes" diagnostic, cosmetic); `npx.cmd -y @playwright/mcp@0.0.83 --version` → `0.0.83` through the shim, Chromium in the image; the tracked `playwright` server is "pending approval" until a session approves it. `docker-dev/claude-home` contents unchanged by `--reset b`. **USER:** login sharing and MCP calls inside a session. |
| Plugins per sandbox; after `--remove a`, `b` still loads them; a marketplace change in `a` does not reach `b` | PASS. Each sandbox's `claude plugin list` reads `adlc-lh`/`log-hub-hooks` from its **own** worktree (`Read from: /work/_repo-worktrees/<n>/.artisyn/marketplace/…`), so a change in `a`'s worktree cannot reach `b` and reaches `a` (in place) at its next session start. After `--remove a`, `b` still had 3 enabled plugins and its hook still uploaded. |
| Server fails to start → session opens after the readiness timeout with a warning; after the fix provisioning completes and uploads resume | PASS. `server/.env` `PORT=3999` + `CLAUDE_DOCKER_READY_TIMEOUT_S=20` → `--serve a` printed the warning, `devctl status` (`server … not responding`), the `devctl logs` hint and the telemetry-off warning, then the URLs. After restoring `PORT=3000` and `devctl restart server`: provisioned, upload `done: uploaded=3 … failed=0`. |
| Tampered sha256 fails the build; no `python3` | PASS. `--target fetch-mailpit` with a zeroed `MAILPIT_SHA256` → `mailpit.tar.gz: FAILED`, build exit 1; `which python3` empty in the image. |
| Invalid name, old git, `--reset` with live claude, stale-image warning | PASS: `Bad_Name` → `only a-z, 0-9 and "-"`, `x-test` → `must not end in -test` (exit 2); `--reset a` with the fake session → exit 1 with message; the first launch warned about the image built from older `docker-dev/` files, and so did a later launch after editing `CLAUDE.container.md` (`--reset b` rebuilt it; the new guide text is in `/etc/claude-code/CLAUDE.md`). Old git: verified by code (`parseGitVersion` + `versionAtLeast` against 2.48.0; the host git cannot be downgraded). |
| Main checkout and its `node_modules` untouched; host `git status` no false changes, no `claude-home`; commit has host author + LF | PASS for the first two: the main checkout's `git status` before/after the sandbox work differs only by the agent's own intended `server/.gitignore` fix; `docker-dev/claude-home/` is `!!` ignored. In the container `git config user.name/email` = the host's, `core.autocrlf=input`, `core.ignorecase=false`, worktree files are LF. **USER:** an actual commit. |
| No developer machine paths or user names in `docker-dev/`, compose, launcher | PASS (grep: only URLs, container paths and the `C:\Users\me\…` placeholder of the guide). |
| Session from `a` visible in `a`'s UI with logs and cost; absent from host and `b`; host sessions keep uploading | PASS for the emulated upload: `done: uploaded=2 … target=http://localhost:5173`; `sessions` row only in `log_hub_a` (0 in `log_hub_b`, `log_hub_c`, `a-log`); from the host, identify as the host git email on `:5200` → repository `github.com/DataArt/artisyn-log-hub` (hook 2.23.0) with the session, cost `0.000108`. Host Log Hub uploads were not checked separately (the host full set ran on the host dev server). **USER:** a real session, OTEL data. |
| Recreating `log_hub_a` re-provisions a new key; uploads resume; no tracked file changes | PASS. `dropdb --force log_hub_a` + restart: launcher recreated the DB, provisioning logged `existing apiKey rejected (log-echo 401); creating a new one` → new key in `log-hub.local.json`; upload resumed. Worktree `git status` identical before/after except a transient `?? server/upload-queue/` (backend runtime dir, see findings; not from provisioning). |
| Without the override the hook reads/writes as before; main checkout `.artisyn/` unchanged | PASS for the sandbox side: sha256 of every file under the main checkout's `.artisyn/config` and `.artisyn/marketplace` identical before/after; in the sandbox uploads `git.root` = `git.worktreeRoot` = `/work/_repo-worktrees/a`. The no-override behaviour is covered by `@S-HOOK-01` steps 14–15 (host full set). |
| KB article and index updated | PASS (chunk 17). |

**Findings fixed in this chunk.**
- `server/src/public/static/installer-version.json` (written by the backend on every start) was not
  ignored by any tracked `.gitignore` — the host relied on an untracked local
  `server/src/public/static/.gitignore`. Every fresh sandbox therefore had one untracked file, so
  `--prune` would classify even an untouched sandbox as "has work". Added to the root `.gitignore`
  (it takes effect for sandboxes branched from a commit that contains it).
- Same pattern for the backend's default `UPLOAD_QUEUE_DIR` `server/upload-queue/` (host: untracked
  self-ignoring `.gitignore` from August): added `/upload-queue/` to `server/.gitignore`.
- Legacy e2e on a fresh DB needs its user `muaddib@arrakis.test` to be an admin and at least one
  repository; documented in `docker-dev/CLAUDE.container.md` (one `psql` line) and the KB
  limitations. The image does not do it itself, keeping the container independent of the test
  suites (NFR).

**Observations (not changed).**
- `claude plugin list --json` records the project plugins with the version of their first install
  (e.g. `log-hub-hooks` 2.22.2) although they load in place from the worktree (2.23.0); Claude
  suggests `claude plugin update … --scope project` to re-record it. Cosmetic.
- The prune plan's reason for a branch with no commits reads `clean, merged into main` (the branch
  is an ancestor of its base), while `--list` shows `no changes, no commits`.
- `--shell` does not print the sandbox URLs (only sessions and `--serve` do).

**Left behind.** Branches `a` and `e` (created by the launcher, kept by `--remove` without
`--delete-branch` / `--prune --force` by design; delete with `git branch -d a e`); the shared cache
volumes `log-hub-dev-cache-{npm,bun,playwright}` and the image `log-hub-dev:latest` (current hash).
All test containers, per-sandbox volumes, `log_hub_*` DBs, worktrees and state dirs are gone.

## 2026-10-22 — post-implementation additions (user requests after the workflow)

**Deletion guards.** An audit of every delete in the launcher found three risks, now closed:
`deleteState` removed `path.join(stateDir, name)` recursively without validating the name;
`--remove` passed the `worktree` path from `state.json` (user-editable) to
`git worktree remove --force`; `CLAUDE_DOCKER_WORKTREES_DIR` was accepted even when it was a drive
root, the home dir or inside the repo. Now every deleted dir is derived from a validated name as a
direct child of a launcher-owned dir (`assertSandboxName`, `assertOwnWorktree`,
`assertSafeWorktreesDir` in `config.mjs`). Checked against `""`, `..`, `../x`, `a/b`, a state
pointing at another dir or the repo, and worktrees dirs `D:\`, the repo, inside it, its parent, the
home dir and its parent: all refused.

**Protected branches.** `.claude/claude-isolation.json` `{"protectedBranches": ["main"]}`. The
launcher refuses, before any change, a sandbox whose branch is listed (new or from its state);
`--from main` stays allowed. In the menu the branch is required (no default) and a protected one is
rejected in the dialog. `claude-docker probe-x --branch main` → exit 1, nothing created.

**First-build notice.** The CLI (before the build) and the menu (before and inside the screen) say
the image is missing and the first build takes ~20–30 min. KB **Image → Build time** and the README
pointer say the same.

**Faster image build.** Playwright's Chromium (the slowest download, 5–10 min) moved to its own
parallel stage `fetch-playwright` instead of the last step of the final stage; apt lists/debs use
BuildKit cache mounts (one id per stage). Measured: a near-cold build 702 s (network was slow that
night: Playwright alone 582 s, Claude 290 s), now bounded by the Playwright download alone; a
rebuild after editing an image file **6 s** (before: the Playwright step re-ran, 356 s).

**`tmp/` volume and timeout scale.** The failures of `@S-SESS-12` in the parallel acceptance run
were the scenario stand stalling (even `/api/v1/auth/config` hung) while two sandboxes did heavy
I/O through the shared 9p file-sharing bridge — not an isolation breach (DBs, schemas, netns and
ports were all separate). `<worktree>/tmp` is now a per-sandbox volume `log-hub-dev-<name>-tmp`,
and `LOG_HUB_TEST_TIMEOUT_SCALE=5` multiplies the Playwright timeouts of scenarios and legacy e2e
(`tests/timeout-scale.ts`, both configs, an auto fixture that scales `test.setTimeout()`).
Unset on the host = 1.

**Legacy e2e admin.** `provision.mjs --loop` promotes `muaddib@arrakis.test` to admin once, as the
developer (`PATCH /api/v1/users/:id/role`), marker `/run/dev/e2e-admin`.

**Entrypoint race fixed.** Two sandboxes starting at once both wrote the shared
`claude-home/settings.json` through the same `settings.json.tmp`; the second `mv` failed and its
container stopped. The tmp name is now unique per sandbox and process.

**Verification.**
- Two sandboxes `nt-a`, `nt-b` (working-tree files copied in, new image) ran `scenarios-a` and
  `e2e-fast` **at the same time**: both 77 passed / 1 skipped in 276 s (before: 479 s and
  `@S-SESS-12` failing; now 2.6 s / 1.9 s), `e2e-fast` 27 passed in ~40 s (before: global setup
  403). Provision log: `e2e admin: promoted muaddib@arrakis.test to admin`.
- Host fast set: client/server lint, typecheck, unit; hook tests; tests typecheck; scripts
  (201/201); build — all pass. Host `@S-SESS-12` (scale 1) passes in 2.4 s.

**Dropped.** `--escape-probe` (an agent in the sandbox probing the file-system and network
boundary) was dropped by the user.

**Left behind.** The image `log-hub-dev:latest` (current hash). The test sandboxes `nt-a` and `nt-b`
were removed with `--remove --force --delete-branch` (container, seven volumes including `-tmp`,
both DBs, worktree, branch).
