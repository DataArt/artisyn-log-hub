# Corpus of real sessions: frozen per Claude Code version, plus a monthly live generation

Design (not an implementation). The owner's requirement: keep **real recorded sessions** from different Claude Code versions in the repository and check against them, so that old log versions do not break; once a month generate a **new full set** on the latest Claude Code version (several repositories, several scenarios, an isolated environment; the owner has a skill for this on another machine, it is not committed), and check the server against that set too.

What is confirmed in the repository: every line of a Claude Code transcript has a `version` field (the schema in `docs/knowledgebase/log-schema/` names version 2.1.175); the repository used to hold only two samples (a folder of internal sample sessions, 100–280 KB, not in line-by-line JSONL format, since deleted; for the current test setup see [KB test](../../knowledgebase/test/index.md)); the server already tracks Claude Code versions (`ai-tool-versions`, the outdated-versions report). What I did not see: the generation skill itself (it is on another machine), so its contract below is assumed.

## Why this is needed (two different jobs)

1. **Backward compatibility.** Every Claude Code version we have ever supported must still be parsed correctly. The log format changes silently, and users do not update (the same is true for the hook, see `S-COMPAT`). A frozen set of real sessions is the only honest way to check this.
2. **Drift detection.** Once a month a fresh set shows what is new in the logs (new line types, fields, attachments) and whether parsing broke anywhere. A side benefit: the "what is new in the format" report feeds `log-schema` in the knowledge base.

It complements, rather than replaces, the hand-written "golden" sessions from [03](03-session-view-reports-golden.md): the hand-written ones give exact numbers computed by hand (an oracle for the formulas), the real ones give realism and compatibility. Scenario tests use the hand-written ones; the corpus runs as a separate block.

## Layout in the repository

```
tests/corpus/
  README.md                      how it works, how to add a set, how to approve a baseline change
  generator/                     generation skill and scenarios (commit here or to a separate repository)
  repos/                         synthetic repositories (small, public, no secrets)
  scenarios/                     session scenarios: the prompt list and the expected "intended" structure
  sets/
    2026-10_cc-2.1.175/          a set "release": one month = one full set
      manifest.json              Claude Code and hook versions, models, OS, date, generator commit, file sha256
      <repo>__<scenario>/
        session.jsonl(.gz)       root transcript
        subagents/*.jsonl        subagent transcripts
        hook/                    telemetry of this session's real hook (artisyn logs)
        prompts.md               what exactly was asked
        expected.json            baseline: snapshot of API responses after upload
        notes.md                 what is special about the session
```

## How "expected" is defined (the LLM's answer is non-deterministic)

The same session cannot be generated a second time, so the reference is built on three levels:

| Level | What | What for |
|---|---|---|
| **Snapshot** (`expected.json`) | Frozen API responses (cost, tokens, time, call count, agent tree, change-surface and so on) for this particular recording | Regression: any diff on the same input is either a bug or a deliberate change; the reference is updated by an "approve" command and a human reviews it in the diff |
| **Independent oracle** | A small separate script that computes invariants from the raw log without the application code: the sum of usage over turns equals the session totals, the tree cost equals the sum of the root and its descendants, the cost is recomputed from the price table, tokens are never negative, every sub-agent has a parent | Catches an error that the snapshot froze in the same way; it also works on a fresh set that has no snapshot yet |
| **Scenario's structural expectation** | What must be there by the scenario's design: "fan-out" gives at least two sub-agents, "compaction" gives at least one boundary, "rejected tool" gives a rejection in the stats | Checks that the scenario did its job at all, and on a fresh set it stands in for exact numbers |

The rule for a **fresh set** (no snapshot yet): only the oracle, the structural expectations, the absence of parse errors and the drift detector apply. After a human review the set is frozen and a snapshot is created for it.

## Tests in the suite

This is a block of about five table tests (parametrized over the corpus) plus one live pipeline that is run by hand.

| ID | What it does | Layer |
|---|---|---|
| S-CORPUS-01 | **Replay:** every frozen session of every version is loaded into a clean application (v1, v2 and, for some, through the real hook upload path), the numbers are compared with the snapshot; for sessions with sub-agents the UI is checked too | API + UI |
| S-CORPUS-02 | **Invariants:** the independent oracle over the whole corpus, without snapshots | API |
| S-CORPUS-03 | **Drift detector:** collects, from the raw corpus lines, the line types, keys and attachment types that are not in the schema or in the parser's lists (`log-schema`, known types); a failure shows the "new" list | unit over data |
| S-CORPUS-04 | **Cross-version consistency:** one scenario on different Claude Code versions gives the same semantic structure (number of sub-agents, tool types) within a tolerance | API |
| S-CORPUS-05 | **Old hook versions:** hook telemetry of different versions recorded in the corpus goes through the upload path against the current server (related to `S-COMPAT-01/02`) | hook + API |
| S-LIVE-01 | **Monthly live run** (by hand): generate a fresh set on the latest Claude Code version, load it, run the oracle, the structural expectations and the drift detector, issue a "what is new" report and, after a human review, freeze the set | pipeline |

## Monthly generation protocol

An isolated environment (a separate machine or a container): a clean `HOME`/Claude config directory, the Claude Code version and the hook version pinned in the manifest, the real hook installed and sending to a local receiver.

1. Bring up the synthetic repositories from the descriptions in `repos/`: a small one, a medium monorepo, a repository with Windows paths (needs a Windows machine), different languages; no secrets and no personal data.
2. Run the scenarios: a simple question and answer, file edits, sub-agent fan-out, skills/rules/MCP, a workflow, context compaction (a long session), tool refusal and rejection, several models, session resume, the 5m/1h cache. Volume: repositories × scenarios, for example 4 × 8 = 32 sessions (an example figure, not an estimate).
3. Collect the transcripts, the sub-agents and the hook telemetry, **scrub** them (see below), write the manifest.
4. Run S-LIVE-01. The report: parse errors, broken invariants, what is new in the format (drift), mismatches with the schema in the KB.
5. A human reviews the report and approves it; the set is pinned in `sets/` and `log-schema` is updated.

## Generation skill

It is on another machine and not committed. Recommendation: commit it to `tests/corpus/generator/` (or a separate repository), otherwise the set cannot be reproduced and an AI maintainer does not know the contract. I need at least its interface: what it takes (repositories, scenarios, Claude version), what it produces (file layout), how it pins the hook version and how it isolates the environment.

## Size, storage, privacy

- **Size.** Real sessions with sub-agents can be large (the samples that were in the repository were 100–280 KB; I did not measure real volumes). A monthly full set grows without limit. The policy is the owner's decision: store as `.gz`; keep one set per **format epoch** (when the drift detector found a change) plus the last two months, delete the rest while keeping the manifest and the hashes; or use Git LFS, or a separate corpus repository, or release artifacts.
- **Privacy.** The set is published together with the open source, so generate **only on synthetic repositories**, and before a commit run the scrub and a secret scanner: home directories and user names in paths, e-mail, hosts, keys, tokens. The scrub must keep the structure (path replacement must be consistent, otherwise change-surface breaks). By design the product records everything (see [KB](../../knowledgebase/product-purpose-and-data-capture.md)), so a clean generation environment is mandatory. It is worth confirming separately that publishing transcripts is allowed by the terms of use.
- The two internal samples that used to be in the repository have been deleted. The client fixtures (`client/src/test/fixtures/*`, `mockData.ts`) should either move into the corpus after the scrub or be deleted.

## What the owner decides

1. Where the generation skill lives (this repository, a separate repository) and whether its interface can be shown.
2. Storage policy: `.gz`, one format epoch plus two months, LFS or a separate repository.
3. How many repositories and scenarios go into the monthly set (token cost, human review time).
4. Whether publishing transcripts is acceptable under the terms of use and the company policy.
5. Confirm that the snapshot plus the independent oracle plus the structural expectations are enough in place of hand-computed numbers for real sessions.
6. Whether the set needs a Windows repository (generation then needs a Windows machine).
