import { isEmail } from 'class-validator';
import { isAbsoluteHttpUrl } from '../../common/public-base-url';
import { isProduction } from '../../common/runtime-env';
import { parseAllowedEmailDomains } from './allowed-email-domains';

/**
 * Fail-fast validation of AUTH_MODE / PASSWORD_POLICY and their per-mode required
 * env vars. Invoked once at app startup (see app.module.ts), reading directly from
 * process.env — this runs before Nest's DI container (and ConfigService) exist.
 *
 * Throws a plain Error with a descriptive message on the first violation found.
 */

const VALID_AUTH_MODES = [
  'none',
  'password',
  'password-confirm',
  'azure-oauth',
] as const;
type AuthMode = (typeof VALID_AUTH_MODES)[number];

const VALID_PASSWORD_POLICIES = ['any', 'mid', 'long'] as const;

function requireNonEmpty(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(
      `${name} environment variable is required when AUTH_MODE requires it`,
    );
  }
  return value;
}

// Mode 1 ("none") takes no env-configured identity at all — a visitor identifies
// via POST /api/v1/auth/identify at request time, not a fixed pre-provisioned
// account. There is nothing to validate at startup for this mode.

const TENANT_GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `PUBLIC_BASE_URL` rule for Modes 2/3 (open-source readiness):
 * emailed links are built only from it, so in production it must be an absolute
 * http(s) URL. Outside production it may be unset (dev fallback), but a value
 * that is set must still be well-formed.
 */
function validatePublicBaseUrl(): void {
  const raw = process.env.PUBLIC_BASE_URL?.trim();
  if (!raw) {
    if (isProduction()) {
      throw new Error(
        'PUBLIC_BASE_URL environment variable is required in production for AUTH_MODE=password and password-confirm (emailed links are built from it)',
      );
    }
    return;
  }
  if (!isAbsoluteHttpUrl(raw)) {
    throw new Error(
      `PUBLIC_BASE_URL environment variable must be an absolute http(s) URL, got: ${raw}`,
    );
  }
}

/**
 * Mode 4 accepts only a single-tenant GUID: multi-tenant
 * aliases would let any Entra tenant sign in. A custom AZURE_AUTHORITY must
 * point at that same tenant.
 */
function validateAzureTenant(): void {
  const tenantId = requireNonEmpty(
    'AZURE_TENANT_ID',
    process.env.AZURE_TENANT_ID,
  ).trim();
  if (!TENANT_GUID_PATTERN.test(tenantId)) {
    throw new Error(
      'AZURE_TENANT_ID must be a tenant GUID; multi-tenant values (common/organizations/consumers/domain) are not supported',
    );
  }

  const authority = process.env.AZURE_AUTHORITY?.trim();
  if (authority) {
    let segments: string[];
    try {
      segments = new URL(authority).pathname.split('/');
    } catch {
      segments = authority.split('/');
    }
    const wanted = tenantId.toLowerCase();
    if (!segments.some((segment) => segment.toLowerCase() === wanted)) {
      throw new Error(`AZURE_AUTHORITY must point at tenant ${tenantId}`);
    }
  }
}

function validateMode4(): void {
  validateAzureTenant();
  requireNonEmpty('AZURE_CLIENT_ID', process.env.AZURE_CLIENT_ID);
  requireNonEmpty('AZURE_CLIENT_SECRET', process.env.AZURE_CLIENT_SECRET);

  const redirectUri = requireNonEmpty(
    'AZURE_REDIRECT_URI',
    process.env.AZURE_REDIRECT_URI,
  );
  try {
    new URL(redirectUri);
  } catch {
    throw new Error(
      `AZURE_REDIRECT_URI environment variable must be an absolute URL, got: ${redirectUri}`,
    );
  }

  // Explicitly-set-but-empty is a distinct misconfiguration from "unset" (which
  // falls back to a default scope list elsewhere) — fail fast on the former.
  if (process.env.AZURE_SCOPES === '') {
    throw new Error(
      'AZURE_SCOPES environment variable must not be set to an empty string',
    );
  }
}

/**
 * SMTP block shared by Modes 2/3: SMTP_HOST, SMTP_FROM and SMTP_PORT (an
 * integer 1–65535) must be set. SMTP_USER/SMTP_PASSWORD/SMTP_SECURE stay
 * optional (SMTP_SECURE unset or empty = false).
 */
function validateSmtpBlock(): void {
  requireNonEmpty('SMTP_HOST', process.env.SMTP_HOST);
  requireNonEmpty('SMTP_FROM', process.env.SMTP_FROM);

  const smtpPort = requireNonEmpty('SMTP_PORT', process.env.SMTP_PORT);
  const port = Number(smtpPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `SMTP_PORT environment variable must be an integer between 1 and 65535, got: ${smtpPort}`,
    );
  }
}

// Per-mode SMTP rule: Modes 1/4 never use SMTP. In Mode 2 ("password") SMTP is optional:
// when SMTP_HOST is set, SMTP_PORT/SMTP_FROM are required (and a relay that cannot be
// reached at startup only logs a warning); when SMTP_HOST is unset (or blank), every other
// SMTP_* value is ignored, password reset is unavailable and "Forgot password?" is disabled.
// In Mode 3 ("password-confirm") SMTP_HOST/SMTP_PORT/SMTP_FROM are required and the relay
// must be reachable at startup (MailService.onModuleInit), or the app does not start.
function validateMode2(): void {
  validatePublicBaseUrl();
  if ((process.env.SMTP_HOST ?? '').trim() !== '') {
    validateSmtpBlock();
  }
}

function validateMode3(): void {
  validatePublicBaseUrl();
  // Throws on a malformed list; the parsed value is re-read by AuthService.signup().
  parseAllowedEmailDomains(process.env.ALLOWED_EMAIL_DOMAINS);

  const adminEmail = process.env.ADMIN_CONTACT_EMAIL;
  if (!adminEmail || adminEmail.trim() === '') {
    throw new Error(
      'ADMIN_CONTACT_EMAIL environment variable is required for AUTH_MODE=password-confirm',
    );
  }
  if (!isEmail(adminEmail)) {
    throw new Error(
      `ADMIN_CONTACT_EMAIL environment variable must be a valid email address, got: ${adminEmail}`,
    );
  }

  validateSmtpBlock();
}

function validatePasswordPolicy(): void {
  const policy = process.env.PASSWORD_POLICY;
  if (!policy || policy.trim() === '') {
    process.env.PASSWORD_POLICY = 'long';
    return;
  }
  if (
    !VALID_PASSWORD_POLICIES.includes(
      policy as (typeof VALID_PASSWORD_POLICIES)[number],
    )
  ) {
    throw new Error(
      `PASSWORD_POLICY environment variable must be one of ${VALID_PASSWORD_POLICIES.join(
        ', ',
      )}, got: ${policy}`,
    );
  }
}

export function validateAuthStartupConfig(): void {
  let authMode = process.env.AUTH_MODE;
  if (!authMode || authMode.trim() === '') {
    // Legacy compatibility: every install that predates AUTH_MODE ran what is now
    // called Mode 2 ("password") with no such env var existing at all. Defaulting here
    // (rather than failing fast, as an explicit-but-invalid value still does below) means
    // those installs keep working unchanged after an upgrade with no .env/compose changes.
    authMode = 'password';
    process.env.AUTH_MODE = authMode;
  }
  if (!VALID_AUTH_MODES.includes(authMode as AuthMode)) {
    throw new Error(
      `AUTH_MODE environment variable has an unrecognized value "${authMode}"; must be one of ${VALID_AUTH_MODES.join(
        ', ',
      )}`,
    );
  }

  switch (authMode as AuthMode) {
    case 'none':
      break;
    case 'password':
      validateMode2();
      break;
    case 'azure-oauth':
      validateMode4();
      break;
    case 'password-confirm':
      validateMode3();
      break;
  }

  validatePasswordPolicy();
}
