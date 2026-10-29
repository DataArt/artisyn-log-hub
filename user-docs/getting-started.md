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

## Exploring a Session

Click any session row to open the **Session Log**. From there you can:

- Browse the **prompt turns** and tool calls in the Timeline tab
- Inspect **cost and token usage** in the Charts tab
- Review **raw log output** in the Raw Logs tab
- See session metadata (model, duration, files touched) in the Info tab
