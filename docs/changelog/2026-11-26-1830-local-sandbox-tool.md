# AgentBook: isolated Docker laptops for Claude Desktop

New separate Windows desktop tool, AgentBook (`agentbook/`), with its own installer: it gives
Claude Desktop isolated Docker "laptops" over SSH on a shared folder — devcontainer-aware
Equipment, given folders, Variables (also added to a running session via `ws env`), sleep / wake,
and a status while Claude Desktop sets Claude up on a new laptop. It works with Docker Desktop,
Rancher Desktop or Docker Engine installed inside a WSL distro.
