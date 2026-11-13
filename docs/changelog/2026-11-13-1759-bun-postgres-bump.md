# Bun 1.4.4 and PostgreSQL 18.7

- The image build, CI and dev sandbox move to Bun 1.4.4 (fixes the Brotli out-of-bounds write CVE-2026-111497); Bun is a build tool and is not shipped.
- The release compose now runs `postgres:18.7-alpine` (Postgres 18.7 bug-fix release, same major, no dump/restore needed); CI and the test compose files use 18.7 too.
- The hook README, the release install guides and the installer's warning now name the patched Node.js floors 22.23.5 / 24.22.3 / 26.13.1.
