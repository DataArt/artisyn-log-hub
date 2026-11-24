---
type: "Note"
title: "Work Hub Remote Git Repositories and Credential Vault — notes"
description: "evidence and background for the requirements of the remote git / credential vault task"
---

# Notes

## 2026-11-22 — authentication methods surveyed

Common ways developers authenticate to git hosts: HTTPS with a credential manager / OS keyring, a
PAT, a CLI login (`gh`, `glab`, `az`), SSH keys. The owner chose SSH key (preferred) and HTTPS + PAT
for this task (FR-1a); browser / OAuth sign-in was excluded because it needs an OAuth application
registered on each git host, which self-managed instances often do not allow, and a WH install is
usually not reachable from outside.

## 2026-11-23 — verification state at archive time

- Real GitHub (uploaded SSH key, private test repo): Test with host-key pinning, branches, clone of
  an empty repo and of a non-default branch through the UI, Settings → Remotes Test and push policy
  (`only ws/*`), push to `main` / `ws/*`, refused force push and delete of `main`, delete of a
  connection in use. No key material found outside the proxy's tmpfs.
- Fake git host only (scenarios @S-WH-02/05/06): GitLab / Azure DevOps descriptors (FR-1a, FR-2;
  also covered by algorithm rows), generated key on a real host, close with push and the PR link
  (FR-8), expose to agent (FR-10).
- Admin overview (FR-12) and terminal copy over plain http checked in the browser on a stand.
- Not re-run after the admin overview, the copy fix, the Dockerfile fix and the doc edits: the full
  final check set (Work Hub checks, `@S-WH-03`, `@S-WH-04` and the contract suite did run). Work Hub
  is an alpha; the owner tests it by hand next week.
