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

```examples
[
  {"id": "RB-01", "input": {"failures": 0}, "expected": {"delayMs": 5000}, "note": "5000 * 2^0 = 5000"},
  {"id": "RB-02", "input": {"failures": 1}, "expected": {"delayMs": 10000}, "note": "5000 * 2 = 10000"},
  {"id": "RB-03", "input": {"failures": 2}, "expected": {"delayMs": 20000}, "note": "5000 * 4 = 20000"},
  {"id": "RB-04", "input": {"failures": 3}, "expected": {"delayMs": 40000}, "note": "5000 * 8 = 40000 < 60000"},
  {"id": "RB-05", "input": {"failures": 4}, "expected": {"delayMs": 60000}, "note": "5000 * 16 = 80000 -> capped at 60000"},
  {"id": "RB-06", "input": {"failures": 5}, "expected": {"delayMs": 60000}, "note": "5000 * 32 = 160000 -> 60000"},
  {"id": "RB-07", "input": {"failures": 1000}, "expected": {"delayMs": 60000}, "note": "exponent bounded at 30, 5000 * 2^30 -> 60000"},
  {"id": "RB-08", "input": {"failures": -3}, "expected": {"delayMs": 5000}, "note": "Rule 1: negative counts as 0 -> 5000"},
  {"id": "RB-09", "input": {"failures": 2.9}, "expected": {"delayMs": 20000}, "note": "Rule 1: 2.9 cut to 2 -> 20000"},
  {"id": "RB-10", "input": {"failures": "3"}, "expected": {"delayMs": 5000}, "note": "Rule 1: a string is not a number -> 0 -> 5000"}
]
```

## Mutations

- "No cap" -> RB-05.
- "Starts at 2^1 (10 s) for the first failure count 0" -> RB-01.
- "Rounds fractions up" -> RB-09.
- "Parses numeric strings" -> RB-10.
- "Negative exponent allowed" (2^-3) -> RB-08.

## Where the result is visible

Safe behaviour: the hook's `receiver.log` and the server's request rate. While the receiver
backs off, the OTEL tabs show realtime data later; the regular chunk upload fills it in.
