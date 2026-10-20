# T-108: Extract Hook LLM Prompts to Markdown Files

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** hook
**Owner:** denis.tsyplakov
**Created:** 2026-08-19

## Description

Move the two main-body LLM prompts out of `post-turn-analysis-worker.js` (in `hook/` src — the
source of truth, not the `.artisyn/marketplace/plugins/log-hub-hooks/` dogfood copy) into
standalone `.md` files placed next to the JS files. Two prompt builders currently embed prompt
text inline as JS template strings: `buildAdvisorPrompt()` (the turn-end cost-advisor / session
analysis prompt) and `buildAttributionPrompt()` (the session-attribution / attribute-extraction
prompt). The JS functions should load and interpolate these `.md` templates instead of
hardcoding the prompt text inline. Expect two `.md` files: one for attribute extraction, one for
analysis.

## Functional Requirements

- Extract the fixed/static prompt text currently built inline inside `buildAdvisorPrompt()` into
  a standalone markdown file (analysis prompt) living next to `post-turn-analysis-worker.js` in
  `hook/` src.
- Extract the fixed/static prompt text currently built inline inside `buildAttributionPrompt()`
  into a second standalone markdown file (attribute-extraction prompt), same location.
- Update `buildAdvisorPrompt()` and `buildAttributionPrompt()` to load their respective `.md`
  file at runtime and interpolate the existing dynamic sections (session usage summary,
  attributes list, changed files, prompt-turn sample, etc.) into it, preserving current output
  exactly.
- Propagate the change per `CLAUDE.md`'s hook workflow: run `npm run build:hooks-installer` and
  refresh the dogfooded install under `.artisyn/marketplace/plugins/log-hub-hooks/` (see
  `.claude/rules/hook.md`), including the new `.md` files in whatever packaging/copy step ships
  the hook's JS files.

## Acceptance Criteria

- [ ] Two new `.md` files exist under `hook/` src, next to `post-turn-analysis-worker.js`: one
      for the attribute-extraction (attribution) prompt, one for the analysis (cost-advisor)
      prompt.
- [ ] `buildAdvisorPrompt()` and `buildAttributionPrompt()` no longer hardcode the fixed prompt
      body as inline JS strings — they read it from the corresponding `.md` file.
- [ ] Generated prompt output (fixed sections + interpolated dynamic sections) is unchanged
      compared to before the refactor.
- [ ] `npm run build:hooks-installer` succeeds and the `.artisyn/marketplace/plugins/log-hub-hooks/`
      dogfood copy is refreshed, including the new `.md` files.

## Open Questions

- Exact filenames/naming convention for the two `.md` files.
- Packaging mechanism: how the installer/build step should bundle non-JS `.md` files alongside
  the hook scripts (e.g. plain copy vs. inlined at build time).

## Notes

<!-- Append timestamped notes here as work progresses -->
