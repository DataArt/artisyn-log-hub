# GS-03 compaction

One root session on `feature/billing` (claude-haiku-4-5, 200K window), W1 Wednesday 10:00:00–11:06:30.

- 12 prompts, one every 6 minutes, each answered by one assistant event 30 s later → work time **360 s**.
- A `compact_boundary` (`preTokens` 180000, trigger auto) sits between t8 and t9; context peaks at
  180 000 (t8), 4 of 12 turns are at or above 160K.
- Legacy usage only (flat `cache_creation_input_tokens`): in 1200, out 6010, cacheRead 255 000,
  cacheWrite 793 800 (all 5m). Cost **$1.0490**; cache read ratio 24.3 %.
- Read `src/app.ts` twice (t1 and t11 — t11 is the file re-read cause).

Checks: compaction, context ceiling, low cache reuse detectors, cache-creation causes and the
per-user threshold.

Dates are written relative to `A` = Monday 2026-01-05 (W1 = 05–11 Jan, W2 = 12–18 Jan); the
loader (`tests/scenarios/helpers/golden.ts`) shifts every timestamp by whole days. `{{RUN}}` and
`{{REPO}}` are placeholders the loader replaces. The numbers here are documentation; the contract is
`expected.json` (DD D3) and `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` §2.3.
