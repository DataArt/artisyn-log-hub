---
reviewed: 2026-10-15
reviewer: ai
---

# Password policy: which passwords are accepted

## Purpose

Decides whether a new password is strong enough under the install's `PASSWORD_POLICY`. It runs on
sign-up, password change and password reset; a rejected password gets `400 weak_password` and the
user must choose another one. Existing password hashes are never re-checked.

## Code

- Implementation: `server/src/auth/utils/password-policy.ts` (`applyPasswordPolicy`).
- Twins: none. The client only shows the policy text; the server decides.
- Test: `server/src/auth/utils/password-policy.algo.spec.ts`.

## Rules

The policy is read from `PASSWORD_POLICY` at each call and compared exactly (case-sensitive, not
trimmed). Length is the JavaScript string length (UTF-16 code units, so an emoji counts 2).
Character classes, ASCII only:

- digit: `0-9` (not other scripts' digits);
- punctuation: printable ASCII punctuation, i.e. `` !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~ ``
  (not the space, not non-ASCII symbols);
- upper: `A-Z`; lower: `a-z` (`É` and `é` are neither).

1. Unset or empty (`""`) `PASSWORD_POLICY` means `long`.
2. `any`: accepted when the length is at least 2.
3. `mid`: accepted when the length is at least 10 **and** it has a digit.
4. `long`: accepted when the length is at least 14 **and** it has a digit, punctuation, an upper
   and a lower letter.
5. Any other value (including `LONG`, `" mid"` or only spaces) is not checked at all: the
   password is accepted. In a running server this does not happen: the startup validator
   ([auth-startup-config.md](auth-startup-config.md)) refuses any other value and rewrites a
   spaces-only one to `long` before the first request. It only happens in a process that skipped
   startup validation (`NODE_ENV=test`).
6. A rejected password throws `400` with `{"error": "weak_password", "message": ...}`. The
   message is one fixed text per policy, stating all its requirements rather than the one that
   failed: `any` "must be at least 2 characters"; `mid` "must be at least 10 characters and
   include a digit"; `long` "must be at least 14 characters and include a digit, punctuation, and
   both upper and lower case". PP-01, PP-03 and PP-06 pin the message of each policy; the other
   rejected rows pin the `error` code only. There is no upper length limit here (the DTO caps passwords at 128 characters).

## Edge cases

- Length boundaries 1/2, 9/10, 13/14: PP-01..PP-07.
- Each missing class under `long`: PP-08..PP-11.
- Space is not punctuation: PP-12. Punctuation characters tested alone: `!` (PP-07), `/`
  (PP-31), `:` (PP-32), `@` (PP-19), `[` (PP-33), `\` (PP-21), `` ` `` (PP-20), `_` (PP-17),
  `{` (PP-34), `~` (PP-18), i.e. both ends of every ASCII range. A non-ASCII symbol does not
  count: PP-22.
- Characters just outside each range: PP-40..PP-44 (next to the punctuation ranges, DEL
  included), PP-45..PP-48 (next to A-Z and a-z), PP-49, PP-50 (next to 0-9).
- Range ends of the letter and digit classes: `Z` (PP-35), `z` (PP-36), `0` (PP-38), `9`
  (PP-39). No upper length limit: PP-37.
- Non-ASCII letters and digits: PP-23, PP-24, PP-28. UTF-16 length: PP-25.
- `mid` needs no letters: PP-26. Empty password: PP-27. Spaces count toward the length: PP-51.
- Unset and empty policy mean `long`: PP-13, PP-14, PP-15.
- Unknown policy value, wrong case, only spaces: PP-16, PP-29, PP-30.

## Examples

`input.policy` is the value of `PASSWORD_POLICY` (`null` = unset). `expected.accepted` says
whether the password passes; for a rejected one `expected.error` is the `error` code of the
`400` response and, where given, `expected.message` its message.

Rows (51): [`docs/algorithm-examples/password-policy.json`](../../algorithm-examples/password-policy.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- `<=` instead of `<` on a length (minimum off by one) -> PP-02, PP-05, PP-07 (rejected).
- Minimum one higher (`< 3`, `< 11`, `< 15`) -> PP-02, PP-05, PP-07.
- `mid` without the digit check -> PP-04.
- `long` missing one class check -> PP-08 (digit), PP-09 (punctuation), PP-10 (upper),
  PP-11 (lower).
- Punctuation class that includes the space (e.g. `[ -/...]`) -> PP-12.
- Punctuation class cut short (`[!-/]` only) -> PP-18..PP-21, PP-32..PP-34; ranges off by one at
  either end -> PP-31..PP-34, PP-18, PP-20; "anything that is not a word character or space" -> PP-17;
  "anything not a letter or digit" -> PP-22.
- Unicode-aware letter or digit classes -> PP-23, PP-24, PP-28.
- Length in code points -> PP-25.
- Punctuation ranges widened by one character -> PP-40..PP-44; letter or digit ranges widened
  -> PP-45..PP-50.
- Wrong message for a policy -> PP-01, PP-03, PP-06.
- Letter or digit ranges cut at either end (`[A-Y]`, `[a-y]`, `[1-9]`, `[0-8]`) -> PP-35, PP-36,
  PP-38, PP-39.
- An upper length limit added to the policy -> PP-37.
- Password trimmed before checking -> PP-51.
- `mid` also requiring a letter -> PP-26.
- Policy trimmed or lowercased before matching -> PP-29, PP-30.
- No default for an unset or empty policy -> PP-13, PP-15 (accepted).
- Default `mid` instead of `long` -> PP-15.

## Where the result is visible

`400 weak_password` with the policy's `message` from `POST /api/v1/auth/signup`, the
reset-password endpoint and the change-password endpoint. The sign-up and reset pages show the
message under the confirm-password field; the change-password dialog (account menu) shows it as
its error.

## Deployment notes

- The 128-character upper bound is a separate `@MaxLength(128)` DTO check, applied under every
  policy; it is not part of `applyPasswordPolicy()`.
- `any` is a deliberate escape hatch for local / dev / test installs, not a real security
  posture. The legacy e2e suite needs it on the dev server ([test/e2e-tests.md](../test/e2e-tests.md));
  the contract suite and the scenario stand pin `long`.
- A policy change applies only to passwords set from then on; it never forces existing users to
  change their password.
