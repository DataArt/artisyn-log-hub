# T-96 — evidence and measurements

**2026-08-13 — measured run-to-run variance on identical code** (mean, run A → run B):

| Scenario | Run A | Run B | Δ |
|---|---|---|---|
| `logs:medium` | 32.8ms | 2.1ms | -94% |
| `logs:subagent` | 12.3ms | 2.2ms | -82% |
| `logs:v2-small` | 12.0ms | 2.6ms | -78% |
| `repos:analytics-work-time` | 11.8ms | 21.3ms | +81% |
| `auth:login` | 2.3ms | 3.8ms | +65% |

Most of the large negative swings are failure latencies, not speedups: run B's failing log POSTs
returned in ~2ms, far faster than the successful requests they replaced, so excluding failures from
the statistics removes most of this apparent variance. `repos:analytics-work-time` (+81%) is the
exception — a pure success path on both runs, i.e. genuine noise that a percentage-only gate would
flag.

**2026-08-13 — run B failure burst:** 2148 errors total (`logs:v2-small`, `logs:subagent`,
`logs:medium` each 500/500; `logs:small` 128/500; `logs:large` 20/500), while the console printed
`✓` for all 25 scenarios. The server log has no entries and no errors in that window and the
failures took ~2ms, so they died before reaching application code. Run A had issued ~12,500
requests two minutes earlier, which makes client-side socket/ephemeral-port exhaustion a candidate,
but this is unverified — see the Open Questions in `requirements.md`.

**2026-08-13 — T-95 context:** the harness produced a "+98% slower on `logs:large`" signal that
could not be trusted in either direction. The gzip middleware under suspicion was subsequently
exonerated by direct reproduction (600/600 → `201`), but the harness was equally incapable of
showing that it was fast, so the perf question for T-95 is unmeasured rather than measured-good.
