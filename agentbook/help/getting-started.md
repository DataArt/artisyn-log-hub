# Getting started

## Run AgentBook

AgentBook is one program, `AgentBook.exe`. You can run it straight from your Downloads folder, or
run `AgentBook-Setup.exe`, which copies it to your user folder and adds AgentBook to the Start menu.
Neither needs administrator rights. Both see the same folders and laptops, because AgentBook keeps
its data in your user data folder (`%LOCALAPPDATA%\AgentBook`), not next to the program.

### The one-time SmartScreen step

AgentBook is not code-signed, so the first time you start it Windows may show **"Windows protected
your PC"** (Microsoft Defender SmartScreen). To start it:

1. Click **More info**.
2. Click **Run anyway**.

Windows remembers the choice for this file. A newer version may ask once more.

To update AgentBook, run a newer `AgentBook-Setup.exe` (or use a newer `AgentBook.exe`). Your
folders, laptops and settings are kept.

## Before the first laptop

AgentBook needs a Docker engine (Docker Desktop, Rancher Desktop or another Docker-compatible
engine) running on this computer, and OpenSSH 9.4 or later. It checks both when it starts; see
[Before the first laptop](help:prerequisites).

On its first launch AgentBook downloads what it needs, once. See [First launch](help:first-launch).

## Your first laptop

1. Click **Add a shared folder…**, or drag a folder onto the window. Pick the folder the agent
   should work in. It sees that folder and nothing else of your computer.
2. If the folder has more than one project setup (`.claude/` folders), AgentBook asks once where the
   agent should start, and remembers the answer.
3. Click **Get a laptop**. Keep the suggested name or type your own, optionally give it more
   folders, and press **Get it and open** (or Enter).
4. AgentBook gets the laptop's Equipment ready — the first time can take a few minutes — and opens
   Claude Desktop on it.

The first time you open a laptop, Claude asks whether you trust it — once. After that, **Open
laptop** goes straight to work.

## Talking to the agent about its laptop

Inside a laptop, the agent can run `ws whoami` (which laptop it is on, the repos and their branches,
the other laptops of the folder) and `ws mounts` (the folders it can see and their modes). Every
prompt also carries one short line with the laptop's name and branch, so the agent always knows
where it is.
