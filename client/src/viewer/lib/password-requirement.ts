/**
 * The server words its password policy as a predicate ("must be at least 14
 * characters …"), both in `GET /auth/config` → `passwordRequirement` and in
 * `weak_password` errors. These turn it into a sentence for the forms.
 */

/** "Password must be at least …." — or null when the server did not send a rule. */
export function passwordRequirementSentence(
  rule: string | undefined,
): string | null {
  return rule ? `Password ${rule}.` : null;
}

/** A `weak_password` error message as a sentence; falls back when there is none. */
export function weakPasswordMessage(message: string | undefined): string {
  if (!message) return 'Password does not meet the strength requirements.';
  return message.startsWith('must ') ? `Password ${message}.` : message;
}
