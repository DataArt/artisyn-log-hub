---
reviewed: 2026-10-15
reviewer: ai
---

# Login backoff: the growing delay after failed logins

## Purpose

Slows down password guessing. After repeated failed logins the server answers `429` with a
`Retry-After` header for a growing number of seconds, counted separately per account and per
source IP, so neither one account attacked from many IPs nor one IP walking through many accounts
escapes it. It is a speed bump, not a lockout.

## Code

- Implementation: `server/src/auth/login-backoff.service.ts` (`LoginBackoffService`:
  `recordFailure`, `assertNotDelayed`, `recordSuccess`), called from
  `server/src/auth/local.strategy.ts`.
- Twins: Work Hub's Rust port `work-hub/server/src/auth/backoff.rs` (`LoginBackoff`: `record_failure`,
  `check`, `record_success`), in memory like the original (a hand-kept map instead of
  `rate-limiter-flexible`). It runs every row on a `ManualClock` in `work-hub/server/tests/algo.rs`
  (`cargo test --test algo`, i.e. `npm run test:algo` from `work-hub/`).
- Test: `server/src/auth/login-backoff.service.algo.spec.ts`. The service is off under
  `NODE_ENV=test` (the shared e2e server would otherwise `429` unrelated specs), so the test
  subclasses it with `enabled = true`, and it runs on a fake clock so waits are exact.

## Input and output

Three operations, all keyed by an e-mail and/or a source IP:

- `fail(email, ip)` records one failed login and returns the delay now in force, in seconds.
- `check(email, ip)` is called before a login is tried: it either lets it through or throws
  `429` with the seconds left (sent as the `Retry-After` header).
- `success(email)` records a successful login.

The caller (`local.strategy.ts`) runs `check` first, then `fail` on a wrong password or
`success` on a right one. `success` is recorded as soon as the password is right, before the
`password-confirm` e-mail check, which can still answer `403` without it counting as a failure.
The IP is `req.ip` (the proxy's client address only when `TRUST_PROXY` is set), else the socket
address, else the literal `unknown`. This calling order is the caller's, not part of the rule; it
is covered end to end by scenario `S-AUTH-06`, not by the rows below.

## Rules

1. Two independent counters with separate key spaces: the **account** key is the e-mail after
   JavaScript `trim()` and `toLowerCase()` (an empty e-mail is a key like any other); the **IP** key is the IP exactly as
   given (no lowercasing: `2001:DB8::1` and `2001:db8::1` are different keys).
2. `fail` adds one failure to both counters. For a counter that now holds `N` failures, the
   delay is `N - 1` seconds (1st failure 0 s, 2nd 1 s, 3rd 2 s, ...). A delay of at least 1 s
   blocks that key for exactly that many seconds from now (replacing any earlier block on the
   key, even a longer one). A delay of 0 leaves an existing block alone, so a block can outlive
   the counter window of rule 5. `fail` returns `max(account delay, IP delay)`.
3. `check` takes the time left on both keys' blocks (0 when not blocked) and uses the larger. If
   it is above 0 it throws `429` with `ceil(time left in ms / 1000)` seconds; otherwise it lets
   the login through. A rejected `check` changes no counter, so being rejected never extends the
   penalty.
4. `success` clears the account counter and the account block. The IP counter and the IP block
   stay: one good login must not wipe the history of an IP that is probing other accounts.
5. A counter lives for `COUNTER_DURATION_SECONDS = 900` seconds **from its first failure**
   (a fixed window: later failures add to it but do not extend it). It is still there 1 ms before
   the 900 s are up and already gone at exactly 900 s; the next failure then starts again at
   `N = 1`. State lives in the process memory only, separately in each server process (each cluster
   worker); a restart forgives everyone.

## Edge cases

- First failure is free: LB-02; a 1 s block after the second: LB-03.
- Rejected attempts do not count: LB-04.
- Seconds left are rounded up: LB-15; a block ends exactly on time: LB-16.
- Account key case and whitespace: LB-05, LB-12; IP key taken as given: LB-17.
- IP dimension wins / account dimension wins: LB-06, LB-07.
- A delayed IP blocks a fresh account, a delayed account blocks a fresh IP: LB-08, LB-09.
- Success resets the account only: LB-10, LB-11 vs LB-13, LB-14.
- The 900 s window ends exactly on time and is fixed, not sliding: LB-20, LB-18, LB-19.
- Empty e-mail: LB-21. Success with a padded e-mail: LB-22.
- A block outliving the counter window, and a shorter block replacing a longer one: LB-29, LB-30.
- Both dimensions delayed by different amounts, for `fail` and for `check`: LB-23.
- Key spaces kept apart: LB-24. IP with spaces: LB-25.
- `check` with another spelling of the e-mail (LB-26) or of the IP (LB-28); 1 ms before a block
  ends (LB-27).

## Examples

`input.steps` is run in order on a fresh service and a fake clock that only moves on a `wait`
step. A step is `["fail", email, ip]`, `["check", email, ip]`, `["success", email]` or
`["wait", milliseconds]`. `expected.results` holds one value per step: for `fail` the returned
delay in seconds; for `check` `null` when the login is let through, otherwise the seconds of the
`429`; for `success` and `wait` always `null`.

Rows (33): [`docs/algorithm-examples/login-backoff.json`](../../algorithm-examples/login-backoff.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Delay `N` instead of `N - 1` -> LB-01, LB-02.
- Block only from 2 s (`seconds >= 2`) -> LB-03.
- `check` consumes a failure -> LB-04 (last result 5); a rejected `check` renews the block ->
  LB-31.
- A cap on the delay, or a formula that only differs above N = 4 -> LB-32.
- Both keys blocked with the larger delay, or only the dominant key blocked -> LB-33.
- `Math.round` or `Math.floor` instead of `Math.ceil` -> LB-15.
- Block one second longer than the delay -> LB-16.
- Account key not lowercased or not trimmed -> LB-05, LB-12; IP key lowercased -> LB-17.
- `min` instead of `max` of the two dimensions -> LB-06, LB-07, LB-23 (both for `fail` and for
  `check`); a sum -> LB-23.
- One key space for accounts and IPs -> LB-24. IP trimmed -> LB-25.
- `check` without e-mail normalization -> LB-26; with IP normalization -> LB-28.
- A block ending early (any floor of the time left) -> LB-27.
- A zero delay clearing the block (no `seconds < 1` guard) -> LB-29. The longer block kept
  instead of replaced -> LB-30.
- `check` looks at the account key only -> LB-08; at the IP key only -> LB-09.
- `success` does not clear the account -> LB-10, LB-11.
- `success` also clears the IP -> LB-13, LB-14.
- Counters never expire -> LB-18; window shorter than 900 s -> LB-20; sliding instead of fixed
  window -> LB-19.
- Account dimension skipped for an empty e-mail -> LB-21.
- `success` not trimming the e-mail -> LB-22.
- Equivalent: the `0` floor in `msLeft` (a negative time left would fail `check`'s `> 0` test just
  like 0) and in `max(0, ...)` of `fail` (every delay is already >= 0). The block store's own 1 s
  `duration` is only a floor that `block()` overrides.
- Waived, not in the table: the fallback for an exhausted counter (`POINTS_BUDGET = 1,000,000`
  failures on one key in 900 s, read from the limiter's rejection so a login never fails with
  `500`); it is unreachable in practice.

## Where the result is visible

`POST /api/v1/auth/login` answers `429` with the seconds in the `Retry-After` header (the JSON body
is only `statusCode` and `message`). The login page shows a "Too many attempts" banner with
"Please wait Ns before trying again." and disables the button while it counts down. Scenario
`S-AUTH-06` walks the start of the schedule end to end on the mode B stand; LB-01, LB-03, LB-06,
LB-09, LB-10, LB-13, LB-14 and LB-26 overlap it on purpose: the scenario checks HTTP answers on a
real clock, these rows pin the exact values of the same rules.
