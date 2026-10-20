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

```examples
[
  {
    "id": "PP-01",
    "input": {"policy":"any","password":"a"},
    "expected": {"accepted":false,"error":"weak_password","message":"must be at least 2 characters"},
    "note": "Rule 2: length 1 < 2."
  },
  {
    "id": "PP-02",
    "input": {"policy": "any", "password": "ab"},
    "expected": {"accepted": true},
    "note": "Rule 2: length 2 >= 2."
  },
  {
    "id": "PP-03",
    "input": {"policy":"mid","password":"short1234"},
    "expected": {"accepted":false,"error":"weak_password","message":"must be at least 10 characters and include a digit"},
    "note": "Rule 3: 9 characters (s,h,o,r,t,1,2,3,4) < 10, although it has a digit."
  },
  {
    "id": "PP-04",
    "input": {"policy": "mid", "password": "nodigitsss"},
    "expected": {"accepted": false, "error": "weak_password"},
    "note": "Rule 3: 10 characters but no digit."
  },
  {
    "id": "PP-05",
    "input": {"policy": "mid", "password": "has1charrr"},
    "expected": {"accepted": true},
    "note": "Rule 3: 10 characters (h,a,s,1,c,h,a,r,r,r) with the digit 1."
  },
  {
    "id": "PP-06",
    "input": {"policy":"long","password":"Aa1!Aa1!Aa1!A"},
    "expected": {"accepted":false,"error":"weak_password","message":"must be at least 14 characters and include a digit, punctuation, and both upper and lower case"},
    "note": "Rule 4: 3 x 'Aa1!' + 'A' = 13 characters < 14; every class is present."
  },
  {
    "id": "PP-07",
    "input": {"policy": "long", "password": "Aa1!Aa1!Aa1!Aa"},
    "expected": {"accepted": true},
    "note": "Rule 4: 3 x 'Aa1!' + 'Aa' = 14 characters, with digit, '!', upper and lower."
  },
  {
    "id": "PP-08",
    "input": {"policy": "long", "password": "Aa!Aa!Aa!Aa!Aaa"},
    "expected": {"accepted": false, "error": "weak_password"},
    "note": "Rule 4: 15 characters, punctuation, upper, lower, but no digit."
  },
  {
    "id": "PP-09",
    "input": {"policy": "long", "password": "Aa1Aa1Aa1Aa1Aaa"},
    "expected": {"accepted": false, "error": "weak_password"},
    "note": "Rule 4: 15 characters, digit, upper, lower, but no punctuation. S-AUTH-03 checks one such password through the API; this row keeps the class-by-class set PP-08..PP-11 complete."
  },
  {
    "id": "PP-10",
    "input": {"policy": "long", "password": "aa1!aa1!aa1!aa!"},
    "expected": {"accepted": false, "error": "weak_password"},
    "note": "Rule 4: 15 characters, digit, punctuation, lower, but no upper letter."
  },
  {
    "id": "PP-11",
    "input": {"policy": "long", "password": "AA1!AA1!AA1!AA!"},
    "expected": {"accepted": false, "error": "weak_password"},
    "note": "Rule 4: 15 characters, digit, punctuation, upper, but no lower letter."
  },
  {
    "id": "PP-12",
    "input": {"policy": "long", "password": "Aa1 Aa1 Aa1 Aa1"},
    "expected": {"accepted": false, "error": "weak_password"},
    "note": "Rule 4: 15 characters with digit, upper, lower; the only non-alphanumeric is the space, which is not punctuation."
  },
  {
    "id": "PP-13",
    "input": {"policy": null, "password": "Aa1!Aa1!Aa1!A"},
    "expected": {"accepted": false, "error": "weak_password"},
    "note": "Rule 1: unset means long; 13 characters < 14 (same password as PP-06)."
  },
  {
    "id": "PP-14",
    "input": {"policy": null, "password": "Aa1!Aa1!Aa1!Aa"},
    "expected": {"accepted": true},
    "note": "Rule 1: unset means long; the 14-character password of PP-07 passes."
  },
  {
    "id": "PP-15",
    "input": {"policy": "", "password": "has1charrr"},
    "expected": {"accepted": false, "error": "weak_password"},
    "note": "Rule 1: empty means long, so the password accepted under mid (PP-05) is rejected: 10 < 14, no punctuation, no upper."
  },
  {
    "id": "PP-16",
    "input": {"policy": "strict", "password": "a"},
    "expected": {"accepted": true},
    "note": "Rule 5: an unknown value checks nothing (startup validation is what refuses it)."
  },
  {
    "id": "PP-17",
    "input": {"policy": "long", "password": "Aa1_Aa1_Aa1_Aa"},
    "expected": {"accepted": true},
    "note": "Rule 4: 14 characters; '_' is the only punctuation and is in the ASCII set (a class built as 'not a word character' would miss it, since '_' is a word character)."
  },
  {
    "id": "PP-18",
    "input": {"policy": "long", "password": "Aa1~Aa1~Aa1~Aa"},
    "expected": {"accepted": true},
    "note": "Rule 4: '~' (end of the last ASCII punctuation range) counts."
  },
  {
    "id": "PP-19",
    "input": {"policy": "long", "password": "Aa1@Aa1@Aa1@Aa"},
    "expected": {"accepted": true},
    "note": "Rule 4: '@' (end of the ':'..'@' range) counts."
  },
  {
    "id": "PP-20",
    "input": {"policy": "long", "password": "Aa1`Aa1`Aa1`Aa"},
    "expected": {"accepted": true},
    "note": "Rule 4: '`' (end of the '['..'`' range) counts."
  },
  {
    "id": "PP-21",
    "input": {"policy": "long", "password": "Aa1\\Aa1\\Aa1\\Aa"},
    "expected": {"accepted": true},
    "note": "Rule 4: the backslash (inside the '['..'`' range) counts; 14 characters."
  },
  {
    "id": "PP-22",
    "input": {"policy": "long", "password": "Aa1€Aa1€Aa1€Aa"},
    "expected": {"accepted": false, "error": "weak_password"},
    "note": "Rule 4: 14 characters, but '€' is not ASCII punctuation, so there is none."
  },
  {
    "id": "PP-23",
    "input": {"policy": "long", "password": "Éa1!Éa1!Éa1!Éa"},
    "expected": {"accepted": false, "error": "weak_password"},
    "note": "Rule 4: 14 characters with digit, '!' and lower 'a', but 'É' is not A-Z: no upper letter."
  },
  {
    "id": "PP-24",
    "input": {"policy": "long", "password": "Aé1!Aé1!Aé1!Aé"},
    "expected": {"accepted": false, "error": "weak_password"},
    "note": "Rule 4: 14 characters with digit, '!' and upper 'A', but 'é' is not a-z: no lower letter."
  },
  {
    "id": "PP-25",
    "input": {"policy": "long", "password": "Aa1!Aa1!Aa1!😀"},
    "expected": {"accepted": true},
    "note": "Length is UTF-16 units: 12 + 2 for the emoji = 14 >= 14, all four classes in 'Aa1!'. Counting code points (13) would reject it."
  },
  {
    "id": "PP-26",
    "input": {"policy": "mid", "password": "1234567890"},
    "expected": {"accepted": true},
    "note": "Rule 3: 10 characters with a digit; mid asks for nothing else, letters are not required."
  },
  {
    "id": "PP-27",
    "input": {"policy": "any", "password": ""},
    "expected": {"accepted": false, "error": "weak_password"},
    "note": "Rule 2: length 0 < 2."
  },
  {
    "id": "PP-28",
    "input": {"policy": "mid", "password": "abcdefghi٣"},
    "expected": {"accepted": false, "error": "weak_password"},
    "note": "Rule 3: 10 characters, but '٣' (Arabic-Indic three) is not 0-9: no digit."
  },
  {
    "id": "PP-29",
    "input": {"policy": "LONG", "password": "a"},
    "expected": {"accepted": true},
    "note": "Rule 5: 'LONG' is not 'long' (exact match), so nothing is checked."
  },
  {
    "id": "PP-30",
    "input": {"policy": "   ", "password": "a"},
    "expected": {"accepted": true},
    "note": "Rule 5: only spaces is not empty, so it is an unknown value and nothing is checked (a running server never sees it: startup rewrites it to long)."
  },
  {
    "id": "PP-31",
    "input": {"policy":"long","password":"Aa1/Aa1/Aa1/Aa"},
    "expected": {"accepted":true},
    "note": "Rule 4: '/' (end of the first range, '!'..'/') is punctuation; 14 characters."
  },
  {
    "id": "PP-32",
    "input": {"policy":"long","password":"Aa1:Aa1:Aa1:Aa"},
    "expected": {"accepted":true},
    "note": "Rule 4: ':' (start of the ':'..'@' range) is punctuation."
  },
  {
    "id": "PP-33",
    "input": {"policy":"long","password":"Aa1[Aa1[Aa1[Aa"},
    "expected": {"accepted":true},
    "note": "Rule 4: '[' (start of the '['..'`' range) is punctuation."
  },
  {
    "id": "PP-34",
    "input": {"policy":"long","password":"Aa1{Aa1{Aa1{Aa"},
    "expected": {"accepted":true},
    "note": "Rule 4: '{' (start of the '{'..'~' range) is punctuation."
  },
  {
    "id": "PP-35",
    "input": {"policy":"long","password":"Za1!Za1!Za1!Za"},
    "expected": {"accepted":true},
    "note": "Rule 4: 'Z' is the only upper letter and is in A-Z (the end of the range)."
  },
  {
    "id": "PP-36",
    "input": {"policy":"long","password":"Az1!Az1!Az1!Az"},
    "expected": {"accepted":true},
    "note": "Rule 4: 'z' is the only lower letter and is in a-z (the end of the range)."
  },
  {
    "id": "PP-37",
    "input": {"policy":"long","password":"Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!"},
    "expected": {"accepted":true},
    "note": "Rule 6: 50 x 'Aa1!' = 200 characters with all four classes; this check has no upper length limit (the 128 cap is the request DTO's)."
  },
  {
    "id": "PP-38",
    "input": {"policy":"mid","password":"abcdefghi0"},
    "expected": {"accepted":true},
    "note": "Rule 3: '0' (start of 0-9) is a digit; 10 characters."
  },
  {
    "id": "PP-39",
    "input": {"policy":"mid","password":"abcdefghi9"},
    "expected": {"accepted":true},
    "note": "Rule 3: '9' (end of 0-9) is a digit; 10 characters."
  },
  {
    "id": "PP-40",
    "input": {"policy":"long","password":"Aa0Aa0Aa0Aa0Aa"},
    "expected": {"accepted":false,"error":"weak_password"},
    "note": "Rule 4: 14 characters; '0' right after '/' is a digit, not punctuation, so there is none."
  },
  {
    "id": "PP-41",
    "input": {"policy":"long","password":"Aa9Aa9Aa9Aa9Aa"},
    "expected": {"accepted":false,"error":"weak_password"},
    "note": "Rule 4: '9' right before ':' is not punctuation: none."
  },
  {
    "id": "PP-42",
    "input": {"policy":"long","password":"Za1Za1Za1Za1Za"},
    "expected": {"accepted":false,"error":"weak_password"},
    "note": "Rule 4: 'Z' right before '[' is not punctuation: none."
  },
  {
    "id": "PP-43",
    "input": {"policy":"long","password":"Az1Az1Az1Az1Az"},
    "expected": {"accepted":false,"error":"weak_password"},
    "note": "Rule 4: 'z' right before '{' is not punctuation: none."
  },
  {
    "id": "PP-44",
    "input": {"policy":"long","password":"Aa1\u007fAa1\u007fAa1\u007fAa"},
    "expected": {"accepted":false,"error":"weak_password"},
    "note": "Rule 4: DEL (0x7F, right after '~') is a control character, not punctuation: none."
  },
  {
    "id": "PP-45",
    "input": {"policy":"long","password":"aa1@aa1@aa1@aa"},
    "expected": {"accepted":false,"error":"weak_password"},
    "note": "Rule 4: '@' right before 'A' is not an upper letter: no upper."
  },
  {
    "id": "PP-46",
    "input": {"policy":"long","password":"aa1[aa1[aa1[aa"},
    "expected": {"accepted":false,"error":"weak_password"},
    "note": "Rule 4: '[' right after 'Z' is not an upper letter: no upper."
  },
  {
    "id": "PP-47",
    "input": {"policy":"long","password":"AA1`AA1`AA1`AA"},
    "expected": {"accepted":false,"error":"weak_password"},
    "note": "Rule 4: '`' right before 'a' is not a lower letter: no lower."
  },
  {
    "id": "PP-48",
    "input": {"policy":"long","password":"AA1{AA1{AA1{AA"},
    "expected": {"accepted":false,"error":"weak_password"},
    "note": "Rule 4: '{' right after 'z' is not a lower letter: no lower."
  },
  {
    "id": "PP-49",
    "input": {"policy":"mid","password":"abcdefghi/"},
    "expected": {"accepted":false,"error":"weak_password"},
    "note": "Rule 3: '/' right before '0' is not a digit: 10 characters, no digit."
  },
  {
    "id": "PP-50",
    "input": {"policy":"mid","password":"abcdefghi:"},
    "expected": {"accepted":false,"error":"weak_password"},
    "note": "Rule 3: ':' right after '9' is not a digit: no digit."
  },
  {
    "id": "PP-51",
    "input": {"policy":"any","password":" a"},
    "expected": {"accepted":true},
    "note": "Rule 2: the password is not trimmed; \" a\" has length 2 (the space counts), so it is accepted. Trimming would leave 1 < 2."
  }
]
```

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
