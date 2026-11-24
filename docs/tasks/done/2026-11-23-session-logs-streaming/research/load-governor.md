---
type: "Research"
title: "FR-6 load signal and rebuild slowdown curve"
description: "Choice of the CPU load signal (Windows, Linux, containers) and the slowdown / pause / hard-cap curve for background rebuilds."
---

# FR-6 load signal and rebuild slowdown curve (2026-11-23)

## Load signal

- `os.loadavg()` is always `[0,0,0]` on Windows and counts runnable threads, not CPU share → rejected.
- `process.cpuUsage()` sees only the own worker (3–15 workers per instance) → rejected as the only signal.
- **Chosen:** system CPU busy share from `os.cpus()` time deltas (works on Windows, Linux, macOS), sampled
  every `REBUILD_LOAD_SAMPLE_MS`, combined with the cgroup v2 limit when present: when
  `/sys/fs/cgroup/cpu.max` holds a quota, busy share = Δ`usage_usec` (`/sys/fs/cgroup/cpu.stat`) /
  (quota/period × Δt). The signal is `max(host share, cgroup share)`, smoothed as the mean of the last
  3 samples. A container limited to 1 CPU on a 4-core host is therefore seen as loaded when it uses its
  1 CPU, which `os.cpus()` alone would report as 25 %.
- Each worker samples on its own (cheap, a few syscalls); no cross-worker coordination.

## Curve (pure function, algorithm doc `rebuild-load-governor`)

Inputs: load `L` (0–100), `now`, `pausedSince` (null or ms), thresholds `S` = slowdown % (default 60),
`P` = pause % (default 99), `H` = hard cap ms (default 300 000), `D` = max delay ms (default 10 000).

| Condition | Decision |
|---|---|
| `L < S` | run now, `pausedSince = null` |
| `S ≤ L < P` | wait `D × (L − S) / (P − S)` ms (rounded down), then run; `pausedSince = null` |
| `L ≥ P` and (`pausedSince` null) | pause (re-check after one sample), `pausedSince = now` |
| `L ≥ P` and `now − pausedSince < H` | pause |
| `L ≥ P` and `now − pausedSince ≥ H` | run now (drain mode); `pausedSince` stays until the worker reports no waiting work, then resets |

- Below the slowdown threshold nothing changes compared to today → an idle instance rebuilds right after
  the upload.
- Rebuilds are never dropped: a paused job keeps its queue rows / stale markers.
- Drain mode guarantees convergence while load stays at 99 %+: after `H` every deferred item runs.
