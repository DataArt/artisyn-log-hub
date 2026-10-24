## Step

Work time. Open `{{SESSION_URL}}&tab=logs` and wait for the prompt turns to load. Read the duration (`h:mm:ss`, next to the clock icon) in the header of the first prompt turn.
- Take a screenshot, filename `{{SHOT_WORK_TIME}}`, showing the first prompt turn header.
- Then open `{{SESSION_URL}}&tab=summary` and read the session work time shown there (the text `<h:mm:ss> work time`).

## Judge

- `workTime`: do not compare durations yourself; the test harness checks them after you finish. Report in `observed` the first prompt turn duration first, then the Summary work time, as `turn 1 <h:mm:ss>; summary <h:mm:ss>`. Use `"pass"` when the turn duration is shown, otherwise `"fail"` with a note.

## Fields

"workTime":  { "status": "pass", "observed": "turn 1 <h:mm:ss>; summary <h:mm:ss>", "note": "", "screenshot": "{{SHOT_REL}}/work-time.png" }
