// Tour 1 — anonymous: the auth pages and the guards (impl-plan DD G5;
// docs/qaa-overview/scenarios/06-ui-tab-walk.md §2.3 story 1, checks per screen §2.2).
//
// Runs in every mode (DD C6). The password pages only exist in B and C (in A the server answers
// them 404), so their rows carry `modes: ['b', 'c']` and the walk takes the rows of the stand's mode.
//
// Anonymous in mode A (06 §5 risk 1, now settled by code): `AutoIdentifyGuard` logs every
// cookie-less `GET /auth/me` from a local peer in as user #1 (`AuthService.autoIdentifyMode1`) —
// and the server counts any 127.x.y.z peer as local, so no browser on the stand's machine is ever
// anonymous on a fresh load. What a mode-A visitor does see is the identify form after «Edit email»
// (the mode-A logout: `setUser(null)` + #/login, no reload). So in A the walk signs in as its own
// user, presses «Edit email», and then follows the guard deep links inside the same document,
// where the app is anonymous until the next full load.
//
// Data: one user who owns a repository (the deep-link target of the guard rows) and, in B/C, a
// password-reset token written straight into `password_reset_tokens` (no endpoint issues one
// without a letter and a cooldown — the same seeding as S-AUTH-04).
//
// Replaces:
//   - tests/e2e/auth-guard.spec.ts (2)
//   - client/src/viewer/__tests__/components/login-page.test.tsx («renders» cases)
//   - client/src/viewer/__tests__/components/forgot-password-page.test.tsx («renders» cases)
//   - client/src/viewer/__tests__/components/reset-password-page.test.tsx («renders» cases)
import { randomBytes } from 'crypto';
import { test, expect } from '../fixtures';
import { createApiKey } from '../helpers/api-key';
import { ownRepoId, uploadPromptSession } from '../helpers/prompt-session';
import { navigateInApp } from '../helpers/ui-auth';
import { skipNewUserNudge } from '../helpers/teams';
import { TourWalker } from './tour-kit';

// A broken screen must fail fast, not eat the story's whole timeout.
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

test('@TOUR-01 anon: auth pages and guards @mode-a @mode-b @mode-c', async ({ stand, api, db, users, page }) => {
  test.setTimeout(120_000);
  const run = randomBytes(4).toString('hex');
  const owner = await users.user('user', { label: 'tour01-owner' });
  const repoUrl = `https://git.arrakis.test/tours/${run}/anon-target`;

  const params = await test.step('setup: a repository to deep-link to; a reset token in B/C', async () => {
    const key = await createApiKey(owner.api);
    await uploadPromptSession(api, key.key, { sessionId: `tour01-${run}`, prompt: `tour 01 ${run}`, repoUrl }, { db, userId: owner.id });
    const repoId = await ownRepoId(owner.api, repoUrl);
    let resetToken = 'unused-in-mode-a';
    if (stand.authMode !== 'none') {
      resetToken = `scn-${randomBytes(24).toString('hex')}`;
      await db.query(
        `INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
        [owner.id, resetToken],
      );
    }
    return { repoId, resetToken };
  });

  const walker = new TourWalker({ story: 'tour-01', mode: stand.mode, params });
  walker.attach(page);
  const modeA = stand.authMode === 'none';

  for (const row of walker.rows()) {
    if (row.id === 'auth.login.identify') {
      await walker.screen(page, row.id, {
        go: async () => {
          await skipNewUserNudge(page);
          await owner.signIn(page);
          await page.goto('/#/main');
          await page.getByRole('button', { name: 'Edit email' }).click();
          await expect(page).toHaveURL(/#\/login$/);
        },
      });
      continue;
    }
    if (row.id === 'auth.reset-password.bad-token') {
      // The garbage token is only rejected on submit: fill a policy-proof password and send.
      await walker.screen(page, row.id, {
        go: async (hash) => {
          await page.goto(hash);
          await page.getByPlaceholder('New password', { exact: true }).fill('Tour-01-Passw0rd!x');
          await page.getByPlaceholder('Confirm new password', { exact: true }).fill('Tour-01-Passw0rd!x');
          await page.getByRole('button', { name: 'Reset password' }).click();
        },
      });
      continue;
    }
    // Mode A: stay in the logged-out document (a reload would auto-identify again).
    await walker.screen(page, row.id, modeA ? { go: (hash) => navigateInApp(page, hash.replace(/^\/#/, '#')) } : {});
  }

  walker.finish();

  if (!modeA) {
    // B runs with Mailpit as its relay (reset available); C runs without SMTP_HOST, so the link is
    // disabled with the hint and /forgot-password refuses the form.
    await test.step('forgot-password link state: enabled in B; disabled with the SMTP hint in C', async () => {
      const hint = 'SMTP server is not configured';
      await page.goto('/#/login');
      const link = page.getByRole('button', { name: 'Forgot password?' });
      await expect(link).toBeVisible();
      if (stand.authMode === 'password-confirm') {
        await expect(link).toBeEnabled();
        await expect(page.getByText(hint)).toHaveCount(0);
      } else {
        await expect(link).toBeDisabled();
        await expect(page.getByText(hint)).toBeVisible();
        await page.goto('/#/forgot-password');
        await expect(page.getByRole('note').filter({ hasText: hint })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Send reset link' })).toBeDisabled();
      }
    });
  }
});
