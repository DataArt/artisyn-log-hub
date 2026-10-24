# Notes: 2026-10-23-big-test-recent-features

## 2026-10-23: chunk 1 PoC probes

PoC: [docs/pocs/2026-10-23-big-test-probes/](../../../pocs/2026-10-23-big-test-probes/README.md).
Its README has the full evidence. The setup was Claude Code 2.1.280 on Windows 11, hook 2.24.0 /
installer 1.0.76 from a local `build-hooks-installer.js --static-dir` tgz, and the dev server in
auth mode `none`. Throwaway `js-cli` / `ts-webapp` / `legacy-hook` copies lived in a workspace next
to the git root, with an isolated `CLAUDE_CONFIG_DIR`.

| Probe | Result | Design Decision |
|---|---|---|
| S8 quoting | The joined `--permission-mode default --allowedTools "Read" "Bash(node:*)"` string works through `shell: true` (cmd.exe). The node commands run without a prompt. | 14 **confirmed** (`permissionArgs` quoting as written) |
| S8 denial | The denied `Write` line has top-level `toolDenialKind: "user-rejected"` and `is_error: true`. Its text is "Claude requested permissions to write to …". The server keeps the field. The UI shows "⊘ rejected" with `title` "rejected by the user". `git status` is **not** denied (read-only git is auto-allowed), so the Bash fallback would not have worked. | 14 **confirmed**: `S8_DENIED = { tool:'Write', target:'denied.txt' }`. requirements.md FR-6 unchanged. |
| S9 | `-p` waits for the background agent. The notification is a main-thread `user` line with **string** content that starts with `<task-notification>` (plus `origin.kind = 'task-notification'`). The main thread makes a tool_use after it. The stream has 2 `result` + 2 `system/init` events. The last `total_cost_usd` equals the server's `telemetryCost`. | 10, 12 **confirmed** |
| S10 | Claude Code reads project settings only from `<cwd>/.claude/`. From `packages/web`, **no plugin, no hooks and no OTEL env**. `--settings "<file>"` (root settings + local `env`, marketplace path absolute) fixes it, and telemetry then lands in the main root's `ai_work_dir`. | 4 / 20 **changed**: S10/S11 get a per-session `--settings` file |
| S11 | A copied OTEL port gives the owner-mismatch warning (the 409), and the OTEL records go to the main checkout. A fresh port puts everything in the worktree's `ai_work_dir`. The sid is in `hook.log` (and attribution/analysis logs, `telemetry/<sid>.jsonl`). The main root's sweep can later upload worktree transcripts and log their sid in the main `hook.log`. | 20 **confirmed** (fresh port needed), 21 **confirmed** with an ordering constraint |
| Transcript cwd | The first two transcript lines are `queue-operation` lines without a `cwd`. | 12 **changed**: `cwd` = first entry that has one |
| FR-13 | Archive 0.5 s, `npm ci --ignore-scripts` 2.3 s (warm cache), old build 1.3 s. `installer-version.json` = `{"version":"2.21.1"}`, package version 1.0.69. The old tgz installs against the current server. Plugin `log-hub-hooks@artisyn-3b54378a` matches `ALLOWED_PLUGIN_SOURCE_RE`. `npx` with a bare `D:/…` tgz path **hangs**; a `file:` URL works. The old installer keeps `serverUrl` / `otelReceiverPort` in `log-hub.json`, `apiKey` only in `log-hub.local.json`, and the OTEL env in `settings.json`. | 16 **changed** (`file:` URL), 17 **confirmed** (regex unchanged) |

Side observations, not in scope:

- **Subdirectory sessions get no hook.** A user who starts Claude Code in a repo subdirectory
  gets no Log Hub hook at all, because the installer writes only the root `.claude/`. This is a
  possible product follow-up (installer / INSTALL_HOOK.md). It is not part of this task.
- **Late upload under the main root.** A worktree session that ran without the hook is uploaded
  later by the main checkout's sweep, under the main root.

## 2026-10-23: chunk 10 full run

Fast set (all `static` checks plus `npm run build`) green before the run. One full
`/big-prod-e2e-test` run: `log_hub_big_test-20261023-192004`, 36 min, **overall FAIL, exit 1**.
Every infra step passed (P5b built `25146c8`, installer 1.0.69 / hook 2.21.1). Passed: S3, S4, S5,
S6, S8, S9, L1; AC rows FR-LC, FR-UP, FR-OLD, FR-WT, FR-6 (P3 CLAUDE.md), FR-10 (completeness);
V2, V3, V4, V6, V7. Verdict fields: 71 pass, 2 fail, 0 skipped.

Every failed row, classified. No test-tooling bug was found, so there was no re-run.

| Failed row(s) | Class | Cause | Task |
|---|---|---|---|
| S1, S2, S7 (`not ingested`); FC / FR-FC1 / FR-FC2; V1; V5; FR-7 (P10) | **product defect** (hook) | `node-service` has `"type": "module"` in its root `package.json`. The CommonJS hook scripts in `<repo>/.artisyn/marketplace/plugins/log-hub-hooks/scripts/` have no `package.json` of their own, so Node treats them as ESM and every hook exits 1 with `require is not defined in ES module scope`. No `ai_work_dir/`, nothing uploaded. The 2026-10-20 run passed on the same fixture; its hooks ran from the plugin cache outside the repo. | [2026-10-24-post-e2e-test-bugs (was 2026-10-23-hook-esm-host-repo-crash)](../2026-10-24-post-e2e-test-bugs (was 2026-10-23-hook-esm-host-repo-crash)/requirements.md) |
| V8 | **product defect** (cascade of the row above) | The personal half passed: admin's My Repos lists no test repo. The direct-URL 403 half could not run, because S1 has no repo id (never ingested). | same task |
| S10 `bashPaths`, S11 `bashPaths` | **product defect** (client) | The Bash tab shows the FILES read and the command as `D:/…/ts-webapp/packages/core/src/index.ts`. `log-parser.ts` falls back to the first main-thread `cwd` (`packages/web`) as the display root when no `CLAUDE.md` path and no two-directory common prefix exist, so `toRepoRelative` leaves the path absolute. Design Decision 1's "the view never uses the session cwd" is wrong for this fallback; the check's expectation follows FR-8 and stays. Repo attribution (FR-WT) passed. | [2026-10-23-subdir-session-abs-paths](../2026-10-23-subdir-session-abs-paths/requirements.md) |

No infrastructure failures.

ACs the run could not prove, left unticked in requirements.md: FR-2 (S1 Bash tab) and FR-3 (S1
Context Growth), because S1 was never ingested; FR-4, because S2's System Context was never
verified (S5's passed). They need a re-run once the hook ESM defect is fixed. FR-5 is ticked on
nine `cost` passes; its fail and `skipped` branches are proved by the `judgeCost` table tests.
FR-10 is ticked on the V8 row and its personal half; the direct-URL half waits for the same re-run.
