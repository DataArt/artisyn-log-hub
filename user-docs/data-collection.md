# Data Collection & Upload

This article explains what data the hook collects from your Claude Code sessions, when it is
uploaded, and how the automatic post-turn analysis and session attributes work.

Everything happens in the background and is designed to never slow down or block your Claude Code
session. If an upload fails, your work is unaffected — the data stays on your machine and is
retried later.

---

## What is collected

The hook sends a lot of data to the server it is configured for. Read this before you install
it. The full description, per hook event, is in the "What is collected" section of the hook's own
README (`README.md` in the hook package).

**Full transcripts.**

- The complete Claude Code transcripts of the project, **including earlier sessions** of the same
  repository that are still on disk when the hook is installed.
- That means every prompt, every tool input and tool result, the contents of every file Claude
  read, and the output of every command Claude ran. Secrets that appeared in a session are
  uploaded with it.
- The hook does not redact transcripts.

**Local context.**

- `CLAUDE.md` files, rules, skills, agents and MCP server configuration of the project, plus the
  user-level skills, plugins and MCP configs that apply to it.
- The git remote URL (with any `user:password@` part removed) and git `user.name`.
- Absolute paths, including the project root and transcript paths, which usually contain your OS
  user name.
- `logTail`: the last 50 lines of the hook's own `hook.log`, sent with each upload for
  diagnostics.

**Other channels.**

- **Post-turn analysis.** When the server asks, the hook runs a local `claude -p` (cost advisor
  and session attribution) with your Claude Code account and sends the result — see
  [Post-turn analysis](#post-turn-analysis).
- **OTEL export.** The installer turns on Claude Code's OpenTelemetry export to a loopback
  receiver, with `OTEL_LOG_TOOL_DETAILS=1` (tool names and parameters). The hook uploads what it
  receives.
- **Code inventory.** The number of git-tracked files and lines (`trackedFiles`, `trackedLines`).
- **Session attribution.** A short classification of what the session was about.
- **MCP probe.** On each `Stop`, the hook starts each configured stdio MCP server briefly to list
  its tools, waiting at most `mcpProbeTimeoutMs` (default 3000 ms) per server.

**How to stop sending.** Remove `apiKey` from `.artisyn/config/log-hub.local.json` or `serverUrl`
from `.artisyn/config/log-hub.json`; the hook then records locally but uploads nothing. Or
uninstall the hook (`npx <server-origin>/static/artisyn-hooks-installer.tgz uninstall`).

**Who operates the server, retention and rights.**

- The data goes to whichever server `serverUrl` points at. Whoever runs that server (usually your
  employer or team) controls the data and is responsible for it. This project runs no hosted
  service and receives none of it.
- The server deletes sessions older than `SESSION_RETENTION_DAYS` (default 30). Users can delete
  their own account, which removes their data.
- Requests to access, correct or delete personal data go to the server operator.
- **Employers:** tell employees before you install the hook in their projects. Explain what is
  collected, who can see it and how long it is kept, and check that this fits your employment and
  data-protection rules.

See also the [Trust model](trust-model.md).

## What the hook uploads

The hook collects and uploads four kinds of data:

- **Session telemetry** — events recorded by the hook itself: each prompt you submit (including
  its text), timing of work periods, tool activity, permission requests, sub-agent activity,
  and session start/end. Each event also carries the repository URL, branch,
  and git user name, plus any custom context labels you configured. Credentials embedded in the
  git remote URL (for example `https://user:token@host/org/repo.git`) are stripped before
  upload — only `https://host/org/repo.git` is sent (hook 2.20.0 and later). When you work in a
  folder that is not a git repository, there is no repository URL to send, so the prompt and
  session-start events carry that folder's full local path (`cwd`) instead; the server uses it to
  group those sessions under a local repository tied to your account (hook 2.21.0 and later).
- **Claude Code transcripts** — the session logs Claude Code writes on your machine, uploaded
  exactly as they are, never modified. This includes every prompt, tool input and result, the
  contents of files Claude read and command output, and earlier sessions of the project that
  are still on disk. Transcripts are **not** redacted.
- **Sub-agent and workflow transcripts** — logs of agents spawned during the session, linked to
  their parent session so costs roll up correctly.
- **Claude Code metrics (optional)** — if the OpenTelemetry option is enabled, Claude Code's own
  usage metrics are captured locally and uploaded per session.

### Notice at install time

The hook installer (`artisyn-hooks` 1.0.66 and later) prints a **data collection notice** after
every successful install and upgrade. It names the server the hook will upload to and summarizes
what is sent — full transcripts, git metadata without credentials, project context and the
Claude Code OpenTelemetry records — before the next Claude Code session starts uploading. The
full list, and how to stop sending, is in [What is collected](#what-is-collected).

### Environment snapshot

Along with the session data, the hook reports a snapshot of your project's Claude setup, so the
server can analyze how your harness affects cost and behavior:

- Sizes of your CLAUDE.md files and the content of rule files
- The list of available skills and agents (names and descriptions)
- Skills your organization syncs to you (under `~/.claude/skills/synced/`): only their names,
  descriptions, sizes and paths, with the organization folder name masked — never the skill text
  (hook 2.28.0 and later)
- The git status of each project file in that list — `tracked`, `untracked`, `ignored` or
  `outside-repo` — just the status, no git output (hook 2.28.0 and later)
- Configured MCP servers and their available tools — any credentials found in server
  configuration are removed before upload
- The hook's own status: version, recent activity, any files that failed to upload, and
  configuration recommendations (this powers the "Installed Hooks" panel on the repository page)

The environment snapshot is sent at most once per session, and only when something changed since
the last report.

### When uploads happen

- **When you submit a prompt** — the current session's own data is uploaded in the background (at
  most once per minute), so long sessions stay up to date on the server while you work.
- **At the end of every assistant turn** — a full upload runs: the current session first, then
  any backlog from other sessions of the project.
- **When a session ends** — a final quick upload ships the session's last changes.

### How uploads work

- Data goes to the server address configured during hook installation, authenticated with your
  API key (stored in a gitignored local config file).
- Uploads are compressed, and large sessions are split into pieces — an interrupted upload
  resumes from where it stopped instead of starting over.
- The hook remembers what was already uploaded, so unchanged files are skipped and nothing is
  duplicated on the server.
- If something goes wrong, details are written to the hook's local log
  (`.artisyn/ai_work_dir/hook.log` in your project) and the upload is retried on the next trigger.

---

## Post-turn analysis

At the end of every assistant turn, the hook can run two automatic analyses in the background:
the **Turn-End Cost Advisor** and **AI Session Attribution**. Before doing anything, it asks the
server whether either feature is enabled for your repository — if not, nothing runs.

Both analyses are performed **on your own machine**, using your own Claude Code installation.
Your transcript is not sent anywhere extra for this — only the analysis *result* is uploaded.
These internal evaluation runs never appear in your session list and are never analyzed
themselves.

### Turn-End Cost Advisor

A short, LLM-generated summary of what drove the session's cost so far, with practical advice.

- **When it runs:** after every turn, once the feature is enabled for the repository (Settings →
  Analysis, where the minimum session cost can also be set).
- **What it looks at:** aggregate figures only — turn counts, work time, cost, model, context
  usage, tool and file-read statistics, which skills were invoked — plus a size-capped sample of
  your prompt texts.
- **What is uploaded:** the resulting summary (general assessment, cost factors, harness advice)
  and the cost of the evaluation itself.
- **Where you see it:** the Advisor panel in the session view, and the evaluation spend in the
  repository reports.

### AI Session Attribution (session attributes)

Automatic classification of each session against attributes your team defines — for example,
which ticket the session worked on or which development stages it covered.

- **What attributes are:** up to 12 per team repository, each with a name, a value type (Text,
  Text list, Yes/No, Number), and a short instruction telling the AI what to extract. The
  built-in defaults are **Jira Ticket**, **Workflow Stages**, and **Has Correction**. Attributes are
  configured by the team owner in Settings → Session Attribution; the feature is on by default
  for team repositories.
- **When it runs:** after a turn, but only when the session has new prompts since its last
  evaluation — nothing is re-evaluated without new activity. After three failed attempts in a row
  the hook stops retrying that session until the attribute definitions change or an attempt
  succeeds.
- **What it looks at:** the attribute definitions, the list of files changed in the session,
  which skills were invoked, and the same size-capped sample of your prompt texts.
- **What is uploaded:** one value per attribute (or "unknown" when it can't be determined) and
  the cost of the evaluation itself. If results arrive out of order, the server keeps the most
  recent evaluation — newer data is never overwritten by an older result.
- **Where you see it:** attribute chips on sessions in the session list, the attribute filter
  above the list, attribute-filtered analytics reports, and the Attribution Spend section showing
  what the evaluations themselves cost.

### Troubleshooting

Both analyses write their activity to local logs in your project:
`.artisyn/ai_work_dir/analysis.log` (advisor) and `.artisyn/ai_work_dir/attribution.log`
(attribution). Advanced options (model choice, timeouts) can be adjusted in the hook's
configuration file — see the hook installation guide.
