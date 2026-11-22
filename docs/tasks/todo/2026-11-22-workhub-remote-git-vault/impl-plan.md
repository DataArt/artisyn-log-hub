# Implementation plan — Work Hub remote git repositories and credential vault

## TL;DR

- **New long-lived Docker objects per instance:** the git proxy sidecar container `wh-gitproxy-<instance>`
  (Alpine + git + openssh-client + lighttpd + curl, built at startup from the embedded
  `work-hub/sidecar/`), an internal network `wh-net-<instance>` (alias `wh-git`) that every
  workspace / workstream container joins, and a mirror volume `wh-gitcache-<instance>`. PoC-proven
  (`docs/pocs/2026-11-22-1828-wh-git-proxy-sidecar/`, 24/24).
- **Secrets:** connection secrets go only to the vault (`secrets.rs`, name `conn-<uuid>`) and to the
  sidecar's tmpfs `/run/wh` (written with `docker exec` + stdin). Containers get only a per-container
  capability in `/tmp/wh-git-capability`, rotated on every container start; DB keeps only its SHA-256.
- **New server modules:** `connections/` (descriptor table `providers.rs`, URL rules `remote_url.rs`,
  field rules `fields.rs`, service, repo), `gitproxy/` (sidecar lifecycle, `ctl` exec wrapper, state
  push, `container_started` hook), `workspaces/remotes.rs`, `workspaces/clone.rs`.
- **DB:** migration `0005_connections.sql` — new tables `connections`, `connection_grants`,
  `workspace_remotes`, `git_capabilities`. Additive only.
- **API:** 17 new routes (`/connection-providers`, `/connections…`, `/workspaces/{id}/remotes`,
  `/remotes/{id}…`, `/clone-ops/{id}…`); additive changes to `POST /workspaces` (optional `source`,
  `opId`), `POST /workstreams/{id}/close` (optional `push`, response `push`), `close/check`
  (`pushRemote`) and `system/status` (`gitProxy`). Old clients keep working.
- **Behaviour changes to existing code:** `tmux::SessionOpts.secret` becomes a list of env pairs
  (FR-10); workspace create gains a clone path; close gains an optional push.
- **No new Rust crates** (keygen / host-key scan / passphrase removal / PAT test run inside the sidecar).
- **Web UI:** a new user-level Connections page (`#/connections`, account menu item) with add / edit /
  delete / grants dialogs; "Clone from a connection" in the new-workspace dialog with progress and
  Cancel; Settings → Remotes cards with Attach / policy / Detach; a push option in the close dialog.
- **Config / tooling:** new env var `WORK_HUB_GIT_PROXY_IMAGE`; `npm run image -- --git-proxy` builds
  the sidecar image by hand (offline installs); new lint guard `scripts/provider-names-check.mjs`
  (FR-2 grep).
- **Tests:** 3 new algorithm docs, 17 contract registry rows (+ a connection and a remote in the
  contract world), new scenario `@S-WH-06` plus steps in `@S-WH-02` and `@S-WH-05`, a fake git host
  image for the stand.

## Reference

- Requirements: [requirements.md](requirements.md)
- PoC: [`docs/pocs/2026-11-22-1828-wh-git-proxy-sidecar/`](../../../pocs/2026-11-22-1828-wh-git-proxy-sidecar/README.md)
  (PoC outcome: `research/git-proxy-sidecar.md`; research archive: `research/findings-1.md`)
- Wireframes: `wireframes/*.svg` (no changes needed)

## Design Decisions

### D1 — Architecture (PoC-proven: `run.cjs` 24/24, network layout `net-check.cjs` 7/7)

1. The sidecar is one container per WH instance; it does all traffic to git hosts. The WH server
   never talks to a git host and never opens a port: it drives the sidecar only with `docker exec`
   (`gitproxy::ctl`).
2. Containers talk smart HTTP to `http://wh-git/git/<remote id>.git`. The sidecar serves it with
   lighttpd CGI `wh-git-cgi`: it checks the capability, syncs the bare mirror
   `/srv/git/<remote id>.git` from the real host on every `info/refs`, then `exec git http-backend`.
3. Pushes go through the system `pre-receive` hook. It checks the policy, then
   `git push --porcelain --force-with-lease=<ref>:<old> upstream <new>:<ref>` to the real host. If
   the host rejects, the hook fails, so the mirror never runs ahead of the host.
4. Upstream credentials:
   - SSH: `GIT_SSH_COMMAND="ssh -i <key> -o IdentitiesOnly=yes -o UserKnownHostsFile=<pinned>
     -o StrictHostKeyChecking=yes -o BatchMode=yes"`.
   - HTTPS: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0=<header file>`.
   - Always `GIT_TERMINAL_PROMPT=0` and `HOME=/run/wh/home`.
5. Error transport (PoC):
   - **Rejected by the host** answers HTTP 401 text/plain with `WWW-Authenticate`, as FR-1a requires.
     The helper always sends credentials, so git prints the body as `remote: <msg>` followed by
     `fatal: Authentication failed` (PoC: the unknown-capability probe). Git then calls the helper's
     `erase`, which the D2 helper ignores.
   - A missing or unknown capability also answers 401 text/plain.
   - The other connection-level errors are an `ERR <msg>` pkt-line in a 200 advertisement, which git
     shows as `fatal: remote error: <msg>`: host key changed, connection deleted, no grant, other
     sync failure.
   - Policy rejections come from the hook as `remote:` lines.
6. Messages, kept exact (`<name>` is the connection name):
   - `Work Hub connection <name> was rejected by the host — update its credential in Settings`
   - `Work Hub connection <name>: the host key of the git host changed — check it and re-pin it in Settings`
   - `Work Hub connection <name> was deleted — rebind the remote in workspace settings`
   - `Work Hub: this workspace has no grant for the connection of this remote`
   - `Work Hub: unknown or revoked capability`
   - `Work Hub push policy: force push to the default branch <b> is not allowed`
   - `Work Hub push policy: deleting the default branch <b> is not allowed`
   - `Work Hub push policy: only ws/* branches may be pushed (<ref>)`
   - `Work Hub push policy: only branches and tags can be pushed (<ref>)`
   - `Work Hub: the git host rejected the push:` followed by the host's `!`, `error`, `remote:` and
     `fatal` lines (at most 10)
7. Sync-failure classification in the CGI, by substring of the sync output:
   - `Host key verification failed` or `REMOTE HOST IDENTIFICATION HAS CHANGED` → host-key message.
   - `Permission denied`, ` 401`, ` 403`, `Authentication failed` or `could not read Username` →
     rejected message.
   - Anything else → `Work Hub connection <name>: <last line of the output>`.
8. `docker cp` / `archive::put_files` cannot write into a tmpfs (PoC). Every file under a
   container's `/tmp` or the sidecar's `/run/wh` is written with `exec_capture` + stdin.
9. The connection status ("Connected" / "Rejected by host" / "Test failed") is updated only by
   server-driven operations (Test, branches, clone, remote Test, close-push). The sidecar cannot
   call the server, so plain `git fetch` from a terminal does not update it.
   - `connections.status` and `workspace_remotes.status` take the values `untested`, `ok`,
     `rejected`, `host_key` and `failed` (DB CHECK).
   - Mapping from an operation outcome: ok → `ok`; rejected → `rejected`; `host_key_changed` →
     `host_key`; `failed` → `failed`. `host_key_unknown` leaves the status unchanged.
   - A secret replace sets `untested`.
   - One helper does the write: `connections::record_outcome(st, conn_id, outcome, user)`.
10. Create, update and delete of a connection and attaching a remote do not need a ready sidecar.
    They write the DB and the vault, then try `sync_connection` / `sync_routes`. When the proxy is
    not ready, they log and carry on; the next `push_all` catches up.
    Test, branches, clone, remote Test and close-push need a ready proxy (`git_proxy_not_ready`
    otherwise).
11. Attaching a remote makes no network call. Its `default_branch` stays NULL until a remote Test, a
    clone or a close-push learns it via `ls-remote`.
12. During the first clone of a big repository the sidecar first fills its mirror. The UI shows
    `Fetching from <host>…` until git prints its first progress line.

### D2 — Names and constants (`work-hub/server/src/docker/names.rs`, `gitproxy/mod.rs`)

| Thing | Value |
|---|---|
| `Role::GitProxy.as_str()` | `git-proxy` |
| sidecar container | `wh-gitproxy-<instance>` (`names::git_proxy_container(instance)`) |
| internal network (labels: root, instance, role `git-proxy`; `internal: true`) | `wh-net-<instance>` (`names::git_network(instance)`) |
| mirror volume (same labels) | `wh-gitcache-<instance>` (`names::git_cache_volume(instance)`) |
| sidecar alias on the network / proxy host | `wh-git` (`gitproxy::PROXY_HOST`) |
| proxy remote URL | `http://wh-git/git/<remote id>.git` (`gitproxy::remote_url(id)`) |
| sidecar image | env `WORK_HUB_GIT_PROXY_IMAGE`, default `artisyn-work-hub-git-proxy:<server crate version>` (`config.git_proxy_image`) |
| capability file in containers | `/tmp/wh-git-capability`, mode 0600, owner = container user |
| credential helper (git config `credential.http://wh-git.helper`) | `!f() { test "$1" = get && printf 'username=wh\npassword=%s\n' "$(cat /tmp/wh-git-capability)"; }; f` |
| clone pid file | `/tmp/wh-clone.pid` |
| vault secret name | `conn-<connection uuid>` (41 chars, fits `secrets.rs` rules) |
| timeouts | `ctl` 120 s · clone 60 min · close push 10 min |

- The sidecar container is created with `network_mode: bridge`, which gives it egress. It is then
  connected to `wh-net-<instance>` with alias `wh-git`.
- Its mounts: tmpfs `/run/wh` (mode 0700) and the volume at `/srv/git`.
- `init: true`, restart policy `no`.
- Its env is `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`, copied from the server env when set.
- It has no published ports.
- Workspace and workstream containers stay on `bridge` and are additionally connected to
  `wh-net-<instance>`. A network has no instance labels on the containers' side.

### D3 — Sidecar contents (`work-hub/sidecar/`, embedded with `RustEmbed`)

The files mirror the PoC (`sidecar/*` there), with these changes:

- `Dockerfile`: `alpine:3.20` plus `apk add --no-cache git git-daemon openssh-client
  openssh-keygen lighttpd curl`.
  - Hooks via `git config --system core.hooksPath /usr/local/share/wh-hooks`, plus
    `safe.directory '*'`.
  - `/srv/git` owned by `lighttpd`.
  - `CMD entry.sh`.
- `entry.sh`: creates `/run/wh/{conns,caps,remotes,home}`, `chown -R lighttpd`, `chmod 700`, then
  `exec lighttpd -D`.
- `lighttpd.conf`: `mod_alias` + `mod_cgi` only (no access log); `/git` → `wh-git-cgi`.
- `wh-git-cgi`: uses the D1 rules.
  - Remote record file `/run/wh/remotes/<rid>`: one tab-separated line read with
    `IFS=<tab> read -r`, never sourced (D4 format).
  - Capability file `/run/wh/caps/<sha256>`: remote ids, one per line.
- `pre-receive`:
  - The default branch is the mirror's `HEAD`.
  - With `block_default=1`, a force push or delete of it is rejected.
  - With `only_ws=1`, any `refs/heads/*` push other than `ws/*` is rejected.
  - Refs outside `refs/heads/` and `refs/tags/` are always rejected.
- `wh-git-ctl` (run as user `lighttpd`; each command and its stdin / stdout are fixed):

| Command | stdin | stdout / effect |
|---|---|---|
| `put <rel>` | file content | atomically writes `/run/wh/<rel>` mode 0600; `<rel>` must match `^conns/[0-9a-f-]{36}/(key|known_hosts|header|api_header)$` |
| `drop-conn <id>` | — | `rm -rf /run/wh/conns/<id>` |
| `prune-conns` | live connection ids, one per line | removes every other `conns/*` dir |
| `replace-remotes` | D4 remote records | rebuilds `remotes/` atomically (tmp dir + `mv`) |
| `replace-caps` | lines `<sha256>\t<rid> <rid> …` | rebuilds `caps/` atomically |
| `prune-mirrors` | live remote ids | removes other `/srv/git/*.git` |
| `ready` / `is-ready` | — | touches / tests `/run/wh/ready` (exit 0 = ready) |
| `keygen <comment>` | — | the private key (OpenSSH PEM), then `PUBLIC <pubkey line>`, then `FINGERPRINT <SHA256:…>` |
| `import-key` | first line: passphrase (may be empty), then the private key | same 3-part output; passphrase removed (`ssh-keygen -p -N ''`) |
| `scan <host> <port>` | — | `ssh-keyscan -p <port> -t ed25519,ecdsa,rsa` lines, then for each: `FINGERPRINT <type> <SHA256:…>` |
| `ls-remote <conn id> <upstream url>` | — | `git ls-remote --symref` output; exit code of git |
| `test-ssh <conn id> <user> <host> <port>` | — | `ssh -T` combined output; last line `EXIT <code>` |
| `test-http <conn id> <url>` | — | `curl -sS -H @api_header -w '\nHTTP %{http_code}' <url>` |
| `sync <rid>` / `push-upstream <rid> …` | — | internal (CGI / hook), as in the PoC |

### D4 — Sidecar state records

- **Remote record** (`replace-remotes`, one line per remote): `<remote id>\t<connection id or ->\t<connection name>\t<upstream url>\t<block_default 1|0>\t<only_ws 1|0>`.
  Tabs and newlines in the connection name are replaced by spaces.
- **Capabilities** (`replace-caps`): one line per `git_capabilities` row,
  `<token_hash>\t<remote ids>`. The ids are those of the workspace's remotes whose connection is
  granted to the workspace **or** has been deleted (`connection_id IS NULL`). Including deleted
  ones makes the CGI answer "was deleted" instead of "no grant".
- **Connection files**:
  - `key` — the SSH private key (`ssh_*` methods).
  - `known_hosts` — the pinned lines (SSH).
  - `header` — `Authorization: Basic base64(<pat user>:<pat>)` (PAT).
  - `api_header` — the descriptor's API test header (PAT, when the descriptor has an API test).

### D5 — `gitproxy` service functions (`work-hub/server/src/gitproxy/`)

These are the seams other chunks call; the signatures are fixed:

- `pub async fn ctl(st: &AppState, args: &[&str], stdin: Option<Bytes>, timeout: Duration) -> Result<ExecOutput, ApiError>`
  - Answers 503 `git_proxy_not_ready` while the status is not `Ok`.
  - Never logs stdin or stdout.
- `pub(crate) async fn ctl_raw(...)`: same signature, without the status gate. Used only by
  `spawn`, `push_all` and the D11 sync helpers, which tolerate failure.
- **Status transitions:**
  - `Building` at startup and while the sidecar is being (re)created.
  - `Ok` after `push_all` and `ready` succeed.
  - `Failed(e)` when the image build or the container start fails. The loop retries every 30 s.
  - Back to `Building` when `is-ready` answers not ready, until the re-push succeeds.
- `pub fn spawn(st: AppState)`: the startup task.
  1. Wait for Docker.
  2. Ensure the network, the image (build from the embedded context when it is missing), the volume
     and the container. Recreate the container when its image differs; start it when it is stopped.
  3. `push_all`.
  4. Every 30 s, `is-ready`; when the answer is not ready (e.g. the sidecar was restarted), ensure
     the container again and `push_all`.
  - The status is kept in `st.git_proxy.status: RwLock<ProxyStatus {Building, Ok, Failed(String)}>`.
- `pub async fn push_all(st)`:
  1. `sync_connection` for every connection.
  2. `prune-conns`.
  3. `sync_routes`.
  4. `prune-mirrors`.
  5. `ready`.
- `pub async fn sync_connection(st, conn_id: Uuid) -> Result<(), ApiError>`: writes the D4 files
  from the row and the vault secret.
- `pub async fn drop_connection(st, conn_id)`.
- `pub async fn sync_routes(st) -> Result<(), ApiError>`: `replace-remotes` and `replace-caps` from
  the DB (all rows).
- `pub async fn container_started(st, ws: &WorkspaceRow, container: &str, repo_dir: &str, workstream: Option<Uuid>)`.
  It returns nothing: on failure it logs a warning and never fails the caller. Steps:
  1. Connect the container to `wh-net-<instance>`; "already connected" counts as ok.
  2. Create a new token (`auth::tokens::new_token()`).
  3. Upsert the `git_capabilities` row (`token_hash = token_hash(token)`).
  4. Write `/tmp/wh-git-capability` via exec stdin (`umask 077; cat > …`) as the container user.
  5. If `<repo_dir>/.git` exists, `sync_repo_remotes`.
  6. `sync_routes`.
- `pub async fn sync_repo_remotes(st, ws, container, repo_dir)`:
  - For every `workspace_remotes` row, `git remote add` or `set-url <name> http://wh-git/git/<id>.git`.
  - Remove remotes whose URL starts with `http://wh-git/git/` and that are not in the DB.
  - Set the credential helper (D2).
- `pub async fn drop_container(st, container: &str)`: deletes the capability row, then `sync_routes`.
- `pub fn remote_url(remote_id: Uuid) -> String`.
- `pub const PROXY_HOST: &str = "wh-git"`.

### D6 — Where `container_started` is called

After every start or create of a workspace or workstream container:

- `workspaces::create_steps`: after the first `create_and_start` (before `git init` / clone), and
  after the step-6 recreate.
- `ensure_workspace_container`: after a start (`mod.rs:801`) or a recreate (`835-869`).
- `workstreams::open` (`mod.rs:553`) and `ensure_workstream_running` (`669`, `694`); `reopen` goes
  through the latter.

The `repo_dir` argument is `WORKSPACE_REPO_DIR` for the workspace container and
`WORKSTREAM_WORKTREE_DIR` for a workstream container.

`drop_container` is called from the workstream `remove_objects` (merged elsewhere, discard).

After deleting a workspace, `workspaces::delete` calls `sync_routes`, then `prune-mirrors`. The
rows go by cascade.

Account deletion is `WorkspaceAccountCleanup::delete_user_data` in
`work-hub/server/src/workspaces/mod.rs:1045`. After its workspace loop and **before**
`secrets::delete_all`, it calls `connections::delete_all_for_user(st, user_id)`:
1. Delete the user's `connections` rows.
2. `drop_connection` for each.
3. `sync_routes`.

The `users` row itself is deleted later by the caller.

### D7 — Provider descriptors (`connections/providers.rs`, the only file allowed to name a provider)

`pub struct Provider` fields:

| Field | Meaning |
|---|---|
| `id` | provider id |
| `display_name` | name shown in the UI |
| `short_label` | tile label |
| `kind` | `"git"` |
| `auth_methods` | supported auth methods |
| `base_template` | the base URL form |
| `base_fixed` | `Option`; the base URL when the user cannot change it |
| `allow_http` | whether `http://` is accepted |
| `https_path` | template, relative to the base URL path |
| `ssh` | `Option<SshRule {host: Option<&str>, user, port, path}>`; `host` `None` means the base host |
| `git_suffix` | whether `.git` is appended to the upstream URL |
| `pat_user` | `PatUser::Fixed(&str)` or `PatUser::FromConnection` |
| `api_test` | `Option<ApiTest {url, header, user_field}>` |
| `ssh_greeting` | `Option<&str>`, a template with `{user}` |
| `token_page` | `Option` |
| `token_scopes` | `Option` |
| `ssh_keys_page` | `Option` |
| `pr_url` | `Option` |
| `pr_label` | `Option` |
| `test_needs_url` | whether Test needs a repository URL |
| `base_placeholder` | input placeholder for the base URL |

Functions: `pub fn all() -> &'static [Provider]` and `pub fn get(id: &str) -> Option<&'static Provider>`.

**Template syntax.**
- `{x}` matches one non-empty path segment.
- `{path}` matches one or more segments and is only allowed last.
- Everything else is literal.
- In page and PR templates, `{web}` is the connection base URL, `{target}` the target branch and
  `{branch}` the source branch. Branches are percent-encoded.

Rows:

- **`github`** · "GitHub" · `GH`
  - auth methods: ssh_generated, ssh_uploaded, pat
  - base URL: fixed `https://github.com`; https path `{owner}/{repo}`
  - SSH: `git@github.com:22`, path `{owner}/{repo}`; git suffix yes
  - PAT user: `x-access-token`
  - API test: `https://api.github.com/user`, `Authorization: Bearer {token}`, user field `login`
  - SSH greeting: `Hi {user}! You've successfully authenticated`
  - token page: `https://github.com/settings/tokens/new?scopes=repo&description=Work%20Hub`; scopes `repo`
  - SSH keys page: `https://github.com/settings/ssh/new`
  - PR: `{web}/{owner}/{repo}/compare/{target}...{branch}?expand=1`; label "pull request"
- **`gitlab`** · "GitLab" · `GL`
  - auth methods: all three
  - base URL: `{base}` (any https URL, default `https://gitlab.com`, may have a path); https path `{path}`
  - SSH: user `git`, port 22, host = base host, path `{path}`; git suffix yes
  - PAT user: `oauth2`
  - API test: `{web}/api/v4/user`, `PRIVATE-TOKEN: {token}`, user field `username`
  - SSH greeting: `Welcome to GitLab, @{user}!`
  - token page: `{web}/-/user_settings/personal_access_tokens?name=Work%20Hub&scopes=read_repository,write_repository,read_user`;
    scopes `read_repository write_repository read_user`
  - SSH keys page: `{web}/-/user_settings/ssh_keys`
  - PR: `{web}/{path}/-/merge_requests/new?merge_request%5Bsource_branch%5D={branch}&merge_request%5Btarget_branch%5D={target}`;
    label "merge request"
- **`azure-devops`** · "Azure DevOps" · `AZ`
  - auth methods: all three
  - base URL: `https://dev.azure.com/{org}`; https path `{project}/_git/{repo}`
  - SSH: `git@ssh.dev.azure.com:22`, path `v3/{org}/{project}/{repo}`; git suffix no
  - PAT user: `pat`
  - API test: `{web}/_apis/connectionData`, `Authorization: Basic {basic}`, user field
    `authenticatedUser.providerDisplayName`
  - SSH greeting: none (an authenticated SSH test is any exit without `Permission denied`)
  - token page: `{web}/_usersSettings/tokens`; scopes `Code (Read & write)`
  - SSH keys page: `{web}/_usersSettings/keys`
  - PR: `{web}/{project}/_git/{repo}/pullrequestcreate?sourceRef={branch}&targetRef={target}`;
    label "pull request"
- **`generic`** · "Other git server" · `GIT`
  - auth methods: ssh_generated, ssh_uploaded, pat
  - base URL: any http(s) URL (`allow_http: true`); https path `{path}`
  - SSH: none, so the pasted URL is used as is and its transport must match the auth method; git
    suffix as pasted
  - PAT user: from the connection's `username` (required)
  - API test, greeting, pages and PR: none
  - Test needs a URL: yes

Derived values:
- `{token}` is the PAT.
- `{basic}` is `base64(<pat user>:<pat>)`.
  - The server has no base64 crate, and none is added.
  - `providers::base64_encode(bytes: &[u8]) -> String` is a hand-written standard-alphabet encoder
    with `=` padding (RFC 4648 §4).
- The git `header` file is always `Authorization: Basic {basic}`.

`base_placeholder` values:

| Provider | `base_placeholder` |
|---|---|
| github | `https://github.com` |
| gitlab | `https://gitlab.example.com` |
| azure-devops | `https://dev.azure.com/<organization>` |
| generic | `https://git.example.com` |

API mapping (`ProviderInfo`):

| API field | From the descriptor |
|---|---|
| `baseUrlFixed` | `base_fixed` |
| `baseUrlPlaceholder` | `base_placeholder` |
| `needsUsername` | `pat_user == PatUser::FromConnection` |
| `allowHttp` | `allow_http` |
| `tokenPageUrl` | `token_page` |
| `tokenScopes` | `token_scopes` |
| `sshKeysPageUrl` | `ssh_keys_page` |
| `prLabel` | `pr_label` |
| `testNeedsUrl` | `test_needs_url` |
| `authMethods` | `auth_methods` (`as_str`) |

### D8 — Remote URL rules (`connections/remote_url.rs`, algorithm doc `workhub-remote-url`)

Functions:
- `parse(raw) -> Result<ParsedUrl{scheme: Https|Http|Ssh, user, host, port, path}, UrlError>`.
  Accepts `https://[user@]host[:port]/path`, `http://…`, `ssh://user@host[:port]/path` and the scp
  form `user@host:path`. The path loses leading `/` and a trailing `.git`; the host is lowercased.
- `resolve(p, base_url, auth_method, parsed) -> Result<Resolved{vars, upstream_url, web_repo_url: Option<String>}, UrlError>`.
- `pr_url(p, base_url, vars, target, branch) -> Option<String>`.

`resolve`:
- HTTPS: the host must equal the base host and the path must start with the base path; the rest is
  matched against `https_path`.
- SSH: the host must equal the descriptor SSH host (default: the base host); the path is matched
  against `ssh.path`.
- Vars from `base_template` must agree.
- Upstream URL:
  - SSH auth: `ssh://<user>@<host>:<port>/<ssh path><.git?>`.
  - PAT: `<base url>/<https path><.git?>`.
- Generic: the upstream is the pasted URL. The transport must match the auth method: SSH auth needs
  an SSH URL, PAT needs http(s).

`UrlError` codes, each mapped to a 400 `invalid_remote_url` message:
- `not_a_git_url`
- `wrong_host`
- `wrong_path`
- `transport_mismatch`
- `http_not_allowed`

### D9 — Field rules (`connections/fields.rs`, algorithm doc `workhub-connection-fields`)

- **Connection name:** `crate::names::validate_display_name` plus `crate::names::name_key`, unique
  per user; duplicates answer `duplicate_name`. In `workspaces/mod.rs` these are imported as
  `display_names`.
- **Remote name:** `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, not ending in `.lock`, unique per workspace.
- **Base URL:** an absolute URL. Scheme `https` (or `http` when the descriptor has `allow_http`).
  No query, fragment or userinfo. Trailing `/` stripped. It must match `base_template`.
- **PAT:** 1–4096 characters, no whitespace or control characters.
  **Uploaded key:** begins with `-----BEGIN` and is at most 16 KiB.
- **Expose env name:**
  - Must match `^[A-Z_][A-Z0-9_]*$` (≤ 64 characters).
  - Must not be in `PATH HOME USER SHELL TERM LANG PWD HOSTNAME`, must not start with `WH_`, and must
    not equal any registered agent's `token_env()`.
  - Allowed only for `auth_method = pat`; otherwise `expose_not_allowed`.
  - Unique among the user's connections.
- **Expose vs `containerEnv`:** on save and on grant, the name is checked against the
  `containerEnv` of every granted workspace whose container is running (`definition_env`); a clash
  answers `invalid_env_name`. At session start the exposed variable is passed with `tmux -e`, so it
  wins and is never dropped.

### D10 — Session env (FR-10)

- `tmux::SecretEnv` is replaced by `pub type SecretEnv<'a> = &'a [(String, String)]`.
- `SessionOpts.secret` is renamed `secrets`.
- `secret_parts` reads one stdin line per pair (`IFS= read -r WH_SECRET_<i>`), adds
  `-e "NAME=$WH_SECRET_<i>"`, and skips pairs whose name fails `fields::is_env_name` or whose value
  contains `\n`.
- `login::agent_env` returns `Vec<(String, String)>`: the agent token (when present) followed by
  `connections::exposed_env(st, ws)` (PAT connections granted to `ws` with `expose_env` set).
- Callers that change:
  - `workstreams/mod.rs:585-600` and `704-745`
  - `workspaces/configure.rs:35-70`
  - `workspaces/login.rs:273`

### D11 — Clone path of workspace create (FR-4)

**Body.** `POST /workspaces` accepts `{name, source?: {connectionId, url, branch?}, opId?}`.
- Rust: `pub struct CloneSource { pub connection_id: Uuid, pub url: String, pub branch: Option<String> }`
  in `workspaces/clone.rs`.
- New `StepError::Clone(ApiError)`, which `create_error` passes through unchanged.
- A malformed `opId` fails body parsing (400 `invalid_body`). An `opId` already registered answers
  400 `invalid_body` "opId is in use".
- `api/mod.rs` has no request timeout layer, so the create request may run for the whole 60-minute
  clone timeout.
- While polling, the client treats 404 from `GET /clone-ops/{id}` as "starting": the op is
  registered at the start of the request, but the first poll may race it.

**Pre-checks (before the row is inserted):**
- The connection is owned by the user and has `kind = git`.
- `remote_url::resolve` passes.
- The proxy is ready (`git_proxy_not_ready` otherwise).

**Steps in `create_steps` with a source**, replacing step 5 (`git init` + initial commit):
1. Insert a grant (connection × workspace) and a remote row:
   - name `origin`
   - URL as pasted, plus the resolved upstream URL
   - `block_default_rewrite = true`
   - `default_branch` from a `ls-remote` done in the pre-check
2. `sync_routes`, then `container_started`.
3. Run the clone via exec as the container user:
   `sh -c 'echo $$ > /tmp/wh-clone.pid; exec git -c credential.http://wh-git.helper=<D2 helper> clone --progress [-b <branch>] -o origin http://wh-git/git/<rid>.git /workspace/repo'`.
   Streaming stderr updates the clone op.
4. If `git rev-parse --verify HEAD` fails (an empty remote), run today's step 5 without `git init`:
   create `main`, write the default files, commit. The working branch is `main`.
5. Otherwise the working branch is `git symbolic-ref --short HEAD` (`repo::update_branch`).
6. `git config user.name` / `user.email`, then `sync_repo_remotes`.
7. Continue with step 6 (the devcontainer, now read from the cloned repo).

**Undo.** A new `UndoStep::GitRoutes` runs `sync_routes` and `prune-mirrors`. Grants and remote
rows go with the workspace row by cascade.

**Clone ops.** `st.git_proxy.clone_ops: Mutex<HashMap<Uuid, CloneOp{user_id, state, line, percent, cancelled}>>`.
- The `opId` comes from the client.
- `percent` is the last `(\d+)%` of the last progress line.
- The entry is removed 10 minutes after it ends.
- Cancel sets `cancelled` and runs `kill $(cat /tmp/wh-clone.pid)` in the container.

**Errors:**
- cancelled → 409 `clone_cancelled`
- stderr contains `rejected by the host` → 400 `credential_rejected` (detail `connectionId`)
- anything else → 400 `clone_failed` (detail `message`: the last 20 stderr lines without progress lines)

### D11a — Service input types (seams between chunks 7–8 and chunk 10)

- **`connections::CreateInput`:** `{ name: String, provider: String, base_url: Option<String>, auth_method: String, username: Option<String>, secret: Option<String>, passphrase: Option<String>, expose_env: Option<String> }`.
- **`connections::UpdateInput`:** `{ name: Option<String>, secret: Option<String>, passphrase: Option<String>, username: Option<String>, expose_env: Option<Option<String>> }`.
  For `expose_env`, an absent field means unchanged and `null` means off.
- **`workspaces::remotes::AttachInput`:** `{ name: String, connection_id: Uuid, url: String, block_default_rewrite: bool /* default true */, only_ws_branches: bool /* default false */ }`.
- **`workspaces::remotes::UpdateRemoteInput`:** `{ connection_id: Option<Uuid>, block_default_rewrite: Option<bool>, only_ws_branches: Option<bool> }`.
- **`CloneSource`:** see D11.
- **Outputs:**
  - The services return `ConnectionRow`, `RemoteRow` and `TestResult` (`connections::TestResult`
    with the fields of the API `TestResult`).
  - `Branches` is `{ default_branch: Option<String>, branches: Vec<String> }`.
  - `PushResult` and `PushRemote` are structs in `workstreams/close.rs` with the API fields.
- Chunk 10 serializes these as camelCase.

### D12 — Close + push (FR-8)

- `CloseBody.push: bool` is `#[serde(default)]`.
- **Push remote:** `origin` if it exists, else the oldest remote; with no remote, `push` is ignored
  and the result is `null`.
- **Per close mode:**
  - `for_now`: `git -C /workspace/worktree push <remote> <s.branch>` in the workstream container
    before `containers::stop`.
  - `bring_into_main`: after the merge, `git -C /workspace/repo push <remote> <s.base_branch>` in the
    workspace container.
  - `merged_elsewhere`: no push.
- A failed push never fails the close.
- **Classification of a failed push** (`rejectedBy`):
  - stderr contains `Work Hub push policy` → `policy`
  - `rejected by the host`, `Authentication failed` or `unknown or revoked capability` → `credential`
  - anything else → `host`
- `message` is the stderr lines with `remote: ` stripped, at most 2000 characters.
- `prUrl` comes from `remote_url::pr_url`, and only when the pushed branch differs from the remote
  `default_branch`.
- The connection status is updated from the result.

### D13 — FR-9 readiness (design only, nothing ships)

- **Data.** A `kind = api` connection is a `connections` row with `kind = 'api'`, a new `api`
  descriptor (`provider`), any `auth_method` text and the same vault name `conn-<id>`. No column
  changes.
- **Routes.**
  - `/api/v1/connections` serves both kinds (a later `?kind=` filter).
  - Grants reuse `connection_grants`.
- **Proxy.**
  - The sidecar gets a second lighttpd alias, `/proxy/<connection id>/…` → a new CGI that injects
    `api_header` and forwards to the base URL.
  - Capability lines gain `api:<connection id>` entries.
  - The `/git` CGI, the hook and the `git_capabilities` table do not change.

### D14 — Connection secret lifecycle

- **Create:**
  - `ssh_generated`: `keygen workhub-<name key>`.
  - `ssh_uploaded`: `import-key` (stdin: passphrase line, then the key); the passphrase is never stored.
  - `pat`: the token as sent.
- The private key or PAT is stored as vault `conn-<id>`. `public_key`, `key_fingerprint` and
  `secret_hint` (the last 4 characters of a PAT) are stored in the row. Then `sync_connection`.
- **Edit with a new secret:** same as create, `secret_updated_at = now()`, `status = 'untested'`, then
  `sync_connection`.
- **Regenerate** (`ssh_generated` only): keygen again; the pinned host key is kept.
- **Delete:**
  - Without `?force=true` while remotes use the connection → 409 `connection_in_use {workspaces:[{id,name}]}`.
  - Otherwise: delete the row (grants cascade; `workspace_remotes.connection_id` is set to NULL and
    `connection_name` is kept), `secrets::delete`, then a tolerant `drop_connection` and
    `sync_routes` (D1 item 10).
- **Test** (`POST /connections/{id}/test {url?, acceptHostKey?}`):
  - SSH method without a pin, or with `acceptHostKey`:
    - `scan` the SSH host and port. The host is the descriptor host or base host; for generic, the
      host of `url`.
    - Without `acceptHostKey`, answer `{result:"host_key_unknown", hostKey}`.
    - With it, the fingerprint must equal the scanned ed25519 one (else the first line's) — else 400
      `host_key_mismatch` — and then pin it: `known_hosts`, `host_key_fingerprint`, `sync_connection`.
  - Then the check itself:
    - an API test (PAT with `api_test`), user from the JSON field;
    - or `test-ssh` with the greeting template (user from it);
    - or, when `test_needs_url` or a `url` is given, `ls-remote` of the resolved upstream.
  - Result mapping:
    - `Permission denied`, HTTP 401/403 or the D1 rejected substrings → `rejected`
    - a host key change → `host_key_changed`
    - other failures → `failed`
  - Stores `status`, `status_detail`, `status_user` and `status_at`.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `work-hub/server/migrations/0005_connections.sql` | new tables | per Database changes |
| `work-hub/sidecar/{Dockerfile,entry.sh,lighttpd.conf,wh-git-cgi,pre-receive,wh-git-ctl}` | git proxy sidecar image | port of the PoC per D3 / D4 |
| `work-hub/server/src/docker/names.rs` | `Role::GitProxy`, name fns | D2 |
| `work-hub/server/src/docker/networks.rs` (new) | ensure internal network, connect container | `ensure(docker, name, labels)`, `connect(docker, net, container, alias: Option<&str>)` |
| `work-hub/server/src/docker/mod.rs` | `pub mod networks` | |
| `work-hub/server/src/docker/images.rs` | embedded sidecar context + `ensure_git_proxy_image(docker, tag) -> DockerResult<()>` | like `ensure_default_image` |
| `work-hub/server/src/docker/containers.rs` | `create_git_proxy(docker, spec: &GitProxySpec)` | D2 container config |
| `work-hub/server/src/docker/exec.rs` | `exec_progress(docker, container, user, argv, timeout, on_stderr: impl FnMut(&[u8]) + Send) -> DockerResult<ExecOutput>` | streams stderr chunks |
| `work-hub/server/src/config.rs` | `git_proxy_image` (`WORK_HUB_GIT_PROXY_IMAGE`) | |
| `work-hub/server/src/state.rs` | `git_proxy: Arc<GitProxyState{status, clone_ops}>` | |
| `work-hub/server/src/lib.rs` | `gitproxy::spawn(state.clone())`, `mod connections; mod gitproxy;` | |
| `work-hub/server/src/gitproxy/mod.rs`, `ctl.rs`, `state.rs`, `containers.rs` | sidecar lifecycle, ctl wrapper, state push, `container_started` | D5 |
| `work-hub/server/src/connections/mod.rs`, `repo.rs`, `providers.rs`, `remote_url.rs`, `fields.rs`, `template.rs` | connections service / SQL / descriptors / URL / field rules / template matcher | D7–D9, D14 |
| `work-hub/server/src/workspaces/remotes.rs` (new), `repo.rs` | attach / update / detach / test remotes; remote SQL | |
| `work-hub/server/src/workspaces/clone.rs` (new), `mod.rs` | clone path, `UndoStep::GitRoutes`, `container_started` calls, delete hooks | D6, D11 |
| `work-hub/server/src/workstreams/mod.rs`, `close.rs` | `container_started` calls, `drop_container`, close push, `pushRemote` | D6, D12 |
| `work-hub/server/src/terminal/tmux.rs`, `workspaces/login.rs`, `workspaces/configure.rs` | env pair list | D10 |
| `work-hub/server/src/error.rs` | new error codes | API changes → Errors |
| `work-hub/server/src/api/connections.rs`, `api/remotes.rs` (new), `api/mod.rs`, `api/workspaces.rs`, `api/workstreams.rs`, `api/system.rs` | routes | API changes |
| `work-hub/web/src/api/connections.ts`, `api/remotes.ts` (new), `api/workspaces.ts`, `api/workstreams.ts` | API clients | API changes |
| `work-hub/web/src/routes.ts`, `App.tsx`, `layout/TopBar.tsx` | Connections route + menu item | |
| `work-hub/web/src/pages/connections/` (new): `ConnectionsPage.tsx`, `ConnectionsTable.tsx`, `AddConnectionDialog.tsx`, `ProviderStep.tsx`, `SshKeyStep.tsx`, `PatStep.tsx`, `EditConnectionDialog.tsx`, `GrantsEditor.tsx`, `DeleteConnectionDialog.tsx`, `TestResultView.tsx`, `HostKeyPrompt.tsx`, `*.module.css` | Connections UI | Visual/UX notes |
| `work-hub/web/src/pages/workspaces/NewWorkspaceDialog.tsx`, `CloneSourceFields.tsx` (new), `CloneProgress.tsx` (new) | clone from a connection | |
| `work-hub/web/src/pages/settings/SettingsPage.tsx`, `RemotesSection.tsx`, `AttachRemoteDialog.tsx`, `PushPolicyDialog.tsx` (new) | Remotes | |
| `work-hub/web/src/pages/workspace/CloseWorkstreamDialog.tsx`, `PushOption.tsx`, `PushResultView.tsx` (new) | close + push | |
| `work-hub/scripts/provider-names-check.mjs` (new), `work-hub/package.json` | FR-2 grep guard in `npm run lint` | |
| `work-hub/tests/fake-git-host/{Dockerfile,lighttpd.conf,git-cgi.sh,start.sh}` (new) | stand's git host | Test coverage plan |
| `work-hub/scripts/scenarios.mjs` | build / run fake git host, clean networks | |
| `work-hub/scripts/contract.mjs` | clean the instance's networks | |
| `work-hub/scripts/image.mjs` | `--git-proxy` manual / offline build of the sidecar image | |
| `work-hub/server/src/auth/tokens.rs` | `new_token` → `pub(crate)` | D5 |
| `work-hub/server/tests/contract/registry.rs` | 17 rows; `owner_scoped_404` id by path prefix | |
| `work-hub/server/tests/contract/harness.rs` | `World.connection`, `World.remote` | |
| `work-hub/server/tests/algo.rs` | 3 table tests | |
| `docs/knowledgebase/algorithms/workhub-remote-url.md`, `workhub-git-providers.md`, `workhub-connection-fields.md` + `docs/algorithm-examples/*.json` | algorithm docs and rows | |
| `work-hub/tests/scenarios/s-wh-connections.spec.ts` (new), `s-wh-workspace.spec.ts`, `s-wh-close.spec.ts`, `fixtures.ts` | scenarios | |
| `docs/knowledgebase/workhub-git-proxy.md` (new), `work-hub.md`, `index.md`, `algorithms/README.md` | KB | |
| `work-hub/README.md`, `work-hub/.env.example` | offline user docs, env var | |

## API changes

All routes need the session cookie (`Auth::Session`). An id that is foreign, missing or malformed
answers 404 `not_found`. New error codes in `error.rs` (status, code, detail):

| Status | Code | Detail |
|---|---|---|
| 400 | `invalid_connection` | `message` |
| 400 | `invalid_env_name` | — |
| 400 | `expose_not_allowed` | — |
| 409 | `connection_in_use` | `workspaces: [{id, name}]` |
| 400 | `not_generated_key` | — |
| 400 | `invalid_remote_url` | `message` |
| 400 | `connection_not_granted` | — |
| 400 | `invalid_remote_name` | — |
| 400 | `credential_rejected` | `connectionId`, `message` |
| 400 | `remote_error` | `message` |
| 400 | `clone_failed` | `message` |
| 409 | `clone_cancelled` | — |
| 503 | `git_proxy_not_ready` | — |
| 400 | `host_key_mismatch` | — |

Duplicate names reuse `duplicate_name`.

Types (camelCase JSON; dates RFC 3339):

```ts
type AuthMethod = "ssh_generated" | "ssh_uploaded" | "pat";
type ConnStatus = "untested" | "ok" | "rejected" | "host_key" | "failed";
interface ProviderInfo { id: string; displayName: string; shortLabel: string; kind: "git";
  authMethods: AuthMethod[]; baseUrlFixed: string | null; baseUrlPlaceholder: string;
  needsUsername: boolean; allowHttp: boolean; tokenPageUrl: string | null; tokenScopes: string | null;
  sshKeysPageUrl: string | null; prLabel: string | null; testNeedsUrl: boolean } // URLs keep {web}
interface Connection { id: string; name: string; kind: "git"; provider: string; providerName: string;
  baseUrl: string; authMethod: AuthMethod; username: string | null; secretSet: boolean;
  secretHint: string | null; secretUpdatedAt: string; publicKey: string | null;
  keyFingerprint: string | null; hostKeyFingerprint: string | null; exposeEnv: string | null;
  status: ConnStatus; statusDetail: string | null; statusUser: string | null; statusAt: string | null;
  grants: { workspaceId: string; workspaceName: string }[];
  usedBy: { workspaceId: string; workspaceName: string; remoteName: string }[]; createdAt: string }
interface TestRequest { url?: string; acceptHostKey?: string } // acceptHostKey = the fingerprint "SHA256:…" the user saw
interface TestResult { result: "ok" | "host_key_unknown" | "host_key_changed" | "rejected" | "failed";
  user: string | null; message: string | null; hostKey: { fingerprint: string; keyType: string } | null }
interface Remote { id: string; workspaceId: string; name: string; url: string; connectionId: string | null;
  connectionName: string; provider: string | null; providerName: string | null;
  blockDefaultRewrite: boolean; onlyWsBranches: boolean; defaultBranch: string | null;
  status: ConnStatus; statusDetail: string | null }
interface Branches { defaultBranch: string | null; branches: string[] }
interface CloneOp { state: "running" | "done" | "failed" | "cancelled"; line: string; percent: number | null }
interface PushResult { remote: string; branch: string; ok: boolean;
  rejectedBy: "policy" | "credential" | "host" | null; message: string | null;
  prUrl: string | null; prLabel: string | null }
interface PushRemote { name: string; connectionName: string; providerName: string | null; defaultBranch: string | null }
```

Rust mirrors these as `Serialize` structs in `api/connections.rs` / `api/remotes.rs` (same field
names, `#[serde(rename_all = "camelCase")]`).

| Method | Path | Body | Response / errors |
|---|---|---|---|
| GET | `/api/v1/connection-providers` | — | `ProviderInfo[]` |
| GET | `/api/v1/connections` | — | `Connection[]` (own only) |
| POST | `/api/v1/connections` | `{name, provider, baseUrl?, authMethod, username?, secret?, passphrase?, exposeEnv?}` (`secret` required unless `ssh_generated`) | 201 `Connection` · `invalid_connection`, `duplicate_name`, `invalid_env_name`, `expose_not_allowed`, `git_proxy_not_ready` |
| GET | `/api/v1/connections/{id}` | — | `Connection` |
| PATCH | `/api/v1/connections/{id}` | `{name?, secret?, passphrase?, username?, exposeEnv?: string \| null}` (provider, baseUrl, authMethod are not accepted) | `Connection` · same errors |
| DELETE | `/api/v1/connections/{id}?force=true` | — | 204 · 409 `connection_in_use` |
| POST | `/api/v1/connections/{id}/test` | `TestRequest` | `TestResult` · `invalid_remote_url`, `host_key_mismatch`, `git_proxy_not_ready` |
| POST | `/api/v1/connections/{id}/regenerate-key` | `{}` | `Connection` · `not_generated_key` |
| PUT | `/api/v1/connections/{id}/grants` | `{workspaceIds: string[]}` (replaces the set; foreign ids → 404) | `Connection` · `invalid_env_name` |
| POST | `/api/v1/connections/{id}/branches` | `{url}` | `Branches` · `invalid_remote_url`, `credential_rejected`, `remote_error`, `git_proxy_not_ready` |
| GET | `/api/v1/workspaces/{id}/remotes` | — | `Remote[]` |
| POST | `/api/v1/workspaces/{id}/remotes` | `{name, connectionId, url, blockDefaultRewrite?=true, onlyWsBranches?=false}` | 201 `Remote` · `invalid_remote_name`, `duplicate_name`, `connection_not_granted`, `invalid_remote_url` |
| PATCH | `/api/v1/remotes/{id}` | `{connectionId?, blockDefaultRewrite?, onlyWsBranches?}` | `Remote` · `connection_not_granted`, `invalid_remote_url` |
| DELETE | `/api/v1/remotes/{id}` | — | 204 (git remote removed from running containers, mirror dropped) |
| POST | `/api/v1/remotes/{id}/test` | `{}` | `TestResult` (`ls-remote` of its upstream) |
| GET | `/api/v1/clone-ops/{id}` | — | `CloneOp` (owner = the creating user) |
| POST | `/api/v1/clone-ops/{id}/cancel` | `{}` | 204 |

Changed (additive):

- `POST /api/v1/workspaces` accepts `{name, source?: {connectionId, url, branch?: string|null}, opId?: string}`.
  - New errors: `clone_failed`, `clone_cancelled`, `credential_rejected`, `invalid_remote_url`,
    `git_proxy_not_ready`, and 404 for a foreign connection.
- `POST /api/v1/workstreams/{id}/close` accepts `push?: boolean`. The response is
  `WorkstreamSummary & {push: PushResult | null}`: the summary is flattened via
  `CloseResponse { #[serde(flatten)] summary, push: Option<PushResult> }`.
- `POST /api/v1/workstreams/{id}/close/check` adds `pushRemote: PushRemote | null`.
- `GET /api/v1/system/status` adds `gitProxy: "ok" | "building" | "failed"`.

## Database changes

Migration `work-hub/server/migrations/0005_connections.sql`:
- Additive only, with `CREATE TABLE IF NOT EXISTS`.
- A `COMMENT ON` for every table and column, as in `0004_secret_key.sql`.

```sql
CREATE TABLE IF NOT EXISTS connections (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL, name_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('git', 'api')),
  provider text NOT NULL, base_url text NOT NULL,
  auth_method text NOT NULL,              -- open-ended: ssh_generated | ssh_uploaded | pat (later oauth…)
  username text NULL,
  secret_name text NOT NULL,              -- vault name conn-<id>
  secret_hint text NULL,                  -- last 4 chars of a PAT
  secret_updated_at timestamptz NOT NULL DEFAULT now(),
  public_key text NULL, key_fingerprint text NULL,
  known_hosts text NULL, host_key_fingerprint text NULL,
  expose_env text NULL,
  status text NOT NULL DEFAULT 'untested'
    CHECK (status IN ('untested', 'ok', 'rejected', 'host_key', 'failed')),
  status_detail text NULL, status_user text NULL,
  status_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name_key)
);
CREATE INDEX IF NOT EXISTS connections_user_idx ON connections (user_id);

CREATE TABLE IF NOT EXISTS connection_grants (
  connection_id uuid NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS connection_grants_workspace_idx ON connection_grants (workspace_id);

CREATE TABLE IF NOT EXISTS workspace_remotes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name text NOT NULL,
  connection_id uuid NULL REFERENCES connections (id) ON DELETE SET NULL,
  connection_name text NOT NULL,          -- kept for the "connection deleted" message
  url text NOT NULL, upstream_url text NOT NULL,
  default_branch text NULL,
  block_default_rewrite boolean NOT NULL DEFAULT true,
  only_ws_branches boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'untested'
    CHECK (status IN ('untested', 'ok', 'rejected', 'host_key', 'failed')),
  status_detail text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
CREATE INDEX IF NOT EXISTS workspace_remotes_connection_idx ON workspace_remotes (connection_id);

CREATE TABLE IF NOT EXISTS git_capabilities (
  container text PRIMARY KEY,             -- wh-ws-<uuid> / wh-st-<uuid>
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  workstream_id uuid NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,        -- sha256 hex; the token itself lives only in the container's /tmp
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS git_capabilities_workspace_idx ON git_capabilities (workspace_id);
```

Migration steps:
1. sqlx runs the migration at startup, like 0001–0004.
2. No data migration: existing workspaces have no rows and behave as before.
3. The first container start after the upgrade connects the container to the network and creates
   its capability.

## Test coverage plan

The project test policy allows three kinds of test, and Work Hub has its own places for each.

**Algorithm** — new docs in `docs/knowledgebase/algorithms/`, each with rows in
`docs/algorithm-examples/<name>.json` and a `#[test]` in `work-hub/server/tests/algo.rs`:
- `workhub-remote-url` (D8). Rows cover:
  - for every provider: HTTPS, `ssh://` and scp URLs → upstream URL for SSH and PAT auth;
  - the errors `wrong_host`, `wrong_path`, `transport_mismatch`, `http_not_allowed` and
    `not_a_git_url`;
  - a GitLab base URL with a sub-path and nested groups;
  - an Azure URL with userinfo;
  - PR URLs for GitHub, GitLab and Azure with a branch that needs encoding, and none for generic.
- `workhub-git-providers` (D7). Rows cover, per provider:
  - the git `header` value;
  - the API test request (URL and header);
  - the token page and SSH keys page URLs for a given base URL;
  - which auth methods are allowed;
  - whether a username is needed;
  - the greeting template → user extraction;
  - `base64_encode` on inputs of length 0, 1, 2 and 3 mod 3 (padding).
- `workhub-connection-fields` (D9). Rows cover:
  - env name accept / reject: leading digit, lower case, reserved names, the `WH_` prefix, the agent
    token name, a non-PAT method;
  - remote name rules;
  - base URL rules;
  - PAT and key shape.

**API contract** — 17 rows in `work-hub/server/tests/contract/registry.rs`: every route in the
API changes table except the four "Changed" ones, which are already registered. All are
`Auth::Session`. `owner_scoped` is false for `GET /connection-providers`, `GET /connections` and
`POST /connections`; true for all the others.

For the owner-scope check to mean something:
- The contract world (`harness.rs` `World`) gains user A's `connection: Uuid` and `remote: Uuid`.
  - The connection is created through the API: generic, PAT, base `http://git.test`, a dummy
    secret. This needs no ready sidecar (D1 item 10).
  - A grants the connection to A's workspace (`PUT /connections/{id}/grants`).
  - The remote is attached to A's workspace (`POST /workspaces/{id}/remotes`, name `origin`, URL
    `http://git.test/git/app.git`). No sidecar is needed (D1 items 10–11).
- `owner_scoped_404` picks the id by path prefix:
  - `/api/v1/connections/` → the connection;
  - `/api/v1/remotes/` → the remote;
  - `/api/v1/workstreams/` → the workstream;
  - `/api/v1/clone-ops/` → a fresh random uuid, since clone ops are in-memory and short-lived, so
    only "unknown → 404" is checked;
  - otherwise → the workspace.
- `scripts/contract.mjs` also removes the networks labelled with its instance. The sidecar
  container and its volume carry the instance label and are already removed.

**Scenario.** The stand gets a fake git host (`work-hub/tests/fake-git-host/`, the PoC `upstream/`
adapted):
- Repositories `/srv/git/app.git` (branches `main`, `dev`) and `/srv/git/empty.git`.
- sshd for user `git`, and smart HTTP with Basic `scenario:<PAT>`. The PAT file can be changed with
  `docker exec`.
- `scenarios.mjs` runs it on `wh-net-<instance>` with alias `git.test` and the stand's instance
  label. All tests use the `generic` provider.

Scenario changes:
- New `s-wh-connections.spec.ts` (`@S-WH-06 @mode-a`) for the new Connections feature:
  - FR-1: create, reload "secret set", edit replaces the secret, delete removes
    `<data dir>/secrets/<user id>/conn-<id>.enc`.
  - FR-1a (generic):
    - a generated key with pin;
    - an uploaded key with passphrase;
    - after `setFakePat` revokes the PAT, Test fails readably and `git fetch` fails with
      "rejected by the host".
  - FR-2: same UI, different provider tile.
  - FR-10: expose on → the variable is in the session; off (default) → absent.
  - FR-11: Test ok / error.
  - FR-1: "in use" delete.
- `s-wh-workspace.spec.ts` (`@S-WH-02`) gains steps for:
  - FR-4: clone, wrong URL, no secret in the container;
  - FR-3: no secret in the host workspace folders, any checkpoint image (`docker save` grep, only
    when one exists) or the recordings dir; the capability only in `/tmp`;
  - FR-5: attach; a non-granted connection is not offered, and a fetch through its remote from that
    workspace's container is rejected with "no grant";
  - FR-6: another user's container is rejected.
- `s-wh-close.spec.ts` (`@S-WH-05`) gains steps for:
  - FR-6: push from a workstream terminal;
  - FR-7: a plain push to `main` succeeds, a force push to `main` is rejected;
  - FR-8: push on close; a policy rejection keeps the close.

What scenarios cannot cover:
- The real GitHub, GitLab and Azure DevOps hosts. Their URL forms, headers and PR links are covered
  by the algorithm rows.
- Live tests against real hosts with real tokens are a manual check, not an automated test.

## Visual/UX notes

- **Connections page** (`#/connections`): a centred column at most 1100 px wide.
  - Header: title and "+ Add connection".
  - Table columns:
    - Name / provider
    - Auth: SSH fingerprint, or `secret set ••••<hint> · updated <date>`
    - Status: a green, red or grey dot with text; `statusDetail` underneath
    - Granted to: "N workspaces", or "none · Grant…"
    - Actions: Test, Edit, Delete…
  - When `exposeEnv` is set, a "👁 Visible to the agent" badge.
  - Empty state: "No connections yet. Work Hub works fully without them."
- **Add dialog** (≈ 560 px):
  1. Provider tiles from `GET /connection-providers`.
     - For GitLab-like providers with no fixed base URL: a "gitlab.com / Self-managed" choice; any
       provider with no `baseUrlFixed` shows a URL field.
     - Then Name and an Auth radio. "Generate a key in Work Hub ★ Recommended" is preselected when
       allowed.
  2. SSH:
     - The public key (read-only) with Copy and a link "Open SSH keys page ↗".
     - Then Test, which shows the HostKeyPrompt ("First connection to <host>", fingerprint,
       "Trust and pin" / Cancel).
     - Then "✓ Test passed · authenticated as <user>".
  3. PAT:
     - A "Create token ↗" link (`tokenPageUrl` with `{web}` filled in) and the scope hint.
     - Username, only when `needsUsername`.
     - A write-only Token field.
     - An "Expose to agent as env var" switch with a name field and a warning text.
     - "Save" creates the connection and runs Test automatically.
  - Error states: inline under fields, from the API `message`.
- **Edit dialog:**
  - Name.
  - "Update key…" (upload / token) or "Regenerate key" for generated keys, with a warning that the
    host needs the new public key.
  - The expose switch (disabled with a tooltip for SSH methods).
  - The GrantsEditor: a checklist of the user's workspaces.
- **Delete dialog:** lists `usedBy` workspaces; the button text is "Delete and break N remotes".
- **New workspace dialog:**
  - A segmented "Start from: Empty repository | Clone from a connection".
  - Clone mode:
    - A connection select, with an "Add connection…" link that opens `#/connections` in the same tab
      after confirming.
    - A repository URL field. On blur it calls `branches`.
    - A branch select, with the default branch preselected.
  - While creating: a progress bar (percent, or indeterminate), the last git line, and "Cancel".
  - Errors:
    - `clone_failed`: a red box with the git message.
    - `credential_rejected`: a box plus a link "Update key in Connections".
- **Settings → Remotes** replaces the "Repository" row.
  - One card per remote: name, connection name, a status dot, URL, auth, and a policy summary
    ("force push to default branch blocked" / "only ws/* branches").
  - Card actions: Test, Push policy…, Detach….
  - "＋ Attach remote" opens AttachRemoteDialog: remote name (default `origin`), a connection select
    (connections not granted are listed disabled as "not granted here · Grant…"), a URL field, two
    policy checkboxes, and Attach.
- **Close dialog:**
  - A "Push <branch> to <remote>" checkbox with a connection chip, unchecked by default.
    - It is hidden when `pushRemote` is null.
    - It is disabled for "Already merged elsewhere".
    - `<branch>` is the workstream branch for "Close for now" and the base branch for "Bring into main".
  - After the close, PushResultView shows:
    - "✓ Pushed <branch> to <remote>", with a "Create <prLabel> ↗" link when there is a `prUrl`;
    - or "Push rejected" with the message and "The workstream is closed locally";
    - or the credential state with an "Update key in Connections" link.
- No provider name, colour or logo is hard-coded in the web code: everything comes from
  `ProviderInfo`.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | DB schema and SQL repos | 4 | first; everything reads these tables |
| 2 | Sidecar image files | 6 | independent of Rust; ported from the PoC |
| 3 | Docker layer | 7 | names, network, volume, image, container, exec streaming |
| 4 | Descriptors, URL and field rules | 5 | pure Rust, no I/O |
| 5 | gitproxy service | 5 | needs 1–4 |
| 6 | Container hook and session env | 6 | needs 5; D6, D10 |
| 7 | Connections service | 6 | needs 4–5; D14 |
| 8 | Remotes and clone service | 6 | needs 6–7; D11 |
| 9 | Close + push | 4 | needs 8; D12 |
| 10 | API layer | 7 | needs 7–9 |
| 11 | Web API clients and navigation | 6 | needs 10 (shapes pinned in API changes) |
| 12 | Web Connections page and dialogs | 7 | needs 11 |
| 13 | Web workspace: new-workspace, Remotes, close push | 7 | needs 11 |
| 14 | Docs, image script and lint guard | 7 | after code |
| 15 | Tests — algorithm docs and rows | 6 | |
| 16 | Tests — contract registry and stand | 7 | |
| 17 | Tests — scenarios and final verification | 7 | last |
| 18 | Admin resource overview (FR-12) | 7 | added 2026-11-23 after chunks 1–17; D15 |

### D15 — Admin resource overview (FR-12)

- **Admins.** `config.admin_emails: Vec<String>` from `WORK_HUB_ADMIN_EMAILS`: split on `,`, trim,
  drop empty entries, lowercase (compared with `users.email_key`). An entry that is not an e-mail
  fails startup with `ConfigError::Invalid`. Unset = no admins. `UserRow::public_profile` takes the
  admin list and answers `role: "admin"` for a listed user, else `"user"` — same JSON shape, so old
  clients keep working. `auth::is_admin(cfg, user)` is the one check.
- **Route.** `GET /api/v1/admin/overview` (`Auth::Session`); non-admin → 403 `forbidden`
  (reuse the existing code if there is one, else add it to `error.rs`). Response (camelCase):
  `{ generatedAt, instance: { gitCacheBytes: number | null },
     users: [{ id, email, createdAt, workspaces: [{ id, name, workingBranch, createdAt,
       workstreamsOpen, workstreamsTotal, disk: { filesBytes, containersBytes, volumesBytes,
       imagesBytes, totalBytes } }], totalBytes }], totalBytes }`.
  A size that cannot be measured is `null` and counts as 0 in totals; the request never fails
  because Docker is unreachable.
- **Measuring.** One call per request, no caching:
  - files — walk the workspace's host folder (the helper the file API already uses for the
    workspace / workstream folders), in `spawn_blocking`, symlinks not followed;
  - containers — Docker container list with `size=true` filtered by the instance label, `SizeRw`
    summed per `artisyn.workhub.workspace` label;
  - volumes and images — Docker `system df` (`/system/df`), `UsageData.Size` of volumes and
    `Size` of images, summed per workspace label; the git cache volume `wh-gitcache-<instance>`
    goes to `instance.gitCacheBytes`.
  - Only objects labelled with this instance are counted.
- **Web.** `ROUTE.admin = "/admin"`, page `pages/admin/AdminPage.tsx` (+ CSS module): a table with
  one group per user (e-mail, workspace count, total) and one row per workspace (name, branch,
  workstreams `open / total`, files, containers, volumes, images, total, human-readable sizes),
  grand total and git cache in a summary line, a "Refresh" button. `TopBar` shows "Admin" in the
  account menu only when `me.role === "admin"`; a non-admin opening `#/admin` sees "Not allowed".
  `api/auth.ts` `role: "user" | "admin"`.
- **No connection data** in the response or the page (NFR Security).

### Chunk 1 — DB schema and SQL repos
- [ ] Create `work-hub/server/migrations/0005_connections.sql` exactly per Database changes, with a `COMMENT ON` for every table and column. Declare the modules: in `lib.rs` add `pub mod connections; pub mod gitproxy;`; create `connections/mod.rs` and `gitproxy/mod.rs`, each with `pub mod repo;`.
- [ ] Create `work-hub/server/src/connections/repo.rs` with `ConnectionRow` (`FromRow`, all `connections` columns). Add owner-filtered fns: `insert`, `get_owned`, `list_for_user`, `update_fields`, `set_secret_meta`, `set_status`, `set_host_key`, `delete`, `grants_of`, `replace_grants`, `used_by`, `exposed_for_workspace` (pat + expose_env + granted), `all_ids`.
- [ ] In `work-hub/server/src/workspaces/repo.rs` add `RemoteRow` and fns `insert_remote`, `list_remotes`, `get_remote_owned` (join to the workspace owner), `update_remote`, `delete_remote`, `set_remote_status`, `remote_by_name`.
- [ ] Add `work-hub/server/src/gitproxy/repo.rs`:
  - capability fns `upsert_capability(container, workspace_id, workstream_id, token_hash)` and `delete_capability(container)`;
  - `route_rows()`, which returns the D4 remote records plus capability lines (granted or `connection_id IS NULL` remotes per workspace).

### Chunk 2 — Sidecar image files
- [ ] Create `work-hub/sidecar/Dockerfile` and `entry.sh` per D3 (Alpine 3.20; packages incl. `curl`; `core.hooksPath`; `safe.directory`; `/srv/git` owned by `lighttpd`).
- [ ] Create `work-hub/sidecar/lighttpd.conf` per D3 (`mod_alias` + `mod_cgi`, no access log, `/git` → `wh-git-cgi`).
- [ ] Create `work-hub/sidecar/wh-git-cgi` from the PoC: tab-separated remote record read per D4 (never sourced), D1 messages and classification, error transport per D1 item 5 (401 for rejected-by-host and capability failures, `ERR` pkt-line for the rest).
- [ ] Create `work-hub/sidecar/pre-receive` from the PoC, honouring the `block_default` and `only_ws` record fields and the D1 policy messages.
- [ ] Create `work-hub/sidecar/wh-git-ctl` with every command in the D3 table. It validates `put` paths with the D3 regex and writes atomically (tmp file + `mv`, mode 0600).
- [ ] Mark the four scripts executable via the Dockerfile `chmod`. Add `work-hub/sidecar/.gitattributes` with `* text eol=lf`.

### Chunk 3 — Docker layer
- [ ] In `docker/names.rs` add `Role::GitProxy` (`git-proxy`), `git_proxy_container(instance)`, `git_network(instance)` and `git_cache_volume(instance)` per D2.
- [ ] Create `docker/networks.rs`:
  - `ensure(docker, name, labels) -> DockerResult<()>` (internal bridge network, idempotent);
  - `connect(docker, net, container, alias: Option<&str>) -> DockerResult<()>` (already connected → Ok);
  - `remove(docker, name)`.
  Register it in `docker/mod.rs`.
- [ ] In `docker/images.rs` embed `../sidecar/` with `RustEmbed` and add `ensure_git_proxy_image(docker, tag) -> DockerResult<()>` (build when missing), reusing `build_from_tar`.
- [ ] In `docker/containers.rs` add `GitProxySpec {name, image, labels, cache_volume, network, env}` and `create_git_proxy(docker, &GitProxySpec) -> DockerResult<()>`: create on `bridge`, connect `network` with alias `wh-git`, start (D2 config).
- [ ] In `docker/exec.rs` add `exec_progress(docker, container, user, argv, timeout, on_stderr: impl FnMut(&[u8]) + Send) -> DockerResult<ExecOutput>`, which calls `on_stderr` per stderr chunk and also collects it.
- [ ] Add `git_proxy_image` to `config.rs` (`WORK_HUB_GIT_PROXY_IMAGE`, default per D2).
- [ ] In `docker/volumes.rs` add `ensure_named(docker, name, labels) -> DockerResult<()>`: a plain local named volume (no bind device), created only when missing. It backs `wh-gitcache-<instance>`.

### Chunk 4 — Descriptors, URL and field rules
- [ ] Create `connections/template.rs`:
  - `match_template(tmpl, path) -> Option<BTreeMap<String,String>>`;
  - `fill(tmpl, vars) -> String` (percent-encodes `branch` and `target`);
  - `match_line(tmpl, text) -> Option<BTreeMap>` (per line, for greetings).
  Syntax per D7.
- [ ] Create `connections/providers.rs` with `Provider`, `SshRule`, `PatUser`, `ApiTest`, `AuthMethod` (`as_str`/`parse`), `all()`, `get()` and the four rows exactly per D7. Add `git_header(p, username, pat) -> String` and `api_request(p, base, pat) -> Option<(String url, String header)>`.
- [ ] Create `connections/remote_url.rs` with `ParsedUrl`, `UrlError` (codes per D8), `parse`, `resolve` and `pr_url` per D8.
- [ ] Create `connections/fields.rs` with `validate_base_url`, `validate_remote_name`, `validate_pat`, `validate_private_key`, `is_env_name` and `validate_expose_env(name, method, agent_envs: &[&str]) -> Result<(), FieldError>` per D9.
- [ ] In the existing `connections/mod.rs` add `pub mod template; pub mod providers; pub mod remote_url; pub mod fields;` (public for `tests/algo.rs`). Add `providers::base64_encode` per D7 derived values.

### Chunk 5 — gitproxy service
- [ ] Add `GitProxyState {status: RwLock<ProxyStatus>, clone_ops: Mutex<HashMap<Uuid, CloneOp>>}` to `state.rs` as `AppState.git_proxy`. `ProxyStatus::as_api_str` → `ok` / `building` / `failed`.
- [ ] Create `gitproxy/ctl.rs` with `ctl` (gated: 503 `git_proxy_not_ready` unless the status is Ok) and `ctl_raw` (ungated), per D5. Both run as user `lighttpd` in the sidecar container and never log stdin or stdout.
- [ ] Create `gitproxy/mod.rs` with `spawn(st)`: ensure network, image, volume and container via the chunk 3 fns with instance labels and D2 env passthrough, then `push_all`, then a 30 s `is-ready` loop. Status transitions per D5. Call it from `lib.rs` after the default image spawn.
- [ ] Create `gitproxy/state.rs` (declare `pub mod ctl; pub mod state; pub mod containers;` in `gitproxy/mod.rs`) with `push_all`, `sync_connection` (D4 files from the row plus `secrets::get`), `drop_connection` and `sync_routes` (from `repo::route_rows`), all via `ctl_raw`, per D5.
- [ ] Add to `gitproxy/mod.rs`: `PROXY_HOST`, `remote_url(id)`, `CREDENTIAL_HELPER` (D2 string) and `classify(output) -> Outcome {Ok, Rejected, HostKeyChanged, Failed(String)}` per the D1 substrings.

### Chunk 6 — Container hook and session env
- [ ] Create `gitproxy/containers.rs` with `container_started`, `sync_repo_remotes` and `drop_container`, with the exact steps of D5. Write the capability file via `exec_capture` stdin as the workspace exec user, never via `put_files` (D1 item 8). Make `auth::tokens::new_token` `pub(crate)`.
- [ ] Call `container_started` at every site listed in D6 in `workspaces/mod.rs`, with `repo_dir` = `WORKSPACE_REPO_DIR`.
- [ ] Call `container_started` at the D6 sites in `workstreams/mod.rs` (`repo_dir` = `WORKSTREAM_WORKTREE_DIR`, `workstream` = id). Call `drop_container` in the workstream object removal path (merged elsewhere, discard).
- [ ] In `workspaces::delete` call `sync_routes` and `prune-mirrors` (via `ctl_raw`) after the DB delete. In `delete_user_data` (`workspaces/mod.rs:1045`) call `connections::delete_all_for_user` before `secrets::delete_all`, per D6. Create that fn in `connections/mod.rs`. Log sidecar failures; never fail the delete.
- [ ] Change `terminal/tmux.rs` `SecretEnv` and `SessionOpts` to the list form per D10 (one `read` per pair; skip invalid names or values containing a newline).
- [ ] Add `connections::exposed_env(st, ws) -> Result<Vec<(String,String)>, ApiError>` in `connections/mod.rs` (`repo::exposed_for_workspace` plus vault values). Change `login::agent_env` / `agent_token` to return `Vec<(String,String)>` (the token, then the exposed pairs) per D10. Update the callers in `workstreams/mod.rs`, `configure.rs` and `login.rs`.

### Chunk 7 — Connections service
- [ ] In `connections/mod.rs` add `create(st, user, CreateInput)` per D14 and D11a: field rules (D9), keygen / import-key (these need the proxy) or PAT, vault `conn-<id>`, row insert, then a tolerant `sync_connection` (D1 item 10). Add `record_outcome(st, conn_id, outcome, user)` per D1 item 9.
- [ ] Add `update(st, user, id, UpdateInput)` (rename, secret replace, username, `exposeEnv` incl. the D9 `containerEnv` check) and `regenerate_key(st, user, id)` per D14.
- [ ] Add `delete(st, user, id, force)` per D14: `connection_in_use` without `force`; row delete, `secrets::delete`, `drop_connection`, `sync_routes`.
- [ ] Add `set_grants(st, user, id, workspace_ids)`: own workspaces only (else 404), D9 `containerEnv` check, `replace_grants`, `sync_routes`.
- [ ] Add `test(st, user, id, url, accept_host_key) -> TestResult` with the D14 host-key and check flow, and status persistence via `repo::set_status`.
- [ ] Add `branches(st, user, id, url) -> Branches` (D11a): `resolve`, ctl `ls-remote`, parse the `ref: … HEAD` symref and `refs/heads/*`, and `record_outcome` on failure or success.

### Chunk 8 — Remotes and clone service
- [ ] Create `workspaces/remotes.rs` with `attach(st, user, ws_id, AttachInput)` (D11a): name rule, grant check (`connection_not_granted`), `resolve`, row insert (`default_branch` NULL, D1 item 11), tolerant `sync_routes`, then `sync_repo_remotes` in the running workspace and workstream containers.
- [ ] Add `update_remote(…, UpdateRemoteInput)` (rebind needs a grant; policy flags), `detach` (row delete, `sync_routes`, `prune-mirrors`, `git remote remove` in running containers) and `test_remote` (ctl `ls-remote`; store the remote status and `default_branch`; `record_outcome` on its connection).
- [ ] Create `workspaces/clone.rs` with the clone-op registry fns `register(op_id, user_id)`, `progress(op_id, user_id) -> Option<CloneOp>`, `cancel(st, op_id, user_id, container)` and `finish(op_id, state)`, plus progress-line parsing per D11.
- [ ] In `workspaces/clone.rs` add `CloneSource` and `clone_steps(st, ws_id, owner, user, source, op_id, undo)`, implementing D11 steps 1–6 with `exec_progress`, the D11 error mapping and `record_outcome` on the connection.
- [ ] In `workspaces/mod.rs` extend `create(st, user, name, source: Option<CloneSource>, op_id: Option<Uuid>)`: D11 pre-checks, branch step 5 to `clone::clone_steps` when a source is given, `UndoStep::GitRoutes`, map `StepError::Clone` in `create_error`.
- [ ] Add `pub mod remotes; pub mod clone;` to `workspaces/mod.rs`.

### Chunk 9 — Close + push
- [ ] In `workstreams/close.rs` add `push_remote(st, ws) -> Option<RemoteRow>` (origin, else the oldest) and add `pushRemote: Option<PushRemote>` to `CloseCheck` (D12).
- [ ] Add `push_branch(st, ws, container, repo_dir, remote, branch) -> PushResult` per D12: exec as the workspace user, 10 min timeout, `rejectedBy` classification, `pr_url`, connection status update.
- [ ] Extend `close(…, push: bool) -> (WorkstreamRow, Option<PushResult>)`: `for_now` pushes `s.branch` before `containers::stop`; `bring_into_main` pushes `s.base_branch` from the workspace container after the merge; `merged_elsewhere` never pushes. A push failure never errors.
- [ ] Update every caller of `close::close` to the new signature and tuple result.

### Chunk 10 — API layer
- [ ] Add the new error codes to `error.rs` exactly per the API changes error table (constructors with the listed details).
- [ ] Create `api/connections.rs` with the handlers for the 10 connection routes, the `ProviderInfo` / `Connection` / `TestResult` / `Branches` serializers (API changes types) and `parse_body` like `api/workspaces.rs`.
- [ ] Create `api/remotes.rs` with the handlers for `GET`/`POST …/workspaces/{id}/remotes`, `PATCH`/`DELETE /remotes/{id}`, `POST /remotes/{id}/test` and `GET /clone-ops/{id}`, `POST /clone-ops/{id}/cancel`, using the `Remote` / `CloneOp` serializers.
- [ ] Register all 17 routes in the `routes!` block of `api/mod.rs` (paths exactly as in the API changes table). Add `pub mod connections; pub mod remotes;`.
- [ ] In `api/workspaces.rs` replace `NameBody` with `CreateBody {name, #[serde(default)] source: Option<SourceBody>, #[serde(default)] op_id: Option<Uuid>}` and pass them to `workspaces::create`.
- [ ] In `api/workstreams.rs` add `#[serde(default)] push: bool` to `CloseBody` and return `CloseResponse {#[serde(flatten)] summary, push}`. In `api/system.rs` add `gitProxy` (`st.git_proxy.status.as_api_str()`) to the status response.
- [ ] Run `npm run lint`, `npm run typecheck` and `npm run test:algo` from `work-hub/` and fix any failures.

### Chunk 11 — Web API clients and navigation
- [ ] Create `web/src/api/connections.ts`: types `AuthMethod`, `ConnStatus`, `ProviderInfo`, `Connection`, `TestResult`, `Branches` (API changes); `connectionKeys`; fns `listProviders`, `listConnections`, `getConnection`, `createConnection`, `updateConnection`, `deleteConnection(id, force)`, `testConnection`, `regenerateKey`, `setGrants`, `listBranches`.
- [ ] Create `web/src/api/remotes.ts`: types `Remote`, `CloneOp`; `remoteKeys`; fns `listRemotes`, `attachRemote`, `updateRemote`, `detachRemote`, `testRemote`, `getCloneOp`, `cancelCloneOp`.
- [ ] In `web/src/api/workspaces.ts` extend `createWorkspace(name, source?, opId?)` (send `source` / `opId` only when given) and `SystemStatus.gitProxy`.
- [ ] In `web/src/api/workstreams.ts` add `PushResult` / `PushRemote` types, `CloseCheck.pushRemote` and `closeWorkstream(id, mode, force, commit, push = false)` (send `push` only when true), returning `WorkstreamSummary & {push?: PushResult | null}`.
- [ ] Add `connections: "/connections"` to `ROUTE` / `routes` in `web/src/routes.ts` and the route to `ConnectionsPage` in `App.tsx`'s router tree.
- [ ] In `layout/TopBar.tsx` add a "🔑 Connections" item before "Edit email" / "Logout" in the account `DropdownMenu`, navigating with `routes.connections`.

### Chunk 12 — Web Connections page and dialogs
- [ ] Create `pages/connections/ConnectionsPage.tsx` + `.module.css` and `ConnectionsTable.tsx` with the columns, badge, status dot and empty state per Visual/UX notes, using react-query `connectionKeys`.
- [ ] Create `AddConnectionDialog.tsx` with `ProviderStep.tsx` (provider tiles, base URL, name, auth radio with the generated key preselected) per Visual/UX notes.
- [ ] Create `SshKeyStep.tsx` (generated: public key + Copy + SSH keys link; uploaded: key textarea + passphrase) and `PatStep.tsx` (token link with `{web}` filled in, username when `needsUsername`, token, expose switch + env name).
- [ ] Create `TestResultView.tsx` and `HostKeyPrompt.tsx`: Test calls `testConnection`; `host_key_unknown` / `host_key_changed` show the prompt; "Trust and pin" re-calls with `acceptHostKey` = the shown fingerprint string (`TestRequest`). A URL field is shown when `testNeedsUrl`.
- [ ] Create `EditConnectionDialog.tsx` (rename, Update key / token, Regenerate key, expose switch disabled for SSH) and `GrantsEditor.tsx` (workspace checklist → `setGrants`).
- [ ] Create `DeleteConnectionDialog.tsx`: on 409 `connection_in_use` list the workspaces and confirm with `force=true`.
- [ ] Keep every component file under 10 KB. Use only `web/src/ui/` primitives and CSS module tokens, with no provider names in code.

### Chunk 13 — Web workspace: new-workspace, Remotes, close push
- [ ] Create `pages/workspaces/CloneSourceFields.tsx`: connection select with an "Add connection…" link, a URL field calling `listBranches` on blur, a branch select with the default preselected, and the `credential_rejected` / `invalid_remote_url` messages.
- [ ] Create `CloneProgress.tsx`: polls `getCloneOp(opId)` every 500 ms while the create request runs (404 = "starting", D11); progress bar, last line, Cancel → `cancelCloneOp`.
- [ ] Extend `NewWorkspaceDialog.tsx` with a "Start from" segmented control; in clone mode generate `opId` (`crypto.randomUUID()`), call `createWorkspace(name, source, opId)` and render `CloneProgress` / errors per Visual/UX notes.
- [ ] Create `pages/settings/RemotesSection.tsx` (remote cards, Test, Detach via confirm-dialog) and replace the "Repository" row in `SettingsPage.tsx` with it.
- [ ] Create `AttachRemoteDialog.tsx` (name, connection select with non-granted entries disabled + "Grant…" → `setGrants`, URL, two policy checkboxes) and `PushPolicyDialog.tsx` (`updateRemote` flags).
- [ ] Create `pages/workspace/PushOption.tsx` (checkbox + connection chip; hidden without `pushRemote`; disabled for merged elsewhere) and `PushResultView.tsx` (ok + PR link / rejected / credential).
- [ ] Wire both into `CloseWorkstreamDialog.tsx`: pass `push` to `closeWorkstream` and show `PushResultView` after the close instead of closing the dialog immediately when `push` was requested.

### Chunk 14 — Docs, image script and lint guard
- [ ] Create `work-hub/scripts/provider-names-check.mjs` (pattern `/github|gitlab|azure devops|dev\.azure\.com|visualstudio\.com/i` over `server/src/**/*.rs` and `web/src/**`; allow only `server/src/connections/providers.rs`). Append it to the `lint` script in `work-hub/package.json`.
- [ ] Create `docs/knowledgebase/workhub-git-proxy.md` (OKF v0.3 front matter) covering D1–D6, D11–D13, the sidecar layout, the error messages and how to debug (`docker exec wh-gitproxy-<instance> …`). Add its line to `docs/knowledgebase/index.md`.
- [ ] Update `docs/knowledgebase/work-hub.md`: container model (extra network), Docker object naming (sidecar, network, volume, `git-proxy` role), the config table (`WORK_HUB_GIT_PROXY_IMAGE`), the offline note (the sidecar image build needs the network once), and a pointer to the new article.
- [ ] Add a "Remote repositories and connections" section to `work-hub/README.md`:
  - providers, auth methods, how to add a key or token, grants, push policy, expose to agent, error messages;
  - offline and self-contained, with no provider links as the only source.
- [ ] Add `WORK_HUB_GIT_PROXY_IMAGE` (commented, with its default) to `work-hub/.env.example`.
- [ ] Extend `work-hub/scripts/image.mjs`: with `--git-proxy` it builds `artisyn-work-hub-git-proxy:<crate version>` from `work-hub/sidecar`. Document `npm run image -- --git-proxy`, plus `docker save` / `docker load` for offline installs, in `work-hub/README.md`.
- [ ] Bump `generated.at` in the edited KB articles.

### Chunk 15 — Tests: algorithm docs and rows
- [ ] Create `docs/knowledgebase/algorithms/workhub-remote-url.md` (format of `workhub-repo-path.md`: Purpose, Code, Input and output, Twins: none) and `docs/algorithm-examples/workhub-remote-url.json` with the rows listed in Test coverage plan.
- [ ] Create `docs/knowledgebase/algorithms/workhub-git-providers.md` and `docs/algorithm-examples/workhub-git-providers.json` with the rows listed in Test coverage plan.
- [ ] Create `docs/knowledgebase/algorithms/workhub-connection-fields.md` and `docs/algorithm-examples/workhub-connection-fields.json` with the rows listed in Test coverage plan.
- [ ] In `work-hub/server/tests/algo.rs` add `#[test] fn workhub_remote_url()`, `workhub_git_providers()` and `workhub_connection_fields()` using `run_table` / `expect_subset` against the public chunk 4 fns.
- [ ] Add the three docs to the list in `docs/knowledgebase/algorithms/README.md`.
- [ ] Run `npm run test:algo` from `work-hub/` until green.

### Chunk 16 — Tests: contract registry and stand
- [ ] Add the 17 rows listed in Test coverage plan → API contract to `work-hub/server/tests/contract/registry.rs`, grouped under a `// Connections and remotes` comment.
- [ ] In `server/tests/contract/harness.rs` add `connection` and `remote` to `World`, created by user A per Test coverage plan → API contract. In `registry.rs` `owner_scoped_404`, pick the id by path prefix as listed there.
- [ ] In `work-hub/scripts/contract.mjs` `removeInstanceObjects`, also remove networks with the instance label filters (`docker network ls -q` + `docker network rm`).
- [ ] Create `work-hub/tests/fake-git-host/` (Dockerfile, `lighttpd.conf`, `git-cgi.sh`, `start.sh`) from the PoC `upstream/`:
  - repos `/srv/git/app.git` (`main`, `dev`) and `/srv/git/empty.git`;
  - user `git` with sshd;
  - HTTP Basic `scenario:<PAT from /etc/pat>`;
  - lighttpd running as `git`.
- [ ] In `work-hub/scripts/scenarios.mjs`:
  - build `artisyn-work-hub-fake-git-host:test`;
  - after `/health`, wait for network `wh-net-<instance>` and run `whs-fakegit-<hex>` there with alias `git.test` and the stand instance label;
  - before starting Playwright, poll `GET /api/v1/system/status` until `gitProxy == "ok"` (timeout
    600 s; fail the run with the status on timeout);
  - pass `WH_FAKE_GIT_HOST=git.test` to Playwright.
- [ ] In `scenarios.mjs` cleanup, also remove networks labelled with the stand instance and include them in the "nothing left" check.
- [ ] Run `npm run test:contract` from `work-hub/` until green.

### Chunk 17 — Tests: scenarios and final verification
- [ ] Add fixtures to `tests/scenarios/fixtures.ts`:
  - `fakeGit(cmd)` (docker exec in the fake host container);
  - `addAuthorizedKey(pub)`;
  - `setFakePat(value)`;
  - `createPatConnection(api, name)`;
  - `FAKE_GIT_HTTP` (`http://git.test/git/app.git`) and `FAKE_GIT_SSH` (`ssh://git@git.test/srv/git/app.git`).
- [ ] Create `s-wh-connections.spec.ts` (`@S-WH-06 @mode-a`), steps 1–4:
  1. Empty state.
  2. PAT create; reload shows "secret set" with no value in the API; edit replaces the secret.
  3. Generated SSH key with Trust and pin; the private key is absent from every API response.
  4. Uploaded key with passphrase.
- [ ] Add steps 5–8 to `s-wh-connections.spec.ts`:
  5. Revoke the PAT via `setFakePat`: Test shows the error and `git fetch` fails with "rejected by
     the host".
  6. Expose: env name error; on → `SCN_TOKEN` in `tmux show-environment`; off → absent.
  7. Grants.
  8. Delete in use → `git fetch` "was deleted"; the `conn-<id>.enc` file is gone.
- [ ] Extend `s-wh-workspace.spec.ts` (`@S-WH-02`) with these steps:
  - clone from a PAT connection on branch `dev`;
  - no secret in `env`, `git config -l`, container files, host workspace folders, recordings or a
    checkpoint image;
  - the capability present only in `/tmp`;
  - a wrong URL creates no workspace;
  - attach a remote to an empty workspace and fetch;
  - a non-granted connection is not offered, and fetching via its remote gives "no grant";
  - another user's container is rejected.
- [ ] Extend `s-wh-close.spec.ts` (`@S-WH-05`) with these steps:
  - `git push origin ws/<slug>` from the workstream terminal;
  - a plain push to `main` succeeds;
  - force push to `main` rejected with the policy message;
  - close for now with push → branch on the fake host and "Pushed" shown;
  - `onlyWsBranches` + bring into main with push → "Push rejected", workstream closed.
- [ ] Run `npm run test:scenarios -- --mode a --grep "@S-WH-06|@S-WH-02|@S-WH-05"` from `work-hub/` until green, then `npm run test:scenarios -- --mode b` and `--mode c`.
- [ ] Run the full Work Hub set from `work-hub/`: `npm run lint`, `npm run typecheck`, `npm run test:algo`, `npm run build`, `npm run test:contract`; then do the visual check of the Connections page, the add dialog and the Settings Remotes card against the wireframes.

### Chunk 18 — Admin resource overview (FR-12, D15)
- [x] `config.rs`: `admin_emails` from `WORK_HUB_ADMIN_EMAILS` per D15 (invalid entry fails startup); add it to every `Config` literal (contract harness, scenario stand). `auth/users.rs`: `public_profile` answers `role: "admin"` for a listed user; update all callers; add `auth::is_admin`.
- [x] Server: `admin/` module with `overview(st)` per D15 (files walk, container `SizeRw`, `system df` volumes and images, git cache volume; unmeasurable → `null`). `api/admin.rs` handler `GET /api/v1/admin/overview` (403 for non-admins); register it in `routes!`.
- [x] Web: `api/admin.ts` (types + `getAdminOverview`), `api/auth.ts` role `"user" | "admin"`, `ROUTE.admin`, `pages/admin/AdminPage.tsx` + CSS module per D15, "Admin" menu item in `TopBar.tsx` only for admins. Component files under 10 KB, `web/src/ui/` primitives only.
- [x] Contract: registry row(s) for `GET /api/v1/admin/overview` — admin answers 200 with the D15 shape and the world's users / workspaces; a plain user answers 403. Make the contract world's admin via the harness `Config.admin_emails`.
- [x] Scenario: a step in an existing mode-a scenario (stand env `WORK_HUB_ADMIN_EMAILS` = the scenario's admin e-mail): the admin sees "Admin", the page lists the users with their workspaces, workstream counts and a non-zero total; another user sees no menu item and gets 403.
- [x] Docs: `WORK_HUB_ADMIN_EMAILS` in `docs/knowledgebase/work-hub.md` (config table, API list), `work-hub/README.md` (how to make someone an admin), `work-hub/.env.example`, `deploy/` env example if it lists variables; bump `generated.at`.
- [x] Run `npm run lint`, `npm run typecheck`, `npm run test:algo`, `npm run build`, `npm run test:contract` (only the known `create_login_patch_delete` may fail) and the touched scenario from `work-hub/` until green.
