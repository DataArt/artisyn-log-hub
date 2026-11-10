# Analytics & Reports

Once a few sessions have been recorded, these repository tabs help you understand them:

- **Analytics** — interactive charts for exploring: pick a view, a time window, and slice by
  branch or user.
- **Spend** — the spend of a day, week or month against its budget, with the forecast and what
  the money went on (see [Spend view](#spend-view)).
- **Reports** — finished, printable documents with KPIs and trends, each downloadable as a PDF —
  made for sharing with a team or management.

## Analytics tab

The toolbar at the top controls every view:

- **Time window:** presets **1d / 2d / 3d / 1w / 2w / 1m** (rolling from now), or **Custom** for
  an exact date range.
- **Group by:** no grouping, by branch, by user (team repositories only), or — under
  **Attributes**, once session attributes are configured — by any session attribute.
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
| Change Surface | How widely each session's file changes spread across folders and modules |
| Tool Analytics | Call counts per tool |
| Token Breakdown | Input / output / cache token volumes |
| Productivity Counters | Diff-based line counts per day |
| Active Sessions | Sessions by last activity |
| Budget Burn | Cumulative spend of the budget period against the budget, with the forecast |

**Budget Burn** works differently from the other views: it has no time window and no **Group
by**. Its x-axis is the current period of the budget you pick (monthly first, then weekly, then
daily). It draws the cumulative spend, the budget line with its thresholds, the forecast to the
end of the period, the previous period for comparison and markers on anomaly days. **Branches**
and **Users** narrow only the spend line, which the label *filtered — budget line is for the
whole scope* points out. Without a budget it shows the cumulative spend of the current month in
your time zone. The spend is the one of [Budgets](budgets.md#what-counts-as-spend), so the last
point equals the Spend tab's total.

## Spend view

The **Spend** tab of a repository (and of a team page) answers "how much did we spend this
day / week / month, will we stay within the budget, and on what did the money go?":

- a budget card with the spend, the % of the budget, the burn rate, the forecast, when the
  budget runs out and the previous period;
- daily (or hourly) spend bars with the budget pace line and the anomaly days;
- cost slices by model, user, repository, branch, sub-agent, skill and MCP server;
- the costly sessions, far above the period's average.

Every member of a team can open it; a plain member of a restricted team sees only their own
spend. How to set a budget, how the spend and the forecast are computed, and the notices are in
[Budgets](budgets.md).

## Reports tab

Pick a report from the **Reports** tree on the left, adjust the parameter strip (**Date range**,
**Group by**, **Branches**, **Users**), and press **Generate**. Every report shows an on-page
preview and a **Download as PDF** button.

- **Summary → Executive Summary** — the one to share upward: total AI cost, sessions, adoption
  rate, average cost per session, Advisor and Attribution spend, weekly usage/cost trends, model
  mix, a per-engineer table, and the top 5 most expensive sessions.
- **Activity** — **Session Timeline** (sessions per day), **Work Time Distribution**,
  **Tool Analytics** (tools, main agent vs sub-agents, MCP servers), **Active Sessions**.
- **Code** — **Branch Summary** (sortable per-branch totals) and **Change Surface** (the files,
  folders and modules the period's sessions changed, and how spread out the changes were).
- **Cost** — **Cost by Branch**, **Cost by User**, **Cache Read Ratio** (including "Why was
  cache creation high?"), **Token Usage** (by service tier and by day), **Budget** (every budget
  of the repository, each of its periods in the date range with spend and % of the budget, the
  current one with its forecast, plus the top cost slices; without a budget, the monthly spend).
  The Budget report takes only the date range: no grouping and no branch or user filter.
- **Productivity** — **Productivity** (cost per line by day) and **Productivity Counters**.
- **Harness** — **Harness Usage**: every skill, rule, MCP server, and tool available in your
  setup, with how often each was actually used and its token share — the report that finds
  never-used harness elements you're paying context for. **Claude Code Version Usage**: the
  Claude Code versions each user ran in the period.
- **Attributes** — **Attribute Breakdown** (sessions and cost per attribute value) and
  **Attribute Extraction Usage** (what the attribute evaluations themselves cost).

If an attribute filter is active in the session list, the reports inherit it and print an
"Attribute filter:" line in their header.

## Which one answers your question?

| Question | Where to look |
|---|---|
| "What did AI usage cost this month, overall?" | Executive Summary |
| "Which branch / person is spending the most?" | Cost by Branch, Cost by User |
| "Are we reusing the prompt cache well?" | Cache Read Ratio |
| "Which skills and MCP servers are dead weight?" | Harness Usage |
| "What kind of work were the sessions doing?" | Attribute Breakdown, Analytics grouped by an attribute |
| "Is everyone on a current Claude Code?" | Claude Code Version Usage |
| "What's happening right now / this week?" | Analytics tab with a 1d–1w preset |
| "Will we stay within the budget this month?" | Spend tab (forecast, runs out in), Analytics → Budget Burn |
| "On what did this month's money go?" | Spend tab → cost slices and costly sessions |
| "How did we do against the budget last quarter?" | Budget report with that date range |
