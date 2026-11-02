# Your first session

## Prerequisites

Before using Artisyn Log Hub, make sure you have:

- **Node.js 18+** installed on your machine
- A running instance of Artisyn Log Hub — see [Install the server](install-server.md)
- Claude Code CLI installed and configured

## Installing the Hook

Install the hook into your project as described in [Install the hook](../hook/INSTALL_HOOK.md).

## Record a session

Once the hook is installed:

1. Start a Claude Code session in any project directory.
2. Work normally — the hook captures all session events in the background.
3. Return to Artisyn Log Hub and select your repository from the left sidebar.
4. Your session will appear in the session list within seconds of completion.

## The Home page

After you sign in, Log Hub opens **Home**. It lists your **Repositories** (your own and your
teams', the ones you visited most recently first) with their sessions and cost of the last seven
days, the hook status and a few question chips such as **Why was this session expensive?** or
**Is my hook healthy?**. A question opens the view that answers it, already filtered to the
repository and the last week; **Start from a question** offers the same questions for the
repository you pick. On the right, **Needs attention** points at hooks with problems, sessions
with Turn-End Cost Advisor advice and failed tool calls of the week; **This week** shows the cost
per repository and per team; **Pinned** holds what you pinned with the pin button on a
repository, an Analytics view or a report, plus your favourite sessions; and **Recent** lists the
repositories and sessions you opened last. **All views →** opens a map of every screen (see
[All views](all-views.md)). A new account with no repositories and no teams sees **Get started**
instead, with links to install the hook and connect a repository.

## Exploring a Session

Click any session row to open the **Session Log**. From there you can:

- Browse the **prompt turns** and tool calls in the Timeline tab
- Inspect **cost and token usage** in the chart tabs (Charts, Call Tree, Context Growth, …)
- Review **raw log output** in the Raw Logs tab
- See session metadata (model, duration, files touched) in the Info tab
- Pick a **View** at the start of the tab row to see only the tabs that answer one question —
  see [Session Log](session-log.md#views-and-tabs)
