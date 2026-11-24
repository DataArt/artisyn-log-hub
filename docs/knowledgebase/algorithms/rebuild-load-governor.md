---
type: "Algorithm"
title: "Rebuild load governor: when a background rebuild step may run"
description: "Paces Log Hub's background drains (derived-data rebuilds, backfills, the gzip builder, the upload-queue tick) by CPU load: run at once when idle, slow down on a linear slope, pause at saturation, and run anyway after a hard cap so deferred work always converges."
tags: [algorithm, background-jobs, performance]
generated: { by: "claude-code", at: "2026-11-23T20:00:00+04:00" }
reviewed: no
reviewer: none
---

# Rebuild load governor: when a background rebuild step may run

## Purpose

Background rebuilds must not compete with users for CPU on a busy instance, yet must never be
dropped: an idle instance rebuilds right after an upload, a loaded one defers the work, and a
saturated one still catches up after a bounded time.

## Code

- Implementation: `server/src/common/load-governor/rebuild-pace.ts` (`decideRebuildPace`), driven
  by `RebuildGovernor.admit()` in `rebuild-governor.ts` with the load from `CpuLoadSampler`
  (`cpu-load-sampler.ts`); both are providers of the global `LoadGovernorModule`.
- Twins: none.
- Test: `server/src/common/load-governor/rebuild-pace.algo.spec.ts`.

## Input and output

`decideRebuildPace({loadPct, nowMs, pausedSinceMs, slowdownPct, pausePct, hardCapMs,
maxDelayMs})` returns `{action, waitMs, pausedSinceMs}`: `action` is `run` (now), `wait` (sleep
`waitMs`, then run) or `pause` (re-check after one load sample); `waitMs` is 0 unless `action` is
`wait`; `pausedSinceMs` is the pause start the caller keeps for its next call.

The load `L` = `loadPct` is the CPU busy share, 0–100, possibly fractional: the mean of the last
`CPU_LOAD_SAMPLE_WINDOW` (3) samples taken every `REBUILD_LOAD_SAMPLE_MS` (2000). One sample is
`max(host share, cgroup share)`: the host share is the busy part of the `os.cpus()` time deltas;
the cgroup share, only when `/sys/fs/cgroup/cpu.max` holds a quota, is
`Δusage_usec / (quota / period × Δt)`. Before the first full sample the load is 0.

## Rules

With `S` = `slowdownPct` (`REBUILD_SLOWDOWN_CPU_PERCENT`, default 60), `P` = `pausePct`
(`REBUILD_PAUSE_CPU_PERCENT`, default 99), `H` = `hardCapMs` (`REBUILD_HARD_CAP_MS`, default
300000) and `D` = `maxDelayMs` (`REBUILD_MAX_DELAY_MS`, default 10000), checked in this order:

1. `L < S` → `run`, `waitMs = 0`, `pausedSinceMs = null`.
2. `S ≤ L < P` → `waitMs = floor(D × (L − S) / (P − S))`, `pausedSinceMs = null`; `action` is
   `wait`, or `run` when `waitMs` is 0.
3. `L ≥ P` and `pausedSinceMs` is null → `pause`, `pausedSinceMs = nowMs`.
4. `L ≥ P` and `nowMs − pausedSinceMs < H` → `pause`, `pausedSinceMs` unchanged.
5. `L ≥ P` and `nowMs − pausedSinceMs ≥ H` → `run` (drain mode), `pausedSinceMs` unchanged.

The governor (not the pure function) adds:

- Env values are read as positive integers (else the default); percents are clamped to 1–100,
  and `S > P` is lowered to `S = P`, so rule 2's divisor `P − S` is never 0 when rule 2 applies.
- One `pausedSinceMs` per worker, shared by every drain. `admit()` loops on `pause` (sleeping one
  sample), sleeps `waitMs` on `wait`, and returns on `run`. `reportIdle()` ends drain mode
  (resets `pausedSinceMs` to null) once the pause outlived `H` and no `admit()` is waiting.
- Work is never dropped: a paused drain keeps its queue rows and stale markers.

## Edge cases

- Below the slowdown threshold: RG-01; just below it after a pause: RG-09.
- Slope midpoint: RG-02; top edge with rounding down: RG-03; bottom edge `L = S`: RG-04.
- Slope while a pause was recorded resets it: RG-05.
- Pause start at exactly `L = P`: RG-06; within the cap: RG-07; at exactly the cap: RG-08.
- `S = P` (no slope): RG-10.

## Examples

Each row's `input` is the full `decideRebuildPace` argument and `expected` the full decision.

Rows (10): [`docs/algorithm-examples/rebuild-load-governor.json`](../../algorithm-examples/rebuild-load-governor.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- `>` instead of `≥` for the pause threshold (`L = P` sloped instead of paused) → RG-06.
- Rounding to nearest instead of down → RG-03.
- Pause start reset on every pause → RG-07.
- `>` instead of `≥` against the hard cap → RG-08.
- Pause start kept when load falls onto the slope → RG-05; kept below the slowdown → RG-09.
- Slope checked before the pause (division by `P − S = 0`) → RG-10.

## Where the result is visible

Safe behaviour: on an idle instance derived figures (Tools/MCP, costs, OTEL tabs, gzip copies,
workflows) appear right after an upload; under load they lag (the session view shows the
"Some figures may lag behind" notice) and catch up within `REBUILD_HARD_CAP_MS` plus one rebuild.
