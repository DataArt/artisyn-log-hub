# Analysis for the plan (2026-11-18)

## Hand-off cost and job claim — PoC

PoC: `docs/pocs/2026-11-18-1933-upload-handoff-cost/` (README has the numbers).

- Hand-off hook process (node start + full `send-logs-hook.js` module graph + heartbeat read +
  tmp/rename job write + detached spawn): p50 46 ms, p95 63 ms wall on Windows 11 / Node 26.13.1.
  The ≤ ~200 ms budget holds with ~3× headroom; the only thing that must leave the hand-off path is
  the `maybeReArmOtelSession` handshake (up to `HELLO_TIMEOUT_MS` 2000 + `REGISTER_TIMEOUT_MS` 2000).
- `spawn(..., {detached, windowsHide}).unref()` costs 4.0 ms p50 / 7.4 ms max, so spawning a
  receiver from the hand-off path fits.
- **Claiming a job by `rename` is not exclusive on Windows**: 8 racers × 50 jobs gave 45 and 174
  duplicate successful claims in two runs. An exclusive-create claim file (`'wx'`) gave 0 duplicates
  in 5 rounds. Rename is used only for the single-writer atomic job write.
- `fs.watch` sees a tmp + rename job in < 1 ms; a slow poll stays as a backstop.

## FR-11 — post-turn analysis ordering

- `post-turn-analysis-hook.js` is a separate `Stop` hook entry (`scripts/build-hooks-installer.js:357-366`);
  Claude Code runs both `Stop` commands in parallel, so its worker's
  `GET /api/v2/post-turn-analysis/config` (`post-turn-analysis-worker.js:2041`) already races the
  upload today.
- The worker already handles a not-yet-ingested session: `aggregate === null` or
  `hasTelemetry: false` → local derivation from the transcript (`post-turn-analysis-worker.js:1631-1671`).
- The advisor POST stores a `not-ingested` session like `ok`
  (`server/src/logs/turn-end-cost-advisor/turn-end-cost-advisor.service.ts:233-266`).
- Conclusion: no code change is needed for FR-11; the receiver picks a `stop` job up within
  milliseconds (`fs.watch`), which keeps the race no worse than today. Only the docs that claim a
  strict "upload before analysis" ordering change (`hook-system-overview.md` § "Order within a
  `Stop` run", `turn-end-cost-advisor.md` § "Sessions not yet ingested").

## User decisions during planning (chat, 2026-11-18)

- Fallback in-process `Stop` stays as today (no overall time budget): "они все обновят" — everyone
  upgrades to 3.0.0, so the fallback is rare.
- But when there is no connection at all the upload must give up within 3–5 s: a 3 s connect
  timeout per request, and the first "server unreachable" result aborts the rest of the run
  (in-process and job runs alike). Leftovers go to the next run.

## Env keys the upload path reads

From a grep of the upload-path modules: `CLAUDE_CONFIG_DIR`, `ARTISYN_PROJECT_ROOT`,
`ARTISYN_MANAGED_SETTINGS_DIR`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (via `SIGNAL_ENDPOINT_KEYS`),
plus `managed-settings.js` reads every `OTEL_*` key and `CLAUDE_CODE_ENABLE_TELEMETRY`.
`OTEL_EXPORTER_OTLP_HEADERS`-style keys may carry credentials and are excluded from job files.
