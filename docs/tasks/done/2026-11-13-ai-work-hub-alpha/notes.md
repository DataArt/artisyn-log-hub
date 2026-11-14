# Notes — Artisyn AI Work Hub, Alpha

## 2026-11-13 — moved from requirements.md (owner's answers and PoC results)

These are the evidence trail behind the requirements; the current contract is `requirements.md`.
Where a later round replaced an earlier answer, the later one wins (marked below).

### Owner's answers

- Round 1: auth is inherited from Log Hub logically, not by code (own users table, different
  users); "agnostic" = any agent, alpha tested with Claude; Claude is preinstalled and authorized
  through an in-app hint running `claude login`; one container per workspace, a container branched
  off it per workstream, workstreams do not interfere.
- Round 2 (from `open_questions_ru.md`): workspace by clone (ask for git authorization) or empty
  without a remote *(clone replaced by round 8: no remote in the alpha)*; default empty
  devcontainer when the repo has none; everything is personal; Claude authorization once per
  workstream plus "copy it from there" *(replaced by round 4: per workspace)*; a workstream
  container takes the workspace container's state at opening; close = commit, push if there is a
  remote, offer merge (maybe via PR), or discard after confirmation *(push/PR dropped by round 8)*;
  closing and similar actions are buttons; a closed, not discarded workstream can be reopened in
  the same context; files can be edited by hand on the working branch; folder `work-hub/`; a
  separate sub-product with its own tests and, later, its own release. Added: the accounting
  reference scenario, running the code with viewable and downloadable results, drag and drop for
  the file tree.
- Round 3: the result of a run is only files (code and produced files), anything more — in later
  versions; a hand edit is committed at once — a commit is the equivalent of saving a document, on
  a branch there is little difference between "save" and "save and commit"; a finer mode for
  advanced users may come later.
- Round 4 (replaces "once per workstream" of round 2): the Claude login is per workspace = per git
  repository, and inside the workspace everything inherits it transparently; the question is asked
  right at workspace creation — a new login, or copy from one of the user's existing workspaces.
- Round 5: inside the chat there is simply the Claude CLI and it is not improved for now, so result
  names cannot be reliably taken from it — no result card in the chat; results are reached through
  the file tree.
- Round 6: the chat is a real terminal with the interactive Claude CLI and full support of special
  key sequences, so that a question Claude asks looks and works as in a real terminal —
  conceptually like a Guacamole terminal (colours, arrow keys and so on), but without installing
  Guacamole.
- Round 7: the theme is LIGHT, the terminal too; dark comes later.
- Round 8: git authorization is undecided — the alpha can do without a remote altogether. For the
  future: a flexible way to set up configurations and tools — a "configure" (wrench) action on the
  workspace opens a service session: an agent session in the workspace container with instructions
  "this session configures the container; do what the user asks". It changes the workspace
  container itself and saves a checkpoint, without copying the whole image. PoC: a checkpoint is a
  `docker commit`, which stores only the changed layer (20 MB installed → 21.4 MB layer, under
  1 s), and every workstream opened afterwards inherits it.
- Round 9 (from `open_questions_ru.md`): the Claude login is kept, for simplicity, as
  `~/.claude/.credentials.json` in the workspace's container profile; security is hardened later
  (a server-held token was the alternative proposed). Keep in mind that later one container may run
  Codex and another OpenCode. The configuration session (wrench) is IN the alpha *(replaces round
  8's "for the future")*, without rollback to an earlier checkpoint for now — the owner wants to see
  how it is laid out and works first. The git tree and the profile should be mounted as volumes
  outside the container, so the container does not intersect with frequently changing files
  *(replaces the PoC's "repository and home in the container filesystem")*.
- Round 10 (2026-11-13, after review-deep): 14 of 16 review questions resolved as common sense
  (see the requirements' Common sense considerations). The owner left refresh-token rotation of
  copied `.credentials.json` to be checked by the owner during implementation. Closing: Work Hub
  never commits for the user (that is asked of Claude in the chat) and every close first checks
  the worktree is clean, listing stuck files otherwise. Then either "take it and merge" — a local
  merge, which needs no remote (a pull request does) — or "it is already merged via a remote,
  just check no files are left and close (remove)". The owner does not yet know how this should
  work in general; this is the alpha's take *(replaces the "offer to merge, abort on conflict"
  flow)*.

### PoC results

- [`docs/pocs/2026-11-13-1906-workhub-container-branching/`](../../../pocs/2026-11-13-1906-workhub-container-branching/README.md)
  — 14/14: snapshot branching, isolation, bundle transfer, merge and conflict, close/reopen,
  discard, checkpoint size.
- [`docs/pocs/2026-11-13-1906-workhub-terminal-bridge/`](../../../pocs/2026-11-13-1906-workhub-terminal-bridge/README.md)
  — Rust axum + bollard + tmux + xterm.js: the interactive Claude CLI with arrow-key prompts,
  resize, reconnect, survival of a server restart, recorded history, light theme, Claude's login
  flow in the terminal (working up to the code prompt).

Both confirm the container model and the terminal design.

## 2026-11-14 — implementation: verification (chunk 24)

### Automated checks

- The `work-hub-*` checks are in `.claude/repo_config/repo-health-checks.json` (`static`: lint,
  typecheck, algo, build; `app`, final only: contract, scenarios a/b/c) and the CI job
  `work-hub-fast` in `.github/workflows/checks.yml` runs lint, typecheck and `test:algo`.
- Fast set, run on Windows 11 with Rust 1.92.0, bun 1.4.4, Docker 29.7.2: `work-hub-lint`
  (rustfmt, clippy `-D warnings`, eslint, agent-name check, licence check over 740 packages),
  `work-hub-typecheck` (web + tests), `work-hub-algo` (7 Rust table tests, 12 vitest rows) and
  `work-hub-build` all pass.
- `work-hub-contract`, `work-hub-scenarios-a|b|c` and Log Hub's own checks (AC-32) are `finalOnly`
  / `app`-group checks: the implement workflow's final verification run executes them after the
  last chunk (plan-gap chunk 25 did not run them, by the workflow's rules). Their results are in
  that run's report, not here.

### Run modes (AC-1a)

First pass (chunk 24): health and config endpoints only. Second pass (chunk 25, 2026-11-14), a
headless-Chromium walk through the real UI in both modes: sign in (`AUTH_MODE=none`), create a
workspace with **New workspace**, click **New login** in the agent-login dialog, then try to open
a workstream, then delete the workspace.

- **Inline:** `npm run start` (web build + `cargo run --release`, `work-hub/.env`, Postgres
  database `workhub`) on `localhost:3100`. The server found the default image, the workspace
  was created, the login terminal ran the **real** Claude CLI (`claude auth login`), which
  printed its OAuth URL and stopped at `Paste code here if prompted >`. With no login,
  `POST …/workstreams` → 409 `login_required` (expected). The workspace was deleted (204) and
  no labelled container or volume was left. The server was then stopped.
- **Dockerized:** `docker compose -p workhub-runmode -f deploy/docker-compose.yml up -d --build`
  (fresh build of the current tree, `deploy/.env`, `WORK_HUB_ENV=production`) on
  `localhost:5010`. It gave the same result as inline: the SPA served, identify worked from the
  host, `system/status` showed `{docker: ok, defaultImage: ok}` through the mounted socket, the real
  CLI's login printed `Opening browser to sign in…`, then the OAuth URL, then `Paste code here
  if prompted >`, and the workstream open returned 409 `login_required`. The stack was removed with
  `down -v` (containers, both volumes, network).
- **Not done in either mode:** opening a workstream and getting a chat answer from the real CLI.
  Both need the login above finished: an OAuth round trip in a browser with the owner's Claude
  account, then pasting the code. Neither a headless walk nor an agent can do that. This
  is part of the owner's step below.

### Real Claude login and the AC-7 walk — owner's step, still open

The walk with the real Claude CLI (AC-7, AC-19, AC-20: a workspace on the default image, the real
`claude auth login` in the login terminal, copying the login to a second workspace, a workstream
answering with no login prompt, then "Q3 dashboard" → view, Download, Bring into main) needs the
owner's own Claude account and a browser OAuth round trip, so it was not done by the implementing
agent. The same flow is covered end to end against the fake agent by `@S-WH-02` and the AC-7 walk
in `@S-WH-05`. The owner also checks here whether a copied `.credentials.json` keeps working after
the refresh token rotates (round 10). To close AC-1a as well, do the walk once in each run mode:
dockerized at `localhost:5010` and inline (`npm run start`) at `localhost:3100`. In each, finish the
login, open a workstream and get an answer in the chat.

**Update 2026-11-14 (night).** Done on the dockerized local install (`../local-workhub`, :5010):
the owner logged in with the real Claude account in workspace "Claude login"; the agent copied
that login into a new workspace "Real Claude check", opened workstream "Hello page" (real Claude
Code v2.1.304 started with no first-run dialogs), asked it to create and commit `hello.html`, then
"Bring into main" → `ae5b86d Bring Hello page into main` in `workspace/repo` on the host. Still
open: the inline run mode (:3100) and the full AC-7 "Q3 dashboard" walk.

Found during the owner's login and fixed (not yet covered by a scenario run, see below): Ctrl+V in
the terminal sent `^V` instead of pasting (xterm key handler); the login-code prompt echoes nothing,
so the login tab now draws one `*` per pasted character (`TerminalView maskPastes`); the fake agent's
code prompt no longer echoes either, like the real CLI.

## 2026-11-14 — status of the open items below (same night, owner: "do everything but the tests")

Done (lint, clippy, typecheck and the licence check pass; **no scenario or contract run** after
these changes — the owner tests by hand on the local install):
- **1 Disk:** adapter `container_env` (`DISABLE_AUTOUPDATER=1`) and `disposable_home_paths`
  pruned after "Bring into main" / "Close for now"; `GET …/workstreams?disk=1` + History "On
  disk" column (FR-5h, AC-20f, plan D22). Existing closed workstreams keep their 380 MB until
  they are reopened and closed again (or discarded); existing containers get the env only when
  recreated.
- **3 Tailwind removed:** all 47 components on CSS Modules + tokens in `src/app.css`;
  `tailwindcss` / `@tailwindcss/vite` uninstalled, `lightningcss` gone from `node_modules`, the
  MPL exception removed from `license-check.mjs` (728 packages, all on the allowlist).
- **4 COOKIE_SECURE** as in Log Hub (unset → Secure).
- **5 Small defects:** favicon added (`web/public/favicon.svg`). `GET /auth/me` was not a defect:
  401 only on an empty DB (no users yet) — Log Hub behaves the same; with a user it answers 200.
- **7 Logout:** FR-24b / AC-20e; `POST /api/v1/workspaces/{id}/login/logout` (+ contract registry
  row), Settings "Log out of <agent>" with a confirmation.

Found in the agent's own browser look at the local install, fixed the same night:
- **Buttons had black text on blue** after the Tailwind removal: the base reset in `app.css`
  (`button { color: inherit }`, specificity 0,0,1) beat the primitives' `:where()` rules. The
  reset now lives in `@layer base`, so unlayered component styles always win.
- **"Bring into main" could report "added to main" with nothing merged.** In workstream "add index
  page" (real Claude) the agent moved the workstream's own copy of `main` to its commit, so the
  bundle range `main..ws/add-index-page` was empty, the close took the "nothing to bring" path and
  still set `merged_at`. Fix: migration `0003_base_commit.sql` records the workspace base commit
  at open and the bundle is `<base_commit>..<branch>` (whole branch for older rows); `merged_at` is
  set only when a merge happened. The already-closed "add index page" still shows "added to main"
  while its commit `333e048` is not in main: reopen and close it again ("Bring into main") with
  the fixed server to really merge it.

Then, on the owner's request:
- **tmux `focus-events on`** in `image/tmux.conf` (the CLI asked for it); default image rebuilt.
  Mouse stays off (with it on, selecting text in the browser terminal needs Shift).
- **"Bring into main" takes everything** (FR-29 changed): `POST …/close` accepts an optional
  `commit: true` (older clients unchanged); the server runs `git add -A` + one commit "Save the
  work of <name>" in the worktree before the bundle. The dialog no longer stops on unsaved files;
  only "Already merged elsewhere" lists the files it would lose. **Scenario impact:** `@S-WH-05`
  (and any step expecting the uncommitted list before "Bring into main") must be updated.

- **"Agent is still working" was always shown** (the old check: tmux `window_activity` within 5 s;
  Claude Code redraws its screen all the time). Owner rejected Claude Code hooks ("they can break
  too much for users") and wanted `idle_prompt`; that is only delivered to hooks, and the terminal
  channel (`preferredNotifChannel: iterm2`, OSC 9) sent **nothing** in a 110 s real test (no
  browser attached; Claude seems to gate notifications on terminal focus). What works, verified on
  real Claude (answer, tool call, Esc interrupt): the session transcript
  `~/.claude/projects/-workspace-worktree/<agent_session_id>.jsonl`. Adapter `transcript_file` +
  `turn_running`: the last conversation record decides — `system`/`turn_duration` (right after
  the final answer) or the user record `[Request interrupted by user]` → idle; a prompt, a
  `tool_result` or an assistant record whose `stop_reason` is not `end_turn` → busy. Fallback:
  adapter `busy_markers` ("esc to interrupt" on the chat screen), then screen activity. A
  permission prompt counts as busy (the turn has not ended). Live check: busy 3–12 s while Claude
  wrote an answer, idle right after.
- **Login copies break each other (refresh-token rotation) — real problem, not fixed.** Claude's
  OAuth refresh token rotates: when one copy refreshes, the others' refresh tokens are dead. Seen
  live: "Real Claude check" (copied from "Claude login") refreshed at ~05:48 UTC; "Claude login"
  kept an expired access token + a used refresh token (`claude auth status` still says
  `loggedIn: true` — it does not check online); a new copy from it was wiped by Claude on its
  first refresh → `login_required`. Every copy eventually kills its source. Options to decide:
  copy from the source with the newest `expiresAt` (helps, does not cure); write the refreshed
  credentials back to the workspace (and other workstreams) after each refresh; or keep one
  credential per user outside the containers and mount/sync it (the "hardened storage" of NFR-1).

- **One login per user, outside the containers (owner's decision; fixes the rotation problem).**
  Verified live first: `claude setup-token` in a workspace container printed a 108-char
  `sk-ant-oat01-…` token; with `CLAUDE_CODE_OAUTH_TOKEN` and no `.credentials.json`,
  `claude auth status` → `authMethod: oauth_token`, `claude -p` answered and the interactive chat
  started (tmux `new-session -e`). Built:
  - `src/secrets.rs` + migration `0004_secret_key.sql`: AES-256-GCM files
    `<data dir>/secrets/<user id>/<name>.enc` (`WHS1 || nonce || ciphertext`, AAD
    `<user id>/<name>`), key in table `secret_key` generated on first use; `aes-gcm` 0.10.3
    (MIT/Apache). Generic for later secrets. Account deletion removes the user's secrets.
  - Adapter: `login_command` = `claude setup-token`, `token_env` = `CLAUDE_CODE_OAUTH_TOKEN`,
    `token_from_login_output`; secret name `<agent>-token`.
  - Login: output collected in the container's `/tmp/wh-login.raw` (tmpfs, not the host disk);
    the watcher takes the token, stores it, deletes the file, marks every workspace of the user
    with that agent logged in. `check_login` = the token exists. `copy`/`sources` routes kept for
    old clients (no-op / empty list). Logout deletes the token for the user.
  - Token to the agent: `tmux::SessionOpts { record_to, secret }`; the value goes through the
    exec's stdin (`read` → `new-session/respawn-pane -e NAME="$WH_SECRET"`), never in a command
    line Docker records; old `.credentials.json` removed before the agent starts.
  - UI: login link bar ("Open sign-in page" / "Copy link", `GET …/login/link` = first `https://`
    link of `capture-pane -J`), paste feedback "Pasted N characters … Press Enter" (the `*`
    local echo garbled `setup-token`'s redrawing screen and is gone), Ctrl+C copies a selection
    (Ctrl+Shift+C always).
  - Fake agent: `setup-token` (link, silent code prompt, fake 108-char token); `auth status` sees
    the env token.
  - Requirements FR-24/24a/24b, AC-19/20 rewritten. **Scenario impact:** every scenario using
    `fakeLoginInUi`, `fakeLoginInContainer` or "Copy from my workspace" (`@S-WH-02`, `@S-WH-04`,
    `@S-WH-05`, contract `workspaces.rs` login copy) must be updated — not done (owner: no tests).
  - The owner logs in once more after the deploy (the old per-workspace logins are not migrated).

Still open: **2** (scenarios a/b/c and contract after all of the above), **6** (inline run mode).

## 2026-11-14 — open items for the next session (recorded, not fixed yet)

1. **Inactive workstreams take a lot of disk.** Measured in
   `local-workhub/files/users/dt@dataart.com/real-claude-check-5b2534/` (760 MB for one workspace
   with two workstreams): each workstream's `home/` is ~380 MB — `home/.local/share/claude`
   349 MB (Claude Code's auto-updater downloads its own copy of the CLI into the home on the first
   run in every workstream, although the image already has the pinned binary in
   `/usr/local/bin`), `home/.claude/plugins` 18 MB, `home/.claude/skills` 12 MB, `cache` 1.3 MB;
   the repo part is tiny (`workspace/` 111 KB). The workspace's own `home/` is small because the
   agent never ran there. Owner's ask:
   - show the size of closed / done workstreams somewhere (at least in History), and
   - when a workstream is closed (or "folded"), drop everything that can be restored: e.g. the
     home's agent caches/downloads, keeping the repo, the branch and the chat recording; on
     reopen restore the home from the workspace's.
   Candidate fix for the biggest part: turn off the agent's self-update in containers (the image
   pins the version; an adapter-provided env such as `DISABLE_AUTOUPDATER=1`, and/or copy the
   workspace home without `~/.local/share/<agent>`). Needs a decision on what "restorable" means
   (agent session history lives in `home/.claude/projects` — needed for `--resume`).
2. **Final verification is incomplete.** Passed: the whole fast set (Log Hub and Work Hub),
   `build`, `e2e-fast`, `e2e-full`, `work-hub-contract`. Not run: Log Hub scenarios a/b/c and
   contract (owner: Log Hub code unchanged), Work Hub scenarios a/b/c (owner: stop; the paste,
   masked-echo and fake-agent changes have not been through a scenario run yet). `@S-WH-02` with
   the AC-3b step passed in mode a before those changes.
3. **`lightningcss` (MPL-2.0) is NOT acceptable — owner, 2026-11-14 ("compliance").** The chunk-19
   exception in `work-hub/scripts/license-check.mjs` (`/^lightningcss(-…)?$/`, MPL-2.0) must go and
   lightningcss must leave Work Hub's dependency tree. It comes in through Tailwind v4
   (`@tailwindcss/vite` 4.3.3 / `tailwindcss` 4.3.3 in `work-hub/web`). **Owner, 2026-11-14: drop
   Tailwind from Work Hub entirely** (no Tailwind v3 either) — plain CSS / CSS modules with the
   design tokens as CSS variables; remove `tailwindcss`, `@tailwindcss/vite`, the `cn`/class-merge
   helpers if they only serve Tailwind, and the D16 wording that names it. Then re-check the
   whole web tree with the licence check without any MPL exception. Note: Log Hub's own client
   also uses Tailwind v4 and has `lightningcss` in `client/node_modules` — ask the owner whether
   the same rule applies to Log Hub (outside this task's scope).
4. **`COOKIE_SECURE` — do it as Log Hub does (owner, 2026-11-14).** When `COOKIE_SECURE` is unset
   the session cookie must be `Secure` always (today: only when `WORK_HUB_ENV=production`, see
   `auth/sessions.rs` and the `.env.example` comment). `TRUST_PROXY` keeps overriding it as in Log
   Hub. Then check that the stands and the inline dev `.env` still log in over plain
   `http://localhost` (Chromium accepts Secure cookies on localhost; set `COOKIE_SECURE=false`
   where a non-localhost http origin is used) and fix the `.env.example` / KB wording.
5. **Small defects:** `GET /api/v1/auth/me` answers 401 in mode `none` instead of auto-identifying a
   local request; `/favicon.ico` is 404.
7. **No "Log out of the agent" action (owner's question, 2026-11-14).** The UI can log in (New
   login / Copy from my workspace) but not log out; the requirements have no such FR either. Today
   the only way is `/logout` typed in a chat (then the workspace banner comes back, AC-20c).
   Proposal for review: a "Log out of <agentName>" item in workspace Settings (and/or the login
   banner's menu) that runs an adapter `logout_command` (Claude: `claude auth logout`) or deletes
   the adapter's `login_files` in the workspace home, refreshes `login_state`, and says that open
   workstreams keep their own copy until they are closed. Needs an FR + AC before building.
6. **Inline run mode (AC-1a)** with the real login is still open (see above).
