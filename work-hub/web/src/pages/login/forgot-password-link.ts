import type { AuthConfig } from "../../api/auth";

/** How the login page renders the "Forgot password?" link. */
export type ForgotPasswordLinkState = "active" | "disabled" | "hidden";

/** Hint shown wherever password reset is unavailable because SMTP is unset. */
export const SMTP_NOT_CONFIGURED_HINT = "SMTP server is not configured";

/**
 * The link state from `GET /auth/config`, as in Log Hub: `passwordResetAvailable` decides; when
 * absent, it is shown in `password-confirm` and hidden in `password`.
 */
export function forgotPasswordLinkState(
  config: Pick<AuthConfig, "mode" | "passwordResetAvailable">,
): ForgotPasswordLinkState {
  if (config.passwordResetAvailable === true) return "active";
  if (config.passwordResetAvailable === false) return "disabled";
  return config.mode === "password-confirm" ? "active" : "hidden";
}
