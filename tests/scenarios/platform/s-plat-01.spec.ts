// S-PLAT-01. Health, build version and security headers everywhere
// (docs/qaa-overview/scenarios/04-ingest-hook-installer-platform.md §S-PLAT-01; layer API, no mode in
// the design → A and C, DD SC4).
//
// The stand is the built bundle (ncc + vite build, DD C1), so it covers the design's ENV-C
// requests too: `GET /` is the SPA (200) and `/assets/*` are real built files.
//
// Code facts that differ from the design text:
//   - the upload route of step 3 is `POST /api/v2/logs` (DD SC3: v1 is gone);
//   - step 5 («the DB is unreachable», `docker pause`) is not run: the stand shares the Postgres
//     of the whole run, pausing it would break every other pass, and the scenario suite never
//     drives docker. The health indicator's «down» branch stays with the unit tests.
//
// Replaces:
//   - server/test/security-headers.e2e-spec.ts (4)
//   - server/test/app.e2e-spec.ts (1)
//   - server/src/common/http-exception.filter.spec.ts (4, through step 4)
import type { APIResponse } from '@playwright/test';
import { test, expect } from '../fixtures';

// helmet joins CSP directives with ';' and no spaces (server/src/common/security-headers.ts).
const EXPECTED_CSP =
  "default-src 'self';script-src 'self' 'wasm-unsafe-eval';style-src 'self' 'unsafe-inline';img-src 'self' data:;font-src 'self' data:;connect-src 'self';object-src 'none';base-uri 'self';form-action 'self';frame-ancestors 'none'";

/** File-system or stack fragments that must never reach an error body. */
const LEAKS = [/\/home\//, /[A-Z]:\\/, /node_modules/, /\n\s+at /, /\.ts:\d+/];

function expectSecurityHeaders(res: APIResponse, what: string) {
  const h = res.headers();
  expect(h['x-frame-options'], `${what}: X-Frame-Options`).toBe('DENY');
  expect(h['x-content-type-options'], `${what}: X-Content-Type-Options`).toBe('nosniff');
  expect(h['content-security-policy'], `${what}: CSP`).toBe(EXPECTED_CSP);
}

test('@S-PLAT-01 health, build version and security headers everywhere @mode-a @mode-c', async ({ api, users }) => {
  await test.step('1. GET /health without a session → 200, status ok, database up', async () => {
    const res = await api.get('/health');
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', info: { database: { status: 'up' } } });
  });

  await test.step('2. GET /health/version without a session → {version, gitCommit, releaseStamp}, none empty', async () => {
    const res = await api.get('/health/version');
    expect(res.status()).toBe(200);
    const info = (await res.json()) as Record<string, unknown>;
    for (const field of ['version', 'gitCommit', 'releaseStamp']) {
      expect(typeof info[field], field).toBe('string');
      expect((info[field] as string).length, field).toBeGreaterThan(0);
    }
  });

  await test.step('3. The same three headers, strictly, on 200/401/403/404, the SPA, static files and assets', async () => {
    const index = await api.get('/');
    expect(index.status()).toBe(200);
    const html = await index.text();
    const asset = /(?:src|href)="(\/assets\/[^"]+)"/.exec(html)?.[1];
    expect(asset, 'index.html references a built /assets file').toBeTruthy();

    const checks: Array<[string, Promise<APIResponse>, number]> = [
      ['GET /health', api.get('/health'), 200],
      ['GET /api/v1/repositories', api.get('/api/v1/repositories'), 401],
      ['GET /api/v1/nonexistent', api.get('/api/v1/nonexistent'), 404],
      ['GET /', api.get('/'), 200],
      ['POST /api/v2/logs without key', api.post('/api/v2/logs?sessionId=s&type=artisyn', { data: '{}\n', headers: { 'Content-Type': 'application/x-ndjson' } }), 401],
      ['GET /static/artisyn-hooks-installer.tgz', api.get('/static/artisyn-hooks-installer.tgz'), 200],
      ['GET /api/v1/releases/download', api.get('/api/v1/releases/download'), 403],
      [`GET ${asset}`, api.get(asset as string), 200],
    ];
    for (const [what, pending, status] of checks) {
      const res = await pending;
      expect(res.status(), what).toBe(status);
      expectSecurityHeaders(res, what);
    }
    const csp = (await api.get('/health')).headers()['content-security-policy'];
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(/script-src[^;]*'unsafe-inline'/.test(csp)).toBe(false);
  });

  await test.step('4. /api errors are JSON {statusCode, message} with no stack or file-system path; the release page is HTML', async () => {
    const user = await users.user('user', { label: 'plat01' });
    const errors: Array<[string, Promise<APIResponse>, number]> = [
      ['404', api.get('/api/v1/nonexistent'), 404],
      ['401', api.get('/api/v1/repositories'), 401],
      ['403', user.api.get('/api/v1/admin/repos'), 403],
      ['400', user.api.get('/api/v1/repositories/not-a-number'), 400],
    ];
    for (const [what, pending, status] of errors) {
      const res = await pending;
      expect(res.status(), what).toBe(status);
      expect(res.headers()['content-type'], what).toMatch(/^application\/json/);
      const text = await res.text();
      expect(JSON.parse(text) as unknown, what).toMatchObject({ statusCode: status, message: expect.any(String) });
      for (const leak of LEAKS) expect(text, `${what}: ${leak}`).not.toMatch(leak);
    }
    const release = await api.get('/api/v1/releases/download');
    expect(release.headers()['content-type']).toMatch(/^text\/html/);
    const page = await release.text();
    expect(page).toContain('Invalid download link');
    for (const leak of LEAKS) expect(page, String(leak)).not.toMatch(leak);
  });

  await test.step('6. Neither Referer nor Origin is required; OPTIONS on the upload route opens no CORS', async () => {
    const preflight = await api.fetch('/api/v2/logs', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.arrakis.test', 'Access-Control-Request-Method': 'POST' },
    });
    expect(preflight.headers()['access-control-allow-origin']).toBeUndefined();
    const health = await api.get('/health', { headers: { Origin: 'https://evil.arrakis.test' } });
    expect(health.status()).toBe(200);
    expect(health.headers()['access-control-allow-origin']).toBeUndefined();
  });
});
