/**
 * Lifetimes of password-reset-token links (`password_reset_tokens.expires_at`
 * is per row, so each issuer picks its own).
 */

/** "Forgot password?" link: 1 hour. */
export const RESET_LINK_TTL_MS = 3_600_000;

/** Admin-issued set-password link (strict-managed bootstrap, create user, resend): 24 hours. */
export const SET_PASSWORD_LINK_TTL_MS = 86_400_000;
