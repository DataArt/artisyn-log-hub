# Connecting a Repository

Connecting a project takes one install command, one config entry, and one Claude Code session to
confirm data is flowing. You do this once per repository.

## Prerequisites

- **Node.js 18.19+** and **Git** (the project must be a git repository)
- **Claude Code** installed and working in the project
- An account on this Log Hub server

## Step 1 — Install the hook

Install the hook into your project as described in [Install the hook](../hook/INSTALL_HOOK.md).

## Step 2 — Run a first session

Open Claude Code **in the project's root directory** and submit any prompt. If you open it in a
subdirectory, the hook will ask you to reopen from the root before continuing. Let the turn
finish — the hook uploads at the end of each turn.

## Step 3 — Verify it worked

Within seconds of the first completed turn:

- The repository appears under **My Repos** in the left sidebar.
- An **Installed Hooks** section appears in the sidebar with a green dot and **OK** next to your
  repository.
- Opening the repository shows your session in the **Sessions** tab.

## The Hook State page

Click a repository row in **Installed Hooks** to open its **Hook State** page — the main place to
check hook health:

- A status card: **Hook up to date** (green), or **Hook outdated** / **Hook has open issues**
  (orange), with the installed vs. latest version, last activity time, and a
  **Copy upgrade cmd** button.
- **Recommendations** — actionable configuration hints reported by the hook itself.
- **Non-uploadable logs** — files that failed to upload, with the reason.
- **Errors & warnings** and the tail of the hook's own log.

An orange dot with "N issues" in the sidebar means something on this page needs attention.

## Upgrading and uninstalling

- **Upgrade:** use the **Upgrade Hooks** card on the Install tab (or the **Copy upgrade cmd**
  button on the Hook State page). Upgrading keeps your existing configuration and is safe to
  re-run.
- **Uninstall:** run the same installer command with `uninstall` — it removes the hook and its
  configuration from the project.

## Troubleshooting

- **Repository doesn't appear in the sidebar** — it only appears after the first successful
  upload. Finish at least one full turn, then check `.artisyn/ai_work_dir/hook.log` in your
  project for upload results or errors.
- **Upload errors in hook.log** — the usual causes are a missing or wrong `apiKey` in
  `log-hub.local.json` or a missing `serverUrl` in `log-hub.json`. Fix the config; the next turn
  retries automatically.
- **Prompt blocked with "reopen in project root"** — close Claude Code and reopen it from the
  repository's root directory.
- **Orange "issues" state** — open the Hook State page: upgrade if outdated, and follow any
  recommendations shown there.
