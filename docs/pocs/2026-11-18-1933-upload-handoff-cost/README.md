# PoC: upload hand-off cost and job-claim exclusivity

Task: [2026-11-18-receiver-upload-queue](../../tasks/todo/2026-11-18-receiver-upload-queue/requirements.md)

## Questions

1. Does the `Stop` / `SessionEnd` hand-off path (start node, load `send-logs-hook.js`'s full module
   graph, read the heartbeat, write one job atomically, optionally spawn a detached receiver) fit
   the ≤ ~200 ms budget?
2. Is "claim a job by renaming it" (`queue/x.json` → `running/x.json`) exclusive when several
   processes race for the same job?
3. Is an exclusive-create claim file (`fs.openSync(path, 'wx')`) exclusive under the same race?
4. How fast does `fs.watch` on the queue dir see a job written by tmp + rename?

## How to run

From this folder (Node only, no dependencies):

```
node run.mjs        # questions 1, 2, 4
node claim-wx.mjs   # question 3
```

Both write only under `./work/` (git-ignored); delete it afterwards.

## Result

Measured on Windows 11, Node 26.13.1, 20 runs per row (ms).

| Measurement | min | p50 | p95 | max |
|---|---|---|---|---|
| Hand-off wall time per hook process (node start → exit), no spawn | 40.4 | 45.4 | 62.8 | 62.8 |
| Same, with a detached hidden spawn | 42.5 | 45.8 | 62.6 | 62.6 |
| In-process part (require graph + heartbeat + job write + spawn) | 17.2 | 17.7 | 36.2 | 36.2 |
| `spawn(..., {detached, windowsHide}).unref()` call alone | 3.8 | 4.0 | 7.4 | 7.4 |
| `fs.watch` pickup of a tmp + rename job | 0.4 | 0.4 | 0.9 | 0.9 |

Bare `node -e 0` is 39 ms; `send-logs-hook.js --self-check` (full graph) 62 ms average.

Claim races (8 processes × the same 50 jobs):

- **rename claim — NOT exclusive on Windows:** 95 successful claims for 50 jobs (45 duplicates);
  a second run gave 174 duplicates. Both racers' `renameSync` succeed: the second rename moves the
  file the first one already moved. Never use rename as a claim.
- **`wx` claim file — exclusive:** 5 rounds, 50 claims for 50 jobs, 0 duplicates each round.

Conclusions:

1. The hand-off path fits the budget with ~3× headroom (p95 63 ms wall), even with the full
   module graph loaded and a detached receiver spawn; the in-process `maybeReArmOtelSession`
   handshake (up to 2 s + 2 s) is what must leave the hand-off path, not the requires.
2. A job is claimed by creating `<job>.claim` with `'wx'` (pid + start time inside); a claim held
   by a dead pid or older than the stuck threshold may be broken. Rename is used only for the
   atomic job write (tmp → final name, single writer).
3. `fs.watch` sees a new job in < 1 ms; a slow poll is still needed as a backstop (network home
   dirs, missed events).
