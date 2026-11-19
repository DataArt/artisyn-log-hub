# PoC — Log Hub hook installer run non-interactively by Work Hub

Task: [2026-11-14-workhub-workspace-templates](../../tasks/todo/2026-11-14-workhub-workspace-templates/requirements.md) (FR-5c, FR-5d, FR-5e)

## Question

Work Hub runs `npx <url>/static/artisyn-hooks-installer.tgz install --server-url <url> --api-key <key>`
inside the workspace container (default image), via `docker exec` with no stdin and no TTY, as the
container user in `/workspace/repo`, right before the initial commit.

1. Does it finish (no hang) and actually install, with and without a `.claude/` folder in the repo?
2. What does a failure look like for an unreachable server / a URL that is not a Log Hub, how long
   does it take, and how can Work Hub tell "couldn't be reached" from "install failed"?
3. Where does the API key end up (git, installer output, home volume)?
4. Is `git status` clean after `git add -A` + commit? Does the installer leave a process behind?

## How to run

From this folder, with Docker running, the Work Hub default image built and the Log Hub installer
built (`npm run build:hooks-installer` at the repo root writes it to `server/src/public/static/`):

```sh
node serve.mjs ../../../server/src/public/static 18731     # in another terminal: fake Log Hub /static
node run.mjs artisyn-work-hub-default:0.1.0-alpha.1 18731  # all cases; add a case prefix (e.g. E) to run one
```

Each case gets a fresh container (`--add-host host.docker.internal:host-gateway`), a `git init`ed
`/workspace/repo` with a `.gitignore`, and the installer run as
`docker exec -e LH_URL -e LH_KEY … sh -c 'npx --yes "$LH_URL/static/…tgz" install --server-url "$LH_URL" --api-key "$LH_KEY"'`.
Output lands in `results/` (ignored).

## Result

Run 2026-11-14, installer 2.32.1 (hooks v2.32.1), image `artisyn-work-hub-default:0.1.0-alpha.1` (Node 26.13.1, npm 11.20.0).

| Case | Setup | Exit | Time | Outcome |
|---|---|---|---|---|
| A | no `.claude/` in repo | **0** | 1.1 s | **Nothing installed.** Prints `.claude/ directory not found. Create it now? [Y/n]`, readline hits EOF on the closed stdin, the promise never resolves and Node exits 0. Silent false success. |
| B | `.claude/settings.json` = `{}` | 0 | 2.0 s | Installed; `✓ Hooks installed successfully!`, OTEL receiver verified; ~40 tracked files under `.artisyn/` and `.claude/`; key only in gitignored `.artisyn/config/log-hub.local.json`; `git status` clean after `git add -A` + commit. |
| C | refused port | 1 | **70.4 s** | `npm error code ECONNREFUSED` … `request to <url>/static/artisyn-hooks-installer.tgz failed` (npm's default fetch retries). |
| D | unknown host | 1 | **71.6 s** | `npm error code ENOTFOUND` … `getaddrinfo ENOTFOUND`. |
| E | as B + quiet npm env | 0 | 2.0 s | Same as B; key nowhere under `$HOME`. |
| F | refused + quiet npm env | 1 | 0.4 s | `npm error code ECONNREFUSED`. |
| G | live server, wrong path (not a Log Hub) + quiet npm env | 1 | 0.3 s | `npm error code E404` … `404 Not Found - GET <url>/static/artisyn-hooks-installer.tgz`. |

"Quiet npm env" = `npm_config_fetch_retries=0`, `npm_config_logs_max=0`, `npm_config_update_notifier=false`.

Conclusions:

1. **The repo must contain `.claude/` before the installer runs**, otherwise the run is a silent
   no-op with exit 0. The Claude Code template ships `.claude/settings.json` (`{}`); the installer
   merges into it and the result is committed.
2. **Unreachable vs failed install**: on a download failure npm exits non-zero with stderr lines
   `npm error code <CODE>` where `<CODE>` is one of `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`,
   `ETIMEDOUT`, `ECONNRESET`, `EHOSTUNREACH`, `ENETUNREACH`, `E404` (or any `E4xx`/`E5xx`), and the
   message mentions `/static/artisyn-hooks-installer.tgz`. Any other non-zero exit is an installer
   failure. With npm's default retries an unreachable server costs ~70 s; `npm_config_fetch_retries=0`
   makes it < 1 s.
3. **Key exposure**: the installer never prints the key (only "API key was passed on the command
   line" on stderr). With default npm settings the key lands in `~/.npm/_logs/*-debug-0.log` (npm
   logs argv) in the home volume; `npm_config_logs_max=0` stops that. Passing the key through the
   exec env (`-e LH_KEY`) and `"$LH_KEY"` in `sh -c` keeps it out of the argv Work Hub builds/logs;
   inside the container it is still visible in the npx/node argv while it runs (accepted: the
   container is the user's own).
4. `git status --porcelain` is empty after `git add -A` + commit; the installer adds its own
   `.gitignore` entries for its local files. No `node` process is left running after the exec
   returns.
5. In non-TTY mode the installer does not contact the server to validate the key (its connection
   check is TTY-only), so a wrong key is not detected at create time — consistent with FR-5c
   ("validation is the installer's job").
