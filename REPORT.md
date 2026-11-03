# Security scan report

_Commit [`dd39252`](https://github.com/DataArt/artisyn-log-hub/commit/dd3925224c1e4950e0294df73724f1ae43a64e2a) on `main` · updated 2026-11-03 14:44 UTC · [workflow run](https://github.com/DataArt/artisyn-log-hub/actions/runs/41656412545)_

The README badge counts every row below except Snyk Open Source (dev) — devDependencies do not
ship — and skipped rows. How the scans work: [ci-security-scans.md](https://github.com/DataArt/artisyn-log-hub/blob/main/docs/knowledgebase/ci-security-scans.md).

## Summary

| Tool | Status | Critical | High | Medium | Low | Details |
|---|---|---|---|---|---|---|
| Snyk Open Source (prod) | ✅ pass | 0 | 0 | 1 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41656412545) 1 medium |
| Snyk Open Source (dev) | ✅ pass | 0 | 1 | 5 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41656412545) 1 high, 5 medium |
| Snyk — installer tarballs | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41656412545) no issues |
| Executable-config guard | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41656412545) |
| Lock-file registry | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41656412545) ok |
| npm registry signatures | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41656412545) ok |
| actionlint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41656412545) ok |
| zizmor | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41656412545) no issues |
| hadolint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41656412545) no issues |
| docker compose config | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41656412545) ok |
| Snyk Container | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41622049803) as of 2026-11-03 10:48 UTC: no issues |
| Node runtime (Dockerfile) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41656412545) 26.13.0 is the latest patch |
| Node runtime (docker-dev) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41656412545) 26.13.0 is the latest patch |
| VirusTotal — artisyn-hooks-installer.tgz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/59be8d358d7efb47a921302033aac3e13f355b548419387a7c9e63684af2b9b9) as of 2026-11-03 10:48 UTC: 0/75 engines |
| VirusTotal — hooks.tar.gz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/979f22ef1f383799a56ea9adf26ab954e020c57f4d3cb4c89d5679aae76820c2) as of 2026-11-03 10:48 UTC: 0/75 engines |

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

- VirusTotal — artisyn-hooks-installer.tgz: ✅ pass · as of 2026-11-03 10:48 UTC: 0/75 engines · [report](https://www.virustotal.com/gui/file/59be8d358d7efb47a921302033aac3e13f355b548419387a7c9e63684af2b9b9)
- VirusTotal — hooks.tar.gz: ✅ pass · as of 2026-11-03 10:48 UTC: 0/75 engines · [report](https://www.virustotal.com/gui/file/979f22ef1f383799a56ea9adf26ab954e020c57f4d3cb4c89d5679aae76820c2)

## More

- [Code scanning alerts](https://github.com/DataArt/artisyn-log-hub/security/code-scanning) — Snyk and zizmor findings with file and line
- [Dependabot alerts](https://github.com/DataArt/artisyn-log-hub/security/dependabot)
