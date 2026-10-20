# GS-08 windows

One root session on `fix/windows` (claude-sonnet-4-6), repo root `C:\work\acme-shop`, W2 Wednesday.

| # | Call | Path as logged | diff | written |
|---|---|---|---|---|
| 1 | Edit | `C:\work\acme-shop\api\users.ts` | +5 −1 | 5 |
| 2 | Edit | `C:\work\acme-shop\web\Cart.tsx` | +8 −3 | 8 |
| 3 | Edit | `c:/work/acme-shop/web/Cart.tsx` (same file) | +2 −0 | 3 |
| 4 | Write | `C:\work\acme-shop\db\migrations\001_init.sql` | +30 | 30 |
| 5 | Edit | `C:\work\acme-shop\infra\deploy.yml` | +2 −2 | 2 |
| 6 | Edit | `C:\work\acme-shop\docs\changelog.md` | +4 −0 | 5 |
| 7 | Write | `C:\work\acme-shop\scripts\seed.js` | +10 | 10 |
| 8 | Write | `C:\Users\dev\.claude\plans\p.md` (outside the repo) | +12 | 12 |

- Session lines: written 75, diff +73 / −6, 8 Edit/Write calls; in-repo only +61 / −6.
- Change surface: 6 files, 6 folders, 6 modules, concentration 8, scattered; 1 file outside the repo.
- Tokens 2000 / 1000 / 5000 / 2000 (5m) → **$0.0300**; Bash `git commit` → 1 commit; work time
  60 + 40 = **100 s**.

Checks: Windows path normalisation (drive case, slashes), scattered change surface and its three
Summary detectors, outside-repo files, written vs diff lines.

Dates are written relative to `A` = Monday 2026-01-05 (W1 = 05–11 Jan, W2 = 12–18 Jan); the
loader (`tests/scenarios/helpers/golden.ts`) shifts every timestamp by whole days. `{{RUN}}` and
`{{REPO}}` are placeholders the loader replaces. The numbers here are documentation; the contract is
`expected.json` (DD D3) and `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` §2.3.
