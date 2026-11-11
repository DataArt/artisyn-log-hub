# Security scan report

_Commit [`3ab64d6`](https://github.com/DataArt/artisyn-log-hub/commit/3ab64d64cb5be07852a988c4d50cff39faf184d8) on `main` · updated 2026-11-11 10:53 UTC · [workflow run](https://github.com/DataArt/artisyn-log-hub/actions/runs/43006953925)_

The README badge counts every row below except Snyk Open Source (dev) — devDependencies do not
ship — and skipped rows. How the scans work: [ci-security-scans.md](https://github.com/DataArt/artisyn-log-hub/blob/main/docs/knowledgebase/ci-security-scans.md).

## Summary

| Tool | Status | Critical | High | Medium | Low | Details |
|---|---|---|---|---|---|---|
| Snyk Open Source (prod) | ❌ findings | 0 | 2 | 2 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43006953925) 1 fixable high/critical |
| Snyk Open Source (dev) | ❌ findings | 0 | 3 | 5 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43006953925) 1 fixable high/critical |
| Snyk — installer tarballs | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43006953925) no issues |
| Executable-config guard | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43006953925) |
| Lock-file registry | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43006953925) ok |
| npm registry signatures | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43006953925) ok |
| actionlint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43006953925) ok |
| zizmor | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43006953925) no issues |
| hadolint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43006953925) no issues |
| docker compose config | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43006953925) ok |
| Snyk Container | ✅ pass | 0 | 0 | 0 | 1 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43006953925) 1 low |
| Node runtime (Dockerfile) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43006953925) 26.13.0 is the latest patch |
| Node runtime (docker-dev) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43006953925) 26.13.0 is the latest patch |
| VirusTotal — artisyn-hooks-installer.tgz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/00ddde5abfbd9dc8736906fe87a5da3b913ad9835a75d8e57aa77781f6d4a9f4) 0/75 engines |
| VirusTotal — hooks.tar.gz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/3c4c1b6ec1c48407e7854f367e88a03865938f86d701cfc25c7db22cbc8a4fab) 0/75 engines |

## Snyk — critical and high issues

### Snyk Open Source (prod)

| Severity | Issue | Package | Fixed in | Project |
|---|---|---|---|---|
| high | [SNYK-JS-FFLATE-22392372](https://security.snyk.io/vuln/SNYK-JS-FFLATE-22392372) Memory Allocation with Excessive Size Value | `fflate@0.8.3` | no fix yet | `client/package.json` |
| high | [SNYK-JS-NODEMAILER-22409044](https://security.snyk.io/vuln/SNYK-JS-NODEMAILER-22409044) Interpretation Conflict | `nodemailer@10.2.1` | 10.4.1 | `server/package-lock.json` |

### Snyk Open Source (dev)

| Severity | Issue | Package | Fixed in | Project |
|---|---|---|---|---|
| high | [SNYK-JS-FFLATE-22392372](https://security.snyk.io/vuln/SNYK-JS-FFLATE-22392372) Memory Allocation with Excessive Size Value | `fflate@0.8.3` | no fix yet | `client/package.json` |
| high | [SNYK-JS-NODEMAILER-22409044](https://security.snyk.io/vuln/SNYK-JS-NODEMAILER-22409044) Interpretation Conflict | `nodemailer@10.2.1` | 10.4.1 | `server/package-lock.json` |
| high | [SNYK-JS-URIJS-19963963](https://security.snyk.io/vuln/SNYK-JS-URIJS-19963963) Infinite loop | `uri-js@4.4.1` | no fix yet | `client/package.json` |

### Snyk — installer tarballs

_No critical or high issues._

### Snyk Container

_No critical or high issues._

## VirusTotal

- VirusTotal — artisyn-hooks-installer.tgz: ✅ pass · 0/75 engines · [report](https://www.virustotal.com/gui/file/00ddde5abfbd9dc8736906fe87a5da3b913ad9835a75d8e57aa77781f6d4a9f4)
- VirusTotal — hooks.tar.gz: ✅ pass · 0/75 engines · [report](https://www.virustotal.com/gui/file/3c4c1b6ec1c48407e7854f367e88a03865938f86d701cfc25c7db22cbc8a4fab)

## More

- [Code scanning alerts](https://github.com/DataArt/artisyn-log-hub/security/code-scanning) — Snyk and zizmor findings with file and line
- [Dependabot alerts](https://github.com/DataArt/artisyn-log-hub/security/dependabot)
