# Blocked

## 2026-11-16 — health check `e2e-full` (`npm run test:e2e:full`) failing after 3 launches

**Symptom (deciding run, rc=1, 72 s):** 81 passed, 1 failed:
`tests/e2e/admin-panel.spec.ts:172` "Clicking a column header toggles sort direction indicator".
After the first click on the Repos table's first header (`thead th` first, "Repository"), the
`svg.lucide-arrow-down` icon never appears within 3 s; the `lucide-arrow-up` (initial asc) was
visible right before the click. Artifacts:
`test-results/admin-panel-Admin-Panel-*-sort-direction-indicator-extended/`.

**Not obviously caused by this branch:** `client/src/viewer/pages/admin/AdminDataTable.tsx`,
`client/src/viewer/pages/admin/tabs/AdminReposTab.tsx` and the spec have no uncommitted changes and
no commit since 2026-10-21. The toggle comes from TanStack `getToggleSortingHandler()` on the `<th>`.
Unconfirmed whether it is a pre-existing failure or flaky (no evidence either way, so not
labelled flaky). Next step: run that single spec on `main` against the same backend to compare.

**Environment problems hit on the way (launches 1 and 2, no code at fault):**
- `server/.env` does not exist on this machine, so the dev backend could not start
  (`client password must be a string`). The backend was started with process-only env (no file
  written): root `.env.defaults`, `DATABASE_URL` pointed at the `a-log-e2e` DB,
  `AUTH_MODE=password`, `PASSWORD_POLICY=any`, `AUTH_RATE_LIMIT_POINTS=0`, SMTP → Mailpit.
  Playwright got the same `DATABASE_URL`.
- Launch 1 used the `.env.defaults` DB (`a-log`), so the setup created a stray
  `muaddib@arrakis.test` (role `user`, id 281) in the dev DB `a-log`. It was left in place; delete
  it if unwanted.
- Launch 2 used `AUTH_MODE=password-confirm`, but `a-log-e2e` was created minutes earlier by the
  `e2e-fast` check under `AUTH_MODE=password`, so its accounts are unconfirmed → global-setup sweep
  403 `email_not_confirmed`. Launch 3 matched `AUTH_MODE=password`.
- Recommended: restore a `server/.env` for the e2e dev backend (see `tests/README.md` →
  "Dev-server settings the e2e suite assumes") so all e2e checks use one consistent config.
