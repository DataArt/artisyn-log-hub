I installed the plugin as **`adlc-aip`** ("adlc install poc"). It's registered through the marketplace **`adlc-install-poc-2-local`**. Everything checked out: the JSON files parse, `lint-skills.js` prints OK, the `--paths` command prints absolute paths with no WARNING, and lint, test and build all ran and passed. Nothing is committed, and the temp clone is deleted.

## Files created / changed
- **`.claude/marketplace/plugins/adlc-aip/`** (new): the plugin copied from `artisyn-log-hub@main`. I replaced every `adlc-lh` with `adlc-aip` and set `displayName` to "ADLC Task Workflow (adlc-install-poc)". The Log Hub note in its README is now one line saying this is this project's copy of `adlc`. A grep finds no `adlc-lh` and no `log-hub` left.
- **`.claude/marketplace/.claude-plugin/marketplace.json`** (new)
- **`.claude/settings.json`** (changed): your existing `permissions` are kept, and I added `extraKnownMarketplaces` and `enabledPlugins`.
- **`.claude/repo_config/`** (new):
  - **`repo-health-checks.json`**: the three checks below, empty pre/post skill arrays, and notes about this project's setup.
  - **`project-env.json`**: `appUrl` is `http://localhost:4100`, the default port in `src/server.js`. `tmpDir` is `tmp/` and `tasksRoot` is `docs/tasks`. `taskDetailsSkill` is empty. I removed `credentialsNote` and `kbIndexPath` because the project has no credentials or docs index.
  - **`review-dimensions.yaml`**: the question about "API/schema/UI changes" now asks about HTTP API changes, since there is no database and no UI.
  - **`requirements-template.md`**: the module list is now `src | scripts | test`, and I dropped the accessibility/UX wording.
  - **`README.md`**: copied along with the other templates and left unchanged.
- **`.gitignore`** (changed): added `tmp/`.
- **`docs/tasks/todo/index.md`** and **`docs/tasks/done/index.md`** (new)
- **`CLAUDE.md`** (new, since there wasn't one): a short section on the `adlc-aip:tracker` and `adlc-aip:workcycle` skills and where the health checks live.

## Health checks
All three commands come from the `scripts` in `package.json`, and each one ran and passed:

| Check | Command | Group | Result |
|---|---|---|---|
| lint | `npm run lint` (`node --check` on both src files) | `static` | OK |
| unit-tests | `npm run test` (`node --test test/`) | `static` | 1/1 pass |
| build | `npm run build` (copies src to `dist/`) | `build` (it writes output) | OK |

None of them is marked `finalOnly`, because each takes about a second.

## What I couldn't determine
- **Typecheck, e2e and CI:** the project has none, so there are no checks for them.
- **No tracker skill** is installed, so `scratch` will only accept plain ideas, not tracker keys.
- **Project name:** I used `adlc-install-poc` from `package.json` for the display name and marketplace owner. The marketplace name comes from the folder name, `adlc-install-poc-2`.
- **Hardcoded file lists:** `npm run lint` and `scripts/build.js` name each source file. I wrote this into the check instructions so a new file under `src/` gets added to both.

## Next steps
1. Restart Claude Code in this folder.
2. Accept the workspace trust dialog and the marketplace and plugin install it offers, or run `/plugin` and enable `adlc-aip`.
3. Try `/adlc-aip:scratch <idea>`.
