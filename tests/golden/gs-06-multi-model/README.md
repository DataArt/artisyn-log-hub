# GS-06 multi-model (two roots)

Two root sessions on `feature/billing`, W2 Monday.

- **06a** (`06a/`, 10:00:00): E1 `claude-sonnet-4-6` (2000 / 1000 / 0 / 10000), a `/model` command line,
  E2 `claude-opus-5` (4000 / 2000 / 10000 / 6000). The session is priced by its **first** model:
  **$0.1260** (by opus it would be 0.2100). Work time 40 + 50 = 90 s; cache ratio 38.5 %.
- **06b** (`06b/`, 11:00:00): `claude-unreleased-9`, 1000 / 500, no price → cost **null** (not 0), the
  "no pricing" badge. Work time 30 s.

Checks: first-model pricing rule, model switch, unpriced model → null.

Dates are written relative to `A` = Monday 2026-01-05 (W1 = 05–11 Jan, W2 = 12–18 Jan); the
loader (`tests/scenarios/helpers/golden.ts`) shifts every timestamp by whole days. `{{RUN}}` and
`{{REPO}}` are placeholders the loader replaces. The numbers here are documentation; the contract is
`expected.json` (DD D3) and `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` §2.3.
