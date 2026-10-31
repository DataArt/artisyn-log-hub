# OTEL collection architecture

Claude Code can export OpenTelemetry (OTEL) data: every model call with its tokens and cost, every
tool call, and — with traces on — the whole tree of a turn, including subagents. Log Hub turns that
stream into the OTEL tabs of a session, a repository and a team. This page explains how the data
gets from Claude Code to those tabs, and why the design holds up when you work in many repositories
at once.

![Team OTEL tab: cost, calls and cache by member and model, with the "Sessions with OTEL" coverage tile](images/otel-team-tab.svg)

![Session OTEL tab: the trace of every turn — model calls, tools and subagents — with cost and timing](images/otel-session-tab.svg)

*Illustrations of the [OTEL tab](otel-tab.md) with OTEL switched on (wireframes, not real data).*

## The big picture

```text diagram=otel-overview
 Developer machine (one OS user)
 ┌───────────────────────────────────────────────────────────────────────┐
 │ Claude Code sessions        Shared OTEL receiver       Per-repo data  │
 │  shop-api    ──┐  OTLP       127.0.0.1:<port>      ┌─► shop-api/…/otel│
 │  web-ui      ──┼──────────►  loopback only     ────┼─► web-ui/…/otel  │
 │  billing-svc ──┘                │                  └─► billing-svc/…  │
 │                                 └ ─ ─► your own collector (proxy mode) │
 └───────────────────────────────────────────────────────────────────────┘
        each repo's folder ═══ upload / realtime, with that repo's API key ═══► Log Hub server
```

- Claude Code sends OTLP (OTEL over HTTP, JSON) to **one receiver per OS user**, on a loopback port
  (`127.0.0.1`) that the installer picks once and remembers in `~/.artisyn/otel/port.json`. Nothing
  listens on the network.
- The receiver works out which repository each record belongs to and writes it into **that
  repository's own folder**. From there the hook uploads it with that repository's own server URL
  and API key, the same way it uploads the session transcript.
- When you already export OTEL to a collector of your own, the receiver can also **forward every
  request to it unchanged** (proxy mode, see below), so you do not have to choose between the two.

## One receiver for all your repositories

Claude Code reads its OTEL endpoint from your user settings (`~/.claude/settings.json`), which are
the same for every project. So every session on your machine, in any repository, exports to the
same port, and one receiver serves them all.

```text diagram=otel-receiver-lifecycle
 session starts in any repo
        │
        ▼
 hello on the per-user port ── valid answer ──► register the session ──► receiver serves every repo
        │                                                                     │
    no answer                                                     10 min without OTEL traffic
        ▼                                                                     ▼
 start a receiver from THIS repo's hook copy                     idle-exit, registry saved to
        │                                                         ~/.artisyn/otel/registry.json
 hello within 2 s? ── no ──► status "receiver-down" (port-conflict)          │
        └── yes ──► register                       next session, any repo ◄──┘
```

- **Whoever comes first starts it.** The first session that finds no receiver starts one from its
  own copy of the hook, and every other repository then uses that receiver until it stops after 10
  idle minutes. The next session, in any repository, starts it again.
- **Deleting or moving a repository breaks nothing.** The running receiver has already loaded its
  code and keeps all of its state in `~/.artisyn/otel/`, not in the repository it was started from.
  Data for a repository that no longer exists is dropped with one log line; the others carry on.
- **Older hooks keep working.** A hook before 2.30.0 still runs its own receiver per project on its
  own port, side by side with the shared one.

## Only your own hooks can talk to it

The receiver is on loopback, but other programs and other OS users on the same machine could still
reach the port. So every control request is signed with a secret that only your OS user can read
(`~/.artisyn/otel/token`):

```text diagram=otel-handshake
 Hook (repo session)                               Shared receiver
   │ POST /artisyn/hello {clientNonce, ownerHash} ──►│
   │◄── 409 owner-mismatch (another OS user's one)   │
   │◄── 200 {serverNonce, proof, capabilities}       │   proof = HMAC(token, clientNonce, serverNonce)
   │ verify the proof before sending anything        │
   │ POST /artisyn/register + x-artisyn-auth ───────►│   HMAC over nonce, path and body
   │◄── 200 {ok, receiverVersion, capabilities}      │   a bad signature: 401, logged as auth-reject
```

The hook checks the receiver's proof before it registers anything, so a stranger's program that took
the port never learns where your repositories are or which server they upload to. Server nonces are
single-use and expire after 30 seconds.

## How each record finds its repository

```text diagram=otel-routing
 OTLP record ─► session.id ─► session registered? ── yes ─► signal enabled for that repo?
                                    │                          ├─ yes ─► that repo's OTEL folder
                                    no                         └─ no ──► dropped (counted)
                                    ▼
                    resource tag artisyn.repo matches an installed repo? ── yes ─► that repo's folder
                                    │
                                    no ─► pending spool (5 min, 5000 records) ─► delivered when the
                                                                                session registers,
                                                                                else dropped
```

- A session registers when it starts, so its records go straight to its repository.
- Records that arrive a moment before the registration wait in a short pending spool.
- The installer also adds a resource tag, `artisyn.repo=<key>`, to the repository's local settings.
  The key is a short hash of the repository path, so no local path ever leaves your machine in the
  OTEL stream.
- A repository with traces switched off (`otelTraces: false`) gets logs and metrics only.

## Which settings Claude Code actually uses

```text diagram=otel-settings
 Managed settings (file · OS policy · admin console) ── always win ──┐
 ~/.claude/settings.json (written by the installer) ─────────────────┼─► effective OTEL config
 .claude/settings.local.json mirror (Claude Code < 2.1.282 only) ─ ─ ┘          │
                                                                                ▼
                                             endpoint is the Log Hub receiver? ── yes ─► OTEL tabs filled
                                                     │
                                  no, an admin pinned it ─► "managed-endpoint" / "managed-disabled"
                                  no, your own collector kept ─► "not-configured"
```

- Since Claude Code 2.1.282, telemetry settings in a project's `.claude/settings.json` or
  `.claude/settings.local.json` are ignored ([details](otel-tab.md#claude-code-21282-change)). That
  is why the installer writes them to your user settings, and keeps a copy in the project's local
  settings only for older Claude Code versions.
- Settings your organization manages always win. Log Hub never tries to override them; it tells you
  why the tabs are empty instead ([Admin-managed OTEL](otel-tab.md#admin-managed-otel), and
  [OTEL for organization admins](otel-admin-guide.md) for the admin side).

## Your own collector: proxy, keep or replace

When your user settings already export OTEL somewhere else, the installer asks once (or takes
`--otel-existing=proxy|keep|replace`):

| Choice | What happens | Log Hub OTEL tabs |
|---|---|---|
| `proxy` | Claude Code exports to the receiver, which forwards every request unchanged (OTLP/HTTP JSON, headers included) to your collector. A small user-level hook keeps the receiver running for every project. | filled |
| `keep` | Your settings stay as they are. | empty, reason "OTEL is not configured" |
| `replace` | Claude Code exports only to the receiver. | filled |

Your original keys are saved to `~/.artisyn/otel/forward.json` and put back exactly when the last
repository is uninstalled. Header values (your collector's credentials) are never written to any
Log Hub log.

## When OTEL does not arrive

At the end of each session the hook asks the receiver how many records it got for that session and
adds one small `otel-status` event to the upload:

```text diagram=otel-status-flow
 Hook at Stop / SessionEnd ── session-status ──► receiver: logs · metrics · traces received
          │                                                │
          └── why: managed settings, effective config,     ▼
              Claude Code version ────────────► otel-status event: ok · partial · none + reason
                                                           │ normal upload
                                                           ▼
                                   Log Hub: session reason panel / partial banner,
                                   repo and team coverage banner, reason chips, "Sessions with OTEL"
```

So an empty tab is never a mystery: the session tab names the reason and how to fix it, and the
repository and team tabs show "OTEL for N of M sessions", so totals are never read as zeros for the
sessions that sent nothing. Every reason is explained in
[Troubleshooting: OTEL tab is empty](otel-tab.md#troubleshooting-otel-tab-is-empty).

## Where things live on your machine

| Path | What it is |
|---|---|
| `~/.artisyn/otel/port.json` | the receiver's port, chosen once per OS user (`--otel-port <n>` changes it) |
| `~/.artisyn/otel/token` | the shared secret of the handshake, readable only by you |
| `~/.artisyn/otel/repos.json` | the repositories this user installed the hook in |
| `~/.artisyn/otel/registry.json` | registered sessions, kept across receiver restarts for 24 hours |
| `~/.artisyn/otel/forward.json` | your own collector's settings, for proxy mode and the uninstall restore |
| `~/.artisyn/otel/receiver.log` | the receiver's log (each line is also mirrored into the repository's own log) |
| `~/.artisyn/otel/bin/` | a copy of the receiver used by the proxy-mode user hook |

`--restart-otel-receiver` stops the receiver; the next Claude Code session starts it again with the
installed code.
