## Step

System context (Anatomy tab). Open `{{SESSION_URL}}&tab=sysctx` and wait for the partition rows (`data-testid="anatomy-partition-row"`) to load.
- Click the Skills partition row (`[data-testid="anatomy-partition-row"][data-kind="skills"]`) to open its drill-down. Click the row itself, not its chevron; a click on an already open row keeps it open. Skill rows are `data-testid="anatomy-skill-row"`, with the name in `data-skill-name` and the source in `data-source` (`project`, `user` or `plugin`). Only the first 10 skills show at first: if a button reading `Show all N skills` is shown, press it.
- Click the Instruction files partition row (`[data-testid="anatomy-partition-row"][data-kind="instruction-file"]`) to open its drill-down as well. File rows are `data-testid="anatomy-file-row"`, with the path in `data-path` (repo-relative; user files as `~/.claude/...`). Columns: Path, Kind, Git, File size, Loaded B, ≈ Tokens, Share — the 2nd `td` is the Kind cell (`claude-md`, `local-md`, `user-md` or `rule`). Rows after the header row reading "On demand — 0 at start" are on-demand; the rows before it are loaded.
- Read every skill row (`data-skill-name`, `data-source`) and every file row (`data-path`, Kind cell text, and whether it is in the loaded group or the On-demand group), for example with one evaluate call.
- Take a screenshot, filename `{{SHOT_SYSCTX}}`, showing both open drill-downs (skills and instruction files).

## Judge

- `systemContext`: passes iff every entry of the expected `sysctx` lists is present: each `sysctx.skills` entry `{ name, source }` as an `anatomy-skill-row` whose `data-skill-name` equals `name` and whose `data-source` equals `source`; each `sysctx.files` entry `{ pathSuffix, kind }` as an `anatomy-file-row` whose `data-path` ends with `pathSuffix` and whose Kind cell equals `kind` (both must hold — the suffix `CLAUDE.md` also matches `~/.claude/CLAUDE.md`, whose Kind is `user-md`); each `sysctx.rules` entry `{ pathSuffix, kind }` matched the same way, in either the loaded group or the On-demand group. This check runs in one direction only: other rows are allowed, and an empty expected list asks for nothing.

## Fields

"systemContext": { "status": "pass", "observed": "<skills with source; file rows with path, Kind and group (loaded / on-demand)>", "note": "", "screenshot": "{{SHOT_REL}}/sysctx.png" }
