# repo_config — this project's config for the `adlc-lh` skills

The `/adlc-lh:*` skills (`scratch`, `review*`, `plan*`, `implement*`, `check-health`, `workcycle`,
`archive`, post-impl checks) come from the project-local plugin
`.artisyn/marketplace/plugins/adlc-lh/` and are project-agnostic. Everything specific to this repo
lives here. Every file is optional: a skill that needs a missing file or key skips the dependent
step or falls back to a bundled default.

The full reference for every file and key (including `paths`, `taskDetailsSkill` and the `group`
concurrency rules) is the plugin's own
[`templates/repo_config/README.md`](../../.artisyn/marketplace/plugins/adlc-lh/templates/repo_config/README.md).

## Files

| File | Consumed by | Purpose |
|---|---|---|
| `repo-health-checks.json` | `adlc-lh:check-health`, `adlc-lh:workcycle`, `adlc-lh:implement*`, `adlc-lh:post-impl-check`, `check-fix-build` | The canonical build/lint/test checks with their `group`, `finalOnly` and `timeoutSeconds`, plus `environmentNotes`. |
| `project-env.json` | `adlc-lh:plan*`, `adlc-lh:implement*`, `adlc-lh:review*`, `adlc-lh:workcycle` | Environment facts: `appUrl`, `tmpDir`, `kbIndexPath`, thresholds. |
| `requirements-template.md` | `adlc-lh:scratch` | Template for a new task's `requirements.md`. |
| `review-dimensions.yaml` | `adlc-lh:review-deep` | Review dimensions for the full review workflow. |

Each `*.sample.*` file documents the expected shape of its real counterpart.

## This repo's `group`s

`adlc-lh:check-health` runs different `group`s concurrently and the checks inside one group in
order. Here `npm run build` rewrites `server/src/public/static/*`, which the watch-mode dev backend
reloads on, so a build overlapping an e2e run knocks the backend out mid-suite. That is why
`build`, `contract`, the scenario checks and the e2e checks share the `app` group, while lint,
typecheck and algorithm tests (which only read sources) sit in `static` and run alongside them.

`CLAUDE.md` keeps a human-readable copy of the command table; keeping the two in sync is part of
`adlc-lh:workcycle`'s Definition of Done.
