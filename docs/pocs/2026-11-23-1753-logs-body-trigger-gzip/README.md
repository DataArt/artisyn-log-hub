---
type: "PoC"
title: "logs.body guard trigger and gzip of stored bodies"
description: "Checks the BEFORE INSERT OR UPDATE OF body trigger planned for logs (rev bump, hash clear) and gzip-6 ratio/time of real stored log bodies."
---

# PoC: `logs.body` guard trigger and gzip of stored bodies

Task: [2026-11-23-session-logs-streaming](../../tasks/todo/2026-11-23-session-logs-streaming/requirements.md)
(FR-1 compressed copy, FR-5 hash skip / hash integrity).

## Question

1. Does a `BEFORE INSERT OR UPDATE OF body` plpgsql trigger on `logs` do what the plan needs:
   - assign a monotonic `body_rev` from a sequence on every body write, including
     `INSERT … ON CONFLICT DO UPDATE SET body = …`;
   - clear `body_sha256` when `body` is written without a new hash (zip import, an older server
     build after a downgrade);
   - **not** fire when only `body_gz` / `body_gz_rev` are updated?
2. What gzip level 6 gives on real stored bodies (`body::text`): ratio, time, round-trip equality.

## How to run

From this folder (needs the local dev Postgres; reads `DATABASE_URL` from `server/.env` or the
environment). Part A works on a TEMP table inside a transaction that is rolled back; part B only
runs `SELECT`s.

```
node poc.cjs
```

## Result

**1. Trigger — works as planned.** Output:

```
insert with hash h1:                               {"body_sha256":"h1","body_rev":"1","body_gz_rev":null}
ON CONFLICT update with new hash h2:               {"body_sha256":"h2","body_rev":"3","body_gz_rev":null}
UPDATE body without hash (zip import / old build): {"body_sha256":null,"body_rev":"4","body_gz_rev":null}
UPDATE gz only (trigger must not fire):            {"body_sha256":null,"body_rev":"4","body_gz_rev":"4"}
upsert same body, new hash h3:                     {"body_sha256":"h3","body_rev":"6","body_gz_rev":"4"}
```

- `UPDATE OF body` fires for the `DO UPDATE` arm of an upsert, so every body writer bumps the
  revision without code changes, including an older server build.
- On an upsert that conflicts, the `BEFORE INSERT` trigger also runs for the attempted insert and
  consumes a sequence value: `body_rev` is strictly increasing but **has gaps**. Readers may only
  compare revisions for equality / order, never count them.
- "Hash not changed by this statement" (`NEW.body_sha256 IS NOT DISTINCT FROM OLD.body_sha256`)
  is a correct test for "writer did not supply a hash": a writer that supplies a hash always
  supplies the hash of the new body, which differs from the old hash unless the body is the same.
- After a gz-only update `body_gz_rev = body_rev` while `body_rev` is unchanged; the next body
  write makes them differ, which is the "compressed copy is stale" signal.

**2. gzip level 6** on the three largest local `claude` bodies (the local DB has no huge sessions):

| text bytes | gzip-6 bytes | ratio | gzip ms (dev CPU) | round trip |
|---|---|---|---|---|
| 357 498 | 82 644 | 4.33 | 4.4 | equal |
| 279 882 | 78 341 | 3.57 | 3.9 | equal |
| 272 172 | 76 473 | 3.56 | 3.8 | equal |

Ratio 3.6–4.3 matches the requirement's estimate (42 MB session → about 10 MB). About 12 ms per MB
on a dev CPU; the Pi will be several times slower, which is why gzip runs in the background
rebuild path, not in the hook-facing request.
