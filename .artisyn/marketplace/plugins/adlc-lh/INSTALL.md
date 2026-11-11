# Installing this plugin into another project (instructions for Claude)

`<name>` is the plugin name the user gave (`adlc-<abbr>`). If they gave none, use `adlc-` plus a
2–4 letter abbreviation of the project's name. Never `adlc-lh` (`lh` is Log Hub, where this copy
lives) and never plain `adlc` (it would collide with the upstream plugin).
`<mp>` is the project's folder name in lower-kebab-case plus `-local`.

1. Sparse-clone this folder from `https://github.com/DataArt/artisyn-log-hub` (branch `main`) into a
   temp folder outside the project. Copy everything except `INSTALL.md` to
   `.claude/marketplace/plugins/<name>/`, replacing an older copy if there is one. Delete the temp folder.
2. In the copy, replace every `adlc-lh` with `<name>`. In `.claude-plugin/plugin.json`, set
   `displayName` to `ADLC Task Workflow (<project>)`. Then
   `node .claude/marketplace/plugins/<name>/scripts/lint-skills.js` must print OK.
3. Write `.claude/marketplace/.claude-plugin/marketplace.json`:
   `{"name": "<mp>", "owner": {"name": "<project>"}, "plugins": [{"name": "<name>", "source": "./plugins/<name>"}]}`.
   Merge into `.claude/settings.json`, keeping every existing key:
   `extraKnownMarketplaces.<mp> = {"source": {"source": "directory", "path": "./.claude/marketplace"}}`
   and `enabledPlugins["<name>@<mp>"] = true`.
4. Copy `templates/repo_config/` to `.claude/repo_config/`, without overwriting existing files, and
   fit it to the project, following `templates/repo_config/README.md`. `repo-health-checks.json`
   must hold only the project's real build/lint/test commands, never invented ones. Remove example
   values that do not apply. Create `<tasksRoot>/todo/index.md` and `<tasksRoot>/done/index.md`.
5. `node .claude/marketplace/plugins/<name>/scripts/adlc-task.js --paths --project .` must print no
   `WARNING`. Do not commit. Tell the user the plugin name, the checks you configured and where each
   came from. Then tell them to restart Claude Code here, accept the trust prompt and try
   `/<name>:scratch <idea>`.
