# Evidence — AC-X1 manual check (2026-10-31)

Real `claude -p` sessions on Claude Code 2.1.314 (≥ 2.1.282), hook 2.30.2, installer 1.0.90,
against the local dev server. Three isolated "OS users", each with its own HOME and
`CLAUDE_CONFIG_DIR` (the developer's own `~/.claude` and `~/.artisyn` were never touched):

| User | Setup | Repos |
|---|---|---|
| alice | own collector on the generic `OTEL_EXPORTER_OTLP_ENDPOINT` (with an auth header), `--otel-existing=proxy` | shop-api, web-ui |
| bob | no collector | shop-api, billing-svc |
| carol | own collector, `--otel-existing=keep` | shop-api |

Team "Web Shop (OTEL demo)" = all three users, all three repos. 19 sessions (haiku and sonnet,
some with a `Task` subagent).

The first round of sessions ran before two fixes found by this check (see below); its sessions
have no OTEL and show reason `unknown` — they are real, not staged, and make the coverage banner
show both chip kinds.

| File | What it shows | Wireframe |
|---|---|---|
| `otel-demo-01-repo-otel-tab.png` | repo OTEL tab: coverage banner "OTEL for 2 of 4 sessions", chip, "Sessions with OTEL" tile | `2026-10-30-otel-tabs-traces/wireframes/repo-otel-tab.svg` |
| `otel-demo-02-session-otel-tab.png` | session OTEL tab: cost chart, sub-agents 33.5 % of cost | `session-otel-tab.svg` |
| `otel-demo-03-session-otel-trace.png` | the trace waterfall of a turn: llm_request, tools with blocked_on_user / execution, the Agent subtree | `session-otel-tab.svg` |
| `otel-demo-04-session-no-otel-unknown.png` | a session without OTEL: the reason panel, "excl. utility calls (no OTEL)" next to the cost | `wireframes/session-otel-tab-no-data.svg` (this task) |
| `otel-demo-05-team-otel-tab.png` | team OTEL tab: chart by person, coverage 7 / 18 with `unknown` and `not-configured` chips, cost structure, cost flow, people, repositories | `team-otel-tab.svg` |
| `otel-demo-07-help-architecture.png` | in-app help: the new "OTEL collection architecture" page with the wireframe images | — |
| `otel-demo-08-site-architecture.png`, `otel-demo-09-site-big-picture.png` | the same page on the built site, with the Mermaid diagrams | — |

Proxy mode (no UI): 14 OTLP requests (logs, traces, metrics) of one alice session reached her
collector with the `authorization` header; `receiver.log` has `forward signal=… status=200
dropped=0` and no header value anywhere in the logs.

Bugs found and fixed by this check:

1. The shared receiver never created a repo's `otelDir` — on a fresh install every OTEL record was
   dropped as `dir-gone`. Fixed in the receiver (created on authenticated register) and the
   installer (created at install); `s-hook-07`'s helper no longer pre-creates the folder.
2. With a collector on the generic endpoint, installing a second repo after `proxy` reset
   `forward.json` to `none`, losing the backup of the user's keys and stopping the forwarding.
   Fixed in `foreign-otel.ts` / `install.ts`; new step `P1b` in `s-inst-04`.
