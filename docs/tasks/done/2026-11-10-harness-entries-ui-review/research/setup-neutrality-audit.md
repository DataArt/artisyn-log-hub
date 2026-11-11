# Setup-neutrality audit (2026-11-11)

Question: a team where developers use different IDEs (VS Code, JetBrains, Cursor, none), surfaces
(CLI, IDE panel, desktop app, SDK / `claude -p`), OSes (Windows, macOS, Linux, WSL) and languages.
Where does Log Hub give wrong, skewed or unfair results today? Read-only code audit of `server/`,
`client/`, `hook/` plus three real sessions. Items marked *(verify)* depend on Claude Code behaviour
not confirmed from this repo.

## Evidence from stored sessions

| Sample | Facts |
|---|---|
| Local prod, all stored main transcripts | 297 sessions, 1 user, all Windows. `entrypoint`: `cli` 273, `sdk-cli` 19, unknown 5. IDE entries in 1 session. `diagnostics` in 147 sessions, all `source: typescript`. The sample cannot rank anything by setup. |
| VS Code + C, Windows, `cli` | `opened_file_in_ide` has only `filename` (no `ideName`), lower-case drive letter vs. `D:` in `cwd`; no `diagnostics` although clangd is installed; `turn_duration` present. |
| WSL (Ubuntu 22.04), Java, `claude -p` | `entrypoint: sdk-cli`, POSIX `cwd` under `/mnt/d/…`; **no `turn_duration`** (only `stop_hook_summary`); new line types `queue-operation`; hook ran fine (Linux node via nvm), SessionEnd flush uploaded. Repo identity became `<email>/mnt/d/_work/…` — the same folder opened from Windows would be `<email>/D:/_work/…`, i.e. two repositories. |

## Findings by impact on a mixed team

### A. Sessions or developers silently missing (H)

1. **Hook needs `node` on the PATH Claude Code was started with** (`scripts/build-hooks-installer.js:315`).
   The installer checks node from its own terminal, so it passes; a macOS desktop app or an IDE
   launched from the Dock with nvm/fnm/Homebrew node runs no hook at all — no session recorded.
2. **Transcript lookup guesses the `~/.claude/projects/<slug>` folder** (`hook/.claude/telemetry_tool/session-files.js:157-183`,
   case-sensitive compare at 166) instead of using the payload's `transcript_path`. Worktrees outside
   the repo (desktop app, Cursor), drive-letter case or macOS symlink/Unicode differences → not uploaded.
3. **Agent SDK (`sdk-ts`) sessions** load no settings unless `settingSources` is set *(verify)* → no
   plugin, no hooks, no OTEL.
4. **Team scope matches `repo_url` as exact text** (`server/src/logs/budgets/spend-read.sql.ts:222-226`,
   `repositories.service.ts:267,1188`, `teams/teams.service.ts:388`). Any spelling the normaliser misses
   drops that developer from team analytics and team budgets without a warning. Missed spellings
   (`server/src/logs/repo-url-normalizer.ts`): path case (`Org/Repo` vs `org/repo`, line 84-90), SSH host
   aliases `git@github.com-work:` (line 62), non-`git@` SSH users, `*.visualstudio.com` Azure URLs,
   Bitbucket Server `/scm/`.
5. **Local (no-remote) repo identity keeps path case** (`server/src/logs/local-repo-identity.ts:22-36`)
   and does not map Git Bash `/d/…` or WSL `/mnt/d/…` → one folder = several repositories.

### B. Numbers skewed by setup — unfair developer comparisons (M–H)

6. **Only the `Bash` tool counts commits / PRs / KB reads.** PowerShell-tool users (Windows without
   Git Bash) get 0 commits and PRs (`server/src/logs/claude-extractor.ts:1038`,
   `client/…/usage/session-usage-derive.ts:481`, Productivity counters, Executive Summary), no OKF
   reads (`okf-access-extractor.ts:346`, `okf-facts.service.ts:167`), and an empty Bash tab
   (`client/…/bash-tab/collect-bash-calls.ts:52`). PRs count only `gh` — GitLab `glab` / Azure `az repos`
   teams always show 0 (`tool-stats.ts:577`).
7. **IDE context inflates cost and context for IDE users only.** `opened_file_in_ide`,
   `selected_lines_in_ide`, `diagnostics` (only with an LSP producer) and `mcp__ide__*` tool schemas add
   tokens and cache writes; nothing separates them. Anatomy puts them into "Environment (estimated)"
   sized as JSON (`sysctx-anatomy.ts:517-522`); Context Growth files them under "other"
   (`context-data.ts:30`). TS/Java developers with an LSP look costlier than C or terminal users.
8. **No setup dimension is stored.** `entrypoint` is never extracted on the server, so `cli`,
   `sdk-cli`, `sdk-ts` are mixed in per-user session counts, cost per session, cache-ratio by user and
   "costly session" budget notices. Nested `claude -p` runs count as separate sessions, so automation-heavy
   users show more, cheaper sessions.
9. **Work time includes permission prompts, IDE diff review and `AskUserQuestion` waits**
   (`docs/knowledgebase/algorithms/work-time.md` rule 4). `claude -p` never waits → its per-hour
   numbers look better than interactive IDE users'. Overlaps `2026-11-09-session-waiting-breakdown`.
10. **Claude Code version check compares every channel with npm `stable`**
    (`server/src/ai-tool-versions/`, `client/…/summary/detectors/claude-version.ts:58`). Desktop-app
    bundled CLI, SDK pins and Homebrew / managed installs show "Outdated" and are sorted first.
11. **Lines-per-hour / cost-per-line** compare languages of very different verbosity and count only
    Edit/Write/MultiEdit (`client/…/analytics/metrics.ts:120-149`).
12. **Snapshot hashes use raw bytes** (`harness-snapshot.js:92`, `skill-catalog.js:76`,
    `okf-snapshot.js:361`): a Windows teammate with `autocrlf=true` gets different snapshot ids for the
    same commit → OKF "changed / stale" unreliable across users.
13. **File re-read detection compares raw path strings** (`server/src/logs/turn-walk.ts:177-183, 385-391`):
    `D:\r\a.ts` vs `d:/r/a.ts` is not a re-read → cache cost lands in "unattributed" on Windows.

### C. Wrong display / privacy (M)

14. **Client never gets a repo root.** `parseSessionLogs` guesses it from this repo's own top folders
    and from the shortest `CLAUDE.md` (`client/…/session-log/log-parser.ts:86-117, 2678-2712`); a Java or
    C repo (`src/main/java/…`) or a repo without `CLAUDE.md` keeps absolute paths (`/Users/alice/…`) and
    all files fall into `code`. Prefix compare is case-sensitive (2706).
15. **Only `<ide_opened_file>` is stripped from prompts** (`server/src/logs/artisyn-extractor.ts:45-48`,
    `log-parser.ts:2829`); `<ide_selection>` blocks from VS Code / JetBrains would show selected code and
    absolute paths in session titles *(verify the tag in a real transcript)*.
16. Nested JSON tool input keeps Windows `\\` paths absolute; `file://C:/…` and WSL `/mnt/c/…` forms are
    not handled (`prompt-turn-helpers.tsx:395`, `packages/bash-view/src/display-paths.ts:14`).

### D. Lower (L)

- WSL + Windows on one checkout share `.claude-logs.sent`, each prunes the other's entries → repeated
  re-uploads (`send-logs-hook.js:1108-1113`).
- SessionEnd flush can be cut if the surface kills the process *(verify)*; delayed, not lost.
- Without `CLAUDE_ENV_FILE` both Bash and PowerShell wrappers are off (`tool-wrap-shims.js:701`).
- Wrapped PowerShell commands buffer all output until exit (`tool-wrap-powershell.js:93`).
- `claude` on PATH ≠ the binary the IDE / desktop app runs (`otel-status.js:413`, post-turn worker).
- macOS `/bin/bash` 3.2 `$!` after process substitution (`tool-wrap-shims.js:197`).
- Day buckets in UTC (`scoped-sessions.sql.ts:242`, `executive-summary.service.ts:237`).
- Defaults assume this repo (`DEFAULT_REPO_CONFIG` `docs/knowledgebase`, `.ts` examples).

## Checked and setup-neutral

Change-surface path normalisation (separators, drive case, longest root); OKF path resolution
(backslashes, Git Bash `/d/…`); tool monitoring Bash/PowerShell; `normaliseClientPath`, anatomy
`pathKey`, `toRepoRelative`; remote URL SSH vs HTTPS basics; detached processes and Windows child
kill; OTEL loopback; managed-settings file locations on all three OSes.

## Test coverage gap

Hook tests are `*.algo.test.js` only, CI runs them on `ubuntu-24.04`; only `tool-wrap-fidelity` has
per-OS rows (linux, windows), none for macOS or zsh. No test covers the folder-name lookup,
`resolveClaude`, managed settings or an IDE surface. `no-visible-window.test.js` is cited in three
files but does not exist.
