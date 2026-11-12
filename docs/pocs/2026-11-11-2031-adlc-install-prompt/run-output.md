The adlc-lh plugin is installed as a project-local marketplace plugin in this project, and every verification step passed. Nothing is committed, and the temp clone folder has been deleted.

## Files created or changed
- **`.claude/marketplace/plugins/adlc-lh/`** (new): plugin v1.5.0, copied unchanged from `main`. A `diff -r` against the clone showed no differences.
- **`.claude/marketplace/.claude-plugin/marketplace.json`** (new): marketplace `adlc-install-poc-local` with the single `adlc-lh` entry.
- **`.claude/settings.json`** (changed): your existing `permissions` are kept. I added `extraKnownMarketplaces.adlc-install-poc-local` (a directory source at `./.claude/marketplace`) and set `enabledPlugins["adlc-lh@adlc-install-poc-local"] = true`.
- **`.claude/repo_config/`** (new): copied from the templates, then fitted to this project:
  - `repo-health-checks.json`: the real checks listed below. The example pre/post skills are removed (empty arrays), and the `environmentNotes` describe this project: no dependencies, no database, lint is only a syntax check, the tests don't start the server, the build writes `dist/`, and temp files go under `tmp/`.
  - `project-env.json`: `appUrl` is `http://localhost:4100`, `tmpDir` is `tmp/`, `taskDetailsSkill` is empty and `tasksRoot` is `docs/tasks`. I removed `credentialsNote` and `kbIndexPath` because there is no login and no docs index.
  - `review-dimensions.yaml`: both dimensions kept. "API/schema/UI changes" now reads "API/data-model changes", since there is no UI or schema.
  - `requirements-template.md`: the Module(s) line now lists this repo's modules, and "accessibility/UX" became "API compatibility". These two files are now saved with LF line endings, like the rest of the repo.
  - `README.md`: copied as-is, since it was part of `templates/repo_config/*`.
- **`docs/tasks/todo/index.md`** (`# Tasks`) and **`docs/tasks/done/index.md`** (`# Done tasks`) (new).
- **`CLAUDE.md`** (new): a short section saying tasks go through `adlc-lh:tracker`, code changes follow `adlc-lh:workcycle`, and the commands live in `repo-health-checks.json`.
- **`.gitignore`** (changed): added `tmp/`.

## Health checks
All three come from `package.json` scripts, and each ran once and passed:

| Check | Command | Group | Notes |
|---|---|---|---|
| lint | `npm run lint` | static | Only `node --check` on two files |
| unit-tests | `npm test` | static | node:test, 1 test, passes |
| build | `npm run build` | build | Writes `dist/`, so it's in its own group |

There's no typecheck, e2e suite, CI config or Makefile, so there are no other checks. All three are fast, so none is marked `finalOnly`.

## Verification
- All JSON files I wrote parse.
- `adlc-task.js --paths --project .` printed absolute paths with no `WARNING`.

## What I couldn't determine
- **`appUrl`**: taken from the default `PORT` in `src/server.js`. If you set `PORT`, this URL will be wrong. The server only has `GET /api/todos`, with no health or root route.
- **No tracker skill** is installed, so `/adlc-lh:scratch` accepts raw ideas only, not task keys.
- **`dist/` is left over** from the build run; it's git-ignored.

## Next steps
1. Restart Claude Code.
2. Trust the `adlc-install-poc-local` marketplace when prompted, or run `/plugin` and enable `adlc-lh`.
3. Try `/adlc-lh:scratch <idea>`.
