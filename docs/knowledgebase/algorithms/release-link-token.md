---
reviewed: 2026-10-15
reviewer: ai
---

# Release link token: who may download a release zip

## Purpose

An admin hands out a download link for a release zip. The link carries the file name, an expiry
and a signature, so it works without a login for 24 hours and cannot be changed to another file,
a later expiry or a path outside the release folder. This rule decides whether a redeemed link is
valid, expired or forged.

## Code

- Implementation: `server/src/releases/release-token.ts` (`verifyReleaseToken`,
  `signReleaseToken`, `RELEASE_ZIP_NAME_RE`; `RELEASE_LINK_TTL_SECONDS = 86400` is applied when a
  link is minted, not here).
- Twins: none.
- Test: `server/src/releases/release-token.algo.spec.ts`.

## Rules

A link has `file`, `exp` (expiry, epoch seconds, as text) and `sig`. The signature is
HMAC-SHA256 over the text `<file>:<exp>`, base64url-encoded, under the release-link key:
`RELEASE_LINK_SECRET` when it is set and non-empty, otherwise a 32-byte HKDF-SHA256 key derived
from `SESSION_SECRET` (an unset one counts as empty; empty salt, info `release-link`), so the session secret itself is never the HMAC key
(`getReleaseLinkKey`).
`verifyReleaseToken(file, exp, sig, key)` checks, in this order, and stops at the first failure:

1. The whole of `file` matches `artisyn-log-hub-<8 digits>-<6 digits>-<amd64|arm64>.zip`
   (case-sensitive, nothing before or after); otherwise `invalid`. This runs before any path is
   built, so `../` never reaches the disk.
2. `exp` is one or more digits and nothing else; otherwise `invalid`.
3. `sig` equals the signature of `<file>:<exp>`: first the byte lengths must be equal, then a
   constant-time compare; otherwise `invalid`. A signature of another length, shorter or longer,
   is `invalid`, not an error.
4. `exp` is read with `Number` (a very long digit string loses precision or becomes
   `Infinity`; there is no upper bound, since only a link the server signed can get here). If
   `exp * 1000 <= now` (milliseconds): `expired`. Only a genuine link can be reported as
   expired.
5. Otherwise `ok`.

The download handler passes a missing or non-string query parameter as `''`, which rules 1-3
refuse. Whether the file still exists on disk is not checked here (the download handler answers a
missing file with `404` afterwards).

## Edge cases

- Expiry exactly now, one second before, one second after: REL-02, REL-03, REL-12.
- Name pattern: traversal, wrong architecture, short date: REL-04, REL-05, REL-06; a valid name
  with something before or after it: REL-13, REL-14, REL-15; time part 5 or 7 digits, date 9
  digits: REL-16, REL-17, REL-18; upper case: REL-19.
- `exp` with a non-digit, or empty: REL-07, REL-20, REL-24, REL-25; with a leading zero: REL-23.
- Empty file name, empty signature: REL-31, REL-32. Far-future and infinite `exp`: REL-33, REL-34. A one-digit `exp`: REL-35.
- Signature with padding added: REL-26. Expiry 1 ms ahead: REL-27. Non-ASCII signature of the
  right character length: REL-28. A trailing newline in `exp` or `file`: REL-29, REL-30.
- A character in place of the dot before `zip`: REL-22.
- Signature for another file, under another key, shorter, longer: REL-08, REL-09, REL-10, REL-21.
- Forged and expired at once: REL-11.

## Examples

`input.now` is the server time in epoch seconds. `input.sign` describes how the row's `sig` is
made: the test computes the genuine signature of `sign.file` (default: the row's `file`) and
`sign.exp` (default: the row's `exp`, used as text) under the key `sign.key` (default
`release-key`): with the real `signReleaseToken` when the text is a plain number it would print
the same way, otherwise with the same HMAC-SHA256 over `<file>:<exp text>`. `sign.extra` is
appended to the signature. Or `input.sig` gives a literal signature. `input.now` may have a
fraction of a second. The server is always verified with the key
`release-key`. `expected.verdict` is `ok`, `expired` or `invalid`.

```examples
[
  {
    "id": "REL-01",
    "input": {"file": "artisyn-log-hub-20261015-120000-amd64.zip", "exp": "1760000000", "sign": {}, "now": 1759990000},
    "expected": {"verdict": "ok"},
    "note": "Rules 1-3 pass (good name, digits, genuine signature); 1760000000 * 1000 > now, so ok."
  },
  {
    "id": "REL-02",
    "input": {"file": "artisyn-log-hub-20261015-120000-amd64.zip", "exp": "1760000000", "sign": {}, "now": 1760000000},
    "expected": {"verdict": "expired"},
    "note": "Rule 4 is inclusive: exp * 1000 = now * 1000, <= holds, expired."
  },
  {
    "id": "REL-03",
    "input": {"file": "artisyn-log-hub-20261015-120000-arm64.zip", "exp": "1760000000", "sign": {}, "now": 1759999999},
    "expected": {"verdict": "ok"},
    "note": "One second before expiry: 1760000000000 > 1759999999000, ok. arm64 is an allowed architecture."
  },
  {
    "id": "REL-04",
    "input": {"file":"../../etc/passwd","exp":"1760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 1: not a release name, invalid even with a genuine signature over it, so a signature can never make a traversal path acceptable. (S-REL-02 checks the HTTP answer. The order among rules 1-3 is not observable, since all three answer invalid; only rule 3 before rule 4 is, see REL-11.)"
  },
  {
    "id": "REL-05",
    "input": {"file": "artisyn-log-hub-20261015-120000-x86.zip", "exp": "1760000000", "sign": {}, "now": 1759990000},
    "expected": {"verdict": "invalid"},
    "note": "Rule 1: architecture must be amd64 or arm64 (also in S-REL-02 over HTTP; kept for the unit-level name rules REL-13..REL-19 build on)."
  },
  {
    "id": "REL-06",
    "input": {"file": "artisyn-log-hub-2026101-120000-amd64.zip", "exp": "1760000000", "sign": {}, "now": 1759990000},
    "expected": {"verdict": "invalid"},
    "note": "Rule 1: the date part has 7 digits, not 8."
  },
  {
    "id": "REL-07",
    "input": {"file": "artisyn-log-hub-20261015-120000-amd64.zip", "exp": "1760000000.5", "sign": {}, "now": 1759990000},
    "expected": {"verdict": "invalid"},
    "note": "Rule 2: '.' is not a digit, invalid before the signature is looked at."
  },
  {
    "id": "REL-08",
    "input": {"file": "artisyn-log-hub-20261015-120000-amd64.zip", "exp": "1760000000", "sign": {"file": "artisyn-log-hub-20261014-120000-amd64.zip"}, "now": 1759990000},
    "expected": {"verdict": "invalid"},
    "note": "Rule 3: the signature binds the file name; one signed for another zip does not match."
  },
  {
    "id": "REL-09",
    "input": {"file": "artisyn-log-hub-20261015-120000-amd64.zip", "exp": "1760000000", "sign": {"key": "another-key"}, "now": 1759990000},
    "expected": {"verdict": "invalid"},
    "note": "Rule 3: signed under another key (S-REL-02 does this over HTTP; here it pins that the key is part of the check, not only the payload)."
  },
  {
    "id": "REL-10",
    "input": {"file": "artisyn-log-hub-20261015-120000-amd64.zip", "exp": "1760000000", "sig": "abc", "now": 1759990000},
    "expected": {"verdict": "invalid"},
    "note": "Rule 3: a 3-character signature has the wrong length: invalid, no exception."
  },
  {
    "id": "REL-11",
    "input": {"file": "artisyn-log-hub-20261015-120000-amd64.zip", "exp": "1760000000", "sign": {"exp": "1760099999"}, "now": 1760050000},
    "expected": {"verdict": "invalid"},
    "note": "Order: the link's exp (1760000000) is past, but the signature was made for another exp, so rule 3 fails first: invalid, not expired."
  },
  {
    "id": "REL-12",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip","exp":"1760000000","sign":{},"now":1760000001},
    "expected": {"verdict":"expired"},
    "note": "Rule 4: one second after expiry, a genuine link is expired."
  },
  {
    "id": "REL-13",
    "input": {"file":"../x/artisyn-log-hub-20261015-120000-amd64.zip","exp":"1760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 1: a valid name with a path before it does not match the whole pattern."
  },
  {
    "id": "REL-14",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip/../../etc/passwd","exp":"1760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 1: a valid name with a path after it does not match the whole pattern."
  },
  {
    "id": "REL-15",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip.exe","exp":"1760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 1: nothing may follow .zip."
  },
  {
    "id": "REL-16",
    "input": {"file":"artisyn-log-hub-20261015-12000-amd64.zip","exp":"1760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 1: the time part has 5 digits, not 6."
  },
  {
    "id": "REL-17",
    "input": {"file":"artisyn-log-hub-20261015-1200000-amd64.zip","exp":"1760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 1: the time part has 7 digits, not 6."
  },
  {
    "id": "REL-18",
    "input": {"file":"artisyn-log-hub-202610150-120000-amd64.zip","exp":"1760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 1: the date part has 9 digits, not 8."
  },
  {
    "id": "REL-19",
    "input": {"file":"artisyn-log-hub-20261015-120000-AMD64.zip","exp":"1760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 1 is case-sensitive: AMD64 is not amd64."
  },
  {
    "id": "REL-20",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip","exp":"","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 2 needs at least one digit. The signature is the genuine one for \"<file>:\" (empty exp), so only rule 2 can reject it; without rule 2 the empty exp would read as 0 and the link would be expired instead of invalid."
  },
  {
    "id": "REL-21",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip","exp":"1760000000","sig":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 3: a base64url HMAC-SHA256 is 43 characters; a 60-character signature has another length: invalid, no exception."
  },
  {
    "id": "REL-22",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64Xzip","exp":"1760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 1: the dot before zip is a literal dot; \"amd64Xzip\" does not match, even with a genuine signature."
  },
  {
    "id": "REL-23",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip","exp":"01760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"ok"},
    "note": "The signature covers exp as text: it is the genuine one for \"<file>:01760000000\", so it verifies; the leading zero does not change the time (1760000000 > now): ok."
  },
  {
    "id": "REL-24",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip","exp":"+1760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 2: \"+\" is not a digit, so this is invalid even with a genuine signature over that text."
  },
  {
    "id": "REL-25",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip","exp":" 1760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 2: a leading space is not a digit: invalid, signature or not."
  },
  {
    "id": "REL-26",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip","exp":"1760000000","sign":{"extra":"="},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 3: the genuine signature plus a padding \"=\" is one byte longer: invalid (base64url signatures carry no padding)."
  },
  {
    "id": "REL-27",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip","exp":"1760000000","sign":{},"now":1759999999.999},
    "expected": {"verdict":"ok"},
    "note": "Rule 4 compares milliseconds: 1760000000000 > 1759999999999, so ok 1 ms before expiry (rounding now up to whole seconds would already say expired)."
  },
  {
    "id": "REL-28",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip","exp":"1760000000","sig":"éaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 3 compares byte lengths: 43 characters, but \"é\" is 2 bytes in UTF-8, so 44 bytes against 43: invalid, no exception."
  },
  {
    "id": "REL-29",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip","exp":"1760000000\n","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 2: the exp text ends in a newline, which is not a digit; invalid even with a genuine signature over that text."
  },
  {
    "id": "REL-30",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip\n","exp":"1760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 1: nothing may follow .zip, not even a newline; invalid even with a genuine signature."
  },
  {
    "id": "REL-31",
    "input": {"file":"","exp":"1760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 1: an empty file name (a missing query parameter arrives as \"\") is not a release name."
  },
  {
    "id": "REL-32",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip","exp":"1760000000","sig":"","now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 3: an empty signature has the wrong length: invalid, no exception."
  },
  {
    "id": "REL-33",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip","exp":"99999999999","sign":{},"now":1759990000},
    "expected": {"verdict":"ok"},
    "note": "Rule 4 has no upper bound: an expiry in the year 5138 is simply in the future: ok."
  },
  {
    "id": "REL-34",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip","exp":"9999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999","sign":{},"now":1759990000},
    "expected": {"verdict":"ok"},
    "note": "Rule 4: 400 nines read with Number are Infinity, and Infinity * 1000 <= now is false: ok (only a link the server signed can carry such an exp)."
  },
  {
    "id": "REL-35",
    "input": {"file":"artisyn-log-hub-20261015-120000-amd64.zip","exp":"1","sign":{},"now":1759990000},
    "expected": {"verdict":"expired"},
    "note": "Rule 2 needs at least one digit, not ten: \"1\" passes, the signature is genuine, and 1 * 1000 <= now: expired (not invalid)."
  },
  {
    "id": "REL-36",
    "input": {"file":"evil-20261015-120000-amd64.zip","exp":"1760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 1: the name must start with the literal artisyn-log-hub-."
  },
  {
    "id": "REL-37",
    "input": {"file":"artisyn-log-hub-20261015_120000-amd64.zip","exp":"1760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 1: date and time are separated by \"-\", not \"_\"."
  },
  {
    "id": "REL-38",
    "input": {"file":"artisyn-log-hub-20261015-120000-riscv64.zip","exp":"1760000000","sign":{},"now":1759990000},
    "expected": {"verdict":"invalid"},
    "note": "Rule 1: only amd64 and arm64; another 64-bit architecture is refused."
  }
]
```

## Mutations

- `<` instead of `<=` for expiry -> REL-02; expired only at the exact second -> REL-12.
- Expiry checked before the signature -> REL-11 (`expired`).
- Name check skipped or loosened (any `.zip`, any architecture) -> REL-04, REL-05, REL-06.
- Pattern without `^` -> REL-13; without `$` -> REL-14, REL-15.
- Time part `\d+` or `\d{5,6}` -> REL-16; `\d{6,7}` -> REL-17; date `\d{8,}` -> REL-18.
- Case-insensitive pattern -> REL-19.
- `exp` pattern allowing empty (`*` for `+`) -> REL-20 (expired instead of invalid).
- Dot in the pattern not escaped -> REL-22. Prefix not checked -> REL-36. Separator loosened ->
  REL-37. Architecture as any `[a-z]+64` -> REL-38.
- Signature checked over `Number(exp)` instead of the text -> REL-23.
- `exp` checked with `Number`/`parseInt` instead of the digit pattern -> REL-07, REL-24, REL-25.
- Patterns with the `m` flag (`$` before a final newline) -> REL-29 (exp), REL-30 (file).
- Signature lengths compared in characters instead of bytes -> REL-28 (the compare would throw).
- Signature compared after stripping `=` padding -> REL-26.
- Expiry compared in whole seconds (`exp <= Math.ceil(now / 1000)`) -> REL-27.
- An upper bound or a finite-number guard on `exp` -> REL-33, REL-34.
- `exp` pattern requiring more than one digit (e.g. 10+) -> REL-35.
- Length check only for shorter signatures -> REL-21 (the compare would throw).
- Signature over `exp` only (in both signer and verifier) -> REL-08.
- Length check missing (`timingSafeEqual` throws) -> REL-10.

## Where the result is visible

`GET /api/v1/releases/download?file=&exp=&sig=`: `ok` streams the zip, `invalid` answers an HTML
page "Invalid download link" with `403`, `expired` a page "Link expired" with `410` (a missing
file `404`). The links are minted in Admin -> System -> Release Downloads.
