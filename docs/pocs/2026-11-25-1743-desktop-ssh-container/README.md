# PoC: Claude Desktop SSH session into a local Docker container

Task: [2026-11-25-local-sandbox-tool](../../tasks/todo/2026-11-25-local-sandbox-tool/requirements.md)

## Question

Can a non-technical user's Claude Desktop (Code tab) work inside a local Docker container through an
SSH environment, with everything the agent does staying in the container? In detail:

1. Do Debian (glibc) and Alpine (musl) containers with `sshd` + SFTP meet Desktop's SSH-remote
   requirements, and does Desktop install and run Claude Code inside them?
2. Does Desktop accept a key it did not generate, (a) entered in its "Add SSH connection" form and
   (b) referenced from a `~/.ssh/config` alias opened by a `claude://code/new?ssh_host=<alias>` link?
3. How does the "worktree folder" behave for a top folder that is not a git repo but holds two repos?
4. Are project skills (`/work/sample/.claude/skills`) and user-level skills copied into
   `~/.claude/skills` in the container both available?
5. What does Desktop write into the container (`~/.claude/remote/`, sign-in), and is anything left on
   the host?
6. Does a live bind mount of an external host folder work, writing through to the host?

## How to run (from this folder)

```
node up.js --image debian --mount out/extra          # 127.0.0.1:2222, prints ssh check + links
node up.js --image alpine                            # 127.0.0.1:2223
node up.js --image debian --mount out/extra --write-ssh-config   # + alias in ~/.ssh/config (backed up)
node up.js --image debian --config-only              # only (re)write ~/.ssh/config, keep the container
node inspect.js --image debian                       # what Desktop left in the container (names only)
node down.js                                         # remove containers and the PoC ~/.ssh/config blocks
```

`up.js` builds `images/<name>`, generates `keys/id_ed25519`, copies `sample/` to `/work/sample`
(`claude-config/` becomes `.claude/`, `repo-a`/`repo-b` become git repos), copies
`user-skills/poc-user-skill` into `~/.claude/skills`, writes a generated `~/.claude/CLAUDE.md` listing
the mounts, then checks SSH and SFTP with the key.

### Manual Desktop steps

- **T1 (form):** Code tab → environment → SSH → Add SSH connection: host `claude@127.0.0.1`, port
  `2222`, key = path printed by `up.js`, folder `/work/sample`. Start a session.
- **T2 (link):** run `up.js --write-ssh-config`, open the printed `link (alias)` in a browser or Win+R.
  Also try `link (no alias)`.
- **T3 (isolation):** ask Claude: "create `hello.txt` here, run `uname -a`, write `~/x.txt`, list
  `/mnt/host`". Check nothing appeared in this PoC's `sample/` or the user's home on the host.
- **T4 (skills):** ask "check the project skill" and "check the user skill" — expect
  `PROJECT-SKILL-OK` and `USER-SKILL-OK`; ask what `~/.claude/CLAUDE.md` says about mounts.
- **T5 (worktree):** note whether Desktop asks for or creates a worktree for `/work/sample` (no git
  at the top), then run `node inspect.js`.
- **T6:** repeat T1 against Alpine (port `2223`).
- **T7 (external folder):** `up.js --mount <any folder>` and ask Claude to list and write a file in
  `/mnt/host/<name>`.

## Result

**Automated part (2026-11-25, Windows 11, Docker Desktop engine, Windows OpenSSH 9.5):**

- Debian bookworm image: SSH key login and SFTP work; glibc 2.36, `/bin/bash`, enough disk.
- Alpine 3.20 image: SSH key login and SFTP work; musl, `/bin/bash`. Needed: `openssh-sftp-server`,
  an explicit `Subsystem sftp`, and unlocking the account (`claude:*` in `/etc/shadow`), otherwise
  key login is refused.
- A key that the script generates (not Desktop) works with Windows OpenSSH once the private key's
  ACL is restricted to the current user (`icacls /inheritance:r`).
- Live bind mount: a host folder is visible at `/mnt/host/<name>`; a file written by the container user
  appears on the host immediately.
- Sample layout: top folder without git, `repo-a`/`repo-b` as two git repos, `.claude/` with a project
  skill, user skill in `~/.claude/skills` — all in place.

**Desktop part (Debian container, 2026-11-25):**

- **T1 (form) — works.** The form needs the port (`2222`) and an **absolute** key path; a relative
  path fails with "ssh couldn't find or open the key file". First connect shows a "Trust and connect"
  host-key fingerprint dialog. The form also shows "This connects to this computer over SSH…" — a
  hint, not a block. An SSH environment has a list of **folders, each with an opt-in "Worktree"
  checkbox**, plus environment variables. The remote folder picker hides dot-folders.
- **Claude Code install:** on first session Desktop downloads the CLI into the container
  (~130 MB download). On disk: `~/.claude/remote/ccd-cli/<version>` 364 MB, `plugins` 12 MB, `srv`
  9 MB. The directory names carry the version, so a volume shared between workstreams (or a
  pre-seeded image) avoids the download on every new workstream.
- **T3 (isolation) — works.** `hello.txt` landed in `/work/sample` in the container; `~/x.txt` in the
  container home; `uname` shows the container. On the host: nothing new in `sample/` or in the home
  folder; only the live mount `out/extra` is visible under `/mnt/host`.
- **T4 (skills) — works.** Project skill from `/work/sample/.claude/skills` → `PROJECT-SKILL-OK`,
  `pwd` = `/work/sample`; user skill from `~/.claude/skills` → `USER-SKILL-OK`, `whoami` = `claude`.
  The CLI runs with `--setting-sources=user,project,local`, so a generated `~/.claude/CLAUDE.md` is
  loaded too.
- **T5 (no git at the top) — works.** With "Worktree" unchecked, Desktop creates no worktree;
  `repo-a`/`repo-b` keep only their main worktree. A non-git top folder with several repos is fine.
- **How the session runs** (`inspect.js`): `sshd` → a Desktop `server --bridge/--serve` over a unix
  socket → the CLI `ccd-cli/<version>` with `--permission-mode=auto`. The CLI's settings deny
  Desktop's host-side MCP servers (computer-use, Claude in Chrome, browser, simulators, …), so no tool
  reaches the user's machine.
- **Sign-in: the user's Claude OAuth token is in the CLI's environment** (`CLAUDE_CODE_OAUTH_TOKEN`,
  plus account/org UUIDs and the user's email). The CLI and the agent's Bash run as the same user,
  so the agent **can read the token** from `/proc/<pid>/environ`. It is the same exposure as a Local
  session (where the agent can read the local credentials), but the container does not reduce it.
  Running the agent's tools as a different user than the CLI is not something Desktop offers.

- **T7 (external folder) — works.** "USB drive" stood for any folder outside the project. Any such
  folder behaves like `out/extra` above: it is a live read-write bind mount, the container writes
  through to the host, and nothing else on the host is visible.

- **T2 (link) — works.** `claude://code/new?ssh_host=poc-desk-debian&ssh_folder=%2Fwork%2Fsample`
  (via Win+R) opened a session through the `~/.ssh/config` alias, with a key Desktop did not generate.
  Inside: Debian 12, `/work/sample`, both skills, generated `~/.claude/CLAUDE.md` loaded, `/mnt/host/extra`
  present.
- **Dialogs on a link-opened session.** No host-key fingerprint dialog: the alias's pre-seeded
  `HostKeyAlias` + `UserKnownHostsFile` was enough. Desktop wrote nothing to any known_hosts file,
  whereas after the T1 fingerprint dialog it had added `[127.0.0.1]:2222`. What remains is Claude
  Code's **"Trust this workspace?"** for `<folder> on <alias>`, once per new host+folder. The trust is
  kept on the Desktop side: the container's `~/.claude.json` has no trust flag for `/work/sample`, so
  the tool cannot pre-accept it from inside the container.
- **T6 (Alpine) — connects.** The link opened the session with the environment, folder `sample` and
  "Worktree" unchecked pre-selected. Desktop downloaded a separate musl CLI build (125 MB).
- **T6 (Alpine) — works.** Alpine Linux, `musl libc (x86_64)`, `/work/sample`, both skills, the
  generated `~/.claude/CLAUDE.md` ("Host folders connected: none") loaded; no `/mnt/host` (none
  mounted). **The musl CLI sits under the same directory name as the glibc one**
  (`ccd-cli/2.1.330-3cc8a8679c34`), so a shared `~/.claude/remote` cache volume must be per libc
  (per base-image family), never shared between glibc and musl images.

- **Workspace trust is keyed by alias + folder.** A second alias (`poc-desk-debiantwo`) pointing to
  the same container, port, host key and folder asked "Trust this workspace?" again.

## Conclusions for the local sandbox tool

- The SSH environment meets both hard constraints: Claude Code runs inside the container, the host
  stays untouched, and only explicitly mounted folders are visible.
- One-click flow is feasible: the tool writes a `~/.ssh/config` alias with its own key and a
  pre-seeded known_hosts, then opens `claude://code/new?ssh_host=<alias>&ssh_folder=<path>`.
- The only remaining dialog is "Trust this workspace?", which Desktop keys by alias + folder. The tool
  can reuse a stable alias and in-container path per source folder, with one slot per parallel
  workstream, and rewrite only the port behind the alias. The BA then confirms once per folder and
  slot, not once per workstream.
- Non-git top folders and nested repos work (leave "Worktree" off). Project and user-level skills and
  a generated user-level `CLAUDE.md` all load.
- Cache `~/.claude/remote` (≈380 MB) in a volume per libc family to skip the per-workstream download.
- The user's Claude OAuth token is readable by the agent inside the container
  (`CLAUDE_CODE_OAUTH_TOKEN` in the CLI's environment). This is the same as a Local session, but it is
  an open decision: accept, or restrict the container's egress.
