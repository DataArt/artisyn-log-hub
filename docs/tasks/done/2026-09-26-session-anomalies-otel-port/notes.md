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

## 2026-10-21 (moved from requirements.md Finding 5)

- At audit time the installer's fill-if-absent endpoint behaviour was pinned by the test
  `--otel-port on a re-install moves the store but leaves the endpoints the user already has`
  (`artisyn-hooks-installer/src/__tests__/install.test.ts` ~L2241). That test file no longer exists.

## 2026-10-21 — re-review against live data and current code

Triggered by the question "in this project's own repo the Workflow badge and the OTEL cost are
fine — what is left to fix?". Checked a `/adlc-lh:review-deep` session of this project's own repo
(hook 2.22.0) plus the DB and current `main`.

- Why that session looks fine: it has one real `Workflow` `tool_use` (true positive), and this
  checkout's `.claude/settings.json` endpoints, `otel-port.json` and `log-hub.json` all use the same
  port, so Finding 5 cannot occur there.
- FR-1: live, 3 of this repo's 14 root sessions are badged; the old `body::text LIKE` would badge 13
  (13 contain `prompt_snapshot`).
- The audited repository: before 2026-09-27, 50 root sessions, 48 with a transcript, all 48 matched
  the old `LIKE`, 12 had a real Workflow call, 0 had OTEL data. Through 2026-10-19, 258 of 258 root
  sessions have `telemetry_cost` / `claude_version_otel` NULL. The second checkout still points at
  `:50280` while `otel-port.json` says 50962, and runs hook 2.17.4 (no FR-7 warning).
- FR-5: 13 audited-repo sessions have more than 1 h idle before the first prompt (worst 11 h 15 m);
  this repo has one session starting 14:16 with the first prompt at 17:13.
- FR-2 audit (patterns per Common sense considerations, over `server/src`, `client/src`,
  `hook/.claude/telemetry_tool`): no `body::text LIKE`/`ILIKE`, no `JSON.stringify(...).includes`,
  no raw-blob `.includes`/`.match`. Remaining hits are harmless:
  - `octet_length(body::text)` — size calculations only.
  - `otel-cost.sql.ts:258` — `LIKE` on the structured `query_source` column.
  - `repositories.controller.ts:557,1071` — `@> '[{"event":"hook_service"}]'` on artisyn bodies.
  - `log-parser.ts:247-249,2358,2910`, `session-usage-derive.ts:84` (first 200 chars of a
    `tool_result`), `session-list-helpers.tsx:94`, `report-url.ts:83`, `attribute-filter.sql.ts:64`
    — structured fields or filter values.
  Conclusion: the old badge query was the only raw-text detector; nothing else changes.
- FR-3 metrics: server reads attachments only by explicit type (`claude-extractor.ts:733-736`
  `nested_memory`, `turn-walk.ts:446` deferred delta); client loops in `log-parser.ts:957,2634-2697`
  are each gated on their own type. None of the seven new types feeds a metric.
- FR-3 prototype (`deferred_tools_record`), dev DB, Claude Code 2.1.280: `deferred_tools_record`
  594 events / 368 sessions, `deferred_tools_delta` 437 events / 369 sessions; 0 record-only
  sessions, 1 delta-only. A distinct additive type, not a replacement. 2.1.300 emits it too.
- Corpus: `known-format.json` already lists `atis-latch`, `cost-state`, `prompt_snapshot`,
  `remote_session_change`, `total_tokens_reminder`; missing `silent_turn_reminder`,
  `deferred_tools_record` (no local set contains them, so `--approve` cannot add them).
