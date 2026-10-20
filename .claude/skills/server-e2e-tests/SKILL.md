---
name: server-e2e-tests
description: "Always after changing server code"
---

After you change server code, add tests of **only these three kinds** (CLAUDE.md → "Test policy"),
and only where the change needs them — do not multiply tests:

1. **Algorithm** — the change touches an algorithm with a doc in `docs/knowledgebase/algorithms/`:
   add/change rows in that doc's examples block; the existing `*.algo.spec.ts` reads them. A new
   `*.algo.spec.ts` only with a new algorithm doc.
2. **API contract** — a new or changed route: its row in `server/test/contract/registry/` (the
   meta-test fails otherwise). Run `npm run test:contract` (from `server/`).
3. **Scenario** — the behaviour: a step in an existing scenario in `tests/scenarios/` (grep the
   area first). A new scenario file only for a genuinely new feature. Run just that scenario:
   `npm run test:scenarios -- --mode <a|b|c> --only scenarios --grep "<@S-TAG>"`.

Never add other `*.spec.ts` / `*.e2e-spec.ts` files. If no scenario can reach the code, either a
step is missing or the code is not needed — target ≥ 80 % coverage from scenarios.

## Rules

- Scenarios are as close to real-world as possible — real stand, real DB, no mocks. They clean up
  after themselves through the stand fixtures.
- Payloads sent in requests are constants (or golden-session fixtures), never inline raw JSON.
