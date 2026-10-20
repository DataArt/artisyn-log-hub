/**
 * Table test for docs/knowledgebase/algorithms/auth-startup-config.md: each row sets an
 * environment, runs `validateAuthStartupConfig` and compares the outcome with the doc.
 */
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import { validateAuthStartupConfig } from './auth-startup-validation';

/** Every variable the validator reads; all are unset unless a row sets them. */
const AUTH_KEYS = [
  'AUTH_MODE',
  'PASSWORD_POLICY',
  'PUBLIC_BASE_URL',
  'ALLOWED_EMAIL_DOMAINS',
  'ADMIN_CONTACT_EMAIL',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_FROM',
  'AZURE_TENANT_ID',
  'AZURE_AUTHORITY',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_REDIRECT_URI',
  'AZURE_SCOPES',
  'NODE_ENV',
];

type StartupExpected =
  | { ok: true; AUTH_MODE: string; PASSWORD_POLICY: string }
  | { ok: false; error: string };

const rows = loadExamples<{ env: Record<string, string> }, StartupExpected>(
  'auth-startup-config',
);

describe('auth-startup-config', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of AUTH_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    for (const key of AUTH_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each(rows)('$id', ({ input, expected }) => {
    Object.assign(process.env, input.env);
    let error: string | null = null;
    try {
      validateAuthStartupConfig();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    if (expected.ok) {
      expect(error).toBeNull();
      expect({
        ok: true,
        AUTH_MODE: process.env.AUTH_MODE,
        PASSWORD_POLICY: process.env.PASSWORD_POLICY,
      }).toEqual(expected);
      return;
    }
    expect(error).toContain(expected.error);
  });
});
