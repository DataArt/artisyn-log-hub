# Security scan report

_Commit [`7bf1356`](https://github.com/DataArt/artisyn-log-hub/commit/7bf1356375500c7aaee0907be277f377f62fc365) on `main` · updated 2026-11-12 11:04 UTC · [workflow run](https://github.com/DataArt/artisyn-log-hub/actions/runs/43205127775)_

The README badge counts every row below except Snyk Open Source (dev) — devDependencies do not
ship — and skipped rows. How the scans work: [ci-security-scans.md](https://github.com/DataArt/artisyn-log-hub/blob/main/docs/knowledgebase/ci-security-scans.md).

## Summary

| Tool | Status | Critical | High | Medium | Low | Details |
|---|---|---|---|---|---|---|
| Snyk Open Source (prod) | ✅ pass | 0 | 0 | 2 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43205127775) 2 medium |
| Snyk Open Source (dev) | ✅ pass | 0 | 0 | 5 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43205127775) 5 medium |
| Snyk — installer tarballs | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43205127775) no issues |
| Executable-config guard | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43205127775) |
| Lock-file registry | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43205127775) ok |
| npm registry signatures | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43205127775) ok |
| actionlint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43205127775) ok |
| zizmor | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43205127775) no issues |
| hadolint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43205127775) no issues |
| docker compose config | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43205127775) ok |
| Snyk Container | ✅ pass | 0 | 0 | 0 | 1 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43205127775) 1 low |
| Node runtime (Dockerfile) | ⚠️ warning | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43205127775) 26.13.0  26.13.1 |
| Node runtime (docker-dev) | ⚠️ warning | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43205127775) 26.13.0  26.13.1 |
| VirusTotal — artisyn-hooks-installer.tgz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/025466c2df1b9247af79ab30386b7bd913d5c1d2da51171b3eac1245be33d9bb) 0/75 engines |
| VirusTotal — hooks.tar.gz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/37b8cff17027e611d4ef70233a3396c8be62572a7e3e60ed96041f5ef0a809db) 0/75 engines |

## Snyk — critical and high issues

### Snyk Open Source (prod)

_No critical or high issues._

### Snyk Open Source (dev)

_No critical or high issues._

### Snyk — installer tarballs

_No critical or high issues._

### Snyk Container

_No critical or high issues._

## VirusTotal

- VirusTotal — artisyn-hooks-installer.tgz: ✅ pass · 0/75 engines · [report](https://www.virustotal.com/gui/file/025466c2df1b9247af79ab30386b7bd913d5c1d2da51171b3eac1245be33d9bb)
- VirusTotal — hooks.tar.gz: ✅ pass · 0/75 engines · [report](https://www.virustotal.com/gui/file/37b8cff17027e611d4ef70233a3396c8be62572a7e3e60ed96041f5ef0a809db)

## More

- [Code scanning alerts](https://github.com/DataArt/artisyn-log-hub/security/code-scanning) — Snyk and zizmor findings with file and line
- [Dependabot alerts](https://github.com/DataArt/artisyn-log-hub/security/dependabot)
