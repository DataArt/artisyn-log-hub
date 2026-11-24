# Notes: Shell Tab — PowerShell Calls Next to Bash

Evidence trails and history moved out of `requirements.md`. The contract lives there.

## 2026-11-22 — moved from requirements.md

### Owner decisions on the first open questions

The owner answered the first open questions, and the requirements were rewritten accordingly:

- the tab is named **Shell**, with the hint "Bash / PowerShell";
- PowerShell commands get the same formatted view as Bash, if a usable parser package exists (it
  does — see the package search below);
- the list gets a filter by shell;
- no half-way version: the "changes N" chip and the first-statement preview must work for PowerShell
  rows too.

### Parser package search (checked 2026-11-22)

The Bash view is driven only by a tree-sitter syntax tree (`@loghub/bash-view` + `web-tree-sitter`
0.27.1 + `tree-sitter-bash` 0.25.1, WASM lazy-loaded). The same route works for PowerShell:

| Package | Version / updated | Licence | Prebuilt WASM | Notes |
|---|---|---|---|---|
| `tree-sitter-powershell` (airbus-cert) | 0.26.6 / 2026-10-28 | MIT | yes, 1.1 MB | **recommended**; the upstream grammar (also used by editors), ships `queries/highlights.scm`; has an `install` script (`node-gyp-build`) for a native binding we do not use — only the `.wasm` and the `.scm` are needed, same as with `tree-sitter-bash` |
| `tree-sitter-pwsh` (wharflab fork) | 0.38.1 / 2026-05-16 | MIT | yes, 2.1 MB | WASM-only package (no native build), but a fork, twice the size, not updated for six months |

### Quick check of both grammars

Throw-away script, not kept: both WASM files load with the repo's pinned `web-tree-sitter` 0.27.1
(grammar ABI 15), parse 8 typical Claude Code PowerShell commands without an error node (pipelines,
`;` chains, `if ($?)`, `foreach`, `try/catch`, here-strings `@'…'@`, call operator `&`, redirects),
and their `highlights.scm` compiles as a query. The tree exposes `pipeline` / `command` /
`command_name` / `command_parameter` / `generic_token` nodes — enough for the same statement-level
formatting and file analysis the Bash view does.
