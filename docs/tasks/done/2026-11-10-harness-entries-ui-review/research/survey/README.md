# Harness entries survey (FR-6)

Task: [2026-11-10-harness-entries-ui-review](../../requirements.md) · plan: [impl-plan.md](../../impl-plan.md)
(Design Decisions 2–5)

## Purpose

The survey counts the entries Claude Code writes into its transcripts: attachments, `system`
subtypes and the other line types. It reads the transcripts Log Hub has stored. For each entry
type it reports how often the type occurs, its size and its payload field names, and who in Log
Hub reads it today. The counts are segmented by per-session facets: `entrypoint`, Claude Code
version, OS family, IDE, diagnostics `source`, hooks seen running and session mode. It also counts
how often the last turn of a session lacks its Stop-time entries, and which hook versions the
repositories report. `harness-entries-analysis.md` cites the generated table for FR-5 and FR-6.

## Files

| File | What it is |
|---|---|
| `scan.mjs` | The scan: runs the queries, computes facets and aggregates, writes the table |
| `queries.sql` | The read-only SQL, three sections: `roots`, `lines`, `repos` |
| `consumers.json` | Hand-maintained map `{ "<type or system:subtype>": { "consumers": [], "producer": "", "kbOnly"?: true } }`. It may be missing or empty: every type is then listed as `none — new` |
| `../survey-table.md` | The generated table. Never edit it by hand |

## Prerequisites

- Node.js (built-ins only, no `npm install`).
- Docker, with the local-prod Log Hub Postgres container running (default name
  `artisyn-log-hub-db`). The queries run inside the container as its own `POSTGRES_USER` /
  `POSTGRES_DB`, so no credentials are needed.
- At least 30 root sessions stored up to the cutoff, or the scan stops with an error.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `LOGHUB_SURVEY_UNTIL` | yes | Cutoff, an ISO timestamp such as `2026-11-11T00:00:00Z`. A root session is kept only if its `claude` log row was created at or before it, and lines with a later `timestamp` are left out. The value is printed in the table header. |
| `LOGHUB_SURVEY_DB_CONTAINER` | no | The Postgres container to query. Default `artisyn-log-hub-db`. |

## How to run

From this folder:

```sh
LOGHUB_SURVEY_UNTIL=2026-11-11T00:00:00Z node ./scan.mjs
```

In PowerShell:

```powershell
$env:LOGHUB_SURVEY_UNTIL = '2026-11-11T00:00:00Z'; node ./scan.mjs
```

A run over about 300 sessions takes several minutes. Progress and the facet matrix go to stderr.
To reproduce the committed table, use the cutoff printed in its header. A re-run with the same
cutoff gives a byte-identical `survey-table.md`, unless stored sessions were deleted or the
consumer map changed. To change the table, fix `scan.mjs` or `consumers.json` and re-run.

## Read-only guarantee

- Every query section runs inside `BEGIN READ ONLY; SET LOCAL statement_timeout = '60s'; … COMMIT;`,
  so Postgres rejects any write and stops any statement that runs longer than 60 s.
- `psql` runs with `ON_ERROR_STOP=1`, so the scan stops at the first error.
- Transcript lines are read in batches of 20 root sessions to keep each statement short.
- The scan never calls the Log Hub API and never changes any file outside the two outputs below.

## What is committed and what stays in `tmp/`

| Output | Where | Committed |
|---|---|---|
| Raw rows: `roots.csv`, `lines.csv`, `repos.csv`, and `sessions.json` (facets and last-turn flags per session) | `<repo>/tmp/harness-survey/`, found by walking up from this folder to the repo root, whatever the current directory | No. `tmp/` is gitignored. These files hold session keys, working directories and hook commands |
| Aggregated table | `../survey-table.md` | Yes |

The committed table holds aggregates only: counts, session counts, size statistics and field
names. It holds no session ids, emails, absolute paths or text payloads. Facet values that look
like an email or a path are reduced to `<email>`, `<abs-win>` or `<abs-posix>`. Facet cells with
fewer than 3 sessions print `n < 3`.
