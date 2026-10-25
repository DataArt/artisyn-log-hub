---
type: reference
title: Git Hooks and Secret Scanning
description: The versioned git hooks in .githooks/ (migration guard, gitleaks secret scan on pre-commit and pre-push), the .gitleaks.toml allowlist, the CI scan (gated on GITLEAKS_ENABLED) and the main/release branch ruleset that requires it and the fast-checks job
tags: [git, hooks, security, gitleaks, ci]
timestamp: 2026-10-25
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

### Custom rule — key files by name

The default rules match provider prefixes or a keyword next to the value, so a file holding only
a bare token (e.g. a 64-char API key with no `api_key=` around it) passes them. The `key-file`
rule in `.gitleaks.toml` flags by path alone: any `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*.jks`,
`*.keystore`, `*.ppk` and `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`, whatever the content. Local
key files belong in `.gitignore` (e.g. `/vt.key`); the rule catches a `git add -f` or a key file
elsewhere in the tree.

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

## CI scan and branch protection

`.github/workflows/gitleaks.yml` downloads the pinned gitleaks release (sha256-verified, the
official `gitleaks-action` needs a license key for organization repos) and scans the full history
on push to `main` or `release` and on pull requests. The job is gated on the repository variable
`GITLEAKS_ENABLED == 'true'` (skipped, no runner minutes, while it is unset); a manual
"Run workflow" (`workflow_dispatch`) always runs. Keep `GITLEAKS_VERSION`/`GITLEAKS_SHA256` equal
in the workflow and `docker-dev/Dockerfile`.

The repository is public; the setup that goes with it:

1. Settings → Secrets and variables → Actions → Variables: add `GITLEAKS_ENABLED` = `true`.
2. Settings → Code security: enable **Secret scanning** and **Push protection** (free for public
   repositories; paid GitHub Secret Protection for private ones). Push protection rejects a push
   with a known provider token at the remote.
3. Make the `scan` check (the gitleaks job) required for `main` and `release` — done in the
   repository ruleset `protect-main-release` (Settings → Rules → Rulesets), which also requires a
   PR and blocks deletion and force-push on both branches.
4. Add `fast-checks` next to `scan` as a required status check of `protect-main-release`. It is the
   single job of `.github/workflows/checks.yml` (the FR-5 fast checks: typechecks, algorithm tests,
   build-script tests, hook tests), which runs on every pull request to `main` and `release` and is
   also called by the release workflow. GitHub offers a check name only after it has run once, so
   add it after the first PR run of `checks.yml`. See [Release Pipeline](release-pipeline.md).

The other, report-only security scans (Snyk, dependency review, config guard, lock-file and workflow
lint, VirusTotal) are in [CI Security Scans](ci-security-scans.md).
