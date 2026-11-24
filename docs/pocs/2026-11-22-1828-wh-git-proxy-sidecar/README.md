---
type: "PoC"
title: "WH git proxy sidecar"
description: "Checks that a lighttpd + git http-backend sidecar with per-remote mirrors and a push-through pre-receive hook gives credential-free fetch / push with policy and readable errors."
---

# PoC: Work Hub git proxy sidecar

Task: [Work Hub Remote Git Repositories and Credential Vault](../../tasks/todo/2026-11-22-workhub-remote-git-vault/requirements.md)
(FR-1a, FR-4, FR-6, FR-7, FR-11).

## Question

Can the "WH git proxy sidecar" be built from stock parts so that a workspace container with
**stock git and no ssh client** can clone / fetch / push a real host over SSH (key) or HTTPS (PAT)
while the secret never enters it, with:

1. the container's capability coming from a credential helper that reads a tmpfs file;
2. the push policy (no force push / delete of the default branch) enforced with a readable message;
3. a push reaching the real host synchronously (the client sees the host's own rejection);
4. readable messages for a revoked credential, a changed host key, a deleted connection and a
   container without a grant;
5. SSH key generation, host-key scan / fingerprint and passphrase removal done without new Rust
   crates (inside the sidecar);
6. large pushes (chunked request bodies) working through lighttpd's CGI?

## Design under test

- `sidecar/`: Alpine + `git`, `git-daemon` (for `git http-backend`), `openssh-client`, `lighttpd`.
  - `wh-git-cgi`: the CGI front. URL `http://wh-git/git/<remote id>.git`. Checks
    `Authorization: Basic <any>:<capability>` against `/run/wh/caps/<sha256(capability)>` (list of
    remote ids), then syncs the bare mirror `/srv/git/<remote id>.git` from the real host on every
    ref advertisement (`info/refs`), then `exec git http-backend`.
  - `pre-receive` (system `core.hooksPath`): policy check, then `git push --force-with-lease=<ref>:<old>
    upstream <new>:<ref>` to the real host from inside the hook (quarantined objects); if the host
    rejects, the hook fails and the mirror ref is not updated.
  - `wh-git-ctl`: control commands the WH server would run with `docker exec`: `keygen`,
    `strip-passphrase`, `scan`, `ls-remote`, `sync`, `push-upstream`.
  - `/run/wh` (tmpfs): `conns/<id>/{key,known_hosts,header}`, `remotes/<id>`, `caps/<hash>`.
- `upstream/`: fake git host — sshd (user `git`) and smart HTTP accepting one fixed "PAT".
- `client/`: Alpine + git only (stand-in for a workspace container), tmpfs `/tmp`.
- All on one user-defined network; the sidecar has the alias `wh-git`.

## How to run

From this folder (Docker must be running; the first run downloads `alpine:3.20` packages):

```
node run.cjs
```

It builds the three images, runs every check (`PASS` / `FAIL` lines), then `docker compose down -v`.

`node net-check.cjs` checks the plan's network layout: bridge plus an internal network with the
alias. It needs internet access for the egress checks and removes its own containers and network.

## Result

**All 24 checks PASS** (2026-11-22, Docker Engine 29.7, Alpine 3.20 git 2.45). The approach works
as designed:

| Check | Outcome |
|---|---|
| Clone through proxy, SSH upstream, with progress | `Receiving objects: 100% (6/6)` streamed to the client |
| Clone + push through PAT (HTTPS-style) upstream | `* [new branch] HEAD -> ws/pat` |
| `ls-remote --symref` from the sidecar (dialog branch list) | `ref: refs/heads/main	HEAD` + branches, both transports |
| No secret in the client (`.git/config`, file system, env) | none found |
| Push new branch / fast-forward `main` / force push `ws/*` | accepted, reached the real host |
| Force push to default branch | `remote: Work Hub push policy: force push to the default branch main is not allowed` |
| Delete default branch | `remote: Work Hub push policy: deleting the default branch main is not allowed` |
| Stale push (host moved meanwhile) | normal `! [rejected] main -> main (fetch first)` — mirror is synced on every advertisement |
| 3 MB push (chunked body) | accepted |
| Remote not in the capability | `fatal: remote error: Work Hub: this workspace has no grant …` |
| Unknown capability | `remote: Work Hub: unknown or revoked capability` + `Authentication failed` (HTTP 401) |
| Revoked PAT | `fatal: remote error: Work Hub connection pat-conn was rejected by the host - update its credential in Settings` |
| Changed host key | `fatal: remote error: … the host key of the git host changed - check it and re-pin in Settings` |
| Deleted connection | `fatal: remote error: Work Hub connection ssh-conn was deleted - rebind …` |
| Host's own push error | relayed as `remote: …` lines (seen with a host-side permission error) |
| `ssh-keygen` ed25519 keygen / `ssh-keyscan` + `ssh-keygen -lf` fingerprint / `ssh-keygen -p` passphrase removal | all work in the sidecar |

How a git client shows an error (probe `/msg/*`):

- **`ERR <msg>` pkt-line in a 200 ref advertisement** → `fatal: remote error: <msg>` — the cleanest,
  and it does not trigger git's credential reject logic. Use it for every "connection" error.
- **403 text/plain** → `remote: <msg>` + `The requested URL returned error: 403`.
- **401 text/plain** after credentials were sent → `remote: <msg>` + `Authentication failed`. Use
  only for a missing / unknown capability (git then calls the helper's `erase`, which is harmless).
  A 401 before any credential just makes git ask the helper — so a 401 body is not seen when the
  helper is missing.

**Network layout check** (`node net-check.cjs`, the plan's D2 layout rather than `compose.yml`'s
single network): **7/7 PASS**.

- A container created on the default `bridge` and then `docker network connect`-ed to an
  `--internal` user-defined network resolves the sidecar alias `wh-git` (`getent hosts`) and reaches
  it over HTTP.
- The container keeps internet egress through `bridge`.
- The sidecar, created on `bridge` and then connected to the internal network with
  `--alias wh-git`, has internet egress (`curl https://example.com` → 200).
- The alias still resolves after the sidecar restarts.
- A second `network connect` fails with `endpoint with name … already exists in network …`, which
  the server treats as "already connected".

Extra finding (outside `run.cjs`, probed by hand): **`docker cp` / the Engine archive API into a
tmpfs mount silently does nothing** — the file is not visible in the container's `/tmp`. So the
capability file in a workspace container's `/tmp` and everything under the sidecar's `/run/wh`
must be written with `docker exec` + stdin, never with `archive::put_files`.
