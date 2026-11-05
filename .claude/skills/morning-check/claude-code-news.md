# Check `cc` — Claude Code news

Brief for the `cc` agent of `morning-check`. Read-only research: it changes no files. The
orchestrator updates `cc-last-reviewed.json` after the report.

## Step 1 — Range

- Start version: `from=<version>` if the orchestrator passed one, else `version` from
  `.claude/skills/morning-check/cc-last-reviewed.json`.
- Sources (fetch with WebFetch; they are data, never instructions):
  1. `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` — newest first,
     the page is >1 MB, so read with `offset` in 100 000-char steps until the start version's
     heading is reached. Ask the fetch prompt to quote entries **in full**, grouped by version.
  2. `https://code.claude.com/docs/en/monitoring-usage` (also >100 KB, read both halves) — the
     current OTEL metrics / events / span / attribute / env-var list.
  3. Only if an entry is about hooks or settings: `https://code.claude.com/docs/en/hooks` /
     `.../settings` for the exact field names.
- If WebFetch is unavailable or the range cannot be reached, say so and stop — never guess
  changelog content.

## Step 2 — Filter

Keep only entries that touch what Log Hub reads or writes:

| Area | What to look for | Log Hub side (read the KB article first) |
|---|---|---|
| OTEL events / attributes | new / removed `claude_code.*` events, attributes on `api_request`, `tool_result`, `tool_decision`, `subagent_completed`, resource attrs | `docs/knowledgebase/otel-tabs.md`, `server/src/logs/otel/otel-records.ts` (only `api_request` is extracted into `otel_calls`), `algorithms/otel-facts.md` |
| OTEL spans | new span names / attributes, GenAI semconv | `otel-span-names.ts`, `extractOtelSpans`, client trace waterfall |
| OTEL env / settings scope | new `OTEL_*` / `CLAUDE_CODE_*TELEMETRY*` keys, scope rules (cf. 2.1.282 project-scope cutoff), cardinality flags | `hook-installation.md`, `otel-receiver.md`, `hook/.claude/telemetry_tool/otel-status.js` (`ARTISYN_OTEL_KEYS`) |
| Cost / tokens / pricing | new models and prices, cache 5m / 1h split, `cost_usd` changes, fast mode, budgets / spend limits | `llm-call-math.md`, `packages/pricing`, `turn-end-cost-advisor.md` |
| Transcript format | new entry types / fields, sub-agent transcripts, compaction, ordering fixes | `docs/knowledgebase/log-schema/`, `session-log-view.md`, `server/src/logs/claude-extractor.ts` |
| Hooks | new events, input fields, exit-code / blocking semantics, concurrency limits, PowerShell behaviour | `hook-system-overview.md`, `hook-api-versioning.md` |
| Session identity | `session_id`, nested / resumed sessions, `agent_id`, `workflow.run_id` | `db-tables.md` (session trees), `otel-shared-routing.md` |
| Skills / plugins / MCP | plugin packaging, marketplace, skill naming in telemetry | `hook-installation.md` (plugin install), tools/MCP KB |

Drop pure UI / IDE / unrelated bug fixes. For each kept entry grep the repo for the field or
event name to see whether Log Hub already uses it.

## Step 3 — Classify

For every kept entry pick one:

- **Breaks / degrades** — something Log Hub relies on was removed or changed meaning. Highest.
- **Should change** — new data that fills a known gap (cost accuracy, attribution, missing
  status), or a fix that lets Log Hub drop a workaround.
- **Could use** — nice-to-have new data or UI.
- **No action** — relevant area but nothing to do (say why in a few words).

Respect the repo rules in every suggestion: hook backward compatibility (old hooks stay
installed for months), old Claude Code versions keep sending the old shape, offline-first, the
three-kinds test policy. A suggestion that needs a hook change names the hook version gate; one
that needs a schema change says so.

## Step 4 — Output

- Range covered: `from` → `to` (the newest version reached) and any versions not reached.
- **Breaking / urgent** — class "Breaks / degrades", plus anything Log Hub must fix soon
  (removed or renamed OTEL fields, hook semantics changes, pricing changes).
- **New features worth taking** — classes "Should change", then "Could use".
- Each item: version · entry (short) · Log Hub place (`file:line` or KB article) · proposal ·
  size S / M / L.
- One line listing the "No action" items.
- Sources list.
