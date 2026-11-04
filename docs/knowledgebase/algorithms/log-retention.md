---
reviewed: 2026-11-04
reviewer: ai
---

# Log retention: which old server log files are deleted

## Purpose

Keeps the server's own operational logs (`logs/app-*.log`, `logs/sql-*.log`, see
[../log-subsystem.md](../log-subsystem.md)) from filling the disk: a few days of each, under a
total size cap. Session telemetry in the DB is not affected.

## Code

- Implementation: `server/src/log-retention/log-retention-plan.ts` (`planLogCleanup`,
  `readLogRetentionPolicy`), called by `LogRetentionService` (`log-retention.service.ts`) at
  bootstrap and then every `LOG_RETENTION_CHECK_INTERVAL_MS` (default 3 600 000 = 1 h) in every
  server process.
- Twins: none.
- Test: `server/src/log-retention/log-retention-plan.algo.spec.ts`.

## Input and output

`planLogCleanup(files, today, policy)`: `files` is every file in `logs/` as `{ name, size }`,
`today` is the loggers' local day tag `YYYY-MM-DD`, `policy` is
`{ appDays, sqlDays, maxTotalBytes }`. It returns the names to delete, in deletion order (the
age-rule names sorted by name first, then the size-rule names in the order of rule 3).

`readLogRetentionPolicy(env)` builds the policy from env.

## Rules

1. Only names matching `^(app|sql)-YYYY-MM-DD(-i<digits>)?\.log$` (lower case, two-digit month and
   day) are day logs. Every other file is never deleted and does not count towards the size cap.
   A file's age in days is `today - its day tag` (calendar days).
2. **Age:** an `app` file with age `>= appDays` and a `sql` file with age `>= sqlDays` are
   deleted, so `N` days means today plus the `N - 1` days before. A limit of `0` switches that
   age rule off.
3. **Size:** over the day logs left after rule 2, while their total size is above
   `maxTotalBytes`, delete the oldest: earliest day first, on the same day `sql` before `app`,
   then by name. Files with age `<= 0` (today, or dated after today after a clock change) are
   never deleted, so the total may stay above the cap. Exactly at the cap is within it.
   `maxTotalBytes = 0` switches the size rule off.
4. **Env:** `LOG_RETENTION_DAYS` → `appDays` (default 5), `SQL_LOG_RETENTION_DAYS` → `sqlDays`
   (default 3), `LOG_RETENTION_MAX_MB` → `maxTotalBytes = MB * 1024 * 1024` (default 100). A value
   must be a non-negative integer (`Number()` of it, so surrounding spaces are fine); anything
   else, or blank, falls back to the default.

## Edge cases

- Defaults end to end: LR-01; cluster-worker `-iN` files: LR-02; foreign names ignored: LR-03.
- Size cap order and stop: LR-04, LR-12, LR-14; today kept above the cap: LR-05; exactly at the
  cap: LR-11; aged-out files not counted: LR-10.
- Limits switched off: LR-06, LR-07; future-dated file: LR-08.
- Calendar boundaries: LR-09 (year), LR-13 (leap day).
- Env parsing: LR-20 .. LR-24.

## Examples

A plan row has `input.files` (`[name, size]` pairs), `input.today`, `input.policy` and
`expected.deleted`. An env row has `input.env` and `expected.policy`.

Rows (19): [`docs/algorithm-examples/log-retention.json`](../../algorithm-examples/log-retention.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- `>` instead of `>=` in the age rule -> LR-01, LR-09.
- Day logs matched case-insensitively or without the full-name anchor -> LR-03.
- Size cap measured before the age rule -> LR-10.
- Today's files deletable by the size rule -> LR-05; future-dated ones -> LR-08.
- `app` before `sql` on the same day -> LR-04; kind before day -> LR-14.
- `>=` instead of `>` in the cap check -> LR-11.
- `0` treated as invalid -> LR-22; negatives or fractions accepted -> LR-23.

## Where the result is visible

Old files disappear from `logs/` within an hour (and on every start); the Admin Panel Error Logs
tab and the Logs Archive download only see what is left. Each sweep that removes anything writes
`Removed N old log file(s)` to the app log.
