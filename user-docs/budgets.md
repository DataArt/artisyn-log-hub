# Budgets

A **budget** is a reference amount for what a repository, a team repository or a whole team
spends per day, week or month. Log Hub compares the spend with it, forecasts where the period
will end, points at the days and sessions that stand out, and tells the people who manage the
budget when the spend crosses a threshold.

**A budget is a reference only.** Log Hub never stops, slows down or limits Claude Code when a
budget is reached. It only shows and reports the spend.

## Where you can set a budget

| Scope | Where | Who can set it | Whose sessions count |
|---|---|---|---|
| Personal repository | the repository's **Settings → Budgets** | the repository owner | the owner's own sessions only |
| Team repository | open the repository from the team, then **Settings → Budgets** | the team owner and managers | the team members' sessions in that repository |
| Whole team | the team page, **Settings** tab | the team owner and managers | the team members' sessions in all team repositories |

A scope has at most one budget per period: one daily, one weekly and one monthly. A second
budget of the same period is refused with *A month budget already exists for this scope*.

Team spend counts the sessions of members who acknowledged the team notice, in the team's
repositories, as far as the team's access mode makes them visible to the team. Who may see a
team budget:

- **Team owner and managers** see and change the team's budgets.
- **Members with team analytics access** (every member of a transparent team) see the budgets,
  the whole Spend tab and the event log, read-only. Their Budgets section says *Managed by the
  team owner and managers*.
- **Plain members of a restricted team** see only their own spend on the Spend tab (see
  [Plain members of a restricted team](#plain-members-of-a-restricted-team)). Their Budgets
  section says *Team budgets are visible to the team owner, managers and members with team
  analytics access*.

## Setting a budget

1. Open **Settings → Budgets** of the repository (or the **Settings** tab of the team).
2. Click **+ Add budget**. The form opens under the table.
3. Pick the **period**: Day, Week or Month.
4. Enter the **amount** in USD: more than $0, at most $1,000,000, at most two decimals.
5. Check the **time zone**. It defaults to your browser's time zone; period boundaries are
   counted in it.
6. Set **Notify at**: whole percentages of the amount, 1 to 200, at most ten of them. The default
   is 75 %, 90 % and 100 %. Remove a threshold with ×, add one with **+ Add**. A threshold above
   100 % (for example 150 %) warns about a period that already went far over.
7. Click **Save**.

The form names who gets the notices. To change a budget, click **Edit** on its row; the new
amount applies to the whole period, and the form shows the old one (*was $80.00 · applies to the
whole period*). **Delete** asks for confirmation. The table shows each budget's period, amount,
thresholds, time zone and the spend of its current period, which opens the Spend tab.

## What counts as spend

- **Period.** A day, a week (Monday to Sunday) or a calendar month in the budget's time zone. A
  daily budget is counted in hours.
- **Session trees.** A session and all its sub-agents are one tree. Its whole cost lands on the
  day its root session started; it is not split by call. A tree that started before the period
  does not count, even when it ran into it.
- **The cost of a tree** is the **higher** of two figures: the cost Log Hub computes from the
  transcripts and its price table (hidden utility calls included), and Claude Code's own OTEL
  total for the session. When one of them is missing, the other is used. A tree with neither
  counts $0 and is reported as *unpriced*. Why the higher one: see
  [Budgets and the OTEL cost](cost-and-context.md#budgets-and-the-otel-cost).
- **OTEL-only sessions** (no transcript yet) count once their first upload links them to the
  repository.
- Deleted sessions do not count.

Because of the higher-cost rule, budget figures can be slightly higher than the cost on the
session list, Analytics or the other reports. The Spend tab, the Budget burn view, the Budget
report and the notices all read the same spend, so they always agree with each other.

## The Spend tab

Every repository and every team page has a **Spend** tab (on a repository between **Analytics**
and **Reports**). Every member of a team can open it.

- **Period picker.** Day / Week / Month and **‹ ›** to step back to earlier periods (› is off on
  the current one). The page address keeps the choice, so a link opens the same period.
- **Manage budgets in Settings →** (for whoever may change the budgets) opens the Budgets
  section.
- **Budget card** — *Monthly budget · $50.00*, the spend (*$41.20 of $50.00 · 82 % · resets on
  1 Dec 2026*) and a bar with a tick per threshold. The bar is green below 75 %, amber from 75 %
  and red from 100 %. An amber **Overspend risk** pill shows when the forecast is above the
  amount. Four tiles: **Burn rate**, **Forecast**, **Runs out in** and **Previous period**.
  Without a budget of that period the card reads *Spent this month $X · previous $Y*.
- A grey line counts the *sessions unpriced* and the *OTEL-only* sessions of the period.
- **Daily spend** (**Hourly spend** for a day) — one bar per day with a dashed budget pace line
  (amount ÷ days of the period). A day that spent at least twice the period's daily average is
  marked as an anomaly; hover it to see by how much.
- **Cost slices** — pick a column: **Model**, **User**, **Repository**, **Branch**,
  **Sub-agent**, **Skill** or **MCP server**. Every slice adds up to the period's spend: what a
  column cannot attribute is in a grey **Not reported** row. The sub-agent slice has a **Main
  agent** row; skill and MCP server use Claude Code's per-call OTEL cost.
- **Costly sessions** — trees far above the period's average, marked **2σ** (amber) or **3σ**
  (red), with the mean and σ in the caption.

Click a slice row, a day bar or **List all** of the costly sessions to list the matching
sessions (start, user, branch, cost, first prompt; at most the 200 costliest). Each row opens its
session.

### Plain members of a restricted team

A plain member of a restricted team sees only their **own** spend of the period, and a budget card
only when their own spend alone is over the budget. There are no daily bars, no slices and no
costly sessions. The rest of the team's spend stays hidden.

## How the numbers are computed

A **unit** is a day for a weekly or monthly budget and an hour for a daily one. The current day
(or hour) counts as elapsed.

| Figure | Formula |
|---|---|
| Burn rate | spend ÷ elapsed units |
| Forecast | spend + burn rate × units left in the period |
| % used | spend ÷ amount × 100 |
| Runs out in | (amount − spend) ÷ burn rate. Shows **~N days**, or a clock time (**~16:40**) for a daily budget; **—** with no spend yet; **exceeded** at or over the amount |
| Overspend risk | the forecast is above the amount (current period only) |
| Previous period | the previous period's spend, and its % of the **current** amount |
| Anomaly day | a day's spend ≥ 2 × the period's average per elapsed day (from the second day on) |
| Costly session | a tree's cost ≥ mean + 2σ (2σ) or mean + 3σ (3σ) of the period's priced trees; needs at least five of them |

Log Hub keeps no amount history: after an edit the whole period, and the previous period's %,
use the new amount. A past period has no forecast and no *Runs out in*.

## Notices: bell, banner and email

The server checks every budget about every **5 minutes** (a background job, see
[Server settings](server-configuration.md)), so a notice can come a few minutes after the session
that crossed the threshold.

- **One notice per threshold and period.** When the spend reaches a threshold, the people who
  manage the budget get one notice. When several thresholds are crossed at once, only the highest
  gets a notice; the lower ones are recorded as *superseded* in the event log.
- **Who gets it.** A personal repository budget: its owner. A team repository or team budget: the
  team owner and the managers. Plain members get no notices.
- **The bell** in the top bar counts unread team invitations plus unread budget notices. Its tray
  lists the notices under the invitations, newest first, and loads older ones as you scroll.
  Click a notice to open the Spend tab at that period and mark it read; **Mark all read** clears
  them all.
- **The banner** under the top bar shows up to three unread notices, the highest threshold first:
  amber below 100 %, red at 100 % and above. × marks one read.
- **Email.** When the server's mail service is configured (SMTP in the password sign-in modes),
  every recipient also gets an email with the spend and a link to the Spend tab. Without it — for
  example under authentication mode `none` or Entra ID sign-in — notices are in-app only. The
  link needs `PUBLIC_BASE_URL`; without it the email has no link. See
  [Server settings](server-configuration.md#budget-threshold-job).

A notice stays after the budget is edited or the spend drops. After an edit, a threshold that is
newly crossed (for example because you lowered the amount) gets its notice once.

## Budget event log

**Budget event log**, next to **+ Add budget**, opens the history of the scope's budgets, newest
first, in your browser's time zone. Filter it by budget and by event; **Load older events** pages
back. Columns: time, actor, budget, event and details.

| Event | Written when |
|---|---|
| Created, Edited, Deleted | someone changed a budget (Edited lists what changed, for example *amount $80.00 → $100.00*) |
| Threshold crossed | the job raised a notice |
| Threshold superseded | a lower threshold was crossed together with a higher one and got no notice |
| Email sent, Email failed | the notice email to one recipient was sent or failed |
| Email skipped | the mail service is not configured, so no email was sent |

The actor of job events is **system · threshold job**. Events of a deleted budget stay, marked
**(deleted)**. The log is visible to everyone who can see the scope's budgets.

## Budgets in Analytics and Reports

On a repository, **Analytics → Budget Burn** draws the cumulative spend of the budget period
against the budget, its thresholds and the forecast, and **Reports → Cost → Budget** lists every
budget's periods in a date range with spend, % and forecast, as a PDF too. See
[Analytics & Reports](analytics-reports.md).

## When budgets go away

A team's budgets, notices and events are removed with the team. A repository's are removed with the
repository (or with the team repository when it is removed from the team), and a personal
repository's with its owner's account. Deleting one budget keeps its notices and events.
