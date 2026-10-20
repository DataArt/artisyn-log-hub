// F01 — non-DB and infrastructure routes (docs/qaa-overview/scenarios/05 §F01).
//
// Family contract: a 2xx answer and a byte-for-byte unchanged schema (`noDb`). Admin-only
// routes also get one `member` row: the guard answers 403 and nothing is written.
import type { ContractFamily } from '../types';

/** A release zip the F01 spec drops into RELEASES_DIR before the rows run. */
export const F01_RELEASE_ZIP = 'artisyn-log-hub-20260101-000000-amd64.zip';

export const f01Infra: ContractFamily = {
  id: 'F01',
  name: 'infra',
  cases: [
    {
      id: 'F01-health',
      route: 'GET /health',
      actor: 'anon',
      expect: {
        status: 200,
        bodyMatches: { status: 'ok', info: { database: { status: 'up' } } },
      },
      noDb: true,
    },
    {
      id: 'F01-health-version',
      route: 'GET /health/version',
      actor: 'anon',
      expect: { status: 200 },
      noDb: true,
    },
    {
      id: 'F01-ping',
      route: 'GET /api/v1/ping',
      actor: 'owner',
      expect: { status: 204 },
      noDb: true,
    },
    {
      id: 'F01-ping-anon',
      route: 'GET /api/v1/ping',
      actor: 'anon',
      expect: { status: 401 },
    },
    {
      id: 'F01-auth-config',
      route: 'GET /api/v1/auth/config',
      actor: 'anon',
      expect: { status: 200, bodyMatches: { mode: 'password-confirm' } },
      noDb: true,
    },
    {
      id: 'F01-installer-tgz',
      route: 'GET /static/artisyn-hooks-installer.tgz',
      kind: 'excluded',
      reason:
        'serves a gitignored build artifact (present only after `npm run build`, so 200 or 404 ' +
        'depending on the checkout) and never touches the DB; `?v=` would write into the dev ' +
        "server's static dir. Covered by the installer scenarios (tests/scenarios/installer/*).",
    },
    {
      id: 'F01-release-download-bad-signature',
      route: 'GET /api/v1/releases/download',
      actor: 'anon',
      query: { file: F01_RELEASE_ZIP, exp: '4102444800', sig: 'forged' },
      expect: { status: 403 },
    },
    {
      id: 'F01-log-echo',
      route: 'POST /api/v1/log-echo',
      actor: 'ownerKey',
      body: { probe: 'world-v1' },
      expect: { status: 200 },
      noDb: true,
    },
    {
      id: 'F01-log-echo-anon',
      route: 'POST /api/v1/log-echo',
      actor: 'anon',
      body: { probe: 'world-v1' },
      expect: { status: 401 },
    },
    {
      id: 'F01-admin-system',
      route: 'GET /api/v1/admin/system',
      actor: 'admin',
      expect: { status: 200 },
      noDb: true,
    },
    {
      id: 'F01-admin-system-member',
      route: 'GET /api/v1/admin/system',
      actor: 'member',
      expect: { status: 403 },
    },
    {
      id: 'F01-admin-error-logs',
      route: 'GET /api/v1/admin/error-logs',
      actor: 'admin',
      expect: { status: 200 },
      noDb: true,
    },
    {
      // The positive call zips the process's whole `logs/` directory (gigabytes on a dev
      // machine, shared with the dev server), so only the guard is exercised here.
      id: 'F01-admin-logs-archive-member',
      route: 'GET /api/v1/admin/logs-archive',
      actor: 'member',
      expect: { status: 403 },
    },
    {
      id: 'F01-admin-releases',
      route: 'GET /api/v1/admin/releases',
      actor: 'admin',
      expect: {
        status: 200,
        bodyMatches: {
          entries: [
            {
              fileName: F01_RELEASE_ZIP,
              stamp: '20260101-000000',
              arch: 'amd64',
              sizeBytes: 13,
            },
          ],
        },
      },
      noDb: true,
    },
    {
      id: 'F01-admin-release-link',
      route: 'POST /api/v1/admin/releases/download-link',
      actor: 'admin',
      body: { file: F01_RELEASE_ZIP },
      expect: { status: 200 },
      noDb: true,
    },
    {
      id: 'F01-admin-release-link-unlisted',
      route: 'POST /api/v1/admin/releases/download-link',
      actor: 'admin',
      body: { file: 'artisyn-log-hub-20250101-000000-arm64.zip' },
      expect: { status: 400 },
    },
    {
      id: 'F01-admin-auth',
      route: 'GET /api/v1/admin/auth',
      actor: 'admin',
      expect: { status: 200, bodyMatches: { mode: 'password-confirm' } },
      noDb: true,
    },
    {
      id: 'F01-retention-days',
      route: 'GET /api/v1/sessions/retention-days',
      actor: 'owner',
      expect: { status: 200, bodyMatches: { retentionDays: 36500 } },
      noDb: true,
    },
  ],
};
