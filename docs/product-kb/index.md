---
okf_version: "0.1"
---

# Product Knowledgebase Index

The **product / PDLC** knowledgebase: why Log Hub exists, who it competes with, product ideas and
UX research. How the code works lives in the separate development KB,
[`docs/knowledgebase/index.md`](../knowledgebase/index.md).

Before reading any file here, check this index. Do not glob the directory.
After adding, removing, or renaming a file here, update this index.

Each line says **when to read** the article, nothing more — the article holds the details. Keep new
lines to one or two sentences. Everything here is in English, like everything under `docs/`.

## Product

* [Product Purpose and Full Data Capture](product-purpose-and-data-capture.md) - Read before proposing redaction or "privacy fixes" to capture: the product captures session data in full by design
* [Competitors](competitors.md) - Read before positioning, pitching or prioritising features: 14 tools by category and the gaps they expose

## Product ideas

Backlog ideas that are not tasks yet. One article per idea; when an idea becomes a task, link the
task folder from the article.

* [Code → session reverse lookup](ideas/code-to-session-lookup.md) - Read before planning provenance / blame-style features (file, line or commit → the session that wrote it): what `session_changed_paths` already gives, what is missing, slicing

## Competitive research

* [Competitive Research (parity study)](competitive-research/README.md) - Read for the row-by-row comparison of 14 tools with Log Hub (snapshot 2026-11-01): one file per tool, the verdict matrix, gaps
* [Gap-Closing Plan](competitive-research/gap-closing-plan.md) - Read before picking a competitor-inspired feature: ranked proposals with effort, corrected verdicts, rejected ideas and the first increments

## Competitive watch

* [Competitive Watch](competitive-watch/index.md) - Read before reporting a competitor item as new or adding a watched source: the running log kept fresh by the `morning-check` skill (`sources.md`, `seen.md`)

## UX research

* [UX Analysis: making the UI digestible](ux-analysis/README.md) - Read before reorganising navigation, tabs or the home page: personas, IA, waves 1–2 ideas and wireframes W1–W6 (2026-11-01)
