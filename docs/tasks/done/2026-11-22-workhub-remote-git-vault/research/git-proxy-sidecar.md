---
type: "Research"
title: "Git proxy sidecar — PoC outcome"
description: "What the sidecar PoC proved and the design facts the plan takes from it."
---

# Git proxy sidecar — PoC outcome (2026-11-22)

PoC: [`docs/pocs/2026-11-22-1828-wh-git-proxy-sidecar/`](../../../../pocs/2026-11-22-1828-wh-git-proxy-sidecar/README.md) — 24/24 checks pass.

Conclusions carried into the plan:

- A sidecar built from stock Alpine packages (`git`, `git-daemon`, `openssh-client`, `lighttpd`)
  serves smart HTTP to workspace containers that have only stock git; secrets stay in the sidecar's
  tmpfs. No new Rust crate is needed for SSH keygen, host-key scan / fingerprint or passphrase
  removal — the sidecar's `ssh-keygen` / `ssh-keyscan` do it, driven by `docker exec`.
- Per-remote bare mirror, synced from the real host on every ref advertisement; a pre-receive hook
  pushes to the real host with `--force-with-lease=<ref>:<old>` before accepting. The host's own
  rejection reaches the client; stale pushes are rejected normally.
- Policy (force push / delete of the default branch) is checked in the hook with
  `merge-base --is-ancestor`; the message reaches the client as `remote: …`.
- Error transport: connection-level errors (revoked credential, changed host key, deleted
  connection, no grant) as an `ERR` pkt-line in a 200 advertisement → `fatal: remote error: …`;
  only a missing / unknown capability answers HTTP 401.
- Network layout (`net-check.cjs`, 7/7):
  - Containers created on `bridge` and then connected to an `--internal` network resolve and reach
    the sidecar alias `wh-git`, and keep egress.
  - The sidecar on `bridge` plus the internal network has egress.
  - The alias survives a sidecar restart.
  - A repeated connect answers "already exists".
- `docker cp` / the archive API cannot write into a tmpfs mount (silently lost): files in a
  container's `/tmp` and the sidecar's `/run/wh` are written with `docker exec` + stdin.
