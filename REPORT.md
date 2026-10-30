# Security scan report

_Commit [`b61f344`](https://github.com/DataArt/artisyn-log-hub/commit/b61f344612fd97780d58a63daae9816957eec40f) on `main` · updated 2026-10-30 09:58 UTC · [workflow run](https://github.com/DataArt/artisyn-log-hub/actions/runs/41037085587)_

The README badge counts every row below except Snyk Open Source (dev) — devDependencies do not
ship — and skipped rows. How the scans work: [ci-security-scans.md](https://github.com/DataArt/artisyn-log-hub/blob/main/docs/knowledgebase/ci-security-scans.md).

## Summary

| Tool | Status | Critical | High | Medium | Low | Details |
|---|---|---|---|---|---|---|
| Snyk Open Source (prod) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41037085587) no issues |
| Snyk Open Source (dev) | ❌ findings | 0 | 2 | 4 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41037085587) 2 fixable high/critical |
| Snyk — installer tarballs | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41037085587) no issues |
| Executable-config guard | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41037085587) |
| Lock-file registry | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41037085587) ok |
| npm registry signatures | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41037085587) ok |
| actionlint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41037085587) ok |
| zizmor | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41037085587) no issues |
| hadolint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41037085587) no issues |
| docker compose config | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41037085587) ok |
| Snyk Container | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41037085587) no issues |
| Node runtime (Dockerfile) | ⚠️ warning | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41037085587) 24.22.1  24.22.2 |
| Node runtime (docker-dev) | ⚠️ warning | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/41037085587) 24.22.1  24.22.2 |
| VirusTotal — artisyn-hooks-installer.tgz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/16feb9f22dc013a6faa9cff17da0c222547f4fae0a75dfd7f8248da3bfb421ef) 0/75 engines |
| VirusTotal — hooks.tar.gz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/24fa647640e9806f2208ae886ea6d0c409bbac3ce14dc401647ac98518dfc19d) 0/75 engines |

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

- VirusTotal — artisyn-hooks-installer.tgz: ✅ pass · 0/75 engines · [report](https://www.virustotal.com/gui/file/16feb9f22dc013a6faa9cff17da0c222547f4fae0a75dfd7f8248da3bfb421ef)
- VirusTotal — hooks.tar.gz: ✅ pass · 0/75 engines · [report](https://www.virustotal.com/gui/file/24fa647640e9806f2208ae886ea6d0c409bbac3ce14dc401647ac98518dfc19d)

## More

- [Code scanning alerts](https://github.com/DataArt/artisyn-log-hub/security/code-scanning) — Snyk and zizmor findings with file and line
- [Dependabot alerts](https://github.com/DataArt/artisyn-log-hub/security/dependabot)
