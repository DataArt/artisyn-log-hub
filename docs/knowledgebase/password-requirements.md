---
type: "Reference"
title: "Password Requirements (Mode 2 / Mode 3)"
description: "Password strength rules enforced under Mode 2 (password) and Mode 3 (password-confirm): the PASSWORD_POLICY levels, exact thresholds, where enforcement runs, and how to change it."
tags:
  - auth
timestamp: "2026-08-20T00:00:00+04:00"
---

# Password Requirements (Mode 2 / Mode 3)

Applies whenever `AUTH_MODE` is `password` (Mode 2) or `password-confirm` (Mode 3) — both modes
authenticate with a local password, so both are governed by the same strength rule. See
[Authorization and Authentication](authorization-and-authentificaiton.md) for the full auth-mode
picture.

## Where the rule lives

`PASSWORD_POLICY` (env var: `any` | `mid` | `long`, default `long`) selects the rule, enforced by a
single function — `applyPasswordPolicy()` in `server/src/auth/utils/password-policy.ts`. It is
called from every place a Mode 2/3 password is set or replaced:

- `POST /api/v1/auth/signup`
- `POST /api/v1/auth/reset-password`
- `POST /api/v1/auth/change-password`

A password failing the active policy gets `400 { error: 'weak_password', message: '...' }`. The
128-character upper bound is a separate, fixed `@MaxLength(128)` DTO check — it applies regardless
of policy and is not part of `applyPasswordPolicy()`.

## Current thresholds

| Policy | Minimum length | Required character classes |
|---|---|---|
| `any` | 2 | none |
| `mid` | 10 | at least one digit |
| `long` (default) | 14 | at least one digit, one punctuation character, one uppercase, one lowercase letter |

`any` exists as a deliberate escape hatch for local/dev/test installs, not a real-world security
posture — it is intentionally left permissive.

## Test environments

- **Playwright e2e (password modes)** drives the running dev server and logs in as
  `muaddib@arrakis.test` / `12345678` (`tests/e2e/helpers/credentials.ts`). That 8-character
  password fails `mid` and `long`, so the dev server must run with **`PASSWORD_POLICY=any`** (and
  `AUTH_RATE_LIMIT_POINTS=0`, so repeated signups/resets in the suite are not rate-limited) in
  `server/.env`. After changing either value, restart the dev server.
- **The contract suite and the scenario stand** do not depend on the dev server's setting: `server/test/contract/setup/global-setup.ts` and the scenario stand (`tests/scenarios/modes.ts`)
  pin `PASSWORD_POLICY=long`.

The `mid` and `long` thresholds set the strength floor for installs running Mode 2/3 in anything
resembling a real deployment. **A policy applies only to passwords set from then on** (new signups,
password resets, password changes): existing password hashes are never touched or invalidated by a
policy change, so raising the threshold never forces current users to change their password.

## Changing the thresholds

Edit the `mid`/`long` cases in `applyPasswordPolicy()` directly — there's no separate config layer
for the numeric thresholds, only the three named levels. If you change a threshold, update the
examples in [algorithms/password-policy.md](algorithms/password-policy.md) alongside it: they are the
test cases of `server/src/auth/utils/password-policy.algo.spec.ts`, several passwords there are
sized right at the boundary, and they will start failing/passing incorrectly if the numbers move
without the doc moving too.
