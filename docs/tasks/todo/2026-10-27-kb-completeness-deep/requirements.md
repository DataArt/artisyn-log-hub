# 2026-10-27: KB Analysis Skill — On-Demand Opus Analysis of Past Sessions

**Status:** todo
**Priority:**
**Type:** feature
**Module(s):** hook (skill shipped with the hooks plugin) | server (read-only data it pulls)
**Owner:** denis.tsyplakov
**Created:** 2026-10-27
**Tracker:** GH-45 https://github.com/DataArt/artisyn-log-hub/issues/45

## Description

Raw idea (owner, verbatim):

> и отдельной задачей заведи отдельный скил который будет строго по запросу пользователя брать
> сколько он скажем штук прошлых сессий и делать их анализ на полноту КБ но уже делая полное чтений
> пофайлово в саб агентах
> т.е. такой исчерпывающий дорогой анализ полноты КБ

Later the same day, after the PoC (owner, verbatim):

> доллар за анализ уже чета дофига
> давай наверное это сделаем скилов который ставится вмиесте с хуками и делает дорогой но более
> толковый анализ сессий опусом уже
> сначала он решает какие сесси взять в ангализ потом анализирует, мжет подтягивать данные с log hub
> но результат туда не заливает а чинистя все локально разработчиком

An on-demand skill, installed together with the Log Hub hooks, that analyses how well the project's
knowledge base (KB) served past sessions — with Opus, deliberately thorough and expensive, and only
when the developer asks. It first chooses which sessions are worth analysing, then analyses them,
and leaves a local report of concrete KB and harness fixes that the developer applies by hand.
Nothing is sent back to Log Hub. This replaces the per-turn LLM analysis that was dropped from
`2026-10-27-okf-usage-tab` (FR-19 there) because one run cost $0.45–0.90 per session.

The analysis design comes from the PoC `docs/pocs/2026-10-27-1950-okf-analysis-cost/` (iterations
v1–v4f on real sessions of this repo; README there).

### What a good KB is (owner, 2026-11-03)

Owner, verbatim:

> общая идея в том, что KB должна экономить исследованеи кода И должна нести в себе неявное знание
> о проекте
> все что может быть легко добыто и главное найдено из кода там быть не должно
> также KB должна заполнять гэп - я не знаю то чего не знаю. т.е. какие-то вещи могут быть в коде
> но только если claude будет знать что их надо искать

The skill judges the KB against these four criteria — they are its definition of KB quality:

- **C1 Saves exploration** — with the KB an agent reaches the answer in fewer code searches and
  reads than without it. A KB read followed by the agent re-deriving the same thing from code is
  a failure of the article (or of its granularity), not a success.
- **C2 Implicit knowledge** — the KB carries what the code does not say: why a decision was made,
  traps, invariants that span packages (server / client / hook twins), backward-compatibility
  constraints, environment quirks.
- **C3 Nothing derivable** — what is both easy to derive AND easy to find from code (file lists,
  field lists, route tables a grep finds in seconds) does not belong in the KB: it rots and costs
  context. Derivable but *hard to find* (non-obvious locations, cross-package wiring) is
  navigational content and stays.
- **C4 Unknown unknowns** — the KB tells the agent what it would not know to look for: things that
  are in the code, but that Claude finds only if it knows they exist ("there is a second copy of
  X in `hook/` you must update too").

Granularity and findability (FR-7 passes 1–3) serve C1; they are means, not the goal.

## Functional Requirements

### Shipping and trigger

- **FR-1** The skill ships in the hooks plugin (`hook/` is the source of truth; installer, version
  bump and the dogfooded copy per `.claude/rules/hook.md`), so every project with the hooks has it.
  It is manual-only: its description says it never triggers on its own. Its name is `kb-analysis`,
  so it runs as `/log-hub-hooks:kb-analysis [session ids]` — the session OKF tab of
  `2026-10-27-okf-usage-tab` already shows that command as a hint (`KB_ANALYSIS_COMMAND` in
  `SessionOkfTab.tsx`); rename both together.

- **FR-1a** A bundle's `index.md` is the entry point and read by design: the skill never reports
  it as over-read, a flood, a hot or coarse article, and leaves it out of every share, like the
  deterministic OKF analysis (`docs/knowledgebase/algorithms/okf-verdict.md`, "Articles"). Not
  reaching the KB through the index is still a finding.

### Step 1 — choose the sessions

- **FR-2** The developer can name the sessions (ids, "the last N", a period, a branch). Without
  that, the skill proposes candidates itself from the Log Hub data of the current repo: sessions
  whose deterministic OKF verdict (`2026-10-27-okf-usage-tab` FR-14a) is not OK, sessions where
  agents reached KB articles without the index, KB flood, and long code exploration with few KB
  reads — ranked, with the reason for each.
- **FR-3** Before spending anything it shows the chosen sessions, the reason for each and an
  estimated cost, and waits for confirmation.

### Step 2 — analyse

- **FR-4** Input per session — no transcript text: the filtered user prompts and the per-agent
  facts (each sub-agent with its own spawn prompt; KB reads, the order of first KB accesses, other
  files read and changed), pulled from Log Hub (`GET /api/v2/okf-usage/facts`,
  `2026-10-27-okf-usage-tab` FR-20) with the hook's API key; when the server lacks the route, the
  skill builds the same facts from the local transcripts with the same session analyser.
- **FR-5** The KB and the harness are judged **as they were when the session started**: every OKF
  bundle of the repo (a repo can have several, wherever they live — detected as in
  `2026-10-27-okf-usage-tab` FR-7; a gitignored bundle is copied from the working tree, since git
  has no history for it), the folders the prompts point at (e.g. `docs/tasks/`), `CLAUDE.md`, `.claude/rules`, `.claude/skills` and the plugin skills of the last commit before
  the session, unpacked with read-only `git archive` into a temporary folder outside the repo
  (harness files under a `harness/` subfolder so they are not loaded as the model's own
  instructions).
- **FR-6** Goal: KB quality as defined by C1–C4 (Description) — not session cost; granularity and
  findability are judged as means to C1. Each sub-agent is an
  independent task judged only against its own prompt; an article read by several agents is not a
  finding; an unread article is not a problem unless it would clearly have helped that agent.
- **FR-7** The analysis runs as **specialised passes in parallel** sub-agents (Opus), each owning
  one class of findings so that no class is traded away for another (the PoC's single combined
  prompt lost the entry-point class and some index-line findings between runs):
  1. **Entry** — for every agent whose search did **not** find an existing relevant article (it
     grepped or listed the KB, missed, and dug into code instead; reaching an article without the
     index is fine when the grep found it): what its instructions said
     (the current `CLAUDE.md`, the skill's sub-agent prompt template, its own prompt — quoted) and
     why they did not route it to the index; proposes `entryFixes` at the point the instruction
     failed to reach the agent, never a duplicate of an existing rule, or states explicitly that
     the instructions are sufficient.
  2. **Findability** — the lines of every bundle's index versus the words of each agent's task
     (including the case where the article sits in another bundle than the one the agent searched): quotes the current line
     and the missing words; proposes `index_line`, `section_pointers` or `index_grouping` fixes.
  3. **Granularity and gaps** — big articles read for a small part (`split`, `section_pointers`),
     knowledge dug out of code with no article (`new_article`); checks the KB before naming a gap.
  4. **Completeness (deep mode, opt-in)** — sub-agents read every KB article in full, in batches,
     and judge each against the sessions' tasks (the original idea of this task).
  5. **Redundancy (C1, C3)** — for every KB article an agent read: did the agent then search and
     read code in the same area for the same fact? If yes, either the article did not answer
     (`granularity` / missing content) or its content is derivable and should go (`derivable`).
     Independently of sessions, the pass may sample article sections and classify them as
     derivable-and-easy-to-find (cut), navigational (keep) or implicit (keep), checking a few
     claims against the code of the session's commit (stale claims are reported as `stale`).
  6. **Implicit knowledge and unknown unknowns (C2, C4)** — where the session went wrong: user
     corrections in the prompts ("нет", "не так", "you forgot …"), rework, a fix made in one copy
     of a twin but not the other, a constraint violated and then repaired. For each: was the
     missing knowledge in the KB (then `index_line` / `entry_point` / `agent_choice`), only in
     `CLAUDE.md` / rules / a code comment, or nowhere (`missing_implicit`, with the proposed
     article, section or "Gotchas" bullet and the index-line words that would have routed the
     agent there). Optional evidence source, opt-in: fix commits and `keep in sync` / `Twin:`
     comments of the repo, to tell a one-off from a recurring trap.
- **FR-8** Each finding carries a `cause`: `entry_point`, `index_line`, `granularity`,
  `derivable` (content that should be cut — C3), `stale` (claim contradicts the code),
  `missing_implicit` (knowledge the agent needed and could not have known to look for — C2/C4) or
  `agent_choice` (KB fine, agent ignored it — reported, no fix). Each finding also names the
  criterion (C1–C4) it serves. The passes' results are merged
  deterministically (dedup by path + kind) and filtered: no `split` for articles under 20 KB, no
  index-line fix whose keywords the current line already has.

### Output

- **FR-9** A local report under `.artisyn/ai_work_dir/kb-analysis/<timestamp>/` (gitignored): one
  section per session (agents, their reads with verdict, granularity, findability and cause) and an
  aggregated, ranked list of `kbFixes` and `entryFixes` with how many sessions each would have
  helped and the evidence, grouped by criterion C1–C4; `kbFixes` include cuts (`derivable`,
  `stale`) as well as additions, so a run can shrink the KB. Nothing is uploaded to Log Hub; the skill never edits the KB or the
  harness — the developer applies the fixes.

## Non-Functional Requirements

- Cost is stated before the run (FR-3) and in the report (real spend per session).
- Backward compatibility: a skill from a newer hook against an older server falls back to local
  transcripts (FR-4); the skill adds no hook API field.

## Acceptance Criteria

- [ ] FR-1: after installing the hooks the skill is available and never runs unless invoked.
- [ ] FR-2/3: invoked without arguments, it proposes ranked sessions with reasons and an estimated
      cost, and starts nothing before confirmation; invoked with ids, it uses exactly those.
- [ ] FR-4: the analysis input carries no tool result text; against a server without the facts
      route the same facts come from local transcripts.
- [ ] FR-5: an article created after a session never appears as a miss or a gap for it.
- [ ] FR-7/8: on the PoC sessions, the report keeps the entry-point class (agents that skipped the
      index, with the instruction that failed to reach them), the `server-conventions.md` case as
      `agent_choice` with no KB fix, the 100–170 KB monoliths as `granularity`, and the
      `hook-system-overview.md` PostToolUse index-line miss.
- [ ] FR-7 passes 5/6: the report contains at least one `derivable` cut proposal for a big
      list-style article (e.g. `client-component-map.md`, `db-tables.md`) and, for a session with
      a user correction, a `missing_implicit` or routing finding that names the knowledge that
      would have prevented it.
- [ ] FR-8/9: every finding names its criterion (C1–C4); the report is grouped by criterion.
- [ ] FR-9: a run changes no file in the KB or the harness and uploads nothing; the report ranks
      fixes by the number of sessions helped.

## Notes

- Open idea (2026-10-28, owner asked for a proposal, not decided yet): make KB search work for
  agents that grep — (1) **synonym tags** in each article's front matter in the words people and
  agents use for the task (today 56 of 82 articles have tags, but coarse ones: `client` ×13,
  `server` ×12); (2) a **generated `tags.md` per bundle** (tag → articles) that one grep hits, with
  a `CLAUDE.md` rule to grep `tags.md` and `index.md` first; (3) later, if needed, a local
  ranked `kb-search` tool. This skill would gain a fix kind `tags` ("add tag X to article Y")
  fed by its failed-search findings. Recommended start: (1) + (2), as a separate task.
- PoC: `docs/pocs/2026-10-27-1950-okf-analysis-cost/` — the design and evidence for FR-4–FR-8; a
  single combined prompt measured $0.45–0.90 and 4–7 min per session with Sonnet.
- **2026-11-03:** C1–C4 added after a manual five-method evaluation of this repo's KB against the
  local-prod OKF data (content audit, usage stats, session case studies, trap inventory, critique
  of the OKF view). The trap inventory found 39 traps: 54 % documented and routed by the index,
  13 % documented but not routed, 10 % only in `CLAUDE.md` / rules, 23 % nowhere (Drizzle array
  binding, per-request transcript reads, hook twins of server logic outside algorithm docs,
  runtime-layout bugs of `static-dir.ts`). Pass 6 is modelled on that method. Pass 5 may need the
  order of code searches/reads relative to KB reads per agent; if the facts route lacks it, add
  it as an optional response field (older skills ignore it) or take it from local transcripts.
- Related: `2026-10-27-okf-usage-tab` (facts route FR-20, deterministic verdict FR-14a/FR-17a);
  the existing repo skill `session-kb-suggest` (one KB article from one past session).
