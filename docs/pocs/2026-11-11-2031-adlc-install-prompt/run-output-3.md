I installed the plugin as **`adlc-aip`** from marketplace **`adlc-install-poc-3-local`**. Nothing is committed. The skill linter printed OK, and the path check (`adlc-task.js --paths`) ran with no `WARNING`.

**About the name:** you asked for `adlc-??`, and I read the `??` as a placeholder. INSTALL.md says that with no name given, it should be `adlc-` plus an abbreviation of the project name. Your `package.json` names the project `adlc-install-poc`, so I used `aip`. If you wanted a different abbreviation, tell me and I'll re-run the rename.

**What I did:**
- Copied the plugin from branch `feature/2026-11-10-harness-entries-ui-review` into `.claude/marketplace/plugins/adlc-aip/`, without INSTALL.md, and deleted the temporary clone.
- Replaced every `adlc-lh` with `adlc-aip` and set `displayName` to `ADLC Task Workflow (adlc-install-poc)`.
- Wrote `.claude/marketplace/.claude-plugin/marketplace.json` and added the marketplace and the enabled plugin to `.claude/settings.json`. The existing `permissions.allow` entry is unchanged.
- Created `.claude/repo_config/` and the empty task indexes `docs/tasks/todo/index.md` and `docs/tasks/done/index.md`.

**Health checks** in `.claude/repo_config/repo-health-checks.json`. All three come from the `scripts` section of `package.json`, and I ran each one to confirm it passes:

| Check | Command | Group | Comes from |
|---|---|---|---|
| lint | `npm run lint` | static | `node --check` on `src/server.js` and `src/todos.js` |
| test | `npm run test` | static | `node --test test/` |
| build | `npm run build` | build | `scripts/build.js`, which copies files to `dist/` |

I left out the template's example pre- and post-check skills because the project has none. I gave `build` its own group only because it writes `dist/`; that doesn't really affect anything, since nothing else reads `dist/`.

**Other config changes:**
- **`project-env.json`:** I removed `appUrl`, `credentialsNote`, `kbIndexPath` and `taskDetailsSkill`. The project has no web interface, no login, no knowledge base and no tracker, so those skills will skip the steps that need them. I kept `tmpDir: tmp/` and `tasksRoot: docs/tasks`.
- **`requirements-template.md`:** the modules line now lists `src | test | scripts`.

**Side effects to know about:**
- Running `npm run build` to test it created `dist/`, which is gitignored.
- `tmp/` is not in `.gitignore`, so files the skills put there will show up in `git status`.
- In the copied `README.md`, line 29 links to `.../plugins/adlc-aip` in the log-hub repo, which doesn't exist. This is a side effect of the replace-all step INSTALL.md requires; you may want to add an exception to the install instructions.

**Next:** restart Claude Code in this folder, accept the trust prompt, and try `/adlc-aip:scratch <idea>`.
