# One-page PDF check — what was verified (2026-11-13)

Question: can `@S-SITE-01` assert "the one-pager prints to exactly one landscape page" without a
PDF library, and does an emulated dark color scheme really reach print media?

Checked with a throw-away script (Playwright Chromium from the repo's `@playwright/test`, headless,
`page.setContent` with 1, 2 and 3 full-height blocks, `@page { size: landscape; margin: 10mm }`):

| Check | Result |
|---|---|
| `page.pdf({ format: 'A4', landscape: true })` and `format: 'Letter'`, page objects counted with `/\/Type\s*\/Page(?![a-zA-Z])/g` over `buffer.toString('latin1')` | 1 / 2 / 3 blocks → 1 / 2 / 3 matches, for both formats. The regex is a reliable page counter for Chromium's PDF output (page dictionaries are not compressed; `/Pages` is excluded by the lookahead). |
| `page.emulateMedia({ colorScheme: 'dark', media: 'print' })`, a token set under `@media (prefers-color-scheme: dark)` | The dark value is still active in print (`--bg` = `#000`). So print is **not** light by itself. |
| Same, plus the token re-declared under `@media print` later in the cascade | The print value wins (`--bg` = `#fff`). |

Consequences for the plan:

- The scenario counts PDF pages with the regex above; no new dependency.
- The one-pager's own stylesheet must re-declare the light tokens under `@media print` (FR-4), and
  the scenario can assert it by comparing `getComputedStyle(document.body)` colors under
  `media: 'print'` with `colorScheme: 'light'` and `'dark'` — they must be equal.
- Printable area at 10 mm margins: A4 landscape 277 × 190 mm ≈ 1047 × 718 CSS px, Letter landscape
  259.4 × 195.9 mm ≈ 980 × 740 CSS px. The screen layout is designed for 1280 × 720, so print needs
  the same layout at about 0.75 scale: every size on the sheet is in `em` and print lowers the
  sheet's `font-size` from 16 px to 12 px.

Screenshot choice (FR-2 "a cost or overview view a manager reads at a glance"): of the files in
`site/assets/shots/`, `spend-budget.png` (743 × 570, caption `Repository → Spend`) — a monthly
budget bar, burn rate, forecast, "runs out in" and daily spend; no e-mail, name or path on it.
`cost-by-branch.png` (1115 × 360) was the alternative; it needs the branch legend to be read and is
too wide for a column of a landscape sheet.
