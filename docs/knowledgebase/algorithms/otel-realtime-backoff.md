---
reviewed: no
reviewer: none
---

# OTEL realtime backoff

## Purpose

The hook's OTEL receiver sends the session's telemetry to Log Hub in realtime batches (about one
POST every 5 s). When the server is slow or unreachable, the receiver must not hammer it: after
each failed send it waits longer, up to a minute, and goes back to the normal pace after the
first success. The regular chunk upload is unaffected, so nothing is lost while it waits.

## Code

- Implementation: `hook/.claude/telemetry_tool/otel-receiver.js` — `nextRealtimeDelay`
  (`RT_BACKOFF_BASE_MS` = 5000, `RT_BACKOFF_MAX_MS` = 60000).
- Twins: none.
- Test: `hook/.claude/telemetry_tool/__tests__/otel-realtime.algo.test.js`.

## Rules

1. `failures` is the number of consecutive failed sends (a 5xx, a timeout or a network error);
   a success resets it to 0. A value that is not a finite number, or is 0 or negative, counts as
   0; a fraction is cut to its whole part.
2. `delay = min(RT_BACKOFF_BASE_MS · 2^failures, RT_BACKOFF_MAX_MS)`
   = `min(5000 · 2^failures, 60000)` milliseconds. The exponent is bounded at 30 before the
   power, which is far beyond the cap anyway.

## Edge cases

- No failure yet: RB-01; negative, fractional and non-number counts: RB-08, RB-09, RB-10.
- Doubling: RB-02, RB-03, RB-04; the last value under the cap: RB-04; capped: RB-05, RB-06.
- A huge count stays at the cap: RB-07.

## Examples

Rows (10): [`docs/algorithm-examples/otel-realtime-backoff.json`](../../algorithm-examples/otel-realtime-backoff.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- "No cap" -> RB-05.
- "Starts at 2^1 (10 s) for the first failure count 0" -> RB-01.
- "Rounds fractions up" -> RB-09.
- "Parses numeric strings" -> RB-10.
- "Negative exponent allowed" (2^-3) -> RB-08.

## Where the result is visible

Safe behaviour: the hook's `receiver.log` and the server's request rate. While the receiver
backs off, the OTEL tabs show realtime data later; the regular chunk upload fills it in.
