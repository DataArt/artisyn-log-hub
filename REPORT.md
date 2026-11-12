# Security scan report

_Commit [`c6228ac`](https://github.com/DataArt/artisyn-log-hub/commit/c6228ac8b99bef72ac523c603baaa7f5e1b12485) on `main` · updated 2026-11-12 20:32 UTC · [workflow run](https://github.com/DataArt/artisyn-log-hub/actions/runs/43301049617)_

The README badge counts every row below except Snyk Open Source (dev) — devDependencies do not
ship — and skipped rows. How the scans work: [ci-security-scans.md](https://github.com/DataArt/artisyn-log-hub/blob/main/docs/knowledgebase/ci-security-scans.md).

## Summary

| Tool | Status | Critical | High | Medium | Low | Details |
|---|---|---|---|---|---|---|
| Snyk Open Source (prod) | ✅ pass | 0 | 0 | 2 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43301049617) 2 medium |
| Snyk Open Source (dev) | ✅ pass | 0 | 0 | 5 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43301049617) 5 medium |
| Snyk — installer tarballs | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43301049617) no issues |
| Executable-config guard | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43301049617) |
| Lock-file registry | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43301049617) ok |
| npm registry signatures | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43301049617) ok |
| actionlint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43301049617) ok |
| zizmor | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43301049617) no issues |
| hadolint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43301049617) no issues |
| docker compose config | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43301049617) ok |
| Snyk Container | ✅ pass | 0 | 0 | 0 | 1 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43205127775) as of 2026-11-12 11:04 UTC: 1 low |
| Node runtime (Dockerfile) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43301049617) 26.13.1 is the latest patch |
| Node runtime (docker-dev) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43301049617) 26.13.1 is the latest patch |
| VirusTotal — artisyn-hooks-installer.tgz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/025466c2df1b9247af79ab30386b7bd913d5c1d2da51171b3eac1245be33d9bb) as of 2026-11-12 11:04 UTC: 0/75 engines |
| VirusTotal — hooks.tar.gz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/37b8cff17027e611d4ef70233a3396c8be62572a7e3e60ed96041f5ef0a809db) as of 2026-11-12 11:04 UTC: 0/75 engines |

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

- VirusTotal — artisyn-hooks-installer.tgz: ✅ pass · as of 2026-11-12 11:04 UTC: 0/75 engines · [report](https://www.virustotal.com/gui/file/025466c2df1b9247af79ab30386b7bd913d5c1d2da51171b3eac1245be33d9bb)
- VirusTotal — hooks.tar.gz: ✅ pass · as of 2026-11-12 11:04 UTC: 0/75 engines · [report](https://www.virustotal.com/gui/file/37b8cff17027e611d4ef70233a3396c8be62572a7e3e60ed96041f5ef0a809db)

## More

- [Code scanning alerts](https://github.com/DataArt/artisyn-log-hub/security/code-scanning) — Snyk and zizmor findings with file and line
- [Dependabot alerts](https://github.com/DataArt/artisyn-log-hub/security/dependabot)
