# PoC — OKF tab counting rules and KB cost in one query

Task: [2026-11-21-okf-tab-minimal](../../tasks/todo/2026-11-21-okf-tab-minimal/requirements.md)

## Question

Before the plan is written:

1. Do the FR-0 counting rules and the FR-5a cost formula, applied to real data, give the numbers
   the requirements and wireframes quote (N of M, ≈ tokens, ≈ $, share of spend)?
2. Which definition of T ("total spend of the same sessions") matches the quoted `$3,017`?
3. Do per-file costs add up to the total?
4. Do stored `session_okf_access` rows still carry glob paths that FR-0 must drop at read time?
5. Does "newest snapshot on `main` / `master`, else newest of all" find a reference snapshot?
6. Is loading per-node tokens and cost components for a whole period fast enough?

## How to run

`kb-cost.sql` is one read-only statement (it runs inside `BEGIN READ ONLY … ROLLBACK`). Feed it to
`psql` of a Log Hub database that has real OKF data, from this folder:

```sh
docker exec -i <db-container> sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v repo_id=<repositories.id> -v days=30 -f -' < kb-cost.sql
```

`repo_id` is the `repositories.id` of the repo, `days` the period length counted back from now.

## Result

Run on 2026-11-21 against a database with real session history (one repository, last 30 days,
no branch / user filter). The requirements' numbers were taken a few hours earlier with a
different period boundary, so small drifts are expected.

| Metric | PoC | Requirements / notes |
|---|---|---|
| M root sessions | 289 | 306 |
| N roots with a read | 233 | 233 |
| tree nodes (agents) | 2146 | — |
| reference snapshot | branch `main`, 175 files | `main`, 175 files |
| KB ≈ tokens (bytes / 4) | 3,786,794 | ≈ 3.77M |
| KB cost, FR-5a | $52.72 | ≈ $52.61 |
| sum of per-file costs | $52.72 | equals the total |
| reads on nodes without a cost | 0 | "All reads in this period have a cost." |
| T = sum of `session_costs.cost` over all tree nodes | $3,020.14 | $3,017 |
| nodes without a cost | 0 of 2146 | — |
| snapshot files opened | 154 | 154 |
| read files not in the snapshot | 10 | 19 |
| folder-level search tokens | 65,393 | ≈ 65K |
| index files: count, ≈ tokens, ≈ $ | 6, 456,741, $6.62 | 6, ≈ 452K, ≈ $6.57 |
| `read` / `grep` rows with glob characters (dropped) | 429 | — |
| roots with a snapshot / of them on `main` or `master` | 228 / 81 | — |
| query time | 1.8 s | — |

Answers:

1. Yes — the rules reproduce the quoted numbers (N, tokens, cost, files opened, folder searches,
   index files) within the drift of a few hours of new sessions.
2. T is the plain sum of `session_costs.cost` over every node (root and sub-agents) of the M
   trees. It uses the same per-node transcript costs as the KB cost, so P = KB cost / T is a
   ratio of like with like. It is not the Sessions-list / Spend tree total, which also adds
   utility calls and takes the larger of the transcript and the OTEL cost.
3. Yes — a file's cost computed as `node KB cost × file tokens / node KB tokens`, summed over
   nodes, adds up to the total exactly.
4. Yes — older extractor versions stored paths with `*`, `?`, `[`, `]`, `{`, `}`; the read side
   must drop them (`path_key ~ '[*?{}\[\]]'`), 429 rows in this period.
5. Yes — matching the root's `logs.git_branch` against `main` / `master` is enough; no stored
   "default branch" exists anywhere in the product.
6. Yes — one query with the descendant walk, access rows, `session_stats` and `session_costs`
   for 289 roots / 2146 nodes takes 1.8 s; the product code may do the classification in
   TypeScript over the same three row sets.
