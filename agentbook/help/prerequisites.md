# Before the first laptop

When it starts, AgentBook checks two things on your computer. Each failed check says what to do.
AgentBook never installs Docker, Claude Desktop or OpenSSH itself.

## Docker engine

Laptops run in a Docker-compatible engine on this computer: Docker Desktop, Rancher Desktop or
another engine that offers the Docker API.

If none is found: start Docker Desktop or Rancher Desktop (or ask your administrator), then press
**Check again**. AgentBook looks, in this order, at the `DOCKER_HOST` setting, the current Docker
context, the standard Docker connection of this computer and, last, Docker Engine inside a WSL
distro.

An engine on another computer cannot see your folders, so AgentBook needs one on this computer.

### Docker Engine inside WSL

Docker Engine installed straight into a WSL distro (for example Ubuntu, without Docker Desktop)
works too. When no Docker Desktop or Rancher Desktop answers, AgentBook looks through your WSL
distros and uses the first one where Docker Engine runs. To pick a distro yourself, set
`DOCKER_HOST` to `wsl://<distro name>` (for example `wsl://Ubuntu-24.04`) before starting
AgentBook.

What the distro needs:

- Docker Engine running: `sudo systemctl enable --now docker` (with systemd), or start it with
  `sudo service docker start` each time WSL starts.
- The `docker` command (it comes with Docker Engine).

AgentBook talks to the engine through `wsl.exe` as the distro's root user, so no password and no
`docker` group are needed. It shows your folders to a laptop through the distro's drive mounts
(`D:\work` becomes `/mnt/d/work`); a folder inside the same distro
(`\\wsl.localhost\Ubuntu\home\me\repo`) works as well, a network share does not. Files on Windows
drives are slower to read from WSL than files inside the distro.

WSL stops a distro soon after the last program using it ends, and the laptops with it. So
AgentBook leaves one small helper running in that distro (`wsl.exe` with a sleeping shell
called `agentbook-keep-alive`): laptops keep running after you close AgentBook, as they do with
Docker Desktop. It ends when you sign out of Windows or run `wsl --shutdown`; the laptops then
show **Sleeping**, and **Wake up** starts them again.

Not supported yet with Docker Engine inside WSL: a folder's own devcontainer (use the Standard
Equipment, or Docker Desktop / Rancher Desktop for such folders).

## OpenSSH

Claude Desktop connects to a laptop with OpenSSH. Version 9.4 or later is needed. Windows 11 ships
OpenSSH as an optional feature: **Settings → System → Optional features**.

## Claude Desktop

AgentBook opens laptops in Claude Desktop. If Claude Desktop does not open a laptop, update it
(Help → Check for updates in Claude Desktop) and press **Open laptop** again.

## Already running

Only one AgentBook can run at a time for your user. If you start a second one, it says that
AgentBook is already running; switch to the open window instead.
