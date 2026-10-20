---
paths:
  - "hook/**"
---

# After every code change

Run lint and fix any issues before finishing:

```sh
npm run lint:fix
npm run lint
```

If `npm run lint` still reports errors after auto-fix, resolve them manually before considering the task done.

# Changes in Claude Code config

All changes in Claude Code config you make MUST be scoped to this project only.
No global changes allowed.

# When hook code changes

If any file under `hook/.claude/telemetry_tool/` is added, removed, or modified:

1. Run the `update-install-instructions` skill to keep `INSTALL_HOOK.md` in sync with the code.


# Log separation 

Hook writes artisyn logs. Only purpose of these logs is to provide info
that is mission in AI Agent (claude logs). 

Neve augment claude logs, always upload them as is. 

# Version bump

Each time you make changes in the hook code, bump the version in:

```
hook/.claude/telemetry_tool/version.json
```

This is the single source of truth for the version — there is no top-level `.claude/telemetry_tool/`
mirror (that predates the plugin/marketplace packaging and no longer exists).

Then run the canonical build step, which reads that file and propagates the version everywhere else
it needs to go (`artisyn-hooks-installer/package.json`, and the gitignored installer tarballs under
`server/src/public/static/`):

```sh
npm run build:hooks-installer
```

This repo also dogfoods its own installer: `.artisyn/marketplace/plugins/log-hub-hooks/` is this
project's own locally-*installed* copy of the plugin (what `.claude/settings.json`'s
`enabledPlugins`/`extraKnownMarketplaces` actually loads), git-tracked, separate from the
`hook/.claude/telemetry_tool/` source and from the build step above (which only regenerates the
installer tarballs, not this directory). After changing hook code, also refresh it so this repo
picks up the change without a full reinstall:

1. Copy every changed file (and `version.json`) into `.artisyn/marketplace/plugins/log-hub-hooks/scripts/`.
2. Update `.artisyn/marketplace/plugins/log-hub-hooks/.claude-plugin/plugin.json`'s `version` to match.

Use semantic versioning (`MAJOR.MINOR.PATCH`):
- `PATCH` — bug fixes, config tweaks, doc-only changes
- `MINOR` — new features or new telemetry events (backwards-compatible)
- `MAJOR` — breaking changes to the event schema or install procedure
