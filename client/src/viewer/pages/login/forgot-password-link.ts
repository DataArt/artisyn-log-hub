import type { AuthConfig } from '../../../models/auth';

/** How the login page renders the "Forgot password?" link. */
export type ForgotPasswordLinkState = 'active' | 'disabled' | 'hidden';

/** Hint shown wherever password reset is unavailable because SMTP is unset. */
export const SMTP_NOT_CONFIGURED_HINT = 'SMTP server is not configured';

/**
 * Decides the "Forgot password?" link state from `GET /auth/config`.
 * `passwordResetAvailable` is sent by newer servers in the password modes;
 * an older server omits it, so fall back to the previous per-mode behaviour
 * (shown in `password-confirm`, hidden in `password`).
 */
export function forgotPasswordLinkState(
  config: Pick<AuthConfig, 'mode' | 'passwordResetAvailable'>,
): ForgotPasswordLinkState {
  if (config.passwordResetAvailable === true) return 'active';
  if (config.passwordResetAvailable === false) return 'disabled';
  return config.mode === 'password-confirm' ? 'active' : 'hidden';
}
