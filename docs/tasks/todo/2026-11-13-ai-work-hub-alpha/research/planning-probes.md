# Planning probes — 2026-11-13

Short experiments run during `/adlc-lh:plan-deep` to settle the research report's open gaps. The
conclusions are carried into `impl-plan.md` (Design Decisions).

## Volume copy (FR-5b, AC-20c)

PoC [`docs/pocs/2026-11-13-2008-workhub-volume-copy/`](../../../../pocs/2026-11-13-2008-workhub-volume-copy/README.md),
14/14. A `docker commit` of the workspace container holds neither the repository nor
`.credentials.json` when both are volumes. The copy recipe is a helper container from the default
image as root, sources mounted read-only: `cd /from && tar cf - . | tar xpf - -C /to`. Owner, mode
and symlinks are kept, and git needs no `safe.directory`. With 20 000 extra small files, both
volumes copy in about 2 s, and the container run takes about 0.4 s. A fresh volume is populated from
the image on first mount; a copied volume is not. `docker cp` (archive endpoints) reads and writes
volume-mounted paths.

## Claude CLI (in the terminal-bridge PoC image, CLI 2.1.323)

- `claude auth status` prints JSON (`loggedIn`, `authMethod`, `loginExpiresAt`, `configDirectory`)
  and exits **1** when not logged in → the adapter's login check is "exit code 0 and
  `loggedIn: true`".
- `claude auth login` exists (subcommands: login, logout, status).
- `--session-id <uuid>` starts a conversation with a chosen id; `--resume <id>` / `-c` continue
  one; `--append-system-prompt <text>` adds an instruction (used by the Configure session);
  `--settings <file-or-json>` exists.

## tmux 3.5a activity (agent "busy" check, FR-29)

`tmux display -p -t <s> '#{window_activity}'` returns the epoch second of the pane's last output
and moves with each output (1794586463 → 1794586465 after an `echo`). "The agent is working" =
last activity within the last 5 s, compared with the container's `date +%s`. Agent-agnostic, one
exec.

## Library versions looked up (cargo search / npm view, 2026-11-13)

axum 0.8.9, tokio 1.54.1, bollard 0.21.1, sqlx 0.9.0, tower-sessions 0.15.0,
tower-sessions-sqlx-store 0.16.0, argon2 0.6.0, lettre 0.11.23, openidconnect 4.1.0,
deunicode 1.6.2, tar 0.4.46, zip 9.5.1, uuid 1.29.2, tower-http 0.7.1, rust-embed 8.14.0,
tracing-subscriber 0.3.23, dotenvy 0.15.7; codemirror 6.0.2, @codemirror/language-data 6.5.2,
@xterm/xterm 6.0.0, @xterm/addon-fit 0.11.0, @xterm/addon-clipboard 0.2.0,
@xterm/addon-web-links 0.12.0. Local toolchain: rustc/cargo 1.92.0; Docker Engine 29.7.
