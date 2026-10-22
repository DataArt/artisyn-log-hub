# Sandbox container guide (managed policy)

You are running inside a log-hub dev sandbox: a Docker container started by
`scripts/claude-docker.mjs` on the developer's host. These rules take priority over the repository
`CLAUDE.md` wherever they diverge; everything else in the repository `CLAUDE.md` still applies.

## 1. Environment

- The OS is **Linux** and the shell is **bash**. Use POSIX paths and bash syntax. There is no
  PowerShell, no `cmd.exe` and no Python. Where the repository `CLAUDE.md` says "NodeJS or
  PowerShell", use Node.js or bash here.
- Your working directory is this sandbox's own git worktree (`$SANDBOX_WORKTREE`) on **its own
  branch**. The main checkout is not mounted; never try to reach it. The developer merges your
  branch from the host.
- The sandbox has its **own** dev stack, and it is **already running**:

  | Service | Inside the container | Notes |
  |---|---|---|
  | Backend (`npm run start:dev` in `server/`, watch mode) | `http://localhost:3000` | `server/.env`: `AUTH_MODE=none` |
  | Client (`bun run dev` in `client/`) | `http://localhost:5173` | proxies `/api` to the backend |
  | Mailpit | SMTP `127.0.0.1:1025`, UI `http://localhost:8025` | |
  | Postgres | `localhost:5432` | forwarded to the shared host cluster |

  - The live DB is `$DATABASE_URL` (`log_hub_<name>`); the test DB is `$TEST_DATABASE_URL`
    (`log_hub_<name>_test`). Both belong to this sandbox only.
  - The `postgres` MCP server points at this sandbox's live DB.
  - The hook is provisioned: Claude sessions in this sandbox are reported to this sandbox's own
    Log Hub (identify in the browser with the developer's git email to see them).
- **Manage the services with `devctl`; never start a second copy.** Do not run
  `npm run start:dev`, `bun run dev` or `mailpit` yourself, even when the repository `CLAUDE.md` or
  a skill says to start the server or client — they are already up. Use:

  ```bash
  devctl status all                   # pid + health probe of every service
  devctl restart server               # server | client | mailpit | provision | all
  devctl logs server                  # tail -n 200 -f /var/log/dev/server.log
  devctl stop client && devctl start client
  ```

  Logs live in `/var/log/dev/<service>.log` (`install.log` holds the `node_modules` installs).
- `node_modules` of the root, `client/`, `server/`, `hook/` and `artisyn-hooks-installer/` are
  installed at container start from the lockfiles. After you change a lockfile, run the matching
  install yourself (`npm ci` in that dir, `bun install --frozen-lockfile` in `client/`), then
  restart the affected service.

### Images pasted from the host (`/host-tmp`)

Images pasted with Ctrl+V arrive as **Windows paths** in the host temp directory, for example
`C:\Users\<user>\AppData\Local\Temp\clipboard-123.png`. The host temp directory is mounted
read-only at `/host-tmp`, and `$HOST_TEMP` holds its host path.

To open such a file, replace the `$HOST_TEMP` prefix with `/host-tmp` and turn backslashes into
forward slashes:

```bash
# HOST_TEMP=C:\Users\me\AppData\Local\Temp
# C:\Users\me\AppData\Local\Temp\shots\a.png  ->  /host-tmp/shots/a.png
win='C:\Users\me\AppData\Local\Temp\shots\a.png'
rel="${win#"$HOST_TEMP"}"; rel="${rel//\\//}"; echo "/host-tmp${rel}"
```

The prefix comparison is case-insensitive on Windows; if the path does not start with `$HOST_TEMP`,
the file is not reachable from the sandbox — ask the user to copy it into the worktree instead.

## 2. Rules

- **The full test set runs here.** Build, lint, typecheck and every test check of the repository
  `CLAUDE.md` table — including the final-only `contract`, `scenarios-a`/`-b`/`-c`, `e2e-fast` and
  `e2e-full` — run inside the sandbox against its own DB. The scenario and contract runners use
  `$TEST_DATABASE_URL` (precedence `TEST_DATABASE_URL`, then `DATABASE_URL`), so they never touch
  the live DB of the running backend; legacy e2e drives the running dev app on `$DATABASE_URL`.
  Use exactly the commands of the repository `CLAUDE.md` table.
- **Test timeouts are ×5 here** (`LOG_HUB_TEST_TIMEOUT_SCALE=5`): the worktree sits on a slow
  host file-sharing bridge, so UI waits are slower than on the host. A test that passes only with
  the longer timeouts is fine here; do not shorten or "fix" timeouts because of the sandbox.
- **Legacy e2e (`e2e-fast`, `e2e-full`)** expects its user `muaddib@arrakis.test` to be an admin.
  Provisioning promotes it automatically once the backend is up (see `devctl logs provision`,
  line `e2e admin: …`). The admin-panel specs also expect at least one repository, which the
  hook upload of this session creates. If the e2e global setup still fails with
  `GET /admin/repos failed (403)`, check the provision log before anything else.
- **The build and the e2e/contract suites never run concurrently** (the `app` group of
  `.claude/repo_config/repo-health-checks.json`). `npm run build` rewrites
  `server/src/public/static/*`, which the watch-mode backend reloads on: a build during an e2e run
  drops the backend mid-suite. Run them one after another, never in parallel, and never alongside
  the scenario stand build.
- **Docker is not available** from inside the container (there is no Docker socket). Do not try to
  run `docker`/`docker compose`; Postgres and Mailpit are already provided (see section 1). Skip
  any step that needs Docker and say why.
- **The WebStorm MCP server and the `web-storm-mcp` skill are unavailable.** Ignore instructions
  that require WebStorm. Use the Read/Edit/Grep/Glob tools for code, and the `typescript-lsp`
  plugin for symbol navigation, references and diagnostics.
