---
type: "Architecture Guide"
title: "AgentBook (local sandbox tool)"
description: "AgentBook (agentbook/), the separate native Rust desktop product in this repo that gives Claude Desktop isolated, devcontainer-aware Docker laptops over SSH on a shared folder: crates, per-user data folder, Docker objects, in-container contract, the engine (Docker, downloads, Equipment pipeline, laptop lifecycle, SSH aliases, context push, Variables, poller), the installer, CI job and release workflow, its own commands and checks, test policy and the manual acceptance list."
tags:
  - agentbook
  - docker
  - rust
  - ssh
  - architecture
generated: { by: "claude-code", at: "2026-11-26T19:00:00+04:00" }
---

# AgentBook (local sandbox tool)

AgentBook is a local desktop tool for people who are not technical (a business analyst is the
target user): point it at a folder, get a laptop, click Open, and Claude Desktop works inside a
local Docker container that sees only that folder, mounted live and read-write, plus folders the
user gives it. The user reviews changes in their own IDE and commits from the host. Claude Desktop
connects through its **SSH environment**: Claude Code runs inside the container and Desktop is only
the chat UI.

It lives in `agentbook/` next to Log Hub and Work Hub but is a **separate product**: its own Cargo
workspace and pinned toolchain (`agentbook/rust-toolchain.toml`, Rust 1.92), its own scripts and
checks. It is not part of `scripts/build.js`, Log Hub's `dist/` or Log Hub's health checks, it has
no HTTP surface and no database, never talks to Log Hub or Work Hub, and shares no code with them
(Work Hub's bollard `docker/` module and licence-check script are copied as patterns only).

Design principle: **simple by default, complex through the project**. The tool has no knobs beyond
what its user needs; anything advanced (image, tools, mounts, env, setup scripts) comes from the
folder's devcontainer config, which the tool honours. UI vocabulary is "laptop", "Equipment",
"give a folder", "Sleep" / "Wake up"; the word "Claude" never appears in the product name.

Task and design history: `docs/tasks/todo/2026-11-25-local-sandbox-tool/` (requirements and
implementation plan); PoCs `docs/pocs/2026-11-25-1743-desktop-ssh-container/` and
`docs/pocs/2026-11-25-2146-devcontainer-laptop-layer/`.

## Crates

One workspace in `agentbook/`, crates under `agentbook/crates/`:

| Crate (folder) | Role |
|---|---|
| `agentbook-core` (`core/`) | Pure domain model (folders, laptops, variables), `state.json` and in-container state file types, every algorithm. No I/O, no clock. Table-tested by `core/tests/algo.rs`. |
| `agentbook-platform` (`platform/`) | The `Platform` trait (data / ssh / home dirs, Docker endpoint, OpenSSH version, credential store, `ssh-keygen`, key ACLs, open URL / folder, folder picker, OS fonts, host `core.autocrlf`) and its Windows and macOS (alpha) implementations. The only crate allowed OS-specific code. |
| `agentbook-engine` (`engine/`) | Docker (bollard), devcontainer CLI, first-launch downloads, Equipment pipeline, laptop lifecycle, SSH config, variables, context push. Depends only on core and the `Platform` trait. Runs on a tokio runtime in a background thread; the UI sends `Command`s and renders the latest `Snapshot`. Owns the scenario test target. |
| `agentbook` (`app/`) | The egui desktop app (lib `agentbook_app` + binary `AgentBook.exe`) on winit + wgpu, wired by hand (no eframe). Calls only engine commands; uses OS fonts (egui's bundled fonts fail the licence allowlist). See "Desktop UI". |
| `agentbook-setup` (`setup/`) | The installer, binary `AgentBook-Setup.exe`: embeds `AgentBook.exe` and copies it to `%LOCALAPPDATA%\Programs\AgentBook\` with a Start-menu shortcut, no admin rights. |

## Platform layer

`agentbook-platform` (`crates/platform/src/lib.rs`) defines `Platform` (held as `Arc<dyn Platform>`,
`agentbook_platform::native()` returns the OS one) and `WindowsPlatform` (`src/windows/`):

- Folders: home and `%LOCALAPPDATA%\AgentBook` from known folders; `ssh_dir` is `<home>\.ssh`.
- `docker_endpoint()`: `src/docker.rs` reads `DOCKER_HOST`, `DOCKER_CONTEXT`,
  `<DOCKER_CONFIG or ~/.docker>/config.json` and the context `meta.json`, lets core's
  `docker_endpoint::resolve` decide and probes each candidate (pipe: `WaitNamedPipeW`; local tcp:
  a connect). Success and every error (`NotLocal`, `Unsupported`, `NotRunning`) carry `probed`,
  the list of what was read and tried.
- `find_program`, `openssh_version` (first `ssh.exe` on PATH, `-V` parsed by core),
  `ssh_keygen` (the `ssh-keygen.exe` next to that `ssh.exe`), `host_git_autocrlf` (global and
  system values; `.effective()` applies core's rule). Child processes start with no console window;
  `prepare_command` does the same for programs the engine starts (the devcontainer CLI).
- `system_proxy()`: `HTTP(S)_PROXY` / `NO_PROXY` when set, else the per-user Windows proxy
  (`Internet Settings` `ProxyEnable` / `ProxyServer` / `ProxyOverride`, `src/windows/proxy.rs`);
  passed as build args to every image build the engine starts.
- Credentials: Windows Credential Manager generic credentials whose target name is exactly
  `credential_target(prefix, folder, laptop, NAME)`, UTF-8 value (at most 2560 bytes), persisted
  per user on this computer; `credential_list(prefix)` enumerates by prefix (stand cleanup).
- `restrict_private_key`: a protected DACL with one full-control entry for the current user's SID
  (the PoC `icacls /inheritance:r /grant:r` recipe, done natively); Windows OpenSSH accepts it.
- `clipboard_set` / `clipboard_get` (`src/windows/clipboard.rs`, Unicode text): Copy log and copy / paste in the UI's text fields (default: none).
- `ui_fonts()`: Segoe UI, Segoe UI Semibold (`FontRole::Bold`), then Segoe UI Symbol / Emoji, YaHei, JhengHei, Yu Gothic, Malgun,
  Nirmala, Leelawadee, Ebrima, then Consolas, from the system font folder, only files that exist.
- **macOS** — `MacPlatform` (`src/macos/`, `cfg(target_os = "macos")`, an untested alpha: built
  only by cross-compiling, never run in CI or the scenario suite):
  - data in `~/Library/Application Support/AgentBook`; Docker through core's non-Windows
    candidates (`~/.docker/run/docker.sock`, then `/var/run/docker.sock`; Docker Desktop's
    `desktop-linux` context comes through the context `meta.json`), probed with a socket connect;
  - `find_program` searches PATH plus `~/.docker/bin`, `~/.orbstack/bin`, `/opt/homebrew/bin`,
    `/usr/local/bin` and Docker.app's `bin` (an app started from the Finder only has
    `/usr/bin:/bin:/usr/sbin:/sbin`), and `prepare_command` puts that same list into the PATH of
    every program the engine starts. `host_git_autocrlf` counts git only when `git --version`
    runs, because `/usr/bin/git` is a stub when the Command Line Tools are missing;
  - credentials are login-Keychain generic passwords (service `AgentBook`, account = the
    credential target), through `security-framework` (`src/macos/credentials.rs`);
  - `restrict_private_key` is `chmod 600`; URLs and folders open with `/usr/bin/open` (`-R` for a
    file); the folder panel comes from rfd (AppKit);
  - the clipboard goes through `pbcopy` / `pbpaste` with a UTF-8 `LANG`;
  - the proxy is read from `scutil --proxy` (HTTP/HTTPS enable/host/port and `ExceptionsList`;
    a PAC file is not evaluated);
  - fonts are Arial / Arial Bold / Arial Unicode, Apple Symbols, Hiragino Sans GB, Apple SD Gothic
    Neo, Kohinoor and Thonburi, then Menlo. Apple Color Emoji is left out because egui cannot draw
    its sbix bitmaps;
  - the OpenSSH floor check is skipped, as on any non-Windows OS (macOS 13+ ships 9.x).

  There is no macOS installer: `agentbook-setup` stays Windows-only and is not built for macOS.
- `scripts/platform-check.mjs` (in `npm run lint`) fails on `cfg(windows)` / other OS cfgs,
  `std::os::windows`, Windows API crates or OS-specific Cargo dependencies anywhere outside
  `crates/platform`. The installer's Start-menu shortcut therefore also belongs behind this crate.

## Per-user data folder

`%LOCALAPPDATA%\AgentBook\` on Windows (the platform data dir on macOS). An installed copy and a
copy run straight from Downloads share it, so every format here is **additive-only**.

| Path | Holds |
|---|---|
| `state.json` | `schema_version` 1, folders, laptops, recent folders. Never a hidden value. Unknown fields are kept on write; a newer `schema_version` opens read-only with "update AgentBook". |
| `agentbook.lock` | Single-instance lock: a second copy only says AgentBook is already running. |
| `laptops/<id>/key/` | `ssh_host_ed25519_key[.pub]`, `authorized_keys`; mounted into the container. |
| `laptops/<id>/client/` | `id_ed25519[.pub]`, host-only, private key ACL-restricted to the user. |
| `laptops/<id>/gen/<n>/` | One container generation: `meta.json` (images, Equipment hash, libc, SSH user, home), `merged.json` (the merged devcontainer config) and the generated override `devcontainer.json` (and `agentbook-compose.yml`). The previous generation stays until the next one runs (rollback, recreate). |
| `folders/<fid>/state/` | Per-folder state, mounted read-only into the folder's laptops. |
| `tool-files/` | `ws`, `prompt-hook`, the `agentbook-ws` skill; rewritten by the running tool version. |
| `deps/node-<v>/`, `deps/devcontainers-cli-<v>/`, `deps/node-<v>-linux-<arch>.tar.xz` | First-launch downloads, sha256-checked against constants in core (`pins`). Downloads go to `<file>.part` first; folders are extracted into `<name>.tmp` and renamed. |
| `logs/` | Build logs; never contain variable values. |

Outside the data folder:

- `~/.ssh/config` gets one line at the **top**, `Include ~/.ssh/agentbook/config`; the user's blocks
  are never edited. `~/.ssh/agentbook/config` has one block per alias `sbx-<id>` (`<id>` is 8
  lowercase base32 characters, stable forever, never derived from the laptop name) plus
  `~/.ssh/agentbook/known_hosts_sbx-<id>`.
- Hidden variable values live in the OS credential store as `AgentBook/<folderId>/<NAME>` and
  `AgentBook/<folderId>/<laptopId>/<NAME>`, removed with their folder or laptop.
- Claude Desktop is opened with
  `claude://code/new?ssh_host=sbx-<id>&ssh_folder=<url-encoded container path>`.

## Docker objects

- Labels: `artisyn.agentbook=1`, `artisyn.agentbook.laptop=<id>`, `artisyn.agentbook.folder=<fid>`,
  `artisyn.agentbook.gen=<n>`, plus `artisyn.agentbook.instance=<run>` on scenario stands only.
- Laptop containers carry all labels; home volumes `agentbook-home-<id>` carry `.laptop`; images
  `agentbook-std:<v>`, `agentbook-eq:<confighash>`, `agentbook-laptop:<basehash>-<layerv>` carry
  `artisyn.agentbook=1`; compose sidecars carry no tool label and are found by the compose project
  `agentbook-<id>`.
- Containers are always found by label; anything is removed only by exact label, name or tag
  (deletion guards as in `docker-dev-container.md`).
- SSH is container port 22 published as `127.0.0.1:<port>:22`, port picked in 20000–29999.

## In-container contract

Fixed from version 1, so a laptop created by an older tool keeps working:

- Read-only mounts `/opt/agentbook/bin` (`ws`, `prompt-hook`), `/opt/agentbook/key`,
  `/opt/agentbook/state` (per folder: `folder.json`, `laptops/<id>.json`, additive-only JSON).
- tmpfs `/run/agentbook` with `base.env` (the container's own env, dumped by `entry.sh`) and
  `env/session.env`: one `NAME='value'` POSIX-sh assignment per variable, `'` written as `'\''`,
  names matching `[A-Za-z_][A-Za-z0-9_]*`. Values never touch host disk or a volume and vanish on
  stop. The tool rewrites it on every running laptop of the folder when the Variables change, but a
  session reads it only at its start; `ws env` (`ls` / `get NAME` / `run CMD…`) re-reads it on
  every call, so a Variable added mid-session works through `ws env run <command>` without a new
  session, and the prompt hook adds one line ("Variables changed after this session started: X
  (new)") when the file differs from the session's environment (cached per laptop, printed again
  only when that difference changes). Known limitation: a laptop started outside the tool while AgentBook is closed has no
  Variables until AgentBook is opened again.
- Layer files `/usr/local/share/agentbook/{entry.sh,session.sh}`; sshd uses `ForceCommand` →
  `session.sh`, which sources `base.env` then `session.env`. The `agentbook-laptop:*` image's
  `devcontainer.metadata` label gets one extra entry,
  `{"id":"agentbook-laptop","entrypoint":"/usr/local/share/agentbook/entry.sh"}`.
- Shared folder at `/work/<folder name>` or the devcontainer's `workspaceFolder`; given folders at
  `/work/given/<basename>[-N]`.
- Home-volume files the tool writes: `~/.gitconfig` keys (`core.fileMode`, `core.autocrlf`,
  `safe.directory`), `~/.claude/CLAUDE.md` (whole), the `UserPromptSubmit` hook entry in
  `~/.claude/settings.json` whose command is exactly `/opt/agentbook/bin/prompt-hook` (the merge
  key), host `~/.claude/{skills,agents,commands}` replaced by name, and the reserved
  `~/.claude/skills/agentbook-ws/`. `.credentials.json` is never copied.
- `ws whoami`, `ws mounts`, `ws env`: plain text in the UI vocabulary (`ws env get` prints one raw value).
- The laptop's host key is generated with the comment `agentbook-laptop-<id>`
  (`assets::host_key_comment`): the state directory is shared by every laptop of a folder, so
  `ws` reads which laptop it is on from that comment of `/opt/agentbook/key/ssh_host_ed25519_key.pub`
  (`entry.sh` also copies the `.pub` to `/run/agentbook/`). Windows OpenSSH's `ssh-keygen` ends
  that `.pub` line in CRLF (Git for Windows' `ssh-keygen` does not), so `ws` strips `\r` before it
  takes the comment — otherwise the id carries the CR, matches no state file and `ws whoami` says
  "this laptop". The scenario suite usually runs from Git Bash and finds Git's `ssh-keygen` first,
  so it does not exercise the CRLF case.

## Laptop assets (`agentbook/assets/`)

Embedded in the engine by `crates/engine/src/assets.rs` (`include_str!`, LF enforced by
`.gitattributes` and again in `Asset::text`). The layer and standard versions are content hashes
of these files (`layer::version()`, `standard::version()`), so any change marks laptops
"Equipment changed" through the config hash without a manual bump.

| Path | What it is |
|---|---|
| `layer/Dockerfile`, `layer/install.sh` | The laptop layer, built `FROM ${BASE}` with build arg `SSHUSER`. `install.sh` (POSIX sh, apt-get or apk) installs sshd + SFTP (Alpine also `libstdc++ libgcc ripgrep bash git`, Debian/Ubuntu `git ca-certificates procps`; the packages show in the build log), creates the SSH user (unlocked on Alpine), writes `/etc/ssh/sshd_agentbook_config` (key-only, `AllowUsers`, `ForceCommand`, `PermitRootLogin no`/`prohibit-password` for root), records `ssh-user` and `libc` (`glibc`/`musl`) in `/usr/local/share/agentbook/` and links `/usr/local/bin/ws`. `USER 0` (not `root`) so a scratch base fails on `/bin/sh` rather than on a missing passwd file. |
| `layer/entry.sh` | Entrypoint: keys → tmpfs `/run/agentbook` (755), the SSH user takes the uid/gid of the shared folder's owner when that is not root (`match_owner`, like devcontainers' `updateRemoteUserUID`: a folder inside a WSL distro keeps its Linux owner, uid 1000, while `claude` is 1001 on Ubuntu 24.04; home files move along; scenario step `wsl-owner`), `export -p` → `base.env`, sshd, `exec "$@"` (sleeps when there is no command). A non-root container user goes through `sudo -n` when it can; otherwise SSH is not started and stderr says why. |
| `layer/session.sh` | `ForceCommand`: sources `base.env` (keeping the session's HOME/USER/LOGNAME/SHELL), then `env/session.env` with `set -a`, then runs `$SSH_ORIGINAL_COMMAND` or a login shell. |
| `standard/Dockerfile` | `agentbook-std`: `ubuntu:24.04@sha256:…` (the only place the digest is named; `standard::base_image()` reads it), git, ca-certificates, curl, xz-utils from apt, Node from the host-downloaded `node-linux.tar.xz` checked against build arg `NODE_SHA256` (pins in `agentbook_core::pins`), `CMD sleep infinity`. |
| `tools/ws`, `tools/prompt-hook` | The `/opt/agentbook/bin` files. `ws` has a small awk JSON flattener, so it needs no `jq` and ignores unknown fields; it finds repos up to 4 levels below the shared folder (skipping `node_modules`, `.worktrees` and linked worktrees). `prompt-hook` runs `ws __prompt-hook`: branch from `.git/HEAD`, `git status --porcelain -uno` under `timeout 1` (`?` on timeout), cached 5 s per repo in `~/.cache/agentbook/`, plus a "Connected folders changed" line when the given folders differ from its last run (the first run only records them). |
| `skills/agentbook-ws/SKILL.md` | The `agentbook-ws` skill: when and how to use `ws whoami` / `ws mounts` / `ws env`. |
| `claude-md/CLAUDE.md.template` | `~/.claude/CLAUDE.md`, rendered by `assets::claude_md::render` (`{{laptop_name}}`, `{{shared_folder_name}}`, `{{shared_path}}`, `{{shared_host_path}}`, `{{home}}`, `{{connected_folders}}`, `{{variables}}`; names only, substituted text is not re-scanned). |

A failed layer build whose log has the `AGENTBOOK-LAYER-UNSUPPORTED` marker (shell but no apt-get /
apk) or a `/bin/sh` "no such file" error (scratch, distroless) is mapped by
`layer::is_unsupported_base` to `layer::UNSUPPORTED_MESSAGE`.

## Engine (`crates/engine/src/`)

- `Engine::new(platform, data_dir_override, Option<EngineTestConfig>)` takes the single-instance
  lock (`lock.rs`: `File::try_lock` on `agentbook.lock`; a second copy gets
  `EngineStartError::AlreadyRunning`), loads `state.json` (an unreadable one is shown read-only,
  never overwritten) and starts a 2-thread tokio runtime that checks the prerequisites, the
  downloads and every folder's Equipment. `Engine::run(Command)` returns an action id at once;
  `Engine::snapshot()` returns the `Snapshot` (`snapshot.rs`: Docker and OpenSSH status,
  `docker_cli`, dependencies, folders with `FolderEquipment` {hash, exposures, error}, laptops
  with their `EquipmentState`, actions with steps, state, log tail and log file).
  `state.json` is written temp-then-rename.
- `docker/`: the bollard client for the endpoint the platform resolved (`connect_with_local` for
  a pipe or socket, `connect_with_http` for tcp). `DockerError::plain_message` gives the FR-9
  text "No Docker-compatible engine found…" for an unreachable engine, `endpoint_message` the
  "needs a Docker engine on this computer" text for a remote one. `docker_host_value` is the
  `DOCKER_HOST` handed to the CLI (`npipe:////./pipe/<name>`).
- **Docker Engine inside WSL** (no Docker Desktop): endpoint kind `wsl`, address = distro. It is
  the last Windows default candidate (any distro, Docker Desktop's / Rancher Desktop's own skipped)
  or `DOCKER_HOST=wsl://<distro>`. `platform/src/windows/wsl.rs` probes a distro as root
  (`wsl.exe -d <d> -u root -e sh -c …`: socket, `docker` command, `docker version`, then
  `wslpath -u 'C:\'` for the automount root, kept in `DockerEndpoint.wsl_mount_root`) and gives
  `Platform::docker_dial_command` = `wsl.exe -d <d> -u root -e docker system dial-stdio`.
  `docker/bridge.rs` listens on `127.0.0.1:<random>` and starts that program per client
  connection (the client keeps connections alive; each `exec` attach is one more `wsl.exe`); the
  bridge lives with the cached client in `Ctx.docker`. Bind sources go through
  `docker::engine_path` → `paths::wsl_path` (`D:\x` → `/mnt/d/x`, `\\wsl.localhost\<d>\x` → `/x`,
  other UNC refused). WSL stops an idle distro ~15 s after its last `wsl.exe`, laptops included,
  so starting the bridge calls `Platform::docker_keep_alive`: one hidden
  `wsl.exe -d <d> -u root -e sh -c "while :; do sleep 3600; done" agentbook-keep-alive`, started
  unless `/proc/*/cmdline` already shows one, and left running when AgentBook closes (laptops then
  keep running, as with Docker Desktop; it ends with the Windows session or `wsl --shutdown`).
  A test runner's job object (node) ends it with the test, so the scenario step
  `wsl-keep-alive` only checks that it runs; survival with no client is a manual acceptance
  item. WSL's localhost relay frees a stopped container's port on Windows ~0.5 s later, so Wake
  up waits up to 2 s for the laptop's own port before moving it. Published ports reach Windows
  through WSL's localhost forwarding. Project
  devcontainers are refused there (`WSL_PROJECT_MESSAGE`: the devcontainer CLI hands Windows
  paths to `docker`). The loopback bridge has no authentication, like Docker's own TCP socket:
  any local process can reach the engine through it while AgentBook runs. Scenarios run against
  it with `DOCKER_HOST=wsl://<distro>` (the stand starts the same bridge).
- `deps.rs` (FR-10): Node win-x64 zip (only `node.exe` is extracted), the `@devcontainers/cli`
  npm tarball (`package/` stripped) and the standard Equipment (the Linux Node archive for the
  engine's arch, then a pull of the pinned Ubuntu base by digest, then the `agentbook-std:<v>`
  build). reqwest with native TLS and the OS proxy; `download_verified` writes `.part`, checks
  the sha256 and renames, deleting the part on a mismatch or a cut. The items are independent; a
  second launch finds them all and downloads nothing.
- `devcontainer.rs`: the CLI run with the downloaded Node, `--docker-path` set to the `docker` on
  PATH, `DOCKER_HOST` set and `DOCKER_CONTEXT` removed: `read-configuration
  --include-merged-configuration`, `build`, `up --override-config --id-label …` (compose with
  `COMPOSE_PROJECT_NAME=agentbook-<id>`). Its log lines stream into the action log.
- `equipment.rs` (FR-7):
  - `prepare`: config hash (the config, every file in its folder, the referenced Dockerfile and
    compose files, plus the standard and layer versions), host exposure, SSH user.
  - `build`: the project image `agentbook-eq:<hash>`, cached by hash. The CLI builds it under
    `agentbook-eq-build:<hash>` and a one-line build adds the tool's labels, because the CLI does
    not apply `--label` to every kind of build. Then the layer
    `agentbook-laptop:<sha(base id, SSH user)>-<layerv>` with the entrypoint entry appended to
    `devcontainer.metadata`; the libc is read from the image without starting it.
  - `launch`: standard Equipment through bollard (shared folder, key/bin/state and given binds,
    home volume, tmpfs, loopback port, labels); project Equipment through the override config and
    `up`.
  - `replace`: the next generation. Non-compose: stop old, start new, then drop old; on failure
    the new one is removed and the old one started again. Compose: the CLI finds a compose laptop
    by project and service, not by the id labels, so the old primary container goes first and a
    failed `up` re-runs `up` with the previous generation's record (sidecars stay).
  - Actions: `get_equipment_locked` (first build, Retry), `rebuild` (Update laptop),
    `recreate_locked` (current images; for give folder and port reallocation). The caller holds
    the laptop lock. A libc switch clears `~/.claude/remote/ccd-cli`. `gc_images` removes
    unreferenced `agentbook-eq/-laptop/-std` images by exact tag (a scenario stand's images are
    left to the stand). `check_all` runs at start and before every Open. `launch` makes the
    laptop's keys and the tool files before the first container, so sshd always starts with them.
  - Lifecycle helpers: `workspace_folder` (the shared folder's path in the laptop for a
    generation, through the override generation), `main_container`, `stop_laptop` /
    `start_laptop` (compose sidecars included).
- `lifecycle.rs` (FR-1, FR-1a, FR-2, FR-6, FR-8, FR-11): every folder and laptop command.
  - `AddFolder` scans for `.claude/` (`claude_dir` algorithm, depth 8, symlinks skipped) and
    devcontainer configs (`.devcontainer/devcontainer.json`, `.devcontainer.json`,
    `.devcontainer/<name>/devcontainer.json`); several `.claude/` are asked once
    (`FolderView::claude_choices`, `ChooseClaudeDir`), several configs are listed in
    `config_choices` (`ChooseEquipment`). The same path again picks the existing folder.
  - `GetLaptop` (with `copy_from` for "Another laptop like this": the source's per-laptop
    variables, Hidden ones copied in the credential store; `Engine::like_this` gives the dialog's
    pre-fill, `Engine::suggest_name` the "Laptop N") records the laptop with a random free port in
    20000–29999 (probed on `127.0.0.1`), builds or reuses the Equipment, starts it and opens
    Desktop.
  - `Open` / `WakeUp`: missing bind sources (shared or given) refuse with a message naming the
    folder; `check_all`; a stopped laptop whose port is taken moves to a new port (state, then
    `recreate_locked`) with a one-line `LaptopView::note`; then `after_start`; `Open` also opens
    `claude://code/new?ssh_host=sbx-<id>&ssh_folder=<workspace folder>/<claude_dir>`.
  - `after_start` (every start, recreate and Update): keys, the alias, tool files, the folder's
    state files, the context push and the env file.
  - `Sleep` stops the containers (compose sidecars too); `Rename` changes only the record and
    the state files (duplicate names in a folder get `LaptopView::duplicate_name`).
  - `GiveFolder` / `SetGivenMode` / `RemoveGiven` recreate the container (volume kept); the old
    given list is put back on failure. A drive root, the home folder or one of its ancestors
    (`broad_folder`) needs `confirm_broad` (also for `AddFolder`, `GetLaptop` and `LocateFolder`).
  - `RemoveLaptop`: compose laptops get `docker compose -p agentbook-<id> -f <override's files>
    down -v` (then removal by the compose project label for anything left); the containers, the
    home volume, the alias and known_hosts, the laptop's credentials and `laptops/<id>/`.
    `RemoveFolder` removes its laptops, credentials and `folders/<fid>/`; the folder on disk is
    never touched. `LocateFolder` re-points the folder and recreates its laptops (project
    Equipment through `rebuild`, which reuses the cached images, because its config moved too).
- `ssh.rs`: the host key (comment `agentbook-laptop-<id>`) and client key via the platform's
  `ssh-keygen` (client key ACL-restricted), `authorized_keys`, the alias block between
  `# >>> sbx-<id>` / `# <<< sbx-<id>` (rewritten only when it changed, so a reallocation touches
  only that block), the alias's known_hosts and the `Include` line at the top of `~/.ssh/config`
  (written in place, so its ACL stays).
- `context.rs`: `tool-files/` (rewritten when different), the folder state files
  (`folder.json`, `laptops/<id>.json` with the run state, given folders and variable names;
  stale laptop files removed) by write-then-rename, and the Open push: one root exec removes the
  entries to be replaced and reads the SSH user's uid/gid and `settings.json`; one tar through the
  archive endpoint brings `CLAUDE.md`, the merged `settings.json` (an invalid one is left alone),
  host `~/.claude/{skills,agents,commands}` (never `.credentials.json`) and the `agentbook-ws`
  skill; a chown follows; git defaults are set as the SSH user with `git config --global`.
- `vars.rs` (FR-12): project defaults from the merged config, `SetVariables` (Hidden values only
  in the credential store, `VarInput::Hidden(None)` keeps the stored value, removed Hidden
  settings lose their credential), the snapshot's `FolderView::variables` rows and
  `LaptopView::needs_value`, and `deliver`: the env file written over `docker exec` stdin as root
  (`umask 077`, owned by the SSH user, renamed into place). `Secret`'s `Debug` never shows the
  value.
- `poller.rs`: every 5 s (`POLL_INTERVAL`), for each laptop whose lock it can take (a laptop an
  action holds is skipped: the action sets its state, and a look taken meanwhile would overwrite
  a fresh Working with a stale Sleeping), lists that laptop's containers by label (Working /
  Sleeping / NotCreated in `LaptopView::run`, so a stop outside the tool shows Sleeping), counts
  sessions with one root exec of `cat /proc/net/tcp /proc/net/tcp6` per Working laptop, rewrites
  the env file of a running laptop that has none (under that same lock) and
  writes the folder state files on a run-state change. The same probe notices Claude Desktop's
  first connection to a laptop: Desktop copies its server and the Claude Code CLI (a few hundred
  MB) into `~/.claude/remote` over SFTP and only then starts that server with `--serve`. While an
  `sftp-server` process runs, no `--serve` one does and a session is attached, the probe's `du` of
  every `~/.claude/remote` becomes `LaptopView::claude_setup_kb`, and the card shows "Claude
  Desktop is setting up Claude here: N MB copied" with a box that offers **Variables…** meanwhile
  (they reach the laptop at once and `ws env` reads them in the session). The copy lives in the
  laptop's home volume, so each new laptop gets it again.

## Desktop UI (`crates/app/src/`)

- **Window** (`window.rs`): egui on winit + wgpu through `egui-wgpu` (Direct3D 12, Vulkan
  fallback, Metal later), wired by hand instead of eframe, because eframe forces egui-winit's
  `clipboard` feature whose Windows crates (clipboard-win, error-code) are BSL-1.0 and fail the
  licence allowlist. Copied text is taken from egui's output and Ctrl+V / Shift+Insert inject the
  clipboard text, both through the platform layer. OpenGL (glutin + egui_glow) was tried first and
  showed a blank window on a hybrid-GPU Windows 11 laptop, as did egui_glow's own example.
- **Fonts** (`fonts.rs`): only `Platform::ui_fonts()` (primary + fallbacks for Cyrillic / CJK
  names, a `bold` family, monospace for logs). **Theme** (`theme.rs`): the wireframes' light
  colours and button shapes. **Icons** (`icons.rs`): the kawaii laptop mascot as pre-rendered
  pictures, one per face (Working, Sleeping, Getting equipment, Not started, and Waking up on the
  Wake up button), square, at 54 / 36 / 21 px; the same Working picture is the window icon, and a
  desk scene heads the About dialog (top bar → About). The app has no PNG decoder (no image
  crate, fewer licences), so `scripts/make-images.ps1 -Source <folder>` converts the source PNGs
  once into raw RGBA files checked in as `crates/app/images/*.rgba` (u32 LE width and height,
  then RGBA bytes): it clears the off-white background reachable from the edges, crops to the
  character and scales to 192 px (the About scene keeps its background, 720 px wide). Each
  picture becomes an egui texture on first use. The exe files' own icon (Explorer, Start menu) is
  the same laptop: the script also writes `images/icon-<16…256>.png`, and `crates/app/icon.rs`
  (`include!`d by the app's and the installer's `build.rs`) packs them into a Windows resource file
  by hand (RT_ICON per PNG + RT_GROUP_ICON 1, no resource compiler or crate) that MSVC's linker
  takes as an input. Non-MSVC targets get no exe icon.
- **Screens**: `app.rs` (state, top bar, banners for failed actions without a card, footer with the
  engine version, its API version and the OpenSSH version — `docker_words`; the engine's product
  name (Docker Desktop, Rancher Desktop, …) is never read or shown, dialog dispatch, the first-launch download started once the engine
  reports `dependencies_checked`), `setup.rs` (prerequisites when Docker or OpenSSH failed;
  first-launch download while an item is not Ready), `home.rs` (every folder: tiles, no-laptops and
  missing cards, drop zone), `folder.rs` (folder view, cards in two columns, devcontainer config
  choice, Good to know), `choose.rs` (drag-and-drop, Browse… on a thread, recent folders from
  `Snapshot::recent`), `laptop.rs` (tile and card; Equipment states from the laptop's latest
  action: building = state A, failed first build = B with log tail, Copy log and Retry, Equipment
  changed = C with Update laptop…, the needs-a-value note, missing sources).
- **Dialogs** (`dialogs.rs`, `variables.rs`): Get a laptop and Another laptop like this (copied
  per-laptop variables warning), the FR-8 consequences dialog (give a folder, mode change, take
  away, Update laptop, Locate folder), the whole-disk confirmation (core `broad_folder`), Sleep
  (only with sessions attached), Remove laptop, Remove folder, the `.claude/` chooser, Rename, the
  Update progress (a failure keeps the old laptop: Close / Retry) and Variables.
- **Help** (`help.rs`): `agentbook/help/*.md` embedded with `include_str!` and rendered from
  CommonMark (pulldown-cmark); `help:<page>` links move between pages, there are no web links.
- Engine additions for the UI: `Snapshot::recent`, `Snapshot::dependencies_checked`,
  `FolderView::repos` (`engine/src/repos.rs`: the folder and its direct subfolders with a `.git`,
  branch read from `HEAD`, files only); `vars::apply` keeps a variable kind written by a newer tool.
- **Visual-check stand** (manual, not a test): `cargo run -p agentbook --example visual_stand`
  from `agentbook/` runs the real window on a real engine with the home, `.ssh` and data folders in
  `tmp/agentbook-visual/`, instance label `visual`, seeded fixture folders and printed `claude://`
  links; `-- --clean` removes its folders, laptops, Docker objects and Hidden values.
- **egui hit-testing gotcha:** a click sense added to a container *after* its children (e.g.
  `frame.response.interact(Sense::click())`) sits on top of them and swallows clicks on the
  buttons inside. The choose-folder drop area reads its double click from raw input
  (`pointer.button_double_clicked` + `contains_pointer`) for this reason.
- The window has no AccessKit (egui-winit is built without default features), so UI Automation
  does not see its controls; automated clicking needs coordinates and real mouse moves first
  (egui learns the pointer position only from move events).

## Distribution: build, installer, CI and release

- **Build** — `npm run build` runs `agentbook/scripts/build.mjs`: a release build of the workspace
  except the installer, then `agentbook-setup` with `AGENTBOOK_EMBED_EXE` set to
  `target/release/AgentBook.exe`. `crates/setup/build.rs` embeds that file (`include_bytes!`);
  without the variable (clippy, a plain `cargo build --workspace`) it embeds an empty payload and
  such a setup only says it was built without AgentBook.exe. The script fails when the setup is not
  larger than the app. Output: `target/release/AgentBook.exe` and `target/release/AgentBook-Setup.exe`.
- **macOS build** — `npm run build:macos` runs `agentbook/scripts/build-macos.mjs` on Windows or
  Linux with no Mac needed. It writes `Info.plist` (bundle id `com.artisyn.agentbook`, macOS
  11+), `AgentBook.icns` (built from `crates/app/images/icon-*.png` as PNG-type ICNS entries) and a
  README into `target/macos/stage/`. In the `messense/cargo-zigbuild` Docker image (Zig
  as linker, a macOS SDK inside) it then runs
  `cargo zigbuild --release --locked -p agentbook --target universal2-apple-darwin` (arm64 + x86_64),
  assembles `AgentBook.app`, signs it ad hoc with `rcodesign` and zips it with the Unix modes kept
  into `target/macos/AgentBook-<version>-macos.zip`. The toolchain, crate cache and build cache
  live in the Docker volumes `ab-mac-rustup`, `ab-mac-cargo` and `ab-mac-target`. The build is not
  notarized, so Gatekeeper blocks the first start: the README explains Open Anyway or
  `xattr -dr com.apple.quarantine`. On the Mac, Node.js comes from the pinned darwin tarball
  (`agentbook_core::pins::node_host_archive`), and only `bin/node` is unpacked.
- **Installer** (`crates/setup/src/main.rs`, OS calls in `crates/platform/src/windows/install.rs`,
  exported as `agentbook_platform::installer`):
  1. writes the embedded exe as `AgentBook.exe.new` in `%LOCALAPPDATA%\Programs\AgentBook\` and
     renames it over `AgentBook.exe`, so a failed copy never leaves a half-written exe;
  2. while AgentBook runs — the data folder's `agentbook.lock` (`agentbook_core::INSTANCE_LOCK_FILE`)
     is held, probed with a shared lock and only opened, never created; or the exe cannot be
     replaced (sharing violation / access denied) — it shows Retry / Cancel ("close every AgentBook
     window") instead of failing; Cancel removes the staged file;
  3. creates `AgentBook.lnk` in the user's Start-menu Programs folder (`IShellLinkW` through the
     `windows` crate, the release wgpu already locks);
  4. offers to open AgentBook.

  It never writes the data folder, so a newer setup over an older install keeps folders and
  laptops. No admin rights, no uninstaller (delete the folder and the shortcut). `--quiet` (no
  dialogs; exit 3 when AgentBook is running or the user cancels, 2 on a bad option, 1 on failure),
  `--dest <dir>` and `--start-menu <dir>` serve scripted installs and checks. Both exes are 64-bit
  (Windows installer detection, which elevates unmanifested 32-bit `*Setup*` exes, does not apply)
  and unsigned.
- **CI** — the `agentbook-fast` job in `.github/workflows/checks.yml` (lint, algorithm tests,
  build on `windows-2025`) runs only when the repository variable `AGENTBOOK_CI` is `true`, like
  `work-hub-fast` with `WORK_HUB_CI`. The scenario suite needs a local Docker engine and stays a
  local `finalOnly` check.
- **Release** — `.github/workflows/agentbook-release.yml`, manual dispatch from the default branch
  only. The version is `[workspace.package] version` in `agentbook/Cargo.toml`
  (`agentbook/scripts/version.mjs`). It builds on Windows (lint, algorithm tests, build), then
  creates the tag `agentbook-v<version>` through the REST API and a release with `AgentBook.exe`,
  `AgentBook-Setup.exe` and `SHA256SUMS`, marked `--latest=false` (latest stays Log Hub's). A
  release that already exists fails the run: bump the version first. `agentbook-v*` tags are not
  strict `vX.Y.Z` tags, so Log Hub's `scripts/ci/release-version.js` ignores them.

## Commands and checks

All run from `agentbook/` (the CLAUDE.md "AgentBook" section is the canonical table):
`npm run lint` (rustfmt, clippy `-D warnings`, `scripts/license-check.mjs`, `scripts/platform-check.mjs`), `npm run test:algo`,
`npm run build` (`scripts/build.mjs`, both exes), `npm run test:scenarios`. The checks are in
`.claude/repo_config/agentbook-health-checks.json` and are **not run by default** — it is not
referenced from `repo-health-checks.json`. `agentbook/target` is ignored by `agentbook/.gitignore`.

The licence check uses Work Hub's permissive allowlist with **no reviewed exceptions** — in
particular no font exception, so egui's bundled OFL / Ubuntu-font fonts must stay disabled.

## Test policy

- **Algorithm** — `docs/knowledgebase/algorithms/agentbook-*.md` with rows in
  `docs/algorithm-examples/agentbook-*.json`, run by `agentbook/crates/core/tests/algo.rs`. The
  docs: `agentbook-state-file` (load / write-back of `state.json`, ids), `agentbook-claude-dir`,
  `agentbook-container-paths` (with the alias and the `claude://` link), `agentbook-broad-folder`,
  `agentbook-variables` (Hidden-by-name, resolution, env file), `agentbook-ssh-user`,
  `agentbook-equipment` (config hash, libc switch), `agentbook-host-exposure`,
  `agentbook-override-config`, `agentbook-autocrlf`, `agentbook-docker-endpoint`,
  `agentbook-session-count`, `agentbook-openssh-version`.
- **API contract** — none (no routes).
- **Scenario** — the Rust suite in `agentbook/tests/scenarios/` (the `scenarios` test target of
  `agentbook-engine`, `harness = false`), driven by `scripts/scenarios.mjs`. It drives `Engine` with
  an `EngineTestConfig` (instance label, local download server, recording fake Desktop launcher,
  `AgentBook-test-<instance>/` credential prefix) and a `TestPlatform` whose home, `.ssh` and data
  dir are under the repo's `tmp/`, and checks laptops over ssh/sftp. Coverage is not measured.
  - Stand: `tmp/agentbook-scenarios/<instance>/` (removed at the end) and
    `tmp/agentbook-scenarios/cache/` (the real Node and CLI files, fetched once and kept), served
    by `server.rs`, which can corrupt a byte or cut a file halfway. Cleanup removes only objects
    with the stand's instance label or a compose project of its own laptops, its prefixed
    credentials and its own folder. Fixtures are plain-file / JS projects the steps write, with no
    `.claude/`.
  - Steps, in order (`--only ac17,laptops` picks some): `ac17` (dependency list, lock,
    checksum mismatch, cut download, a standard laptop while the CLI is missing, Retry, second
    launch downloads nothing), `ac6` (Dockerfile devcontainer with a tool off the default PATH,
    docker.sock warning, cached second laptop, Equipment changed → Update keeps the volume, broken
    Dockerfile during Update and on a first build, Debian → Alpine), `ac6-compose` (sidecar, a
    failed Update rolls back), `laptops` (AC-1, 2, 3, 4, 4a, 10, 11, 12, 14, 15, 18, 19 on the
    standard Equipment), `given` (AC-7, 13, 9), `variables` (AC-16), `images` (AC-7a and AC-6
    over ssh), `ac7a-scratch` (a scratch-based image built by the stand, since the devcontainer CLI
    cannot read a Dockerfile whose base is `scratch`, gets the plain layer message). The lifecycle steps connect with the system `ssh -F <fake home>/.ssh/agentbook/config
    sbx-<id>` (the fake home's `Include` points at the real home), and record Desktop links with
    the stand's `Recorder` launcher. Every project laptop layer runs apt/apk inside its build and the stand removes its images at the
    end, so a full run takes 25 minutes or much longer on a slow distro mirror.

## Manual acceptance (before a release)

Checked once on a clean machine with a real Claude Desktop:

- The Trust dialog appears only once per laptop.
- Skills load in the laptop, and `.credentials.json` is absent from it.
- Desktop does not re-download its CLI on every Open.
- The sshd `ForceCommand` wrapper works under Desktop (Variables visible in Desktop sessions).
- AC-4a's Claude-behaviour parts: Claude answers from `ws whoami`, follows the worktree flow, and
  warns before a collision with another laptop.
- Rancher Desktop works as the engine.
- Docker Engine inside WSL with no Docker Desktop installed: AgentBook finds the distro on its
  own (no `DOCKER_HOST`), opens a laptop in Claude Desktop, and after AgentBook is closed for a
  minute the Desktop session still works (the keep-alive holds the distro up). The scenario
  suite itself also runs there: `DOCKER_HOST=wsl://<distro> npm run test:scenarios`.
- AC-8 messages (missing prerequisites), AC-17 first-launch download UI, AC-20 installer.
