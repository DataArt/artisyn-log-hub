# 2026-10-27: KB Completeness Deep Analysis Skill

**Status:** todo
**Priority:**
**Type:** feature
**Module(s):** skill (`.claude/skills/`)
**Owner:** denis.tsyplakov
**Created:** 2026-10-27
**Tracker:** GH-45 https://github.com/DataArt/artisyn-log-hub/issues/45

## Description

Raw idea (owner, verbatim):

> и отдельной задачей заведи отдельный скил который будет строго по запросу пользователя брать
> сколько он скажем штук прошлых сессий и делать их анализ на полноту КБ но уже делая полное чтений
> пофайлово в саб агентах
> т.е. такой исчерпывающий дорогой анализ полноты КБ

A separate skill, run **only on the user's explicit request**, that takes a user-chosen number of
past sessions and runs an exhaustive, deliberately expensive analysis of how complete the knowledge
base is for them. Unlike the post-turn OKF analysis of `2026-10-27-okf-usage-tab` (only the KB
index in the prompt, the model reads a few files with moderate curiosity), this skill reads the
**whole KB, file by file, in sub-agents**.

Related: `2026-10-27-okf-usage-tab` (transcript task-context assembly FR-22, KB access extraction
FR-1/FR-23, OKF bundle detection FR-7); PoC `docs/pocs/2026-10-27-1950-okf-analysis-cost/`; the
existing `session-kb-suggest` skill (suggests one KB article from a single past session).

## Functional Requirements

- **FR-1** Manual-only skill: its description says it never triggers on its own; it runs only when
  the user invokes it.
- **FR-2** Input: how many past sessions to analyse (the latest N of the current repo) or an
  explicit list of session ids; the skill states the session count and asks for confirmation
  before spending anything, since the run is expensive.
- **FR-3** For each session, build the task context and the KB accesses from the session's own
  transcript (sub-agents included), the same way as `2026-10-27-okf-usage-tab` FR-22 / FR-1.
- **FR-4** The KB = every OKF bundle of the repo (`index.md` with `okf_version`, nested indexes
  belong to the parent bundle). Sub-agents read **every** KB article in full, split across
  sub-agents by file batches so that no agent's context is overloaded.
- **FR-5** Per session, the sub-agents judge each article against the session's task: relevant
  and read; relevant but not read (a miss); read but not needed (a false read); and what the KB
  lacks — facts the session had to dig out of code or ask about, with no article covering them.
- **FR-6** Output: one report per session plus an aggregated KB-completeness report across all
  analysed sessions, with concrete fix suggestions (new article, extend article X, fix index
  entry Y, split or merge), ranked by how many sessions each would have helped.
- **FR-7** Reports are written to a gitignored location (under `tmp/`), never into the KB itself;
  the skill only suggests changes.

## Acceptance Criteria

- [ ] FR-1: the skill does not run unless the user invokes it by name.
- [ ] FR-2: invoked with `5`, it lists the 5 latest sessions and asks for confirmation before any
      sub-agent starts; invoked with explicit ids, it uses exactly those.
- [ ] FR-3: a session whose task is a one-line question gets that prompt as its whole task context.
- [ ] FR-4: the run log shows every KB article read in full by some sub-agent, exactly once per
      session.
- [ ] FR-5/6: each per-session report lists misses, false reads and KB gaps with reasons; the
      aggregated report ranks fix suggestions by the number of sessions they would have helped.
- [ ] FR-7: no file under the KB folders is changed by a run; reports land under `tmp/`.

## Notes
