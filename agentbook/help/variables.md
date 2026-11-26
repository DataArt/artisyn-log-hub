# Variables

Variables are values that programs on the laptops read, such as an address or a token. AgentBook
only delivers them; it knows nothing about what they are for. For example, a project may ship a
script that reads `JIRA_URL` and `JIRA_PAT`.

Open **Variables…** on the folder view, or in a laptop's **⋯** menu.

## Where values come from

- **Project default**: the project's `.devcontainer` may declare variables (`containerEnv` and
  `remoteEnv`). An empty default means the variable **needs a value**.
- **You**: you can change a default, reset it to the project default (**↺ project default**), add a
  variable the project does not declare, and remove one you added.

Values apply to every laptop of the shared folder. As an exception, a value can be set **Only for one
laptop** — for example a different token for one laptop. That laptop then sees its own value; removing
it falls back to the folder's value.

Names are letters, digits and `_`, not starting with a digit.

## Hidden values

A **Hidden** value is masked and kept in Windows Credential Manager — never in AgentBook's own files,
logs or the instructions for the agent. Names with `TOKEN`, `PAT`, `SECRET`, `PASSWORD` or `KEY`
start as Hidden. A Hidden value is not shown again; type a new one to replace it.

**The agent and every program on these laptops can read all values, hidden ones too.** Hidden only
keeps a value off your screen and out of files.

## When changes apply

Changes apply to new Claude Desktop sessions. Sessions already open keep the old values. Nothing
restarts.

A laptop card notes when a variable still needs a value. **Open laptop** works anyway.

## Known limitation

Values live only in the running laptop's memory, never on its disk. A laptop started outside
AgentBook (for example after your computer restarted) while AgentBook is closed has no Variables
until you open AgentBook again; AgentBook then delivers them by itself.
