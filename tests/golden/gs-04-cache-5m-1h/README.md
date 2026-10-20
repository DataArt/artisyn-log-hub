# GS-04 ttl

One root session on `main` (claude-opus-5), W1 Tuesday 10:01:00–10:04:05, four prompts with one
assistant event each.

| Prompt | Feature | in / out / cacheRead / cw5m / cw1h | Cost |
|---|---|---|---|
| P1 | `cache_creation` 5m 40 000 + 1h 60 000 | 10000 / 2000 / 0 / 40000 / 60000 | 0.9500 |
| P2 | `speed: "fast"`, 2 web searches, 1h write | 5000 / 1000 / 100000 / 0 / 20000 | 0.3700 |
| P3 | cache read only | 1000 / 500 / 120000 / 0 / 0 | 0.0775 |
| P4 | no cache at all (ratio n/a) | 200 / 60 / 0 / 0 / 0 | 0.0025 |

- Total **$1.4000**; the wrong prices a test must tell apart: 1h at the 5m rate 1.1000, no fast
  surcharge 1.3500.
- Work time 40 + 60 + 20 + 5 = **125 s**; overlaps GS-02 on the same day and branch.

Checks: 5m/1h TTL pricing, fast mode ×2, web search per request, per-prompt ratio n/a.

Dates are written relative to `A` = Monday 2026-01-05 (W1 = 05–11 Jan, W2 = 12–18 Jan); the
loader (`tests/scenarios/helpers/golden.ts`) shifts every timestamp by whole days. `{{RUN}}` and
`{{REPO}}` are placeholders the loader replaces. The numbers here are documentation; the contract is
`expected.json` (DD D3) and `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` §2.3.
