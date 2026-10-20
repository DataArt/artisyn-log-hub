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
This exists because `npx <url>` caches its local exec by the downloaded package's own name+version,
not by the request URL — a stale installer version left the door open to serving old cached hook
code even after the server started serving fresh content.
