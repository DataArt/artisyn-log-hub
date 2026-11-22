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
