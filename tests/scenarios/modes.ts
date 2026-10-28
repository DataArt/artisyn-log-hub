// Stand modes for the scenario suite: ONE table shared by the runner (scripts/scenarios/*.mjs)
// and the Playwright fixtures. See docs/tasks/.../impl-plan.md, DD C2 and DD C4.
//
// Loaded directly by Node's built-in type stripping from the .mjs scripts and from
// scripts/__tests__/scenarios-stand.test.js, so this file uses erasable syntax only
// (no enum, no namespace, no parameter properties) and imports nothing.

export type StandMode = 'a' | 'b' | 'c';

export type AuthMode = 'none' | 'password' | 'password-confirm';

export interface ModeSpec {
  mode: StandMode;
  authMode: AuthMode;
  nodeEnv: 'test' | 'production';
  /** True when the mode needs Mailpit (signup confirmation emails). */
  needsMailpit: boolean;
}

export const STAND_MODES: readonly StandMode[] = ['a', 'b', 'c'];

export const MODES: Readonly<Record<StandMode, ModeSpec>> = {
  a: { mode: 'a', authMode: 'none', nodeEnv: 'test', needsMailpit: false },
  b: { mode: 'b', authMode: 'password-confirm', nodeEnv: 'production', needsMailpit: true },
  c: { mode: 'c', authMode: 'password', nodeEnv: 'test', needsMailpit: false },
};

/** Fast-tick env (DD C4): schedulers tick in milliseconds, nothing reaches the network. */
export const FAST_TICK_ENV: Readonly<Record<string, string>> = {
  UPLOAD_QUEUE_INTERVAL_MS: '50',
  UPLOAD_QUEUE_LEASE_TIMEOUT_MS: '150',
  UPLOAD_QUEUE_PARTIAL_UPLOAD_SWEEP_INTERVAL_MS: '200',
  SESSION_RETENTION_CHECK_INTERVAL_MS: '50',
  SESSION_COST_RECOMPUTE_INTERVAL_MS: '50',
  AI_TOOL_VERSION_CHECK_ENABLED: 'false',
  MODEL_PRICING_FETCH_ENABLED: 'false',
};

/**
 * Auth rate limits raised: every scenario signs up its
 * users from 127.0.0.1, and the default 5 signups per IP per 15 min would 429 the suite.
 */
export const SUITE_LIMITS_ENV: Readonly<Record<string, string>> = {
  AUTH_RATE_LIMIT_POINTS: '1000',
};

/** Neutral identity domain for every scenario user and address (DD 2). */
export const SCENARIO_EMAIL_DOMAIN = 'arrakis.test';
export const DEFAULT_ADMIN_CONTACT_EMAIL = `admin@${SCENARIO_EMAIL_DOMAIN}`;
export const DEFAULT_SMTP_FROM = `noreply@${SCENARIO_EMAIL_DOMAIN}`;

export const DEFAULT_DATABASE_URL = 'postgresql://postgres:pw@localhost:5432/postgres';
export const DEFAULT_MAILPIT_URL = 'http://localhost:8025';
export const DEFAULT_MAILPIT_SMTP = 'localhost:1025';

export function isStandMode(value: string): value is StandMode {
  return value === 'a' || value === 'b' || value === 'c';
}

/** Parses `--mode a,b,c` style lists; throws on an unknown mode. Order and duplicates normalised. */
export function parseModes(list: string): StandMode[] {
  const wanted = new Set(
    list
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const m of wanted) {
    if (!isStandMode(m)) throw new Error(`Unknown stand mode "${m}" (expected a, b or c)`);
  }
  return STAND_MODES.filter((m) => wanted.has(m));
}

/** Splits `host:port` (MAILPIT_SMTP). */
export function parseHostPort(value: string): { host: string; port: string } {
  const idx = value.lastIndexOf(':');
  if (idx <= 0 || idx === value.length - 1) {
    throw new Error(`Expected host:port, got "${value}"`);
  }
  const host = value.slice(0, idx);
  const port = value.slice(idx + 1);
  if (!/^\d+$/.test(port)) throw new Error(`Expected a numeric port in "${value}"`);
  return { host, port };
}

export interface StandEnvInput {
  mode: StandMode;
  port: number;
  databaseUrl: string;
  schema: string;
  /** Process working dir of the stand: tmp/scenarios/run-<runId>/<mode>/. */
  runDir: string;
  /** Path joiner of the caller (node:path join); keeps this module import-free. */
  joinPath: (...parts: string[]) => string;
  /** Required in mode B: random 48 bytes hex, fresh per run. */
  sessionSecret?: string;
  mailpitSmtp?: string;
  adminContactEmail?: string;
  /** Defaults to the stand URL. */
  publicBaseUrl?: string;
}

/** `http://127.0.0.1:<port>` — the stand's base URL (STAND_URL). */
export function standUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * The application environment for one stand process (DD C2 + DD C4). Contains only the
 * app's own variables; the caller adds the OS essentials (PATH etc.). CLUSTER_MODE is never
 * set, so the stand is one process without fork.
 */
export function standEnv(input: StandEnvInput): Record<string, string> {
  const spec = MODES[input.mode];
  if (!spec) throw new Error(`Unknown stand mode "${String(input.mode)}"`);
  const url = standUrl(input.port);
  const env: Record<string, string> = {
    ...FAST_TICK_ENV,
    ...SUITE_LIMITS_ENV,
    AUTH_MODE: spec.authMode,
    NODE_ENV: spec.nodeEnv,
    PORT: String(input.port),
    DATABASE_URL: input.databaseUrl,
    E2E_DB_SCHEMA: input.schema,
    PUBLIC_BASE_URL: input.publicBaseUrl || url,
    LOGS_MAX_BODY_MB: '2',
    // The Tools/MCP rebuild drain (DD-7) runs every second, so a scenario sees the derived
    // `session_tool_usage` rows shortly after its upload instead of after the 15 s default.
    TOOL_USAGE_REBUILD_INTERVAL_MS: '1000',
    // The stand is plain http on 127.0.0.1; the server defaults to Secure cookies, which the
    // browser and request contexts would then never send back. .env.defaults is not copied.
    COOKIE_SECURE: 'false',
    UPLOAD_QUEUE_DIR: input.joinPath(input.runDir, 'upload-queue'),
    EXPORT_IMPORT_DIR: input.joinPath(input.runDir, 'export-import'),
  };
  if (input.mode === 'b') {
    if (!input.sessionSecret || !/^[0-9a-f]{96}$/.test(input.sessionSecret)) {
      throw new Error('Mode b needs sessionSecret: 48 random bytes as hex');
    }
    const smtp = parseHostPort(input.mailpitSmtp || DEFAULT_MAILPIT_SMTP);
    env.PASSWORD_POLICY = 'long';
    env.SESSION_SECRET = input.sessionSecret;
    env.SMTP_HOST = smtp.host;
    env.SMTP_PORT = smtp.port;
    env.SMTP_FROM = DEFAULT_SMTP_FROM;
    env.ADMIN_CONTACT_EMAIL = input.adminContactEmail || DEFAULT_ADMIN_CONTACT_EMAIL;
  }
  return env;
}
