## Step

Bash tab. Open `{{SESSION_URL}}&tab=bash` and wait for the tab (`data-testid="session-bash-tab"`) to load.
- For each row of the expected `bash` list, find the Bash call row (`data-testid="bash-call-row"`) whose command contains that row's `command` text, and open it (click it) to see its details.
- In each opened row read: the status badge (`data-testid="tool-status-badge"`; a successful call shows no badge, a failed call shows `✗ error`), the Working dir line (`data-testid="bash-workdir"`, may be absent), and the FILES block (`data-testid="bash-files"`) with its runs list (`data-testid="bash-files-runs"`).
- Read all the text in each such row and note whether it contains an absolute path (one starting with a drive letter such as `D:/` or `C:\`, or with `/home/`, `/Users/`, `/tmp/` or `/d/`).
- Take a screenshot, filename `{{SHOT_BASH}}`, showing the opened row(s).

## Judge

- `bash`: passes only if, for every row of the expected `bash` list, all of these hold: (a) a `bash-call-row` with that command is shown; (b) its status matches — `ok` means no `tool-status-badge`, `error` means the badge reads `✗ error`; (c) when `workDir` is a string, `bash-workdir` shows exactly that value, and when `workDir` is `null`, no `bash-workdir` line is shown; (d) `bash-files-runs` contains `node`; (e) no text in that row contains an absolute path. Extra Bash rows are allowed.

## Fields

"bash":      { "status": "pass", "observed": "<per expected command: shown?, status, working dir, runs, absolute path?>", "note": "", "screenshot": "{{SHOT_REL}}/bash.png" }
