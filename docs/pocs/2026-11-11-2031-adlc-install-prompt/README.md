# PoC: install adlc-lh into another project with one Claude prompt

Task: ad-hoc (no task folder) — add a "install it with Claude" prompt to
`.artisyn/marketplace/plugins/adlc-lh/README.md`.

## Question

Can a user point Claude Code at the plugin's GitHub folder with one pasted prompt and get a working
project-local marketplace install — plugin copied, marketplace registered, and `.claude/repo_config/`
fitted to *their* project (real build/test commands, not the template examples)?

## How to run

1. Create a small target project outside this repo (used: `D:\_work\Artisyn-LogHub\adlc-install-poc`,
   a dependency-free Node todo API with `lint` / `test` / `build` scripts and an existing
   `.claude/settings.json` holding one `permissions.allow` entry), `git init` + commit a baseline.
2. From that folder:
   ```powershell
   Get-Content -Raw <this folder>\install-prompt.md | claude -p --dangerously-skip-permissions
   ```
3. Check: `git status` / `git diff`, then that the skills load (see Result).

`install-prompt.md` is the canonical prompt; the plugin README embeds it verbatim. Run 2 used it
minus the first sentence of step 3 (deleting the README's own install section), which was added
after it: the README on `main` did not have that section yet, but once it does, a blind
`adlc-lh` → `<name>` replace would rewrite the source URL inside the copied prompt.

## Result

Works. Two runs:

- **Run 1** (`run-output.md`, target `adlc-install-poc`) — first prompt version, which kept the
  plugin name `adlc-lh`. Rejected: `-lh` means Log Hub, so another project must get its own slug.
- **Run 2** (`run-output-2.md`, target `adlc-install-poc-2`, clean clone of the same baseline) —
  prompt with the rename step, `adlc-??` left unfilled. Claude picked `adlc-aip` ("adlc install
  poc"), copied the plugin to `.claude/marketplace/plugins/adlc-aip/`, replaced all `adlc-lh`
  (210 `adlc-aip:` skill references afterwards, zero `adlc-lh` / `log-hub` left), set
  `displayName`, rewrote the README note, and `lint-skills.js` printed OK. Settings:
  `enabledPlugins["adlc-aip@adlc-install-poc-2-local"]`. Config results identical to run 1.

Details below are from run 1; run 2 matched them.

- Plugin copied unchanged (Claude ran `diff -r` against the clone itself) to
  `.claude/marketplace/plugins/adlc-lh/`; marketplace `adlc-install-poc-local` created; temp clone
  deleted.
- `.claude/settings.json` merged — the existing `permissions` kept, `extraKnownMarketplaces` and
  `enabledPlugins` added.
- `repo-health-checks.json` holds exactly the three real checks from `package.json` (`lint`,
  `unit-tests` in group `static`, `build` in its own group because it writes `dist/`), each run once;
  example pre/post skills removed; project-specific `environmentNotes`.
- `project-env.json`: `appUrl` derived from the server's default `PORT`, `tmpDir` added to
  `.gitignore`, `kbIndexPath` / `credentialsNote` dropped as not applicable.
- `docs/tasks/{todo,done}/index.md` and a `CLAUDE.md` section created; `adlc-task.js --paths` clean.

Skill loading:

- A headless `claude -p` in a never-trusted folder ignores project settings, so no `adlc-lh:*`
  skills appear — expected; the user's interactive restart + trust dialog covers it.
- After `claude plugin marketplace add ./.claude/marketplace` +
  `claude plugin install adlc-lh@adlc-install-poc-local --scope project`, all 19 `adlc-lh:*` skills
  (14 skills + 5 `-wf` workflows) were listed by a fresh session.
- Gotcha: `claude plugin marketplace remove <mp>` also empties `extraKnownMarketplaces` /
  `enabledPlugins` in the project's `.claude/settings.json` — the README warns about it.
