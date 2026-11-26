# Welcome to AgentBook

AgentBook gives the agent **a virtual laptop inside your computer**. You point AgentBook at a
folder, get a laptop for it, and Claude Desktop opens on that laptop. The agent works there: it can
install programs and run anything, but it sees only the folders you share or give it — nothing else
of your computer.

## The words AgentBook uses

| Word | What it means |
|---|---|
| **Shared folder** | The folder you pointed AgentBook at. You and the agent both see it; changes are instant. |
| **Laptop** | The agent's own computer for one shared folder. You can have as many as you like, and rename them any time ("Laptop 1", "Q3 reports"). |
| **Get a laptop** | Creates a laptop and opens Claude Desktop on it. |
| **Open laptop** | Opens Claude Desktop on a laptop (and wakes it up first when it sleeps). |
| **Sleep** / **Wake up** | Stops or starts a laptop. Nothing is lost: files and what the agent installed stay. |
| **Give a folder** | Lets one laptop also see another folder of your computer. |
| **View only** | A given folder the agent can read but not change. |
| **Equipment** | The programs on a laptop: from the project (its `.devcontainer`), or the standard Equipment. |
| **Ports** | A server the agent starts on a laptop, opened in your browser at `localhost:<port>`. |
| **Variables** | Values that programs on the laptops read, such as a project's address or token. A secret value is **Hidden**. |
| **Remove laptop** | Deletes the laptop and what the agent installed on it. Your folders are never touched. |

## Good to know

The laptop picture is helpful, but two things work differently from a real laptop:

- **Changes in shared and given folders appear on your computer at once.** There is no copy and
  nothing to sync back. Commit and push from your computer as usual.
- **Laptops with the same shared folder work on the same files.** Don't give two laptops the same
  job — give them different tasks, or the agent on one may change what the other is working on.

## Help pages

- [Getting started](help:getting-started) — install, the SmartScreen step, the first laptop
- [Laptops](help:laptops) — Open, Sleep, Wake up, ports, rename, remove
- [Folders](help:folders) — shared and given folders, View only, a moved folder
- [Equipment](help:equipment) — what is on a laptop, builds, "Equipment changed"
- [Variables](help:variables) — values for programs on the laptops, Hidden values
- [First launch](help:first-launch) — what AgentBook downloads, and why
- [Before the first laptop](help:prerequisites) — Docker engine and OpenSSH
