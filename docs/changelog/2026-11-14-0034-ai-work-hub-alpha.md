# Artisyn AI Work Hub alpha

A new, separate product in `work-hub/`: a self-hosted web workspace where each user runs an AI coding agent (Claude Code) in Docker containers.

- Workspaces with their own git repository and container; every workspace and workstream is a plain folder on the host, readable even when Work Hub or Docker is down. A configure session installs tools into the workspace container.
- Workstreams: a chat with the agent in a real browser terminal, each in its own branch and container, that survive page reloads and server restarts; "Bring into main" takes all the work (saving what the agent left unsaved), or close as already merged, for now, or discard, with a full replay and disk size in History.
- One agent login per user (a long-lived Claude token), kept encrypted outside the containers; the login screen offers the sign-in link with Open / Copy.
- A file tree and editor with upload, download, drag-and-drop and live reload of files the agent changes.
- The same sign-in modes as Log Hub (identify-only, password, password with email confirmation, Azure); runs inline or with Docker Compose.
