# GS-02 tree

A delegating root session on `main`, W1 Tuesday 10:00:00–10:05:00, with sub-agents three levels deep:
root (sonnet-4-6) → A (haiku-4-5) → B (haiku-4-5, grandchild, `parentSessionId` = A); root → D (opus-5).

| Node | in / out / cacheRead / cw5m / cw1h | Cost |
|---|---|---|
| root | 2000 / 1000 / 10000 / 4000 / 0 | 0.0390 |
| A | 10000 / 4000 / 20000 / 4800 / 0 | 0.0380 |
| B | 6000 / 2000 / 8000 / 0 / 3000 | 0.0228 |
| D | 1000 / 500 / 0 / 0 / 0 | 0.0175 |
| tree | 19000 / 7500 / 38000 / 8800 / 3000 | **0.1173** |

- Root work time P1 120 s + P2 60 s = **180 s**; sub-agent events do not extend it.
- Edits: A edits `src/billing/invoice.ts` (+2 −2); B writes `src/billing/tax.ts` (create, 20 lines) and
  edits `invoice.ts` again (+1 −1); D edits `src/api/routes.ts` (+4 −0). Tree: written 36,
  diff +27 / −3, 3 unique files in 2 folders, concentration 62 (focused).
- Tools (tree): Agent 3, Read 5, Edit 3, Write 1, Bash 1 (`git commit` at the root) = 13.

Checks: 3-level nesting, tree-scoped cost/lines/change surface, the double-count trap, per-turn
"main + sub-agents" cost, delegation share.

Dates are written relative to `A` = Monday 2026-01-05 (W1 = 05–11 Jan, W2 = 12–18 Jan); the
loader (`tests/scenarios/helpers/golden.ts`) shifts every timestamp by whole days. `{{RUN}}` and
`{{REPO}}` are placeholders the loader replaces. The numbers here are documentation; the contract is
`expected.json` (DD D3) and `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` §2.3.
