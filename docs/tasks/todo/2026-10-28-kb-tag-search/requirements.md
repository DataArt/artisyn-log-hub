# 2026-10-28: KB Tag Search — Synonym Tags and a Generated Tag Index

**Status:** todo
**Priority:**
**Type:** feature
**Module(s):** knowledgebase | repo skills
**Owner:** denis.tsyplakov
**Created:** 2026-10-28
**Tracker:** GH-46 https://github.com/DataArt/artisyn-log-hub/issues/46

## Description

Raw idea (owner, verbatim):

> гляди в то что агент дошел до статьи без индекса криминала нет.
> он сделал grep и на нашел.
> я бы по идее сделал еще какой-то поиск/индекс по тегам но пока не знаю точно как надо - можешь
> преложить

> поиск по тегам сделай отдельной задачей

Agents often reach KB articles by `grep` instead of the index, which is fine when the grep finds
the article. The problem is a grep that misses: the article exists, but the words the agent
searched for (the task's words — "semver", "shared package", "PostToolUse payload") are not in it,
so the agent digs through code instead. Today 56 of the 79 `docs/knowledgebase` articles (82 `.md`
files minus 3 `index.md`) have front-matter `tags`, but coarse ones (`client` ×13, `server` ×12,
`hooks` ×8) that do not help a search; the 23 without tags are all in `algorithms/`.

Proposal agreed as the start: synonym tags in each article's front matter, plus a generated tag
index per OKF bundle that one grep hits; a ranked local search tool only later, if needed.

Related: `2026-10-27-kb-completeness-deep` (the KB-analysis skill finds failed searches and will
propose tag fixes), `2026-10-27-okf-usage-tab` (OKF bundle detection — a repo can have several
bundles; facts route FR-20).

## Functional Requirements

- **FR-1** Each KB article's OKF front matter carries **synonym tags**: the words people and
  agents use for the task the article serves, not categories. Existing coarse tags stay; the
  synonym tags are added next to them. This task includes the initial pass over every article of
  `docs/knowledgebase` (the 23 untagged `algorithms/` docs included).
- **FR-2** A **generated `tags.md` in every OKF bundle** of the repo lists each tag with the
  articles that carry it, one line per tag, so a single `grep -i <word> <bundle>/tags.md` leads to
  the article even when the word is not in its text. It is built by a repo script from the front
  matter and never edited by hand.
- **FR-3** A check keeps `tags.md` in sync with the front matter (fails when they differ), run as
  a `static` health check in `repo-health-checks.json`.
- **FR-4** A **repo skill `kb-tags`** (`.claude/skills/kb-tags/`, this repo only — not shipped
  with the hooks plugin) owns the tags and the generator script:
  1. **How to write tags** — start from the existing tag list (the bundle's `tags.md`) and reuse a
     tag that fits before inventing one; tags are the words a person or agent would search for the
     task the article serves (synonyms, task words, key identifiers), not categories.
  2. **When** — its trigger: every time an agent adds, changes or deletes a KB article, it updates
     that article's tags and runs the generator to rebuild `tags.md`.
- **FR-4a** Every place in this repo that tells an agent to start from the KB index (`CLAUDE.md`
  Knowledgebase section, the repo skills `session-kb-suggest` and `post-impl-check-kb-actual`)
  adds: also look at the bundle's `tags.md` — a tag there may point to a useful article the index
  line does not name.
- **FR-5** The KB-analysis skill (`2026-10-27-kb-completeness-deep`) gains a fix kind `tags` —
  "add tag X to article Y" — proposed from its failed-search findings (the words the agent searched
  for, the article it should have found). This needs the search words in the skill's input: the
  per-agent facts (`2026-10-27-okf-usage-tab` FR-20, `kb-completeness-deep` FR-4) carry each KB
  search — tool, pattern, searched path, number of matching files — for the Grep tool and for
  `grep`/`rg` in Bash; no result text.
- **FR-6** Works for every OKF bundle of a repo; a bundle's `tags.md` covers only its own articles.
- **FR-7** The OKF tab (`2026-10-27-okf-usage-tab`) treats a bundle's `tags.md` like its
  `index.md`: an access to it counts as starting from the index (FR-12 there), it is excluded from
  the "always read" rule (FR-17a there) and from the file-share numerator and denominator.

## Acceptance Criteria

- [ ] FR-1/2: after adding the tag `semver` to `release-pipeline.md`,
      `grep -i semver docs/knowledgebase/tags.md` returns that article.
- [ ] FR-1: every article of `docs/knowledgebase` (not `index.md`, not `tags.md`) has a non-empty
      `tags` list.
- [ ] FR-2: an article whose tags are written as an inline list (`tags: [a, b]`) and one written as
      a block list (`tags:` + `- a`) both appear in `tags.md`.
- [ ] FR-3: editing an article's tags without regenerating `tags.md` makes the check fail;
      regenerating makes it pass.
- [ ] FR-4: the `kb-tags` skill exists, says to read the existing tag list first, and its
      description triggers on any KB article change; following it after adding an article leaves
      `tags.md` in sync (FR-3 check passes).
- [ ] FR-4a: `CLAUDE.md`, `session-kb-suggest` and `post-impl-check-kb-actual` each tell the agent
      to look at `tags.md` next to `index.md`.
- [ ] FR-5: for a session whose agent grepped a word and missed an existing article, the facts
      carry that search (pattern, path, match count) and the skill's report proposes a `tags` fix
      naming the word and the article.
- [ ] FR-6: with two bundles, each gets its own `tags.md` listing only its articles; a nested
      `index.md` without `okf_version` (`log-schema/`, `test/`) does not start a bundle.
- [ ] FR-7: a session whose only KB entry is a grep of `tags.md` shows "started from index" in the
      OKF tab; `tags.md` never appears as an "always read" anomaly.

## Common sense considerations

- Generator: one Node script inside the `kb-tags` skill folder with a `--check` mode; the health
  check calls the `--check` mode; no new dependency (front-matter lists parsed in both YAML forms).
- The local `adlc-lh` plugin copy (it reads `kbIndexPath`) is not edited; the pointer line in each
  bundle's `index.md` reaches agents that follow it.
- Bundle detection follows `2026-10-27-okf-usage-tab` FR-7 (an `index.md` with `okf_version`; a
  nested `index.md` without it belongs to the parent; a file belongs to the deepest bundle).
- `tags.md` format: OKF front matter like the other files, then one line per tag, sorted, tags
  lowercased: `* <tag> — [Title](path), [Title](path)`; `index.md` and `tags.md` themselves are not
  listed.
- Multi-word tags are allowed ("shared package"); agents grep `tags.md` case-insensitively.
- The generator writes `tags.md` into gitignored bundles too (`docs/kb-local`); the check covers
  whatever bundles exist in the working tree, so it passes in a clone without `docs/kb-local`.
- Each bundle's `index.md` gets one line pointing to its `tags.md`.
- Tests: the generator's parsing and sync check go into the existing build-script tests
  (`scripts/__tests__/`, `npm run test:scripts`); no scenario (no app behaviour changes).
- FR-5 and FR-7 are implemented in their own tasks; this task adds the matching lines to
  `2026-10-27-kb-completeness-deep` and `2026-10-27-okf-usage-tab` requirements.

## Notes

- Measured on 612 local transcripts of this repo (2026-10-28): 160 transcripts grep the KB, 489
  KB greps, 17 returned nothing; most empty ones searched code identifiers
  (`systemContext`, `AgentRawLogsModal`) or words the KB has since gained. An empty grep is a weak
  signal; a grep that returns hits but not the right article is not detectable from facts alone —
  that judgment stays with the skill (FR-5).
- The PoC facts (`docs/pocs/2026-10-27-1950-okf-analysis-cost/facts.ts`) keep no search words:
  `kbSeq` records only `Bash <path>` / `Grep <path>`, and Bash `grep` patterns are dropped
  entirely — hence the facts extension in FR-5.
- Later, only if grep over tags proves not enough: a local ranked `kb-search <words>` tool over
  titles, descriptions, tags and headings.
