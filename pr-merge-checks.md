# PR merge checks

What a maintainer checks by hand before merging a pull request into this repository.

Some files in this repository are not just data: Claude Code, the telemetry hook, npm or git
**execute** them, or read from them where to send data, on the machine of everyone who clones the
repository and opens it in Claude Code. CI does not catch a malicious change in them. Review every
change to the files below line by line, whoever the author is.

## 1. Hook config: `.artisyn/config/log-hub.json`

The telemetry hook reads this file from the repository it runs in, so a PR can change how the
hook behaves for every contributor.

- [ ] **Model names** `turnEndCostAdvisorModel`, `sessionAttributionLlmModel`. They are passed to
      `claude --model <value>`, which on Windows runs through `cmd.exe` (`shell: true`,
      `hook/.claude/telemetry_tool/claude-invoke-async.js`). The hook does not validate them, so
      a value like `sonnet & <command>` runs `<command>` in a hidden background process on every
      `Stop`. Accept only a plain model id: letters, digits and `. _ : - [ ]`, for example
      `sonnet`, `haiku` or `claude-opus-5-5[1m]`.
- [ ] **`serverUrl`**: where every contributor's session transcripts are uploaded. Only
      `http://localhost:<port>` (the dogfood server) is acceptable here.
- [ ] **`telemetryDir`**: must stay empty or relative. An absolute path makes the hook write
      outside the repository.
- [ ] **Any new key**: check `hook/.claude/telemetry_tool/env-context.js` (`CONFIG_DEFAULTS`) for
      what it does. Unknown keys are passed through unchanged.

`.artisyn/config/log-hub.local.json` is gitignored and must never appear in a PR: it holds the
API key.

## 2. Claude Code config

- [ ] **`.claude/settings.json`**:
  - `hooks` (commands Claude Code runs on events; there are none today);
  - `env` (the `OTEL_EXPORTER_OTLP_*_ENDPOINT` values must stay on `127.0.0.1`/`localhost`);
  - `enabledPlugins` and `extraKnownMarketplaces` (only `adlc-lh@artisyn` and
    `log-hub-hooks@artisyn` from `.artisyn/marketplace`, plus official plugins such as
    `typescript-lsp@claude-plugins-official`);
  - `permissions` (no broad `allow` rules).
- [ ] **`.mcp.json`**: every `command` + `args` of a stdio server is executed. Claude Code asks
      before it starts a project MCP server, but the telemetry hook's MCP probe
      (`mcpProbeTimeoutMs`, `send-logs-hook.js`) launches them on every `Stop` without asking,
      with `shell: true` on Windows for `npx`-style commands.
- [ ] **`.claude/skills/**`, `.claude/rules/**`, `CLAUDE.md`**: instructions that Claude follows in
      every session. Look for injected instructions such as "run this script" or "send this file",
      and for scripts that skills call (`.claude/skills/*/scripts/`).

## 3. Code that runs on contributors' machines

- [ ] **`.artisyn/marketplace/plugins/**`**: the locally installed plugins (the dogfood hook and
      `adlc-lh`). They run inside every Claude Code session in this repository. Changes must
      match `hook/.claude/telemetry_tool/` (see `.claude/rules/hook.md`), not add code of their
      own.
- [ ] **`hook/.claude/telemetry_tool/**`**: anything that spawns a process (`spawn`,
      `execFile*`, `shell: true`) or makes a network request.
- [ ] **`package.json` scripts in every package**: `prepare`, `preinstall`, `postinstall` and the
      `pre*`/`post*` hooks of commands run every day (`build`, `test`, `lint`) run on
      `npm install` or with those commands.
- [ ] **`.githooks/**`** and `scripts/install-git-hooks.js`: run on every commit.
- [ ] **Fixture repositories** under `.claude/skills/big-prod-e2e-test/fixtures/` and
      `tests/corpus/scenarios/scenarios.json`: `npm run corpus:generate` and the big-prod test run
      real `claude -p` sessions on them. Their `CLAUDE.md`, `.claude/` and prompts steer those
      sessions.

## 4. Dependencies

- [ ] New or changed dependencies in `package.json`: a known package, a real need, an MIT-compatible
      licence. Add it to `THIRD_PARTY_NOTICES.md`.
- [ ] Lock files (`package-lock.json`, `bun.lock`): every `resolved` URL is
      `https://registry.npmjs.org/`, and a lock-file change comes with a matching `package.json`
      change.

## 5. Secrets and private data

- [ ] `gitleaks dir .` (or `gitleaks git` on the PR branch) reports nothing new.
- [ ] No real e-mails, internal hosts or personal paths. Test identities use `@arrakis.test` or
      `example.com`; paths use `C:\work\project` or `/home/user/project`.
- [ ] No recorded sessions: `tests/corpus/sets/` is gitignored, and new `.jsonl` fixtures are
      synthetic.
- [ ] No `.env`, `*.local.*`, screenshots or `tmp/` files.

## 6. Database migrations

- [ ] Existing files in `server/drizzle/migrations/` are never edited, only new ones added. The pre-commit
      hook (`scripts/migrations-lock.js`) enforces this locally, but a PR author may not have it
      installed.
