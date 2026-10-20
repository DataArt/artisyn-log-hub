---
type: "Architecture Guide"
title: "Repository Identity (URL normalisation and local repos)"
description: "How a session's repository is identified: remote URL normalisation, the per-user <email>/<path> identity for projects without a git remote, how ingest detects a local path (git.repo or the top-level cwd), team repo matching, and the idempotent startup backfill phase that rewrites former-local rows."
tags:
  - repositories
  - ingest
  - hooks
timestamp: "2026-10-14T00:00:00+04:00"
---

# Repository Identity

A `repositories` row is identified by `(user_id, repo_url)` (unique). This article covers how
`repo_url` is derived from what the hook reports, for both projects with a git remote and projects
without one. Read it before touching `repo-url-normalizer.ts`, `local-repo-identity.ts`,
`extractRepoUrls()`, the repository step of `LogsService` ingest, `RepoBackfillService` or the
team add-repo path.

## 1. What the hook reports

`telemetry-hook.js` (`prompt_start`) and `lifecycle-hook.js` (`SessionStart`) upload a `git`
object `{ repo, branch, user, root, worktreeRoot }`, where `repo` is `git.remote || git.root`:

| Project | `git.repo` | Top-level `cwd` |
|---|---|---|
| Git repo with a remote | The remote URL (SSH or HTTPS) | absent |
| Git repo without a remote | The repo root — a **local path** | absent |
| Not a git repo (`git: null`) | — | The session's cwd, a **local path** (hook `2.21.0`+ only) |

Older hooks send no `cwd`, so a non-git folder from them gets no repository at all. See
[hook-api-versioning.md](hook-api-versioning.md) § "Telemetry tail sweep and the top-level `cwd`
field".

`extractRepoUrls(lines)` (`server/src/logs/artisyn-extractor.ts`) returns the distinct raw values:
`git.repo` when `git` is an object, else a string `line.cwd` when `git` is exactly `null`.

## 2. Remote URLs — `normalizeRepoUrl`

`server/src/logs/repo-url-normalizer.ts` maps every spelling of one remote to one canonical HTTPS
form, so SSH and HTTPS clones share a row:

- SSH Azure DevOps and legacy `vs-ssh.visualstudio.com` → `https://dev.azure.com/<org>/<project>/_git/<repo>`.
- Any other `git@<host>:<path>[.git]` → `https://<host>/<path>`.
- `http` → `https`; credentials, a trailing `.git` and trailing slashes are stripped; the host is
  lower-cased. `git://` and unparseable input are returned verbatim.
- **Fixed point.** The single pass is repeated (bounded to 3 extra passes) until the value stops
  changing, so normalising a stored value never changes it again.
- **Local identities are returned unchanged.** The first check is
  `isLocalRepoIdentity(raw)`, which runs **before** the scp-style `git@` rule, so an identity like
  `muaddib@arrakis.test/C:/work/p` (or one whose email starts with `git@`) is never mistaken for an SSH
  remote.

## 3. Local identity — `<email>/<path>`

A bare local path is not unique across users: two people can both work in `C:\work\project`.
Before this identity existed, the path was pushed through `normalizeRepoUrl` and stored as a
mangled pseudo-URL (`https://work/project`), which collided across users and with real hosts and
showed a meaningless name in the UI. Now a local path is scoped by the uploader's email.

`server/src/logs/local-repo-identity.ts`:

| Export | Rule |
|---|---|
| `isRawLocalPath(raw)` | Matches `^[A-Za-z]:[\\/]` (drive), `^\\\\` (UNC) or `^/` (POSIX; also `//`) |
| `toLocalRepoIdentity(email, rawPath)` | 1. lower-case the email · 2. `\` → `/` · 3. upper-case the drive letter · 4. strip trailing `/`, keeping a bare root (`/`, `C:/`) · 5. `email + path` when the path starts with `/`, else `email + '/' + path` |
| `isLocalRepoIdentity(value)` | Matches `^[^\s/:@]+@[^\s/:]+/` — an email followed by `/` |

| Raw path | Identity |
|---|---|
| `C:\work\project` | `muaddib@arrakis.test/C:/work/project` |
| `c:\work\project\` | `muaddib@arrakis.test/C:/work/project` |
| `/home/u/proj` | `muaddib@arrakis.test/home/u/proj` |
| `\\srv\share\p` | `muaddib@arrakis.test//srv/share/p` |

The identity is a fixed point of `normalizeRepoUrl`, so ingest, teams and the backfill always agree
on the stored `repo_url`. The UI shows it as the repository name (the repo detail endpoint returns
`repoUrl` verbatim).

There is deliberately **no** "host without a dot means local" heuristic: only `isRawLocalPath`
decides.

## 4. Ingest detection

In `LogsService` step 5 (`server/src/logs/logs.service.ts`, artisyn logs only):

1. `rawRepoUrls = extractRepoUrls(lines)`.
2. When any raw value passes `isRawLocalPath`, the uploader's email is loaded from `users` by
   `userId` — **once per call**, and only then.
3. Each raw local path maps to `toLocalRepoIdentity(email, raw)`; every other value goes through
   `normalizeRepoUrl`. A `local repo identity: <raw> → <identity>` line is logged on first insert.
4. The repository upsert and `log_repositories` link are unchanged (`onConflictDoNothing`).

An old hook's raw `git.repo` path and a new hook's `cwd` for the same folder therefore attach to
the **same** identity row.

## 5. Teams

`TeamsService.toTeamRepoUrl(raw, actingUserId)` (`server/src/teams/teams.service.ts`) is used by
the add-repo and repo-match paths: a raw local path becomes
`normalizeRepoUrl(toLocalRepoIdentity(actingUser.email, raw))`, so a team owner adding their own
local project matches the identity ingest stored for them. Anything else is just normalised.

## 6. Startup backfill — `migrateLocalRepoIdentities()`

Rows created before the identity existed hold the normalised form of a raw path. The rewrite is a
TypeScript phase, not SQL, in `RepoBackfillService` (`server/src/logs/repo-backfill.service.ts`).
`onApplicationBootstrap()` runs, in order: `migrateLocalRepoIdentities()` →
`backfillRepoUrls()` → `backfillTeamRepoUrls()`.

**Detection.** For every repository whose `repo_url` is **not** already an identity, read the raw
values (`git.repo`, or `cwd` when `git` is null) from the artisyn logs linked through
`log_repositories`. Only the oldest and newest linked artisyn log per repo are scanned (every linked
log carries the value that produced the URL; scanning all bodies took seconds on the dev DB, this
takes tens of milliseconds). A repo R is **former-local** when a raw value passes `isRawLocalPath`
**and** `normalizeRepoUrl(raw) === R.repo_url`. Its identity is built with R's **owner's** email.
If one repo yields several different identities, the first is kept and a warning is logged.

**Merge.** Former-local rows are grouped by `(userId, identity)`, together with any identity row
ingest already created for that user. Per group, in one transaction:

- The lowest id survives. Every other member is merged through `mergeRepoInto(survivorId,
  nonSurvivorId)`: drop `log_repositories` links the survivor already has, re-point the rest,
  delete the non-survivor row (its child rows cascade). The same helper backs the URL backfill.
- A former-local survivor gets `repo_url = identity`.
- `team_repositories.repo_url` is rewritten from each old URL to the identity in teams where the
  owner is a member or the owner, skipping teams that already list the identity.

**Idempotent.** Identity rows are excluded from detection, so a second start finds nothing and logs
`Local repo identity migration: nothing to do`.

Follow the `migrations-data-integrity` skill before changing this phase.

## Out of scope

The post-turn advisor (`post-turn-analysis-hook.js`) still cannot resolve a repo without a remote:
the hook does not know the owner's email, so it cannot build the identity.

## Related

- [db-tables.md](db-tables.md) — `repositories`, `log_repositories`, `team_repositories`
- [hook-api-versioning.md](hook-api-versioning.md) — the additive `cwd` field
- [server-endpoint-map.md](server-endpoint-map.md) — `GET /api/v1/repositories/:repoId` (optional `teamId`)
