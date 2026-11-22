---
type: "Architecture Guide"
title: "Work Hub git proxy and connections"
description: "How Work Hub reaches remote git hosts: the per-instance git proxy sidecar (wh-gitproxy-<instance>, network wh-net-<instance>, mirror volume wh-gitcache-<instance>), connections and the vault, per-container capabilities, remote records, the wh-git-ctl command set, push policy, error messages and their transport, the clone path of workspace create, close + push, the FR-9 API-proxy extension point, and how to debug the sidecar."
tags:
  - work-hub
  - git
  - docker
  - security
  - architecture
generated: { by: "claude-code", at: "2026-11-23T01:10:00+04:00" }
---

# Work Hub git proxy and connections

Read [Artisyn AI Work Hub](work-hub.md) first. Task and design:
`docs/tasks/*/2026-11-22-workhub-remote-git-vault/` (`requirements.md`, `impl-plan.md`; the
D-numbers below refer to its Design Decisions). PoC:
`docs/pocs/2026-11-22-1828-wh-git-proxy-sidecar/`. User-facing docs: `work-hub/README.md` →
"Remote repositories and connections".

## Architecture (D1)

- **One sidecar per Work Hub instance** (`wh-gitproxy-<instance>`) does **all** traffic to git
  hosts. The Work Hub server never talks to a git host and never opens a port for it: it drives the
  sidecar only with `docker exec` of `/usr/local/bin/wh-git-ctl` as user `lighttpd`
  (`gitproxy::ctl`).
- Workspace and workstream containers speak git smart HTTP to `http://wh-git/git/<remote id>.git`.
  lighttpd runs the CGI `wh-git-cgi`, which checks the container's capability, syncs the bare
  mirror `/srv/git/<remote id>.git` from the real host on every `info/refs`, then
  `exec git http-backend`.
- **Pushes** run the system `pre-receive` hook (`core.hooksPath /usr/local/share/wh-hooks`): it
  checks the push policy, then `git push --porcelain --force-with-lease=<ref>:<old> upstream
  <new>:<ref>` to the real host. A host rejection fails the hook, so the mirror never runs ahead of
  the host.
- **Upstream credentials** live only in the sidecar's tmpfs `/run/wh/conns/<connection id>/`:
  - SSH: `GIT_SSH_COMMAND="ssh -i key -o IdentitiesOnly=yes -o UserKnownHostsFile=known_hosts
    -o StrictHostKeyChecking=yes -o BatchMode=yes"`.
  - HTTPS (token): `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0=<header>`.
  - Always `GIT_TERMINAL_PROMPT=0`, `HOME=/run/wh/home`.
- **Secrets.** A connection secret (private key or token) is stored in the vault
  (`server/src/secrets.rs`, name `conn-<connection uuid>`) and written into the sidecar with
  `wh-git-ctl put` via exec **stdin**. `docker cp` / `archive::put_files` cannot write into a tmpfs
  (PoC), so every file under a container's `/tmp` or the sidecar's `/run/wh` is written with
  `exec_capture` + stdin. `ctl` never logs stdin or stdout. lighttpd has no access log, so request
  headers (capabilities) are never logged.
- **Capabilities.** A workspace / workstream container gets only `/tmp/wh-git-capability` (mode
  0600, its own user), a random token rotated on every container start. The DB table
  `git_capabilities` keeps only its SHA-256. The git credential helper
  `credential.http://wh-git.helper` (`gitproxy::CREDENTIAL_HELPER`) answers `get` with
  `username=wh` and the capability; it ignores `store` / `erase`.
- **Status writes.** `connections.status` and `workspace_remotes.status` (`untested`, `ok`,
  `rejected`, `host_key`, `failed`) change only on server-driven operations (Test, branches, clone,
  remote Test, close-push) via `connections::record_outcome`; the sidecar cannot call the server,
  so a plain `git fetch` in a terminal does not update them. `host_key_unknown` leaves it unchanged;
  a secret replace resets it to `untested`.
- **Tolerant writes.** Create / update / delete of a connection and attach / detach of a remote
  write the DB and the vault, then try `sync_connection` / `sync_routes`; when the proxy is not
  ready they log and carry on, and the next `push_all` catches up. Test, branches, clone, remote
  Test and close-push need a ready proxy (503 `git_proxy_not_ready`). Attaching a remote makes no
  network call: `default_branch` stays NULL until a remote Test, a clone or a close-push learns it.

## Names and constants (D2)

| Thing | Value | Code |
|---|---|---|
| role label | `git-proxy` | `Role::GitProxy` |
| sidecar container | `wh-gitproxy-<instance>` | `names::git_proxy_container` |
| internal network (`internal: true`; labels root, instance, role `git-proxy`) | `wh-net-<instance>` | `names::git_network` |
| mirror volume (same labels; plain local volume, no bind folder) | `wh-gitcache-<instance>` | `names::git_cache_volume` |
| sidecar alias on the network | `wh-git` | `gitproxy::PROXY_HOST` |
| proxy remote URL | `http://wh-git/git/<remote id>.git` | `gitproxy::remote_url` |
| sidecar image | `WORK_HUB_GIT_PROXY_IMAGE`, default `artisyn-work-hub-git-proxy:<crate version>` | `config.git_proxy_image` |
| capability file | `/tmp/wh-git-capability` | `gitproxy::CAPABILITY_FILE` |
| clone pid file | `/tmp/wh-clone.pid` | `workspaces/clone.rs` |
| vault secret | `conn-<connection uuid>` | `connections` |
| timeouts | `ctl` 120 s · clone 60 min · close push 10 min | |

- The sidecar is created on `bridge` (egress), then connected to `wh-net-<instance>` with alias
  `wh-git`. Mounts: tmpfs `/run/wh` (0700) and the volume at `/srv/git`. `init: true`, restart
  policy `no`, no published ports. Env: `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` (either case)
  copied from the server env when set.
- Workspace and workstream containers stay on `bridge` and are **additionally** connected to
  `wh-net-<instance>`. The network is `internal`, so it gives them no extra egress; they reach only
  the sidecar through it.

## Sidecar layout (D3, D4)

`work-hub/sidecar/` is embedded in the server (`RustEmbed` in `docker/images.rs`) and built with
`ensure_git_proxy_image` when the image is missing; `npm run image -- --git-proxy` builds it by
hand. All files are LF (`.gitattributes`).

| File | In the image | Role |
|---|---|---|
| `Dockerfile` | — | `alpine:3.20` + `git git-daemon openssh-client openssh-keygen lighttpd curl`; `core.hooksPath`, `safe.directory '*'`; `/srv/git` owned by `lighttpd` |
| `entry.sh` | `/usr/local/bin/entry.sh` | creates `/run/wh/{conns,caps,remotes,home}` (0700, `lighttpd`), `exec lighttpd -D` |
| `lighttpd.conf` | `/etc/lighttpd/lighttpd.conf` | port 80, `mod_alias` + `mod_cgi` only, `/git` → `wh-git-cgi` |
| `wh-git-cgi` | `/usr/local/bin/wh-git-cgi` | capability check, mirror sync, error transport, `git http-backend` |
| `pre-receive` | `/usr/local/share/wh-hooks/pre-receive` | push policy, then push upstream |
| `wh-git-ctl` | `/usr/local/bin/wh-git-ctl` | the server's control interface (table below) |

State in the tmpfs `/run/wh` (lost on every sidecar restart; the server re-pushes it):

- `conns/<connection id>/{key,known_hosts,header,api_header}` — SSH private key, pinned host
  lines, `Authorization: Basic base64(<pat user>:<pat>)` for git, the descriptor's API test header.
- `remotes/<remote id>` — one tab-separated record, read with `IFS=<tab> read -r`, never sourced:
  `<remote id> <connection id or -> <connection name> <upstream url> <block_default 1|0> <only_ws 1|0>`
  (tabs and newlines in the name become spaces).
- `caps/<sha256 of capability>` — the remote ids that capability may use, one per line: the
  workspace's remotes whose connection is granted to it **or** deleted (`connection_id IS NULL`, so
  the CGI answers "was deleted" rather than "no grant").
- `home/` — `HOME` for git and ssh; `ready` — marker set by `ready`, tested by `is-ready`.

`wh-git-ctl` commands (stdin / stdout fixed):

| Command | stdin | stdout / effect |
|---|---|---|
| `put <rel>` | file content | writes `/run/wh/<rel>` atomically, 0600; `<rel>` must match `^conns/[0-9a-f-]{36}/(key\|known_hosts\|header\|api_header)$` |
| `drop-conn <id>` | — | `rm -rf conns/<id>` |
| `prune-conns` | live connection ids | removes every other `conns/*` |
| `replace-remotes` | remote records | rebuilds `remotes/` atomically |
| `replace-caps` | `<sha256>\t<rid> <rid> …` | rebuilds `caps/` atomically |
| `prune-mirrors` | live remote ids | removes every other `/srv/git/*.git` |
| `ready` / `is-ready` | — | touch / test `/run/wh/ready` |
| `keygen <comment>` | — | private key, `PUBLIC <line>`, `FINGERPRINT <SHA256:…>` |
| `import-key` | passphrase line, then the key | same; passphrase removed |
| `scan <host> <port>` | — | `ssh-keyscan` lines, then `FINGERPRINT <type> <SHA256:…>` each |
| `ls-remote <conn id> <url>` | — | `git ls-remote --symref`; git's exit code |
| `test-ssh <conn id> <user> <host> <port>` | — | `ssh -T` output, last line `EXIT <code>` |
| `test-http <conn id> <url>` | — | response body, then `HTTP <code>` |
| `sync <rid>` / `push-upstream <rid> …` | — | internal (CGI / hook) |

## Server side (D5, D6)

- `gitproxy::spawn` (from `lib.rs`): waits for Docker, ensures network, image, volume and container
  (recreates it when its image differs, starts it when stopped), then `push_all`
  (`sync_connection` for every connection → `prune-conns` → `sync_routes` → `prune-mirrors` →
  `ready`). Every 30 s it runs `is-ready`; a sidecar that lost its state (restarted) is brought up
  again. Status `st.git_proxy.status`: `building` → `ok`, or `failed` (retried every 30 s);
  exposed as `gitProxy` in `GET /api/v1/system/status`.
- `gitproxy::ctl` is gated (503 `git_proxy_not_ready` unless `ok`); `ctl_raw` is ungated and used
  only by the startup task and tolerant sync paths.
- `gitproxy::containers::container_started(st, ws, container, repo_dir, workstream)` is called after
  every start or create of a workspace or workstream container (`workspaces::create_steps`,
  `ensure_workspace_container`, `workstreams::open`, `ensure_workstream_running`): connect to the
  network, new capability (`auth::tokens::new_token`), upsert `git_capabilities`, write the
  capability file, `sync_repo_remotes` when the repo exists, `sync_routes`. It never fails the
  caller. `repo_dir` is `/workspace/repo` (workspace) or `/workspace/worktree` (workstream).
- `sync_repo_remotes` sets every DB remote's URL to its proxy URL (`git remote add` / `set-url`),
  removes `http://wh-git/git/` remotes no longer in the DB and sets the credential helper.
- `drop_container` (workstream removal: merged elsewhere, discard) deletes the capability row and
  re-syncs routes. Workspace delete re-syncs routes and prunes mirrors (rows go by cascade).
  Account deletion calls `connections::delete_all_for_user` before `secrets::delete_all`.
- Session env (D10): `tmux::SessionOpts.secrets` is a list of `(name, value)` pairs passed through
  exec stdin and `tmux -e`; `login::agent_env` returns the agent token plus
  `connections::exposed_env` (token connections granted to the workspace with `expose_env` set).

## Connections and providers (D7–D9, D14)

- `server/src/connections/providers.rs` is the **only** file that may name a provider (GitHub,
  GitLab, Azure DevOps, plus `generic`); the web reads everything from `GET
  /api/v1/connection-providers`. `scripts/provider-names-check.mjs` (in `npm run lint`) enforces
  it over `server/src/**/*.rs` and `web/src/**`.
- URL rules: `connections/remote_url.rs` (algorithm doc `workhub-remote-url`); field rules:
  `connections/fields.rs` (`workhub-connection-fields`); descriptors: `workhub-git-providers`.
- Secret lifecycle: `ssh_generated` → `keygen`, `ssh_uploaded` → `import-key` (passphrase never
  stored), `pat` → as sent; vault `conn-<id>`, then `sync_connection`. Regenerate keeps the pinned
  host key. Delete without `?force=true` while remotes use it → 409 `connection_in_use`; with it,
  remotes keep `connection_name` and get `connection_id = NULL`.
- Test: SSH without a pin (or with `acceptHostKey`) scans the host first; without `acceptHostKey`
  it answers `host_key_unknown` with the fingerprint, with it the fingerprint must match the scan
  (else 400 `host_key_mismatch`) and is pinned. Then an API test (token + descriptor API test),
  `test-ssh` with the greeting template, or `ls-remote` of a given URL.
- Reachability: the sidecar has egress (`bridge`), and the `generic` provider accepts any http(s)
  or SSH host the user types, so Test, branches and clone reach whatever that host is, LAN
  addresses included — by design, for self-hosted git. `wh-git-ctl` refuses arguments that start
  with `-` (no URL or host can become a `git` / `ssh` option) and takes only `http(s)://` for
  `test-http`; it never runs anything else on the user's behalf.

## Error messages and their transport (D1 items 5–7)

Kept exact (`<name>` is the connection name):

| Message | Transport |
|---|---|
| `Work Hub connection <name> was rejected by the host — update its credential in Settings` | HTTP 401 text/plain + `WWW-Authenticate`; git prints `remote: <msg>`, then `fatal: Authentication failed` |
| `Work Hub: unknown or revoked capability` | HTTP 401 text/plain |
| `Work Hub connection <name>: the host key of the git host changed — check it and re-pin it in Settings` | `ERR` pkt-line in a 200 advertisement → `fatal: remote error: <msg>` |
| `Work Hub connection <name> was deleted — rebind the remote in workspace settings` | `ERR` pkt-line |
| `Work Hub: this workspace has no grant for the connection of this remote` | `ERR` pkt-line |
| `Work Hub connection <name>: <last line of the sync output>` | `ERR` pkt-line |
| `Work Hub: unknown remote` | HTTP 404 |
| `Work Hub push policy: force push to the default branch <b> is not allowed` | `remote:` line from the hook |
| `Work Hub push policy: deleting the default branch <b> is not allowed` | hook |
| `Work Hub push policy: only ws/* branches may be pushed (<ref>)` | hook |
| `Work Hub push policy: only branches and tags can be pushed (<ref>)` | hook |
| `Work Hub: the git host rejected the push:` + the host's `!`, `error`, `remote:`, `fatal` lines (≤ 10) | hook |

Sync-failure classification in the CGI (and `gitproxy::classify` on the server), by substring:
`Host key verification failed` / `REMOTE HOST IDENTIFICATION HAS CHANGED` → host key changed;
`Permission denied`, ` 401`, ` 403`, `Authentication failed`, `could not read Username` →
rejected; anything else → the last output line. The default branch for the policy is the mirror's
`HEAD`.

## Clone path of workspace create (D11)

- `POST /api/v1/workspaces` takes an optional `source {connectionId, url, branch?}` and `opId`.
  Pre-checks before the row exists: own `git` connection, `remote_url::resolve`, proxy ready, an
  `ls-remote` for the default branch.
- Instead of `git init`: grant + remote `origin` (`block_default_rewrite = true`), `sync_routes`,
  `container_started`, then `git clone --progress [-b <branch>] -o origin http://wh-git/git/<rid>.git
  /workspace/repo` with the helper passed by `-c`, via `exec_progress` (stderr streamed into the
  clone op). An empty remote starts `main` with the default files. Then `user.name` / `user.email`,
  `sync_repo_remotes`, and the devcontainer step reads the cloned repo.
- Clone ops live in memory (`st.git_proxy.clone_ops`, keyed by the client's `opId`, removed 10 min
  after they end): `GET /api/v1/clone-ops/{id}` (404 = not started yet), `POST …/cancel` kills the
  pid in `/tmp/wh-clone.pid` → 409 `clone_cancelled`. Errors: `credential_rejected` (stderr has
  "rejected by the host"), else `clone_failed` with the last 20 non-progress lines.
- Undo: `UndoStep::GitRoutes` re-syncs routes and prunes mirrors.

## Close + push (D12)

`POST /api/v1/workstreams/{id}/close` with `push: true`: the push remote is `origin`, else the
oldest remote (none → `push` is ignored, `close/check` returns `pushRemote: null`). `for_now`
pushes the workstream branch from the workstream container before it stops; `bring_into_main`
pushes the base branch from the workspace container after the merge; `merged_elsewhere` never
pushes. A failed push never fails the close; `rejectedBy` is `policy` (`Work Hub push policy`),
`credential` (`rejected by the host`, `Authentication failed`, `unknown or revoked capability`) or
`host`. `prUrl` comes from the descriptor when the pushed branch is not the remote's default.

## FR-9 extension point (D13, design only)

An API connection would be a `connections` row with `kind = 'api'` and an `api` descriptor, same
vault name, same grants. The sidecar would get a second lighttpd alias `/proxy/<connection id>/…`
→ a CGI that injects `api_header` and forwards to the base URL, and capability lines would gain
`api:<connection id>` entries. The `/git` CGI, the hook and `git_capabilities` stay unchanged.

## Debugging

The instance is `WORK_HUB_INSTANCE` (`default` unless set; test stands use `whs-<8hex>` /
`whc-<8hex>`).

```
docker ps -a --filter label=artisyn.workhub.role=git-proxy           # the sidecar and its state
docker logs wh-gitproxy-<instance>                                    # lighttpd / CGI stderr
docker exec -u lighttpd wh-gitproxy-<instance> wh-git-ctl is-ready; echo $?   # 0 = state pushed
docker exec wh-gitproxy-<instance> ls -l /run/wh/conns /run/wh/caps /run/wh/remotes
docker exec wh-gitproxy-<instance> cat /run/wh/remotes/<remote id>    # the remote record
docker exec wh-gitproxy-<instance> git -C /srv/git/<remote id>.git log --oneline -5 --all   # the mirror
docker exec -u lighttpd wh-gitproxy-<instance> wh-git-ctl ls-remote <conn id> <upstream url>
docker network inspect wh-net-<instance>                              # who is connected
```

- **Never** `cat` files under `/run/wh/conns/` in a shared log: they are the credentials.
- A workspace terminal: `git remote -v` shows the proxy URLs; `GIT_CURL_VERBOSE=1 git ls-remote
  origin` shows the HTTP status (401 = capability or host rejection, 200 with `ERR` = the other
  connection errors).
- After a sidecar restart `/run/wh` is empty until the next 30 s check re-pushes it; `GET
  /api/v1/system/status` shows `gitProxy: "building"` meanwhile.
- `docker rm -f wh-gitproxy-<instance>` is safe: the server recreates it and re-pushes the state;
  the mirrors survive in `wh-gitcache-<instance>`.
