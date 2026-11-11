Install the adlc task-lifecycle Claude Code plugin into this project as a project-local marketplace plugin.

Plugin name for this project: adlc-??
(If I left "??", pick a 2-4 letter lowercase abbreviation of this project's name, e.g. adlc-shop.
Never keep "adlc-lh" - "lh" is Log Hub, the project the plugin is copied from - and never use plain
"adlc", which collides with the upstream plugin. Below <name> means the chosen plugin name.)

Source: https://github.com/DataArt/artisyn-log-hub/tree/main/.artisyn/marketplace/plugins/adlc-lh
(public repo). Read its README.md and templates/repo_config/README.md before changing anything.

1. Fetch. Shallow sparse clone https://github.com/DataArt/artisyn-log-hub (branch main) into a
   new temp folder outside this project and check out only .artisyn/marketplace/plugins/adlc-lh.
   No git -> download the GitHub tarball of main instead. Delete only that temp folder at the end.
2. Copy the plugin folder (.claude-plugin/, skills/, workflows/, scripts/, templates/, README.md) to
   .claude/marketplace/plugins/<name>/ in this project. If it is already there, replace only that
   folder (this is how you update it; then redo the renaming below).
3. Rename the copy to <name>. First, in its README.md delete the "Install into your project with
   Claude Code" section (this prompt - it only works against the source repo) and replace the note
   that this is Log Hub's local copy with one line saying it is this project's copy of adlc. Then in
   every file of .claude/marketplace/plugins/<name>/ replace every "adlc-lh" with "<name>" (skill
   references /adlc-lh:..., adlc-lh@..., paths, plugin.json "name"), and in plugin.json set
   "displayName" to "ADLC Task Workflow (<project name>)". Change nothing else.
   Afterwards grep the folder: no "adlc-lh" and no "log-hub" may remain,
   and node .claude/marketplace/plugins/<name>/scripts/lint-skills.js must print OK.
4. Marketplace manifest .claude/marketplace/.claude-plugin/marketplace.json:
   {"name": "<mp>", "owner": {"name": "<project name>"}, "plugins": [{"name": "<name>",
   "source": "./plugins/<name>", "description": "ADLC task lifecycle"}]}.
   <mp> = this project's folder name in lower-kebab-case + "-local" (unique per project -
   marketplace names are global in Claude Code). If the file exists, add/replace only this entry.
5. Register it in .claude/settings.json (create if missing; keep every existing key, merge objects):
   extraKnownMarketplaces.<mp> = {"source": {"source": "directory", "path": "./.claude/marketplace"}}
   and enabledPlugins["<name>@<mp>"] = true.
6. Project config. Copy templates/repo_config/* to .claude/repo_config/ (never overwrite an existing
   file - adjust it instead) and fit it to THIS project:
   - repo-health-checks.json - replace every example with this project's real checks (build, lint,
     typecheck, unit/e2e tests) taken from package.json / pom.xml / *.csproj / Makefile / CI config /
     CLAUDE.md. Never invent a command: if the project has no lint, there is no lint check. Set dir,
     a group (checks that share a DB, a port or build output go in one group), finalOnly: true for
     slow ones, timeoutSeconds. Remove the example preCheckSkills / postCheckSkills entries (keep
     empty arrays) and write real environmentNotes.
   - project-env.json - appUrl only if the project runs a local web app/API (from its config or
     start script), else remove the key; tmpDir (e.g. tmp/, and add it to .gitignore); kbIndexPath
     only if a docs index exists; taskDetailsSkill empty unless a tracker skill is installed;
     paths.tasksRoot (default docs/tasks); drop credentialsNote if there is nothing to say.
   - review-dimensions.yaml, requirements-template.md - keep; remove dimensions/sections that cannot
     apply to this stack (e.g. DB with no database, UI with no frontend).
7. Task folders. Create <tasksRoot>/todo/index.md and <tasksRoot>/done/index.md (a "# Tasks" /
   "# Done tasks" heading) if missing.
8. CLAUDE.md (create if missing, else append) - a short section: task tracking always goes through
   the <name>:tracker skill, every code change follows <name>:workcycle, and the build/test commands
   live in .claude/repo_config/repo-health-checks.json.
9. Verify. Every JSON you wrote parses;
   node .claude/marketplace/plugins/<name>/scripts/adlc-task.js --paths --project .
   prints absolute paths and no WARNING; each configured check command really exists (run the fast
   ones once).
10. Do not commit. Report: the plugin name, files created/changed, each health check with where its
   command came from, anything you could not determine. Remind me to restart Claude Code in this
   folder, accept the workspace trust dialog and the marketplace/plugin install it offers (or run
   /plugin and enable <name>), then try /<name>:scratch <idea>.
