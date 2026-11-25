---
paths:
  - "artisyn-hooks-installer/**"
---

# artisyn-hooks-installer

After every change to files in `artisyn-hooks-installer/`, bump the patch version in
`artisyn-hooks-installer/package.json`.

Note: a change to `hook/` content alone (no `artisyn-hooks-installer/` files touched) no longer
needs a manual bump here — `scripts/build-hooks-installer.js`'s `ensureInstallerVersionTracksHook()`
auto-bumps the patch version whenever the bundled hook version changes, every time the build runs.
This exists because a stale installer version left the door open to serving old cached hook code
even after the server started serving fresh content.

Observed 2026-11-25: npx also keeps one exec-cache entry per command spec (`~/.npm/_npx/<hash>` /
`%LOCALAPPDATA%\npm-cache\_npx\<hash>`) — a bare `…/artisyn-hooks-installer.tgz` URL that was run once
re-runs that first installer forever, whatever the server now serves. Hence the `?v=<hook version>`
suffix in every command the UI and docs print, and the installer's downgrade guard
(`src/downgrade-guard.ts`), which fetches the server's current installer when it finds itself stale.
