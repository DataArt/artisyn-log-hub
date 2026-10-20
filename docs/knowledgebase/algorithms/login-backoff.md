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
- Twins: none.
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

```examples
[
  {
    "id": "LB-01",
    "input": {"steps": [["fail", "victim@arrakis.test", "198.51.100.7"], ["fail", "victim@arrakis.test", "198.51.100.7"], ["fail", "victim@arrakis.test", "198.51.100.7"], ["fail", "victim@arrakis.test", "198.51.100.7"]]},
    "expected": {"results": [0, 1, 2, 3]},
    "note": "Rule 2: N = 1..4 on both keys gives N - 1 = 0, 1, 2, 3."
  },
  {
    "id": "LB-02",
    "input": {"steps": [["fail", "first@arrakis.test", "198.51.100.8"], ["check", "first@arrakis.test", "198.51.100.8"]]},
    "expected": {"results": [0, null]},
    "note": "One failure: delay 0, nothing blocked, the next attempt is let through."
  },
  {
    "id": "LB-03",
    "input": {"steps": [["fail", "second@arrakis.test", "198.51.100.9"], ["fail", "second@arrakis.test", "198.51.100.9"], ["check", "second@arrakis.test", "198.51.100.9"]]},
    "expected": {"results": [0, 1, 1]},
    "note": "Rule 2: the second failure has delay 1 >= 1, so it blocks for 1 s; check at once: ceil(1000 / 1000) = 1."
  },
  {
    "id": "LB-04",
    "input": {"steps": [["fail", "norebound@arrakis.test", "198.51.100.10"], ["fail", "norebound@arrakis.test", "198.51.100.10"], ["fail", "norebound@arrakis.test", "198.51.100.10"], ["check", "norebound@arrakis.test", "198.51.100.10"], ["check", "norebound@arrakis.test", "198.51.100.10"], ["fail", "norebound@arrakis.test", "198.51.100.10"]]},
    "expected": {"results": [0, 1, 2, 2, 2, 3]},
    "note": "The third failure blocks for 2 s, both checks report 2. Rule 3: the rejected checks add nothing, so the next failure is the 4th: 4 - 1 = 3, not 5."
  },
  {
    "id": "LB-05",
    "input": {"steps": [["fail", "Mixed@Arrakis.test", "198.51.100.11"], ["fail", "mixed@arrakis.test", "198.51.100.12"], ["fail", "  MIXED@ARRAKIS.TEST  ", "198.51.100.13"]]},
    "expected": {"results": [0, 1, 2]},
    "note": "Rule 1: all three spellings are one account key; each IP is new (delay 0), so the account's 0, 1, 2 shows."
  },
  {
    "id": "LB-06",
    "input": {"steps": [["fail", "probe-a@arrakis.test", "203.0.113.5"], ["fail", "probe-b@arrakis.test", "203.0.113.5"], ["fail", "probe-c@arrakis.test", "203.0.113.5"], ["fail", "probe-d@arrakis.test", "203.0.113.5"]]},
    "expected": {"results": [0, 1, 2, 3]},
    "note": "Each account is new (0); the IP reaches N = 4: max(0, 3) = 3."
  },
  {
    "id": "LB-07",
    "input": {"steps": [["fail", "roaming@arrakis.test", "203.0.113.21"], ["fail", "roaming@arrakis.test", "203.0.113.22"], ["fail", "roaming@arrakis.test", "203.0.113.23"]]},
    "expected": {"results": [0, 1, 2]},
    "note": "Each IP is new (0); the account reaches N = 3: max(2, 0) = 2."
  },
  {
    "id": "LB-08",
    "input": {"steps": [["fail", "probe-1@arrakis.test", "203.0.113.30"], ["fail", "probe-2@arrakis.test", "203.0.113.30"], ["fail", "probe-3@arrakis.test", "203.0.113.30"], ["check", "never-seen@arrakis.test", "203.0.113.30"]]},
    "expected": {"results": [0, 1, 2, 2]},
    "note": "The IP is blocked for 2 s; a never-seen account from it is rejected with 2."
  },
  {
    "id": "LB-09",
    "input": {"steps": [["fail", "targeted@arrakis.test", "203.0.113.41"], ["fail", "targeted@arrakis.test", "203.0.113.42"], ["fail", "targeted@arrakis.test", "203.0.113.43"], ["check", "targeted@arrakis.test", "203.0.113.44"]]},
    "expected": {"results": [0, 1, 2, 2]},
    "note": "The account is blocked for 2 s; a brand-new IP does not help: rejected with 2."
  },
  {
    "id": "LB-10",
    "input": {"steps": [["fail", "good@arrakis.test", "192.0.2.1"], ["fail", "good@arrakis.test", "192.0.2.2"], ["fail", "good@arrakis.test", "192.0.2.3"], ["success", "good@arrakis.test"], ["fail", "good@arrakis.test", "192.0.2.4"]]},
    "expected": {"results": [0, 1, 2, null, 0]},
    "note": "Rule 4: success clears the account counter; the next failure is the account's 1st and the IP's 1st: 0."
  },
  {
    "id": "LB-11",
    "input": {"steps": [["fail", "unblocked@arrakis.test", "192.0.2.11"], ["fail", "unblocked@arrakis.test", "192.0.2.12"], ["fail", "unblocked@arrakis.test", "192.0.2.13"], ["success", "unblocked@arrakis.test"], ["check", "unblocked@arrakis.test", "192.0.2.14"]]},
    "expected": {"results": [0, 1, 2, null, null]},
    "note": "Rule 4: success also clears the account's 2 s block, so the account may log in again at once."
  },
  {
    "id": "LB-12",
    "input": {"steps": [["fail", "Cased@Arrakis.test", "192.0.2.21"], ["fail", "cased@arrakis.test", "192.0.2.22"], ["fail", "CASED@ARRAKIS.TEST", "192.0.2.23"], ["success", "cASED@aRRAKIS.test"], ["fail", "Cased@Arrakis.test", "192.0.2.24"]]},
    "expected": {"results": [0, 1, 2, null, 0]},
    "note": "Rules 1 and 4: success under another spelling clears the same account key."
  },
  {
    "id": "LB-13",
    "input": {"steps": [["fail", "shared-ip@arrakis.test", "192.0.2.100"], ["fail", "shared-ip@arrakis.test", "192.0.2.100"], ["fail", "shared-ip@arrakis.test", "192.0.2.100"], ["success", "shared-ip@arrakis.test"], ["fail", "other@arrakis.test", "192.0.2.100"]]},
    "expected": {"results": [0, 1, 2, null, 3]},
    "note": "Rule 4: the IP keeps its 3 failures; another account's failure from it is the IP's 4th: 3."
  },
  {
    "id": "LB-14",
    "input": {"steps": [["fail", "ip-owner@arrakis.test", "192.0.2.101"], ["fail", "ip-owner@arrakis.test", "192.0.2.101"], ["fail", "ip-owner@arrakis.test", "192.0.2.101"], ["success", "ip-owner@arrakis.test"], ["check", "stranger@arrakis.test", "192.0.2.101"]]},
    "expected": {"results": [0, 1, 2, null, 2]},
    "note": "Rule 4: the IP's 2 s block survives the success, so another account from it is rejected with 2."
  },
  {
    "id": "LB-15",
    "input": {"steps": [["fail", "round@arrakis.test", "192.0.2.150"], ["fail", "round@arrakis.test", "192.0.2.150"], ["fail", "round@arrakis.test", "192.0.2.150"], ["wait", 700], ["check", "round@arrakis.test", "192.0.2.150"], ["wait", 1000], ["check", "round@arrakis.test", "192.0.2.150"]]},
    "expected": {"results": [0, 1, 2, null, 2, null, 1]},
    "note": "Rule 3 rounds up: 2000 - 700 = 1300 ms left gives ceil(1.3) = 2 (rounding gives 1); 300 ms left gives ceil(0.3) = 1 (rounding down gives 0)."
  },
  {
    "id": "LB-16",
    "input": {"steps": [["fail", "expiry@arrakis.test", "192.0.2.160"], ["fail", "expiry@arrakis.test", "192.0.2.160"], ["fail", "expiry@arrakis.test", "192.0.2.160"], ["wait", 2000], ["check", "expiry@arrakis.test", "192.0.2.160"]]},
    "expected": {"results": [0, 1, 2, null, null]},
    "note": "Rule 2: the block is exactly 2 s; after 2000 ms nothing is left, the login is let through."
  },
  {
    "id": "LB-17",
    "input": {"steps": [["fail", "v6-a@arrakis.test", "2001:DB8::1"], ["fail", "v6-b@arrakis.test", "2001:db8::1"]]},
    "expected": {"results": [0, 0]},
    "note": "Rule 1: the IP key is used as given, so the two spellings are two IP keys, each at N = 1; the accounts differ too: 0 and 0."
  },
  {
    "id": "LB-18",
    "input": {"steps": [["fail", "window@arrakis.test", "192.0.2.170"], ["fail", "window@arrakis.test", "192.0.2.170"], ["wait", 900000], ["fail", "window@arrakis.test", "192.0.2.170"]]},
    "expected": {"results": [0, 1, null, 0]},
    "note": "Rule 5: 900 s after the first failure both counters are gone, so the next failure is N = 1 again: 0 (not 2)."
  },
  {
    "id": "LB-19",
    "input": {"steps": [["fail", "fixed@arrakis.test", "192.0.2.180"], ["wait", 600000], ["fail", "fixed@arrakis.test", "192.0.2.180"], ["wait", 400000], ["fail", "fixed@arrakis.test", "192.0.2.180"]]},
    "expected": {"results": [0, null, 1, null, 0]},
    "note": "Rule 5 is a fixed window: at 1000 s the window opened at 0 s has ended, although the last failure was only 400 s ago, so N = 1: 0. A sliding window would give 2."
  },
  {
    "id": "LB-20",
    "input": {"steps":[["fail","edge@arrakis.test","192.0.2.190"],["fail","edge@arrakis.test","192.0.2.190"],["wait",899999],["fail","edge@arrakis.test","192.0.2.190"]]},
    "expected": {"results":[0,1,null,2]},
    "note": "Rule 5: 1 ms before the window ends both counters still hold 2 failures, so this is N = 3: 2. With LB-18 it pins the window at exactly 900 s."
  },
  {
    "id": "LB-21",
    "input": {"steps":[["fail","","192.0.2.200"],["fail","   ","192.0.2.201"]]},
    "expected": {"results":[0,1]},
    "note": "Rule 1: an empty e-mail is a key like any other, and spaces trim to the same empty key: account N = 1, 2 against new IPs: 0, 1."
  },
  {
    "id": "LB-22",
    "input": {"steps":[["fail","ws@arrakis.test","192.0.2.210"],["fail","ws@arrakis.test","192.0.2.211"],["success","  WS@arrakis.test  "],["fail","ws@arrakis.test","192.0.2.212"]]},
    "expected": {"results":[0,1,null,0]},
    "note": "Rules 1 and 4: success trims and lowercases the e-mail too, so it clears the same account key; the next failure is N = 1 on a new IP: 0."
  },
  {
    "id": "LB-23",
    "input": {"steps":[["fail","both@arrakis.test","192.0.2.230"],["fail","both@arrakis.test","192.0.2.231"],["fail","both@arrakis.test","192.0.2.230"],["check","both@arrakis.test","192.0.2.230"]]},
    "expected": {"results":[0,1,2,2]},
    "note": "Both dimensions delayed and different: the third failure is the account's 3rd (2 s) and the IP's 2nd (1 s), max = 2 (min would be 1, a sum 3). The check then sees 2 s and 1 s left and reports the larger, 2."
  },
  {
    "id": "LB-24",
    "input": {"steps":[["fail","198.51.100.50","198.51.100.51"],["fail","other@arrakis.test","198.51.100.50"]]},
    "expected": {"results":[0,0]},
    "note": "Rule 1, separate key spaces: an e-mail that reads like an IP and that IP are two different keys, so the second failure is N = 1 everywhere: 0. Sharing one key space would give 1."
  },
  {
    "id": "LB-25",
    "input": {"steps":[["fail","pad-a@arrakis.test"," 192.0.2.240"],["fail","pad-b@arrakis.test","192.0.2.240"]]},
    "expected": {"results":[0,0]},
    "note": "Rule 1: the IP is not trimmed either, so \" 192.0.2.240\" and \"192.0.2.240\" are two keys: 0, 0."
  },
  {
    "id": "LB-26",
    "input": {"steps":[["fail","Spell@arrakis.test","192.0.2.250"],["fail","spell@arrakis.test","192.0.2.251"],["fail","SPELL@arrakis.test","192.0.2.252"],["check","  spell@ARRAKIS.test  ","192.0.2.253"]]},
    "expected": {"results":[0,1,2,2]},
    "note": "Rules 1 and 3: check normalizes the e-mail the same way, so a padded, differently cased spelling from a new IP still finds the account blocked for 2 s."
  },
  {
    "id": "LB-27",
    "input": {"steps":[["fail","last@arrakis.test","192.0.2.254"],["fail","last@arrakis.test","192.0.2.254"],["fail","last@arrakis.test","192.0.2.254"],["wait",1999],["check","last@arrakis.test","192.0.2.254"]]},
    "expected": {"results":[0,1,2,null,1]},
    "note": "Rule 3, 1 ms before the 2 s block ends: ceil(1 / 1000) = 1, still rejected (LB-16 is the moment it ends)."
  },
  {
    "id": "LB-28",
    "input": {"steps":[["fail","v6-1@arrakis.test","2001:DB8::2"],["fail","v6-2@arrakis.test","2001:DB8::2"],["fail","v6-3@arrakis.test","2001:DB8::2"],["check","v6-4@arrakis.test","2001:db8::2"]]},
    "expected": {"results":[0,1,2,null]},
    "note": "Rule 1 for check: the IP is taken as given there too, so the lower-case spelling is another key with no block: let through."
  },
  {
    "id": "LB-29",
    "input": {"steps":[["fail","outlive@arrakis.test","192.0.2.40"],["wait",899000],["fail","outlive@arrakis.test","192.0.2.40"],["fail","outlive@arrakis.test","192.0.2.40"],["wait",1000],["fail","outlive@arrakis.test","192.0.2.40"],["check","outlive@arrakis.test","192.0.2.40"]]},
    "expected": {"results":[0,null,1,2,null,0,1]},
    "note": "At 899 s the 2nd and 3rd failures block for 2 s (until 901 s). At 900 s the window ends, the next failure is N = 1 (delay 0), which leaves the block alone: the check still has 1 s left."
  },
  {
    "id": "LB-30",
    "input": {"steps":[["fail","shorter@arrakis.test","192.0.2.41"],["wait",899000],["fail","shorter@arrakis.test","192.0.2.41"],["fail","shorter@arrakis.test","192.0.2.41"],["fail","shorter@arrakis.test","192.0.2.41"],["wait",1000],["fail","shorter@arrakis.test","192.0.2.41"],["fail","shorter@arrakis.test","192.0.2.41"],["check","shorter@arrakis.test","192.0.2.41"]]},
    "expected": {"results":[0,null,1,2,3,null,0,1,1]},
    "note": "At 899 s the 4th failure blocks for 3 s (until 902 s). After the window ends at 900 s, failures restart at N = 1 (0) and N = 2 (1 s): the new 1 s block replaces the longer one, so the check sees 1 s, not 2."
  },
  {
    "id": "LB-31",
    "input": {"steps":[["fail","renew@arrakis.test","192.0.2.60"],["fail","renew@arrakis.test","192.0.2.60"],["fail","renew@arrakis.test","192.0.2.60"],["wait",700],["check","renew@arrakis.test","192.0.2.60"],["wait",1300],["check","renew@arrakis.test","192.0.2.60"]]},
    "expected": {"results":[0,1,2,null,2,null,null]},
    "note": "Rule 3: the rejected check at 700 ms does not renew the 2 s block, so at 2000 ms it has ended and the next check is let through."
  },
  {
    "id": "LB-32",
    "input": {"steps":[["fail","long@arrakis.test","192.0.2.61"],["fail","long@arrakis.test","192.0.2.61"],["fail","long@arrakis.test","192.0.2.61"],["fail","long@arrakis.test","192.0.2.61"],["fail","long@arrakis.test","192.0.2.61"],["fail","long@arrakis.test","192.0.2.61"],["fail","long@arrakis.test","192.0.2.61"]]},
    "expected": {"results":[0,1,2,3,4,5,6]},
    "note": "Rule 2 has no cap: N = 1..7 gives 0..6 seconds."
  },
  {
    "id": "LB-33",
    "input": {"steps":[["fail","dual@arrakis.test","192.0.2.70"],["fail","dual@arrakis.test","192.0.2.71"],["fail","dual@arrakis.test","192.0.2.70"],["check","fresh@arrakis.test","192.0.2.70"]]},
    "expected": {"results":[0,1,2,1]},
    "note": "Rule 2 blocks each key for its own delay: after the third failure the account has 2 s and the IP (its 2nd failure) 1 s. A fresh account from that IP sees only the IP block: 1. Blocking both keys with the larger delay would give 2; blocking only the larger key would let it through."
  }
]
```

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
