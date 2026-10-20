# GS-01 plain

A plain root session on `main` (claude-sonnet-4-6), W1 Monday 10:00:00–10:10:30.

- 3 qualifying prompts (10:00:00, 10:05:00, 10:10:00) plus one `isMeta` user line that does not qualify.
- Work time 90 + 45 + 30 = **165 s**; duration 0:10:30.
- Tokens 3000 / 2000 / 20000 / 10000 (5m) / 0 (1h). The usage objects have **no** `cache_creation`
  object (legacy format), so every cache write lands in the 5m bucket. Cost **$0.0825**
  (P1 0.0429, P2 0.0267, P3 0.0129); cache read ratio 66.7 %.
- Tools: Read 3 (`src/app.ts` twice, `docs/api.md` once), Write 1 (`src/health.ts`, create, 12 lines),
  Edit 2 (`src/app.ts` +3 −1, `src/main.ts` +2 −0), Bash 2 (`git commit`, `gh pr create`).
- Lines written 19, diff +17 / −1; commits 1, PRs 1; change surface 3 files in one folder (`src`),
  concentration 100, focused.
- Service lines for Raw Logs: `mode`, `permission-mode`, `system-context`, `attachment`, `ai-title`,
  `last-prompt`. Claude Code version `2.1.99` on every transcript line.

Checks: prompt qualification, work time, legacy TTL fallback, cache ratio, file categories,
written vs diff lines, commits and PRs, change surface 100.

Dates are written relative to `A` = Monday 2026-01-05 (W1 = 05–11 Jan, W2 = 12–18 Jan); the
loader (`tests/scenarios/helpers/golden.ts`) shifts every timestamp by whole days. `{{RUN}}` and
`{{REPO}}` are placeholders the loader replaces. The numbers here are documentation; the contract is
`expected.json` (DD D3) and `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` §2.3.
