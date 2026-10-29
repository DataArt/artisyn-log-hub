# Analytics & Reports

Once a few sessions have been recorded, two repository tabs help you understand them:

- **Analytics** — interactive charts for exploring: pick a view, a time window, and slice by
  branch or user.
- **Reports** — finished, printable documents with KPIs and trends, each downloadable as a PDF —
  made for sharing with a team or management.

## Analytics tab

The toolbar at the top controls every view:

- **Time window:** presets **1d / 2d / 3d / 1w / 2w / 1m** (rolling from now), or **Custom** for
  an exact date range.
- **Group by:** no grouping, by branch, or by user (team repositories only).
- **Branches** / **Users:** popovers to limit the data to a selection.
- **Layout:** **Vertical (timeline)** — values over time — or **Horizontal (ranking)** — totals
  side by side.

Available views:

| View | What it shows |
|---|---|
| Work Time | How long the AI worked autonomously per day |
| Cost | Spend over time |
| Files & Tools | Files edited/written, lines changed, reads per file category |
| Vision | Images examined and image bytes |
| MCP Invocations | Calls to external MCP servers |
| Productivity | Lines per hour, cost per hour, cost per line |
| Log Lines | Volume of recorded log data |
| Cache Read Ratio | How well prompt caching is being reused |
| Tool Analytics | Call counts per tool |
| Token Breakdown | Input / output / cache token volumes |
| Productivity Counters | Diff-based line counts per day |
| Active Sessions | Sessions by last activity |
| Attributes | Session count or cost per attribute value |

## Reports tab

Pick a report from the **Reports** tree on the left, adjust the parameter strip (**Date range**,
**Group by**, **Branches**, **Users**), and press **Generate**. Every report shows an on-page
preview and a **Download as PDF** button.

- **Summary → Executive Summary** — the one to share upward: total AI cost, sessions, adoption
  rate, average cost per session, Advisor and Attribution spend, weekly usage/cost trends, model
  mix, a per-engineer table, and the top 5 most expensive sessions.
- **Activity** — **Session Timeline** (sessions per day), **Work Time Distribution**,
  **Tool Analytics** (tools, main agent vs sub-agents, MCP servers), **Active Sessions**.
- **Code → Branch Summary** — sortable per-branch totals.
- **Cost** — **Cost by Branch**, **Cost by User**, **Cache Read Ratio** (including "Why was
  cache creation high?"), **Token Usage** (by service tier and by day).
- **Productivity** — **Productivity** (cost per line by day) and **Productivity Counters**.
- **Harness → Harness Usage** — every skill, rule, MCP server, and tool available in your
  setup, with how often each was actually used and its token share — the report that finds
  never-used harness elements you're paying context for.
- **Attribution** — **Attribution Breakdown** (sessions and cost per attribute value) and
  **Attribution Usage** (what the attribute evaluations themselves cost).

If an attribute filter is active in the session list, the reports inherit it and print an
"Attribute filter:" line in their header.

## Which one answers your question?

| Question | Where to look |
|---|---|
| "What did AI usage cost this month, overall?" | Executive Summary |
| "Which branch / person is spending the most?" | Cost by Branch, Cost by User |
| "Are we reusing the prompt cache well?" | Cache Read Ratio |
| "Which skills and MCP servers are dead weight?" | Harness Usage |
| "What kind of work were the sessions doing?" | Attribution Breakdown, Attributes view |
| "What's happening right now / this week?" | Analytics tab with a 1d–1w preset |
