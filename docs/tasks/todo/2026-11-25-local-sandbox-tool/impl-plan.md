---
type: "Plan"
title: "AgentBook (local sandbox tool): implementation plan"
description: "Architecture and chunking for AgentBook: a native Rust desktop tool that gives Claude Desktop isolated, devcontainer-aware Docker laptops over SSH on a shared folder."
---

# Implementation plan — 2026-11-25-local-sandbox-tool (AgentBook)

## TL;DR

- **New top-level product `agentbook/`**, built like `work-hub/`: its own Cargo workspace and pinned toolchain,
  `package.json` scripts, licence check, `.claude/repo_config/agentbook-health-checks.json` (not run by
  default) and a CLAUDE.md section. It is not part of Log Hub's build, `dist/` or checks, and shares no code
  with Work Hub (the bollard Docker module and the licence-check script are copied as patterns).
- **UI: `eframe`/`egui`**, MIT/Apache, giving a single exe with no webview, using **OS fonts through the
  platform layer**. egui's bundled fonts (OFL + Ubuntu-font) fail the licence allowlist. Rejected: `iced`
  (its Elm/async architecture is heavier than this UI needs) and `slint` (GPL or royalty licence).
- **Equipment pipeline (verified in PoC `docs/pocs/2026-11-25-2146-devcontainer-laptop-layer/`).**
  - **Project Equipment:**
    1. `devcontainer build` builds the project's image.
    2. The tool builds its laptop layer on top and appends its entrypoint to the `devcontainer.metadata` label.
    3. `devcontainer up --override-config` runs it with only the keys the label lacks, plus the tool's run
       args and mounts.
    4. Compose configs get one extra tool compose file and a per-laptop `COMPOSE_PROJECT_NAME`.
  - **Standard Equipment:** an embedded Dockerfile plus the same layer, with the container created by the
    tool through bollard. It needs no devcontainer CLI (FR-10).
  - **Rejected:** a devcontainer Feature, because the CLI accepts local Features only inside the project's
    own `.devcontainer/`. Also rejected: re-implementing devcontainer create semantics in Rust.
- **Variables:**
  - **Delivery:** an sshd `ForceCommand` wrapper sources a tmpfs env file that the tool writes over
    `docker exec` stdin. Values never land on host disk or in a volume, and vanish on stop.
  - **Hidden values:** kept in the OS credential store (`keyring` crate).
  - **Rejected:** `~/.ssh/environment` (a file in the volume) and client `SetEnv` (values in host ssh config).
- **In-container tooling is POSIX `sh`:** `ws` and the prompt hook are plain scripts. They ship in a
  read-only tool bind mount that is refreshed on every Open and do not depend on the libc. Rejected:
  per-libc/arch static Rust binaries. Per-folder state is a read-only directory mount, updated by
  write-then-rename.
- **Installer:** a second tiny Rust binary, `AgentBook-Setup.exe`, that embeds the main exe and copies it
  per-user with a Start-menu shortcut. Rejected: Inno Setup (an extra non-Rust build toolchain).
- **Shared data folder safety:**
  - A single-instance lock in the data folder: a second copy of the tool only says that AgentBook is
    already running.
  - `state.json` keeps unknown fields when it is written back.
  - A `schema_version` newer than the tool's own opens read-only, with a message to update.
- **New dependencies** (all MIT/Apache, licence-checked):
  - UI and runtime: `eframe`/`egui`, `tokio`, `bollard`;
  - storage and files: `keyring`, `serde`/`serde_json`, `tar`, `sha2`;
  - downloads: `reqwest`;
  - OS integration: `rfd` (folder picker) and `windows` (Start-menu `.lnk`);
  - help: a CommonMark renderer for egui.

  Downloaded at first launch (not linked): Node.js and `@devcontainers/cli`.
- **New CI:** a gated `agentbook-fast` job in `checks.yml` and a manual `agentbook-release.yml`.
- **No Claude Desktop version check** (owner, 2026-11-25): an old Desktop fails to open the link and the
  user updates it. Prerequisites are the engine and Windows OpenSSH ≥ 9.4 only.
- **External surface:** this is a new product. The Log Hub and Work Hub APIs and DB are untouched. New
  contracts:
  - the per-user data folder format
  - one `Include` line in `~/.ssh/config` plus a tool-owned ssh config
  - `claude://` links
  - Docker objects labelled `artisyn.agentbook.*`
  - credential-store entries
  - fixed in-container paths, the `ws` CLI and the env file
  - downloads from nodejs.org and registry.npmjs.org (host, sha256-checked), plus the Docker Hub Ubuntu
    base by digest and the distro apt/apk mirrors during builds
  - direct `docker compose … down` for compose laptops
  - two release exes

  Each one is additive-only so older installs keep working.
- **Tests:** algorithm table tests for the pure core (`agentbook-*` docs and rows), plus a Rust scenario
  suite that drives the engine on real Docker with a fake home and a fake Desktop launcher. Real-Desktop and
  installer acceptance checks are manual. There are no contract tests (no routes), and scenario coverage is
  not measured, as with Work Hub.

## Reference

Requirements: [requirements.md](requirements.md). Evidence:
- the earlier SSH PoC, `docs/pocs/2026-11-25-1743-desktop-ssh-container/`;
- this plan's PoC, `docs/pocs/2026-11-25-2146-devcontainer-laptop-layer/`;
- [research/platform-and-crates.md](research/platform-and-crates.md).

## Architecture decisions

- **Crates** (one workspace in `agentbook/`):
  - `agentbook-core` holds the pure domain model, the state file types and every algorithm (no I/O, no clock).
  - `agentbook-platform` holds the `Platform` trait and the Windows implementation. No macOS
    implementation is built now: nothing could check it. The trait, plus a lint rule allowing
    `cfg(windows)` only in this crate, keeps macOS a matter of adding one implementation.
  - `agentbook-engine` holds Docker, devcontainer CLI, downloads, laptop lifecycle and context push. It
    depends only on core and the `Platform` trait.
  - `agentbook` is the egui binary and only calls engine commands.
  - `agentbook-setup` is the installer.
- **Engine/UI threading:** the engine runs on a tokio runtime in a background thread. The UI sends `Command`
  values over a channel and renders the latest `Snapshot` (folders, laptops, states, progress, errors). The
  UI never blocks on Docker.
- **Docker:** use bollard, copying Work Hub's `docker/` module pattern (`DockerError` mapping, build-log
  tail). The engine resolves the endpoint itself in this order, because bollard's defaults ignore contexts:
  1. `DOCKER_HOST`
  2. `DOCKER_CONTEXT` / `currentContext` → `contexts/meta/<sha256>/meta.json`
  3. the default pipe or socket
- **Bind paths:** host bind sources are passed as native host paths, with no Docker Desktop path mapping
  (PoC item 5, verified on Docker Desktop).
  - An endpoint that is not on this computer (`tcp://` or `ssh://` to another host) cannot see host folders.
    It gets the plain message "AgentBook needs a Docker engine on this computer".
  - Rancher Desktop is checked in manual acceptance.
- **Devcontainer CLI** is run with the downloaded Node, using `--docker-path` set to the `docker` executable
  found on PATH and `DOCKER_HOST` set to the resolved endpoint. Project Equipment without a `docker` CLI gets
  a plain message, and the standard Equipment does not need one.
- **Devcontainer merged view:** `devcontainer read-configuration --include-merged-configuration` is the only
  source for `remoteUser`/`containerUser`, `workspaceFolder`/`workspaceMount`, `containerEnv`/`remoteEnv`
  (variable defaults) and the host-exposure check. The tool never parses JSONC itself.
- **Override config:**
  - It keeps only `name`, `image` (the layered one), `workspaceMount`/`workspaceFolder`, the project's
    `runArgs` plus the tool's, and the tool's `mounts`. Keys the label already carries are never repeated,
    because repeating them ran lifecycle commands twice in the PoC.
  - When the project sets no `workspaceMount`, the tool always sets one to the shared folder, because the CLI
    default mounts the enclosing git root.
  - Compose configs keep the project's compose files and add a tool compose file for the primary service.
- **Laptop layer:** one POSIX `install.sh` for both apt and apk. It installs sshd and sftp, creates the
  `claude` user when needed and unlocks it on Alpine, and writes sshd config with key-only auth, `AllowUsers`,
  `ForceCommand` and `PermitRootLogin` set to `no` or `prohibit-password`. It also installs `entry.sh` and
  `session.sh`.
- **`entry.sh`:**
  - copies the key files from the read-only key mount to `/run/agentbook`, which is tmpfs;
  - runs `chmod 755` on that tmpfs, because sshd `StrictModes` rejects 1777;
  - dumps its own environment (the image `ENV` plus `containerEnv`, including the image's `PATH`) to
    `/run/agentbook/base.env`, readable by the SSH user;
  - starts sshd and then `exec "$@"`.
- **`session.sh`:** sources `base.env` first and then `env/session.env`, so SSH sessions see the same base
  environment as `devcontainer exec` (AC-6: tools installed off the default `PATH`).
- **Compose laptops:**
  - The project name stays stable (`agentbook-<id>`), so sidecar named volumes survive Update.
  - Rollback after a failed Update re-runs `up` with the previous generation's override config and images,
    which are kept until the new generation succeeds.
  - Remove runs `docker compose -p agentbook-<id> down -v` with the same files, then removes the home volume.
    Sidecars are found by the compose project label.
- **Images:**
  - standard Equipment base: pinned by digest, with Node pinned by sha256;
  - image cache key: the config hash (Equipment changed, below);
  - libc family: detected once per layered image and recorded on the laptop.
- **Container identity:** the engine finds containers by label only (`artisyn.agentbook.laptop=<id>`).
  Removal works only by exact label or name, following the deletion guards of `docker-dev-container.md`.
- **Update laptop:**
  1. Build the new images.
  2. Stop the old container (which frees the port).
  3. Run `up`/create the new one with `artisyn.agentbook.gen=<n+1>`.
  4. On success, remove the old container. On failure, remove the new one and start the old one.
  5. If the libc changed, clear `~/.claude/remote/ccd-cli` in the volume.
- **Recreate-type actions** (give folder, change mode, Locate folder, port reallocation) use the same
  create-new-then-drop-old path. The volume is kept.
- **Ports:** a random free loopback port in 20000–29999 that no other laptop in `state.json` uses. It is
  probed by binding `127.0.0.1:<port>` and reallocated only on a clash at Open (FR-4).
- **SSH keys:** both keys are ed25519, generated by the system `ssh-keygen`, which is already a prerequisite.
  The private key is restricted to the user with the PoC's ACL recipe through the platform layer.
- **ssh config:** a tool-owned file with one block per alias (PoC alias recipe: `IdentitiesOnly`,
  `HostKeyAlias`, `UserKnownHostsFile` with forward slashes, `StrictHostKeyChecking yes`) and a pre-seeded
  per-alias known_hosts. The `Include` line goes at the **top** of `~/.ssh/config`, because an `Include` below
  a `Host` block would be conditional on it.
- **Variable resolution:**
  - For each name, the per-laptop override wins over the folder value, which wins over the project default
    (`containerEnv`/`remoteEnv`). An empty effective value means "needs a value".
  - `${containerEnv:X}` references in `remoteEnv` are resolved against the container's env
    (`docker inspect`) at Open. Such entries, like `PATH` additions, are delivered but are not listed as
    user-editable Variables.
  - The env file is rewritten on Open, on Wake up, after a variables change, and when the poller finds a
    running laptop whose env file is missing (one started outside the tool).
  - Known limitation (stated in help and the KB): a laptop started outside the tool while the tool is
    closed has no Variables until AgentBook is opened again. This is the price of keeping values only in
    tmpfs.
- **Context push on every Open:**
  - `~/.claude/CLAUDE.md` is written whole, since it is tool-owned.
  - The `UserPromptSubmit` entry in `~/.claude/settings.json` is merged in by its command path, keeping the
    user's other keys.
  - Host `~/.claude/{skills,agents,commands}` are uploaded as a tar through the Docker API, owned by the SSH
    user, and replace entries of the same name. `.credentials.json` is never copied.
  - The `ws` skill is part of the pushed skills.
- **Session count:** every 5 s for Working laptops while the window is open, `docker exec … cat
  /proc/net/tcp /proc/net/tcp6`, counting ESTABLISHED sockets on local port 22 (PoC item 6).
- **Equipment changed:**
  - The config hash is sha256 over the selected config file and every file in its folder, plus the compose
    files and Dockerfile it references, plus the tool's standard-Equipment and layer versions.
  - The engine compares it with each laptop's recorded hash at start and before every Open.
- **Host-exposure warning:** computed from the merged config. It covers writable bind mounts other than the
  workspace, `docker.sock`, `privileged`, and `--network`/`--pid host`.
- **Downloads** (FR-10). The first-launch screen lists three items, each with name, version, size and
  progress:
  - **Node** — the official win-x64 zip from nodejs.org/dist.
  - **`@devcontainers/cli`** — the npm registry tarball (it has no runtime dependencies).
  - **Standard Equipment**, made of two parts:
    1. The engine pulls the pinned Ubuntu 24.04 base by digest from Docker Hub.
    2. The engine builds `agentbook-std:<v>`. The Linux Node tarball for the engine's architecture
       (linux-x64 or linux-arm64) is downloaded **on the host** like the other two items and sent in the
       build context.

  Rules for these downloads:
  - Host files (both Node archives and the CLI) have sha256 constants in core. They go through `reqwest`
    with the OS proxy settings, are written to a temp name, verified, then renamed.
  - The standard image's apt packages (git, ca-certificates, curl) come from the Ubuntu archive. Each
    laptop layer's sshd packages come from the base image's own apt or apk mirror, at that Equipment's
    build. Both are verified by the distro's package signatures, not by AgentBook's sha256 list (open
    owner decision, recorded in FR-10).
  - Every build the tool starts (standard, layer) gets the OS proxy as `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`
    build args, because a bollard build does not inherit the docker CLI's proxy config. Project Equipment
    builds go through the docker CLI, which applies `~/.docker/config.json` proxies itself.
  - A Debian/Ubuntu or Alpine layer build shows its packages in the build log.
- **Help:** Markdown pages under `agentbook/help/`, embedded in the binary and rendered natively. The kawaii
  icons are drawn with egui shapes, so no SVG or image dependency is needed.

Internal contracts between chunks:

- `Platform` trait (chunk 3, consumed by 5–8):
  - `data_dir()`, `ssh_dir()`, `home_dir()`
  - `docker_endpoint() -> Endpoint{kind, address, probed: Vec<String>}`
  - `openssh_version() -> Option<Version>`
  - `credential_get/set/delete(target)`
  - `ssh_keygen(path, comment)`, `restrict_private_key(path)`
  - `open_url(url)`, `open_in_file_manager(path)`, `pick_folder()`
  - `ui_fonts() -> Vec<FontFile>`, `host_git_autocrlf() -> Option<String>`, `is_windows()`
- Core types (chunk 2):
  - `Folder{id, path, claude_dir, equipment: EquipmentRef, vars: Vec<VarSetting>}`
  - `Laptop{id, folder_id, name, port, given: Vec<Given{path, read_only}>, equipment_hash, libc, gen, laptop_vars}`
  - `VarSetting{name, value: Plain(String)|Hidden, origin}`
  - `State{schema_version, folders, laptops, recent}`
- Engine API (chunk 5/6, consumed by 7 and 9): `Engine::new(platform, data_dir_override)`, `Engine::run(Command)`, `Engine::snapshot()`.
  Commands:
  - `AddFolder`, `ChooseClaudeDir`, `GetLaptop{folder, name, given, copy_from}`
  - `Open`, `Sleep`, `WakeUp`, `Rename`
  - `GiveFolder`/`SetGivenMode`/`RemoveGiven`, `UpdateLaptop`, `RemoveLaptop`, `RemoveFolder`, `LocateFolder`
  - `SetVariables`, `CheckPrerequisites`, `DownloadDependencies`
- In-container state files: chunk 4 reads them and chunk 6 writes them. Their format is in External
  surface.
- Scenario hooks (chunk 5, used by 5–6): `Engine::new` takes an optional `EngineTestConfig`. This is a
  constructor argument, not a CLI flag or env var. It holds:
  - the instance label;
  - a download base URL (a local file server);
  - a fake Desktop launcher;
  - a credential-name prefix `AgentBook-test-<instance>/`.

  The harness wraps the Windows `Platform` in a `TestPlatform` that redirects `home_dir`/`ssh_dir`/`data_dir`
  to the repo `tmp/`. It deletes its own prefixed credentials at the end.

## External surface

**API:** None. AgentBook has no HTTP surface and never talks to Log Hub or Work Hub. Their APIs are unchanged.

**DB:** None. AgentBook has no database. Log Hub and Work Hub schemas are unchanged.

**Other:**

- **Per-user data folder** (new): `%LOCALAPPDATA%\AgentBook\` on Windows, the platform data dir on macOS.
  - `state.json`: `schema_version` 1 plus folders, laptops and recent folders. Hidden values are never stored
    there. The format is additive-only, an older tool ignores unknown fields, and a newer tool reads older
    files.
  - `laptops/<id>/key/`: `ssh_host_ed25519_key[.pub]` and `authorized_keys`, mounted into the container.
  - `laptops/<id>/client/`: `id_ed25519[.pub]`, host-only.
  - `folders/<fid>/state/`: mounted read-only into the folder's laptops.
  - `tool-files/`: `ws`, `prompt-hook`, the skill; rewritten by the running tool version.
  - `deps/node-<v>/` and `deps/devcontainers-cli-<v>/`.
  - `logs/`: build logs; never contain variable values.

  - `laptops/<id>/gen/`: the generated override `devcontainer.json` and, for compose, `agentbook-compose.yml`
    of the current and previous generation.
  - `agentbook.lock`: the single-instance lock.

  The installed copy and a copy run straight from Downloads share this folder. Compatibility:
  - Writes keep unknown fields, so a newer tool's fields survive an older copy writing the file.
  - A `schema_version` newer than the tool knows opens read-only, with "update AgentBook".
- **`~/.ssh/config`:** one line, `Include ~/.ssh/agentbook/config`, added once at the top. The user's blocks
  are never edited.
  - New files `~/.ssh/agentbook/config`, with one block per alias `sbx-<id>`, and
    `~/.ssh/agentbook/known_hosts_sbx-<id>`.
  - `<id>` is 8 lowercase base32 characters and stable forever. The alias never derives from the laptop name.
  - Backward compatible: blocks are only added or removed, never reformatted.
- **Claude Desktop link:** `claude://code/new?ssh_host=sbx-<id>&ssh_folder=<url-encoded container path>`.
  The Desktop version is not checked (owner): an old Desktop fails to open the link and the user updates it.
- **Prerequisites the tool reads:**
  - `ssh.exe -V` on PATH, at least `OpenSSH_for_Windows_9.4`;
  - the Docker endpoint, in the order above.
- **OS credential store:** generic credentials named `AgentBook/<folderId>/<NAME>` (folder-wide) and
  `AgentBook/<folderId>/<laptopId>/<NAME>` (only for one laptop). They are removed together with their
  folder or laptop.
- **Docker objects:**
  - Labels: `artisyn.agentbook=1`, `artisyn.agentbook.laptop=<id>`, `artisyn.agentbook.folder=<fid>`,
    `artisyn.agentbook.gen=<n>`, plus `artisyn.agentbook.instance=<run>` for scenario stands only.
  - Which objects carry them:
    - laptop containers: all labels;
    - home volumes `agentbook-home-<id>`: `.laptop`;
    - images `agentbook-std:<v>`, `agentbook-eq:<confighash>` and `agentbook-laptop:<basehash>-<layerv>`:
      `artisyn.agentbook=1`;
    - compose sidecars: no tool label; found by the compose project label `agentbook-<id>`.
  - Containers are named by the CLI or by the tool and are always found by label.
  - Images no laptop references any more are removed after a successful Update and after Remove laptop,
    by exact tag only.
  - The `agentbook-laptop:*` image's `devcontainer.metadata` label is the base image's array plus one
    entry, `{"id":"agentbook-laptop","entrypoint":"/usr/local/share/agentbook/entry.sh"}`.
- **In-container contract** (fixed from version 1, so a laptop created by an older tool keeps working):
  - read-only mounts:
    - `/opt/agentbook/bin` (`ws`, `prompt-hook`)
    - `/opt/agentbook/key`
    - `/opt/agentbook/state` (per folder)
  - tmpfs `/run/agentbook`, holding `base.env` and the env file `/run/agentbook/env/session.env`. Format
    (fixed, because an older layer's `session.sh` sources it):
    - one POSIX-sh assignment per variable, `NAME='value'`;
    - inside the value, `'` is written as `'\''`, and newlines are kept literally inside the quotes;
    - names must match `[A-Za-z_][A-Za-z0-9_]*`, and the Variables dialog rejects other names;
  - the prompt hook entry in `~/.claude/settings.json`: a `UserPromptSubmit` command hook whose command is
    exactly `/opt/agentbook/bin/prompt-hook`, which is the merge key across versions;
  - the `ws` skill at `~/.claude/skills/agentbook-ws/`, copied after the host skills, so that name stays
    reserved for the tool;
  - layer files `/usr/local/share/agentbook/{entry.sh,session.sh}`;
  - per-folder state files in `/opt/agentbook/state`, additive-only JSON that an older `ws` must keep
    reading:
    - `folder.json`: `{schema_version, name, shared_path_in_container, host_path}`;
    - `laptops/<id>.json`: `{schema_version, id, name, state, given: [{container, host, mode}], vars: [names]}`;
  - files the tool writes into the home volume:
    - `~/.gitconfig`: `core.fileMode`, `core.autocrlf` and `safe.directory`, set by key; other keys are
      kept;
    - `~/.claude/{skills,agents,commands}/<name>`: replaced by name from the host, others kept;
  - SSH on container port 22, published as `127.0.0.1:<port>:22`;
  - the shared folder at `/work/<folder name>` or the devcontainer's `workspaceFolder`;
  - given folders at `/work/given/<basename>[-N]`;
  - generated `~/.claude/CLAUDE.md` and a `UserPromptSubmit` hook entry in `~/.claude/settings.json`.
- **`ws` CLI** (new, inside the container): `ws whoami` and `ws mounts`, printing plain text in the UI
  vocabulary (FR-4a, FR-11). The state format they read is additive-only.
- **Network endpoints:**
  - first launch, from the tool, sha256-checked:
    - `https://nodejs.org/dist/v<pinned>/node-v<pinned>-win-x64.zip`
    - `https://registry.npmjs.org/@devcontainers/cli/-/cli-<pinned>.tgz`
    - `https://nodejs.org/dist/v<pinned>/node-v<pinned>-linux-<arch>.tar.xz` (sent into the standard
      Equipment build context)
  - first launch, through the engine:
    - the Docker Hub `ubuntu@sha256:<pinned>` base image
    - the Ubuntu apt archive
  - each project Equipment build, through the engine: the base image's own apt or apk mirror for the laptop
    layer, plus whatever the project's devcontainer fetches.
- **External programs invoked:**
  - the `docker` CLI, for project Equipment only:
    - through the devcontainer CLI (build, up, compose rollback);
    - directly as `docker compose -p agentbook-<id> -f … down -v` on Remove of a compose laptop.

    If no `docker` CLI is found, these actions show the plain "needs the docker command" message and
    change nothing. A standard-Equipment laptop never needs the CLI;
  - `ssh-keygen.exe`;
  - Claude Desktop via the `claude:` protocol.
- **Distribution:**
  - `AgentBook.exe` runs without installation.
  - `AgentBook-Setup.exe` copies it to `%LOCALAPPDATA%\Programs\AgentBook\` and creates a Start-menu
    shortcut, with no admin rights.
  - Neither is code-signed.
  - A GitHub release tagged `agentbook-v<version>` carries both exes.
- **Repo** (new, additive):
  - the `agentbook/` folder;
  - `.claude/repo_config/agentbook-health-checks.json`;
  - an AgentBook section in CLAUDE.md;
  - a gated `agentbook-fast` job in `checks.yml` and an `agentbook-release.yml` workflow (manual dispatch);
  - the KB article `docs/knowledgebase/agentbook.md`, the `agentbook-*` algorithm docs and rows, and the
    index entries.

## Test coverage plan

- **Algorithm:** new `docs/knowledgebase/algorithms/agentbook-*.md` docs with rows in
  `docs/algorithm-examples/agentbook-*.json`, plus one table test, `agentbook/crates/core/tests/algo.rs`
  (Work Hub's `algo.rs` pattern). The docs are:
  - `.claude/` discovery
  - container paths: given-folder naming with `-N`, non-ASCII kept, `claude://` encoding
  - whole-disk, home and ancestor detection
  - variable resolution and Hidden-by-name
  - SSH user resolution
  - Equipment change and libc switch decision
  - host-exposure detection
  - override-config generation from a merged config
  - effective `autocrlf`
  - Docker endpoint resolution
  - session-count parsing of `/proc/net/tcp`
  - the OpenSSH version floor (parsing `ssh -V`)
- **Scenario:** a new suite `agentbook/tests/scenarios/` (Rust, real Docker).
  - **Setup:** it drives `Engine` with an `EngineTestConfig`. The data dir and the fake home (with its own
    `.ssh`) live under the repo's `tmp/` (`project-env.json → tmpDir`), never the OS temp folder. A local
    file server stands in for the download URLs, and a recording fake Desktop launcher replaces Desktop.
  - **Checks:** it connects over ssh/sftp with the laptop's alias, as the PoC did.
  - **When it is built:** the harness lands with chunk 5 and steps are added in chunks 5 and 6, so engine
    behaviour is checked as each chunk lands.
  - **Steps by acceptance criterion:**
    - AC-2: the `.claude/` choice is asked once and remembered
    - AC-17: a checksum mismatch or a cut download leaves no file in use; the second launch downloads nothing
    - AC-1 / AC-3 (live edit, `git status` parity, package only inside)
    - AC-4 (volume survives reopen)
    - AC-4a (session counts)
    - AC-6 (project tool on a non-default `PATH`, cached second start, docker.sock warning, Equipment
      changed → Update, broken Dockerfile on first build and during Update, compose rollback, Debian→Alpine
      libc switch)
    - AC-7 (give folder, View only, home not visible, whole-disk guard, `prompt-hook` run over ssh
      prints the connected-folders line once after a change)
    - AC-7a (Debian, Alpine, root, scratch image message, restart without fingerprint change)
    - AC-9 (including compose sidecars removed), AC-10, AC-11, AC-12, AC-13, AC-14, AC-15
    - AC-16 (`printenv` in a new session, no value in host files or state dir)
    - AC-18 (port clash)
    - AC-19 (a v1 `state.json` fixture opened by the current engine; unknown fields survive a write)
- **Manual acceptance** (real Claude Desktop, clean machine): checked once before release and listed in the
  KB article.
  - Trust dialog only once
  - skills load, and `.credentials.json` is absent
  - no CLI re-download
  - the `ForceCommand` wrapper under Desktop
  - AC-4a's Claude-behaviour parts: answering from `ws whoami`, the worktree flow, warning before a collision
  - Rancher Desktop as the engine
  - AC-8 messages, AC-17 download UI, AC-20 installer
- **Not used:** no contract tests, since there are no routes, and no unit, UI or integration tests beyond
  the above.

## Visual/UX notes

- The wireframes in `wireframes/agentbook-*.svg` are the layout source:
  - home with every folder (including empty and missing ones) and a footer with the engine and OpenSSH
    versions (the wireframes' Desktop version row and footer entry are not built);
  - the folder view;
  - the choose-folder flow with the `.claude/` chooser;
  - the Get a laptop and Another laptop like this dialogs;
  - the give-folder consequences and whole-disk confirmation;
  - the four Equipment states;
  - prerequisites, first-launch download and Variables.
- The UI uses only the FR-11 vocabulary; "Claude" never appears in the product name.
- Kawaii laptop states (Working, Sleeping, Getting equipment, Not started) at 54, 36 and 21 px. Sleep and
  Wake up show their icons.
- Every long action (build, update, recreate, download) shows progress on the card and never blocks the
  window. A failure keeps the log tail with Copy log and Retry.
- Fonts come from the OS, so Cyrillic and CJK folder names render.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Product skeleton and repo wiring | 5 | First; everything builds inside it |
| 2 | Core model and algorithms | 6 | Pure; needs 1 |
| 3 | Platform layer | 5 | Implements the `Platform` trait; needs 2 |
| 4 | Laptop layer and in-container tools | 5 | Shell/Dockerfile assets embedded by the engine; needs 2 (state file shapes) |
| 5 | Engine: Docker, downloads, Equipment pipeline + scenario harness | 6 | Needs 2–4; harness and Equipment steps land here |
| 6 | Engine: laptop lifecycle, SSH, variables, context | 6 | Needs 5; adds its scenario steps |
| 7 | Desktop UI | 6 | Calls only the engine API; needs 6 |
| 8 | Installer, CI, release and final verification | 5 | Last |

### Chunk 1 — Product skeleton and repo wiring
`agentbook/` exists as a separate product with its own toolchain, scripts and checks, wired into the repo
like Work Hub.
Where: new `agentbook/` (workspace manifest, toolchain pin, `package.json`, `.gitignore`, licence-check
script), `.claude/repo_config/`, CLAUDE.md, `docs/knowledgebase/`
- [ ] A Cargo workspace with the five crates from Architecture decisions builds. `npm run lint` (fmt, clippy
      `-D warnings`, licence check with Work Hub's allowlist and no font exception), `npm run test:algo`,
      `npm run build` and `npm run test:scenarios` exist in `agentbook/package.json`.
- [ ] `.claude/repo_config/agentbook-health-checks.json` lists `agentbook-lint`, `-algo`, `-build` (static)
      and `agentbook-scenarios` (finalOnly), in the format of `work-hub-health-checks.json`. It is not
      referenced from `repo-health-checks.json`.
- [ ] CLAUDE.md has an AgentBook section (commands table, "not run by default", test-policy places) mirroring
      the Work Hub section.
- [ ] `docs/knowledgebase/agentbook.md` (OKF v0.3) describes the product, crates, data folder, in-container
      contract and the manual acceptance list, and is linked from `docs/knowledgebase/index.md`.
- [ ] Log Hub's `npm run build` and `dist/` are unaffected; `agentbook/target` is ignored.

### Chunk 2 — Core model and algorithms
The pure core holds the domain model, the state file format and every algorithm, table-tested from docs.
Where: `agentbook/crates/core`, `docs/knowledgebase/algorithms/agentbook-*.md`,
`docs/algorithm-examples/agentbook-*.json`
- [ ] Core types and `state.json` (de)serialisation match Architecture decisions and External surface. They
      round-trip, keep unknown fields on write-back, flag a newer `schema_version` as read-only, and load a
      `schema_version` 1 fixture.
- [ ] Each algorithm listed in the Test coverage plan is a pure function in core, with no I/O and no clock.
- [ ] Each one has an `agentbook-*` algorithm doc (OKF, `type: "Algorithm"`) and a rows file, listed in the
      algorithms index.
- [ ] `agentbook/crates/core/tests/algo.rs` runs every rows file and passes under `npm run test:algo`.
- [ ] The rows cover: `-2`/`-3` collisions with spaces and non-ASCII names; `C:\`, home and its ancestors;
      Hidden-by-name for each of TOKEN, PAT, SECRET, PASSWORD, KEY; an explicit `root` versus an unset user
      on a root image; override-config output for image, Dockerfile, compose and custom `workspaceMount`
      inputs, never repeating label-carried keys.
- [ ] Hidden values cannot be represented in `state.json` (only a Hidden marker).

### Chunk 3 — Platform layer
Every OS-specific piece sits behind `Platform`, implemented for Windows.
Where: `agentbook/crates/platform`
- [ ] The Windows `Platform` implements the whole trait from Architecture decisions. Docker endpoint
      resolution follows the stated order and reports what it probed.
- [ ] `openssh_version` parses
      `ssh.exe -V` from PATH.
- [ ] Credential get/set/delete use Windows Credential Manager under the External surface names.
      `restrict_private_key` leaves a key that Windows OpenSSH accepts.
- [ ] `ui_fonts` returns Segoe UI plus CJK/symbol fallbacks from the system font folder.
- [ ] No `cfg(windows)` or Windows-only API appears outside this crate; this is grep-checked in
      `npm run lint`.

### Chunk 4 — Laptop layer and in-container tools
The assets that go into every laptop exist and are embedded in the engine.
Where: `agentbook/assets/` (layer `install.sh`, `entry.sh`, `session.sh`, layer Dockerfile, standard
Equipment Dockerfile, `ws`, `prompt-hook`, `ws` skill, CLAUDE.md template)
- [ ] The layer builds on Debian/Ubuntu and Alpine bases and produces the sshd setup from Architecture
      decisions. On an image without apt/apk (scratch, distroless) it fails with a recognisable marker that
      the engine maps to the plain "cannot add the laptop layer" message.
- [ ] The standard Equipment is Ubuntu 24.04 by digest with git, ca-certificates, curl and Node pinned by
      sha256.
- [ ] `ws whoami` and `ws mounts` read only `/opt/agentbook/state` and the git repos (POSIX sh), print the
      FR-4a content in FR-11 words, and re-read state on every call.
- [ ] `prompt-hook` prints the one-line FR-4b summary. It reads the branch from `.git/HEAD`, takes the dirty
      count with a ~1 s timeout ("?" on timeout) cached per repo, and adds a line when the connected
      folders changed since its last run.
- [ ] The CLAUDE.md template covers every FR-4b point plus variable names only. The `ws` skill teaches the two
      commands.

### Chunk 5 — Engine: Docker, downloads, Equipment pipeline + scenario harness
The engine can download its dependencies, build any Equipment and create a laptop container as decided,
and the scenario harness checks it on real Docker.
Where: `agentbook/crates/engine` (docker, deps, equipment modules), `agentbook/tests/scenarios/`
- [ ] The Docker client connects through the resolved endpoint and maps errors to the FR-9 plain message. A
      single-instance lock guards the data folder.
- [ ] First-launch downloads cover the three items from Architecture decisions (version, size, progress,
      sha256 check for host files, temp-then-rename, Retry, OS proxy). The second launch downloads nothing.
      Folders without a devcontainer work when only the CLI is missing.
- [ ] Project Equipment runs build → layer with the appended metadata entrypoint → `up --override-config`
      for image, Dockerfile and compose configs. The image is cached by config hash, progress steps and log
      are streamed, and the log tail is kept on failure.
- [ ] Standard Equipment is built and the container created through bollard with the same run args, mounts
      and labels as External surface.
- [ ] Update laptop and recreate actions follow Architecture decisions, compose included: the old laptop
      keeps working on failure, `ccd-cli` is cleared on a libc switch, and unreferenced images are removed by
      exact tag. The Equipment-changed state and host-exposure warnings are produced at start and before
      every Open.
- [ ] The scenario harness exists as described in the Test coverage plan, under the repo `tmp/` and with an
      instance label. It removes only its own objects and never touches the real `~/.ssh` or data folder.
      Its fixtures are JS/plain-file projects with no live `.claude/`. Its build-level steps pass under
      `npm run test:scenarios`: AC-6 (built through the engine, checked by `docker exec`) and AC-17.

### Chunk 6 — Engine: laptop lifecycle, SSH, variables, context
Every user action on folders and laptops works end-to-end in the engine.
Where: `agentbook/crates/engine` (laptops, ssh, variables, context, poller modules)
- [ ] Get a laptop, Another laptop like this, Open, Sleep, Wake up, Rename, Remove laptop, Remove folder and
      Locate folder behave as in FR-1a/FR-2/FR-6/FR-11. Each one blocks on missing bind sources with a
      message naming the folder.
- [ ] Ports are allocated and reallocated as decided. The alias file, per-alias known_hosts and the one
      `Include` line follow External surface, and only that alias changes on reallocation.
- [ ] Give folder, mode change and remove-given recreate the container with the volume kept and refuse
      whole-disk, home and ancestor paths without explicit confirmation.
- [ ] Variables resolve per Architecture decisions. Hidden values go only to the credential store and the
      tmpfs env file, and are rewritten on Open, Wake up, change and detection of a missing file.
- [ ] Context push on Open writes CLAUDE.md, merges the hook entry, copies skills, agents and commands (never
      `.credentials.json`), refreshes the tool files and sets git defaults (`core.fileMode`, effective
      `autocrlf`, `safe.directory`). Rename and state changes reach `/opt/agentbook/state` by
      write-then-rename.
- [ ] The poller reports Working/Sleeping (also for containers stopped outside the tool) and session counts
      every 5 s. The scenario steps for AC-1, 2, 3, 4, 4a, 6 (over ssh), 7, 7a, 9–16, 18 and 19 pass under
      `npm run test:scenarios`.

### Chunk 7 — Desktop UI
The egui app presents every screen and dialog of the wireframes and drives only the engine API.
Where: `agentbook/crates/app`, `agentbook/help/`
- [ ] Home, folder view and choose-folder (drag-and-drop, Browse, recent, `.claude/` chooser) match the
      wireframes, including empty and missing folders and the footer versions.
- [ ] The dialogs match the wireframes, with the FR-8/FR-11 wording and counts: Get a laptop, Another laptop
      like this (copied per-laptop variables warning), Give a folder consequences, whole-disk confirmation,
      Sleep, Remove laptop and Remove folder confirmations.
- [ ] Prerequisites, first-launch download and the four Equipment card states (progress, log tail, Copy log,
      Retry, Update laptop) match the wireframes.
- [ ] The Variables dialog (NAME, VALUE, FROM, project default, Only for one laptop sub-row, Hidden, add and
      remove, warnings) and the "needs a value" card note work.
- [ ] Kawaii icons are drawn natively for the four states and three sizes. OS fonts render non-ASCII names.
      Help pages ship inside the exe, including the SmartScreen and metaphor notes.
- [ ] Visual check of each wireframe screen on Windows 11 against a running engine.

### Chunk 8 — Installer, CI, release and final verification
AgentBook ships as a standalone exe plus a per-user installer, checked and released from CI.
Where: `agentbook/crates/setup`, `agentbook/package.json` build script, `.github/workflows/`
- [ ] `npm run build` produces `AgentBook.exe` and `AgentBook-Setup.exe` (the latter embeds the former).
- [ ] The setup copies the exe to `%LOCALAPPDATA%\Programs\AgentBook\`, creates the Start-menu shortcut and
      needs no admin. Running a newer setup over it keeps the data folder untouched. If AgentBook is running,
      the setup asks the user to close it instead of failing.
- [ ] `checks.yml` has a gated `agentbook-fast` job (lint, algo, build on a Windows runner) like
      `work-hub-fast`.
- [ ] `agentbook-release.yml` (manual dispatch) attaches both exes to a GitHub release `agentbook-v<version>`.
- [ ] Every `agentbook-health-checks.json` check passes (`finalRun: true`), including the full scenario suite.
