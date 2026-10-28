# 2026-10-28: KB Tag Search — Synonym Tags and a Generated Tag Index

**Status:** todo
**Priority:**
**Type:** feature
**Module(s):** knowledgebase | scripts
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
so the agent digs through code instead. Today 56 of 82 `docs/knowledgebase` articles have
front-matter `tags`, but coarse ones (`client` ×13, `server` ×12, `hooks` ×8) that do not help a
search.

Proposal agreed as the start: synonym tags in each article's front matter, plus a generated tag
index per OKF bundle that one grep hits; a ranked local search tool only later, if needed.

Related: `2026-10-27-kb-completeness-deep` (the KB-analysis skill finds failed searches and will
propose tag fixes), `2026-10-27-okf-usage-tab` (OKF bundle detection — a repo can have several
bundles).

## Functional Requirements

- **FR-1** Each KB article's OKF front matter carries **synonym tags**: the words people and
  agents use for the task the article serves, not categories. Existing coarse tags stay; the
  synonym tags are added next to them.
- **FR-2** A **generated `tags.md` in every OKF bundle** of the repo lists each tag with the
  articles that carry it, one line per tag, so a single `grep <word> <bundle>/tags.md` leads to the
  article even when the word is not in its text. It is built by a repo script from the front
  matter and never edited by hand.
- **FR-3** A check keeps `tags.md` in sync with the front matter (fails when they differ), run with
  the other KB checks.
- **FR-4** `CLAUDE.md` tells agents that search the KB to grep the bundle's `tags.md` and
  `index.md` before grepping the articles or the code.
- **FR-5** The KB-analysis skill (`2026-10-27-kb-completeness-deep`) gains a fix kind `tags` —
  "add tag X to article Y" — proposed from its failed-search findings (the words the agent searched
  for, the article it should have found).
- **FR-6** Works for every OKF bundle of a repo; a bundle's `tags.md` covers only its own articles.

## Acceptance Criteria

- [ ] FR-1/2: after adding the tag `semver` to `release-pipeline.md`,
      `grep semver docs/knowledgebase/tags.md` returns that article.
- [ ] FR-3: editing an article's tags without regenerating `tags.md` makes the check fail;
      regenerating makes it pass.
- [ ] FR-4: `CLAUDE.md` contains the tags-first search rule.
- [ ] FR-5: for a session whose agent grepped a word and missed an existing article, the skill's
      report proposes a `tags` fix naming the word and the article.
- [ ] FR-6: with two bundles, each gets its own `tags.md` listing only its articles.

## Notes

- Later, only if grep over tags proves not enough: a local ranked `kb-search <words>` tool over
  titles, descriptions, tags and headings.
