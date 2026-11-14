# Research findings 1 — plan-deep, 2026-11-13

Audit archive of the research subagent's report (verbatim). Nothing downstream reads it.

I couldn't find the Log Hub pieces Work Hub needs ready-made in the repo. There is no terminal, WebSocket, code editor, generic file tree, drag-out or Rust tooling, and no build, lint, test or CI step covers `work-hub/`. The two PoCs prove the core mechanics. The wireframes and one PoC conclusion are partly out of date against the final requirements; details are below.

## Requirements summary

Work Hub is a new sub-product in `work-hub/`: a Rust backend, a React frontend, its own Postgres, its own tests and later its own release, running independently of Log Hub. A logged-in user creates a **workspace** (one local git repo started empty, no remote). It opens in a light-theme, IDEA-like web IDE with a file tree, tabs, editing that commits on save, and drag and drop in, out and inside the tree. The user opens named **workstreams**. Each one is a container branched off the workspace container (latest checkpoint image plus copies of the repo and home volumes), with a git branch and exactly one chat. The chat is the interactive Claude CLI running in tmux in the container, bridged to xterm.js over a WebSocket and recorded for history. All Docker work goes through the Docker Engine API. The agent sits behind an adapter; Claude Code is the only one shipped. The Claude login is per workspace and copied into each workstream. A "Configure" agent session saves the workspace container as a checkpoint with `docker commit`. Closing offers bring into main (local merge via git bundle), already merged elsewhere, close for now, or discard. Everything is personal to the user. Auth has the same four modes as Log Hub but is re-implemented, with its own users table.

(The per-FR/AC gist list of the report restated `requirements.md` one line per id; see that file.)

The Notes section adds one open item: the owner will check during implementation whether copies of `.credentials.json` survive refresh-token rotation. `open_questions_ru.md` has no open questions. `notes.md` holds rounds 1–10 of the owner's answers; round 9 replaced the PoC's "repo in the container filesystem" with volumes.

## Wireframes

There are 12 SVGs in `wireframes/`, all 1200 px and light theme.

**Shared header:** "Artisyn AI Work Hub › <crumb>", History, Settings, a wrench "Configure" on the working-branch view, and "email · Logout". Below it, a "WORKSTREAM" row of chips: `main (working branch)`, one chip per open workstream, and "+ Open workstream". A "PROJECT" tree on the left. Tabs on the right, with "📌 Chat · <name>" first.

- `workspaces-and-settings.svg` — workspace cards (name, "started empty · no remote", working branch, number of open workstreams, Delete…, Open). Settings form: name (read-only), working branch dropdown, Repository "none — started empty", Container "Work Hub default", Save. The delete confirmation lists what is removed.
- `new-workspace-dialog.svg` — Name, then "Start empty" or "Use an existing git repository". The clone half is out of scope (FR-9). "Create" prepares the container and then asks for the Claude login.
- `claude-authorization.svg` — a modal with "New login" (terminal preview, "Start login in a terminal"), "Copy from my workspace" (list with login date and "Copy from there"), and "Not now — only view and edit files".
- `claude-login-terminal.svg` — a terminal tab ">_ Claude login" with "Skip for now". Runs `claude auth login`, shows the method picker, OAuth URL and "Paste code here". On "Login successful" the tab closes.
- `workspace-working-branch.svg` — editor with line numbers; status line "docs/requirements.md · main · edited by hand · saved", one "Save" button.
- `configure-session.svg` — "[wrench] Configure container" tab with "Finish configuration" and a "Saving the container setup… ✓ Saved" toast. Callout 4 still calls ending the session an open question; FR-25b settled it.
- `open-workstream-dialog.svg` — Name field only, inline error for empty/duplicate. Then "Preparing…", then the chat tab.
- `workstream-chat.svg` — pinned chat tab is a terminal with header "Terminal · Claude CLI running on the server · workstream X · opened 10:42" and a "Close workstream" button outside the terminal.
- `result-preview.svg` — an HTML result rendered inside Work Hub with "Open in new tab" and "Download" — XSS concern on the Work Hub origin.
- `file-tree-drag-drop.svg` — "Drop to upload into data/" highlight; context menu Download, Rename, Delete. Rename and Delete are not in any FR.
- `close-workstream-dialog.svg` — out of date against FR-29 ("Keep the work" vs "Discard everything", git term "Saved as: branch ws/q3-dashboard"). FR-29 wins.
- `workstream-history.svg` — list with name filter, state chips (open / closed / discarded; no *done*), "added to main" / "not added to main", durations, read-only replay pane, "Reopen".

## PoCs

**`docs/pocs/2026-11-13-1906-workhub-container-branching/`** (Node `run.js` on the docker CLI; image `node:26.13.1-slim` + git, tmux)
- Branching with `docker commit` → `docker run` → `git worktree add -q -b ws/<name> /workspace/worktrees/<name> main`. Commit 1843/832 ms, run 409/422 ms, worktree 143/142 ms. Checkpoint after 20 MB: 947 ms, 21.4 MB layer.
- Bundle: `git -C REPO bundle create - main..ws/a` from exec stdout → `docker exec -i WS sh -c 'cat > /tmp/x.bundle'` → `git fetch -q /tmp/x.bundle ws/a:ws/a` → `git merge --no-ff`. 489 bytes, 107 ms. Conflict by merge exit code, `git merge --abort`.
- Stop/start keeps files not processes. Discard: `docker rm`, `docker rmi`, `git branch -D`.
- Gotchas: tested repo in the container filesystem — reversed by FR-5a/5b; volume copy not covered. ~127-layer overlayfs limit for checkpoint chains. README says 14/14 vs log footer 13/13.

**`docs/pocs/2026-11-13-1906-workhub-terminal-bridge/`** (Rust; `axum =0.8.4` with `ws`, `bollard =0.18.1`, `futures-util 0.3`, `serde 1`, `serde_json 1`, `tokio 1` full; edition 2021)
- xterm.js over a WebSocket: binary frames for keys/output, text JSON `{cols, rows}` for resize.
- bollard `create_exec` with `tty: true`, attach stdin/stdout/stderr, `user: "node"`, `TERM=xterm-256color`, running `sh -c "tty; exec tmux attach -d -t <s>"`. First output line is the client pty; on disconnect run `tmux detach-client -t <pty>` (closing stdin does not end `tmux attach`). `-d` drops stale clients. Resize via `docker.resize_exec`.
- `ensure_session`: `tmux new-session -d -s S -x 120 -y 32 -c /workspace "tmux wait-for go-S; exec <cmd>"` → `tmux pipe-pane -o -t S 'cat >> DIR/S.raw'` → `tmux wait-for -S go-S`. Names `[a-z0-9-]{1,40}`.
- `image/tmux.conf`: `status off`, `prefix None`, `unbind C-b`, `escape-time 0`, `history-limit 50000`, `default-terminal tmux-256color`, `terminal-overrides ",xterm-256color:Tc"`, `extended-keys on`, `allow-passthrough on`, `window-size latest`, `remain-on-exit on`, `mouse off`.
- Image installs `@anthropic-ai/claude-code` unpinned (2.1.323 observed). 9/9 fresh, 3/3 after server restart (same pane PID). Browser: theme picker, arrows, Enter OK; login screen showed OSC-8 URL and "Paste code here"; no real sign-in completed. History replays with colours.
- Advice: record resizes with bytes; preset CLI `theme`; xterm clipboard addon (OSC 52) and OSC-8 link handler; product must bundle `@xterm/xterm@5.5.0` / `addon-fit@0.10.0` (CDN in PoC, NFR-2).

## Knowledgebase

- `docs/knowledgebase/authorization-and-authentificaiton.md` — four `AUTH_MODE`s (`none`, `password`, `password-confirm`, `azure-oauth`); unset = `password`; unknown fails startup; per-mode validation (mode 3 SMTP reachable, mode 4 tenant GUID, `PUBLIC_BASE_URL` for 2/3 in production). Off-mode routes 404. Mode 1 identify only from localhost (+ container default gateway by socket peer, never `X-Forwarded-For`); `AutoIdentifyGuard` on `GET me`. Backoff: max of account/IP counters, 2nd failure 1 s, 3rd 2 s…; 429 `Retry-After`. `AUTH_RATE_LIMIT_POINTS` 5 / `AUTH_RATE_LIMIT_WINDOW_SEC` 900. `ALLOWED_EMAIL_DOMAINS` in mode 3; `TRUST_PROXY` overrides `COOKIE_SECURE`. Email case-insensitive; `password_hash` nullable. Admin gets no data access.
- `docs/knowledgebase/algorithms/password-policy.md` — `PASSWORD_POLICY` (`any`/`mid`/`long`, unset `long`), `400 weak_password`; rows in `docs/algorithm-examples/`. `auth-startup-config` also an algorithm doc.
- `docs/knowledgebase/server-conventions.md` — Argon2id timeCost 2, memoryCost 19, parallelism 1 (`server/src/utils/password-hash.ts:22-28`); real value is 19 KiB despite the "512 MiB" comment — choose Work Hub's on purpose.
- `docs/knowledgebase/ui-principles.md` — light only; English only; `lucide-react`, no emoji; status colour families; light tooltips. xterm needs its own light palette.
- `docs/knowledgebase/test/overview.md`, `test/scenarios.md` — three test kinds; Playwright scenarios on an isolated stand; modes A `none`/test, B `password-confirm`/production + Mailpit, C `password`/test; no Azure stand. Tags `@S-XXX-NN … @mode-a`. Own `scn_<mode>_<8hex>` schema and free port, ready on `GET /health`. Postgres `postgresql://postgres:pw@localhost:5432/postgres`, compose `postgres:18.7`. `app` group serial.
- `docs/knowledgebase/test/contract-tests.md` — NestJS-only registry `f<NN>-<family>.ts` + router meta-test; Work Hub needs its own for axum.
- `docs/knowledgebase/algorithms/README.md` — rows `docs/algorithm-examples/<name>.json`, array of `{id, input, expected, note}`, validated by `scripts/algo-docs/load-examples.cjs:144-183`. Candidates: branch slug, name validation, resize-offset replay.
- `docs/knowledgebase/docker-dev-container.md` — never copy a Claude login (refresh token rotates); first-run keys to merge into `.claude.json` (`theme`, `hasCompletedOnboarding`, `lastOnboardingVersion`, `projects[<path>].hasTrustDialogAccepted/hasCompletedProjectOnboarding`); native binary pinned by sha256 (`docker-dev/Dockerfile:60-66`, `CLAUDE_VERSION=2.1.304`); `--init`.
- `docs/knowledgebase/db-schema-code.md` + `.claude/rules/db-migration.md` — hand-written SQL migrations, `COMMENT ON`, immutability, advisory lock; same discipline for Work Hub (e.g. `sqlx::migrate!`).
- `docs/knowledgebase/twins-and-cross-cutting-rules.md` — new env var → commented line in an env example.
- `docs/knowledgebase/static-asset-serving.md` — SPA precompressed (brotli/gzip), `/assets/` cache policy.
- `docs/knowledgebase/client-routing-and-layout.md` — `createHashRouter` (`client/src/main.tsx:3,257`); lazy chunk budget ~8.
- `docs/knowledgebase/release-pipeline.md` — GHCR multi-arch image + install kit; Work Hub release later.

## Existing patterns

**Auth contract to mirror**
- `server/src/auth/auth.controller.ts:60-85` — `GET /api/v1/auth/config` → `{mode, azure?: {authority, clientId, redirectUri}, adminContactEmail?, passwordResetAvailable?}`; `:87+` `POST identify` with `@AllowedAuthModes('none')`.
- Other routes: login, logout, me, signup, confirm-email, forgot-password, change-password, delete-account, `GET /api/v1/auth/azure`, `GET /api/auth/callback`.
- `server/src/auth/` guards, utils (`localhost.util`, `container-gateway.util`, `password-policy`), config (`auth-startup-validation`, `allowed-email-domains`), `login-backoff.service.ts`, `auth-rate-limit.service.ts`, `azure/azure-authority.ts`.
- `server/src/app.module.ts:186-227` — sessions in Postgres; cookie `httpOnly`, `sameSite: 'lax'`, `maxAge` 3 600 000 ms, `rolling`, `secure` from `COOKIE_SECURE` / `'auto'` behind `TRUST_PROXY`.
- `server/src/database/schema/index.ts:56-65` — users: `id serial`, `email` unique, `password_hash` nullable, `role` enum default `user`, `created_at`, `email_confirmed_at`.
- `server/src/common/security-headers.ts:14-33` — strict CSP (`default-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`); CSRF = SameSite=Lax; no state-changing GET; WebSocket upgrade must check `Origin`.
- `server/.env.example` — `DATABASE_URL`, `SESSION_SECRET`, `COOKIE_SECURE`, `TRUST_PROXY`, `AUTH_MODE`, `PASSWORD_POLICY`, `ADMIN_CONTACT_EMAIL`, `AUTH_RATE_LIMIT_*`, `SMTP_*`, `AZURE_*`.

**Client login UI to mirror** (`client/src/`)
- `viewer/pages/login/LoginPage.tsx` — `IdentifyForm` :53; `PasswordLoginForm` :121 (403 `email_not_confirmed`, 429 countdown, 401); mode switch :310-326; `TemporaryIssueMessage` :29; `?oauthError=` banner :286-307.
- `AzureSignInButton.tsx:11`, `forgot-password-link.ts`, `signup/SignupPage.tsx`, `hooks/useAuthConfig.ts:5`.
- `viewer/api.ts` — `apiFetch` :172, 401 handler :122-139, `ApiError` :141, blob downloads :2017/:2496/:2533, `FormData` uploads :2037/:2100.
- `viewer/ui/{dialog,confirm-dialog,button,card,input,tabs,tooltip}.tsx` (shadcn on `radix-ui`); `viewer/app.css:4,56` Tailwind v4 tokens.
- Native drag handlers only in `pages/repository/FileCategoriesEditor.tsx:89-115`.
- Versions: react 19.3.0, react-router-dom 7.18.4, vite 7.3.7, typescript 5.9.3, tailwindcss 4.3.3, @tanstack/react-query 5.104.2, radix-ui 1.8.1, lucide-react 0.577.0, vitest 4.1.12, eslint 9.39.5.

**Docker from Node** — `scripts/claude-docker/docker.mjs` (`docker()` :74, volumes with labels :202-221, labelled listing :236-262, `runContainer` :517 with `--init`); `scripts/claude-docker/sandbox.mjs:493-518` `prepareClaudeProfile` (atomic `.claude.json` merge).

**Build, test, CI** — `scripts/build.js:48-64` parallel branches; `scripts/build-assets.js:75-83`; `repo-health-checks.json` entry fields `name, dir, module, command, group, timeoutSeconds, instructions, finalOnly?`; `scripts/scenarios/*.mjs`, `tests/scenarios/modes.ts`, `playwright.scenarios.config.ts` Log Hub-specific; `tests/tsconfig.json` covers `e2e/**`, `scenarios/**`, `golden/**`; `.github/workflows/checks.yml:70-92` no Rust job; Postgres 18.7 everywhere; root `.gitignore` covers `tmp`, `/dist`, `/node_modules/`.

## Open gaps

1. Nothing exists for Rust, `rust-toolchain.toml`, xterm.js, WebSockets, a code editor, a file tree, drag-out (`DownloadURL` Chromium-only), folder drop (`webkitGetAsEntry`), toasts.
2. Volume model unproven (helper tar copy, volumes excluded from commit).
3. Copying `.credentials.json` vs refresh-token rotation; detecting a broken login; adapter "busy" notion.
4. Claude CLI pinning in the default image; image build needs network at install time.
5. Tests for a Rust backend: own contract registry/route enumeration, own scenario stand, Docker prerequisite, Rust algorithm tests reading the rows files.
6. Login UI cannot be imported from the Log Hub client — copy or extract.
7. Agent-written HTML preview is an XSS risk — sandboxed iframe / attachment / plain text.
8. Wireframes vs requirements drift (close dialog, history *done*, configure callout, Rename/Delete).
9. Undecided: env var names, slug algorithm, id → Docker names/labels, pane-log sync interval, file-change watching, host-restart recovery, 127-layer limit, takeover message, build/CI/gitignore placement.
10. Argon2 parameters — choose on purpose.
