#!/usr/bin/env node
// Preflight checks for the scenario suite (impl-plan DD C8). Every failed check prints what is
// wrong and how to fix it; the process then exits with 2 (distinct from a test failure's 1).
//
//   - DATABASE_URL is reachable (default postgresql://postgres:pw@localhost:5432/postgres);
//   - mode b only: MAILPIT_URL answers (default http://localhost:8025);
//   - the Playwright chromium browser is installed;
//   - tmp/scenarios/.env.local does NOT exist: the stand bundle loads `.env.local` from
//     `__dirname/..` (app.module.ts), i.e. from tmp/scenarios/, which would leak overrides.
//
// Usage: node scripts/scenarios/preflight.mjs [--mode a,b,c]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  DEFAULT_DATABASE_URL,
  DEFAULT_MAILPIT_URL,
  MODES,
  STAND_MODES,
  parseModes,
} from '../../tests/scenarios/modes.ts';
import { SCENARIOS_TMP } from './build-stand.mjs';

export const PREFLIGHT_EXIT_CODE = 2;
const CHECK_TIMEOUT_MS = 5000;

/** Hides the password in a connection string for messages. */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(unparseable URL)';
  }
}

async function checkDatabase(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: CHECK_TIMEOUT_MS });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return null;
  } catch (err) {
    return (
      `Postgres is not reachable at DATABASE_URL=${redactUrl(databaseUrl)} (${err.message}).\n` +
      '  Start one with: docker compose -f tests/scenarios/docker-compose.yml up -d\n' +
      '  or point DATABASE_URL at a Postgres you may create schemas in.'
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkMailpit(mailpitUrl) {
  const target = `${mailpitUrl.replace(/\/+$/, '')}/api/v1/info`;
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (res.ok) return null;
    return `Mailpit at MAILPIT_URL=${mailpitUrl} answered ${target} with HTTP ${res.status}; mode b needs a working Mailpit API.`;
  } catch (err) {
    return (
      `Mailpit is not reachable at MAILPIT_URL=${mailpitUrl} (${err.message}); mode b needs it for confirmation emails.\n` +
      '  Start one with: docker compose -f tests/scenarios/docker-compose.yml up -d\n' +
      '  or set MAILPIT_URL (HTTP API) and MAILPIT_SMTP (host:port).'
    );
  }
}

async function checkBrowser() {
  try {
    const { chromium } = await import('@playwright/test');
    const exe = chromium.executablePath();
    if (exe && fs.existsSync(exe)) return null;
    return `Playwright chromium is not installed (expected ${exe}).\n  Install it with: npx playwright install chromium`;
  } catch (err) {
    return `Cannot load @playwright/test (${err.message}). Run npm install in the repo root, then: npx playwright install chromium`;
  }
}

export function checkNoEnvLocal(scenariosTmp = SCENARIOS_TMP) {
  const file = path.join(scenariosTmp, '.env.local');
  if (!fs.existsSync(file)) return null;
  return (
    `${file} exists. The stand bundle loads .env.local from its parent directory and it would ` +
    'override the runner-controlled environment. Delete or move it.'
  );
}

/**
 * Runs every check relevant to `modes`. Returns the list of problems (empty when all pass).
 * Checks are independent; all are run so one report lists every problem at once.
 */
export async function runPreflight({
  modes = STAND_MODES,
  databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
  mailpitUrl = process.env.MAILPIT_URL || DEFAULT_MAILPIT_URL,
  scenariosTmp = SCENARIOS_TMP,
  browser = true,
} = {}) {
  const checks = [checkDatabase(databaseUrl), Promise.resolve(checkNoEnvLocal(scenariosTmp))];
  if (modes.some((m) => MODES[m].needsMailpit)) checks.push(checkMailpit(mailpitUrl));
  if (browser) checks.push(checkBrowser());
  return (await Promise.all(checks)).filter(Boolean);
}

/** Prints problems and exits with 2 when there are any; returns silently otherwise. */
export async function preflightOrExit(options) {
  const problems = await runPreflight(options);
  if (problems.length === 0) return;
  process.stderr.write(`Scenario preflight failed (${problems.length} problem${problems.length > 1 ? 's' : ''}):\n`);
  for (const p of problems) process.stderr.write(`\n- ${p}\n`);
  process.exit(PREFLIGHT_EXIT_CODE);
}

function parseModeArg(argv) {
  const i = argv.findIndex((a) => a === '--mode' || a.startsWith('--mode='));
  if (i === -1) return [...STAND_MODES];
  const value = argv[i].includes('=') ? argv[i].slice('--mode='.length) : argv[i + 1];
  if (!value) throw new Error('--mode requires a list such as a,b,c');
  return parseModes(value);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let modes;
  try {
    modes = parseModeArg(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`preflight: ${err.message}\n`);
    process.exit(PREFLIGHT_EXIT_CODE);
  }
  await preflightOrExit({ modes });
  process.stderr.write(`Scenario preflight OK (modes: ${modes.join(',')}).\n`);
  process.exit(0);
}
