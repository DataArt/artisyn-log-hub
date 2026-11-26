---
type: "PoC"
title: "Devcontainer laptop layer (AgentBook)"
description: "How AgentBook layers sshd onto any devcontainer (image, Dockerfile, compose) and delivers variables to SSH sessions, verified on Debian, Alpine and compose."
---

# PoC: devcontainer laptop layer

Task: [2026-11-25-local-sandbox-tool](../../tasks/todo/2026-11-25-local-sandbox-tool/requirements.md)

## Question

How does AgentBook put its laptop layer (sshd + sftp + session wrapper) on top of an arbitrary devcontainer and
apply the devcontainer's create-time settings "as `devcontainer up` would" (FR-4, FR-7, FR-12)? In particular:

1. Can the layer be a devcontainer Feature injected from outside the project folder?
2. Does sshd start from a wrapper entrypoint that survives `docker restart`, and does the host key stay the same?
3. Do lifecycle commands run (once), and do Dockerfile-, image- and compose-based configs all work?
4. Can variables (Hidden ones included) reach every SSH session without being written to disk?
5. Does the Docker Engine API (named pipe) accept a Windows path with spaces / non-ASCII as a bind source?
6. Can attached sessions be counted with nothing but `sh` and `cat` in the image?

## How to run

```
npm install
node run.mjs --variant debian     # Dockerfile-based config, extra tool (jq), non-root SSH user
node run.mjs --variant alpine     # image-based, remoteUser root, custom workspaceMount/workspaceFolder
node run.mjs --variant compose    # compose-based (app + db sidecar); set COMPOSE_PROJECT_NAME to isolate
node run.mjs --api-bind           # Engine API over the current context's named pipe, Windows bind path
node run.mjs --down               # remove containers/volumes labelled poc=dc-laptop
```

Needs Docker Desktop (or another engine with the `docker` CLI) and Windows OpenSSH.

## Result

1. **A Feature from outside the project does not work.** `@devcontainers/cli` 0.91.0 accepts a local Feature
   only as a `./` path inside the project's own `.devcontainer/` ("Resolved path must be a child of the
   .devcontainer/ folder"); absolute paths are parsed as OCI refs and fail. The tool must not write into the
   user's folder, so the layer is **not** a Feature.
2. **What works: build → layer → up.**
   - `devcontainer build --workspace-folder <shared> --image-name <eq-image>` builds the project's Equipment
     (Dockerfile + features) unchanged. Its `devcontainer.metadata` label already carries the config's
     lifecycle commands, `containerEnv`, `remoteEnv`, `remoteUser`.
   - The tool builds `FROM <eq-image>` a small layer (`laptop-layer/`: one POSIX `install.sh` for apt and apk),
     and re-labels `devcontainer.metadata` = base array + `{"entrypoint": "/usr/local/share/agentbook/entry.sh"}`.
   - `devcontainer up --workspace-folder <shared> --override-config <generated> --id-label …` with a generated
     config that holds **only** what the label does not: `image` (the layered one), `workspaceMount` /
     `workspaceFolder`, the project's `runArgs` + the tool's (`-p 127.0.0.1:<port>:22`, `--tmpfs /run/agentbook`,
     labels) and the tool's `mounts` (home volume, key dir read-only, given folders). Repeating label-carried
     keys runs `postCreateCommand` twice (observed: 2 lines, then 1 after the fix).
   - The CLI chains the label's entrypoint into the container command
     (`/bin/sh -c "…; /usr/local/share/agentbook/entry.sh; exec "$@"; …"`), so sshd starts again after
     `docker restart`; `postStartCommand` ran again too.
   - Compose: the generated config keeps the project's compose files and appends a tool compose file that sets
     the primary service's `image`, `ports`, `tmpfs`, `volumes` and labels; sidecars still start.
     `COMPOSE_PROJECT_NAME=<per-laptop>` gives each laptop its own compose project (`agentbook-l2-app-1`,
     `agentbook-l2-db-1`); without it two laptops of one folder would share `<folder>_devcontainer`.
   - Without an explicit `workspaceMount`, the CLI's default mounts the enclosing **git root**, not the chosen
     folder (`read-configuration` reported `/workspaces/<git-root-name>/…/sample-debian`), so the tool always
     sets `workspaceMount` itself unless the project does.
   - Timing: Debian build 10.4 s + layer 45.7 s first time; cached rebuild 1.3 s + 0.9 s, `up` ≈ 1.8 s.
3. **sshd details.** The host key and `authorized_keys` come from a read-only bind (`/opt/agentbook/key`) and
   are copied by `entry.sh` to `/run/agentbook` (tmpfs) with mode 0600/0644. The tmpfs is created 1777, which
   sshd `StrictModes` rejects ("bad ownership or modes for directory /run/agentbook") — `entry.sh` must
   `chmod 755` it. Key-only login, password refused, root with `prohibit-password` worked on Alpine.
4. **Variables.** sshd `ForceCommand /usr/local/share/agentbook/session.sh` sources
   `/run/agentbook/env/session.env` (tmpfs, dir and file owned by the SSH user, 0700/0600) with `set -a`, then
   `exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"` or a login shell. `ssh` exec saw `JIRA_PAT=s3cr3t 'quoted' $x`
   exactly; `sftp` still worked through the wrapper (subsystem command passed via `SSH_ORIGINAL_COMMAND`). The
   file is written by `docker exec -i … sh -c 'cat > tmp && mv tmp session.env'` from stdin: no value on the
   command line, on the host disk or in a volume, and it is gone when the container stops.
5. **Engine API bind.** `POST /containers/create` over the current context's pipe with
   `Binds: ["<windows path>\\given Ж:/work/given/given Ж"]` worked as-is; no Docker-Desktop path mapping (as in
   Work Hub's in-container `default_engine_path`) is needed for a host-side client. Files written by root in the
   container were deletable from the host without admin rights.
6. **Session count.** `docker exec <c> sh -c 'cat /proc/net/tcp /proc/net/tcp6'`, counting state `01` with
   local port `:0016`: 1 with one `ssh` held open, 0 after it closed.

Not covered here: the real Claude Desktop through the `ForceCommand` wrapper (the earlier PoC
`docs/pocs/2026-11-25-1743-desktop-ssh-container/` covered Desktop without a wrapper); it is part of the task's
acceptance checks (AC-7a, AC-16).
