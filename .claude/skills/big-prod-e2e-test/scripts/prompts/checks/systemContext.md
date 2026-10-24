## Step

System context. Open `{{SESSION_URL}}&tab=logs` and wait for the prompt turns to load. Find the system context panel (`data-testid="sysctx-panel"`) and press its "Show details" button.
- Open the rules tab (`data-testid="sysctx-tab-rules"`) and read the rule rows (`data-testid="sysctx-rule-row"`).
- Open the skills tab (`data-testid="sysctx-tab-skills"`) and read the skill rows (`data-testid="sysctx-skill-row"`, the name is in `data-skill-name`) with their source badge (`project`, `user` or `plugin`).
- Open the files tab (`data-testid="sysctx-tab-files"`) and read the file rows (`data-testid="sysctx-file-row"`) with their type.
- Take a screenshot, filename `{{SHOT_SYSCTX}}`, showing the panel with its details open, on the tab that holds the expected entries.

## Judge

- `systemContext`: passes iff every entry of the expected `sysctx` lists is present: each name in `sysctx.rules` as a `sysctx-rule-row`; each `sysctx.skills` entry as a `sysctx-skill-row` with that name and its `source` as the source badge; each `sysctx.files` entry as a `sysctx-file-row` with that `name` and `type`. This check runs in one direction only: other rows are allowed, and an empty expected list asks for nothing.

## Fields

"systemContext": { "status": "pass", "observed": "<rules; skills with source; files with type>", "note": "", "screenshot": "{{SHOT_REL}}/sysctx.png" }
