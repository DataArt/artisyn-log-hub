---
type: "Research"
title: "OKF v0.3 front-matter scan of Log Hub's own bundles"
description: "Applies the planned FR-6 line-regex parse to this repo's real v0.3 bundles: meta size, hint counts, okf_version offsets, and the size-guard and FR-8 decisions that follow."
---

# Front-matter scan (2026-11-20)

Script: `research/meta-scan.mjs` (`node research/meta-scan.mjs <projectRoot>`). It reimplements the
parse rules of FR-6 (8192-byte head, `---` block, top-level `key: value` lines, scalar
normalisation: trim, strip ` #` comment, strip one pair of quotes, `''`/`null`/`~` = absent, cap
200 chars) and the FR-7 hint rules, then reports per bundle.

## Result (repo root, 2026-11-20)

| bundle | okf_version | offset of `okf_version` line | files | reserved (index/log) | articles | meta bytes avg / max | articles with hints |
|---|---|---|---|---|---|---|---|
| docs/knowledgebase | 0.3 | 4 | 127 | 2 | 125 | 82.4 / 91 | 0 |
| docs/product-kb | 0.3 | 4 | 41 | 1 | 40 | 78.7 / 80 | 0 |
| docs/product-kb/competitive-watch | 0.3 | 4 | 2 | 0 | 2 | 80 / 80 | 0 |
| docs/kb-local (personal) | 0.3 | 4 | 3 | 0 | 3 | 77.3 / 78 | 0 |

- `meta` as serialized JSON (3 booleans + present scalar keys) costs ~80 bytes per article on a
  real KB. At the hook's `OKF_SNAPSHOT_MAX_FILES = 20000` that is 20000 × 82.4 = 1 648 000 bytes
  (~1.57 MiB) — far below `OKF_SNAPSHOT_MAX_BYTES` (10 MiB).
- Worst case (every scalar at the 200-char cap): 4 × 200 chars + keys + booleans ≈ 900 bytes per
  file → 20000 × 900 = 18 000 000 bytes, over 10 MiB → the server would reject the body and the
  hook would resend it every upload. Hence the hook-side budget guard (plan DD-H5): when the
  serialized snapshot exceeds `OKF_SNAPSHOT_META_BUDGET_BYTES` = 8 MiB, the hook drops every new
  field and sends today's shape.
- `competitive-watch` has a bundle-root `description` that hits exactly the 200-char cap — the cap
  is reachable on real data, so the bundle-card description must truncate/wrap gracefully.
- No article in these bundles currently triggers a hint and none is deprecated or has
  `stale_after`, so scenario fixtures must create those cases themselves.
- Every `okf_version` sits at byte 4 (first key) here, so this repo never exercised the 512-byte
  window; OS-07 `d` in `okf-snapshot.json` (byte 521) is the existing row that flips with 8192.

## FR-8 version rule (from the user's "assume semver")

After quote stripping the raw `okfVersion` must match `^\d+\.\d+(\.\d+)?$` to be a version
(`MAJOR.MINOR[.PATCH]`); anything else — absent, `foo`, bare `1` — is "not a version" → hint.
A version gets the hint when `(major, minor) < (0, 3)` compared numerically. So `0.3`, `"0.3"`,
`0.3.1`, `0.10`, `1.0` → no hint; absent, `0.1`, `0.2`, `1`, `foo` → hint. This also matches the
acceptance criterion that numeric `1` shows the hint.
