---
reviewed: no
reviewer: none
---

# Site example dataset

## Purpose

The site (Home, Features) and the deck show one fictional example — an average $8 session, $144 a day,
$2,880 a month for a team of six. Every figure comes from `site/data/example-dataset.json`, so the
pages never disagree with each other, and the arithmetic between the figures is checked at build
time so a reader who multiplies them gets the same numbers.

## Code

- Implementation: `scripts/site/dataset.mjs` (`checkDataset`, `fillPlaceholders`); caller
  `scripts/site/build-site.mjs`, which fails the build on any error.
- Twins: none.
- Test: `scripts/__tests__/site-example-dataset.algo.test.js` (`npm run test:scripts`).

## Input and output

The dataset (money in USD numbers):
`team { developers, workingDays, period }`, `session { total, parts { … }, tokens { … },
contextRereadPct }`, `daily { sessions, total }`, `monthly { total }`, an optional `insight`
block (the Home "what to do about it" figure: `turns`, `systemContextTokens`,
`unusedContextTokens`, `unusedContextPct`, `subAgentsPct`, `trimPerSession`, `trimMonthly`, plus
comparison figures no rule checks), plus `tools` rows that no rule checks. A placeholder is `{{ds:<dot.path>}}` or `{{ds:<dot.path>|<format>}}`.

## Rules

**`checkDataset(ds)`** returns an array of error strings, `[]` when the set is consistent. With
`EPS = 0.005` and `fmt2(n)` = `n` with two decimals:

1. `|Σ session.parts − session.total| > EPS` →
   `session.parts sum <fmt2(Σ)> != session.total <fmt2(total)>`.
2. `|daily.total − daily.sessions × session.total| > EPS` →
   `daily.total <fmt2(daily.total)> != daily.sessions × session.total <fmt2(product)>`.
3. `|monthly.total − team.workingDays × daily.total| > EPS` →
   `monthly.total <fmt2(monthly.total)> != team.workingDays × daily.total <fmt2(product)>`.
4. `session.contextRereadPct ≠ round(100 × tokens.cacheRead / Σ session.tokens)` →
   `session.contextRereadPct <pct> != round(100 × cacheRead / Σ tokens) <expected>`.

Rules 5–8 run only when `insight` is present. If any of its seven checked fields is missing or not a
number → one error `insight must have numbers turns, systemContextTokens, unusedContextTokens,
unusedContextPct, subAgentsPct, trimPerSession, trimMonthly`, and rules 5–8 are skipped.

5. `insight.unusedContextPct ≠ round(100 × unusedContextTokens / systemContextTokens)` →
   `insight.unusedContextPct <pct> != round(100 × unusedContextTokens / systemContextTokens) <expected>`.
6. `insight.subAgentsPct ≠ round(100 × session.parts.subAgents / session.total)` →
   `insight.subAgentsPct <pct> != round(100 × parts.subAgents / session.total) <expected>`.
7. `|insight.trimPerSession − unusedContextTokens × turns × parts.cacheRead / tokens.cacheRead| > EPS`
   (the unused system context re-read every turn, priced at this session's cache-read price) →
   `insight.trimPerSession <fmt2(stored)> != unusedContextTokens × turns × cache-read price <fmt2(computed)>`.
8. `insight.trimMonthly ≠ round(trimPerSession × daily.sessions × team.workingDays)` (stored
   `trimPerSession`) →
   `insight.trimMonthly <stored> != round(trimPerSession × daily.sessions × team.workingDays) <expected>`.

Errors are listed in that order; every rule is checked, so one wrong figure can raise more than
one error (rule 3 uses the stored `daily.total`, not the product). A missing or non-numeric field
gives a "must be numbers" error for its rule instead.

**`fillPlaceholders(text, ds)`** replaces every placeholder; text outside placeholders is unchanged.
The value is looked up by the dot path (`session.tokens.cacheRead`).

1. Path not in the dataset → throws `unknown dataset key: <path>`.
2. No format: an integer gets a comma every three digits (`1560000` → `1,560,000`), another number
   is printed as-is, a string as-is; an object or array → throws `unknown dataset key: <path>`.
3. `usd`: `$` + thousands separator + two decimals (`2880` → `$2,880.00`).
4. `usd0`: `$` + thousands separator, rounded to no decimals (`8` → `$8`).
5. `pct`: rounded to no decimals + `%` (`78` → `78%`).
6. Any other format → throws `unknown format: <format>`.

## Edge cases

- A consistent dataset (an earlier version of the shipped one): SED-01.
- Parts off by 0.01 fails, off by 0.004 is within `EPS`: SED-02, SED-03.
- Daily mismatch (`daily.sessions` changed, monthly still right): SED-04.
- Monthly mismatch: SED-05. Reread percentage mismatch: SED-06.
- Raw integer with grouping, raw string, raw non-integer: SED-07, SED-08, SED-09.
- `usd`, `usd0`, `pct`: SED-10, SED-11, SED-12. Several placeholders in one text: SED-13.
- Unknown path, object path, unknown format: SED-14, SED-15, SED-16.
- Insight block consistent: SED-17. Unused-context share, sub-agent share wrong: SED-18, SED-19.
  Wrong trim per session also breaks the monthly figure: SED-20. Incomplete block: SED-21.

## Examples

`input.fn` is the exported function to call and `input.args` its argument list; `expected.result`
is its exact return value, or `expected.error` the message of the error it throws. `D` below is
a consistent dataset (an earlier version of the shipped one, without `tools`):
`{"team":{"developers":6,"workingDays":20,"period":"one month"},"session":{"total":8,"parts":{"input":0.62,"output":1.94,"cacheRead":2.16,"cacheWrite":1.48,"subAgents":1.8},"tokens":{"input":42000,"output":18000,"cacheRead":1560000,"cacheWrite":380000},"contextRereadPct":78},"daily":{"sessions":18,"total":144},"monthly":{"total":2880}}`;
the `checkDataset` rows spell it out with one field changed.

```examples
[
  {"id":"SED-01","input":{"fn":"checkDataset","args":[{"team":{"developers":6,"workingDays":20,"period":"one month"},"session":{"total":8,"parts":{"input":0.62,"output":1.94,"cacheRead":2.16,"cacheWrite":1.48,"subAgents":1.8},"tokens":{"input":42000,"output":18000,"cacheRead":1560000,"cacheWrite":380000},"contextRereadPct":78},"daily":{"sessions":18,"total":144},"monthly":{"total":2880}}]},"expected":{"result":[]},"note":"Parts 0.62+1.94+2.16+1.48+1.80 = 8.00; daily 18 × 8 = 144; monthly 20 × 144 = 2880; tokens 42000+18000+1560000+380000 = 2000000, 100 × 1560000 / 2000000 = 78. No error."},
  {"id":"SED-02","input":{"fn":"checkDataset","args":[{"team":{"developers":6,"workingDays":20,"period":"one month"},"session":{"total":8,"parts":{"input":0.63,"output":1.94,"cacheRead":2.16,"cacheWrite":1.48,"subAgents":1.8},"tokens":{"input":42000,"output":18000,"cacheRead":1560000,"cacheWrite":380000},"contextRereadPct":78},"daily":{"sessions":18,"total":144},"monthly":{"total":2880}}]},"expected":{"result":["session.parts sum 8.01 != session.total 8.00"]},"note":"input 0.63: parts sum 8.01, |8.01 − 8| = 0.01 > 0.005, rule 1."},
  {"id":"SED-03","input":{"fn":"checkDataset","args":[{"team":{"developers":6,"workingDays":20,"period":"one month"},"session":{"total":8,"parts":{"input":0.624,"output":1.94,"cacheRead":2.16,"cacheWrite":1.48,"subAgents":1.8},"tokens":{"input":42000,"output":18000,"cacheRead":1560000,"cacheWrite":380000},"contextRereadPct":78},"daily":{"sessions":18,"total":144},"monthly":{"total":2880}}]},"expected":{"result":[]},"note":"input 0.624: parts sum 8.004, |8.004 − 8| = 0.004 <= 0.005, within EPS."},
  {"id":"SED-04","input":{"fn":"checkDataset","args":[{"team":{"developers":6,"workingDays":20,"period":"one month"},"session":{"total":8,"parts":{"input":0.62,"output":1.94,"cacheRead":2.16,"cacheWrite":1.48,"subAgents":1.8},"tokens":{"input":42000,"output":18000,"cacheRead":1560000,"cacheWrite":380000},"contextRereadPct":78},"daily":{"sessions":17,"total":144},"monthly":{"total":2880}}]},"expected":{"result":["daily.total 144.00 != daily.sessions × session.total 136.00"]},"note":"17 × 8 = 136 != 144, rule 2. Rule 3 uses the stored daily.total 144: 20 × 144 = 2880 matches."},
  {"id":"SED-05","input":{"fn":"checkDataset","args":[{"team":{"developers":6,"workingDays":20,"period":"one month"},"session":{"total":8,"parts":{"input":0.62,"output":1.94,"cacheRead":2.16,"cacheWrite":1.48,"subAgents":1.8},"tokens":{"input":42000,"output":18000,"cacheRead":1560000,"cacheWrite":380000},"contextRereadPct":78},"daily":{"sessions":18,"total":144},"monthly":{"total":2900}}]},"expected":{"result":["monthly.total 2900.00 != team.workingDays × daily.total 2880.00"]},"note":"20 × 144 = 2880 != 2900, rule 3."},
  {"id":"SED-06","input":{"fn":"checkDataset","args":[{"team":{"developers":6,"workingDays":20,"period":"one month"},"session":{"total":8,"parts":{"input":0.62,"output":1.94,"cacheRead":2.16,"cacheWrite":1.48,"subAgents":1.8},"tokens":{"input":42000,"output":18000,"cacheRead":1560000,"cacheWrite":380000},"contextRereadPct":80},"daily":{"sessions":18,"total":144},"monthly":{"total":2880}}]},"expected":{"result":["session.contextRereadPct 80 != round(100 × cacheRead / Σ tokens) 78"]},"note":"round(100 × 1560000 / 2000000) = 78 != 80, rule 4."},
  {"id":"SED-07","input":{"fn":"fillPlaceholders","args":["{{ds:session.tokens.cacheRead}} tokens",{"session":{"tokens":{"cacheRead":1560000}}}]},"expected":{"result":"1,560,000 tokens"},"note":"No format, integer: commas every three digits; the text after the placeholder stays."},
  {"id":"SED-08","input":{"fn":"fillPlaceholders","args":["per {{ds:team.period}}",{"team":{"period":"one month"}}]},"expected":{"result":"per one month"},"note":"No format, string: as-is."},
  {"id":"SED-09","input":{"fn":"fillPlaceholders","args":["{{ds:session.parts.cacheRead}}",{"session":{"parts":{"cacheRead":2.16}}}]},"expected":{"result":"2.16"},"note":"No format, non-integer number: printed as-is."},
  {"id":"SED-10","input":{"fn":"fillPlaceholders","args":["{{ds:monthly.total|usd}}",{"monthly":{"total":2880}}]},"expected":{"result":"$2,880.00"},"note":"usd: $ + 2,880 + .00."},
  {"id":"SED-11","input":{"fn":"fillPlaceholders","args":["{{ds:session.total|usd0}}",{"session":{"total":8}}]},"expected":{"result":"$8"},"note":"usd0: $ + 8, no decimals."},
  {"id":"SED-12","input":{"fn":"fillPlaceholders","args":["{{ds:session.contextRereadPct|pct}}",{"session":{"contextRereadPct":78}}]},"expected":{"result":"78%"},"note":"pct: 78 + %."},
  {"id":"SED-13","input":{"fn":"fillPlaceholders","args":["{{ds:daily.sessions}} sessions × {{ds:session.total|usd0}} = {{ds:daily.total|usd}}",{"session":{"total":8},"daily":{"sessions":18,"total":144}}]},"expected":{"result":"18 sessions × $8 = $144.00"},"note":"Three placeholders, each by its own rule: 18 raw, $8 usd0, $144.00 usd."},
  {"id":"SED-14","input":{"fn":"fillPlaceholders","args":["{{ds:session.nope|usd}}",{"session":{"total":8}}]},"expected":{"error":"unknown dataset key: session.nope"},"note":"Rule 1: session has no key nope."},
  {"id":"SED-15","input":{"fn":"fillPlaceholders","args":["{{ds:session.parts}}",{"session":{"parts":{"input":0.62}}}]},"expected":{"error":"unknown dataset key: session.parts"},"note":"Rule 2: the path names an object, not a figure."},
  {"id":"SED-16","input":{"fn":"fillPlaceholders","args":["{{ds:session.total|eur}}",{"session":{"total":8}}]},"expected":{"error":"unknown format: eur"},"note":"Rule 6: eur is not usd, usd0 or pct."},
  {"id":"SED-17","input":{"fn":"checkDataset","args":[{"team":{"developers":6,"workingDays":20,"period":"one month"},"session":{"total":8,"parts":{"input":0.62,"output":1.94,"cacheRead":2.16,"cacheWrite":1.48,"subAgents":1.8},"tokens":{"input":42000,"output":18000,"cacheRead":1560000,"cacheWrite":380000},"contextRereadPct":78},"daily":{"sessions":18,"total":144},"monthly":{"total":2880},"insight":{"turns":65,"systemContextTokens":14400,"unusedContextTokens":9600,"unusedContextPct":67,"subAgentsPct":23,"trimPerSession":0.86,"trimMonthly":310}}]},"expected":{"result":[]},"note":"Insight block present and consistent: 100 × 9600 / 14400 = 66.7 → 67; 100 × 1.80 / 8 = 22.5 → 23; 9600 × 65 × 2.16 / 1560000 = 0.864, |0.86 − 0.864| <= 0.005; round(0.86 × 18 × 20) = round(309.6) = 310. No error."},
  {"id":"SED-18","input":{"fn":"checkDataset","args":[{"team":{"developers":6,"workingDays":20,"period":"one month"},"session":{"total":8,"parts":{"input":0.62,"output":1.94,"cacheRead":2.16,"cacheWrite":1.48,"subAgents":1.8},"tokens":{"input":42000,"output":18000,"cacheRead":1560000,"cacheWrite":380000},"contextRereadPct":78},"daily":{"sessions":18,"total":144},"monthly":{"total":2880},"insight":{"turns":65,"systemContextTokens":14400,"unusedContextTokens":9600,"unusedContextPct":60,"subAgentsPct":23,"trimPerSession":0.86,"trimMonthly":310}}]},"expected":{"result":["insight.unusedContextPct 60 != round(100 × unusedContextTokens / systemContextTokens) 67"]},"note":"Rule 5: 100 × 9600 / 14400 rounds to 67, not 60."},
  {"id":"SED-19","input":{"fn":"checkDataset","args":[{"team":{"developers":6,"workingDays":20,"period":"one month"},"session":{"total":8,"parts":{"input":0.62,"output":1.94,"cacheRead":2.16,"cacheWrite":1.48,"subAgents":1.8},"tokens":{"input":42000,"output":18000,"cacheRead":1560000,"cacheWrite":380000},"contextRereadPct":78},"daily":{"sessions":18,"total":144},"monthly":{"total":2880},"insight":{"turns":65,"systemContextTokens":14400,"unusedContextTokens":9600,"unusedContextPct":67,"subAgentsPct":22,"trimPerSession":0.86,"trimMonthly":310}}]},"expected":{"result":["insight.subAgentsPct 22 != round(100 × parts.subAgents / session.total) 23"]},"note":"Rule 6: 100 × 1.80 / 8 = 22.5 rounds to 23, not 22."},
  {"id":"SED-20","input":{"fn":"checkDataset","args":[{"team":{"developers":6,"workingDays":20,"period":"one month"},"session":{"total":8,"parts":{"input":0.62,"output":1.94,"cacheRead":2.16,"cacheWrite":1.48,"subAgents":1.8},"tokens":{"input":42000,"output":18000,"cacheRead":1560000,"cacheWrite":380000},"contextRereadPct":78},"daily":{"sessions":18,"total":144},"monthly":{"total":2880},"insight":{"turns":65,"systemContextTokens":14400,"unusedContextTokens":9600,"unusedContextPct":67,"subAgentsPct":23,"trimPerSession":0.9,"trimMonthly":310}}]},"expected":{"result":["insight.trimPerSession 0.90 != unusedContextTokens × turns × cache-read price 0.86","insight.trimMonthly 310 != round(trimPerSession × daily.sessions × team.workingDays) 324"]},"note":"Rule 7: 0.90 is 0.036 off 0.864; rule 8 then uses the stored 0.90: round(0.90 × 360) = 324 != 310 — two errors."},
  {"id":"SED-21","input":{"fn":"checkDataset","args":[{"team":{"developers":6,"workingDays":20,"period":"one month"},"session":{"total":8,"parts":{"input":0.62,"output":1.94,"cacheRead":2.16,"cacheWrite":1.48,"subAgents":1.8},"tokens":{"input":42000,"output":18000,"cacheRead":1560000,"cacheWrite":380000},"contextRereadPct":78},"daily":{"sessions":18,"total":144},"monthly":{"total":2880},"insight":{"turns":65,"systemContextTokens":14400,"unusedContextTokens":9600,"unusedContextPct":67,"subAgentsPct":23,"trimPerSession":0.86}}]},"expected":{"result":["insight must have numbers turns, systemContextTokens, unusedContextTokens, unusedContextPct, subAgentsPct, trimPerSession, trimMonthly"]},"note":"Insight block without trimMonthly: one \"must have numbers\" error, rules 5-8 skipped."}
]
```

## Mutations

- Comparing the parts sum with `===` instead of `EPS` -> SED-03.
- Checking monthly against `workingDays × sessions × total` instead of the stored `daily.total`
  -> SED-04 (would report a second error).
- Leaving `cacheRead` out of `Σ tokens` (1560000 / 440000 = 355 %) -> SED-01.
- No thousands separator -> SED-07, SED-10.
- Two decimals for `usd0` -> SED-11.
- Printing `[object Object]` for an object path, or an empty string for an unknown path ->
  SED-14, SED-15; silently leaving an unknown format -> SED-16.

## Where the result is visible

The figures on the site's Home and Features pages and in the deck (all blocks labelled
"Illustrative example"). Safe behaviour: `npm run build:site` exits 1 on an inconsistent dataset
or an unknown placeholder, so a wrong figure never reaches GitHub Pages.
