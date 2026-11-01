---
type: "Installation Guide"
title: "Hook Installation Guide"
description: "Install, upgrade, or uninstall the hook as a Claude Code plugin via npx, the JSON config reference, the per-user OTEL port and state (~/.artisyn/otel), the user-scope OTEL keys in ~/.claude/settings.json with validation and backup, the .claude/settings.local.json mirror and resource attributes, the foreign-collector proxy/keep/replace flow, managed settings, migration from the pre-plugin install, and verification steps."
tags:
  - hooks
  - otel
timestamp: "2026-10-31T00:00:00+04:00"
---

# Hook Installation Guide

The hook ships as a **Claude Code plugin** (`log-hub-hooks`) served from a project-local marketplace (`artisyn`)
under `.artisyn/marketplace/`. Configuration lives in JSON files under `.artisyn/config/`. There is no manual
file-copying or `.claude/settings.json` hand-editing step.

Prerequisites:
- Node.js in PATH — any current LTS release (the user-facing promise in `hook/INSTALL_HOOK.md`; the
  technical floor is `engines >=18.19`). The hook runs with the user's own `node`; see the
  "Runs on every current Node.js LTS" principle in [hook-system-overview.md](hook-system-overview.md)
- Git installed; project must be a git repository
- Claude Code with plugin support on `PATH` (the installer shells out to `claude plugin marketplace add` /
  `claude plugin install`)
- An API key from artisyn-log-hub (API Keys page → API Keys tab → Generate)

---

## Install

Run from the project root:

```sh
npx <server-origin>/static/artisyn-hooks-installer.tgz install
```

Where `<server-origin>` is the base URL of your artisyn-log-hub instance (e.g. `http://localhost:3000`). The API
Keys page (Install tab) shows the exact command pre-filled with the correct origin.

### Optional CLI flags

| Flag | Description |
|---|---|
| `--server-url <url>` | Writes `serverUrl` into the gitignored `.artisyn/config/log-hub.local.json` (installer `1.0.75`+; never changes `serverUrl` in the tracked `log-hub.json`). Trailing slash stripped automatically. |
| `--api-key <key>` | Writes `apiKey` into `.artisyn/config/log-hub.local.json` (never into the tracked `log-hub.json`). Prints a warning that the key will be visible in shell history. |
| `--otel-port <n>` | Pins the loopback port of the **per-user** OTEL receiver (integer `1`-`65535`; anything else is a hard `exit 1`). Installer for hook `2.30.0`+: one receiver serves every repo of the OS user, so it rewrites `~/.artisyn/otel/port.json`, the endpoints in `~/.claude/settings.json`, the `.claude/settings.local.json` mirror and `otelReceiverPort` of **every** repo in `repos.json`, then prints "restart Claude Code". Use it to move off a colliding port — see "OTEL settings" below. `install` only; `upgrade` and `uninstall` reject it alongside `--server-url`/`--api-key`. (Before `2.30.0` it pinned this project's own port.) |
| `--otel-existing=proxy\|keep\|replace` | Installer for hook `2.30.0`+. Answers the foreign-collector question when Claude Code already exports OTEL elsewhere (user settings or process env): `proxy` — the Log Hub receiver forwards everything unchanged to your collector (OTLP/HTTP JSON only); `keep` — your collector stays, the OTEL tabs stay empty; `replace` — data goes only to Log Hub. Without the flag: the stored choice when your collector settings are unchanged, else a TTY prompt, else `keep`. `install` and `upgrade`; `uninstall` rejects it. See "Foreign collector" below. |
| `--restart-otel-receiver` | Installer for hook `2.30.0`+. An action of its own (no subcommand, no other option): an authenticated `POST /artisyn/shutdown` to the per-user receiver, then a wait until its port is free. The next Claude Code session starts it again from the installed code. Exit 1 when `port.json` is missing or the receiver could not be stopped. |
| `--otel-traces=yes\|no` | Answers the trace question (installer for hook `2.29.0`+): `yes` adds the three trace keys to the `env` block, `no` writes none of them (and strips owned ones). Stored as `otelTraces` in `log-hub.json`. Without the flag a TTY run asks `Also export Claude Code traces (enhanced telemetry beta) to Log Hub? [Y/n]` and a non-TTY run means yes. Any other value is a hard `exit 1`. `install` only; `upgrade` and `uninstall` reject it. See "Trace keys" below. |
| `--help` | Prints usage and exits. |

**Reinstall behavior**: an omitted flag preserves the previously configured value; a provided flag always wins.
Unrecognized keys already present in either JSON file survive reinstall untouched.

**Full Auto Install** — the API Keys page → Install tab has a "Full Auto Install" card with both flags pre-filled
(server URL from the browser location, API key generated on demand):

```sh
npx "<server-origin>/static/artisyn-hooks-installer.tgz" install --server-url "<server-origin>" --api-key "<your-api-key>"
```

**What `install` does, in order:**
1. Validates `.git/` exists — exits 1 if not.
2. Validates `.claude/` exists — prompts `Create it now? [Y/n]` if missing.
3. Extracts the `.artisyn/marketplace/` plugin tree bundled in the installer tarball (no network call here) and
   renames the marketplace to this repo's own name (see "Per-repo marketplace name" below).
4. Resolves the **per-user** OTEL receiver port (`--otel-port` → `~/.artisyn/otel/port.json` → allocate),
   persists it to `port.json`, creates `~/.artisyn/otel/token` when missing and deletes the legacy
   `.artisyn/config/otel-port.json` (installer for hook `2.30.0`+; older installers kept a per-project port
   there). Before any file is touched it also resolves the OTEL plan: managed settings, then the
   foreign-collector choice. See "OTEL settings" below.
5. Writes/merges `.artisyn/config/log-hub.json` (shared, non-per-developer settings; a legacy `otelReceiverPort`
   in it is removed) and `.artisyn/config/log-hub.local.json` — always written (installer `1.0.75`+): it gets
   `otelReceiverPort` (always overwritten from the resolved port) plus `serverUrl`/`apiKey` when the flags are given.
6. Ensures `log-hub.local.json` is git-ignored (`.artisyn/config/.gitignore`) on every install; hard-aborts with a
   remediation message if it's already tracked by git.
7. Upserts this repo's entry in `~/.artisyn/otel/repos.json`, copies the receiver to `~/.artisyn/otel/bin/`,
   writes the OTEL keys into the user-scope `~/.claude/settings.json` (validated first, `.artisyn-bak` copy —
   see "User-scope OTEL keys" below; skipped when OTEL is managed), then merges the nine-key OTEL `env` block
   (twelve keys when the trace answer is yes) plus `OTEL_RESOURCE_ATTRIBUTES` into the gitignored
   `.claude/settings.local.json` mirror (created when absent, `.claude/settings.local.json.bak` written first;
   installer `1.0.72`+ — see "The `.claude/settings.local.json` `env` block" below), then merges `enabledPlugins["log-hub-hooks@artisyn-<hash>"] = true` and
   `extraKnownMarketplaces["artisyn-<hash>"].source.path = "./.artisyn/marketplace"` into `.claude/settings.json` —
   every other key (including hooks you wired yourself) is preserved; `.claude/settings.json.bak` is written first.
8. Runs `claude plugin marketplace add ./.artisyn/marketplace` then
   `claude plugin install log-hub-hooks@artisyn-<hash> --scope project`. **This step is required** — declaring the two
   settings keys alone does not register or cache the plugin, so no hook fires without it. A failure here (e.g.
   `claude` not on `PATH`) is non-fatal: a warning prints both exact commands to run manually, in order.
9. Runs the OTEL receiver smoke test — since hook `2.30.0` the shared handshake (`verifyInstalledReceiver`):
   a hello with proof check against the receiver on the shared port, spawning `~/.artisyn/otel/bin/otel-receiver.js`
   with the shared argv when none answers, then an authenticated `session-status`. A listener that fails the
   proof is reported as "not this user's Log Hub receiver". Required but non-fatal, like step 8: on failure it
   prints the exact foreground command to reproduce the problem, and never re-allocates the port. (Older
   installers spawned a per-project receiver into a temp directory and POSTed a synthetic `/artisyn/register`.)
   Before it (installer `1.0.78`+ / hook `2.24.2`+), the **hook load check**: every script the installed
   `hooks/hooks.json` runs is started exactly the way Claude Code starts it — `node` from `PATH`, cwd = the
   project — with `--self-check` (`exitIfSelfCheck` in `hook-log.js`, called by each entry script right after
   its top-level requires: prints `{"selfCheck":"ok",…}` and exits 0 without reading stdin or writing a file).
   It catches what kills every hook before it can log a line: the project's `package.json` `"type": "module"`
   (the plugin pins CommonJS with its own `scripts/package.json`), no `node` on `PATH`, a Node too old for
   the hook, a missing file. Success prints `✓ Hook scripts load with node <version> (n/n)`; a failure names
   each script with its exit code and error line plus a `node "<script>" --self-check` command to reproduce.
   Same required-but-non-fatal contract as the receiver check (`verifyHookScriptsLoad` in `install.ts`).
10. If a pre-plugin install is detected, migrates it automatically (see below).
11. Prints the summary. When the hook load check or the receiver check failed, the headline is
    `⚠ Hooks installed (hooks vX), but they are not working in this project yet:` with one line per
    problem, and `Hooks are configured, but not working yet …` replaces `Hooks are fully configured and
    ready to use.` (`upgrade` prints the same headline). The exit code stays `0`: the files are in place, and
    scripts that run the installer must not break on a diagnosis.

**Per-repo marketplace name** (installer `1.0.69`+). `claude plugin marketplace add` registers a marketplace by
its `marketplace.json` name at the **user** level (`known_marketplaces.json`, the user `settings.json`,
`plugins/cache/<name>/`). With the single shared name `artisyn` every repo of a user re-pointed that one
registration at itself — the last installed repo won and all of them shared one plugin cache (found by the big
pre-prod e2e test, five repos of one user). So each repo now gets `artisyn-<8 hex>`: the first 8 hex of the
SHA-256 of the normalised `origin` URL (`resolveMarketplaceName` / `normalizeRemoteUrl` in
`artisyn-hooks-installer/src/install.ts`; `git@host:org/repo.git`, `https://user@host/org/repo/` → `host/org/repo`,
so every clone and teammate derives the same name and the committed settings keys agree), or of the checkout path
without an `origin`. A per-repo name already in `marketplace.json` is reused, so a changed remote does not rename
it. The archive still ships `artisyn`; the installer rewrites `"name"` after extraction.

Legacy migration (install/upgrade): `extraKnownMarketplaces.artisyn` that points at `./.artisyn/marketplace` is
dropped, and `<plugin>@artisyn` keys of `log-hub-hooks` and of every other plugin listed in this marketplace move to
`<plugin>@artisyn-<hash>` with their value (a disabled `log-hub-hooks` is then re-enabled with the usual Note). The
user-level `artisyn` registration is left alone — other repos not yet upgraded still load through it. The
user-level collision warning fires only when the repo's name is registered for a *different* directory (a second
checkout of the same repo). This repo's own dogfooded install (`log-hub-hooks@artisyn`, `adlc-lh@artisyn`) is
still on the legacy name and migrates on its next installer run.

---

## Upgrade

```sh
npx <server-origin>/static/artisyn-hooks-installer.tgz upgrade
```

Pre-filled on the API Keys page's "Upgrade Hooks" card. `upgrade` takes no `--server-url`/`--api-key` flags — the
already-configured values are read from `.artisyn/config/log-hub*.json`. It re-extracts the plugin tree, re-runs
the `claude plugin marketplace add` / `claude plugin install` sequence (both are no-ops when already
registered/installed at the same version), and prints `Previous version:` / `New version:` lines. Both versions are
read from the hook itself (the installed plugin before, the bundled plugin after), never from the installer
package's own version, and the archive is applied through the same `applyHooksUpdate` path `install` uses. If a
pre-plugin install is detected, `upgrade` performs the same migration `install` does and does not require
`.claude/telemetry_tool/version.json` to exist. Running `upgrade` a second time with nothing to do is a no-op.

`upgrade` also resolves/allocates the OTEL port and writes the user-scope keys and the `env` block exactly as
`install` does — this is the only route by which an already-installed project starts receiving OTEL, and the
route that moves the keys out of `.claude/settings.json` and rewrites a stale Artisyn endpoint, so it deliberately
shares that code path. It takes `--otel-existing=` like `install`.

**Upgrade from the per-project receiver** (hook `2.30.0`, DD-25, AC-A9). An existing `~/.artisyn/otel/port.json`
is reused, so upgrading never moves the shared port; the first upgraded repo of a user allocates it. The upgrade
writes the shared port into `otelReceiverPort` (`log-hub.local.json`), the user file and the local mirror,
**deletes** `.artisyn/config/otel-port.json`, and does **not** stop the old per-project receiver
(`stopExistingReceiverIfRunning` is no longer called): it keeps its old port, receives nothing new and idle-exits.
The old per-project port stays "owned" for this run (`readRecordedOtelPorts`), so the endpoints that still point at
it are rewritten as stale. The trace
answer (hook `2.29.0`+) comes from the stored `otelTraces` in `log-hub.json` without asking; an install that
predates the question gets the TTY `[Y/n]` prompt once (non-TTY: yes), and the answer is stored. After the
success lines `upgrade` always prints
`Note: Claude Code sessions that are already running keep their old OTEL endpoint until restarted.` — a running
session's exporter does not pick up a rewritten endpoint.

---

## Uninstall

```sh
npx <server-origin>/static/artisyn-hooks-installer.tgz uninstall
```

Removes `.artisyn/marketplace/` and `.artisyn/config/` (both JSON files plus a legacy `otel-port.json`), and surgically
removes `enabledPlugins["log-hub-hooks@artisyn-<hash>"]` / `extraKnownMarketplaces["artisyn-<hash>"]` (and the same
keys under the legacy `artisyn` name) from `.claude/settings.json`, leaving every other setting untouched.

**Other plugins in this repo's marketplace** (installer `1.0.65`+). A project may keep its own plugin next to
`log-hub-hooks` — this repo ships `adlc-lh` in `.artisyn/marketplace/plugins/adlc-lh/`, listed in
`marketplace.json`. The archive's `marketplace.json` lists only `log-hub-hooks`, so install/upgrade reads every
other entry before extraction and merges it back afterwards (`readForeignMarketplacePlugins` /
`restoreForeignMarketplacePlugins` in `artisyn-hooks-installer/src/install.ts`); their folders are never touched,
since extraction only writes `plugins/log-hub-hooks/`. While another entry is listed, `uninstall` deletes only
`plugins/log-hub-hooks/` and its entry and keeps `extraKnownMarketplaces["artisyn-<hash>"]`. An installer older than `1.0.65`
still overwrites `marketplace.json` (dropping the foreign entries) and `uninstall` deletes the whole
`.artisyn/marketplace/`.

The nine OTEL `env` keys (and the three trace keys) are removed too, **per key and per file**, from both `.claude/settings.json` (legacy
location) and `.claude/settings.local.json` (`removeOtelEnvKeys` in `artisyn-hooks-installer/src/install.ts`,
installer `1.0.72`+). The recorded ports are read before `.artisyn/config/` is deleted, and each key is removed only
while it is Artisyn-owned by the ownership rule in "The `.claude/settings.local.json` `env` block" below, judged on
that file's `env` as read. So a collector of your own survives: an endpoint you repointed (non-loopback, or a
loopback port outside the Artisyn range) stays, together with the exporter/protocol keys in the same file, and a
`Note: .claude/<file> env.<KEY> is "<value>", which is not an Artisyn loopback receiver — leaving it untouched.`
line names it. A file is rewritten (after its `.bak`) only when at least one key was removed and is never deleted;
an `env` block left empty by the removal is dropped entirely. `settings.local.json` is cleaned whether or not
`settings.json` exists.

**Per-user OTEL state** (installer for hook `2.30.0`+, DD-27, AC-B2). `uninstall` removes this repo's entry from
`~/.artisyn/otel/repos.json`. While other repos remain, nothing else changes there and it prints
`Kept the per-user OTEL receiver and the OTEL keys in ~/.claude/settings.json — <n> other repo(s) still use them.`
Removing the **last** entry (`removeUserOtelState`):

- restores the `forward.json.original` keys (and `otelHeadersHelper`) in the user file exactly, in the order
  `original.envOrder` recorded (so a proxy-then-uninstall leaves the file byte-identical), removes the
  Artisyn-owned OTEL keys, `_artisynOtel` and the user-level SessionStart hook entry (`restoreUserOtel`,
  `withUserEnsureHook`); the write is validated and backed up like every other user-file write;
- stops the shared receiver (authenticated shutdown, then the port wait);
- unlinks the listed state files one by one (`port.json`, `token`, `repos.json`, `registry.json`,
  `forward.json`, `receiver.log`, `claude-version.json` and the three `bin/` files), then `rmdir`s `bin/` and
  `otel/` **non-recursively** — a folder holding anything Log Hub did not create is kept and named.

`~/.claude/settings.json.artisyn-bak` is kept: it is the user's safety copy, and the message names it.

If a leftover file can't be deleted (locked by an editor or a running hook), the
settings-key removal still succeeds and is reported; a warning names the leftover path and the next
install/upgrade/uninstall run retries the delete.

---

## Migrating from the pre-plugin install

`install` and `upgrade` both detect a pre-plugin install — `.claude/telemetry_tool/.env` present, or
installer-authored entries in `.claude/settings.json`'s `hooks` block — and migrate automatically, in this order:

1. **Convert config**: `.env`/`.env.local` → `.artisyn/config/log-hub.json` / `log-hub.local.json`. If
   `log-hub.json` already exists, it's authoritative — conversion only fills keys absent from it (same rule for
   `.local.json`/`apiKey`); `--server-url`/`--api-key` flags still win over both files. `CTX_*` variables collapse
   into the `context` array. The written files are re-read to confirm they parse before continuing.
2. **Rewrite settings**: remove only the installer-authored `hooks` entries from `.claude/settings.json` (matched
   by command path — any hook entry you added yourself, even inside the same matcher, is left byte-identical), and
   write the `enabledPlugins`/`extraKnownMarketplaces` keys — one read-modify-write, one `.claude/settings.json.bak`.
3. **Activate the plugin**: `claude plugin marketplace add` / `claude plugin install`, same as a fresh install
   (non-fatal on failure).
4. **Delete the legacy directory**: `.claude/telemetry_tool/` is removed. If deletion fails (e.g. a Windows file
   lock), migration is still reported successful with a warning naming the leftover directory — retried on the
   next run.

Telemetry hook entries found in `.claude/settings.local.json` or the user-level `~/.claude/settings.json` are never
rewritten — only reported: `Warning: telemetry hooks also found in <file> — remove them or events will be recorded
twice.`

A `.claude/settings.json` that fails to parse aborts the whole run with
`Error: .claude/settings.json is not valid JSON - fix it and re-run`, leaving the file untouched (no silent `{}`
fallback). The same rule applies to `.claude/settings.local.json`, which the installer now also writes (the OTEL
`env` block): `Error: .claude/settings.local.json is not valid JSON - fix it and re-run`.

Migrating twice changes nothing the second time — idempotent by design.

---

## Configuration Reference

Config lives in two project-local JSON files, resolved from the git repo root:

- `.artisyn/config/log-hub.json` — tracked, non-secret settings shared by every checkout.
- `.artisyn/config/log-hub.local.json` — gitignored per-developer settings: `apiKey`, `serverUrl`,
  `otelReceiverPort`. Overrides `log-hub.json` per top-level key (whole-value replacement — arrays are replaced,
  not merged). `null` in the local file means "absent", falling through to the base value. Written by every
  install (installer `1.0.75`+; older installers put `serverUrl`/`otelReceiverPort` into `log-hub.json`, which
  still works — a `serverUrl` already in the tracked file stays as a fallback).

A missing file uses defaults silently. Unparseable JSON or a non-object root falls back to defaults for every key
it would have contributed, plus one `[warn]` line in `.artisyn/ai_work_dir/hook.log`. A key whose value is `null`
uses that key's default silently, like an absent key. A single wrong-typed value falls back to just that key's
default, plus one `[warn]` line naming the file and key (`env-context.js`).

**Plugin manifests are generated, not authored.** `marketplace.json`, the plugin's `.claude-plugin/plugin.json`
and `hooks/hooks.json` are written by `scripts/build-hooks-installer.js` (`npm run build:hooks-installer`) from
`hook/`. `hook/` is the only source of the hook scripts; the plugin version comes from
`hook/.claude/telemetry_tool/version.json`. The build also checks the `hooks.json` event names against
`hook/INSTALL_HOOK.md` and fails on a mismatch.

### Required

| Key | File | Description |
|---|---|---|
| `serverUrl` | `log-hub.local.json` (a shared value in `log-hub.json` also works) | Base URL of artisyn-log-hub (`http://host:3000`) |
| `apiKey` | `log-hub.local.json` | API key from artisyn-log-hub |

### Context Metadata

| Key | Default | Description |
|---|---|---|
| `context` | `[]` | Array of `{key, value}` pairs attached to every event as `context.<key>`. Keys lowercased; last entry wins on duplicates; absent/empty → no `context` field. |

### Telemetry Storage

| Key | Default | Description |
|---|---|---|
| `telemetryDir` | `""` | Where JSONL event files are written. Absolute or relative to repo root; empty → `<repo-root>/.artisyn/ai_work_dir/telemetry`. |
| `jsonCompact` | `false` | Write JSONL without pretty-printing. |

### Guardrail keys (compatibility rules)

The hook has no `PreToolUse` guardrail (it is absent from hook `2.19.0` on). Hook `2.27.0` registers a `PreToolUse`
entry again (matcher `PowerShell`, `tool-wrap-powershell.js`), but it only wraps a PowerShell command that mentions a
monitored CLI tool with a logging prefix (`updatedInput`); it never denies a call and reads no `guardrail*` key — see
"CLI Tool Wrapper" below. The `guardrail*` keys
(`guardrailEnabled`, `guardrailBlockOutsideProject`, `guardrailProhibitedFiles`, `guardrailLlm*`,
`guardrailBlockNetwork`, `guardrailMaxScriptSizeKb`) are therefore not configuration of the current hook, and these
rules apply to them:

- The installer never writes `guardrail*` keys and never converts `GUARDRAIL_*` variables from a legacy `.env`.
- The installer never touches `guardrail*` keys already present in `log-hub.json`: an older hook that still reads
  them would otherwise fall back to its guardrail-on defaults.
- `applyHooksUpdate` deletes the obsolete `scripts/guardrail-hook.js` and `docs/GUARDRAIL_SETTINGS.md` from the
  installed plugin after extraction (`removeObsoletePluginFiles` in `artisyn-hooks-installer/src/install.ts`).

### Upload Settings

| Key | Default | Description |
|---|---|---|
| `sendLogsTimeoutMs` | `10000` | HTTP timeout for log upload requests |
| `sendLogsOnPromptEnabled` | `true` | Gates whether `UserPromptSubmit` also spawns a detached, scoped background upload of the current session's files. `false` disables prompt-triggered uploads entirely; the Stop/Interrupt-triggered full upload (`send-logs-hook.js`) is unaffected either way. |
| `sendLogsOnPromptTimeoutMs` | `60000` | Watchdog timeout (ms) for the prompt-triggered background upload (`prompt-upload-hook.js`); the process force-exits if it hasn't finished by then. Also drives the shared upload-lock's staleness window (`2x` this value) used to keep the prompt-triggered and Stop-triggered upload paths mutually exclusive. |

Two fixed limits on the upload side are not config keys:

- **40 MB payload warning.** When one upload body (a session file plus its prepended synthetic events) is larger
  than 40 MB, `send-logs-hook.js` writes a `warn` line to `hook.log` and to stderr naming the size, then uploads it
  anyway. It is a signal, not a cap: bodies above `CHUNK_SIZE_BYTES` go through the chunked path, and the server's
  limits are per route (see `hook-api-versioning.md`) and per repository (`repositories.max_upload_bytes`).
- **Plugin resolution for the harness snapshot (hook `2.22.0`+, DD-4).** The catalog the hook
  uploads (as part of the `harness-snapshot` line — see `docs/knowledgebase/hook-system-overview.md`'s
  "Context injection") no longer does a recursive, depth-bounded scan of `~/.claude/plugins/`.
  Instead, for each `<name>@<marketplace>` left enabled after merging `enabledPlugins` from
  `<claudeConfigDir>/settings.json`, the project's own `.claude/settings.json`, then
  `.claude/settings.local.json` (a later file's `false` disables an earlier `true`),
  `skill-catalog.js` resolves the plugin's actual install location from
  `<claudeConfigDir>/plugins/installed_plugins.json` (v2): it picks the first `plugins["<id>"]`
  entry that matches, in order, a `local`-scope entry whose `projectPath` matches this project, a
  `project`-scope entry whose `projectPath` matches, then a `user`-scope entry — and reads only
  that entry's `installPath`. There is no depth limit and no `PLUGIN_SKILL_MAX_DEPTH` env var any
  more; a plugin enabled but not resolvable this way is skipped with one `hook.log` line
  (`harness: plugin <id> enabled but not installed for this project — skipped`), never a scan
  failure. Project skills still win over user and plugin skills of the same name.

### OKF Knowledge-Base Snapshot (hook `2.26.0`+)

| Key | Default | Description |
|---|---|---|
| `okf` | `{"exclude": []}` | Object. `okf.exclude` is an array of repo-relative globs (`**` any depth, `*` and `?` inside one path segment) whose files and folders are never scanned for OKF bundles (folders whose `index.md` front matter has an `okf_version:` key). `tmp/**` is always excluded on top of the list, so a user list can never remove it. A non-array `exclude` is ignored with one `[warn]` line; blank or non-string entries are dropped; other sub-keys are kept as they are. |

- **Merge.** Like every top-level key, `log-hub.local.json`'s `okf` replaces `log-hub.json`'s whole
  object (shallow merge) — the two `exclude` lists are **not** concatenated. Example:
  `{"okf": {"exclude": ["vendor/**", "docs/archive/**"]}}`.
- **What it drives.** On every root-session `artisyn` upload `send-logs-hook.js` detects the
  bundles, flags gitignored files with one `git check-ignore` call, and sends the
  `okf-snapshot-ref` line (plus the full `okf-snapshot` line once per distinct KB state, tracked in
  `.artisyn/ai_work_dir/okf-state.json`). Rules: `docs/knowledgebase/algorithms/okf-snapshot.md`;
  wire contract: `hook-api-versioning.md`; what the server shows: `okf-usage.md`.
- **Excluding vs ignoring.** An excluded folder is not in the snapshot at all; a gitignored one is
  in it, flagged `ignored`, and hidden from every team view (but visible to its owner).
- **`hook.log` lines.** `okf: snapshot <id12> sent` / `known` / `unknown on server — will resend`;
  `okf-snapshot: detection took N ms …` when over 300 ms; `okf-snapshot: N KB files exceed the
  20000 cap — no snapshot sent`; `okf: snapshot skipped (…)` on any failure (the upload still goes
  out).
- An older hook ignores the key; this hook ignores unknown sub-keys.

### CLI Tool Wrapper (hook `2.27.0`+)

| Key | Default | Description |
|---|---|---|
| `toolWrap` | `true` | Local kill switch of the CLI tool wrapper (Tools/MCP tab). `false` — like the environment variable `LOGHUB_TOOL_WRAP=0` — turns it off for this checkout: `SessionStart` puts no shims on `PATH`, the `PreToolUse` PowerShell entry never rewrites a command, and no new wrapper records (so no new `tool-calls` log) are produced. The list of monitored tools is configured in the UI (Repository → Settings → Monitored Tools), never here. An older hook ignores the key. |
| `toolWrapConfigTimeoutMs` | `2000` | HTTP timeout (ms) of the monitored-tools fetch `GET /api/v2/tool-monitoring/config` — synchronous at `SessionStart`, at most once a minute on `UserPromptSubmit` (there capped at 1000 ms). On a timeout, a non-200 answer (an old server answers 404) or any error the hook keeps its cached `<workDir>/tool-wrap/config-cache.json`; without a cache nothing is wrapped. Fail open: it never blocks a session. |

- **Third kill switch.** "Pause all wrapping" in the UI's Monitored Tools settings tab reaches the hook as `paused: true`
  in the config: a new session wraps nothing, a running one gets the `off/__all` marker on the next refresh.
- **`hook.log` lines.** `lifecycle-hook.js`: `tool-wrap: wrapping <tools>` / `tool-wrap skipped: <reason>` /
  `[warn] tool-wrap pre-flight failed: <reason>; Bash tool calls are not wrapped this session`;
  `telemetry-hook.js`: `tool-wrap config refreshed (…)` / `tool-wrap config refresh: no config (kept cache)`.
- **Files.** Everything lives under `<workDir>/tool-wrap/` (`.artisyn/ai_work_dir/tool-wrap/`): the config cache, one
  folder per session (shims, per-call records and captured text, markers, breaker, `preflight.json`) and the
  assembled `upload/<sessionId>.jsonl`. Session folders older than 7 days are pruned at `SessionStart`.

How the wrapper works and what the server does with its records: [tool-monitoring.md](tool-monitoring.md).

### OTEL Settings

Hook `2.3.0`+ (the last three rows: `2.29.0`+). These eight keys live in `.artisyn/config/log-hub.json` like every other non-secret setting —
except `otelReceiverPort`, which is per checkout and goes to the gitignored `log-hub.local.json` (installer
`1.0.75`+).
See `docs/knowledgebase/otel-receiver.md` for what they gate.

| Key | Default | Description |
|---|---|---|
| `otelEnabled` | `true` | Runtime switch. Gates the receiver spawn, the register handshake, and the `claude-otel` upload + prune pass. See the caveat below — this does **not** stop Claude Code from exporting. |
| `otelReceiverPort` | `0` | The receiver port, written by the installer from `~/.artisyn/otel/port.json` on every run (hook `2.30.0`+: the shared per-user port; before: this project's own port). A `2.30.0` hook reads it only in the legacy fallback when `port.json` is missing; hooks `≤ 2.29.0` always read it. `0` means "not yet allocated"; hand-editing is pointless (re-install with `--otel-port` instead). If it somehow never got a value, `OTEL_FALLBACK_PORT` (`25317`) applies. |
| `otelReceiverIdleTimeoutMs` | `600000` | No request of any kind for this long ⇒ the receiver exits (10 min). `0` means "use the default". Legacy per-project receiver only: the shared receiver always uses the fixed `SHARED_IDLE_TIMEOUT_MS` (600000), because no single repo owns it. |
| `otelReceiverMaxBodyKb` | `8192` | Request bodies above this are rejected (`413`) without writing. **KiB**, converted to bytes by the spawning hook (`8192` → `8388608`). Applies to wire bytes, before decompression. `0` means "use the default". |
| `otelRetentionDays` | `7` | `<telemetryDir>/otel/*.jsonl` older than this (by mtime) are deleted on a later `Stop` run. `0` means "use the default". See `docs/knowledgebase/data-retention.md`. |
| `otelRealtime` | `true` | Hook `2.29.0`+. The receiver's realtime channel: it forwards the session's OTEL logs and spans to `POST /api/v2/otel-realtime` while the session runs, so the OTEL tabs update live. `false` turns it off; chunks still upload at each turn end, so the tabs update after each turn. Read by the receiver itself (`readRealtimeTarget`), re-read on a config mtime change. See [otel-receiver.md](otel-receiver.md) § "Realtime sender". |
| `otelRealtimeIntervalMs` | `5000` | Hook `2.29.0`+. Smallest gap between two realtime POSTs of one session; clamped to at least `5000`. The server's `minIntervalMs` answer can only raise it. |
| `otelTraces` | absent | Hook `2.29.0`+. The installer's stored answer to the trace question (`true` / `false`); absent on installs that predate it. `otel-endpoint-check.js` checks `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` only when it is `true`. Change it by re-running `install --otel-traces=yes\|no` (editing it by hand does not add or remove the `env` keys). |

**`otelEnabled: false` is runtime-only.** It stops the hook from spawning the receiver, registering, uploading and
pruning — but it does **not** retract the `env` block from `.claude/settings.local.json`, so Claude Code keeps
exporting to a port nothing listens on. That is harmless by design: the port is a random high one (below), so there
is no realistic chance of it later colliding with a collector of your own on `4317`/`4318`. To disable OTEL fully,
set `otelEnabled: false` **and** remove the nine (twelve with traces) `env` keys, or just run `uninstall`. Since
hook `2.30.0` the user-scope keys in `~/.claude/settings.json` serve every repo of the user and stay until the last
repo is uninstalled.

#### Port allocation

A fixed default port would be wrong twice over — `4318` collides with the user's own collector, and any fixed
choice is a guess. So the installer allocates a **random port** out of `[25000, 65535]` — since hook `2.30.0`
**one per OS user** (`resolveSharedOtelPort` in `install.ts`), because Claude Code `2.1.282`+ reads the OTEL
endpoint only from user (or managed) settings, which are per user. Before `2.30.0` it was one per project.

Resolution order at install time, first match wins:

1. `--otel-port <n>` — explicit operator override; rewrites `port.json` and moves every installed repo (see the
   flag above).
2. `port` from `~/.artisyn/otel/port.json` (`{version:1, port, allocatedAt}`), if a usable port — this is what
   makes the port stable across reinstalls, upgrades and repos.
3. Allocate, then persist to `port.json`.

Allocation walks the 40536-slot range with a prime-step (`7919`) open-addressing probe from a random origin, so it
visits every port exactly once before repeating and consecutive probes land far apart. Each candidate must pass
**two** checks before anything touches disk: a bind probe, *and* a full loopback HTTP round-trip (which catches a
local proxy or security product intercepting loopback, or an IPv4/IPv6 binding mismatch that a bind probe alone
would miss).

**`~/.artisyn/otel/port.json`** is the authoritative record and lives outside every repo, so it is never committed
and never inherited by a teammate. `log-hub.local.json`'s `otelReceiverPort` is an **output** of it, never an input
(installer `1.0.75`+ for the local file; older installers wrote it into the tracked `log-hub.json`, and the next
install removes it from there). The legacy per-project record `.artisyn/config/otel-port.json` is deleted on every
install and upgrade.

The rest of the per-user state dir (`token`, `repos.json`, `registry.json`, `forward.json`, `receiver.log`,
`claude-version.json`, `bin/`) is described in [otel-receiver.md](otel-receiver.md) § "User-level state".
`repos.json` gets one entry per installed repo: `{repoKey, gitRoot, otelDir, uploader, traces, installedAt,
hookVersion}` (`upsertRepoEntry` in `user-state.ts`); the receiver uses it to route records that carry an
`artisyn.repo` tag before their session registered.

A port held by another program or another OS user is detected, not repaired: the hook's hello fails the HMAC proof
and it writes one `otel port-conflict port=<n>` warning (the session's OTEL status then says `receiver-down`), and
the installer's receiver check names it. Re-install with `--otel-port <n>`. For legacy per-project receivers the
`409 owner-mismatch` guard still applies — see [otel-receiver.md](otel-receiver.md).

#### The `.claude/settings.local.json` `env` block

Claude Code exposes a settings `env` block to the session as real environment variables, which is how its OTLP
exporter is pointed at the local receiver (and how the hook learns the endpoint the exporter actually uses). Since
hook `2.30.0` the authoritative copy is the user-scope file (see "User-scope OTEL keys" below); the project-local
block described here is the **mirror** for Claude Code versions before `2.1.282`, which still read project scope
and where a local value would otherwise shadow the user one. It points at the same shared port. The
installer (`1.0.72`+) writes these nine keys — twelve with the trace keys (hook `2.29.0`+, "Trace keys" below) —
into the **gitignored `.claude/settings.local.json`**, with `<port>`
substituted from the resolution above. Older installers wrote them into the committed `.claude/settings.json`; the
next `install`/`upgrade` moves them (see "Migration from `.claude/settings.json`" below).

| Key | Value |
|---|---|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `"1"` |
| `OTEL_LOGS_EXPORTER` | `"otlp"` |
| `OTEL_METRICS_EXPORTER` | `"otlp"` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `"http/json"` |
| `OTEL_EXPORTER_OTLP_COMPRESSION` | `"none"` |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | `"http://127.0.0.1:<port>/v1/logs"` |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | `"http://127.0.0.1:<port>/v1/metrics"` |
| `OTEL_LOG_TOOL_DETAILS` | `"1"` |
| `OTEL_METRIC_EXPORT_INTERVAL` | `"10000"` |

`OTEL_METRIC_EXPORT_INTERVAL` overrides Claude Code's 60 s metrics default. Metrics use **delta temporality**, so
a shorter interval changes no total — it only shrinks the unexported tail lost when a session stops mid-window,
since the Stop upload can land seconds after the last export. 10 s bounds that loss while staying 6x cheaper in
record volume than the 5 s logs stream (`OTEL_LOGS_EXPORT_INTERVAL`, left at its default). Per-request cost comes
from the `api_request` log events and is unaffected by this setting.

**Trace keys** (hook `2.29.0`+, `OTEL_TRACE_ENV_KEYS(port)` in `artisyn-hooks-installer/src/otel-env.ts`). Written
only when the trace answer is yes (`--otel-traces=yes`, the `[Y/n]` prompt, or the stored `otelTraces: true`):

| Key | Value | Artisyn-owned when |
|---|---|---|
| `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` | `"1"` | the value is `1` (and every endpoint key in the same `env` is owned) |
| `OTEL_TRACES_EXPORTER` | `"otlp"` | the value is `otlp` (same endpoint rule) |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `"http://127.0.0.1:<port>/v1/traces"` | a loopback receiver URL (`OTEL_LOOPBACK_ENDPOINT_RE` now also matches `/v1/traces`) on an allocated or recorded port |

`OTEL_ENV_KEYS` itself is unchanged (the dev-container provisioning imports it). The traces endpoint counts as an
endpoint key (`isOtelEndpointKey`), and `isArtisynOwnedOtelValue` looks the expected value up in
`{ ...OTEL_ENV_KEYS(0), ...OTEL_TRACE_ENV_KEYS(0) }`, so the merge, the stale-endpoint rewrite and the migration below
treat the three keys exactly like the nine. When the answer is no, and on `uninstall`, only the **owned** trace keys
are stripped (`stripOwnedOtelEnvKeys`); a value you set yourself stays. The hook (`env-context.js`) has a traces
regex for the port-mismatch check, and `otel-endpoint-check.js` checks the traces endpoint only when
`otelTraces === true`.

`OTEL_EXPORTER_OTLP_COMPRESSION` is written explicitly so the payload encoding never depends on an exporter default
— the receiver still accepts `gzip`/`deflate`, so overriding it is not silently dropped.

**Why `settings.local.json`.** The endpoints carry this checkout's random port, and `otel-port.json` is gitignored
per checkout. A committed `settings.json` carried one checkout's port to every teammate and every second checkout,
whose receivers listen elsewhere, so their exporters posted to a port nothing listens on and all OTEL data was lost
silently (measured case: `at.authors`, settings said `:50280`, the receiver was on `50962`). A local file per
checkout cannot drift that way. After writing it, the installer adds `settings.local.json` and
`settings.local.json.bak` to `.claude/.gitignore` when `git check-ignore` does not already ignore them
(`ensureConfigIgnored`), so neither shows up in `git status`.

**Ownership — which values are "ours"** (`isArtisynOwnedOtelValue`, judged per key and per file, on that file's
`env`):

- An endpoint key (`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`) is Artisyn-owned when it
  is a loopback receiver URL — `http(s)://127.0.0.1|localhost:<port>/v1/logs|metrics` (`OTEL_LOOPBACK_ENDPOINT_RE`)
  — whose port is in the allocation range `25000`–`65535` **or** is a port the installer recorded earlier
  (`readRecordedOtelPorts`: `otel-port.json` `port`, `log-hub.local.json` `otelReceiverPort` and the legacy
  `log-hub.json` one, all when they disagree,
  read before the port is resolved because resolution overwrites the store; the newly resolved port counts too).
  A collector of your own on `localhost:4318` is therefore not ours.
- Any of the other seven keys is Artisyn-owned only when its value equals the installer default **and** every
  endpoint key present in the same `env` is owned. A file whose endpoint points at your collector keeps its
  exporter/protocol keys: they are yours.

**Per-key merge on `install`/`upgrade`** (`mergeOtelEnv`). For each of the nine keys, with `shared` =
`.claude/settings.json` `env` and `local` = `.claude/settings.local.json` `env`:

1. `shared` has it and it is owned → it is deleted from `shared` (migration, below).
2. `shared` has it and it is not owned → it is your value: kept, not written to `local` (an owned `local` copy is
   deleted so it cannot shadow yours), and listed in
   `Note: kept your existing .claude/settings.json env values for <KEYS> — …`.
3. Otherwise, an endpoint key is (re)written in `local` while it is absent or owned — this is the **stale-endpoint
   rewrite**: an owned endpoint on another port is moved to the resolved port and reported as
   `Note: rewrote stale Artisyn OTEL endpoints in .claude/settings.local.json (<KEY>: <oldPort> → <newPort>, …).`
   A non-owned endpoint in `local` is kept and listed in
   `Note: kept your existing .claude/settings.local.json env values for <KEYS> — …`.
4. Otherwise, a non-endpoint key is filled in `local` only when absent; a different existing value is kept and goes
   into that same `settings.local.json` Note.

So an `OTEL_*` value you set yourself still always wins, while the installer's own stale endpoints no longer do.
`settings.local.json` is written first (created when absent), then `settings.json`; each gets a `.bak` before any
mutation, and an `env` object left empty is deleted from either file.

**Migration from `.claude/settings.json`.** A project installed by an older installer has the nine keys in
`.claude/settings.json`. The next `install`/`upgrade` deletes every owned one there, writes `local`, and prints
`Note: moved the Artisyn OTEL env keys from .claude/settings.json to .claude/settings.local.json.` Commit the
resulting `settings.json` change so teammates stop inheriting your port. Running sessions keep the old endpoint
until restarted (the `upgrade` restart Note above).

**Hook-side detection (FR-7).** Claude Code (2.1.280) does **not** forward a settings `env` block's `OTEL_*` keys to
hook processes (`CLAUDE_CODE_ENABLE_TELEMETRY` does arrive), so `resolveOtelPort`'s endpoint cross-check in
`env-context.js` never sees the endpoint. Since hook `2.18.0`, `otel-endpoint-check.js` (called by
`lifecycle-hook.js` on `SessionStart`) reads the settings files directly: local → project → user → process env. It
reports a missing endpoint, or a loopback endpoint on a port other than the receiver's, as a `hook.log` `warn` plus a
`systemMessage` shown to the user. It only detects and never rewrites — the installer's stale-endpoint rewrite above
is the repair. Since hook `2.22.1` the warning ends with the fix that matches it:

```
Fix: re-run the log-hub installer "upgrade" (it writes OTEL_EXPORTER_OTLP_LOGS_ENDPOINT/OTEL_EXPORTER_OTLP_METRICS_ENDPOINT for port <receiverPort> to .claude/settings.local.json), then restart Claude Code.
```

Detection logic is unchanged in `2.22.1`; only the text (and the comments naming `.claude/settings.local.json` as
where the installer writes the endpoints) changed.

**`OTEL_RESOURCE_ATTRIBUTES` in the mirror** (hook `2.30.0`+, `buildResourceAttributes` in `otel-env.ts`). The local
mirror also gets `OTEL_RESOURCE_ATTRIBUTES` = the user-scope value (if any) + the existing local value +
`artisyn.repo=<repoKey>`, comma-joined and deduped by attribute key (local wins over user on a clash; an older
`artisyn.repo` entry is replaced). A local value replaces the user value in Claude Code, so the user's own
attributes are carried over. The `repoKey` tag lets the shared receiver route records to this repo before the
session registers; it is a hash, so no local path reaches a foreign collector.

#### User-scope OTEL keys: `~/.claude/settings.json` (hook `2.30.0`+)

Claude Code `2.1.282`+ ignores telemetry keys in `.claude/settings.json` and `.claude/settings.local.json`, so
the installer writes the same nine (twelve) keys, pointing at the shared port, into the **user** file
(`$CLAUDE_CONFIG_DIR/settings.json` when that env var is set, else `~/.claude/settings.json`;
`artisyn-hooks-installer/src/user-settings.ts`, called from `applyUserOtelSettings` in `install.ts`). This file is
global — a wrong-typed known key makes Claude Code skip **the whole file** — so every write is guarded:

- **Read** (`readUserSettingsForMutation`): a missing file reads as `{}`; invalid JSON or a non-object root aborts
  the installer (exit 1) with no write.
- **Validate** (`validateUserSettingsShape`), once on the file as read and again on the merged result right before
  the write: `env` an object of string values, `hooks` an object of arrays, `otelHeadersHelper` a string,
  `_artisynOtel` an object. A violation → exit 1 with one line per problem, file untouched.
- **Backup:** the content about to be replaced goes to `<settings>.artisyn-bak` first; the write itself is atomic.
  An unchanged result writes nothing.
- **Merge** (`mergeUserOtelEnv`): per key, by the same ownership rule as the mirror (`isArtisynOwnedOtelValue`,
  extended so that endpoints on the per-user port count as owned). Absent or still-Artisyn values are (re)written to
  the shared port, the user's own values are kept and listed in a Note. The trace keys are written while **any**
  installed repo of the user wants traces (the receiver drops spans per repo) and stripped, while still owned, once
  none does.

**Managed settings** (DD-26). When `readManagedOtel` (`managed-settings.ts`) finds OTEL keys in a managed source —
`managed-settings.json` (`%ProgramFiles%\ClaudeCode\` on Windows, `/Library/Application Support/ClaudeCode/` on
macOS, `/etc/claude-code/` on Linux), the OS policy (Windows registry `HKLM`/`HKCU\SOFTWARE\Policies\ClaudeCode`,
macOS `com.anthropic.claudecode` plist) or the server-managed cache `<claudeConfigDir>/remote-settings.json` — the
installer writes **no** user OTEL keys, still writes the local mirror and the `repos.json` entry, and prints
`OTEL is managed by your organization — OTEL tabs are unavailable, everything else works.` The env
`ARTISYN_MANAGED_SETTINGS_DIR` replaces the managed file location and disables the OS-policy reads (test-only).

#### Foreign collector: proxy / keep / replace (hook `2.30.0`+)

**Foreign** = a user-scope or process-env OTLP endpoint key, or `otelHeadersHelper`, that is not Artisyn-owned
(`detectForeignOtel` in `foreign-otel.ts`). Its **fingerprint** is the `sha256` of a canonical JSON of the foreign
keys, with header values replaced by their own `sha256`.

Choice resolution (`resolveOtelUserPlan`): `--otel-existing=` → the stored `forward.json` mode when its
`fingerprint` matches → a TTY prompt (`[P]roxy` recommended / `[k]eep` / `[r]eplace`) → `keep` on a non-TTY run,
with a message naming both flags. The prompt lists per signal the endpoint, protocol, `headers: set` (never values)
and exporter, and names the stream changes Log Hub adds (`OTEL_LOG_TOOL_DETAILS=1`, export intervals, traces if on).

| Choice | User file | `forward.json` | Receiver |
|---|---|---|---|
| `proxy` | endpoint and protocol keys move to the shared port; header keys and `otelHeadersHelper` stay (Claude Code sends them to the receiver, which passes them upstream); `_artisynOtel` note; the user-level SessionStart hook entry is added | `mode:'proxy'`, per-signal upstream `{endpoint, protocol}`, `original` = the replaced keys | forwards every request of a listed signal upstream (see [otel-receiver.md](otel-receiver.md) § "Forwarding") |
| `replace` | endpoint, protocol and header keys (and `otelHeadersHelper`) removed, Artisyn keys written; `_artisynOtel` note | `mode:'replace'`, `original` | no forwarding |
| `keep` | no Artisyn OTEL key goes in; a former proxy/replace rewrite is undone from the backup | `mode:'keep'` | the OTEL tabs stay empty for this user |

- **`grpc` / `http/protobuf` collectors:** the receiver forwards only OTLP/HTTP JSON. The installer says so and, on
  a TTY, offers to enter an OTLP/HTTP URL of the same collector, `keep` or `replace`; non-interactive → `keep`
  plus a message.
- **`_artisynOtel`** = `{note, mode, previous:{KEY: masked}, backup:'<path to forward.json>'}`, with header keys
  masked as `set` (`buildArtisynOtelNote`). No header value is ever printed or logged.
- `forward.json` is written **before** the user file, and only when it changed.
- **Second repo after a takeover (installer `1.0.90`+):** once `proxy`/`replace` is applied, the user file
  carries the Artisyn per-signal endpoints; `detectForeignOtel` no longer lets those owned keys hide the
  backed-up generic `OTEL_EXPORTER_OTLP_ENDPOINT`, so the next repo's install still sees the collector and
  reuses the stored choice. As a second guard, a `none` plan never overwrites an applied `proxy`/`replace`
  `forward.json` and keeps `_artisynOtel` and the user-level hook — the file holds the only copy of the
  user's original keys. (Before 1.0.90 a generic-endpoint collector lost its backup and its forwarding at
  the second repo.)
- **Drift:** when the user later points the user-scope endpoint elsewhere while `forward.json` says `proxy` or
  `replace`, the hook writes one `endpoint-drift` `warn` per SessionStart (`otel-endpoint-check.js`); the next
  install sees a new fingerprint and asks again.

**Hook-side effective-config check** (hook `2.30.0`+, `otel-status.js` `resolveEffectiveOtel` /
`deriveConfigWarnings`). At `SessionStart` `otel-endpoint-check.js` resolves, per Artisyn key, the effective scope
(managed > user > local > project before Claude Code `2.1.282`; managed > user from `2.1.282` on or when the version
is unknown) and writes one `warn` per class: `project-only` (keys only in project scope on `≥ 2.1.282`),
`endpoint-drift`, `port-mismatch`; `lifecycle-hook.js` also logs `claude-version=<v|unknown> source=<transcript|cache|cli|none>` at SessionStart.
It never writes a file. Rules: algorithm [otel-status-reason](algorithms/otel-status-reason.md).

### Post-Turn Analysis Settings

Hook `2.9.0`+. These 6 keys configure `post-turn-analysis-worker.js`'s two independently-gated branches —
the Turn-End Cost Advisor (`turnEndCostAdvisor*`) and AI Session Attribution (`sessionAttribution*`) — spawned
detached by `post-turn-analysis-hook.js` on `Stop`. Both branches are also gated server-side
(feature enabled + threshold met / evaluation required); these keys tune the local `claude -p` invocation and
prompt-size cap once a branch has already decided to run.

| Key | Default | Description |
|---|---|---|
| `turnEndCostAdvisorModel` | `"sonnet"` | Claude model used for the advisor branch's `claude -p` call |
| `turnEndCostAdvisorLlmTimeoutMs` | `30000` | Timeout (ms) for the advisor branch's LLM call; on timeout the run is recorded as `failed` (fail-open) |
| `turnEndCostAdvisorMaxPromptSizeKb` | `60` | Cap on the advisor prompt's free-text "user prompts" sample; fixed fields (aggregate numbers, tool/file usage) are never truncated |
| `sessionAttributionMaxPromptSizeKb` | `60` | Cap on the attribution prompt's free-text "user prompts" sample; attribute definitions and the changed-file list are never truncated |
| `sessionAttributionLlmModel` | `"haiku"` | Claude model used for the attribution branch's `claude -p` call |
| `sessionAttributionLlmTimeoutMs` | `30000` | Timeout (ms) for the attribution branch's LLM call; on timeout the run is recorded as `failed` and counts toward the 3-consecutive-failure cap |

---

## Verification

After installation, start a Claude Code session in the project and issue any prompt. Then check:

```sh
cat .artisyn/ai_work_dir/hook.log
```

You should see `activate` and `result` lines from `telemetry-hook.js`. After the session ends, `send-logs-hook.js`
lines should appear with upload results.

If `serverUrl` or `apiKey` are missing or wrong, `send-logs-hook.js` will log the error there but will not block
the session.

A `413` line in `hook.log` whose response snippet contains `nginx/<version>` (rather than a JSON body from the
app) means a reverse proxy in front of the server — not this app — rejected the request before it arrived; see
`docs/knowledgebase/hook-api-versioning.md`'s "Known limitation" section for why the app's own `LOGS_MAX_BODY_MB`
can't fix that, and what the hook (`CHUNK_SIZE_BYTES`, `2.6.1`+) does to stay under a proxy's likely default cap.

For OTEL, check the receiver's own diagnostics file and its output directory:

```sh
cat .artisyn/ai_work_dir/telemetry/otel/receiver.log
ls  .artisyn/ai_work_dir/telemetry/otel/
```

(substitute your `telemetryDir` if you have set one). A `start` line followed by `ingest` lines, plus one
`<session-id>.jsonl` per session, means the exporter is reaching the receiver. An `addr-in-use` line is normal for
the second and later sessions of a project — one receiver serves them all (back-to-back repeats are written once). A
`no-data` line at idle-exit means the receiver lived a whole idle period without a single OTLP request — Claude Code
is not exporting to it (OTEL env not in `~/.claude/settings.json`, or Claude Code not restarted). Every install /
upgrade (installer 1.0.91+) writes an `[installer]` line to `hook.log` (`upgrade: hooks v<old> → v<new> (server …)`),
as a `warn` with `DOWNGRADE` when the bundled hook is older than the installed one. An `owner-mismatch` line means another
project allocated the same port; re-install with `--otel-port <n>`.

---

## Hook State panel

Each project's hook reports its own health to the server, and the user sees it per repository in the left nav
("Installed Hooks") and on the Hook State page (`#/repos/:repoId/hook-state`, see
`client-routing-and-layout.md` § "`HookStatePage`").

**What the hook sends.** On the `Stop` upload, `send-logs-hook.js` prepends one `hook-status` event to the current
session's artisyn upload. It carries the installed hook version, last activity, the tail of `hook.log` (at most 50
lines), the logs the hook could not upload (`{ file, reason }`), and the active recommendations. The hook keeps
recommendations in `.artisyn/ai_work_dir/hook-recommendations.json`, one entry per `rule`: a new detection of the
same rule replaces the old entry, and a cleared condition removes it (`recommendations.js`). The server writes the
event into the `repositories` row's `hook_*` columns (`db-tables.md#repositories`). An upload without a
`hook-status` event (an older hook, or a non-final body) leaves the stored state as it is.

**Installed vs. latest version.** A repository is `outdated` when its reported hook version is lower than the
latest known hook version (`HookStateService.readLatestHookVersion()`, `server/src/logs/hook-state.service.ts`):

- The installer download records the `?v=` query parameter the client appends to the tarball URL into
  `latest-hook-version.json`, max-wins: a lower or malformed version never replaces the stored one, and the
  download itself never fails because of the parameter (`server/src/installer/installer.controller.ts`).
- Until a download has recorded a version, `installer-version.json` (the hook version bundled into the installer)
  is used. On the interactive dev server `installer-version.json` is always used, because a repository that
  dogfoods its own hook never downloads the tarball.

**Issue count.** The left-nav badge counts one issue for an outdated version, one if the log tail has any
`[error]` / `[fail]` / `[warn]` line, and one per active recommendation. The routes are
`GET /api/v1/repositories/hooks` (the caller's own hook-reporting repositories) and
`GET /api/v1/repositories/:repoId/hook-state` (404 until the repository has reported a `hook-status` event); see
`server-endpoint-map.md`.
