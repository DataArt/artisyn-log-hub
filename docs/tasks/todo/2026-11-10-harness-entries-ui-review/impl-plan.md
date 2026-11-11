# Implementation Plan — 2026-11-10 Harness-Injected Transcript Entries / Logs Tab Review

## TL;DR

- **This task ships no product code.** It produces an analysis document, `analysis.md`, in the task folder. The supporting material goes in `research/`: a reproducible survey with its scripts and an aggregate table. The two SVG wireframes are updated and new ones added only if needed. The task ends with a ranked follow-up list for `/adlc-lh:scratch`.
- **New research scripts:** they live in `research/survey/` and use Node only.
  - `scan.mjs` runs a read-only `psql` against the local-prod DB container through `docker exec`. It writes raw rows to `tmp/harness-survey/` and the aggregated, redacted table to `research/survey-table.md`.
  - `queries.sql` holds the SQL.
  - `consumers.json` is a static map from each type to its consumers.
  - Required env `LOGHUB_SURVEY_UNTIL` sets a cutoff, so a re-run reproduces the table.
  - Optional env `LOGHUB_SURVEY_DB_CONTAINER` names the DB container (default `artisyn-log-hub-db`).
  - `README.md` explains how to run it.
  - These are research tooling, not product code.
- **DB, API, hook, server and client:** none of them change. Every proposed change becomes a follow-up item.
- **KB documentation edits:**
  - `attachment-types.md` and `claude-log-message-types.md` get rows for the newly seen types (field names and sizes only).
  - The false claim in `harness-usage-tab.md` that there are no per-invocation hook records is corrected.
  - Product ideas, if there are any, go to `docs/product-kb/ideas/`.
- **High-risk decisions to check:**
  - The survey reads the real local-prod DB in a read-only transaction (Design Decision 2).
  - The definition of the hook-identity facet (Design Decision 4).
  - The hook-to-turn assignment rule the proposals rely on (Design Decision 7).

## Reference

- Requirements: [requirements.md](requirements.md)
- Evidence trail: [notes.md](notes.md), [research/setup-neutrality-audit.md](research/setup-neutrality-audit.md), research archive [research/findings-1.md](research/findings-1.md)

## Design Decisions

1. **Output layout.**
   - `analysis.md` in the task folder is the single deliverable document. Its sections, in this order:
     1. Sample & facets
     2. Decision table
     3. Item details
     4. Logs tab review
     5. Overlap map
     6. Follow-up list
     7. AC checklist
   - `requirements.md` gets only a one-line pointer in Notes.
2. **Survey source (FR-6).**
   - Read the local-prod Postgres through the house pattern from `docs/pocs/2026-10-30-1407-otel-traces-session-view/build.js:39-60`: `docker exec -i <container> sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" --csv'`.
   - The container comes from env `LOGHUB_SURVEY_DB_CONTAINER`, default `artisyn-log-hub-db`.
   - Every query runs inside `BEGIN READ ONLY; SET LOCAL statement_timeout = '60s'; … COMMIT;`.
   - Rows come from `jsonb_array_elements(logs.body) WITH ORDINALITY` with `log_type IN ('claude','claude-subagent')`, joined `logs.session_id → sessions.id`.
   - **Sample unit:** a root session, i.e. a `sessions` row with `parent_session_id IS NULL AND NOT deleted`.
     - Sub-agent sessions are separate `sessions` rows linked by `parent_session_id`, which holds the parent's `session_id` string, not always the root.
     - A recursive CTE attributes their lines to the root session.
   - **Minimum sample:** `MIN_SESSIONS = 30` root sessions. The scan exits with an error below it.
   - **Cutoff:** the scan takes a required env `LOGHUB_SURVEY_UNTIL` (an ISO timestamp). It keeps a root session only if its `claude` log row has `logs.created_at <= LOGHUB_SURVEY_UNTIL`. The value is printed in the table header. All output rows are sorted by type, then facet value, so a re-run with the same cutoff gives byte-identical output.
   - **Hook version:**
     - No per-session hook version is stored in `logs` or `sessions`; `repositories.hook_version` holds only the current per-repo value.
     - So the scan reports the "SessionEnd flush" dependency (hook ≥ 2.8.0) as an observable: the number of sessions whose last turn lacks its Stop-time entries.
     - It also lists per-repo `repositories.hook_version` values, compared numerically by `major.minor.patch`. A missing or unparseable value is `unknown`.
   - **Raw output columns per line:**
     - root session key (`sessions.id` of the root): raw only, never committed
     - log type
     - line index (ordinality)
     - `timestamp`
     - `type`
     - `subtype`
     - `attachment.type`
     - prompt-boundary flag: `type = 'user'`, not `isMeta`, and content is not only `tool_result`
     - size
     - the facet fields of Design Decision 4
   - **Size** is `length(elem::text)`, the characters of the whole JSON line. It is labelled "line chars" and is not the same as the characters that reached the model's context.
   - **`claude -p` session:** `entrypoint = 'sdk-cli'`.
   - **Repo root:** `scan.mjs` finds it by walking up from its own file location until it finds a `.git` entry. It never uses the current directory, so `tmp/harness-survey/` always lands in the repo's `tmp/`.
   - The sample is all stored sessions. Local prod has 297 sessions, one user and Windows only; this is recorded in the analysis rather than worked around.
   - The `/logs` API route is not used.
3. **Raw vs committed output.**
   - Raw per-session CSV/JSON goes to `tmp/harness-survey/`, which is gitignored via `tmp/`.
   - Committed files hold only aggregates, as defined in Design Decision 5. They contain no session IDs, no emails, no absolute paths and no text payloads.
   - Example values in the table are redacted to their shape, e.g. `X:\…\file.ts` → `<abs-win>/…/file.ts`.
4. **Facet definitions (one per session).** Each facet is read from the first line that carries it.

   | Facet | Rule |
   |---|---|
   | `entrypoint` | First non-empty `entrypoint`; missing → `unknown` |
   | CC version | First `version` matching `^\d+\.\d+\.\d+`, cut to `major.minor.patch` (any suffix dropped); otherwise `unknown` |
   | OS family | From `cwd`: `^[A-Za-z]:[\\/]` → `windows`; `^/mnt/[a-z]/` → `wsl`; `^/` → `posix`; else `unknown` |
   | IDE | `ideName` of any `*_in_ide` entry; `opened_file_in_ide` without `ideName` → `IDE, name not recorded`; none → `none` |
   | diagnostics sources | Set of raw `source` values; missing → `other`; none → `none seen` |
   | hooks | Set of hook identities |
   | session mode | `auto_mode` value, or `not recorded` |

   - **Hook identity:** take the first token of `hook_success.command` or of `stop_hook_summary.hookInfos[].command`, reduced to its basename without extension. If the command has no path-like token, the identity is `status-text`.
   - This is how we read FR-6's "configured hook names": hooks seen running, not hooks configured. `analysis.md` § Sample & facets records this reading.
5. **Table shape (FR-6).**
   - `research/survey-table.md` is generated entirely by `scan.mjs` and never edited by hand.
   - One row per entry type. The columns are the original ones (Entry | Count / sessions | Chars — here "line chars" | Payload | Read by Log Hub today) with the last column replaced by the corrected consumer column: client parser, anatomy, Raw Logs renderer, server extractor, DB table.
   - Below the main table come the facet matrices, the `diagnostics` per-`source` sub-rows, and a **Stop-time** section. That section counts:
     - root sessions whose last turn lacks `turn_duration` / `stop_hook_summary` / `hook_success`
     - `claude -p` sessions without `turn_duration`
     - repos per `repositories.hook_version`, split into < 2.8.0, ≥ 2.8.0 and `unknown`
   - The consumer column and the producer come from a hand-maintained static map, `research/survey/consumers.json`, which `scan.mjs` reads. Its shape is `{ "<type or system:subtype>": { "consumers": string[], "producer": string, "kbOnly"?: true } }`.
   - Types that are in the map but absent from the sample are emitted as `rare / setup-dependent`.
   - Types seen in the sample but missing from the map are emitted with consumer `none — new`.
   - A missing or empty map is allowed: every type is then emitted as `none — new`.
   - Generated files are never hand-fixed. A redaction problem is fixed in `scan.mjs`, then the scan is re-run with the same cutoff.
   - Per-facet counts (`count / sessions`) go in a second matrix per facet. `diagnostics` gets one sub-row per `source`.
   - A facet cell with fewer than 3 sessions prints `n < 3`.
   - The script also prints the facet matrix (sessions per facet value).
   - A type in the KB but absent from the sample keeps its row as `rare / setup-dependent`, with its producer named.
6. **Decision line format (FR-1).**
   - The decisions are:
     - **(a)** extra markup or info on an existing tab, naming the tab and the place
     - **(b)** a new tab, chart or report, at session or repo/team level
     - **(c)** not worth showing
   - One table row per type, with the columns: Type | Kind (attachment / system) | Decision (a/b/c) | Where (tab + place, or report scope) | Reason (one line) | Producer | Absent in setups.
   - Each (a) and (b) row links to an Item details card that carries the FR-2 / FR-7 / FR-8 fields:
     - shown content
     - fields read
     - client-only vs server, naming the extractor it extends
     - hook change and backward compatibility
     - `artisyn`-log equivalent and the preferred source, with the reason
     - degraded behaviour, including the not-yet-uploaded last turn and the hook ≥ 2.8.0 SessionEnd flush
     - privacy
     - producer and the setups where it is absent
7. **Hook-to-turn assignment (used by proposals).**
   - A harness entry belongs to the turn whose user prompt is the latest one at or before the entry's timestamp. This is the same rule as `compactBoundariesBetween` in `client/src/viewer/pages/repository/session-log/compact-boundary-placement.ts:9-26`.
   - Stop-time entries that come after the turn's last assistant line belong to that same turn.
   - An entry that is not uploaded yet makes the chip read "not recorded yet". The chip does not read zero.
8. **`queued_command` text.**
   - The Logs tab does not show queued text today. Its only consumer is `raw-logs/attachment-system.tsx:184`.
   - So the per-turn marker shows only the time and the offset into the turn. The text appears only in the Raw logs modal, as FR-2 requires.
   - The wireframe is corrected to match.
9. **Compaction divider.**
   - Proposals extend the existing `CompactBoundaryDivider` (`PromptTurnList.tsx:37-83`): keep the ⟳ glyph, and add the trigger, the files re-read count and the size of re-injected context.
   - The wireframe is corrected to match.
10. **"Usage" in FR-3** means Context Usage plus Statistics, because `tab-ids.ts` has no tab named "Usage". This reading is recorded in the analysis.
11. **Signals toolbar state:** the proposal uses a URL search param `signals=issues`, so a filtered view can be shared. The default (`Show`) leaves no param.
12. **Sub-agent Signals:** sub-agent transcripts are counted in the survey. Signals markup inside `SubAgentDetail` is listed as a separate low-priority follow-up, because the sample has no sub-agent diagnostics.
13. **FR-5 scales.**
    - **Value** is the share of producer-present sessions where the entry occurs: H ≥ 50 %, M 10–49 %, L < 10 %. A separate note estimates how common the producer is.
    - **Effort:**
      - S: client-only from `/logs`
      - M: server extractor + DB table + route
      - L: needs a hook change
    - Each follow-up names the test kind and the target the work extends:
      - scenario: `tests/scenarios/view/s-sess-03.spec.ts` for Logs markup, `s-sess-12.spec.ts` for Raw Logs
      - golden sessions: `tests/golden/gs-03-compaction`, `gs-09-windows-paths`
      - a new algorithm doc + rows file for a new per-turn signal derivation
      - a contract registry row for any new repo/team route
14. **Script location.**
    - The survey scripts live in the task's `research/survey/`, as FR-6 requires ("scan scripts kept in `research/`"). They are task research tooling, not a PoC, so the `docs/pocs/` rule does not apply.
    - The README gives the run command relative to that folder (`node ./scan.mjs`), so it survives archiving to `done/`.
15. **Acceptance criteria to self-check (from requirements):**
    - **AC-1:** every type has a decision line.
    - **AC-2:** every (a)/(b) item carries the FR-2/FR-7 fields.
    - **AC-3:** the Logs review has additions, outdated/redundant parts and improvements, with SVGs.
    - **AC-4:** every finding maps to a task or is marked "new".
    - **AC-5:** a prioritised follow-up list exists, and the user picks from it.
    - **AC-6:** the re-run table has ≥ 30 stored sessions plus its scripts, and FR-5 cites it.
    - **AC-7:** producers and absent setups are named; nothing is setup-specific; facet segmentation is done; every audit finding is listed.
16. **Audit coverage.**
    - Every finding of `research/setup-neutrality-audit.md` appears in the follow-up list, either as its own item or merged into one: sections A (1–3), B (4–13), C (14–16) and D.
    - Items outside harness entries are marked "outside this task's harness scope".
17. **Neutral labels.** No label, heuristic or priority names WebStorm, Windows, TypeScript codes or this repo's hooks.
    - Diagnostics groups use the raw `source`.
    - Signal heuristics use `severity` + file + later Edit/Write of the same repo-relative path.
    - Paths are reduced to repo-relative by the existing setup-neutral reducers (`toUserDisplayPath`, `toRepoRelative`, `normaliseClientPath`). They never use `prompt-turn-helpers.tsx:395` or `packages/bash-view/src/display-paths.ts:14` (audit C16).

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `docs/tasks/todo/2026-11-10-harness-entries-ui-review/analysis.md` | The deliverable | Sections per Design Decision 1 |
| `…/research/survey/scan.mjs` | Reproducible FR-6 scan | Node ESM; follow the `nodejs-script` skill; read-only DB (Design Decision 2) |
| `…/research/survey/queries.sql` | SQL used by `scan.mjs` | Read-only transaction, `statement_timeout` |
| `…/research/survey/consumers.json` | Static type → consumers/producer map | Shape per Design Decision 5 |
| `…/research/survey/README.md` | How to run, env vars, what is committed vs `tmp/` | Like `docs/pocs/2026-10-29-1504-sysctx-anatomy/README.md` |
| `…/research/survey-table.md` | Aggregated, redacted re-run table + facet matrix | Shape per Design Decision 5 |
| `…/wireframes/logs-tab-harness-markup.svg` | Corrected wireframe | Per Design Decisions 8, 9, 11 |
| `…/wireframes/logs-turn-signals-section.svg` | Corrected wireframe if group findings change | Neutral labels per Design Decision 17 |
| `…/wireframes/<new>.svg` | Only for a new non-trivial (b) item, e.g. a repo/team hook-health report | Optional |
| `…/requirements.md` | One-line pointer to `analysis.md` in Notes | No other changes |
| `docs/knowledgebase/log-schema/attachment-types.md` | Rows for newly seen attachment types | Field names, sizes and producer only |
| `docs/knowledgebase/log-schema/claude-log-message-types.md` | Enumerate `system` subtypes seen | `turn_duration`, `stop_hook_summary`, `scheduled_task_fire`, `informational`, `local_command`, compact, … |
| `docs/knowledgebase/harness-usage-tab.md` | Correct lines 86-88 | `hook_success` exists per invocation in the transcript |
| `docs/product-kb/ideas/<slug>.md` + `docs/product-kb/index.md` | Only if the analysis yields a new product idea | Index updated if a file is added |

## Test coverage plan

- This task adds no code to the product packages, so the test policy requires no algorithm, contract or scenario tests.
- The scan scripts are one-off research tooling under the task folder. Their check is that they are reproducible: re-running `scan.mjs` with the same `LOGHUB_SURVEY_UNTIL` produces the committed table byte for byte.
- Each follow-up item in `analysis.md` names its own test kind and target, per Design Decision 13. This is how the policy carries into the follow-up tasks.

## Visual/UX notes

- The Signals section reuses the Tools-row layout from `PromptTurnItem.tsx:146-330`: a kind badge, a mono metric, a mono detail and a "›" that opens the raw entry in the Raw logs modal. The section order in a turn is: after Tools, before Files.
- The "Signal sources" strip reuses the one-line band style of `StartupContextLine.tsx`.
- The timing chip sits in `PromptTurnHeader.tsx`. When the entries are missing it reads "turn timing: not recorded". In `claude -p` sessions it falls back to the time from the prompt to the last assistant line, marked "≈".
- Groups whose producer is absent are hidden, and the strip explains why.

## Wireframes

- **`logs-tab-harness-markup.svg`** gets these changes:
  - element 6: the `queued_command` marker shows only the time and the "+offset into the turn", with no quoted text (Design Decision 8)
  - element 7: the divider keeps ⟳ (Design Decision 9)
  - the toolbar shows the URL-state note (Design Decision 11)
  - the tab bar matches the current `tab-ids.ts` group labels
- **`logs-turn-signals-section.svg`** gets neutral group labels per Design Decision 17, and its groups are adjusted to the final (a) decisions.
- **A new SVG** is added only for a (b) item with non-trivial layout. The likely candidate is a repo/team hook-health and diagnostics report filterable by `source`, `entrypoint`, IDE and OS.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Survey tooling | 6 | Read-only DB scan; everything after depends on its numbers |
| 2 | Survey table & consumers | 5 | Uses chunk 1 output |
| 3 | Decision table & item cards | 6 | Uses chunk 2 numbers |
| 4 | Logs tab review & wireframes | 6 | Uses chunk 3 (a) decisions |
| 5 | Overlap map & follow-up list | 6 | Uses chunks 2–4 |
| 6 | KB corrections & wrap-up | 7 | Last; needs final type list |

### Chunk 1 — Survey tooling
- [ ] Create `research/survey/queries.sql`. Its read-only queries return the raw output columns of Design Decision 2 for `claude`/`claude-subagent` lines, plus `repositories.hook_version` per repo (Design Decision 2). Filter by the `LOGHUB_SURVEY_UNTIL` cutoff and wrap the queries as in Design Decision 2.
- [ ] Create `research/survey/scan.mjs` (Node ESM, per the `nodejs-script` skill). It resolves the repo root as in Design Decision 2 and requires `LOGHUB_SURVEY_UNTIL`. It runs `queries.sql` through `docker exec -i ${LOGHUB_SURVEY_DB_CONTAINER:-artisyn-log-hub-db} … psql --csv` and writes raw rows to `tmp/harness-survey/`.
- [ ] In `scan.mjs`, compute the per-session facets exactly as in Design Decision 4, including the hook-identity reduction, the OS family regexes and the `claude -p` rule.
- [ ] In `scan.mjs`, aggregate per entry type: count and sessions in total and per facet value, `diagnostics` per `source`, `n < 3` masking, and the facet matrix. Also compute these Stop-time stats:
  - last turn missing `turn_duration` / `stop_hook_summary` / `hook_success`, using the Design Decision 7 rule
  - `claude -p` sessions without `turn_duration`
  - repos per `repositories.hook_version` bucket (< 2.8.0, ≥ 2.8.0, `unknown`)
- [ ] In `scan.mjs`, read `research/survey/consumers.json` and generate the whole of `research/survey-table.md` per Design Decisions 3 and 5, with rows sorted deterministically and the cutoff in the header.
- [ ] Create `research/survey/README.md` covering: purpose, prerequisites (local-prod container running), the env vars, the folder-relative run command per Design Decision 14, the read-only guarantee, and what is committed vs `tmp/`.

### Chunk 2 — Survey table & consumers
- [ ] Create `research/survey/consumers.json` per Design Decision 5. It gets one entry per attachment type in `attachment-types.md` and per `system` subtype in `claude-log-message-types.md`. Its consumers cover the client parser, anatomy, Raw Logs renderer, server extractor (`claude-extractor.ts`, `turn-walk.ts`) and DB table. Confirm the server consumers with the `ce` skill.
- [ ] Run the scan with a fixed `LOGHUB_SURVEY_UNTIL`. For every type emitted as `none — new`, add a `consumers.json` entry with its consumers and producer, then re-run.
- [ ] Re-run with the same cutoff. Confirm that the sample has at least 30 sessions, that the output is byte-identical, and that `survey-table.md` contains no email, absolute path, session ID or text payload.
- [ ] Write `analysis.md` § Sample & facets. It covers:
  - the cutoff, the sample size and the facet matrix
  - the sample's limits: one user, OS and IDE counts, `n < 3` cells
  - the reading of the hook-identity facet (Design Decision 4) and of "Usage" (Design Decision 10)
  - how the re-run differs from the 2026-11-10 survey (`requirements.md` § "Survey already done")
- [ ] Add a Stop-time note to `analysis.md` § Sample & facets, citing the chunk 1 stats on the missing last-turn entries, `claude -p` sessions without `turn_duration`, and the repo hook-version buckets.

### Chunk 3 — Decision table & item cards
- [ ] Write `analysis.md` § Decision table. It has one row per entry type: every attachment type in `attachment-types.md`, every `system` subtype, and every new type from chunk 2. Use the columns of Design Decision 6, with a one-line reason each.
- [ ] Write `analysis.md` § Item details. Give one card per (a)/(b) decision, with the fields of Design Decision 6 and the shown content linked to its wireframe element number where it has one.
- [ ] In each card, name the `artisyn`-log equivalent from `hook/HOW_HOOK_WORKS.md` and the preferred source, with the reason. The equivalents include `prompt_start`/`prompt_stop`, `PreCompact`/`PostCompact`, `hook-status` and SessionEnd flush.
- [ ] In each card, state the degraded behaviour: the entry is absent, the entry has an unknown shape, the last turn is not yet uploaded, the session ran on hook < 2.8.0, or it is a `claude -p` session. Use the hook-to-turn rule of Design Decision 7.
- [ ] In each card, check privacy and neutrality against Design Decisions 8 and 17 and the FR-2 rules: no email or absolute paths; text only if the Logs tab already shows it; repo/team items carry only counts, durations, codes and repo-relative paths.
- [ ] For `auto_mode`, write a (b) card for session-mode segmentation, which the user approved. For hook health and diagnostics, write repo/team (b) cards with filters for `source`, `entrypoint`, IDE and OS. Each card names the ingest extractor and the derived table it needs, per `server-conventions.md:15`.

### Chunk 4 — Logs tab review & wireframes
- [ ] Walk the Logs tab on at least 3 real local-prod sessions (`use-playwright` skill, http://localhost:5003). Use "Edit email" to identify as the repo owner. The sessions must include a compaction, a hook error and a queued command. Record observations only; any screenshots go to `tmp/` and are not committed. Cover: `PromptTurnItem` sections, the metrics row, `StartupContextLine`, sub-agents and workflows.
- [ ] Write `analysis.md` § Logs tab review (i): the per-turn additions, mapped to their chunk 3 decision lines, the placement in the section order and the Signals / Signal sources naming.
- [ ] Write § Logs tab review (ii): the parts that are outdated, redundant or hard to read. Compare each against Session Map, Timeline, Context Growth, Info, Summary, Harness usage, System context and "Usage" (per Design Decision 10). Give a keep/merge/drop recommendation for each.
- [ ] Write § Logs tab review (iii): concrete UX improvements, each with an S/M/L effort and a wireframe reference for the non-trivial ones. Include the toolbar state per Design Decision 11 and sub-agent Signals per Design Decision 12.
- [ ] Update `wireframes/logs-tab-harness-markup.svg` per the Wireframes section, covering the `queued_command` marker, the ⟳ divider, the URL-state note and the current tab-group labels. Update `wireframes/logs-turn-signals-section.svg` to the final (a) groups and neutral labels.
- [ ] Add a new SVG under `wireframes/` for each non-trivial (b) report layout from chunk 3, such as a repo/team hook-health and diagnostics report. Reference each SVG from `analysis.md`.

### Chunk 5 — Overlap map & follow-up list
- [ ] Read the requirements of `2026-11-09-session-waiting-breakdown`, `2026-11-02-session-antipatterns`, `2026-11-10-sysctx-prompt-viewer` and `2026-11-11-sysctx-recommendations`. Write `analysis.md` § Overlap map, which maps every (a)/(b) item and Logs review finding to one of those tasks or to "new".
- [ ] Write `analysis.md` § Follow-up list. Each entry gives: title, a 2–3 line description, value H/M/L with the survey-table number and the question it answers, producer prevalence, effort S/M/L, the linked decision lines, the task it extends, and the test kind/target, per Design Decision 13.
- [ ] Add a follow-up item for every finding in `research/setup-neutrality-audit.md` (A, B, C, D), either on its own or merged into one, per Design Decision 16. Mark the non-harness ones "outside this task's harness scope".
- [ ] Add a follow-up item for a client-only Hooks kind in the Harness usage tab, read from per-invocation `hook_success` / `hook_non_blocking_error` records. Add another for Signals in `SubAgentDetail` (Design Decision 12).
- [ ] Sort the follow-up list by value, then effort, then dependency. Mark which items block others, for example the shared per-turn signal derivation before its consumers.
- [ ] Record any new product idea, such as a competitor-parity hook-health report, in `docs/product-kb/ideas/<slug>.md` and add it to `docs/product-kb/index.md`. Check the idea against `docs/product-kb/competitive-research/budgets-forecasts-waiting.md`.

### Chunk 6 — KB corrections & wrap-up
- [ ] Add rows to `docs/knowledgebase/log-schema/attachment-types.md` for every newly seen attachment type: field names, size range, producer and the setups that lack it. Include no payload text.
- [ ] Add a `system` subtypes list to `docs/knowledgebase/log-schema/claude-log-message-types.md` that enumerates each subtype seen, with its key fields and when it is written. Cover `turn_duration`, `stop_hook_summary`, `scheduled_task_fire`, `informational`, `local_command` and compact.
- [ ] Correct `docs/knowledgebase/harness-usage-tab.md:86-88`: per-invocation `hook_success` / `hook_non_blocking_error` records (command, event, exit code, `durationMs`, stderr) are in the transcript and the `/logs` payload.
- [ ] Add the one-line Notes pointer to `analysis.md` in `requirements.md`.
- [ ] Fill in `analysis.md` § AC checklist. For each of AC-1…AC-7 in Design Decision 15, give the section or file that satisfies it.
- [ ] Run a final privacy sweep over every new or changed file: the task folder, the three edited KB files and any `docs/product-kb/ideas/` file. This includes `consumers.json` and the SVGs. Grep for these patterns. Remove any hit that is not a redacted shape; for generated files, fix `scan.mjs` and re-run instead (Design Decision 5):
  - email: `[\w.+-]+@[\w-]+\.[\w.]+`
  - Windows path: `[A-Za-z]:\\`
  - home paths: `/Users/`, `/home/`
  - UUID: `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`
- [ ] Present the ranked follow-up list to the user and record their picks in `analysis.md` § Follow-up list (AC-5).
