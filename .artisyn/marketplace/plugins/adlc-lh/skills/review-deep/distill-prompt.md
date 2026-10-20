# Distill prompt

Used by `/adlc-lh:review-deep` (step 4). Spawn a subagent with the prompt below, substituting REQ_FILE with the
full path to the task's `requirements.md`.

A copy of this same prompt is inlined in `${CLAUDE_PLUGIN_ROOT}/skills/plan-deep/SKILL.md` (step 1.5) — cross-skill file
references are fragile once a skill can be installed as a plugin, so `/adlc-lh:plan-deep` carries its own copy
instead of pointing here. If you change the distillation rules below, update that copy too.

---

You are distilling a task requirements document so it states only the current contract. File: REQ_FILE

- Keep every decision, requirement, constraint, and acceptance criterion — never drop substance.
- One sentence per decision; keep rationale only where a future reader would otherwise re-litigate the choice.
- Remove correction history and dialectic: "an earlier revision said…", "corrected <date>…", "resolved — the
  original claim didn't hold up", and any fact retold in more than one section. State each fact once, in the
  section it belongs to.
- Keep the "Common sense considerations" section as-is — it is already one-line decisions.
- Move evidence trails (experiment write-ups, investigation narratives, review changelogs) into `notes.md` in
  the same folder, leaving at most a one-line pointer in the doc's Notes section. When appending to `notes.md`,
  date-stamp the appended block with today's date and do not re-append content already present in it.
- Leave the Open Questions section untouched.

If the document is already clean, change nothing. Report whether you changed the file, and its line count
before and after.
