# T-108: Key design decisions

- **The source of truth is `hook/`.** Edits are made only in the `hook/` src, not in the dogfooded
  copy `.artisyn/marketplace/plugins/log-hub-hooks/`. The copy is updated by the standard process
  (`npm run build:hooks-installer` + the steps from `.claude/rules/hook.md`), not by hand.

- **Exactly two files, no more.** One `.md` for the attribute-extraction prompt
  (`buildAttributionPrompt()`), the second for the analysis/cost-advisor prompt
  (`buildAdvisorPrompt()`). There is no need to split each prompt into several files — the task is
  specifically to separate "code" and "prompt text", not to rework the structure of the prompts
  themselves.

- **File location — next to the JS.** The `.md` files are placed in the same `hook/` src directory
  where `post-turn-analysis-worker.js` lives, not in a separate `prompts/` folder — so that it is
  obvious which file belongs to which function, without extra navigation.

- **Only the static text is extracted, not the whole prompt assembly.** The fixed part
  (System/instructions, static paragraphs) goes into the `.md`. The dynamic sections (session usage
  summary, attribute list, list of changed files, truncated sample of user messages) are still
  assembled in JS and substituted into the loaded template — it is just that the substitution
  point is now not a literal in the code but a place in the `.md` file.

- **The output prompt text must not change.** The refactoring is purely structural: what is
  currently sent to `claude -p` must stay byte-for-byte the same after moving the text into the
  `.md` and substituting it back into the code.

- **The substitution format and exact file names are an open question** (see `open-questions.md`):
  it needs to be decided how exactly to interpolate the dynamic sections into the loaded `.md`
  (simple `{{...}}` template-engine-style placeholders vs. concatenation of "loaded text + generated
  sections"), and how these `.md` files should get into the hooks-installer package (copying as is
  vs. inlining at build time).
