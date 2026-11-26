# Folders

## The shared folder

The shared folder is the folder you pointed AgentBook at. Every laptop of it works on the real
folder — there is no copy. Changes the agent makes appear on your computer at once, and your own
changes appear on the laptops at once.

Laptops with the same shared folder work on the same files. Don't give two laptops the same job.

### Where the agent starts

If the folder holds one project setup (a `.claude/` folder), the agent starts in the folder that
contains it. If there are several, AgentBook asks once and remembers the answer.

### A folder that moved

If a shared folder is moved, renamed, or on a drive that is not connected, its card says so. Its
laptops keep what the agent installed. **Locate folder…** points them at the new place (the laptops
restart), or remove the laptops or the folder. A laptop never starts on a missing folder.

### Remove folder

**Remove folder** takes the folder off AgentBook's list together with its laptops. The folder on
your computer and its files stay untouched.

## Given folders

You can give a laptop more folders of your computer, for example a folder of mockups.

- **Best done when you get the laptop**: in **Get a laptop**, use **Add a folder…**. Nothing
  restarts.
- **On the go**: **Give a folder now…** in the laptop's **⋯** menu. The laptop restarts, attached
  Claude Desktop sessions disconnect, and programs the agent left running stop. AgentBook lists
  every consequence before you confirm, and suggests the calmer option: another laptop like this
  one, with the folder added.

A given folder is **Can change** by default: the agent works on the real folder and could change or
delete files there. Choose **View only** to let it read the folder but not change it.

Inside the laptop, given folders appear under `/work/given/`. The agent can list them with
`ws mounts`.

### The whole disk

AgentBook asks before you share or give your system drive (`C:\`), your home folder or any folder
above it, because the agent would see everything there: your other projects, saved passwords and
keys. Usually you want a smaller folder.
