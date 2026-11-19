import { BadRequestException } from '@nestjs/common';

const HAS_DIGIT = /\d/;
const HAS_PUNCTUATION = /[!-/:-@[-`{-~]/;
const HAS_UPPER = /[A-Z]/;
const HAS_LOWER = /[a-z]/;

function weakPassword(message: string): never {
  throw new BadRequestException({ error: 'weak_password', message });
}

/**
 * Enforces the active PASSWORD_POLICY, read directly from process.env. The
 * startup validator (auth-startup-validation.ts) normally defaults an unset
 * value to 'long' as a side effect of validating it — but that validator is
 * itself skipped when NODE_ENV === 'test' (same escape hatch app.module.ts
 * uses for SESSION_SECRET), so PASSWORD_POLICY can reach here still unset
 * during e2e tests. Defaulting here too (not just relying on the validator's
 * side effect) means policy enforcement can't silently no-op in that case —
 * verified in practice: without this, an unset PASSWORD_POLICY matched none
 * of the switch cases below and let any password through.
 */
export function applyPasswordPolicy(password: string): void {
  const policy = activePolicy();
  switch (policy) {
    case 'any':
      if (password.length < 2) {
        weakPassword(REQUIREMENT.any);
      }
      return;
    case 'mid':
      if (password.length < 10 || !HAS_DIGIT.test(password)) {
        weakPassword(REQUIREMENT.mid);
      }
      return;
    case 'long':
      if (
        password.length < 14 ||
        !HAS_DIGIT.test(password) ||
        !HAS_PUNCTUATION.test(password) ||
        !HAS_UPPER.test(password) ||
        !HAS_LOWER.test(password)
      ) {
        weakPassword(REQUIREMENT.long);
      }
      return;
  }
}

/** The rule each policy enforces — also the `weak_password` message. */
const REQUIREMENT = {
  any: 'must be at least 2 characters',
  mid: 'must be at least 10 characters and include a digit',
  long: 'must be at least 14 characters and include a digit, punctuation, and both upper and lower case',
} as const;

function activePolicy(): string {
  return process.env.PASSWORD_POLICY || 'long';
}

/**
 * The active policy's rule, worded like the `weak_password` message
 * ("must be …"), so forms can show it before the first submit. `null` for
 * an unknown policy value (startup validation rejects those).
 */
export function passwordRequirement(): string | null {
  const policy = activePolicy();
  return policy in REQUIREMENT
    ? REQUIREMENT[policy as keyof typeof REQUIREMENT]
    : null;
}
