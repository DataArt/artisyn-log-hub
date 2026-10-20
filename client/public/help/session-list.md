# Working with the Session List

Open a repository from **My Repos** to land on the **Sessions** tab: the session list on the
left, and the selected session's details on the right. (The other repository tabs are
**Analytics**, **Reports**, and **Settings**.)

## View modes

The dropdown at the top of the list offers four ways to group sessions:

- **By branch** (default) — one collapsible group per git branch. The header shows the branch,
  a session count, and the latest activity, work time, and total cost; hover for details.
  Sessions load when you expand a branch.
- **By date** — one group per calendar day, newest open.
- **By user** — one group per uploader, useful on team repositories. This mode always shows all
  uploaders.
- **Plain list** — one flat list.

Your choice is remembered per browser.

## Reading a session row

- **First line:** end date-time and the session cost. Cost is color-coded relative to the other
  visible sessions — green (cheapest), blue, orange (most expensive), red for an outlier. A star
  marks a favorite.
- **Second line:** the session's first prompt (truncated).
- **Badges:** the git branch (green), **⚡ Workflow** if the session ran a workflow (purple),
  **hook-service** for internal background sessions (amber), and sky-blue **attribute chips**
  like `Jira Ticket: ABC-123` once the session has been auto-classified.
- A yellow **lightbulb** in the corner means the Advisor has cost-saving advice for this
  session — clicking it opens the session directly on its Advisor tab.
- **⚠ no pricing** (amber) means the session's model has no pricing configured, so its cost
  can't be computed — see the "Understanding Cost & Context" article.

## Filtering

- **Filter by attribute** — the button under the view-mode dropdown (shown once your team has
  session attributes configured). It lists each attribute's values with session counts; click a
  value to show only matching sessions. Special entries: **Not determined** (evaluated, but the
  value couldn't be established) and **Unattributed (no evaluation yet)**. One filter is active
  at a time; **Clear filter** removes it. The active filter also carries over into Reports.
- **Hide hook-service sessions** — on by default; toggle it in **Settings → Display** if you
  want to see the hook's internal background sessions.
- On a personal repository the list shows **your** sessions by default. If other people uploaded
  sessions to the same repository, an amber notice reports how many are hidden, with a
  **Show all** link.

## Staying up to date

The refresh button (circular arrow, left of the tab row) re-fetches everything. A small **red
dot** on it means new sessions have arrived that the current view doesn't show yet — the app
checks roughly every 15 seconds. Click refresh to pull them in.

## Working with a session

Click a row to open the session. The header shows start/end times, user, model, prompt count,
work time, token totals, cost, max context, and skills used. The toolbar below it has:

- A **star** to favorite the session (favorites show the star in the list).
- **Refresh** — reloads just this session's logs (useful while a session is still running).
- The content tabs: **Summary**, **Info**, **Logs**, **Charts**, **Advisor** (when advice
  exists), **Statistics**, **Change surface**, **Harness usage**, and **Raw Logs** (visible only
  to the session's own uploader and admins).
  - **Change surface** shows *where* this session's tree wrote — changed files, folders and
    modules, and how concentrated those changes were.
  - **Harness usage** shows *what harness the session used*: a tree of the main session and
    every agent sub-session it spawned (workflow fan-outs grouped under one node), and for the
    selected session a chronological list of the skills, rules, sub-agent spawns, workflow runs,
    MCP tool calls and slash commands it used. Turn on **Include sub-sessions** to fold in
    everything its descendants used as well. Ordinary tool calls (Read, Bash, Edit…) are not
    listed here — the Logs and Statistics tabs cover those.
- **Remove** (session owner or admin only) — permanently deletes the session and all its data,
  after a confirmation dialog. This cannot be undone.

## Team repositories

- By default, members of a team see only **their own** sessions in a team repository.
- The team owner can enable **"Allow members to see each other's sessions"** on the team's
  Members tab. When it's on, a blue **Team-wide session visibility** badge appears in the
  repository header and everyone sees all members' sessions and analytics.
- **Raw Logs** stay private to each session's uploader regardless of this setting.
