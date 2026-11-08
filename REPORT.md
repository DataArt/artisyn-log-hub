# Security scan report

_Commit [`28e98e8`](https://github.com/DataArt/artisyn-log-hub/commit/28e98e871560145d3b6c260d1de4f3420fd05bf4) on `main` · updated 2026-11-08 10:16 UTC · [workflow run](https://github.com/DataArt/artisyn-log-hub/actions/runs/42470567545)_

The README badge counts every row below except Snyk Open Source (dev) — devDependencies do not
ship — and skipped rows. How the scans work: [ci-security-scans.md](https://github.com/DataArt/artisyn-log-hub/blob/main/docs/knowledgebase/ci-security-scans.md).

## Summary

| Tool | Status | Critical | High | Medium | Low | Details |
|---|---|---|---|---|---|---|
| Snyk Open Source (prod) | ✅ pass | 0 | 0 | 2 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42362063134) as of 2026-11-07 10:02 UTC: 2 medium |
| Snyk Open Source (dev) | ✅ pass | 0 | 1 | 5 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42362063134) as of 2026-11-07 10:02 UTC: 1 high, 5 medium |
| Snyk — installer tarballs | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42362063134) as of 2026-11-07 10:02 UTC: no issues |
| Executable-config guard | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42470567545) |
| Lock-file registry | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42470567545) ok |
| npm registry signatures | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42470567545) ok |
| actionlint | 💥 tool error | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42470567545) step outcome: error; actionlint install failed |
| zizmor | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42470567545) no issues |
| hadolint | 💥 tool error | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42470567545) no output |
| docker compose config | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42470567545) ok |
| Snyk Container | ✅ pass | 0 | 0 | 0 | 1 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42470567545) 1 low |
| Node runtime (Dockerfile) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42470567545) 26.13.0 is the latest patch |
| Node runtime (docker-dev) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42470567545) 26.13.0 is the latest patch |
| VirusTotal — artisyn-hooks-installer.tgz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/8a61fb75d0b7c479dfb4ed0303691c1538d4a98a4bbe9f032e39177bd53c4ce0) 0/75 engines |
| VirusTotal — hooks.tar.gz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/346541dc059d7a5b7e168f3f9554a559ed6228ff976174c13aa9d346f48bbbe1) 0/75 engines |

## Snyk — critical and high issues

### Snyk Open Source (prod)

_No critical or high issues._

### Snyk Open Source (dev)

| Severity | Issue | Package | Fixed in | Project |
|---|---|---|---|---|
| high | [SNYK-JS-URIJS-19963963](https://security.snyk.io/vuln/SNYK-JS-URIJS-19963963) Infinite loop | `uri-js@4.4.1` | no fix yet | `client/package.json` |

### Snyk — installer tarballs

_No critical or high issues._

### Snyk Container

_No critical or high issues._

## VirusTotal

- VirusTotal — artisyn-hooks-installer.tgz: ✅ pass · 0/75 engines · [report](https://www.virustotal.com/gui/file/8a61fb75d0b7c479dfb4ed0303691c1538d4a98a4bbe9f032e39177bd53c4ce0)
- VirusTotal — hooks.tar.gz: ✅ pass · 0/75 engines · [report](https://www.virustotal.com/gui/file/346541dc059d7a5b7e168f3f9554a559ed6228ff976174c13aa9d346f48bbbe1)

## More

- [Code scanning alerts](https://github.com/DataArt/artisyn-log-hub/security/code-scanning) — Snyk and zizmor findings with file and line
- [Dependabot alerts](https://github.com/DataArt/artisyn-log-hub/security/dependabot)
