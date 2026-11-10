# PoC: hook + installer on Node 18.19 / 20 / 22

Task: [2026-11-09-morning-check-followups](../../tasks/todo/2026-11-09-morning-check-followups/requirements.md), item 6 (FR6 / AC6).

## Question

Do the current hook installer (`artisyn-hooks-installer`, `engines >=18.19`, v1.0.95) and the hook
scripts (bundled hook 2.31.1) still install and run on Node 18.19 and 20? What is the cheapest
repeatable check, and where should a "move to Node 22+" warning live?

## How to run

Needs Docker and a built installer tarball at `server/src/public/static/artisyn-hooks-installer.tgz`
(`npm run build:hooks-installer`). From this folder:

```
node static-scan.mjs              # grep sources for Node APIs newer than 18.19
node run.mjs                      # 18.19, 20, 22 (or: node run.mjs 18.19 24)
```

`run.mjs` starts `node:<ver>-slim` with the repo mounted read-only (`--rm`), and runs
`in-container.mjs` there: `npm install -g` the installer tgz, `artisyn-hooks install --server-url
http://127.0.0.1:9 --api-key poc-key --otel-traces=no --otel-existing=keep` in a temp git repo,
`node --check` every installed script, then pipes a sample payload into every command of the
installed `hooks.json` (no Log Hub server reachable), waits 8 s for detached workers and scans the
hook logs for `TypeError`/`ReferenceError`/`SyntaxError`. Logs go to `out/` (ignored).

## Result

**Works on 18.19 and 20.** No incompatibility found.

```
SUMMARY v18.19.1: 21/21 passed  [exit 0]
SUMMARY v20.20.2: 21/21 passed  [exit 0]
SUMMARY v22.23.4: 21/21 passed  [exit 0]
```

- npm install: no `EBADENGINE` on any version; installer exit 0; 43 installed scripts pass `node --check`.
- All 17 hook commands (SessionStart, UserPromptSubmit, PreToolUse/PowerShell, PostToolUse(+Failure),
  Stop x2, SessionEnd x2, Permission*, Subagent*, Pre/PostCompact, PostToolBatch, StopFailure) exit 0
  in 28-233 ms with the server unreachable; hook logs contain no thrown errors.
- `static-scan.mjs`: 53 files, 0 hits for post-18.19 APIs (glob, getBuiltinModule, import.meta.dirname,
  groupBy, toSorted, styleText, AbortSignal.any, WebSocket, node:sqlite, ...).

### Where a warning lives

- Installer: `artisyn-hooks-installer/src/install.ts` — next to the existing
  `warnIfClaudeCodeLikelyRunning()` calls at lines 958 (install), 1186 and 1266 (upgrade/uninstall),
  helper defined at line 2412. A sibling `warnIfNodeEol()` (parse `process.versions.node`, major < 22)
  fits this pattern; or once in `src/index.ts` before the subcommand dispatch (~line 124).
- Docs already say it: `user-docs/getting-started.md:8`, `user-docs/connect-repository.md:9`,
  `hook/INSTALL_HOOK.md:9-16`. Not mentioned: `hook/README.md`, `release-template/INSTALL.md` /
  `LOCAL-BUNDLE.md` (no Node line at all).

### Verification for AC6

`node run.mjs 18.19 20 22` (~1-2 min per version, mostly apt-get git). The `/big-prod-e2e-test` skill
already has a P5c "Node LTS" phase in Docker, but it only covers live LTS lines and costs 30-90 min;
adding 18.19 there or keeping this runner is the cheap repeatable option.
