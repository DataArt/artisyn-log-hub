# Notes — 2026-10-23-ci-cd-scans

## 2026-10-24 — Snyk prototype

Snyk CLI 1.1308.3 (`npx`), `snyk test --all-projects --detection-depth=4
--exclude=node_modules,dist,fixtures,pocs,marketplace,tmp` from the repo root, host account
authenticated. Script: `tmp/snyk-proto/run.mjs` (not tracked).

- 5 projects detected: root `package-lock.json`, `server/`, `hook/`, `artisyn-hooks-installer/`
  (npm lock files) and `client/package.json`. Wall time ~11 s for all five.
- `bun.lock` is not supported: `client/` was resolved from `package.json` + installed
  `node_modules`; a copy with only `package.json` + `bun.lock` fails with SNYK-CLI-0000. The root
  has both lock files; Snyk used `package-lock.json`.
- The CLI prints "Open source: no" for every project, also with `--remote-repo-url`. Snyk docs:
  free-plan test limits apply to private repositories only; `--remote-repo-url` (or the project's
  Git remote URL in the Snyk UI) is how a CLI project is tied to its public origin. Whether the
  quota really stays untouched is checked in Snyk → Settings → Usage after the first CI runs.
- Production dependencies (default): only `server/` has findings — 6 high, all with a fix:
  multer 2.4.0 → 2.5.0, nodemailer 10.1.1 → 10.1.4 (3 issues), body-parser 2.3.0 → 2.4.0 and
  qs 6.16.0 → 6.16.1 (both transitive via `@nestjs/platform-express` → `express` 5.2.1).
- With `--dev`: root 5 high + 2 medium; `hook/` 9 high + 4 medium; `client/` 4 high + 3 medium +
  1 low; `server/` 1 critical (esbuild 0.25.12, fixed in 0.28.1) + 8 high + 11 medium; the
  installer none.

## 2026-10-24 — VirusTotal and container prototypes

- VirusTotal (Public API key, `tmp/vt-proto/vt.mjs`, not tracked): `artisyn-hooks-installer.tgz`
  and `hooks.tar.gz` built by `scripts/build-hooks-installer.js --static-dir` were unknown by
  hash, uploaded, and analysed by 75 engines: 0 malicious, 0 suspicious (14 type-unsupported).
  Analysis took 1–3 minutes after upload.
- Snyk Container on `node:22.23.4-slim`: 88 deb packages (95 issues, mostly low; util-linux,
  zlib), plus the image's global npm tree. On `node:22.0.0-slim` it also reports the `node`
  runtime binary: 46 issues (2 critical, 16 high) with fixed-in versions, so runtime CVEs are
  covered.
- `is-my-node-vulnerable`: 22.23.4 and 24.22.1 not vulnerable; 22.0.0 vulnerable (sanity check).
- The `slim` image has no `ca-certificates` package; Node uses its bundled store (116 roots,
  OpenSSL 3.5.9).
- Trivy was dropped by the owner before its run finished.
