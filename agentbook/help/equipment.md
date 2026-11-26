# Equipment

Equipment is the set of programs on a laptop.

- **From the project**: when the shared folder has a `.devcontainer` setup
  (`.devcontainer/devcontainer.json` or `.devcontainer.json`), AgentBook builds the laptop from it,
  exactly as the project describes. If there are several, the folder view lets you pick one.
- **Standard**: otherwise, a recent Ubuntu LTS with git, curl and Node.js.

AgentBook adds a small layer on top of either, so Claude Desktop can connect.

Equipment from the project needs the `docker` command, which Docker Desktop and Rancher Desktop
install. The standard Equipment does not.

## The first build

The first time a laptop starts with new Equipment, AgentBook builds it. The card shows the steps
and the last lines of the build log; **Show full log** opens the whole log. Later starts reuse the
build and are quick.

## When a build fails

The laptop is not started, and the card keeps the last lines of the log. **Copy log** copies them,
for example to ask someone for help. Fix the `.devcontainer` in the shared folder, then press
**Retry**.

If the base image cannot take AgentBook's layer (an image with no package manager, such as a
"distroless" or "scratch" image), the card says so in plain words.

## Equipment changed — Update laptop

When the project's `.devcontainer` changes (or a new AgentBook ships new standard Equipment), the
existing laptops keep their own Equipment and show **Equipment changed — Update laptop**. New
laptops get the new Equipment.

**Update laptop…** builds the new Equipment first. Only when that works does it restart the laptop
on it, keeping the laptop's home folder. AgentBook lists the consequences (the restart, attached
sessions, running programs) before it starts. If the build fails, nothing changes: the laptop keeps
its current Equipment and keeps working.

## Equipment that opens your computer

Some project setups give the laptop access to your computer, for example to Docker itself
(`/var/run/docker.sock`), to a folder of your computer the project chose, to your network or to
your devices. AgentBook shows a warning naming it. It does not block it: that is your project's
choice.
