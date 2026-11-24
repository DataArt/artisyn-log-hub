# PoC: gzip for large JSON API answers (Express 5)

Task: [2026-11-24-traffic-optimization](../../tasks/todo/2026-11-24-traffic-optimization/requirements.md), Part B (FR-11, FR-12).

## Question

How should the server gzip large JSON answers (session OTEL ~9 MB) on Express 5.2.1 under Nest 11?
Specifically:

- Does the `compression` middleware (1.8.2) give `gzip` + `Vary: Accept-Encoding`, honour `q=0` and a
  size threshold, leave pre-gzipped answers and streamed NDJSON alone, and keep the event loop free?
- Does a small in-house middleware that wraps `res.json` do the same? Nest's Express adapter replies
  every plain-object handler result through `response.json(body)`
  (`@nestjs/platform-express/adapters/express-adapter.js`, `reply()`).

## How to run

```
npm install
node poc.mjs
```

## Result

| Check | A: `compression` 1.8.2 | B: `res.json` wrapper + async `zlib.gzip` |
|---|---|---|
| Browser `Accept-Encoding: gzip, deflate, br` | **`br`** (prefers brotli, no option to turn it off) | `gzip` |
| `Accept-Encoding: gzip` | `gzip`, 9,546,706 → 264,882 bytes | same |
| No `Accept-Encoding` / `gzip;q=0` | identity | identity |
| `Vary: Accept-Encoding` | yes, also on identity answers | yes, also on identity answers |
| Below threshold (8 KiB) | identity | identity |
| Pre-gzipped answer (`Content-Encoding` already set, `res.end`) | not compressed twice | not compressed twice (never calls `res.json`) |
| Streamed NDJSON (`res.write`) | identity with the content-type filter; chunks arrive progressively | identity by construction; chunks arrive progressively |
| Non-`/api` path | untouched (filter) | untouched |
| Max event-loop lag while serving the 9.5 MB answer | 10–16 ms | 9 ms (mostly the `JSON.stringify` the route already does) |
| Decoded JSON identical | yes | yes |

The JSON is synthetic with repetitive padding, so the 36x ratio overstates real data; the shape of
the result (gzip works, ratio is large for `spans`-heavy JSON) is what matters. One-shot gzip of the
9.5 MB body on this dev machine: level 6 20 ms, level 1 7 ms (Pi will be several times slower,
which is why the async thread-pool `zlib.gzip` is used, not `gzipSync`).

**Conclusion:** use variant B. It needs no new dependency, answers `gzip` exactly as FR-11 states,
and excludes streamed answers, `@Res()` downloads and pre-gzipped log parts automatically because
those never go through `res.json`. `compression` would answer `br` to browsers and needs an
explicit filter for every streamed route.
