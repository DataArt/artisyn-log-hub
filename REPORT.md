# Security scan report

_Commit [`8b52be6`](https://github.com/DataArt/artisyn-log-hub/commit/8b52be66c68111536d46816144b9c495fbd338e4) on `main` · updated 2026-10-29 09:55 UTC · [workflow run](https://github.com/DataArt/artisyn-log-hub/actions/runs/40853147854)_

The README badge counts every row below except Snyk Open Source (dev) — devDependencies do not
ship — and skipped rows. How the scans work: [ci-security-scans.md](https://github.com/DataArt/artisyn-log-hub/blob/main/docs/knowledgebase/ci-security-scans.md).

## Summary

| Tool | Status | Critical | High | Medium | Low | Details |
|---|---|---|---|---|---|---|
| Snyk Open Source (prod) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40853147854) no issues |
| Snyk Open Source (dev) | ❌ findings | 0 | 2 | 4 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40853147854) 2 fixable high/critical |
| Snyk — installer tarballs | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40853147854) no issues |
| Executable-config guard | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40853147854) |
| Lock-file registry | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40853147854) ok |
| npm registry signatures | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40853147854) ok |
| actionlint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40853147854) ok |
| zizmor | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40853147854) no issues |
| hadolint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40853147854) no issues |
| docker compose config | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40853147854) ok |
| Snyk Container | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40853147854) no issues |
| Node runtime (Dockerfile) | ⚠️ warning | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40853147854) 24.22.1  24.22.2 |
| Node runtime (docker-dev) | ⚠️ warning | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40853147854) 24.22.1  24.22.2 |
| VirusTotal — artisyn-hooks-installer.tgz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/aadf3e3a86eb60eca1006f5bb2a53a19e2f9d34537a62b0dcadb356df818a3cb) 0/75 engines |
| VirusTotal — hooks.tar.gz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/fcdc2fdd8c84b135d96f1827dc8d3d7895002a820f8b5cab8337d39406c14975) 0/75 engines |

## Snyk — critical and high issues

### Snyk Open Source (prod)

_No critical or high issues._

### Snyk Open Source (dev)

| Severity | Issue | Package | Fixed in | Project |
|---|---|---|---|---|
| high | [SNYK-JS-PICOMATCH-21248802](https://security.snyk.io/vuln/SNYK-JS-PICOMATCH-21248802) Regular Expression Denial of Service (ReDoS) | `picomatch@4.0.7` | no fix yet | `client/package.json` |
| high | [SNYK-JS-URIJS-19963963](https://security.snyk.io/vuln/SNYK-JS-URIJS-19963963) Infinite loop | `uri-js@4.4.1` | no fix yet | `client/package.json` |

### Snyk — installer tarballs

_No critical or high issues._

### Snyk Container

_No critical or high issues._

## VirusTotal

- VirusTotal — artisyn-hooks-installer.tgz: ✅ pass · 0/75 engines · [report](https://www.virustotal.com/gui/file/aadf3e3a86eb60eca1006f5bb2a53a19e2f9d34537a62b0dcadb356df818a3cb)
- VirusTotal — hooks.tar.gz: ✅ pass · 0/75 engines · [report](https://www.virustotal.com/gui/file/fcdc2fdd8c84b135d96f1827dc8d3d7895002a820f8b5cab8337d39406c14975)

## More

- [Code scanning alerts](https://github.com/DataArt/artisyn-log-hub/security/code-scanning) — Snyk and zizmor findings with file and line
- [Dependabot alerts](https://github.com/DataArt/artisyn-log-hub/security/dependabot)
