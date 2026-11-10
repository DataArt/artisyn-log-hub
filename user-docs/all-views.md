# All views

**All views** is a map of every screen in Log Hub on one page: team tabs, repository tabs,
Analytics views, reports, repository settings, the tabs of a session (the charts included), your
API keys, the admin panel (admins only) and these help articles. Each line says in one sentence
what it answers, so you can find a view without knowing its name.

## Opening the map

- Press **Ctrl+K** (**Cmd+K** on a Mac) on any page, even while typing in a text field.
- Or click **All views** in the top bar, next to the Help button.

The map opens with the filter focused. It takes its context from the page you were on: open it
from a session and that session's team, repository and session are already filled in.

To go back, press **Esc** on an empty filter or click **Back**. You return to the page you came
from.

## The tree

- **Teams**: the tabs of each team you are in.
- **Repositories**: every repository you can open, with its tabs, all Analytics views, the
  reports by category, the settings tabs, Hook state and **Sessions**.
- **Sessions** holds one session: the one in the context. Under it are the session tabs, sorted
  under Overview, Transcript, Cost & context and Effects (each chart is a tab of its own).
- **API keys**, **Admin panel** (administrators only) and **Help**.

The tabs on the map:

| Page | Tabs |
|---|---|
| Team | Members, Repositories, Invitations, OTEL, **Spend**, Settings |
| Repository | Sessions, Analytics, **Spend**, Reports, Tools/MCP, OKF, OTEL, Settings |
| Repository settings | Display, File Categories, Analysis, Monitored Tools, Session Attributes, **Budgets**, Maintenance, Import/Export |

The team OTEL and Settings tabs, and the repository tabs other than Sessions and Spend of a
restricted team, are listed only for those who may open them. **Spend** is listed for every
member.

### Spend and budgets on the map

| Line | What it answers | Also found by |
|---|---|---|
| Team or repository → **Spend** | Spend against the budget, forecast, burn rate and what the cost went on | budget, spend, forecast, burn rate, limit |
| Repository → Settings → **Budgets** | Spend budgets, alert thresholds and their event log | budget, limit, alerts |
| Team → **Settings** | Team budgets and alert thresholds | settings, budgets |
| Repository → Analytics → **Budget Burn** | Cumulative spend of the budget period against the budget, with forecast | budget, forecast, burn rate, limit |
| Repository → Reports → Cost → **Budget** | Spend, percent of budget and forecast per budget period | budget, forecast, limit, spend, burn rate |

See [Budgets](budgets.md) for how they work.

Click a line to open that view. Click a group to expand or collapse it; a collapsed group shows
how many views it holds. Log Hub remembers which groups you opened, per user, in this browser.

Views you have no access to are not listed. A view that only has nothing to show is listed in
grey with the reason, for example *No advisor result for this session*.

## Context: team, repository, session

The **Team**, **Repository** and **Session** fields above the tree set the context of the map.
They are filled in this order:

1. From the page you opened the map from.
2. Otherwise from your last visit. Such a field is marked **from Recent**.
3. Otherwise they read **choose…**.

Pick a team or repository in its field. Click the **Session** field to pick a session.

Views that need a context you have not chosen yet stay visible in grey, with **choose a session ▸**
(or **choose a repository ▸**). Clicking one opens a picker:

- your recent sessions of that repository and its latest sessions,
- a search box that matches the session id or the first prompt,
- **Open the session list instead →** to go to the repository's full session list.

The session you pick fills the context, and the view you clicked opens right away. The map never
picks a session for you.

## Filter

Type in the filter at the top to find a view:

- Matching lines are highlighted and their groups open; the other lines stay visible but dimmed.
- A word matches the start of a word in the name, a synonym or the description. From three
  letters on it also matches inside a word. Every word you type must match.
- When a line matches through a synonym, a small chip shows it (for example **≈ expensive**).
- The counter under the filter reads **N of M views**.

Filtering does not change which groups you opened. The filter is part of the address
(`#/map?q=cost`), so you can share a filtered map.

## Keyboard

| Key | What it does |
|---|---|
| Ctrl+K / Cmd+K | Opens the map; on the map it focuses the filter |
| ↓ in the filter | Moves into the tree |
| Enter in the filter | Opens the first match |
| Esc in the filter | Clears the filter; on an empty filter, goes back |
| ↑ / ↓ | Move between lines (between matches while filtering) |
| → / ← | Expand a group or go to its first line / collapse or go to the parent |
| Home / End | First / last line |
| Enter | Opens the line |
| / | Back to the filter |

## Start from a question

At the top of the map, **Start from a question** lists common questions. Each opens the view
that answers it for the repository in the context:

- **Why was this session expensive?** opens the session of that repository you opened last (from
  your Recent visits) under the Cost lens (Statistics: tokens and cost by model and tool); without
  one it filters this map to the cost views, where you pick a session.
- **Which tools fail most?** opens Tools/MCP filtered to errors of the last week.
- **Is my hook healthy?** opens the repository's Hook state.
- **What context does Claude load at startup?** opens the System context anatomy tab of the session of
  that repository you opened last; without one it filters this map to the startup
  views, where you pick a session.
- **Is my CLAUDE.md being used?** opens the Harness Usage report for the last week.
- **Who spent how much this week?** opens the Cost by User report for the last week.

Without a repository in the context, a question opens the repository picker first.

## Linking to the map

`#/map` takes optional parameters: `teamId`, `repoId` and `session` set the context, and `q`
sets the filter. Values you have no access to are ignored.
