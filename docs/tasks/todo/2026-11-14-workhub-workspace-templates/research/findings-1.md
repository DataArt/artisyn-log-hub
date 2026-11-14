# Research findings 1 — 2026-11-14 (plan-deep step 2)

## Requirements summary
GH-147, built on top of the Work Hub alpha. When creating a workspace, the user picks a **template**. A template is an embedded directory `work-hub/templates/<id>/` holding a descriptor (`id`, `name`, `description`, `agent`, `order`, `logHubConnection`), `.devcontainer/devcontainer.json` and any other files. These files go into the initial "Start workspace" commit; a template file at a path Work Hub also writes replaces Work Hub's default. Two templates ship:
- **claude-code** keeps `"image": "artisyn-work-hub-default"`.
- **opencode** needs a new `opencode` agent adapter and its own image, built from `templates/opencode/image/` with a sha256-pinned binary. Its devcontainer names the image with the sentinel `artisyn-work-hub-opencode`, which the server resolves to `:<VERSION>`.

Images build at startup, the default image first, then each template image in turn. Readiness is tracked per image. Template images are shared: never in a workspace's undo list, never removed with a workspace. A broken embedded template stops the server at startup.

API changes:
- New `GET /api/v1/templates`.
- `system/status` gains `templateImages`.
- `POST /workspaces` takes `{name, template?, logHub?}`. A missing `template` means `claude-code`. New errors: 400 `unknown_template` and 400 `invalid_log_hub`.
- A migration adds `workspaces.template NOT NULL DEFAULT 'claude-code'`, and the workspace API returns it.

For Claude Code with Log Hub filled in, Work Hub runs `npx <url>/static/artisyn-hooks-installer.tgz install --server-url <url> --api-key <key>` in `/workspace/repo` as the container user, before the initial commit. A failure gives `create_failed` with a named cause, and the create is undone. The key must never reach the DB, API responses, logs or git. UI: a template picker with Claude Code preselected, a Log Hub section only when `logHubConnection` is set, a template badge on workspace cards, and no template management.

## Wireframes
- `wireframes/new-workspace-claude-code.svg`
  - The dialog subtitle reads "The template sets the workspace's container, tools and starting files." The current text is "The workspace starts empty, with Work Hub's default container."
  - Name field, then a "Template" choice of two radio-like cards: Claude Code ("Claude Code agent and tools. Can report sessions to Log Hub.") and OpenCode.
  - "Log Hub connection (optional)" section with "Fill both fields…", a server URL field (hint "Must be reachable from the container: host.docker.internal, not localhost.") and a masked API key field (hint "Not stored by Work Hub. Written to a gitignored file in the workspace repo.").
  - Cancel / Create.
  - The annotation names `.artisyn/config/log-hub.local.json`, which is the installer's internal file. That conflicts mildly with the "installer is a black box" rule (FR-5c).
- `wireframes/new-workspace-opencode.svg` — OpenCode selected: the Log Hub section is hidden and the request is `{name, template:"opencode"}`.
- `wireframes/workspace-list-template.svg` — each card gets a template badge (the template's name) under the workspace name, above "main · N open workstreams". Pre-migration workspaces show Claude Code.

## Knowledgebase
- `docs/knowledgebase/work-hub.md`
  - Only `server/src/agent/{mod,claude}.rs` may name the agent; the web shows the API's `agentName`. `scripts/agent-names-check.mjs` enforces this.
  - Default image: `artisyn-work-hub-default:<crate version>`, built from the embedded `image/` at start; `image_not_ready` until it is ready.
  - Cleanup goes by instance label only. Failed create undoes its steps in reverse.
  - Three-stage `work-hub/Dockerfile`; the offline-first exception covers only the first-start image build.
  - Test kinds and locations. Coverage is not measured.
  - This article needs updating: Layout gains `templates/`; Container model and image choice; the `templateImages` status; env vars.
- `docs/knowledgebase/algorithms/workhub-devcontainer-subset.md` with rows in `docs/algorithm-examples/workhub-devcontainer-subset.json`
  - Rows DC-01 to DC-26, shape `{ok, source:{kind}, containerEnv, postCreate}`.
  - Rule 3 (sentinel, compared after trim) is where the template sentinel `artisyn-work-hub-<id>` goes. Add new rows (DC-27 onward) and extend the Mutations section.
  - Test: `work-hub/server/tests/algo.rs:195` `workhub_devcontainer_subset` maps `ImageSource` to JSON and needs a new `kind` (e.g. `{kind:"template", id}`).
- `docs/knowledgebase/algorithms/README.md` — rows-file format (`id`, `input`, `expected`, `note`).
- `docs/knowledgebase/algorithms/workhub-names.md`, `workhub-repo-path.md` — not affected. Name validation is reused unchanged.
- `docs/tasks/todo/2026-11-13-ai-work-hub-alpha/impl-plan.md` — the design decisions referenced throughout:
  - D4: error shape `{error, message}`.
  - D6: default image and devcontainer subset.
  - D7: adapter trait.
  - D9: create with an undo list.
  - D13: `routes!` macro plus `ROUTE_TABLE` and the registry meta-test.
  - D14: fake agent.
  - D16: web conventions (plain CSS modules, no Tailwind, hash router, react-query).
  - D20: licence allowlist.
  - D22: no CSS framework.
- `docs/tasks/todo/2026-11-13-ai-work-hub-alpha/notes.md` — the alpha is implemented: all of `work-hub/` exists, still untracked in git.
  - Open items there: final verification incomplete (Work Hub scenarios a/b/c not re-run), COOKIE_SECURE, small defects.
  - Nothing about templates or OpenCode exists yet. OpenCode appears only as a future agent (alpha requirements.md:253).
- `hook/INSTALL_HOOK.md` (the installer's documented CLI, which FR-5c relies on):
  - `--server-url` and `--api-key` write the gitignored `.artisyn/config/log-hub.local.json`.
  - Non-TTY runs take the defaults (`--otel-traces` → yes; destination-change → proceed).
  - The installer also writes `~/.claude/settings.json` and `~/.artisyn/otel/*` in the home volume.
  - Lines 494–506: inside a linked worktree the hook reads the **main checkout's** `.artisyn/config/` via `git rev-parse --git-common-dir`.

## Existing patterns
**Server**
- `work-hub/server/src/docker/images.rs:23-26` — `#[derive(RustEmbed)] #[folder="../image/"]` embeds the image context. Reuse for `#[folder="../templates/"]`.
- `work-hub/server/src/docker/images.rs:133-148` — `default_image_context_tar()` builds a tar from the embedded files. Generalise it to a template's `image/` subfolder.
- `work-hub/server/src/docker/images.rs:154-200` — `ensure_default_image(docker, tag, &RwLock<ImageStatus>)`: exists check, retry while Docker is unreachable, build, set status. Run it sequentially per template.
- `work-hub/server/src/lib.rs:72-83` — startup spawns `ensure_default_image`; template images chain after it. `lib.rs:30` `VERSION` is the image tag.
- `work-hub/server/src/state.rs:24-40,59` — `ImageStatus{Building,Ok,Failed(String)}` with `as_api_str`; `AppState.image_status`. A per-template map (e.g. `HashMap<String, RwLock<ImageStatus>>`) and a template registry are new fields.
- `work-hub/server/src/config.rs:176-177` — the `WORK_HUB_DEFAULT_IMAGE` override with default `artisyn-work-hub-default:{VERSION}`.
- `work-hub/server/src/devcontainer.rs:17,66-88` — `DEFAULT_IMAGE_SENTINEL` and `parse_source`, where the template sentinel gets resolved. `ImageSource` enum at :21.

**Server: create flow (`workspaces/mod.rs`)**
- `:37-47` — `DEVCONTAINER_FILE`, `DEFAULT_GITIGNORE`, `DEFAULT_DEVCONTAINER`, `INITIAL_COMMIT_MESSAGE`.
- `:552-610` — `create(st, user, raw_name)`:
  - validates the name;
  - takes `st.agents.get(DEFAULT_AGENT)`; this must come from the template's `agent` instead;
  - calls `require_default_image`;
  - inserts the row with `insert_creating`;
  - on failure, `undo.run` then `create_error`.
- `:612-759` — `create_steps`:
  - volumes;
  - discovers the user on the **default image**, starts the container on the default image;
  - `git init`;
  - `archive::put_files` for `.gitignore` and the devcontainer (`:669-690`); template files and the installer run go here;
  - `git add -A` + commit (`:691-707`);
  - then `read_definition`/`resolve_image` (`:710-744`), which recreates the container on the definition image;
  - postCreate plus checkpoint;
  - profile patch;
  - `mark_ready`.
  - Note: the installer must therefore run in the default-image container, which has Node and npx.
- `:479-496` — `require_default_image`: Ok / Building (exists → ok, else `image_not_ready`) / Failed (logs, then `create_failed`). Copy per template image.
- `:500-543` — `UndoStep`/`Undo`. `:712-714` pushes `UndoStep::Image(image)` whenever `image != default_image`; this **must exclude template images** (FR-1d).
- `:98-115` — `create_error` maps `StepError::Definition(reason)` to `create_failed` with message "The workspace couldn't be created: {reason} Nothing was kept." Reusable for the Log Hub messages.
- `:187-204` `run_checked`, `:429-458` `run_post_create` — the exec-in-repo pattern with a stderr tail of 5 lines. Use it as the model for the installer run with a redacted tail.
- `:363-426` `resolve_image` — the `ImageSource::Default` branch; add the template-sentinel branch that checks the template's readiness.
- `:797-861` `recreate` — resolves through `read_definition`/`resolve_image` too, so the sentinel resolves on recreate after upgrades.
- `:924-1007` `delete` — removes images by workspace label plus `built_image`; untagged shared template images are safe.

**Server: other**
- `work-hub/server/src/workspaces/repo.rs:65-67` (`COLUMNS`), `:86-104` `insert_creating(..., agent, files_dir)`, `:10-23` `WorkspaceRow` — add `template`. `:242-258` login copy is already filtered by `agent` (FR-6d is satisfied).
- `work-hub/server/src/workstreams/mod.rs:138-155` — `image_and_env` uses the stored `ws.base_image` (a versioned tag) with no fallback. `:541` copies volumes with `default_image`.
- `work-hub/server/src/agent/mod.rs:15-52,69-95` — the `AgentAdapter` trait (17 methods) and `AgentRegistry::new()` registering `ClaudeAdapter`. Add `opencode.rs` and register it. `DEFAULT_AGENT="claude"` at :7.
- `work-hub/server/src/agent/claude.rs` — the full adapter to mirror for OpenCode: `login_files`, login/status/logout, `start_command(session_id)`, `resume_command` with fallback, `profile_patch`, `profile_file`, `container_env` (`DISABLE_AUTOUPDATER`), `disposable_home_paths`, `busy_markers`.

**Server: API and errors**
- `work-hub/server/src/api/mod.rs:52-101` — `routes!{}` declares the route and fills `ROUTE_TABLE`. Add `GET "/api/v1/templates" => templates::list`.
- `work-hub/server/src/api/system.rs:15-23` — `status` builds the JSON with `json!`. Add `templateImages`.
- `work-hub/server/src/api/workspaces.rs`:
  - `:21-35` — the `Workspace` API struct (camelCase); add `template` (and possibly `templateName`).
  - `:50-67` — `workspace()` mapping.
  - `:82-91` — `parse_body` → 400 `invalid_body`.
  - `:93-96` — `NameBody`.
  - `:122-131` — the `create` handler; extend the body to `{name, template?, logHub?}`.
- `work-hub/server/src/error.rs:44-72,144-158` — `ApiError::new/bad_request`, `image_not_ready` (503), `create_failed` (500). Add `unknown_template` and `invalid_log_hub` constructors in the same style.
- `work-hub/server/migrations/0001_init.sql:44-80` — `workspaces` table with `agent text NOT NULL DEFAULT 'claude'` and a `COMMENT ON COLUMN` per column. `0002`/`0003` show the add-column pattern (`ALTER TABLE … ADD COLUMN IF NOT EXISTS` plus a COMMENT). New file: `0004_template.sql`. Embedded via `db.rs:59` `sqlx::migrate!("./migrations")`.
- `work-hub/server/src/docker/exec.rs:65-76,103-172` — `describe(argv)` puts the full argv (up to 200 chars) into `DockerError::Timeout` messages and debug logs. `ExecOutput::check()` puts all of stderr into `DockerError::Exit`. `CreateExecOptions` has no `env` set.
- `work-hub/server/src/docker/containers.rs:71,272` — `network_mode: "bridge"`, no `extra_hosts`.
- `work-hub/server/src/files.rs:256-274` — `workspace.json` metadata. Adding `template` is optional; never add the key.

**Web**
- `work-hub/web/src/pages/workspaces/NewWorkspaceDialog.tsx` — phases `form | preparing | failed | login`. `NAME_ERRORS` set routes codes to field errors; the same pattern serves `invalid_log_hub` → highlight a Log Hub field. Testids: `new-workspace-name`, `new-workspace-create`, `new-workspace-dialog`.
- `work-hub/web/src/api/workspaces.ts` — `Workspace` type, `SystemStatus` (`defaultImage` only), `workspaceKeys`, `createWorkspace(name)` (POST `{name}`), `fetchSystemStatus`. Add a `fetchTemplates` and a `templates` query key.
- `work-hub/web/src/pages/workspaces/WorkspacesPage.tsx:26-70` — `WorkspaceCard` (`cardName`, `cardMeta`, `cardLogin`). The badge goes here.
- `work-hub/web/src/layout/DockerStatusGate.tsx:18-19,52-80` — gates the whole UI on `docker` and `defaultImage` only. Template images should not gate the UI.
- `work-hub/web/src/ui/` — button, card, dialog, input, select, tooltip, popover, dropdown-menu, confirm-dialog. `radix-ui@1.8.1` is a dependency (a RadioGroup is available in it).

**Tests**
- `work-hub/server/tests/contract/registry.rs:52-54,121-122` — `row(method, path, Auth, owner_scoped)`. Add `row("GET","/api/v1/templates",S,false)`.
- `work-hub/server/tests/contract/workspaces.rs:79-98` — the `create_name_errors` case pattern (`expect_error(400, code, …)`). Extend it with `unknown_template` and `invalid_log_hub`, and assert a no-template create gives a Claude Code workspace.
- `work-hub/server/tests/contract/harness.rs`:
  - `:873-883` — `WORKSPACE_KEYS` (exact-key assertion, so adding `template` must update it);
  - `:405,417-418` — the in-process app uses `FAKE_AGENT_IMAGE` and forces `image_status = Ok`. The template image statuses need the same treatment.
- `work-hub/tests/scenarios/s-wh-workspace.spec.ts` (`@S-WH-02`):
  - `startCreate` at `:38-43`;
  - step 1 "new workspace starts empty… one commit" at `:107`;
  - step 10 "delete removes every Docker object" at `:330`;
  - `objectsOfWorkspace` helper.
  - This is the natural home for template, badge, Log Hub and error steps.
- `work-hub/tests/scenarios/s-wh-workstream.spec.ts` (`@S-WH-04`) — open a workstream and chat. Candidate for the OpenCode workstream step and the AC-4 "worktree has hook files" step.
- `work-hub/tests/scenarios/fixtures.ts:303` `createWorkspace(api, name)`, `:281` `instanceObjects`, `:296` `gitIn`, `:554` `gitMain`.
- `work-hub/scripts/scenarios.mjs:54-55,203-210,324` and `work-hub/scripts/contract.mjs:28-29,76-83` — build the default image, then the fake-agent image FROM it, and set `WORK_HUB_DEFAULT_IMAGE=artisyn-work-hub-fake-agent:test`.
- `work-hub/tests/fake-agent/{Dockerfile,claude.mjs}` — replaces `/usr/local/bin/claude` with a scripted Node CLI. There is no OpenCode equivalent.

**Other**
- `work-hub/Dockerfile:21-24` — `COPY image/ ./image/` for rust-embed. It must also `COPY templates/`.
- `work-hub/scripts/agent-names-check.mjs` — scans `server/src/**/*.rs` (except `agent/{claude,mod}.rs`) and all of `web/src/**` for `/claude/i`.
- `work-hub/image/Dockerfile` — the pattern for the OpenCode image: a fetch stage with pinned `ARG …_VERSION`/`…_SHA256` and `sha256sum -c`, a `workhub` uid 1000 user, Node 26.13.1 at `/usr/local`.
- `artisyn-hooks-installer/package.json` — no runtime deps; Node ≥18.19. The tarball is built to `server/src/public/static/artisyn-hooks-installer.tgz` by `scripts/build-hooks-installer.js`, next to `hooks.tar.gz`.

## Open gaps
1. **The agent-name lint breaks on the template id.** `scripts/agent-names-check.mjs` matches `/claude/i` in `server/src/**` and in `web/src/**` without exception. A server-side `DEFAULT_TEMPLATE = "claude-code"` constant outside `agent/` fails lint, and so would web code that preselects by id. The plan must decide: keep the default-template constant in `agent/mod.rs`, preselect by `order`/the first entry, or add a descriptor flag. It must also decide whether `templates/` and migrations stay unscanned (today only `server/src` and `web/src` are scanned).
2. **The installer can hang or skip without a `.claude/` folder.** `artisyn-hooks-installer/src/install.ts:960-968` asks "`.claude/ directory not found. Create it now? [Y/n]`" without a TTY guard. With stdin not attached, readline gets EOF and the `rl.question` callback likely never fires. The likely result is a silent exit with code 0 and nothing installed, or a hang. The Claude Code template should ship a tracked file under `.claude/`, or Work Hub must pass stdin. A PoC is needed. npx itself assumes `--yes` without a TTY.
3. **Redacting the API key.** The required command line puts the key in argv. `exec::describe(argv)` embeds argv in `DockerError::Timeout` (logged and surfaced). `check()` embeds the whole stderr, and the key is visible to `ps` inside the container. The plan needs a design:
   - pass the key through exec `Env` plus `sh -c '… --api-key "$K"'` (`CreateExecOptions.env` is unused today);
   - add a redaction helper for the stderr tail and all error and log paths;
   - write no debug traces of argv.
4. **Ordering for the Log Hub install.** The installer must run after the template files are written and before the commit (`create_steps:669-707`). At that point the container runs the **default image**, which is fine for claude-code (Node and npx are present). The undo has no extra Docker objects to undo, but files the installer wrote under the home volume (`~/.claude/settings.json`, `~/.artisyn/otel/`) persist into the home volume. That is fine because the folder is removed on undo.
5. **`host.docker.internal` on Linux engines.** Containers use the bridge network with no `extra_hosts`. `host.docker.internal` resolves only on Docker Desktop. The plan must decide whether to add `ExtraHosts: host.docker.internal:host-gateway` to the run spec, keeping recreate and backward compatibility in mind, or only document it.
6. **Workstreams and the gitignored key.** `log-hub.local.json` is gitignored, so it is not in the commit. It does sit in the workspace's `/workspace/repo` and is copied with the repo volume. The hook inside `/workspace/worktree` resolves the main checkout through `--git-common-dir` (INSTALL_HOOK.md:494-506), so it should find `/workspace/repo/.artisyn/config/`. This needs confirmation in the AC-4 scenario step.
7. **No sentinel resolution for template images yet.** `devcontainer::parse` would treat `artisyn-work-hub-opencode` as a plain local image name (`ImageSource::Image`), and `resolve_image` would fail with "doesn't exist". The plan must define the new `ImageSource` variant, its readiness check, the algorithm-doc rule and rows, how unknown sentinel ids behave, and whether parse needs the list of known template ids (that affects the algorithm-test input shape).
8. **Template-image overrides for test stands.** There is no `WORK_HUB_TEMPLATE_IMAGE_*` style override. Scenario and contract stands run `WORK_HUB_DEFAULT_IMAGE=fake-agent`, but a real OpenCode image build at stand start needs the network and a real binary. Two things are needed:
   - an env override or a fake-agent variant per template (a fake `opencode` CLI under `tests/fake-agent/`);
   - an update to `scenarios.mjs`, `contract.mjs` and the harness's forced `ImageStatus::Ok`.
9. **The OpenCode adapter specifics are unknown in the repo.** There are no KB articles, PoCs or samples. Still to decide:
   - pinned version and sha256;
   - login files and login/status/logout commands;
   - how to start or resume with a **fixed session id**. OpenCode generates its own session ids, so the existing `start_command(session_id)` with a uuid may not map; a PoC is needed;
   - profile file and patch;
   - busy markers;
   - disposable paths;
   - the self-update env.
   The binary's licence also needs a D20-style note in the README/KB, as for the Claude CLI.
10. **Template registry and descriptor format.** There is no existing code for:
   - descriptor file name and format (JSON vs JSONC);
   - startup validation (FR-1e: invalid descriptor, `.git/` entries, duplicate ids, an `agent` that is not registered);
   - how embedded files are enumerated per template and excluded (the `image/` subfolder and the descriptor itself must not be committed);
   - file modes (`put_files` uses one `FileOwner` mode, 0o644, for all files, so an executable template file would lose its bit).
11. **The installer for scenarios.** AC-4 and AC-7 need a Log Hub endpoint reachable from the container that serves `/static/artisyn-hooks-installer.tgz` and `hooks.tar.gz`, plus any calls the installer makes to validate the key. No such fake exists in `work-hub/tests/`. The plan must decide between a small Node static server on the host (built from `server/src/public/static/`) and a real Log Hub stand. An "unreachable URL" case is easy.
12. **Workstreams after a server upgrade.** `workstreams/mod.rs:149-153` uses the stored `base_image` tag with no fallback, so after an upgrade the old `artisyn-work-hub-opencode:<old>` may be missing. The default image has the same issue today. Decide whether template workspaces re-resolve here.
13. **Status gate and UI pieces.** `DockerStatusGate` and `SystemStatus` only know `defaultImage`. Template-image readiness needs a query or polling in the dialog to show a not-ready template as disabled with a hint. There is also no radio or card-choice component in `web/src/ui/`, so a new one is needed (radix RadioGroup from the `radix-ui` package is already a dependency).
14. **Docs to update:** `work-hub/README.md` (offline user docs: templates, Log Hub fields, OpenCode), `work-hub/.env.example` (any new image env vars), and the KB `work-hub.md` Layout, Container model and Configuration tables.
