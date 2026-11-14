# Implementation plan — Artisyn AI Work Hub, Alpha

## TL;DR

- **New sub-product `work-hub/`**:
  - a Rust 1.92 server (`work-hub/server`, axum + bollard + sqlx), modules `auth`, `docker`,
    `agent`, `fs`, `workspaces`, `workstreams`, `terminal` and `api`;
  - a React 19 SPA (`work-hub/web`: Vite, plain CSS modules — Tailwind removed 2026-11-14, D22 —, Monaco editor, xterm.js 6) embedded in the
    server binary;
  - its own default container image (`work-hub/image`) and a fake-agent test image.
- **New Rust crates:** axum (ws), tokio, tokio-util, bollard, sqlx (postgres, runtime queries,
  migrate), tower-sessions with the sqlx store, tower-http, argon2, lettre, openidconnect,
  deunicode, tar, zip, sha1, sha2, rust-embed, dotenvy, uuid, time, thiserror, mime_guess, rand,
  tracing, tracing-subscriber (full list in Dependencies).
- **New web packages:** monaco-editor (bundled locally, no CDN), @monaco-editor/react, @xterm/xterm with the fit,
  clipboard and web-links addons, plus copies of the client's stack (react, radix-ui,
  lucide-react, react-query, react-router).
- **DB:** its own schema (`WORK_HUB_DB_SCHEMA`, default `work_hub`) with the tables `users`,
  `email_tokens`, `auth_sessions` (store), `workspaces`, `workstreams`, `terminal_recordings` and
  `terminal_resizes`. Log Hub's DB is untouched.
- **API:**
  - `/api/v1/auth/*` mirrors Log Hub's auth contract, with its own users and a cookie named
    `workhub.sid`;
  - new families `/api/v1/workspaces`, `…/views/{view}/fs/*`, `/api/v1/workstreams/*` and
    `/api/v1/system/status`;
  - three terminal WebSockets.
- **High blast radius:**
  - the server drives the host's Docker Engine (containers, volumes, `docker commit`, image
    builds) and labels and cleans only objects it owns;
  - the dockerized deployment mounts `/var/run/docker.sock`.
- **Two ways to run (FR-1b):**
  - `work-hub/Dockerfile` with `work-hub/deploy/docker-compose.yml` (Work Hub, Postgres 18.7, the
    Docker socket);
  - inline with `npm run dev` / `npm run start` in `work-hub/` against a local Postgres.
- **Tests:**
  - the Rust auth ports run Log Hub's existing algorithm rows;
  - four new algorithm docs;
  - a Rust contract registry with a route meta-test;
  - five new Playwright scenario files on Work Hub's own stand, with a fake `claude`;
  - Work Hub's own entries in `repo-health-checks.json`.
- **Repo-wide files touched** (Log Hub code and its build are not): `CLAUDE.md` (a Work Hub
  section), `repo-health-checks.json`, a new `work-hub-fast` job in
  `.github/workflows/checks.yml`, four existing auth algorithm docs (Rust twin listed),
  `algorithms/README.md`, `twins-and-cross-cutting-rules.md`, `docs/knowledgebase/index.md`; new
  `docs/knowledgebase/work-hub.md`, four algorithm docs with their `docs/algorithm-examples/*.json`
  rows, and a changelog entry.
- **Licences:** only permissive licences (MIT, Apache-2.0, BSD and the like) for Work Hub's own
  dependencies. No GPL family and no paid licences, enforced by `scripts/license-check.mjs` in
  `lint` (D20).
- **Offline exception:** the first start builds the default container image and needs the network
  once (Ubuntu packages, Node, Claude Code). After that everything runs offline (NFR-2 "after
  installation", D15).

## Reference

- Requirements: [requirements.md](requirements.md) (FR-1…FR-33, NFR-1…NFR-5, AC-1…AC-32)
- Owner's answers and PoC trail: [notes.md](notes.md); planning probes:
  [research/planning-probes.md](research/planning-probes.md)
- PoCs: [container-branching](../../../pocs/2026-11-13-1906-workhub-container-branching/README.md),
  [terminal-bridge](../../../pocs/2026-11-13-1906-workhub-terminal-bridge/README.md),
  [volume-copy](../../../pocs/2026-11-13-2008-workhub-volume-copy/README.md)

## Design Decisions

### D1 — Repository layout and toolchain

- **`work-hub/`** is a Cargo workspace (`members = ["server"]`, `target/` at `work-hub/target`).
  `rust-toolchain.toml` pins `channel = "1.92.0"` with `rustfmt` and `clippy`. Rust edition 2024.
- **`work-hub/web/`** is the SPA, installed with bun as the Log Hub client is. **`work-hub/`**
  itself has a `package.json` (npm) that holds only the orchestration scripts and the test devDeps
  (`@playwright/test` at the root's version, `typescript` 5.9.3).
- **`work-hub/.gitignore`** lists `target/`, `node_modules/`, `web/dist/`, `data/`, `.env` and
  `test-results/`.
- Work Hub is **not** added to `scripts/build.js`, Log Hub's `dist/` or its CI jobs (NFR-4). It
  gets its own CI job.

### D2 — Configuration (FR-1a)

Env vars are read with `dotenvy` from `work-hub/.env` when present. Log Hub's names are reused
wherever the meaning is the same.

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3100` | HTTP port |
| `HOST` | `0.0.0.0` | bind address |
| `DATABASE_URL` | required | Postgres URL |
| `WORK_HUB_DB_SCHEMA` | `work_hub` | schema created if missing; set as `search_path` on every connection |
| `WORK_HUB_ENV` | `production` | `production` / `development` / `test` (Log Hub's `NODE_ENV` role) |
| `WORK_HUB_DATA_DIR` | `./data` | file area `users/` (D21), recordings (`recordings/`) and temp files (`tmp/`) |
| `WORK_HUB_DOCKER_DATA_DIR` | the absolute data dir (Windows drive → Docker Desktop path) | the data dir as the Docker Engine sees it (D21) |
| `DOCKER_HOST` | bollard default (unix socket / Windows named pipe) | Docker Engine endpoint |
| `WORK_HUB_DEFAULT_IMAGE` | `artisyn-work-hub-default:<crate version>` | image for new workspaces and helper containers |
| `WORK_HUB_INSTANCE` | `default` | value of the `artisyn.workhub.instance` label; scopes every Docker object |
| `WORK_HUB_STATIC_DIR` | unset | serve the SPA from disk instead of the embedded copy (dev) |
| `SESSION_SECRET` | required in production | signs the session cookie (SHA-512 of it = 64-byte key) |
| auth vars | as in Log Hub | `AUTH_MODE`, `PASSWORD_POLICY`, `ADMIN_CONTACT_EMAIL`, `AUTH_RATE_LIMIT_POINTS`, `AUTH_RATE_LIMIT_WINDOW_SEC`, `ALLOWED_EMAIL_DOMAINS`, `PUBLIC_BASE_URL`, `COOKIE_SECURE`, `TRUST_PROXY`, `SMTP_HOST/PORT/FROM/USER/PASSWORD/SECURE`, `AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI/AUTHORITY/SCOPES` |

Startup validation follows `docs/knowledgebase/algorithms/auth-startup-config.md`. The rows' key
`NODE_ENV` maps to `WORK_HUB_ENV`.

### D3 — Auth (FR-6, AC-6)

- **Contract.** The same routes, request and response shapes, status codes and per-mode 404s as
  `server/src/auth/auth.controller.ts`: `config` :60, `identify` :87, `signup` :102, `login`
  :142, `azure` :159, `logout` :172, `confirm-email` :188, `resend-confirmation` :196,
  `forgot-password` :214, `reset-password` :228, `change-password` :245, `delete-account` :257,
  `me` :284, and the Azure callback in `server/src/auth/azure/azure-callback.controller.ts:33`.
  The code is re-implemented in Rust and shares nothing with Log Hub.
- **Behaviour ports.** Each port follows its Log Hub doc and must pass that doc's rows:
  - password policy;
  - login backoff (in memory) and the rate limit (in memory);
  - local-request detection (mode `none` identify, plus auto-identify on `GET me`);
  - startup config.
- **Password hashing.** Argon2id with m = 19456 KiB, t = 2, p = 1 (the OWASP baseline), chosen on
  purpose rather than copied from Log Hub.
- **Sessions.** `tower-sessions` with `PostgresStore` (schema `WORK_HUB_DB_SCHEMA`, table
  `auth_sessions`). Cookie `workhub.sid` (unlike Log Hub's, because cookies ignore the port on
  `localhost`). Attributes: signed, `HttpOnly`, `SameSite=Lax`, 1 h inactivity expiry,
  `Secure` from `COOKIE_SECURE` / `TRUST_PROXY` as in Log Hub.
- **Users.** Work Hub has no roles in the alpha. `me` (and the user in login, identify and
  signup) returns Log Hub's public profile shape `{id, email, role:"user", createdAt}`, with
  `role` always `"user"`.
- **SESSION_SECRET.** Required when `WORK_HUB_ENV=production`. Otherwise, when unset, a random key
  is used per process start, with a warning, so sessions end on restart.
- **`delete-account`.** Body `{confirm:"delete"}` as in Log Hub (`server/src/auth/dto`); no
  password; answers 204 and clears `workhub.sid`.
- **Account deletion.** `delete-account` first deletes all of the user's workspaces (D9),
  through the trait `auth::AccountCleanup` (`async fn delete_user_data(&self, user_id: i64) -> Result<(), ApiError>`).
  `AppState` holds it as `Arc<dyn AccountCleanup>`; it is a no-op until the workspace service
  implements it.
- **Tokens.** The confirm token lives 24 h and the reset token 1 h. Resending has a 60 s cooldown.
  These are Log Hub's values: `email-confirmation-tokens.service.ts:8-9` and
  `password-reset-tokens.service.ts:8-9`.
- **Email links.** They use `PUBLIC_BASE_URL/#/confirm-email?token=…` and
  `…/#/reset-password?token=…` (hash router).

### D4 — Ownership and errors

- **Ownership.** Every query is filtered by the session user. A missing or foreign id answers
  **404** `{error:"not_found"}`, never 403 (AC-5).
- **Errors.** Error bodies are `{error:<code>, message:<plain English sentence for the UI>, ...details}`.
  `ApiError { status: StatusCode, code: &'static str, message: String, details: Option<serde_json::Map> }`;
  `details` is flattened into the body (`version`, `paths`).
- **Codes used:**
  - `unauthorized` (401), `not_found` (404);
  - `invalid_name`, `duplicate_name`, `unknown_branch` (400), `invalid_login_source` (400: the
    source is not the user's, has another agent or is not logged in);
  - `working_tree_busy` (409: git refused to switch the branch), `not_closed` (409: reopen of a
    workstream that is not `closed`), `unavailable` (503: retry could not start the container);
  - `docker_unavailable` (503), `image_not_ready` (503);
  - `create_failed`, `open_failed` (500, rolled back);
  - `login_required` (409), `configure_running` (409);
  - `changed_on_disk` (409), `target_exists` (409), `uncommitted` (409), `merge_conflict` (409);
  - `not_open` (409), `not_text` (400), `invalid_path` (400), `cannot_discard` (409: the
    workstream is done or already discarded).
- **Messages** (each constructor carries its text; the name rules come from D8, merge_conflict
  from D10):

| Code | Message |
|---|---|
| `unauthorized` | Please sign in. |
| `not_found` | This item doesn't exist or isn't yours. |
| `unknown_branch` | That branch doesn't exist in this workspace. |
| `invalid_login_source` | That workspace has no login to copy. |
| `working_tree_busy` | The working branch can't be switched right now: some files are not saved yet. |
| `not_closed` | Only a closed workstream can be reopened. |
| `unavailable` | Work Hub couldn't start this workstream's container. Try again later. |
| `docker_unavailable` | Work Hub can't reach Docker on this computer. Start Docker and try again. |
| `image_not_ready` | Work Hub is still preparing its container image. Try again in a few minutes. |
| `create_failed` | The workspace couldn't be created. Nothing was kept. Try again. |
| `open_failed` | The workstream couldn't be opened. Nothing was kept. Try again. |
| `login_required` | This workspace needs a <agentName> login first. |
| `configure_running` | The container is already being configured. |
| `changed_on_disk` | This file was changed by the agent. |
| `target_exists` | Some files with these names already exist. |
| `uncommitted` | The agent has not saved these files yet. |
| `not_open` | This workstream is not open. |
| `not_text` | This file can't be edited here. |
| `invalid_path` | That file path is not allowed. |
| `cannot_discard` | This workstream can't be discarded. |

- **Timing constants** (`src/timing.rs`):

| Constant | Value |
|---|---|
| `POLL_INTERVAL_MS` (web, `ide/useFsPoll.ts`) | 2000 |
| `AGENT_BUSY_WINDOW` | 5 s |
| `RECONCILE_INTERVAL` | 60 s |
| `STALE_TRANSIENT_AGE` | 10 min |
| `LOGIN_WATCH_INTERVAL` | 2 s |
| `CONFIGURE_WATCH_INTERVAL` | 5 s |
| `RECORDING_SYNC_INTERVAL` | 30 s |

- **Size limits.** Uploads, saves above `MAX_EDITABLE_BYTES` and folder zips have no cap in the
  alpha (NFR-1). Temp files go to `<DATA_DIR>/tmp` and are deleted after use.

### D5 — Docker objects, names and labels

- **Labels.** Every object gets `artisyn.workhub=1`, `artisyn.workhub.instance=<WORK_HUB_INSTANCE>`,
  `artisyn.workhub.workspace=<uuid>`, `artisyn.workhub.workstream=<uuid>` (when it belongs to a
  workstream) and `artisyn.workhub.role=workspace|workstream|helper|checkpoint|built`.

| Object | Name |
|---|---|
| workspace container | `wh-ws-<workspace uuid>` |
| workspace volumes | `wh-ws-<uuid>-repo`, `wh-ws-<uuid>-home` |
| workstream container | `wh-st-<workstream uuid>` |
| workstream volumes | `wh-st-<uuid>-repo`, `wh-st-<uuid>-home` |
| built devcontainer image | `wh-img-<workspace uuid>:1` |
| checkpoint image | `wh-ckpt-<workspace uuid>:<seq>` |
| helper container | `wh-helper-<random uuid>` (auto-remove) |

- **Container config.** Every container uses `Cmd ["sleep","infinity"]`, `Init: true`,
  `Tmpfs {"/tmp": ""}` (so tmux sockets and bundles never enter a checkpoint), env from
  `containerEnv` plus `TERM=xterm-256color` and `LANG=C.UTF-8`, the default bridge network, no
  published ports and restart policy `no`. Mounts: repo volume → `/workspace`, home volume →
  `<home_dir>`.
- **Paths.** Inside the repo volume, the working-branch checkout is `/workspace/repo`. A
  workstream's worktree is `/workspace/worktree` in its own container.
- **Exec.** Every exec runs as the workspace's `container_user`. Git runs with
  `-c core.quotepath=off`.
- **Timeouts** (constants in `docker/exec.rs`):

| Constant | Value | Used for |
|---|---|---|
| `EXEC_TIMEOUT_DEFAULT` | 60 s | git and listings |
| `EXEC_TIMEOUT_STATUS` | 15 s | agent status, tmux queries |
| `HELPER_RUN_TIMEOUT` | 120 s | user discovery |
| `VOLUME_COPY_TIMEOUT` | 600 s | — |
| `IMAGE_BUILD_TIMEOUT` | 1800 s | — |
| `STOP_TIMEOUT` | 10 s | — |

- **`docker/exec.rs` interfaces** used by later chunks:
  - `exec_capture(container, user, argv, stdin: Option<Bytes>, timeout) -> Result<ExecOutput{exit_code: i64, stdout: Vec<u8>, stderr: Vec<u8>}>`;
  - `exec_stream_stdout(container, user, argv) -> impl Stream<Item=Result<Bytes>>`;
  - `exec_tty(container, user, argv, env) -> TtyExec{exec_id: String, output: impl Stream<Item=Bytes>, input: impl AsyncWrite}`
    with `resize(&self, cols: u16, rows: u16)`.

### D6 — Default image and devcontainer subset (FR-5d, FR-10, FR-22)

- **`work-hub/image/Dockerfile`** builds on `ubuntu:24.04`:
  - the `ubuntu` user is removed and user `workhub` (uid/gid 1000, home `/home/workhub`) is added,
    with passwordless `sudo`;
  - packages: git, tmux, sudo, ca-certificates, procps, curl, less, unzip;
  - Node 26.13.1 and the native Claude Code binary, each pinned by version and sha256 exactly as
    `docker-dev/Dockerfile:46-66` does;
  - `/etc/gitconfig` with `init.defaultBranch main`;
  - `/etc/tmux.conf` = the terminal-bridge PoC's `image/tmux.conf`;
  - `USER workhub`.
- **Embedding.** The server embeds `work-hub/image/` (rust-embed). At startup it builds
  `WORK_HUB_DEFAULT_IMAGE` through the Engine API when the image is missing; `npm run image` does
  the same by hand. While the build runs, workspace creation answers `image_not_ready`.
- **Subset.** `.devcontainer/devcontainer.json` (JSONC) supports these keys and ignores any other:
  - `image`;
  - `build.dockerfile` with optional `build.context` (relative to `.devcontainer/`);
  - `containerEnv` (string map);
  - `postCreateCommand` (string → `sh -c`, or argv array).

  The image value `artisyn-work-hub-default` means `WORK_HUB_DEFAULT_IMAGE`. Any other image must
  already exist locally (no pull, NFR-2), otherwise `create_failed` says so. A `build` is built
  through the Engine API from a tar of its context, read from the repo volume, into
  `wh-img-<uuid>:1`. Parsing is the algorithm `workhub-devcontainer-subset`.
- **Parse result.** `devcontainer::parse(&str) -> Result<ContainerSpec, String>`:

  ```rust
  ContainerSpec {
      source: ImageSource,                  // Default | Image(String) | Build { dockerfile, context }
      container_env: BTreeMap<String, String>,
      post_create: Option<Vec<String>>,     // a string becomes ["sh", "-c", s]
  }
  ```

  `Build.context` defaults to `"."`; both paths are relative to `.devcontainer/`.
- **Default definition.** The initial commit of a new workspace holds `.gitignore` (D8) and
  `.devcontainer/devcontainer.json` = `{"name":"Work Hub default","image":"artisyn-work-hub-default"}`.
- **When it is read.** The definition is read whenever the workspace container has to be created
  and the workspace has no checkpoint: at workspace creation, and when the container was removed
  outside Work Hub (D9).
- **postCreateCommand.** It runs once in a newly created workspace container. If it ran, an
  automatic checkpoint (seq 1) is taken so that workstreams inherit its effects.
- **Container user.** The user and home of a definition's image come from a helper
  `docker run --rm <image> sh -c 'id -un; id -u; id -g; echo $HOME'` at creation and are stored on
  the workspace row. The workspace's user, uid, gid, home and `base_image` columns are nullable
  while `state='creating'` and filled before `ready`.
- **`base_image`.** The image the workspace container was first created from: the
  `WORK_HUB_DEFAULT_IMAGE` tag, `wh-img-<uuid>:1` or a named local image. Containers start from
  `checkpoint_image` when it is set, else from `base_image`.

### D7 — Agent adapter (FR-2, FR-24a, FR-31)

Trait `agent::AgentAdapter` (`Send + Sync`); the registry is keyed by `workspaces.agent`. Only
`agent/claude.rs` names Claude.

```rust
fn id(&self) -> &'static str;                                  // "claude"
fn login_files(&self) -> &'static [&'static str];              // [".claude/.credentials.json"] (relative to home)
fn login_command(&self) -> Vec<String>;                        // ["claude","auth","login"]
fn status_command(&self) -> Vec<String>;                       // ["claude","auth","status"]
fn parse_status(&self, exit_code: i64, stdout: &str) -> bool;  // exit 0 && JSON loggedIn == true
fn start_command(&self, session_id: &str) -> Vec<String>;      // ["claude","--session-id",id]
fn resume_command(&self, session_id: &str) -> Vec<String>;     // sh -c 'claude --resume "$1" || exec claude --session-id "$1"' _ <id>
fn configure_command(&self) -> Vec<String>;                    // ["claude","--append-system-prompt",CONFIGURE_PROMPT]
fn profile_patch(&self, workdirs: &[&str]) -> serde_json::Value; // merged into ~/.claude.json
fn copy_extra_keys(&self) -> &'static [&'static str];          // ["oauthAccount"]: keys copied from the source ~/.claude.json
fn profile_file(&self) -> &'static str;                        // ".claude.json"
fn display_name(&self) -> &'static str;                        // "Claude": sent to the UI as `agentName`; the web never hard-codes it
```

- **Profile patch.** Claude's patch is `theme:"light"`, `hasCompletedOnboarding:true`, and
  `projects[<dir>].hasTrustDialogAccepted:true` / `hasCompletedProjectOnboarding:true`. It is
  applied with `workdirs = ["/workspace/repo"]` at workspace creation, and with
  `["/workspace/worktree"]` at workstream open (D10 step 8). It is merged by the server: read through the
  archive endpoint, merged with serde_json, written back as uid/gid 0600. Agent-specific
  knowledge stays in the adapter.
- **CONFIGURE_PROMPT** = "This session configures the container of this workspace. Do what the
  user asks: install tools, libraries and settings into the container (you may use sudo). Do not
  change the project files in /workspace/repo."
- **Login state.** `login_state` on the workspace row (`missing`/`ok`) is a cache. It is
  refreshed by running `status_command` in the workspace container on `GET workspace`, after a
  login session ends and after a copy. Copy sources are the user's other workspaces with the same
  `agent` and `login_state='ok'`.

### D8 — Names, branches and paths (algorithms)

- **Display name** (workspace and workstream, FR-9 and FR-26). The rules are the algorithm
  `workhub-names`:
  - trim Unicode whitespace;
  - empty → "Enter a name.";
  - more than 100 Unicode scalar values → "Use at most 100 characters.";
  - any control character → "A name cannot contain line breaks or control characters.";
  - uniqueness key = lowercase of the trimmed name; a duplicate → "You already have a workspace
    with this name." / "This workspace already has a workstream with this name."
- **Branch** (in the same doc). `ws/<slug>`, where the slug is built like this:
  - `deunicode` → lowercase → each run of chars outside `[a-z0-9]` becomes `-`;
  - trim `-` and cut at 50 chars (trim `-` again);
  - empty → `work`;
  - if taken, append `-2`, `-3`, … The taken set is the workspace repo's `refs/heads/ws/*` plus
    every DB branch of the workspace's workstreams, discarded ones included.
- **Repo path** (algorithm `workhub-repo-path`). Input is a `/`-separated relative path:
  - strip one leading `./`;
  - reject an absolute path, `\`, NUL, an empty segment in the middle, `.` or `..` segments, any
    segment equal to `.git`, and more than 4096 bytes;
  - `""` = the view root.

  Output is the normalized path. The container path is `<view root>/<path>`.
- **Default `.gitignore`.** `node_modules/`, `dist/`, `build/`, `out/`, `target/`, `.venv/`,
  `__pycache__/`, `*.pyc`, `.cache/`, `.DS_Store`, `*.log`.

### D9 — Workspace lifecycle (FR-5e, FR-5f, FR-9–FR-12a)

**Create.** Each step records what to undo; on failure everything is undone in reverse, the row is
deleted and the user gets `create_failed`.

1. Validate the name.
2. Insert the row (`state='creating'`).
3. Create the two volumes.
4. Run the container from the default image.
5. Exec as `container_user`:
   `git init -b main /workspace/repo`, `git config user.name/user.email <user email>`, write
   `.gitignore` and the default devcontainer, `git add -A`, `git commit -m "Start workspace"`.
6. Apply the devcontainer (D6).
7. Set `state='ready'`.

**Ensure** (`ensure_workspace_container(ws)`). Called by every action that needs the container:
inspect; when the container is missing, recreate it from `checkpoint_image`, else from the
definition (D6); when it is stopped, start it. Docker errors map to `docker_unavailable`.

**Settings.**
- `PATCH workingBranch` runs `git -C /workspace/repo switch <branch>` under the workspace lock;
  it fails with `working_tree_busy` 409 when git refuses.
- The branch list comes from `git for-each-ref --format=%(refname:short) refs/heads`.

**Delete.**
1. Final recording sync is skipped.
2. Remove the workstream containers and their volumes.
3. Remove the workspace container and its volumes.
4. Remove the images `wh-ckpt-<uuid>:*` and `wh-img-<uuid>:*`.
5. Remove the recording files.
6. Delete the row (cascade).

**Locks.** Per-container `tokio::Mutex` (`locks.rs`, keyed by container name) around every git
write. Opening a workstream holds the workspace lock while it copies volumes, so workspace writes
wait (FR-5b).

### D10 — Workstream lifecycle (FR-26–FR-31)

**Open.** The undo list is as in D9; on failure the user gets `open_failed`.

1. Validate the name.
2. Live login check (`login_required` when not logged in).
3. Compute the branch.
4. Insert the row (`state='opening'`, `base_branch` = the working branch,
   `agent_session_id = uuid v4`).
5. Copy the volumes with a helper container (the PoC recipe: `-u 0`, sources read-only,
   `cd /from && tar cf - . | tar xpf - -C /to`).
6. Run `wh-st-<uuid>` from `checkpoint_image`, else from `base_image` (D6).
7. Exec `git -C /workspace/repo switch --detach` and
   `git -C /workspace/repo worktree add -b <branch> /workspace/worktree <base>`.
8. Apply the profile patch.
9. Create the tmux session `chat` (D11) with `start_command`.
10. Insert the recording row and set `state='open'`.

**Close check.** `POST …/close/check` returns:
- `uncommitted`: the paths from `git -C /workspace/worktree status --porcelain=v1 -z --untracked-files=all`;
- `agentBusy`: `#{window_activity}` of `chat` is within 5 s of the container's `date +%s`.

The UI asks to confirm when the agent is busy; with uncommitted files it lists them, and "Close
anyway" sends `force:true`.

**Bring into main.**
1. Sync the recording.
2. Run `git -C /workspace/worktree bundle create - <base>..<branch>` in the workstream container.
   An empty bundle (exit ≠ 0 with "empty bundle") means nothing to merge.
3. Under the workspace lock, pipe the bundle to `/tmp/wh-<uuid>.bundle` in the workspace
   container and `git fetch <bundle> +<branch>:refs/heads/<branch>`.
4. Merge `--no-ff --no-edit -m "Bring <name> into <base>"`:
   - in `/workspace/repo` when `<base>` is checked out there;
   - otherwise in a temporary worktree `/tmp/wh-merge-<uuid>` that is removed afterwards.
5. **Conflict:** `git merge --abort`, then pipe `git bundle create - <base>` from the workspace
   into the workstream and `git fetch <bundle> +<base>:<base>` there. Answer `merge_conflict` with
   "Main has changed since this workstream started. Ask the agent in the chat: “Combine the latest
   <base> into this work”, then close again." The workstream stays open.
6. **Success:** stop the container, `state='closed'`, `closed_at`, `merged_at`.

**Other closes.**
- **Already merged elsewhere:** sync, remove the container and volumes, `state='done'`.
- **Close for now:** sync, stop, `state='closed'`.
- **Discard** (open or closed): sync when running, remove the container and volumes, run
  `git branch -D <branch>` in the workspace repo when the branch exists, `state='discarded'`,
  `discarded_at`.

**Reopen.** Allowed only from `closed`: start the container, ensure `chat` with `resume_command`,
`state='open'`.

**Reconciler** (`workstreams/reconciler.rs`). Runs at startup and every 60 s. For every `open`
workstream of this instance it ensures the container runs and `chat` exists (created with
`resume_command`). A start failure marks the workstream unavailable in memory (`available:false`
in the API) until `POST …/retry` succeeds. It also deletes rows stuck in `creating`/`opening`
older than 10 min, after removing their labelled objects.

### D11 — Terminals (FR-24, FR-25a/b, FR-27a–c, FR-32)

**tmux sessions.** One per container:
- `chat` in a workstream container, cwd `/workspace/worktree`;
- `login` and `configure` in the workspace container, cwd `/workspace/repo`.

They are created like the PoC's `ensure_session`: for `chat` first `mkdir -p <home>/.workhub/term`, then `new-session -d -x 120 -y 32 … "tmux wait-for go-<s>; exec <cmd>"`, then for `chat` only
`pipe-pane -o 'cat >> <home>/.workhub/term/chat.raw'`, then `wait-for -S go-<s>`. The tmux config
keeps `remain-on-exit on`. When `chat` is found with `#{pane_dead}=1` at attach or in the
reconciler, it is respawned with `respawn-pane -k` and `resume_command`.

**WebSocket routes.**
- `GET /api/v1/workstreams/{id}/chat/ws`
- `GET /api/v1/workspaces/{id}/login/ws`
- `GET /api/v1/workspaces/{id}/configure/ws`

Each requires the session cookie and an `Origin` equal to the request origin or
`PUBLIC_BASE_URL`, else 403.

**Frames.**

| Direction | Frame | Meaning |
|---|---|---|
| client → server | binary | keystrokes |
| client → server | text `{"type":"resize","cols":n,"rows":n}` | resize |
| server → client | binary | terminal output |
| server → client | text `{"type":"taken_over"}` | another tab took the session |
| server → client | text `{"type":"ended","loggedIn"?:bool}` | the login or configure process finished |
| server → client | text `{"type":"error","message":…}` | plain-language error |

**Bridge.** bollard exec with TTY: `sh -c "tty; exec tmux attach -d -t <s>"`. The first line is
the client pty; the bridge runs `tmux detach-client -t <pty>` on disconnect (PoC fix). Resize
goes through `resize_exec`.

**Takeover.** `terminal/hub.rs` keeps one live connection per `(container, session)`. A new one
sends `taken_over` to the old one and closes it (FR-27c, AC-22d).

**Recording.**
- Sync runs `tail -c +<synced_bytes+1> <log>` via exec and appends the bytes to
  `<DATA_DIR>/recordings/<workstream uuid>.raw`, updating `synced_bytes`.
- It runs on attach, on detach, every 30 s for running open workstreams, and before
  stop/remove.
- After each resize the server execs `stat -c %s <log>` and inserts
  `terminal_resizes(byte_offset, cols, rows)`.

**Login session.** `POST …/login/start` creates `login` with `login_command`; it is idempotent,
so with a session already running it just returns 204 and the UI reattaches. A watcher polls
`#{pane_dead}` every 2 s; when the pane is dead it runs the status check, updates `login_state` /
`login_at`, kills the session and sends `ended{loggedIn}`. `POST …/login/cancel` kills the session.

**Configure session.** Lives in `workspaces/configure.rs`.
- `POST …/configure` answers 409 `configure_running` when `configure_started_at` is set, and 409
  `login_required` without a login. Otherwise it sets `configure_started_at` and creates
  `configure` with `configure_command`.
- It ends on `POST …/configure/finish`, or when the watcher (every 5 s, resumed from the DB after
  a restart) sees a dead pane. Then: kill the session, `docker commit` →
  `wh-ckpt-<uuid>:<seq+1>`, store `checkpoint_image`/`checkpoint_seq`, clear
  `configure_started_at`, send `ended`.
- No rollback (FR-25c). The ~127-layer overlay limit is documented, not mitigated.

### D12 — Files and the IDE (FR-13–FR-21, FR-28)

**View.** `{view}` = `main` (workspace container, root `/workspace/repo`) or a workstream uuid
(its container, root `/workspace/worktree`). A view whose workstream is not open answers
`not_open`.

**Listing.**
- Lazy, one directory per call: `find <dir> -mindepth 1 -maxdepth 1 -not -name .git -printf '%y\t%s\t%T@\t%f\n'`.
- Directories come first, then names, case-insensitive. Everything else is shown.

**Version.** The version of a file is its git blob sha (`sha1("blob <len>\0" + bytes)`), computed
in Rust when the file is read and by `git hash-object --no-filters -- <path>` in a poll.

**Poll.** The client posts the expanded dirs and open files every 2 s while the page is visible.
One exec returns the listings plus the versions (`-` for missing). The tree and tabs update
without a reload (AC-16, AC-23). A clean tab reloads silently; a dirty one shows "Changed by the
agent" with "Keep mine" / "Take theirs" (FR-15).

**File kinds.**
- `text`: no NUL in the first 8000 bytes, valid UTF-8 and at most 2 MiB (`MAX_EDITABLE_BYTES`).
  Editable in Monaco (D19).
- `image`: extension png, jpg, jpeg, gif, webp, bmp or ico. Shown in an `<img>` from a blob URL.
- Everything else: "This file can't be shown here" with Download.
- HTML and SVG are shown as text, never rendered: agent-written HTML on Work Hub's origin would be
  an XSS (AC-23a also forbids embedding running apps).

**Save.**
1. `PUT` with `If-Match: "<version>"` (required).
2. Under the container lock, recompute the version; a mismatch → `changed_on_disk` with the
   current version.
3. Write through the archive endpoint as uid/gid, keeping the existing mode.
4. `git add -- <p>` and `git commit -m "Edit <p>" -- <p>` (only that path, FR-15a).
5. Return the new version.

"Take theirs" reloads; "Keep mine" re-saves with the current version.

**Upload.**
- Multipart, one part per file, the filename = a relative path under the drop target.
- Without `overwrite=1`, any existing target → `target_exists {paths}`.
- A tar is built in `<DATA_DIR>/tmp` with uid/gid, sent with `put archive`, then
  `git add -- <non-ignored paths>` and one commit "Upload <n> file(s) to <dir or project>".
- No commit when every path is ignored.
- Body limits are disabled on upload and save.

**Move.**
1. `mv` (refused into itself, `invalid_path`).
2. On a taken target without `overwrite` → `target_exists`.
3. `git add -A -- <from> <to>` and commit "Move <from> to <to>".

The UI re-points open tabs under `<from>`. Files the agent moves show as deleted.

**Download.**
- A file is streamed as an attachment.
- A folder becomes `<name>.zip` (zip crate) built from the archive tar in `<DATA_DIR>/tmp` and
  deleted after sending.
- Drag-out sets `DownloadURL` (`application/octet-stream:<name>:<absolute download URL>`), which
  works in Chromium; the "Download" menu item works everywhere.

**Tree DnD.**
- Drop from the computer uses `webkitGetAsEntry` recursion; the target is highlighted.
- Inside the tree the MIME type is `application/x-workhub-path`, and a drop on a folder moves the
  file.
- No Rename/Delete in the alpha (the wireframe menu items are not in the FRs).

### D13 — API registry and contract tests

- **Route table.** `api/mod.rs` defines a `routes!` macro: each `METHOD "path" => handler` line
  both adds the route to the axum `Router` and appends `(METHOD, "path")` to
  `pub static ROUTE_TABLE`.
- **Contract tests.** `work-hub/server/tests/contract/` holds `registry.rs`, a list of `Contract`
  rows with these fields:
  - `method`, `path`;
  - `auth`: `Public` / `Session` / `ModeOnly(&[modes])`;
  - `owner_scoped: bool`.
- **Meta-test.** It fails when `ROUTE_TABLE` and the registry differ.
- **Generic checks.** Session routes without a cookie → 401; owner-scoped routes as user B on
  user A's ids → 404.
- **Shape tests.** Per-family tests check the response shapes in API changes.
- **Environment.**
  - DB: `WORK_HUB_TEST_DATABASE_URL`, default `postgresql://postgres:pw@localhost:5432/postgres`,
    own schema `whc_<8hex>`, dropped afterwards.
  - Docker with `WORK_HUB_INSTANCE=whc-<8hex>`; objects with that label are removed afterwards.
  - The fake-agent image (D14).

### D14 — Test stand and fake agent

**Fake agent.**
- `work-hub/tests/fake-agent/` has a `Dockerfile` (`FROM artisyn-work-hub-default:<version>`) and
  `claude.mjs` installed as `/usr/local/bin/claude`. It is test infrastructure and is never
  shipped.
- **`auth status`:** exit 0 with `{"loggedIn":true}` when `~/.claude/.credentials.json` contains
  `"fake":"ok"`, else exit 1 with `{"loggedIn":false}`.
- **`auth login`:**
  1. An arrow-key menu with two methods; Enter picks.
  2. It prints `https://example.invalid/oauth` and `Paste code here:`.
  3. The code `good-code` writes the credentials and prints `Login successful.`
- **Interactive mode** (any other argv). It honours `--session-id`, `--resume` and
  `--append-system-prompt`, uses ANSI colours, a `> ` prompt and raw mode. The conversation is
  appended to `~/.claude/projects/fake/<session>.log`.

| Input | Fake agent does |
|---|---|
| `make <path> <text>` | writes a file |
| `run <command>` | runs `sh -c`, then prints `Run finished: exit <code>` |
| `ask` | shows a 3-option arrow question; Enter answers, Esc prints `Cancelled` |
| `commit` | `git add -A && git commit -m fake` |
| `recall` | prints `You said before: <previous message>` |
| `busy <s>` | prints a spinner for s seconds |
| `install <name>` | `sudo touch /opt/<name>` |
| `logout` | removes the credentials |
| anything else | echo |

**Stand.** `work-hub/scripts/scenarios.mjs --mode a|b|c [--grep <tag>]`:
1. Build the web (production) and `cargo build --release`.
2. Build the default image and the fake-agent image `artisyn-work-hub-fake-agent:test`.
3. Create schema `whs_<mode>_<8hex>`.
4. Start the server on a free port with `WORK_HUB_DEFAULT_IMAGE=artisyn-work-hub-fake-agent:test`,
   `WORK_HUB_INSTANCE=whs-<8hex>` and the mode env:

| Mode | Auth | `WORK_HUB_ENV` | Extra |
|---|---|---|---|
| a | `none` | `test` | — |
| b | `password-confirm` | `production` | Mailpit SMTP, `PUBLIC_BASE_URL`, random `SESSION_SECRET`, `COOKIE_SECURE=false` |
| c | `password` | `test` | — |

5. Wait for `GET /health`.
6. Run Playwright (`work-hub/tests/playwright.config.ts`, projects per mode, tags
   `@S-WH-NN @mode-x`).
7. Clean up: drop the schema and remove only objects labelled with its instance.

The runner also serves a control endpoint (`WH_STAND_CONTROL_URL`, `POST /restart-server`) for the
restart scenarios. `--stand-only` starts the stand, waits for `/health` and stops, with no
Playwright.

**Contract runner.** `work-hub/scripts/contract.mjs` builds the default and fake-agent images when
missing, then runs `cargo test --test contract -- --test-threads=1`. `server/Cargo.toml` declares
`[[test]] name = "contract", path = "tests/contract/main.rs"`.

Prerequisites: Postgres and Mailpit from the root `tests/scenarios/docker-compose.yml`, and Docker.

### D15 — Running it (FR-1b)

**Inline.**
- `work-hub/.env.example` lists every D2 var with a comment.
- `npm run dev` runs `cargo run` (server on 3100, `WORK_HUB_STATIC_DIR` unset) and Vite on
  `5180`, with `/api` proxied (`ws: true`, **no `changeOrigin`**, so `Host` stays
  `localhost:5180` and the WebSocket `Origin` check passes) to 3100.
- The SPA is embedded with rust-embed `#[allow_missing = true]` on `../web/dist`. A build without
  the web (Rust-only checks, CI `work-hub-fast`) compiles and serves a one-line "Web UI not built"
  page.
- `npm run start` runs the release binary with the embedded SPA on 3100.
- Postgres: a database of Work Hub's own (`workhub`), never Log Hub's database — the two products
  install independently. In local dev it may live on the same Postgres server as Log Hub's.

**Dockerized.** `work-hub/Dockerfile` has three stages:
1. `oven/bun:1.4.4` builds `web/dist`.
2. `rust:1.92` builds the release binary, embedding the SPA and `image/`.
3. Runtime `debian:trixie-slim` with ca-certificates, running as root (access to the Docker
   socket is host root anyway, documented). `WORK_HUB_DATA_DIR=/data`.

`work-hub/deploy/docker-compose.yml`:
- `db`: `postgres:18.7`, volume `workhub-pg`.
- `app`: build `..`, port `${WORK_HUB_PORT:-5010}:3100`, env file `.env`, volumes
  `/var/run/docker.sock:/var/run/docker.sock` and `workhub-data:/data`, `depends_on` db healthy.
- `work-hub/deploy/.env.example` is the env file for it.

The default image is built by the app at startup (D6), so the first start needs the network. This
is the accepted install-time exception to offline-first: NFR-2 and AC-30 cut the network "after
installation", and Log Hub's own install pulls its image the same way. The README and the KB
article say so.

### D16 — Frontend conventions

- **Stack.** Hash router as in the Log Hub client (`client/src/main.tsx:257`), react-query and
  `apiFetch` (relative `/api/v1`, `credentials:'include'`, `ApiError`, 401 → login), modelled on
  `client/src/viewer/api.ts:122-184`.
- **UI.** The client's `client/src/viewer/ui/{button,dialog,confirm-dialog,input,card,tooltip,popover}.tsx`
  are copied, along with its light tokens (`client/src/viewer/app.css`).
- **New primitives** in `src/ui/`:
  - `dropdown-menu.tsx` (radix DropdownMenu) for the user menu and the tree's context menu;
  - `select.tsx` (radix Select) for the branch picker;
  - `toast.tsx`, a minimal context-based toast (`useToast().show(text, tone)`), bottom right,
    auto-hidden after 4 s. Icons are lucide-react;
  no emoji. Follow `docs/knowledgebase/ui-principles.md`.
- **Routes.**
  - auth: `#/login`, `#/signup`, `#/confirm-email`, `#/forgot-password`, `#/reset-password`;
  - workspaces: `#/` (the list), `#/w/:wsId` (working-branch view);
  - workspace pages: `#/w/:wsId/s/:streamId`, `#/w/:wsId/history`, `#/w/:wsId/settings`.
- **xterm light theme** (NFR-1a):

| Slot | Colour |
|---|---|
| background | `#ffffff` |
| foreground | `#1f2937` |
| cursor | `#1f2937` |
| selection | `#bfdbfe` |
| ANSI 0–7 | `#1f2937 #b91c1c #15803d #a16207 #1d4ed8 #a21caf #0e7490 #6b7280` |
| ANSI 8–15 | `#4b5563 #dc2626 #16a34a #ca8a04 #2563eb #c026d3 #0891b2 #9ca3af` |

- **xterm settings.** Scrollback 10000, the clipboard addon (OSC 52) and the web-links addon
  (OSC 8 links open in a new tab).
- **Socket reconnect.** Delays of 1, 2, 4 and 8 s, then every 10 s, with a "Reconnecting…"
  overlay. There is no reconnect after `taken_over` or `ended`.
- **`AppState` final fields** (server, D-wide):
  - `config: Arc<Config>`, `db: PgPool`, `docker: DockerClient`;
  - `agents: Arc<AgentRegistry>`, `locks: Arc<ContainerLocks>`, `hub: Arc<TerminalHub>`;
  - `unavailable: Arc<Mutex<HashSet<Uuid>>>`, `image_status: Arc<RwLock<ImageStatus>>`;
  - `account_cleanup: Arc<dyn AccountCleanup>`;
  - `backoff: Arc<LoginBackoff>`, `rate_limit: Arc<RateLimiter>`, `mailer: Option<Arc<Mailer>>`.
- **CSP.** `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'`
  (Monaco and xterm inject styles; Monaco runs its editor worker).

### D17 — Replay (FR-32, FR-33)

The chat tab first loads the stored recording (`GET …/recording` bytes plus `…/recording/meta`)
into xterm, then attaches live, so earlier output is in scrollback (AC-26). The history replay
does the same, read-only, with no WebSocket.

The segments come from the algorithm `workhub-terminal-replay`: given `totalBytes`,
`initial{cols,rows}` and the resizes sorted by offset, it returns
`[{start,end,cols,rows}]` that are contiguous and non-empty, with resizes at the same offset
collapsed to the last one and offsets past `totalBytes` dropped. xterm resizes before writing each
segment.

### D19 — Editor: Monaco

- **Choice.** `monaco-editor` 0.57.0 (MIT) with `@monaco-editor/react` 4.7.0 (MIT), chosen over
  CodeMirror 6 at the owner's request. It gives the VS Code look the IDE layout aims at, find and
  replace, multi-cursor, a minimap, a read-only mode, and a built-in diff editor for the later diff
  UI (NFR-1).
- **Offline (NFR-2).** `@monaco-editor/react` loads Monaco from a CDN by default. `ide/monaco-setup.ts`
  must call `loader.config({ monaco })` with the locally imported `monaco-editor`. The editor worker
  is imported through Vite's `?worker` and set as `self.MonacoEnvironment.getWorker`.
- **Size.** Only `editor.worker` is bundled. The TS, JSON, CSS and HTML language-service workers are
  not: syntax highlighting (Monarch) works for every built-in language without them. Monaco is a
  lazy chunk loaded on the first file tab, so the workspace list and login stay light.
- **Language.** Matched from the file name with `monaco.languages.getLanguages()` (`extensions`,
  `filenames`), falling back to `plaintext`.
- **Theme and options.** Theme `vs` (light, NFR-1a); `automaticLayout: true`,
  `minimap.enabled: true`, `readOnly` for files that are not editable text.
- **Save.** Ctrl+S is bound with `editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, save)`.
- **Preview.** Plain text only for now (owner, 2026-11-13); HTML and SVG open in Monaco as code.
- **Not chosen for the alpha:**
  - `@codingame/monaco-vscode-api` 39.x (MIT; VS Code workbench services: explorer, file
    service). It is tied to VS Code internals, and its explorer would replace the tree, drag and
    drop, and commit-on-save flows the requirements define. Revisit for extensions or LSP.
  - `modern-monaco` 0.4.2: an early wrapper.

  Evidence: [research/editor-choice.md](research/editor-choice.md).

### D20 — Licences

- **Allowed.** Work Hub's own dependencies (Rust crates, the web and test npm packages) may only
  use permissive licences: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Zlib, 0BSD,
  Unicode-3.0, Unicode-DFS-2016, CDLA-Permissive-2.0, CC0-1.0, and `OR` / `AND` combinations of
  these.
- **Forbidden.** GPL, LGPL, AGPL, SSPL, BUSL, MPL and any paid or "commercial" licence.
- **Check.** `scripts/license-check.mjs` fails the `lint` script on any other licence and names
  the package. It reads `cargo metadata --format-version 1` and every installed package.json.
- **Checked at planning (2026-11-13).** All planned crates and packages are permissive: axum,
  tokio, tower-sessions(+sqlx-store), lettre, openidconnect, zip, rust-embed and jsonc-parser are
  MIT; bollard is Apache-2.0; sqlx, argon2 and tar are MIT/Apache-2.0; deunicode is BSD-3-Clause;
  monaco-editor, @monaco-editor/react and the @xterm packages are MIT.
- **Default container image.** It is not a dependency of the Work Hub binary. It is built on the
  user's machine and contains separately licensed programs that Work Hub runs but does not link:
  Ubuntu packages including git (GPL-2.0, unmodified, used as a separate program), and the Claude
  Code CLI under Anthropic's own terms. The README and the KB article state this.

### D18 — Shared server interfaces (seams between chunks)

```rust
// state.rs (fields listed in D16 "AppState final fields")
pub enum ImageStatus { Building, Ok, Failed(String) }        // API: "building" | "ok" | "failed"
// locks.rs
impl ContainerLocks { pub async fn lock(&self, container: &str) -> tokio::sync::OwnedMutexGuard<()>; }
// agent/mod.rs
impl AgentRegistry { pub fn get(&self, id: &str) -> Option<Arc<dyn AgentAdapter>>; }
// workspaces/repo.rs — row struct used by every service
pub struct WorkspaceRow { id: Uuid, user_id: i64, name: String, working_branch: String, agent: String,
  state: String, container_user: Option<String>, container_uid: Option<i32>, container_gid: Option<i32>,
  home_dir: Option<String>, base_image: Option<String>, checkpoint_seq: i32, checkpoint_image: Option<String>,
  login_state: String, login_at: Option<OffsetDateTime>, configure_started_at: Option<OffsetDateTime>, created_at: OffsetDateTime }
// workstreams/repo.rs
pub struct WorkstreamRow { id: Uuid, workspace_id: Uuid, name: String, branch: String, base_branch: String,
  state: String, agent_session_id: Uuid, opened_at: OffsetDateTime, closed_at: Option<OffsetDateTime>,
  merged_at: Option<OffsetDateTime>, discarded_at: Option<OffsetDateTime> }
// workspaces/mod.rs
pub async fn ensure_workspace_container(st: &AppState, ws: &WorkspaceRow) -> Result<String /*container name*/, ApiError>;
pub async fn apply_profile_patch(st: &AppState, container: &str, ws: &WorkspaceRow, workdirs: &[&str]) -> Result<(), ApiError>;
// workstreams/mod.rs
pub async fn ensure_workstream_running(st: &AppState, ws: &WorkspaceRow, s: &WorkstreamRow) -> Result<String, ApiError>;
// fs/mod.rs
pub struct ViewCtx { container: String, root: &'static str /* "/workspace/repo" | "/workspace/worktree" */, user: String, uid: i32, gid: i32 }
pub async fn resolve_view(st: &AppState, user_id: i64, ws_id: Uuid, view: &str) -> Result<ViewCtx, ApiError>;
// terminal/hub.rs
impl TerminalHub {
  pub fn register(&self, key: (String, String)) -> (ConnId, tokio::sync::mpsc::Receiver<HubEvent>); // a newer register sends TakenOver to the older one
  pub fn unregister(&self, key: &(String, String), id: ConnId);
  pub fn notify(&self, key: &(String, String), ev: HubEvent);   // HubEvent::{TakenOver, Ended{logged_in: Option<bool>}, Error(String)}
}
```

### D21 — File area (FR-5g, AC-3b; owner's decision 2026-11-13, added after chunk 24)

Supersedes the "named volumes, never host paths" parts of D5, D9, D10 and D15.

- **Volumes are host folders.** Every repo and home volume is still a named volume (same names,
  labels, mounts and helper copy), but created with the `local` driver and
  `type=none,o=bind,device=<folder>`. Docker's copy-up of the image's home into an empty volume
  still happens (checked on Docker Desktop).
- **Layout** under `WORK_HUB_DATA_DIR` (module `src/files.rs`):
  `users/<email>/<workspace slug>-<id6>/{workspace,home,workspace.json}` and
  `<workspace folder>/workstreams/<workstream slug>-<id6>/{workspace,home,workstream.json}`.
  `workspace/` is the repo volume (mounted at `/workspace`), so git is `workspace/repo` and a
  workstream's worktree `workspace/worktree`. The email folder keeps `[a-z0-9._@+-]`, other
  characters become `_`. Migration `0002_files_dir.sql` stores the relative folder in
  `workspaces.files_dir` / `workstreams.files_dir`, so a later change of the naming rule never
  loses existing folders.
- **Engine path.** `WORK_HUB_DOCKER_DATA_DIR` = the data dir as the Docker Engine sees it; default
  the absolute data dir, with a Windows drive path mapped to Docker Desktop's
  `/run/desktop/mnt/host/<drive>/…`.
- **Who touches the folders.** The server creates the folders and writes the JSON metadata
  (on create/open, branch change and every workstream state change); the containers write the
  contents (`prepare_dirs` chowns them to the container user and sets `home/` to 0700); deletion
  runs `rm -rf` in a root helper container with the parent bind-mounted, then the server removes
  what is left. Only paths under `users/` with plain segments are accepted.
- **Lifecycle.** Removing a volume never deletes its folder: folders are removed on workspace
  delete, workstream discard / merged elsewhere, a failed create/open (undo step `Folder`) and the
  reconciler's stale cleanup. When a volume is missing but its folder exists, the ensure paths
  re-create the volume.
- **Dockerized.** Compose binds `${WORK_HUB_FILES:-/srv/workhub}` to `/data` and passes
  `WORK_HUB_DOCKER_DATA_DIR=${WORK_HUB_FILES_ENGINE:-${WORK_HUB_FILES:-/srv/workhub}}`; the
  `workhub-data` volume is gone.
- **Inline dev DB.** Work Hub uses its own database (`workhub`), never Log Hub's (owner,
  2026-11-13).

### D22 — No CSS framework; agent self-update off; logout (owner, 2026-11-14)

- **Styles.** Tailwind is removed (its compiler lightningcss is MPL-2.0, which compliance forbids;
  no MPL exception in `license-check.mjs`). `src/app.css` holds the tokens (`--color-*`, status
  tints, radii, shadows, `--focus-ring`) and a small reset; every component has a
  `<Component>.module.css`. `src/ui/*` primitives wrap their selectors in `:where()` so a caller's
  class always wins. Supersedes the Tailwind parts of D16 and Dependencies.
- **Disk.** The adapter gets `container_env()` (Claude: `DISABLE_AUTOUPDATER=1`, under the
  definition's `containerEnv`) — otherwise the CLI downloads ~350 MB into every workstream home —
  and `disposable_home_paths()` (Claude: `.local/share/claude`, `.local/bin/claude`,
  `.local/state/claude`, `.claude/cache`, `.cache`), deleted by a root helper after "Bring into
  main" and "Close for now". `GET …/workstreams?disk=1` adds `diskBytes` per workstream (folder
  walk); History shows it as "On disk".
- **Logout.** Adapter `logout_command()` (Claude: `claude auth logout`); `POST
  /api/v1/workspaces/{id}/login/logout` → `{loggedIn}` runs it in the workspace container and
  refreshes `login_state`; Settings has "Log out of <agentName>" with a confirmation. Open
  workstreams keep their copy until closed.
- **Cookie.** `COOKIE_SECURE` unset → `Secure` always, as in Log Hub (`TRUST_PROXY` still wins).

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `work-hub/Cargo.toml`, `work-hub/rust-toolchain.toml`, `work-hub/.gitignore`, `work-hub/package.json`, `work-hub/.env.example`, `work-hub/README.md` | workspace, toolchain, scripts, env, self-contained run docs | D1, D2, D15 |
| `work-hub/server/Cargo.toml`, `src/main.rs`, `src/lib.rs`, `src/config.rs`, `src/db.rs`, `src/error.rs`, `src/state.rs`, `src/locks.rs` | server skeleton | D2, D4, D9 |
| `work-hub/server/migrations/0001_init.sql` | schema | Database changes |
| `work-hub/server/src/auth/{mod,startup,password_policy,password_hash,local_request,backoff,rate_limit,sessions,extract,users,tokens,mailer,azure,routes}.rs` | auth port | D3 |
| `work-hub/server/src/docker/{mod,names,containers,exec,archive,volumes,images}.rs` | Engine API layer | D5, D6, D10 |
| `work-hub/server/src/devcontainer.rs` | subset parser | D6 |
| `work-hub/server/src/agent/{mod,claude}.rs` | adapter trait and Claude | D7 |
| `work-hub/server/src/names.rs`, `src/repo_path.rs`, `src/git.rs` | name, branch and path algorithms; git command helpers | D8 |
| `work-hub/server/src/workspaces/{mod,repo,login,configure}.rs` | workspace service, login, configure session | D7, D9, D11 |
| `work-hub/server/src/workstreams/{mod,repo,close,reconciler}.rs` | workstream service | D10 |
| `work-hub/server/src/terminal/{mod,tmux,bridge,hub,recording,watchers}.rs` | terminals | D11 |
| `work-hub/server/src/timing.rs` | timing constants | D4 |
| `docs/changelog/<YYYY-MM-DD-HHmm>-work-hub-alpha.md` | changelog entry (changelog skill) | CLAUDE.md |
| `work-hub/server/src/fs/{mod,poll,transfer}.rs` | file service | D12 |
| `work-hub/server/src/api/{mod,system,workspaces,fs,workstreams,terminals,static_files,security_headers}.rs` | HTTP layer | API changes, D13 |
| `work-hub/server/tests/algo.rs` | algorithm table tests (Rust) | Test coverage plan |
| `work-hub/server/tests/contract/{main,harness,registry,auth,workspaces,fs,workstreams}.rs` | contract tests | D13 |
| `work-hub/image/{Dockerfile,tmux.conf}` | default devcontainer image | D6 |
| `work-hub/web/{package.json,vite.config.ts,tsconfig.json,eslint.config.js,index.html}` | SPA tooling | D16 |
| `work-hub/web/src/{main.tsx,App.tsx,app.css}`, `src/api/{client,auth,workspaces,fs,workstreams}.ts`, `src/auth/{AuthContext.tsx,useAuthConfig.ts}` | SPA core | D16 |
| `work-hub/web/src/ui/{button,dialog,confirm-dialog,input,card,tooltip,popover,dropdown-menu,select,toast}.tsx` | UI primitives (copied plus new) | D16 |
| `work-hub/web/src/pages/login/{LoginPage,IdentifyForm,PasswordLoginForm,AzureSignInButton}.tsx`, `pages/signup/SignupPage.tsx`, `pages/confirm/ConfirmEmailPage.tsx`, `pages/password/{ForgotPasswordPage,ResetPasswordPage,ChangePasswordDialog}.tsx` | auth pages | D3 |
| `work-hub/web/src/pages/workspaces/{WorkspacesPage,NewWorkspaceDialog,DeleteWorkspaceDialog}.tsx`, `src/pages/settings/SettingsPage.tsx`, `src/layout/{TopBar,DockerStatusGate}.tsx` | workspace list and settings | Visual/UX |
| `work-hub/web/src/ide/{FileTree,tree-model,useFsPoll,dnd,TabBar,tabs-store,EditorTab,monaco-setup,ImageTab,BinaryTab,ChangedOnDiskBanner,OverwriteDialog}.ts(x)` | IDE | D12, D19 |
| `work-hub/web/src/terminal/{TerminalView,terminal-socket,xterm-theme,replay,ReplayView}.ts(x)` | terminal | D11, D16, D17 |
| `work-hub/web/src/pages/workspace/{WorkspacePage,WorkstreamSwitcher,OpenWorkstreamDialog,CloseWorkstreamDialog,AgentLoginDialog,LoginTab,ConfigureTab}.tsx`, `src/pages/history/HistoryPage.tsx` | workspace page and flows | Visual/UX |
| `work-hub/web/src/terminal/replay.algo.test.ts` | algorithm table test (vitest) | D17 |
| `work-hub/Dockerfile`, `work-hub/.dockerignore`, `work-hub/deploy/{docker-compose.yml,.env.example}` | dockerized run | D15 |
| `work-hub/scripts/{dev.mjs,image.mjs,scenarios.mjs,contract.mjs,agent-names-check.mjs,license-check.mjs}` | orchestration; AC-2 lint guard; licence check | D14, D15, D20, Test coverage plan |
| `work-hub/tests/{playwright.config.ts,tsconfig.json}`, `work-hub/tests/fake-agent/{Dockerfile,claude.mjs}`, `work-hub/tests/scenarios/{fixtures.ts,s-wh-auth,s-wh-workspace,s-wh-files,s-wh-workstream,s-wh-close}.spec.ts` | scenario suite | D14 |
| `docs/knowledgebase/algorithms/{workhub-names,workhub-repo-path,workhub-devcontainer-subset,workhub-terminal-replay}.md`, `docs/algorithm-examples/` (same names `.json`) | new algorithm docs and rows | Test coverage plan |
| `docs/knowledgebase/algorithms/{password-policy,login-backoff,auth-startup-config,local-request-detection}.md`, `algorithms/README.md`, `docs/knowledgebase/twins-and-cross-cutting-rules.md` | list the Rust twins | D3 |
| `docs/knowledgebase/work-hub.md`, `docs/knowledgebase/index.md` | Work Hub KB article | AC-29 |
| `CLAUDE.md` | Work Hub commands and test policy | NFR-5 |
| `.claude/repo_config/repo-health-checks.json` | Work Hub checks | NFR-5 |
| `.github/workflows/checks.yml` | `work-hub-fast` job | NFR-5 |

## API changes

All JSON. All routes need the session cookie except `GET /health`, the auth routes marked public in
Log Hub, and `GET /api/v1/system/status`. All ids are uuids except user ids.

**Auth** — `/api/v1/auth/*` and `/api/auth/callback` as in D3, with the same shapes as Log Hub
(`me` → `{id, email}`).

**System**
- `GET /health` → `{ok:true}`
- `GET /api/v1/system/status` → `{docker:"ok"|"unreachable", defaultImage:"ok"|"building"|"failed"}`

**Workspaces**

| Method, path | Request | Response |
|---|---|---|
| `GET /api/v1/workspaces` | — | `[{id, name, workingBranch, openWorkstreams, agent, loginState:"ok"\|"missing", loginAt, createdAt}]` |
| `POST /api/v1/workspaces` | `{name}` | 201 `Workspace` · 400 `invalid_name`/`duplicate_name` · 503 · 500 `create_failed` |
| `GET /api/v1/workspaces/{id}` | — | `Workspace & {branches:string[], configureActive:boolean, workstreams: WorkstreamSummary[]}` — `workstreams` lists open ones; this call runs the live login check |
| `PATCH /api/v1/workspaces/{id}` | `{workingBranch}` | 200 `Workspace` · 400 · 409 `working_tree_busy` |
| `DELETE /api/v1/workspaces/{id}` | — | 204 |
| `GET /api/v1/workspaces/{id}/login/sources` | — | `[{id, name, loginAt}]` |
| `POST /api/v1/workspaces/{id}/login/copy` | `{fromWorkspaceId}` | `{loggedIn}` |
| `POST /api/v1/workspaces/{id}/login/start` | — | 204 |
| `POST /api/v1/workspaces/{id}/login/cancel` | — | 204 |
| `POST /api/v1/workspaces/{id}/configure` | — | 204 · 409 `configure_running`/`login_required` |
| `POST /api/v1/workspaces/{id}/configure/finish` | — | `{checkpointSeq}` |
| `GET /api/v1/workspaces/{id}/workstreams` | — | `WorkstreamSummary[]`, every state |
| `POST /api/v1/workspaces/{id}/workstreams` | `{name}` | 201 `WorkstreamSummary` · 400 · 409 `login_required` · 500 `open_failed` |

- `Workspace` = `{id, name, workingBranch, openWorkstreams, agent, agentName, loginState, loginAt, createdAt}` (`agentName` from the adapter's `display_name`).
- `WorkstreamSummary` = `{id, name, state:"open"|"closed"|"done"|"discarded", baseBranch,
  openedAt, closedAt, mergedAt, discardedAt, available:boolean}`.
- Error codes: `PATCH` → 400 `unknown_branch`; `login/copy` → 400 `invalid_login_source`;
  `login/start` is idempotent (D11). Dates are ISO-8601 strings.

**Files** (`{view}` = `main` | workstream id; prefix `/api/v1/workspaces/{id}/views/{view}/fs`)

| Method, path | Request | Response |
|---|---|---|
| `GET …/list?dir=` | — | `{entries: Entry[]}` · 404 when the dir is missing |
| `POST …/poll` | `{dirs:string[], files:string[]}` | `{dirs:{[dir]: Entry[] \| null}, files:{[path]: string \| null}}` (version or null) |
| `GET …/file?path=` | — | raw bytes; headers `ETag: "<version>"`, `X-WorkHub-Kind: text\|image\|binary` |
| `PUT …/file?path=` | raw text, `If-Match` | `{version}` · 409 `changed_on_disk {version}` · 400 `not_text` |
| `POST …/upload?dir=&overwrite=0\|1` | multipart `files` (filename = relative path) | `{paths}` · 409 `target_exists {paths}` |
| `POST …/move` | `{from, toDir, overwrite}` | `{path}` · 409 `target_exists` · 400 `invalid_path` |
| `GET …/download?path=` | — | attachment (folder → `.zip`) |

`Entry` = `{name, path (repo-relative), kind:"file"|"dir"|"symlink", size:number, mtime:number (epoch seconds)}`.

**Workstreams**

| Method, path | Request | Response |
|---|---|---|
| `POST /api/v1/workstreams/{id}/close/check` | — | `{uncommitted:string[], agentBusy:boolean}` |
| `POST /api/v1/workstreams/{id}/close` | `{mode:"bring_into_main"\|"merged_elsewhere"\|"for_now", force:boolean}` | `WorkstreamSummary` · 409 `uncommitted {paths}` / `merge_conflict` |
| `POST /api/v1/workstreams/{id}/discard` | — | `WorkstreamSummary` |
| `POST /api/v1/workstreams/{id}/reopen` | — | `WorkstreamSummary` · 409 `not_closed` |
| `POST /api/v1/workstreams/{id}/retry` | — | `WorkstreamSummary` · 503 `unavailable` |
| `GET /api/v1/workstreams/{id}/recording` | — | `application/octet-stream` (synced first when running) |
| `GET /api/v1/workstreams/{id}/recording/meta` | — | `{totalBytes, initial:{cols, rows}, resizes:[{offset, cols, rows}]}` |

**WebSockets** — D11.

## Database changes

New schema `WORK_HUB_DB_SCHEMA` (created by the server with `CREATE SCHEMA IF NOT EXISTS`, then
`sqlx::migrate!("./migrations")`, which takes its own advisory lock). Every table and column gets a
`COMMENT ON` (repo convention, `.claude/rules/db-migration.md`). Queries are runtime `sqlx::query_as`
(no compile-time DB).

| Table | Columns | Constraints and indexes |
|---|---|---|
| `users` | `id bigserial pk`, `email text not null`, `email_key text not null` (lower), `password_hash text null`, `email_confirmed_at timestamptz null`, `created_at timestamptz not null default now()` | `unique(email_key)` |
| `email_tokens` | `id bigserial pk`, `user_id bigint not null references users on delete cascade`, `kind text not null`, `token_hash text not null`, `expires_at timestamptz not null`, `used_at timestamptz null`, `created_at timestamptz not null default now()` | `check (kind in ('confirm','reset'))`, `unique(token_hash)`, index `(user_id)` |
| `auth_sessions` | created by `PostgresStore::migrate()` | — |
| `workspaces` | see the column list below | see the list below |
| `workstreams` | see the column list below | see the list below |
| `terminal_recordings` | `workstream_id uuid pk references workstreams on delete cascade`, `file_name text not null`, `synced_bytes bigint not null default 0`, `initial_cols int not null default 120`, `initial_rows int not null default 32`, `updated_at timestamptz not null default now()` | — |
| `terminal_resizes` | `id bigserial pk`, `workstream_id uuid not null references workstreams on delete cascade`, `byte_offset bigint not null`, `cols int not null`, `rows int not null`, `created_at timestamptz not null default now()` | index `(workstream_id, byte_offset)` |

**`workspaces` columns:**
- `id uuid pk`, `user_id bigint not null references users on delete cascade`;
- `name text not null`, `name_key text not null`, `working_branch text not null default 'main'`;
- `agent text not null default 'claude'`, `state text not null`;
- `container_user text null`, `container_uid int null`, `container_gid int null`,
  `home_dir text null` (filled before `ready`, D6);
- `base_image text null` (filled before `ready`), `checkpoint_seq int not null default 0`, `checkpoint_image text null`;
- `login_state text not null default 'missing'`, `login_at timestamptz null`;
- `configure_started_at timestamptz null`, `created_at timestamptz not null default now()`.

**`workspaces` constraints:** `unique(user_id, name_key)`,
`check (state in ('creating','ready'))`, `check (login_state in ('missing','ok'))`.

**`workstreams` columns:**
- `id uuid pk`, `workspace_id uuid not null references workspaces on delete cascade`;
- `name text not null`, `name_key text not null`, `branch text not null`, `base_branch text not null`;
- `state text not null`, `agent_session_id uuid not null`;
- `opened_at timestamptz not null default now()`, `closed_at`, `merged_at`, `discarded_at`
  (all `timestamptz null`);
- `created_at timestamptz not null default now()`.

**`workstreams` constraints:**
`check (state in ('opening','open','closed','done','discarded'))`; partial unique index
`(workspace_id, name_key) where state <> 'discarded'`; `unique(workspace_id, branch)`.

Rows in `creating`/`opening` are hidden from every list.

## Dependencies

**Rust** (`work-hub/server/Cargo.toml`, `Cargo.lock` committed):

| Crate | Version | Features |
|---|---|---|
| axum | 0.8.9 | `ws`, `multipart` |
| tokio | 1.54.1 | `full` |
| tokio-util | — | `io` |
| bollard | 0.21.1 | — |
| sqlx | 0.8.6 (chunk 1: sqlx 0.9.0 requires Rust 1.94, the toolchain is pinned at 1.92; one sqlx in `Cargo.lock`) | `runtime-tokio`, `postgres`, `uuid`, `time`, `migrate`, `macros` |
| tower-sessions | 0.15.0 | `signed` |
| tower-sessions-sqlx-store | 0.15.1 (the last release on sqlx 0.8 with tower-sessions-core 0.15; 0.16 needs sqlx 0.9) | `postgres` |
| tower-http | 0.7.1 | `trace`, `set-header`, `compression-br`, `compression-gzip` |
| argon2 | 0.6.0 | — |
| lettre | 0.11.23 | `tokio1-rustls-tls`, `builder`, `smtp-transport` |
| openidconnect | 4.1.0 | `reqwest` (rustls) |
| jsonc-parser | 0.34.0 | `serde` (devcontainer JSONC) |
| deunicode | 1.6.2 | — |
| tar | 0.4.46 | — |
| zip | 9.5.1 | — |
| sha1, sha2 | — | — |
| rust-embed | 8.14.0 | — |
| dotenvy | 0.15.7 | — |
| uuid | 1.29.2 | `v4`, `serde` |
| time | — | — |
| serde, serde_json, futures-util, thiserror, tracing, mime_guess, rand | — | — |
| tracing-subscriber | 0.3.23 | — |

**Web** (`work-hub/web/package.json`):
- copies of the client's locked versions: react 19.3.0, react-dom, react-router-dom 7.18.4,
  @tanstack/react-query 5.104.2, radix-ui 1.8.1, lucide-react 0.577.0, tailwindcss 4.3.3,
  vite 7.3.7, typescript 5.9.3, eslint 9.39.5, vitest 4.1.12;
- build tooling as in the client: `@vitejs/plugin-react`, `@tailwindcss/vite`, `@types/react`,
  `@types/react-dom`, the client's eslint plugins (versions from `client/package.json`);
- new: monaco-editor 0.57.0, @monaco-editor/react 4.7.0, @xterm/xterm 6.0.0,
  @xterm/addon-fit 0.11.0, @xterm/addon-clipboard 0.2.0, @xterm/addon-web-links 0.12.0.

**Tests** (`work-hub/package.json`): `@playwright/test` at the root's version and typescript 5.9.3.

## Test coverage plan

The project's three kinds only (CLAUDE.md, Test policy). Work Hub's commands are its own (NFR-5).

**Algorithm.**
- **New docs**, each with its rows file `docs/algorithm-examples/<name>.json` and a table test:
  - `workhub-names` (display-name validation, uniqueness key, branch slug with clashes, covering
    AC-21a's 100/101 chars, Cyrillic and clashing slugs);
  - `workhub-repo-path`;
  - `workhub-devcontainer-subset`.

  These three run in `work-hub/server/tests/algo.rs`, which reads the rows files through
  `CARGO_MANIFEST_DIR/../../docs/algorithm-examples`.
- **New doc** `workhub-terminal-replay` runs in `work-hub/web/src/terminal/replay.algo.test.ts`
  (vitest).
- **Existing docs, extended:** `password-policy`, `login-backoff`, `auth-startup-config` and
  `local-request-detection` get Work Hub's Rust port listed as a twin. `tests/algo.rs` runs their
  **existing** rows against the port, with no new rows.

**API contract.**
- Every Work Hub route gets a row in `work-hub/server/tests/contract/registry.rs`; the meta-test
  compares it with `ROUTE_TABLE`.
- Generic checks: 401 without a session (AC-6), 404 across users (AC-5).
- Shape tests per family (auth, workspaces, fs, workstreams).
- The Log Hub contract registry is untouched: it covers only Log Hub's NestJS routes.

**Where these tests live.** NFR-5 puts Work Hub's tests inside `work-hub/`. Its contract registry
(`work-hub/server/tests/contract/registry.rs`) and its scenarios (`work-hub/tests/scenarios/`) are
Work Hub's counterparts of `server/test/contract/registry/` and `tests/scenarios/`. CLAUDE.md is
updated to say so (chunk 19).

**Coverage.** The ≥ 80 % scenario-coverage target is not measured for the Rust server in the
alpha (no `cargo-llvm-cov`). The KB article lists it as a follow-up.

**Scenario.** New files, because this is a new feature that no existing scenario covers, under
`work-hub/tests/scenarios/`, run by Work Hub's stand (D14) with the fake agent. "Fake login" below
means: `AgentLoginDialog` → New login → in the terminal press Enter on the menu and type
`good-code` + Enter.

**`s-wh-auth.spec.ts` `@S-WH-01`** (modes a, b, c):
1. The login page shows the email-only form in mode a, and email + password with a sign-up link
   in b and c (AC-6).
2. `GET /api/v1/workspaces` without a cookie → 401.
3. Mode b: sign up → the Mailpit link confirms → log in. Mode c: sign up → log in.
4. Mode a: `GET /api/v1/auth/me` for an email never used in Work Hub returns that user only after
   identify, and the `users` table had no row before.

**`s-wh-workspace.spec.ts` `@S-WH-02`** (mode a):
1. Create a workspace. The tree shows `.gitignore` and `.devcontainer/`; the switcher shows
   `main (working branch)`; no clone option exists; `git log` (Docker CLI exec) shows one commit
   holding `.gitignore` (AC-8, AC-9).
2. Name errors: empty, 101 chars and a duplicate each show the D8 message (AC-8).
3. The first workspace's login dialog has no "Copy from my workspace". Fake login → the workspace
   shows no login banner after a reload and after `restart-server` (AC-19, AC-20).
4. A second workspace offers copy from the first; after copying, `claude auth status` exits 0 in
   its container (AC-20).
5. A third workspace: "Not now". Files open and save; "Open workstream" shows the login dialog
   (AC-20b).
6. `docker commit` of the workspace container (CLI) → a `docker run` of that image has no
   `/workspace/repo` and no `.credentials.json` (AC-20c).
7. The fake agent `logout` in a workstream of workspace 1, plus removing the workspace's
   credentials file (CLI) → reopening the workspace shows the login banner (AC-20c).
8. Settings: create branch `draft` via the CLI with a distinct file, select it, Save → the tree
   shows that file; switch back to `main` (AC-10).
9. A second user (identify as another email) sees no workspaces, and gets 404 on user 1's
   workspace, view and workstream URLs (AC-5).
10. Delete with Cancel → nothing changes. Delete with confirm → the list no longer has it, and no
    container, volume or image with its uuid remains (CLI) (AC-8a).
11. Throughout: every request URL starts with the stand origin (AC-30), and `body` and the
    terminal background compute to `rgb(255, 255, 255)` (AC-31).

**`s-wh-files.spec.ts` `@S-WH-03`** (mode a, a logged-in workspace):
1. Click a file → a tab opens with its content; click again → the same tab is focused (AC-11).
2. Edit, Save → `git show --stat HEAD` lists only that file and other uncommitted files stay
   (CLI). A reload shows the new content. There is a single Save button (AC-12, AC-12a).
3. An uploaded PNG opens in an image tab with no editor (AC-12).
4. With a clean tab, change the file via the CLI → the tab reloads within 5 s. With a dirty tab:
   the banner appears, Save is blocked until "Keep mine" / "Take theirs", and each works (AC-12b).
5. In a workstream, the fake agent `make notes.md x` → the workstream view shows it and the
   working-branch view does not (AC-15).
6. Drop a file and a folder (Playwright `DataTransfer`) on a folder → both appear without a
   reload, in one commit; dropping the same name again → the overwrite dialog; Cancel changes
   nothing (AC-16, AC-16a).
7. Drag a file from the tree: the `dragstart` data holds `DownloadURL`. The "Download" menu saves
   the file, and a folder as `.zip` (AC-17).
8. Drag a file onto another folder → moved in one commit, and its open tab shows the new path
   (AC-18).

**`s-wh-workstream.spec.ts` `@S-WH-04`** (mode a, a logged-in workspace):
1. Configure → the fake agent `install tool-a` → Finish → a toast. A second Configure while one
   runs → the "already running" message; no rollback control exists (AC-20d).
2. Open workstream A → the chat tab is first, has no close button and stays first after file
   tabs open and close; `/opt/tool-a` exists in A's container (AC-3, AC-14, AC-21, AC-20d).
3. Save a file on the working branch → absent in A. Run Configure with `install tool-b` → absent
   in A; open B → present in B (AC-3, AC-20d).
4. A 100-char Cyrillic/punctuation name works; 101 is rejected; two names with the same slug get
   `ws/<slug>` and `ws/<slug>-2` (CLI); empty and duplicate are rejected (AC-21, AC-21a).
5. In A: `make a.txt` and `busy 30` → `a.txt` and the process are absent in B and in the
   workspace container (CLI `ps`). Close B for now → A's chat keeps working (AC-4).
6. The switcher lists the working branch, A and B, and switches the tree (AC-13). The first
   message in every workstream is answered with no login (AC-20a).
7. Chat: typed text echoes. `ask` → arrows move, Enter answers, Esc cancels. The xterm buffer
   holds the ANSI colour cells. A viewport resize changes the cols reported by `tput cols` run via
   the fake agent. Copy and paste through the xterm selection API (AC-22, AC-22a). No UI control
   starts a second chat (AC-22).
8. `busy 40`, then a page reload → the same spinner continues; `restart-server` → the same pane
   PID (CLI) and output continues (AC-22b).
9. Stop all instance containers (CLI) and run `restart-server` → A runs again with `recall`
   answering the earlier message; closed B stays stopped (AC-22c).
10. Open A in a second page → the first page shows the takeover overlay (AC-22d).
11. `run sh -c "echo done > out.txt"` → the chat shows `Run finished: exit 0`; `out.txt` appears
    in the tree without a reload, opens and downloads. No iframe exists on the page (AC-23,
    AC-23a).
12. Remove the latest checkpoint image (CLI) and open C → a plain error with "Try again", and no
    C row, branch, volume or container is left (AC-3a). A workstream whose container was removed
    (CLI) shows "Unavailable", and its history still replays (AC-3a).
13. After `restart-server`, History replays A, the closed B and a discarded D in full, with
    colours (AC-27, AC-28).

**`s-wh-close.spec.ts` `@S-WH-05`** (mode a):
1. An uncommitted `make x.txt` → every close option first lists `x.txt`; "Back to chat" leaves it
   open (AC-24).
2. During `busy 20`, Close asks for confirmation first (AC-24).
3. `commit` → Bring into main → the working-branch view shows the files; the state is closed and
   reopenable (AC-24).
4. A conflict: the working branch and a reopened workstream change the same line → Bring into
   main shows the conflict message, `main` is unchanged, the workstream is still open and has the
   new main. The fake agent `run git merge main` + `commit` → Bring into main succeeds (AC-24).
5. Already merged elsewhere → the working branch is unchanged; the container and volumes are
   gone (CLI); the state is done in History with no Reopen (AC-24a).
6. Close for now → no branch changed; Reopen shows the earlier terminal output, the files are in
   place, and `recall` answers (AC-24a, AC-26).
7. Discard: Cancel → nothing changes; confirm → the branch, worktree and container are gone; no
   Reopen (AC-25, AC-26).
8. AC-7 walk: create a workspace, log in, open "Q3 dashboard", ask in plain words via the fake
   agent (`make dashboard.html …`, `run …`), view the result, Download it, Bring into main — using
   only buttons and chat text.

**Static checks.** AC-2 is checked by the `work-hub-lint` check: `scripts/agent-names-check.mjs`
fails when `claude` (any case) appears in `server/src/**/*.rs` outside `agent/claude.rs` and
`agent/mod.rs`, or anywhere in `web/src/**`. UI copy uses `agentName` from the API. `image/`,
`tests/` and docs are not scanned. AC-29 is met by the CLAUDE.md section, the KB article and the
health-check entries.

**Manual, before done** (workcycle visual check, not a test file): one walk of AC-7, AC-19 and
AC-20 with the real Claude CLI and a real login, plus AC-1a with `docker compose up` and the inline
start.

**Unchanged.** Log Hub's health checks must pass (AC-32).

## Visual/UX notes

- Light theme only. The header layout follows the wireframes: "Artisyn AI Work Hub › <crumb>",
  History, Settings, the wrench "Configure" (working-branch view only) and the user menu ("Edit
  email" under mode `none`, "Logout" otherwise, as in Log Hub).
- **Workspaces list:** cards (name, "<working branch> · <n> open workstreams", Open, Delete…) and
  a "New workspace" button. Empty state: "No workspaces yet. Create one to start."
- **Login banner** (amber) on a workspace without a login: "This workspace needs a <agentName>
  login." with a "Log in" button.
- **Unavailable chip:** "<name> · Unavailable" with a "Try again" button, plus a tooltip "Its
  container could not be started."
- **Switcher row** above the tabs: the chip `<working branch> (working branch)`, one chip per open
  workstream (an amber "Unavailable" chip with "Try again" when `available:false`) and
  "+ Open workstream".
- **Tab row:** the pinned "Chat · <name>" first, with no close control and not draggable; file
  tabs to its right; Login and Configure tabs are pinned-left service tabs while active. A dirty
  tab shows a dot; Save is `Ctrl+S` or the button.
- **Long operations** (create workspace ~3–10 s, open workstream ~3 s, bring into main) show a
  dialog spinner with "Preparing…" or "Bringing your work into main…"; errors show the plain
  `message` plus "Try again".
- **Close dialog** (follows FR-29, superseding the wireframe):
  - first the uncommitted list ("The agent has not saved these files yet:") with "Back to chat" /
    "Close anyway";
  - then three options: "Bring into main" (primary), "Already merged elsewhere" and "Close for
    now";
  - a separate red "Discard…" with its own confirmation.

  No git terms appear except the working-branch name.
- **History:** a table of name, state chip (open / closed / done / discarded), "added to main"
  when `mergedAt`, and opened and closed dates. Selecting a row shows the read-only replay;
  "Reopen" only for `closed`.
- **Docker unreachable:** a full-page plain message ("Work Hub can't reach Docker on this
  computer…") instead of the workspace page. While the image builds: "Work Hub is preparing its
  container image…".
- **Drop target:** blue dashed outline plus a "Drop to upload into <folder>" label. **Overwrite
  dialog:** lists the taken names, "Replace" / "Cancel".

## Wireframes

Not redrawn. Where they differ, the plan wins:
- `close-workstream-dialog.svg` → the Visual/UX close dialog;
- `workstream-history.svg` gains the *done* chip;
- `configure-session.svg` callout 4 is settled by D11;
- `file-tree-drag-drop.svg` has no Rename/Delete;
- `result-preview.svg` shows HTML as text (D12);
- `new-workspace-dialog.svg` shows "Start empty" only.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Scaffold and toolchain | 6 | creates `work-hub/` skeleton everything else builds on |
| 2 | Default container image | 4 | needed by server (embedded) and tests |
| 3 | Server core: config, DB, schema | 6 | after 1 |
| 4 | Auth port: algorithms and sessions | 7 | after 3 |
| 5 | Auth routes, email and Azure | 6 | after 4 |
| 6 | Docker layer | 7 | after 3 |
| 7 | Devcontainer, agent adapter, git helpers | 6 | after 6 |
| 8 | Workspace service | 6 | after 7 |
| 9 | Terminal layer and service sessions | 7 | after 8 |
| 10 | Workstream service | 7 | after 9 |
| 11 | File service | 6 | after 10 (view resolution uses workstream state) |
| 12 | HTTP API and wiring | 8 | after 5, 8–11 |
| 13 | Web foundation and auth pages | 7 | after 12 (API shapes per plan) |
| 14 | Terminal UI | 5 | after 13; used by login, configure and chat tabs |
| 15 | Workspaces list, login and settings UI | 5 | after 14 |
| 16 | IDE: tree, tabs, editor, DnD | 8 | after 15 |
| 17 | Workstream flows UI | 5 | after 16 |
| 18 | Run modes: dockerized and inline | 5 | after 17 |
| 19 | Docs and dev tooling | 5 | after 18 |
| 20 | Algorithm docs and table tests | 7 | after 19 |
| 21 | Scenario stand and fake agent | 5 | after 20; the fake-agent image is used by 22 and 23 |
| 22 | Contract tests | 6 | after 21 |
| 23 | Scenarios | 5 | after 22 |
| 24 | Health checks, CI and final verification | 5 | after 23; ends with the full run |

### Chunk 1 — Scaffold and toolchain
- [ ] Create `work-hub/Cargo.toml` (workspace, members `server`), `work-hub/rust-toolchain.toml` (1.92.0, rustfmt, clippy) and `work-hub/.gitignore` per D1.
- [ ] Create `work-hub/server/Cargo.toml` (package `work-hub-server`, edition 2024, version `0.1.0-alpha.1`, lib + bin) with the crates per Dependencies, and a `src/main.rs` printing the version; commit `Cargo.lock`.
- [ ] Create `work-hub/web/` Vite React TS app (package.json with versions per Dependencies, `vite.config.ts` dev port 5180 proxying `/api` with `ws:true` and no `changeOrigin` to 3100, `tsconfig.json`, `eslint.config.js` copied from `client/`, `index.html`, empty `src/main.tsx`).
- [ ] Create `work-hub/package.json` scripts: `build` (web build then `cargo build --release`), `lint`, `typecheck`, `test:algo`, `test:contract`, `test:scenarios`, `dev`, `start`, `image` — each calling the tools named in D1/D14/D15 (scripts in `work-hub/scripts/` arrive in later chunks).
- [ ] Create `work-hub/.env.example` with every D2 variable, default and one-line comment.
- [ ] Create `work-hub/README.md` stub: what Work Hub is, prerequisites (Docker Engine, Postgres, Rust 1.92, bun), and placeholders for run modes filled in chunk 18.

### Chunk 2 — Default container image
- [ ] Create `work-hub/image/Dockerfile` per D6 (ubuntu:24.04, user `workhub` 1000:1000 with passwordless sudo, packages, Node 26.13.1 and Claude Code binary pinned by version and sha256 copied from `docker-dev/Dockerfile:46-66`, `/etc/gitconfig`, `/etc/tmux.conf`, `CMD sleep infinity`).
- [ ] Create `work-hub/image/tmux.conf` with the terminal-bridge PoC's settings (`docs/pocs/2026-11-13-1906-workhub-terminal-bridge/image/tmux.conf`).
- [ ] Create `work-hub/scripts/image.mjs` (nodejs-script skill): `docker build -t artisyn-work-hub-default:<version from server/Cargo.toml> work-hub/image`; wire `npm run image`.
- [ ] Build the image with `npm run image` and confirm `claude --version`, `git`, `tmux -V`, `node -v` and `sudo -n true` work as `workhub` inside it.

### Chunk 3 — Server core: config, DB, schema
- [ ] `src/config.rs`: `Config::from_env()` reading every D2 var (dotenvy first), with defaults; auth fields are filled by chunk 4's startup validation.
- [ ] `src/db.rs`: Postgres pool whose `after_connect` sets `search_path` to `WORK_HUB_DB_SCHEMA`; `CREATE SCHEMA IF NOT EXISTS`; run `sqlx::migrate!("./migrations")`.
- [ ] `migrations/0001_init.sql`: all tables, constraints, indexes and `COMMENT ON` per Database changes (except `auth_sessions`).
- [ ] `src/error.rs`: `ApiError { status, code, message }` implementing `IntoResponse` as `{error, message}`, with constructors for every code in D4.
- [ ] `src/state.rs` (`AppState`: config, pool, docker client handle, agent registry, locks, terminal hub; fields added as later chunks land) and `src/locks.rs` (per-container `tokio::Mutex` map per D9).
- [ ] `src/api/mod.rs` skeleton with the `routes!` macro and `ROUTE_TABLE` per D13, `src/timing.rs` per D4; `src/main.rs`/`lib.rs`: tracing, config, DB init, axum on `HOST:PORT` with `GET /health` → `{ok:true}` declared through `routes!`; verify it starts against local Postgres.

### Chunk 4 — Auth port: algorithms and sessions
- [ ] `auth/startup.rs`: port `server/src/auth/config/auth-startup-validation.ts` (rules in `docs/knowledgebase/algorithms/auth-startup-config.md`); invalid config aborts startup with its message.
- [ ] `auth/password_policy.rs`: port `server/src/auth/utils/password-policy.ts` per `algorithms/password-policy.md`.
- [ ] `auth/backoff.rs` and `auth/rate_limit.rs`: in-memory ports of `server/src/auth/login-backoff.service.ts` and `auth-rate-limit.service.ts` with an injectable clock (rules in `algorithms/login-backoff.md`).
- [ ] `auth/local_request.rs`: port `server/src/auth/utils/localhost.util.ts` and `container-gateway.util.ts` per `algorithms/local-request-detection.md` (socket peer only).
- [ ] `auth/password_hash.rs`: Argon2id with the D3 parameters (hash, verify).
- [ ] `auth/sessions.rs`: tower-sessions `PostgresStore` (schema per D2, table `auth_sessions`, `migrate()` at startup), signed cookie `workhub.sid` with the D3 attributes.
- [ ] `auth/extract.rs` and `auth/users.rs`: `CurrentUser` extractor (401 `unauthorized`), auth-mode route guard (404 when the mode is off), auto-identify on `GET me` in mode `none` for local requests; users table access (find, create, confirm, set password, delete).

### Chunk 5 — Auth routes, email and Azure
- [ ] `auth/routes.rs`: `config`, `identify`, `signup`, `login`, `logout`, `me` with Log Hub's shapes and status codes (controller lines per D3), using backoff, rate limit and policy from chunk 4.
- [ ] `auth/tokens.rs` and `auth/mailer.rs`: hashed single-use confirm and reset tokens; lettre SMTP from `SMTP_*`; the SMTP reachability check at startup in `password-confirm` mode, as Log Hub does.
- [ ] Routes `confirm-email`, `resend-confirmation`, `forgot-password`, `reset-password`, `change-password` with links per D3.
- [ ] `auth/azure.rs`: `GET /api/v1/auth/azure` and `GET /api/auth/callback` via openidconnect, mirroring `server/src/auth/azure/` (authority, tenant check, `?oauthError=` redirect to `/#/login`).
- [ ] `delete-account` per D3 (`{confirm:"delete"}`, 204, cookie cleared): call `AccountCleanup::delete_user_data` (no-op until chunk 8), then delete the user. Declare every auth route through `routes!`.
- [ ] Run the server under `AUTH_MODE=none` and `password` and exercise `config`, `identify` / `signup` + `login`, `me` and `logout` with curl: expect 200s with the Log Hub shapes, 404 for off-mode routes, 401 for `me` after logout.

### Chunk 6 — Docker layer
- [ ] `docker/mod.rs`: bollard `connect_with_defaults` (honours `DOCKER_HOST`); `status()` ping → `ok`/`unreachable`; map connection errors to `docker_unavailable`.
- [ ] `docker/names.rs`: name and label builders per D5, including the instance label filter.
- [ ] `docker/containers.rs`: `create_and_start(spec)` per the D5 container config, `inspect`, `start`, `stop(timeout 10s)`, `remove(force)`, `list_by_labels`.
- [ ] `docker/exec.rs`: `exec_capture(container, user, argv, stdin: Option<bytes>, timeout)` → `{exit_code, stdout, stderr}`; `exec_stream_stdout` for bundles and recordings; `exec_tty(container, user, argv, env)` per D5 for terminals.
- [ ] `docker/archive.rs`: `get_file(container, path)` via the archive endpoint to a temp file in `<DATA_DIR>/tmp` and extract it; `put_files(container, dir, entries, uid, gid, mode)` building a tar.
- [ ] `docker/volumes.rs`: create with labels, remove, and `copy_volume(from, to)` with the helper container per D10 (the PoC recipe).
- [ ] `docker/images.rs`: `commit(container, repo, tag)`; `build_from_tar(tar, tag)`; `ensure_default_image()` building the embedded `work-hub/image/` (rust-embed) when missing and tracking `building|ok|failed` for `/api/v1/system/status`.

### Chunk 7 — Devcontainer, agent adapter, git helpers
- [ ] `devcontainer.rs`: `parse(jsonc: &str) -> Result<ContainerSpec, String>` for the D6 subset (comments and trailing commas allowed, the default-image sentinel, `postCreateCommand` string or array).
- [ ] `agent/mod.rs`: the `AgentAdapter` trait exactly as in D7 and a registry keyed by id.
- [ ] `agent/claude.rs`: the Claude implementation per D7, including `CONFIGURE_PROMPT`, the resume fallback command and the light-theme/onboarding/trust profile patch.
- [ ] `names.rs`: `validate_display_name`, `name_key`, `derive_branch(name, taken)` per D8 with the exact messages.
- [ ] `repo_path.rs`: `normalize(input) -> Result<String, ApiError(invalid_path)>` and `container_path(root, rel)` per D8.
- [ ] `git.rs`: argv builders and parsers for `status --porcelain=v1 -z`, `for-each-ref`, `bundle create`, `fetch`, `merge` (conflict detection by exit code plus `MERGE_HEAD`), `worktree add`, `hash-object`, all with `-c core.quotepath=off`.

### Chunk 8 — Workspace service
- [ ] `workspaces/repo.rs`: SQL for workspaces (insert creating, mark ready, get owned, list with open-workstream counts, update branch, login fields, configure fields, checkpoint fields, delete).
- [ ] `workspaces/mod.rs` `create(user, name)`: the D9 create sequence with the undo list, default `.gitignore` per D8, the default devcontainer, container user discovery (D6) and the postCreate checkpoint.
- [ ] `ensure_workspace_container(ws)` per D9 (recreate from the checkpoint or the definition, start when stopped).
- [ ] `set_working_branch`, `branches`, and `delete(ws)` per D9 (objects by labels, images, recording files, row); implement the chunk-5 account-deletion hook with it.
- [ ] `workspaces/login.rs`: live status check (adapter `status_command`, cache update), `copy_login(from, to)` (adapter `login_files` plus `copy_extra_keys` merge, mode 0600, uid/gid), `login_sources`.
- [ ] `apply_profile_patch(container, home, adapter, workdirs)`: read, merge and write `~/.claude.json`-style file per D7; call it at workspace creation for `/workspace/repo`.

### Chunk 9 — Terminal layer and service sessions
- [ ] `terminal/tmux.rs`: `ensure_session(container, user, name, cwd, argv, record_to: Option<path>)` per D11 (wait-for gate, pipe-pane), `has_session`, `pane_dead`, `respawn(argv)`, `kill`, `window_activity`, session names `chat|login|configure`.
- [ ] `terminal/hub.rs`: registry of live connections per `(container, session)` with takeover (send `taken_over`, close the old one) per D11.
- [ ] `terminal/bridge.rs`: WebSocket ↔ `exec_tty` per D11 frames (binary keys and output, JSON resize via `resize_exec`), first-line pty capture and `tmux detach-client` on close; `Origin` check helper.
- [ ] `terminal/recording.rs`: `sync(workstream)` (tail by offset → append to `<DATA_DIR>/recordings/<uuid>.raw`, update `synced_bytes`), `record_resize` (stat offset → `terminal_resizes`), `read_meta`.
- [ ] `terminal/watchers.rs`: the login watcher (2 s; on a dead pane: status check, cache update, kill, notify via the hub) and the configure watcher (5 s, resumed from `configure_started_at` at startup).
- [ ] Service sessions per D11: `workspaces/configure.rs` `start_configure` / `finish_configure` (kill, commit `wh-ckpt-<uuid>:<seq+1>`, update row, notify `ended`), and `workspaces/login.rs` `start_login` (idempotent `ensure_session` of `login`) / `cancel_login` (kill).
- [ ] A periodic task (30 s) syncing recordings of running open workstreams, started from `main.rs`.

### Chunk 10 — Workstream service
- [ ] `workstreams/repo.rs`: SQL for workstreams and recording rows (insert opening, set open/closed/done/discarded with timestamps, list by workspace excluding transient states, get owned through the workspace's user, taken branches).
- [ ] `workstreams/mod.rs` `open(ws, name)`: the D10 open sequence with the undo list, holding the workspace lock during the volume copy.
- [ ] `ensure_workstream_running(st)`: start the container, ensure `chat` with `resume_command`, respawn a dead pane; on failure mark `available:false` in an in-memory set.
- [ ] `workstreams/close.rs` `close_check` and `close(mode, force)` per D10, including bundle transfer, merge in place or in a temp worktree, and the conflict path bringing the base into the workstream.
- [ ] `discard`, `reopen` and `retry` per D10, each syncing the recording before stopping or removing.
- [ ] `workstreams/reconciler.rs`: startup plus 60 s loop per D10 (open ⇒ running with `chat`; stale `creating`/`opening` rows older than 10 min cleaned up).
- [ ] Manually open, close (each mode) and reopen one workstream against Docker with the default image and confirm the containers, volumes and branches match D10.

### Chunk 11 — File service
- [ ] `fs/mod.rs`: `resolve_view(user, ws, view)` → `(container, root, lock key)`; `not_open` for non-open workstreams; ensure the container is running.
- [ ] `list_dir` per D12 (find output parsed; directories first; `.git` hidden).
- [ ] `fs/poll.rs`: one exec script per D12 returning the requested listings and `git hash-object` versions (`-` for missing).
- [ ] `read_file` (archive get, kind detection per D12 and `MAX_EDITABLE_BYTES`, blob-sha version) and `save_file` (If-Match check, write, one-path commit per D12).
- [ ] `fs/transfer.rs` `upload` (overwrite check, tar with uid/gid, commit of non-ignored paths only) and `move_path` (overwrite check, `mv`, commit per D12) under the view's container lock.
- [ ] `download` (file stream; folder → zip in `<DATA_DIR>/tmp`, deleted after send).

### Chunk 12 — HTTP API and wiring
- [ ] `api/mod.rs`: declare every route below through `routes!`; assemble all routers, the session layer, tracing, and the default body limit disabled only on upload and save.
- [ ] `api/security_headers.rs`: the CSP per D16 plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin` on every response.
- [ ] `api/system.rs`: `/health` and `/api/v1/system/status` per API changes.
- [ ] `api/workspaces.rs`: every Workspaces route in API changes, calling the chunk-8 and chunk-9 services, returning the `Workspace` and `WorkstreamSummary` shapes (camelCase via serde).
- [ ] `api/fs.rs`: every Files route in API changes (`ETag`, `X-WorkHub-Kind`, `If-Match`, multipart, attachment `Content-Disposition` with an RFC 5987 filename).
- [ ] `api/workstreams.rs` and `api/terminals.rs`: Workstreams routes plus the three WebSocket routes per D11 (ownership, `not_open`, `Origin` 403).
- [ ] `api/static_files.rs`: serve `web/dist` embedded (rust-embed, brotli/gzip when the client accepts it, `index.html` fallback) or from `WORK_HUB_STATIC_DIR`.
- [ ] `main.rs`: on startup run `ensure_default_image` in the background, start the reconciler, the watchers and the recording task; `cargo clippy -- -D warnings` clean.

### Chunk 13 — Web foundation and auth pages
- [ ] `src/api/client.ts`: `apiFetch`, `ApiError` (code and message from `{error, message}`), 401 → `#/login`, modelled on `client/src/viewer/api.ts:122-184`.
- [ ] `src/api/{auth,workspaces,fs,workstreams}.ts`: typed functions and TS types for every route and shape in API changes.
- [ ] `src/app.css` (Tailwind v4, light tokens copied from `client/src/viewer/app.css`) and `src/ui/` primitives per D16 (copied: button, dialog, confirm-dialog, input, card, tooltip, popover; new: dropdown-menu, select, toast).
- [ ] `src/main.tsx` and `App.tsx`: QueryClient, hash router with the routes per D16, `auth/AuthContext.tsx` (`me`), `auth/useAuthConfig.ts` (`staleTime: Infinity`) and an auth guard.
- [ ] `src/pages/login/`: `LoginPage` with `IdentifyForm`, `PasswordLoginForm` (403, 429 countdown, 401 messages), `AzureSignInButton`, the oauthError banner and the mode switch, mirroring `client/src/viewer/pages/login/LoginPage.tsx:29-326`.
- [ ] `src/pages/{signup,confirm,password}/`: `SignupPage`, `ConfirmEmailPage`, `ForgotPasswordPage`, `ResetPasswordPage` mirroring Log Hub's, and `ChangePasswordDialog` opened from the user menu (password modes only).
- [ ] `src/layout/TopBar.tsx` (brand, crumb, slots for History/Settings/Configure, user menu with "Edit email"/"Logout") and `DockerStatusGate.tsx` (status endpoint → full-page messages per Visual/UX).

### Chunk 14 — Terminal UI
- [ ] `terminal/xterm-theme.ts` (palette per D16) and `terminal/terminal-socket.ts` (WebSocket URL from `location`, frames per D11, reconnect on network loss, but not after `taken_over`).
- [ ] `terminal/TerminalView.tsx` (props: `wsPath`, `replayFrom?: workstreamId`, `onEnded`): xterm with the fit, clipboard and web-links addons, ResizeObserver → resize frames, a "This chat was opened in another tab" overlay with "Take it back" on `taken_over`.
- [ ] `terminal/replay.ts` (segments per D17) and `ReplayView.tsx` (read-only xterm fed segment by segment); `TerminalView` with `replayFrom` writes the recording first, then attaches live.
- [ ] `pages/workspace/LoginTab.tsx`: a service tab hosting `TerminalView` on the login WebSocket with "Skip for now" (cancel call); on `ended{loggedIn:true}` it closes and refreshes the workspace query.
- [ ] `pages/workspace/ConfigureTab.tsx`: start call (409 messages shown plainly), `TerminalView` on the configure WebSocket, "Finish configuration" → finish call with a "Saving the container setup…" then "Saved" toast; it also closes on `ended`.

### Chunk 15 — Workspaces list, login and settings UI
- [ ] `pages/workspaces/WorkspacesPage.tsx`: cards, "New workspace" and the empty state per Visual/UX (Workspaces list).
- [ ] `NewWorkspaceDialog.tsx`: name field with server errors, "Preparing…" state, then opens `AgentLoginDialog` for the new workspace.
- [ ] `DeleteWorkspaceDialog.tsx`: confirmation text "This deletes the workspace's files, its containers and saved setups, its Claude login and the history of all its workstreams."; Cancel changes nothing.
- [ ] `pages/workspace/AgentLoginDialog.tsx`: "New login" (start call, then shows `LoginTab`), "Copy from my workspace" (listed only when sources exist), "Not now"; reused from the workspace banner and from "Open workstream" on `login_required`.
- [ ] `pages/settings/SettingsPage.tsx`: read-only name, a working-branch select from `branches`, Save (PATCH), and Repository "none — started empty" / Container "Work Hub default" rows.

### Chunk 16 — IDE: tree, tabs, editor, DnD
- [ ] `ide/tree-model.ts` and `FileTree.tsx`: lazy directory loading via `list`, expand state, selection, a context menu with "Download" only.
- [ ] `ide/useFsPoll.ts`: a 2 s poll while `document.visibilityState==='visible'`, merging listings into the tree and reporting version changes for open tabs (D12).
- [ ] `ide/tabs-store.ts` and `TabBar.tsx`: open/focus/close file tabs, a pinned-first slot for chat and service tabs (no close, not movable), dirty markers, re-pointing tabs after a move.
- [ ] `ide/monaco-setup.ts` per D19 (local loader, editor worker only, light theme) and `ide/EditorTab.tsx`: lazily loaded Monaco with language from the file extension, Save button and Ctrl+S (`If-Match`), `ChangedOnDiskBanner.tsx` with "Keep mine" / "Take theirs", and a deleted-file banner with "Close tab".
- [ ] `ide/ImageTab.tsx` (blob URL `<img>`) and `BinaryTab.tsx` ("This file can't be shown here" plus Download); HTML and SVG open in `EditorTab` per D12.
- [ ] `ide/dnd.ts`: drop from the computer (`webkitGetAsEntry` recursion → relative paths), drag-out `DownloadURL`, internal move MIME per D12; drop-target highlight.
- [ ] `ide/OverwriteDialog.tsx`: on `target_exists` list the names, "Replace" re-sends with overwrite, "Cancel" does nothing.
- [ ] `pages/workspace/WorkspacePage.tsx`: tree left, tab area right, working-branch view by default (`#/w/:wsId`), the login banner per Visual/UX opening `AgentLoginDialog`, `LoginTab`/`ConfigureTab` (TopBar wrench) as pinned service tabs.

### Chunk 17 — Workstream flows UI
- [ ] `WorkspacePage` workstream route `#/w/:wsId/s/:streamId`: view = the workstream id for tree and tabs (FR-18), a pinned chat tab = `TerminalView` on the chat WebSocket with `replayFrom`, and a "Close workstream" button beside the tab row.
- [ ] `pages/workspace/WorkstreamSwitcher.tsx`: chips per Visual/UX (working branch, open workstreams, Unavailable plus Try again via `retry`, "+ Open workstream"), switching routes.
- [ ] `OpenWorkstreamDialog.tsx`: name with errors, "Preparing…", `login_required` → `AgentLoginDialog`, on success navigate to `#/w/:wsId/s/:id` with the chat tab in front.
- [ ] `CloseWorkstreamDialog.tsx`: `close/check` → busy confirmation → uncommitted list (Back to chat / Close anyway) → three options → result or `merge_conflict` message; a separate Discard… confirmation, per Visual/UX.
- [ ] `pages/history/HistoryPage.tsx`: table per Visual/UX, `ReplayView` for the selected row, "Reopen" and "Discard…" only for `closed` (open ones are discarded from the close dialog; `done` has neither).

### Chunk 18 — Run modes: dockerized and inline
- [ ] `work-hub/Dockerfile` (three stages per D15) and `work-hub/.dockerignore` (target, node_modules, data, web/dist, tests).
- [ ] `work-hub/deploy/docker-compose.yml` and `deploy/.env.example` per D15.
- [ ] `work-hub/scripts/dev.mjs` (nodejs-script skill): start `cargo run` and the Vite dev server together, forward signals, kill both on exit; wire `npm run dev` and `npm run start` (release binary).
- [ ] Complete `work-hub/README.md`: both run modes step by step (inline: `.env`, Postgres, `npm run image`, `npm run dev`; dockerized: `docker compose -f deploy/docker-compose.yml up -d --build`), env table pointer, offline note (first start builds the image online).
- [ ] Run both modes once: compose up → log in, create a workspace, open a workstream at `localhost:5010`; inline `npm run start` → the same at `localhost:3100`; expect the chat to answer with the real CLI; then stop everything started.

### Chunk 19 — Docs and dev tooling
- [ ] Write `docs/knowledgebase/work-hub.md` (OKF front matter): architecture, D5 container model, D2 env table, run modes, commands, test stand, Docker labels and cleanup rules, the checkpoint-layer limit; add it to `docs/knowledgebase/index.md`.
- [ ] `CLAUDE.md`: a "Work Hub" section with its command table (`npm run lint|typecheck|test:algo|build|test:contract|test:scenarios -- --mode a|b|c`, all from `work-hub/`) and Test-policy lines: Work Hub's algorithm tests are `server/tests/algo.rs` and `web/**/*.algo.test.ts`, its contract registry is `server/tests/contract/registry.rs`, its scenarios are `work-hub/tests/scenarios/`, and scenario coverage is not measured yet.
- [ ] `work-hub` `lint` script: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, web eslint (cache in `../tmp/.eslintcache-work-hub`), plus `scripts/agent-names-check.mjs` per Test coverage plan (Static checks).
- [ ] `work-hub/scripts/license-check.mjs` per D20 (allowlist; `cargo metadata` plus `web/node_modules` and `node_modules` package.json `license` fields); add it to the `lint` script.
- [ ] `work-hub` `typecheck` script: `tsc --noEmit` for `web/` and `tests/`.

### Chunk 20 — Algorithm docs and table tests
- [ ] Write `docs/knowledgebase/algorithms/workhub-names.md` and `docs/algorithm-examples/workhub-names.json` (rows: valid, trim, empty, 100/101 chars, control chars, case-insensitive key, Cyrillic slug, punctuation-only → `work`, 50-char cut, clashes → `-2`/`-3`).
- [ ] Write `workhub-repo-path.md` and its rows (root, `./a`, nested, absolute, `..`, `.git` anywhere, backslash, NUL, empty middle segment, 4096-byte limit).
- [ ] Write `workhub-devcontainer-subset.md` and its rows (default sentinel, other image, build with and without context, containerEnv, postCreate string/array, JSONC comments and trailing comma, invalid JSON, unknown keys ignored).
- [ ] Write `workhub-terminal-replay.md` and its rows (no resizes, several resizes, same-offset collapse, offset 0, offset past end, zero bytes).
- [ ] `work-hub/server/tests/algo.rs`: one table test per Rust doc (names, repo path, devcontainer, plus the existing `password-policy`, `login-backoff`, `auth-startup-config`, `local-request-detection` rows with `NODE_ENV`→`WORK_HUB_ENV`); wire `npm run test:algo`.
- [ ] `work-hub/web/src/terminal/replay.algo.test.ts` (vitest reading the rows file); add it to `test:algo`.
- [ ] Register the four new docs in `docs/knowledgebase/algorithms/README.md` and add Work Hub's Rust port as a twin (code path plus `cargo test`) in the four existing auth docs and `docs/knowledgebase/twins-and-cross-cutting-rules.md`.

### Chunk 21 — Scenario stand and fake agent
- [ ] `work-hub/tests/fake-agent/claude.mjs` with the behaviour table in D14, plus its `Dockerfile`.
- [ ] `work-hub/scripts/scenarios.mjs` (nodejs-script skill): the D14 stand (builds, images, schema, free port, mode env, `/health` wait, Playwright, control endpoint `POST /restart-server`, cleanup only of its own schema and instance-labelled objects).
- [ ] `work-hub/tests/playwright.config.ts` (one project per mode with tag greps) and `tests/tsconfig.json`.
- [ ] `work-hub/tests/scenarios/fixtures.ts`: stand URL, API helper with cookie jar, users per mode (identify / signup plus Mailpit confirm), Docker CLI helper, restart helper, a workspace-with-fake-login helper.
- [ ] Wire `npm run test:scenarios -- --mode <a|b|c> [--grep]` and check `--stand-only` starts and stops the stand cleanly in mode a (no containers, volumes or schema left).

### Chunk 22 — Contract tests
- [ ] `tests/contract/harness.rs`: start the app in process on `127.0.0.1:0` with schema `whc_<8hex>`, `WORK_HUB_INSTANCE=whc-<8hex>`, mode `none`, the fake-agent image (D14) and data dir under `tmp/`; clean up the schema and labelled Docker objects afterwards.
- [ ] `tests/contract/registry.rs`: one `Contract` row per route in API changes plus auth routes (fields per D13), and the meta-test against `ROUTE_TABLE`.
- [ ] Generic tests: 401 without a session for every `Session` row; 404 for user B on user A's ids for every `owner_scoped` row (AC-5).
- [ ] `tests/contract/auth.rs`: `config` shape per mode, off-mode 404s, `identify`/`me`/`logout` shapes.
- [ ] `tests/contract/{workspaces,fs,workstreams}.rs`: response shapes and error codes per API changes (create, list, get, patch, delete; list, file, save 409, upload 409, move, download; open, close/check, close modes, discard, reopen, recording meta).
- [ ] `work-hub/scripts/contract.mjs` and the `[[test]]` entry per D14 (Contract runner); wire `npm run test:contract` and run it green.

### Chunk 23 — Scenarios
- [ ] `s-wh-auth.spec.ts` `@S-WH-01` (modes a, b, c) per Test coverage plan.
- [ ] `s-wh-workspace.spec.ts` `@S-WH-02` per Test coverage plan.
- [ ] `s-wh-files.spec.ts` `@S-WH-03` per Test coverage plan.
- [ ] `s-wh-workstream.spec.ts` `@S-WH-04` per Test coverage plan.
- [ ] `s-wh-close.spec.ts` `@S-WH-05` per Test coverage plan, ending with the AC-7 reference walk (buttons and plain fake-agent messages only).

### Chunk 24 — Health checks, CI and final verification
- [ ] `.claude/repo_config/repo-health-checks.json`: add `work-hub-lint`, `work-hub-typecheck`, `work-hub-algo`, `work-hub-build` (group `static`, timeout 1200) and `work-hub-contract`, `work-hub-scenarios-a|b|c` (group `app`, `finalOnly`, timeouts: contract 900, scenarios-a 1200, -b/-c 900), dir `work-hub`; update `environmentNotes` (Docker plus the image prerequisite).
- [ ] `.github/workflows/checks.yml`: a `work-hub-fast` job (Rust 1.92 via the toolchain file, bun 1.4.4) running lint, typecheck and test:algo.
- [ ] Write the changelog entry per the `changelog` skill (`docs/changelog/<YYYY-MM-DD-HHmm>-work-hub-alpha.md`).
- [ ] Run all Work Hub checks (`work-hub-*`, including contract and scenarios a/b/c) and Log Hub's existing fast set (AC-32); fix failures.
- [ ] Manual verification per Test coverage plan: the real Claude login and the AC-7 walk in the browser, and both run modes (AC-1a); record the outcome in the task notes.

### Chunk 25 — File area (D21, added after chunk 24)
- [x] `migrations/0002_files_dir.sql`, `files_dir` on both rows and inserts; `src/files.rs` (layout, engine path, prepare, remove via root helper, JSON metadata); `HelperSpec.binds`.
- [x] `volumes::create` with a bind `device`; workspace create/recreate/delete, workstream open/ensure/close/discard/reconciler use the folders (undo step `Folder`).
- [x] `config.rs`: absolute `WORK_HUB_DATA_DIR`, `WORK_HUB_DOCKER_DATA_DIR`; contract harness passes a canonical data dir.
- [x] Compose binds `WORK_HUB_FILES`; `.env.example`, `deploy/.env.example`, README ("Where your files are"), KB `work-hub.md`.
- [x] Scenario step `@S-WH-02` 1b plus checks in step 10 (AC-3b): folders, metadata, host `git log` with the container stopped, folder gone after delete.

