## Step

Bash paths. Open `{{SESSION_URL}}&tab=bash` and wait for the tab (`data-testid="session-bash-tab"`) to load.
- Find the Bash call row (`data-testid="bash-call-row"`) whose command reads the file of the expected `bashPaths.read`, and open it (click it).
- Read its FILES block (`data-testid="bash-files"`), in particular the reads list (`data-testid="bash-files-reads"`).
- Read all the text in the row and note whether it contains an absolute path (one starting with a drive letter such as `D:/` or `C:\`, or with `/home/`, `/Users/`, `/tmp/` or `/d/`).
- Take a screenshot, filename `{{SHOT_BASH_PATHS}}`, showing the opened row.

## Judge

- `bashPaths`: passes iff `bash-files-reads` of that row shows the repo-relative path `bashPaths.read`, and no absolute path appears anywhere in the row.

## Fields

"bashPaths": { "status": "pass", "observed": "<reads list; absolute path shown?>", "note": "", "screenshot": "{{SHOT_REL}}/bash-paths.png" }
