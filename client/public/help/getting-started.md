# Getting Started

## Prerequisites

Before using Artisyn Log Hub, make sure you have:

- **Node.js 18+** installed on your machine
- A running instance of Artisyn Log Hub (server + client)
- Claude Code CLI installed and configured

## Installing the Hook

The Artisyn Log Hub hook captures Claude Code session data automatically.

1. Open **My API Keys** in the left sidebar — the **Install** tab opens first.
2. Copy the hook installation command shown on the page.
3. Run the command in your project's root directory — it installs the hook into your Claude Code
   configuration.
4. Add your API key and the server URL as shown in the Install tab's steps 2 and 3.

For verification steps and troubleshooting, see **Connecting a Repository** in the Reference
section.

After installation, the hook fires automatically whenever a Claude Code session starts or ends.

## Your First Session

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
