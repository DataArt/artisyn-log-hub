# Understanding Cost & Context

The two numbers to watch in every session are **cost** and **context usage** — and they are
closely related: the bigger the context, the more tokens every single call consumes.

## How cost is calculated

Cost is computed from the session's token usage multiplied by the model's configured prices.
Four token kinds matter:

- **Input** — everything sent to the model.
- **Output** — everything the model wrote.
- **Cache read** — input replayed from the prompt cache. Much cheaper than fresh input; you
  *want* a big share of this.
- **Cache write** — input stored into the cache. More expensive than plain input; it pays off
  only when later turns read it back.

The app also records Claude Code's OTEL cost. If the computed and OTEL figures disagree by 33% or more, an amber ⚠ appears next to the session's cost — treat that
session's number as approximate.

## Where you see cost

- **Session list** — per-session cost, color-coded relative to the other visible sessions
  (green = cheapest, red = outlier).
- **Session header** — total **Cost** with a breakdown tooltip; a **+sub-agents** marker means
  agent costs are included.
- **Per turn (Logs tab)** — a violet **Cost** chip. When agents ran, it becomes a sum:
  `main + sub-agents + ~workflow = total`.
- **Info tab** — the full token/cost table, including a **"Calculated approx. total"** row.

## Sub-agents and workflows

Sub-agent token usage is tracked separately and rolled up into the session and turn totals —
including nested agents at any depth. Workflow agents report only a total token count without
the input/output/cache split needed for exact pricing, so their cost is an **estimate** (marked
with `~`, based on the session's average token rate). When a total can't include workflow costs
exactly, it's marked **"(partial)"**.

In the session header's cost tooltip, sub-agents have a row of their own. It reads **Sub-agents
(from OTEL)** when some sub-agent's cost was taken from its OTEL calls because its transcript
missed some of them (older Claude Code versions; see
[Sub-agent cost from OTEL](otel-tab.md#sub-agent-cost-from-otel)).

## Hidden (utility) calls

Claude Code also makes model calls that never appear in a transcript: title generation,
summaries, the next-prompt suggestion and similar. Log Hub learns about them from OTEL and prices
them like any other call, so the session cost includes them; that is also why the tooltip's
"Calculated approx. total" can differ slightly from the session cost. The OTEL tab lists them as
[hidden calls](otel-tab.md#hidden-calls). Sessions without OTEL data have no utility-call cost.

## Budgets and the OTEL cost

Everywhere else Log Hub shows its own computed cost. [Budgets](budgets.md) make one exception:
for each session tree (a session with all its sub-agents) a budget counts the **higher** of the
computed cost and Claude Code's OTEL total for the session. The reason is that a budget must
never under-count — a cost that is too low would cross a threshold late or not at all:

- The computed cost can be too low when a transcript misses calls (older Claude Code versions,
  a session still uploading) or when the model has no price configured.
- A session that has so far arrived only through OTEL has no computed cost at all.

When only one figure exists the budget uses it; with neither the tree counts $0 and the Spend tab
reports it as unpriced. The comparison is made once per tree, not per call, and uses the
near-realtime OTEL totals, so a budget can react before the transcript is uploaded. That is why a
budget's spend can be slightly higher than the cost of the same sessions on the session list,
Analytics or the other reports.

## The "⚠ no pricing" badge

This badge means the server has **no price configured for the session's model**, so cost cannot
be computed — it does not mean the session was free. Ask your administrator to add pricing for
that model; afterwards, **Settings → Maintenance → Recompute all sessions** refreshes the
figures.

## Cache read ratio

Each turn shows a **cache_ratio** chip: cache read ÷ (cache read + cache write). High is good —
it means the context was reused instead of re-written. Signals to act on:

- The Summary tab raises a **"Low cache reuse"** finding when a longer session stays below a 70%
  ratio.
- The **Cache Read Ratio** report includes **"Why was cache creation high?"** — it attributes
  heavy cache-writing turns to their cause (context compaction, or re-reading files). The
  token-per-turn threshold for this analysis is configurable in **Settings → Analysis**.

## Context

The **context** is everything the model carries into each call: system setup (CLAUDE.md, rules,
skill and tool definitions), file contents it has read, tool outputs, your prompts, and the
conversation history. It grows over the session, and every call pays for it again — as cache
read when things go well.

Where to see it:

- **Per turn:** a **Context** chip like `35k → 48k (Δ +13k) | 152k left` — size before and after
  the turn, and how much of the model's window remains.
- **Summary tab:** the **Peak context** tile — the largest context any turn reached, as a
  percentage of the model's window.
- **Context Growth** tab: one bar per LLM call showing prior context vs. new growth, with
  **⚡ Compaction** markers where Claude Code compressed the history (e.g. `150k → 40k`).
  Compactions are expensive turns — frequent ones are a sign the session ran too long or read
  too much.
- **Context Usage** tab: a breakdown by category — system overhead, file contents, tool
  results, images, prompt text, conversation history — showing what actually fills the window.

Context Growth is in the **Cost** view and Context Usage in **Harness & context**; both are also
under **More ▾ → Cost & context** (see [Views and tabs](session-log.md#views-and-tabs)).

**Rule of thumb:** a session that keeps its context lean stays cheap; a session pushed near the
window ceiling burns tokens on compaction and re-reading. When peak context is regularly high,
prefer smaller tasks and fresh sessions — and see [Tuning Your Setup](tuning-your-setup.md) for
what to trim.
