---
type: reference
title: Git Hooks and Secret Scanning
description: The versioned git hooks in .githooks/ (migration guard, gitleaks secret scan on pre-commit and pre-push), the .gitleaks.toml allowlist, the off-by-default CI scan and what to switch on when the repository goes public
tags: [git, hooks, security, gitleaks, ci]
timestamp: 2026-10-24
---

# Git Hooks and Secret Scanning

## Installation

The root `package.json` `prepare` script (`scripts/install-git-hooks.js`) sets
`core.hooksPath=.githooks` on every `npm install`, so the versioned hooks below run for every
clone. Outside a git checkout or without git on PATH it does nothing. Hook files are LF-only
(`.gitattributes`) and must carry the executable bit in the index for Linux/macOS clones
(`git add --chmod=+x .githooks/<hook>`); Git for Windows runs them regardless.

| Hook | Runs | Blocks when |
|---|---|---|
| `pre-commit` | `scripts/migrations-lock.js --pre-commit`, then `scripts/gitleaks-scan.js --pre-commit` | a committed migration changed (see [db-schema-code.md](db-schema-code.md)); gitleaks finds a secret in the staged changes; gitleaks is not installed |
| `pre-push` | `scripts/gitleaks-scan.js --pre-push <remote>` | gitleaks finds a secret in any commit being pushed; gitleaks is not installed |

## Secret scan (gitleaks)

Three layers, earliest first:

1. **pre-commit** — `gitleaks git --pre-commit --staged`: a secret never lands in a commit, so
   there is no history to rewrite.
2. **pre-push** — the backstop for commits made with `--no-verify` or before the hooks were
   installed. For each ref line git writes to the hook's stdin it scans `<remote sha>..<local sha>`;
   for a new branch, or a remote tip this clone does not have, it scans
   `<local sha> --not --remotes=<remote>`. Branch deletions are skipped.
3. **CI** — `.github/workflows/gitleaks.yml`, the only layer `--no-verify` cannot skip (see below).

Both hooks are **strict**: a missing `gitleaks` binary blocks too, with install hints (Windows
`scoop install gitleaks`, macOS `brew install gitleaks`, Linux release binary). The Claude sandbox
image (`docker-dev/Dockerfile`, stage `fetch-gitleaks`) ships it. Findings are printed redacted.
`git commit/push --no-verify` skips the hook as a last resort — it also skips the migration guard.

### False positives — `.gitleaks.toml`

The config extends the default rule set (`[extend] useDefault = true`) and holds `[[allowlists]]`
for reviewed false positives. Rules for a new entry:

- only for a value verified not to be a secret (a public key fingerprint, a dev-only placeholder);
- as narrow as possible — an anchored regex on the exact secret (default `regexTarget`) or on the
  whole match (`regexTarget = "match"`), never a whole path or a whole rule;
- a `description` saying what the value is and where it lives.

The CI job scans the whole history, so a false positive in an old commit needs an allowlist entry
too. Check the full history locally with
`gitleaks git --config .gitleaks.toml --redact --log-opts="--all" .`.

If a real secret was committed: rotate it first — removing it from history does not un-leak it.

## CI scan — off until the repository is public

`.github/workflows/gitleaks.yml` downloads the pinned gitleaks release (sha256-verified, the
official `gitleaks-action` needs a license key for organization repos) and scans the full history
on push to `main` and on pull requests. The job is gated on the repository variable
`GITLEAKS_ENABLED == 'true'`, so it is skipped (no runner minutes) until then; a manual
"Run workflow" (`workflow_dispatch`) always runs. Keep `GITLEAKS_VERSION`/`GITLEAKS_SHA256` equal
in the workflow and `docker-dev/Dockerfile`.

When the repository goes public:

1. Settings → Secrets and variables → Actions → Variables: add `GITLEAKS_ENABLED` = `true`.
2. Settings → Code security: enable **Secret scanning** and **Push protection** (free for public
   repositories; paid GitHub Secret Protection for private ones). Push protection rejects a push
   with a known provider token at the remote.
3. Optionally make the `gitleaks` check required in the `main` branch protection rule.
