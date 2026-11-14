# Artisyn AI Work Hub alpha

A new, separate product in `work-hub/`: a self-hosted web workspace where each user runs an AI coding agent (Claude Code) in Docker containers.

- Workspaces with their own git repository, container and agent login; a configure session installs tools into the workspace container.
- Workstreams: a chat with the agent in a real browser terminal, each in its own branch and container, that survive page reloads and server restarts; close by bringing the work into main, as already merged, for now, or by discarding it, with a full replay in History.
- A file tree and editor with upload, download, drag-and-drop and live reload of files the agent changes.
- The same sign-in modes as Log Hub (identify-only, password, password with email confirmation, Azure); runs inline or with Docker Compose.
