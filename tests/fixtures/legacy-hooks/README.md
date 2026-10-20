# Frozen legacy hooks

Historical versions of `hook/.claude/telemetry_tool/`, frozen for the backward-compatibility
scenario S-COMPAT-01 (`tests/scenarios/hook/s-compat-01.spec.ts`). Each directory is one version as
it shipped; `FROZEN.json` names the source commit. Tests (`__tests__/`) and env files are left out.

Never edit or refresh these files: they stand for users who keep an old hook for a long time.

| Version | Commit | Why this one |
|---|---|---|
| `1.6.2` | `38b0d4f` (`4d4e6d9^`) | the last version before 1.7.0; uploads only through `POST /api/v1/logs`, which the server no longer has |
| `2.6.1` | `de89d03` (`577386b^`) | the last version before 2.8.0 (there is no 2.7.x); v2 uploads with 900 KB chunks |

Add a version with `node scripts/scenarios/freeze-legacy-hook.mjs --commit <sha> [--label <version>]`
(see `tests/scenarios/README.md`).
