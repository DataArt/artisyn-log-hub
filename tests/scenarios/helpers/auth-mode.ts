/**
 * auth-mode.ts — the AUTH_MODE of the stand under test.
 *
 * Copied from tests/e2e/helpers/auth-mode.ts without the hardcoded dev-server BASE_URL. The
 * scenario runner already knows the mode it started the stand in (STAND_MODE → modes.ts), so the
 * synchronous helpers read that; {@link detectAuthMode} asks the stand itself, which is what the
 * smoke scenario uses to prove the two agree.
 */
import { request } from '@playwright/test';
import { MODES, isStandMode, type AuthMode, type StandMode } from '../modes';

/** STAND_MODE as set by scripts/scenarios/run.mjs; throws when it is missing or invalid. */
export function standMode(): StandMode {
  const mode = process.env.STAND_MODE ?? '';
  if (!isStandMode(mode)) {
    throw new Error(
      `STAND_MODE is "${mode}" — run the scenario suite through npm run test:scenarios, which sets it.`,
    );
  }
  return mode;
}

/** The AUTH_MODE the stand was started with. */
export function authMode(): AuthMode {
  return MODES[standMode()].authMode;
}

/** Mode A: sessions come from /auth/identify; signup, login and email flows are absent. */
export function isNoAuthMode(): boolean {
  return authMode() === 'none';
}

/** Mode B: signup sends a confirmation email and opens no session until the user logs in. */
export function isPasswordConfirmMode(): boolean {
  return authMode() === 'password-confirm';
}

/** Asks the stand at `baseUrl` which mode it runs in (`GET /api/v1/auth/config`). */
export async function detectAuthMode(baseUrl: string): Promise<string> {
  const ctx = await request.newContext({ baseURL: baseUrl });
  try {
    const resp = await ctx.get('/api/v1/auth/config');
    if (!resp.ok()) {
      throw new Error(`Could not read /api/v1/auth/config (${resp.status()}): ${await resp.text()}`);
    }
    const { mode } = (await resp.json()) as { mode?: string };
    // Server-side, an unset/empty AUTH_MODE means `password` (the legacy default).
    return mode && mode.trim() !== '' ? mode : 'password';
  } finally {
    await ctx.dispose();
  }
}
