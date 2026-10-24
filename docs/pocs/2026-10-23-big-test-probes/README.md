# Big-test probes: Claude Code `-p` behaviour for S8–S11 and the FR-13 legacy hook

Task: [2026-10-23-big-test-recent-features](../../tasks/todo/2026-10-23-big-test-recent-features/requirements.md)
(chunk 1 of [impl-plan.md](../../tasks/todo/2026-10-23-big-test-recent-features/impl-plan.md)).

## Questions

1. **S8**: does `claude -p --permission-mode default --allowedTools "Read" "Bash(node:*)"` work as a
   joined `shell: true` command string? Does a denied `Write` carry `toolDenialKind`, and how does
   the UI mark it? (Design Decision 14)
2. **S9**: does `-p` wait for a background Agent's `<task-notification>`? What shape does that
   entry have? Does the stream have more than one `result` event? (Design Decisions 10, 12)
3. **S10/S11**: from `packages/web` of ts-webapp, and from the same subdirectory of a linked
   worktree with `ARTISYN_PROJECT_ROOT`: do the project settings and the plugin load? Does a copied
   OTEL port give `409 owner-mismatch`? Which `ai_work_dir` file holds the session id? (Design
   Decisions 4, 20, 21)
4. **FR-13**: how long do `git archive 25146c8`, `npm ci --ignore-scripts` and the old
   `build-hooks-installer.js --static-dir` take? What is in `installer-version.json`? Does the old
   tgz install against the current server? Does its plugin id match `ALLOWED_PLUGIN_SOURCE_RE`?
   (Design Decisions 16, 17)

## How to run

Everything runs from this folder. The probes reuse the big-prod-e2e-test skill libs (`copyFixture`,
`gitSetup`, `childEnv`, `prepareClaudeConfig`, `runAsync`). Sessions spawn `claude -p` the same way
`sessions.mjs` does. Each session costs a few cents of haiku.

1. Start the dev server (`npm run start:dev` from `server/`, auth mode `none`).
2. Create a probe user and an API key, and put them into the ignored `.env`:

   ```
   POC_SERVER_URL=http://localhost:3000
   POC_API_KEY=<key from POST /api/v1/api-keys after POST /api/v1/auth/identify>
   ```

3. Build the current installer into the ignored `static/`:
   `node ../../../scripts/build-hooks-installer.js --static-dir static` (run from this folder, or
   `node scripts/build-hooks-installer.js --static-dir docs/pocs/2026-10-23-big-test-probes/static`
   from the repo root). This never rewrites `server/src/public/static`.
4. `node setup.mjs`: creates `../../../../big_test_probes-<stamp>/` next to the git root (never
   inside it). It holds an isolated `_claude-config/` and throwaway `js-cli` and `ts-webapp` repos
   with the hook installed.
5. `node probe-s8.mjs`, `node probe-s9.mjs`, `node probe-s10-s11.mjs`, `node probe-s10-control.mjs`,
   `node probe-s10-settings.mjs`, `node probe-s11.mjs` (needs the worktree from `probe-s10-s11.mjs`),
   `node probe-fr13.mjs`.
6. Raw output goes to the ignored `results/`. That covers streams, the extracted JSON and the
   workspace path. Afterwards stop the `otel-receiver.js` processes under the workspace and delete it.

## Result (2026-10-23, Claude Code 2.1.280, Windows 11, hook 2.24.0 / installer 1.0.76)

### S8: permission mode and denial

- **The quoting works.** The joined string
  `claude -p … --permission-mode default --allowedTools "Read" "Bash(node:*)"` went through cmd.exe
  as intended. `init.permissionMode` was `default`, and `node --version` and
  `node -e "process.exit(3)"` ran without a prompt.
- **The denied `Write`** result line has a top-level `"toolDenialKind": "user-rejected"`, and its
  tool_result has `is_error: true`. The text is
  `Claude requested permissions to write to <abs path>, but you haven't granted it yet.`
- **The other calls.** `node -e "process.exit(3)"` gives `is_error: true` with text `Exit code 3`
  and no denial kind. The final `result` event lists the Write in `permission_denials`.
- **The UI.** The server keeps `toolDenialKind` (it is in `GET …/sessions/<sid>/logs`).
  `tool-outcome.ts` maps any non-empty `denialKind` to `rejected`. `StatusBadge.tsx` shows
  **"⊘ rejected"** with `title` "rejected by the user".
- **No Bash fallback.** `git status` was **not** denied: read-only git runs without a prompt in
  `default` mode, so it would not have worked as a fallback anyway. → `S8_DENIED = { tool:'Write', target:'denied.txt' }`.

### S9: background agent

- **`-p` waits.** It waits for the background agent, then runs the turn the notification
  triggers. Exit is 0 after about 19 s.
- **The notification entry** is a main-thread `user` line whose `message.content` is a **string**
  that starts with `<task-notification>`. The line also has `origin: { kind: 'task-notification' }`.
- **Main-thread work after it.** After the notification, the main thread made a `Read` tool_use
  (`toolUseAfterNotification` = true). The last main-thread assistant entry came 15.4 s after the
  first user entry.
- **Stream events.** The stream has **two** `result` events and **two** `system/init` events. Both
  `result` events carry the same `total_cost_usd` (0.049416), and that equals the server's
  `costBreakdown.telemetryCost` for the session (0.049416). `parseStream` takes the first init
  and the last result, which is correct.

### S10/S11: subdirectory and worktree

- **Settings load only from `<cwd>/.claude/`.** Claude Code 2.1.280 reads the project
  `settings.json` / `settings.local.json` only there. A session started in `packages/web` loads
  **no `log-hub-hooks` plugin, no hooks and no OTEL env**. The debug log only looks for
  `packages/web/.claude/settings*.json`. The control session from the repo root does load the
  plugin.
- **Two working fixes.** Both were tested from `packages/web`; with either one the plugin loads,
  `SessionStart` fires and telemetry lands in the **main** root's `ai_work_dir`, because the hook
  resolves the root via `--git-common-dir`:
  - (a) `--settings "<file>"`, where the file is the root `settings.json` plus
    `settings.local.json` `env`, with the marketplace `path` made absolute;
  - (b) a `packages/web/.claude/` copy with the marketplace path `../../.artisyn/marketplace`.

  (a) is chosen: it writes nothing into the repo.
- **Worktree with `ARTISYN_PROJECT_ROOT`.** With the main checkout's port copied, `otel-register.js`
  logs `[warn] the OTEL receiver on port <p> belongs to another project` (the 409 owner-mismatch),
  and the OTEL records go to the **main** checkout's `ai_work_dir`. With a freshly allocated port,
  every file is in the **worktree's** `ai_work_dir` and none in main's.
- **Where the session id lands.** It is in `hook.log`, `attribution.log`, `analysis.log`,
  `harness-state.json`, `telemetry/<sid>.jsonl`, `telemetry/otel/<sid>/` and
  `telemetry/.claude-logs.sent`.
- **Sweep caveat.** The main checkout's Stop-hook sweep uploads linked-worktree transcripts that
  are not yet in *its own* `.claude-logs.sent` (`session-files.js` `findProjectSlugDirs` prefix rule
  + `transcriptBelongsToRepo`). It logs `claude/<sid>.jsonl: uploaded` in the **main** `hook.log`.
  This happened here to worktree sessions that ran without the plugin. So any ts-webapp main-root
  session after S11 can put S11's sid into main's `hook.log`.
- **The transcript cwd.** The first two transcript lines are `queue-operation` entries without a
  `cwd`. The first `user` line has the real cwd (`…\ts-webapp-wt\packages\web`).
- **The worktree has no `.claude/`.** When the fixture tracks nothing under `.claude/`, the
  worktree checkout has no `.claude/` dir, so create it before copying the settings.

### FR-13: previous-release installer

- **Timings.** `git archive 25146c8 | tar -x` took 0.5 s, `npm ci --ignore-scripts --no-audit
  --no-fund` 2.3 s (warm npm cache; node_modules is 72 MB) and the old
  `build-hooks-installer.js --static-dir` 1.3 s. All exited 0.
- **Versions.** `installer-version.json` is `{"version":"2.21.1"}`, and
  `git show 25146c8:artisyn-hooks-installer/package.json` gives `1.0.69`.
- **`npx` with a bare Windows path hangs.** `npx --yes "D:/…/artisyn-hooks-installer.tgz" install …`
  hangs with no output until it is killed, and so does `--help`. A relative path is resolved
  against the npm workspace root. The **`file:` URL** (`pathToFileURL(tgz).href`) works.
- **The old installer.** It installs against the current server: exit 0, "Hooks installed", and
  two warnings (a running Claude process, API key on the command line). It writes `serverUrl` and
  `otelReceiverPort` into the tracked **`log-hub.json`**, and only `apiKey` into
  `log-hub.local.json`. The OTEL env goes into `.claude/settings.json` (there is no
  `settings.local.json`).
- **The session.** Plugin `log-hub-hooks@artisyn-3b54378a` version 2.21.1 **matches**
  `ALLOWED_PLUGIN_SOURCE_RE`. The hooks fire, and the transcript, OTEL and artisyn files upload to
  the current server.
