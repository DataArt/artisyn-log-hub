# Laptops

A laptop is the agent's own computer for one shared folder. A folder can have any number of
laptops; only your computer's memory limits how many work at once.

## Open laptop

**Open laptop** opens Claude Desktop on the laptop. A sleeping laptop is woken up first. AgentBook
also refreshes the laptop's instructions for the agent, your skills, agents and commands (copied
from your `~/.claude` folder — never your sign-in), and its Variables.

## Sleep and Wake up

AgentBook never puts a laptop to sleep by itself.

- **Sleep** stops a working laptop. Files and what the agent installed stay. If Claude Desktop is
  still connected, AgentBook asks first: the sessions disconnect, the agent stops mid-task, and
  programs it left running (servers, builds) stop.
- **Wake up** starts a sleeping laptop without opening Claude Desktop. **Open laptop** wakes it and
  opens Desktop.

Laptops keep working when you close AgentBook. A laptop that was stopped outside AgentBook (for
example after a restart of your computer or of Docker) shows as Sleeping.

## Sessions

The card shows how many Claude Desktop sessions are attached to a laptop. The number counts open
connections; only "none" versus "some" is exact.

## Rename

Click **✎ rename** (or **Rename** in the **⋯** menu). The name is only for you: the laptop keeps its
internal id, so renaming never brings back Claude's trust question. Two laptops of one folder with
the same name get a short note, not a block.

## Another laptop like this

Opens **Get a laptop** filled in from an existing laptop: the same shared folder, given folders and
their modes, and Equipment. It copies the setup only — the new laptop starts fresh, with nothing the
agent installed, no sessions and no chat history. Variables set "Only for one laptop" are copied
too; the dialog names them before you confirm.

## Ports

A server the agent starts on a laptop (a dev server, an API) opens in your browser only through a
**forwarded port**: `localhost:5173` on your computer reaches port 5173 inside the laptop. The
**Ports** part of the laptop card lists them; click an address to open it.

- A project whose `.devcontainer` lists `forwardPorts` gets those by default.
- **Ports…** adds, changes or removes them. Leave "On this computer" empty to use the same port.
  Two laptops cannot use the same port of your computer at once: give the second one another
  port (for example 15173 for 5173).
- Ports are forwarded while the laptop works and AgentBook is open. Changing them does not restart
  the laptop.
- "Another program on this computer uses this port" means something else on your computer already
  listens there; pick another port.

The agent sees the same list with `ws ports` and gives you the right address.

## What a laptop keeps

The laptop's home folder is kept for its whole life (also when it sleeps, is updated or gets a new
folder). Everything outside it — system packages, `/usr`, `/etc`, `/tmp` — may be lost when the
laptop restarts with changes (giving a folder, Update laptop, a moved folder). The agent is told so.

## Remove laptop

**Remove laptop** (in the **⋯** menu) deletes the laptop and everything the agent installed on it,
and forgets its name, given folders and its own variables. It never touches your folders. There is
no separate reset: to start clean, remove a laptop and get a new one.
