# Notes: 2026-09-26 Session List Anomalies and OTEL Port Drift Fixes

## 2026-09-27 (moved from requirements.md Notes)

- 2026-09-26: OTEL root-cause details.
  - The second test checkout's receiver has run on 50962 since 2026-08-23 (`receiver.log`).
  - `:50280` sits in `.claude/settings.json`, which is **committed to git**. It was already in the
    `.bak` of the 2026-09-25 reinstall and in the initial commit.
  - `otel-port.json` is gitignored and per checkout. The allocator picks a **random** port per
    checkout (`allocateOtelPort`). So a committed settings file carries one checkout's port to
    every other checkout / machine / teammate, and fill-if-absent never corrects it. The exact
    origin of 50280 is unknown: no local `otel-port.json` has it.
  - Second cause: Claude Code 2.1.280 does not forward `OTEL_*` keys from the settings `env` block
    to hook processes (verified: `CLAUDE_CODE_ENABLE_TELEMETRY` arrives, no `OTEL_*` key does).
    So `resolveOtelPort`'s endpoint-wins rule and its mismatch `warn` in `env-context.js` are dead
    in practice, and the receiver always binds `otelReceiverPort`. The old comment in
    `lifecycle-hook.test.js` claiming the env is exposed was wrong and has been corrected.
  - Design follow-up for FR-6: consider writing the OTEL `env` block to the gitignored
    `.claude/settings.local.json` (same per-checkout scope as `otel-port.json`), or reusing an
    existing loopback endpoint port as the allocation when `otel-port.json` is absent.
  - Extra finding: `hook.log` rotates at ~100 KB × 3 files, which is only ~3 minutes of history
    in an active session, so diagnostics vanish almost immediately.
- 2026-09-26: **FR-7 implemented (hook 2.18.0)**.
  - New `hook/.claude/telemetry_tool/otel-endpoint-check.js`, called from `lifecycle-hook.js`
    on `SessionStart` when `otelEnabled`. It reads the effective endpoints from
    settings.local → settings → `~/.claude/settings.json` → process env. A missing endpoint, or a
    loopback endpoint on a port other than the receiver's, gives a `hook.log` `warn` plus a
    `systemMessage`. Non-loopback collectors are ignored. It never rewrites anything.
  - Tests: `__tests__/otel-endpoint-check.test.js` (9) and 2 new cases in
    `lifecycle-hook.test.js`.
  - Bundled via `HOOK_JS_FILES` in `scripts/build-hooks-installer.js`. Installer bumped to
    1.0.61. Dogfood copy refreshed. INSTALL_HOOK.md and the KB `hook-installation.md` updated.
