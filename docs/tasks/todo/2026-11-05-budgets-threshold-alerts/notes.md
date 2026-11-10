# Notes: Budgets, Spend Forecasts and Cost Slices

## 2026-11-09

- Original scope (2026-11-05): set a spend budget per user / team / repository and day / week / month,
  alert at 50 / 80 / 100 %, show burn rate and a forecast to period end.
- Reworked 2026-11-09 as display-only after the user's note ("we cannot limit, but we can show
  different slices, forecasts and so on") and the competitor study in
  `docs/product-kb/competitive-research/budgets-forecasts-waiting.md` and `beezi.md`.
- PoC [`docs/pocs/2026-11-09-2049-statusline-quota-capture/`](../../../pocs/2026-11-09-2049-statusline-quota-capture/README.md):
  the real subscription quota (5-hour / 7-day window % used and reset time) is readable, but only from
  the status-line input of interactive sessions of Pro / Max / Team subscribers — not from hooks, OTel
  or `claude -p`. Capturing it needs a status-line wrapper in the hook that keeps the user's own status
  line.
