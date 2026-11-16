/**
 * Texts of the set-password emails (auth mode `strict-managed`). Pure
 * builders, so the bootstrap (which has no `MailService`) and `MailService`
 * send the same wording. The forgot-password email stays in `MailService`.
 */

export interface EmailContent {
  subject: string;
  text: string;
}

/** First-start email to `ADMIN_CONTACT_EMAIL`; `url` is valid once, for 24 hours. */
export function bootstrapAdminEmail(
  url: string,
  baseUrl: string,
): EmailContent {
  return {
    subject: 'Set your Log Hub administrator password',
    text: `You are the administrator of the Log Hub server at ${baseUrl}.\n\nSet your password here (the link works once and is valid for 24 hours):\n${url}\n\nIf it expired, use "Forgot password?" on the login page.`,
  };
}

/** Email to an account an administrator created (or a resent link); valid once, for 24 hours. */
export function setPasswordEmail(email: string, url: string): EmailContent {
  return {
    subject: 'Set your Log Hub password',
    text: `An administrator created a Log Hub account for ${email}.\n\nSet your password here (the link works once and is valid for 24 hours):\n${url}\n\nIf it expired, ask your administrator to send a new link, or use "Forgot password?" on the login page.`,
  };
}
