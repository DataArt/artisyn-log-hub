/**
 * global.setup.ts — the `setup` PROJECT test file.
 *
 * Matched by the `setup` project (`testMatch: /global\.setup\.ts/`) added in
 * chunk 4; every `core`/`extended` test depends on it. It runs AFTER the
 * config-level globalSetup (lock + run-uuid + sweep are already done there).
 *
 * For each role it:
 *   1. establishSession(...) — idempotent API signup/identify + copies the
 *      resulting session cookie onto a browser context (see that helper's
 *      docstring in helpers/auth.ts for why a genuine UI login can no longer
 *      be driven here under Mode 1 (AUTH_MODE=none): AutoIdentifyGuard
 *      auto-authenticates the browser as an arbitrary existing user before a
 *      scripted login ever reaches the identify form, once the shared dev DB
 *      already has users — which it always does);
 *   2. navigates to /#/main as a sanity check that the session genuinely works;
 *   3. saves that context's storageState to tests/e2e/.auth/<role>.json, so all
 *      other specs reuse the session instead of logging in per test.
 *
 * ORDER MATTERS: the backend makes the first-ever signup an admin. So the admin
 * identities (primary/admin/owner — all ROLES.admin.email) are authenticated
 * first, then the non-admin roles (regular, nonowner). `mode: 'serial'` enforces
 * this even under fullyParallel, and guarantees regular/nonowner never win the
 * first-signup race on a fresh DB.
 */
import { test as setup, request as pwRequest } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { ROLES, BASE_URL, storageStatePath, type Role } from './helpers/credentials';
import { establishSession } from './helpers/auth';
import {
  DATA_COLLECTION_NOTICE_SETTING,
  consentSettingValue,
} from './helpers/notice-hash';

// First-signup-is-admin order: admin identities first, then non-admins.
const AUTH_ORDER: Role[] = ['primary', 'admin', 'owner', 'regular', 'nonowner'];

setup.describe.configure({ mode: 'serial' });

for (const role of AUTH_ORDER) {
  setup(`authenticate ${role}`, async ({ page }) => {
    const creds = ROLES[role];

    // 1. Ensure the user exists (idempotent) and copy its session cookie onto
    //    the browser context.
    const apiCtx = await pwRequest.newContext({ baseURL: BASE_URL });
    try {
      await establishSession(page, apiCtx, creds);

      // 1a. Accept the data-collection notice for this role. The consent
      //     screen replaces the whole app shell until it is accepted, so
      //     without this every other spec would only ever see the notice.
      const res = await apiCtx.put(
        `/api/v1/user-settings/${DATA_COLLECTION_NOTICE_SETTING}`,
        { data: { value: consentSettingValue() } },
      );
      if (!res.ok()) {
        throw new Error(
          `Failed to accept the data-collection notice for ${role}: ${res.status()}`,
        );
      }
    } finally {
      await apiCtx.dispose();
    }

    // 2. Sanity-check the session actually works end-to-end in a browser.
    await page.goto('/#/main');
    await page.waitForFunction(
      () => !window.location.hash.startsWith('#/login'),
      { timeout: 10_000 },
    );

    // 3. Persist the authenticated storageState for reuse by other specs.
    const outPath = storageStatePath(role);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.context().storageState({ path: outPath });
  });
}
