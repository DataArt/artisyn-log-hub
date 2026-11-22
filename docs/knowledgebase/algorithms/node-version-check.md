---
type: "Algorithm"
title: "Node.js version check"
description: "Claude Code runs the Log Hub hooks with the user's own `node` from `PATH`. Node 18 and 20 and every odd line are end-of-life, and the supported lines 22 / 24 / 26 have a security release (November 2026) whose fixes an older patch level lacks."
tags: [algorithm]
generated: { by: "human:denistsyplakov", at: "2026-11-19T01:29:04+04:00" }
reviewed: no
reviewer: none
---

# Node.js version check

## Purpose

Claude Code runs the Log Hub hooks with the user's own `node` from `PATH`. Node 18 and 20 and every
odd line are end-of-life, and the supported lines 22 / 24 / 26 have a security release (November
2026) whose fixes an older patch level lacks. Since hook `3.0.0` the hook warns the user about it
on `SessionStart` (at most once a day per Node version) and the installer warns on install. The
hooks keep working either way: the check only advises.

## Code

- Implementation: `hook/.claude/telemetry_tool/node-version-check.js` — `classifyNodeVersion`,
  `nodeWarningText`, `shouldShowNodeWarning`, `effectiveNodeVersion`, `checkNodeVersion`
  (constants `NODE_PATCHED_MINIMUMS` = `{22: '22.23.5', 24: '24.22.3', 26: '26.13.1'}`,
  `NODE_ADVISORY` = `'November 2026'`, `NODE_WARNING_INTERVAL_MS` = 86400000,
  `NODE_VERSION_OVERRIDE_ENV` = `ARTISYN_NODE_VERSION_OVERRIDE`). Caller: `lifecycle-hook.js`
  (`SessionStart` `systemMessage`, merged with the OTEL endpoint warning).
- Twins: `artisyn-hooks-installer/src/node-version.ts` — the same table, classification, text and
  override env, without the throttle; used by `warnIfNodeEol` and the "not working yet" text in
  `artisyn-hooks-installer/src/install.ts`. It is TypeScript, so the rows do not run against it:
  keep both copies identical by hand.
- Test: `hook/.claude/telemetry_tool/__tests__/node-version-check.algo.test.js`.
- Design: [../upload-job-queue.md](../upload-job-queue.md) (hook 3.0.0), task
  `docs/tasks/todo/2026-11-18-receiver-upload-queue/` (FR-16, DD-15).

## Input and output

Every row has `input.kind`:

| `kind` | Call | Compared |
|---|---|---|
| `classify` | `classifyNodeVersion(version)` | `{status, line, target}` in full |
| `text` | `nodeWarningText(version)` | `{text}` (a string or `null`) |
| `throttle` | `shouldShowNodeWarning(state, version, now)` | `{show}` |
| `effective` | `effectiveNodeVersion(env)` | `{version}`; `$process` stands for `process.versions.node` of the running Node |

`now` and a numeric `shownAt` are epoch ms; the rows use `now` = 1800000000000.

## Rules

1. **Parse**: the version must start with `N`, `N.N` or `N.N.N` (a leading `v` is allowed); a
   missing minor or patch counts as 0. Anything else → `{status: 'unknown', line: null, target:
   null}`. `line` is the major; `target` is `NODE_PATCHED_MINIMUMS[line]` or `null`.
2. **End-of-life**: (a) major < 22, or (b) an odd major ≤ 26 → `eol` (target `null`).
3. **Unknown**: major > 26 → `unknown` (target `null`); a newer line is not judged. An odd major
   above 26 is `unknown`, not `eol`.
4. **Unpatched**: a major in the table whose `[major, minor, patch]` compares below its minimum
   (numerically, part by part) → `unpatched`.
5. Otherwise → `ok`.
6. **Text** (`nodeWarningText(v)`): `null` for `ok` and `unknown`; else
   `Log Hub: Node.js <v> <problem> — upgrade to Node.js 22.23.5, 24.22.3 or 26.13.1 or newer. Log Hub hooks keep working.`,
   where `<problem>` is `is end-of-life` (`eol`) or `misses the <NODE_ADVISORY> security fixes`
   (`unpatched`), and the targets are the table values in line order, the last one joined with
   `or`.
7. **Throttle** (`shouldShowNodeWarning(state, version, now)`; `state` is
   `~/.artisyn/node-check.json` `{nodeVersion, shownAt}`), show when any of:
   - (a) there is no state (missing or unreadable file);
   - (b) `state.nodeVersion !== version`;
   - (c) `shownAt` (a number, or a parsable date string) is not finite or lies in the future;
   - (d) `now − shownAt ≥ NODE_WARNING_INTERVAL_MS`.
   Otherwise hide. `checkNodeVersion` writes `{nodeVersion, shownAt: now}` atomically each time
   it shows the warning, and never throws (any error → no warning).
8. **Effective version** (`effectiveNodeVersion(env)`): the test-only `ARTISYN_NODE_VERSION_OVERRIDE`,
   trimmed, when not blank; else `process.versions.node`. A leading `v` is dropped.

## Edge cases

- The four end-of-life shapes (old even, old odd, odd supported-era lines): NV-01 … NV-05.
- Each table line one patch below and at its minimum: NV-06/NV-07, NV-09/NV-10, NV-12/NV-11.
- Numeric, not string, comparison of the minor: NV-08.
- Lines above 26, including an odd one: NV-13, NV-14.
- A `v` prefix, garbage and a bare major: NV-15, NV-16, NV-17.
- Warning text per status: NV-18 … NV-21.
- Throttle: no state NV-22; same version young NV-23; 24 h on both sides NV-24, NV-25; version
  changed NV-26; future and unparsable `shownAt` NV-27, NV-28.
- Override env: set NV-29, blank NV-30.

## Examples

Rows (30): [`docs/algorithm-examples/node-version-check.json`](../../algorithm-examples/node-version-check.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- "Odd lines above 26 are eol too" -> NV-14.
- "Minimum compared as strings" -> NV-08.
- "Equal to the minimum is unpatched (`<=`)" -> NV-07, NV-10, NV-11.
- "Throttle with `>` instead of `≥`" -> NV-25.
- "Throttle ignores a Node version change" -> NV-26.
- "A future `shownAt` hides the warning forever" -> NV-27.

## Where the result is visible

The `systemMessage` Claude Code shows on `SessionStart` (one JSON object, merged with the OTEL
warning), `~/.artisyn/node-check.json`, the installer's console warning, and the `nodeVersion`
field of the `hook-status` event.
