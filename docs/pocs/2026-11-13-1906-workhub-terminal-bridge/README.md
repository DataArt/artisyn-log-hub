# PoC: the chat tab as a real terminal (Rust ⇄ Docker exec ⇄ tmux ⇄ Claude CLI)

Task: [2026-11-13-ai-work-hub-alpha](../../tasks/todo/2026-11-13-ai-work-hub-alpha/requirements.md)
(FR-24, FR-27a–FR-27c, FR-32, FR-33, NFR-1a, AC-19, AC-22, AC-22a, AC-22b, AC-27, AC-28).

## Question

With the required stack (Rust backend, React/browser frontend), can the chat tab be a full
interactive terminal running the Claude CLI inside a container, where:

- colours, cursor movement, redraws and interactive prompts (arrows + Enter) work as in a local
  console (FR-27b);
- resizing the tab re-flows the CLI;
- a page reload, and even a **restart of the Work Hub server**, does not stop the agent, and
  reconnecting shows the live session (FR-27c);
- the session output is recorded and can be replayed read-only with its colours (FR-32/33);
- Claude's own login scenario can run inside that terminal (FR-24);
- the whole thing works in a light theme (NFR-1a)?

## Design tested

```
xterm.js ──WebSocket(binary = keys/output, text JSON = resize)──▶ axum (Rust)
   ──bollard: docker exec, TTY, attached stdin/stdout──▶ `tmux attach -d -t <session>`
   ──▶ tmux session inside the container ──▶ `claude`
tmux pipe-pane ──▶ raw output log (history)
```

tmux runs *inside the container* and owns the session. It has no status bar and no prefix key, so
the user never sees it. The Rust server holds nothing and only bridges bytes.

## How to run

From this folder (needs Docker and a Rust toolchain; the image installs the Claude CLI from npm):

```sh
docker build -t workhub-poc-term image
docker run -d --name wh-poc-term workhub-poc-term
cargo build
./target/debug/workhub-terminal-bridge-poc          # listens on 127.0.0.1:7801
node test.js t1                                     # prints PANE_PID=<n> at the end
# kill and restart the server, then:
PANE_PID=<n> node test.js t1 --after-restart
# manual look: http://127.0.0.1:7801/?session=demo  and  ...?session=demo&history
docker rm -f wh-poc-term
```

`WH_CONTAINER`, `WH_PORT` and `WH_SESSION_CMD` (default `claude`) override the defaults.

## Result

**Works. 9/9 checks on a fresh session, 3/3 after a server restart, and checked visually in a
browser.**

```
PASS  the CLI started in the container and its screen reached the browser
PASS  browser size is applied to the session (resize)
PASS  ANSI colour / cursor sequences pass through untouched
PASS  arrow-down key reaches the CLI and moves its selection   "❯ ✔ Dark mode" -> "❯   Light mode"
PASS  arrow-up moves it back
PASS  resize to 80x24 re-flows the session
PASS  page reload: reconnect shows the running session (same process, screen redrawn)
PASS  no tmux client is left behind after the browser disconnects
PASS  history: raw pane output is recorded (replayable in a read-only terminal)   11610 bytes
--- server process killed and started again ---
PASS  after a server restart the reconnect gets the screen redrawn
PASS  the CLI process is the same one (tmux kept it alive)   pane pid <n> -> <n>
PASS  no tmux client is left behind (stale clients of the killed server dropped too)
```

In a real browser (Playwright, Chromium): Claude CLI 2.1.323's first-run theme picker rendered in
truecolor on the light xterm.js theme. Real ArrowDown/Enter key presses chose "Light mode". The
next screen ("Select login method") worked the same way. Choosing the subscription login printed
`Browser didn't open? Use the url below to sign in` with the OAuth URL as a clickable OSC-8
hyperlink, followed by `Paste code here if prompted >`. The history page replayed the recorded
bytes read-only with the same colours and layout.

Conclusions for the requirements:

1. **FR-27a/b are feasible with xterm.js + a WebSocket + bollard exec with a TTY.** The bytes pass
   through untouched, so Work Hub needs no knowledge of the CLI (FR-2 agent-agnostic holds at this
   level). The Rust crates used: `axum 0.8` (ws), `bollard 0.18`. They compiled on the first try.
2. **FR-27c, and survival of a server restart, come for free from tmux inside the container.**
   The server is stateless about terminals. Reconnecting attaches again and tmux redraws the
   current screen. tmux is part of the container image Work Hub prepares.
3. **Found and fixed:** closing stdin of a TTY `docker exec` does **not** end `tmux attach`. Every
   reconnect leaked a client, and a killed server left its clients behind. Fix: the exec first
   prints its pty, and on disconnect the server runs `tmux detach-client -t <pty>`.
   `attach -d` drops stale clients from a crashed server. One viewer per workstream: a second
   browser tab takes the session over (fine for a personal alpha).
4. **FR-24 needs no Work Hub UI for the sign-in itself.** The CLI's own login runs in the
   terminal tab: choose a method with the arrows, open the link, paste the code back. The
   requirement's "`claude login`" is `claude auth login` in CLI 2.1.x, or simply the first-run
   flow of `claude`. `claude setup-token` ("long-lived authentication token, requires Claude
   subscription") also exists. Its token can be stored by the server per workspace and injected as
   `CLAUDE_CODE_OAUTH_TOKEN` into every container. That is a cleaner base for "per workspace",
   "copy from my workspace" and "inherited by every workstream" than copying
   `~/.claude/.credentials.json`, whose refresh token is refreshed independently in every copy.
   This PoC did **not** complete a real sign-in (no account used), so the token-rotation risk and
   the `setup-token` flow end to end are still unverified.
5. **History (FR-32/33):** `tmux pipe-pane` records the raw pane output losslessly from the first
   byte (the pane waits on `tmux wait-for` until recording is attached), and xterm.js replays it.
   For the product: copy the log out of the container into Work Hub's storage (it must outlive a
   discarded container), and record resize events next to the bytes (asciicast-like). The raw log
   alone replays correctly only at the original size.
6. **Light theme (NFR-1a):** the xterm.js light palette works. The CLI also has its own
   "Light mode" setting. The adapter should preset it (`theme` in the CLI config) so the first-run
   picker is not shown in dark mode. Claude's "c to copy" uses OSC 52, and xterm.js needs its
   clipboard addon for that. Clickable links need the OSC-8 link handler.
7. **Offline first (NFR-2):** this PoC page loads xterm.js from a CDN only for brevity. The
   product bundles it via npm.
