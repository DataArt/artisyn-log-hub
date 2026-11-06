# Security scan report

_Commit [`28e98e8`](https://github.com/DataArt/artisyn-log-hub/commit/28e98e871560145d3b6c260d1de4f3420fd05bf4) on `main` · updated 2026-11-06 19:38 UTC · [workflow run](https://github.com/DataArt/artisyn-log-hub/actions/runs/42281205201)_

The README badge counts every row below except Snyk Open Source (dev) — devDependencies do not
ship — and skipped rows. How the scans work: [ci-security-scans.md](https://github.com/DataArt/artisyn-log-hub/blob/main/docs/knowledgebase/ci-security-scans.md).

## Summary

| Tool | Status | Critical | High | Medium | Low | Details |
|---|---|---|---|---|---|---|
| Snyk Open Source (prod) | ✅ pass | 0 | 0 | 2 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42281205201) 2 medium |
| Snyk Open Source (dev) | ✅ pass | 0 | 1 | 5 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42281205201) 1 high, 5 medium |
| Snyk — installer tarballs | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42281205201) no issues |
| Executable-config guard | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42281205201) |
| Lock-file registry | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42281205201) ok |
| npm registry signatures | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42281205201) ok |
| actionlint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42281205201) ok |
| zizmor | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42281205201) no issues |
| hadolint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42281205201) no issues |
| docker compose config | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42281205201) ok |
| Snyk Container | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42205389510) as of 2026-11-06 10:50 UTC: no issues |
| Node runtime (Dockerfile) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42281205201) 26.13.0 is the latest patch |
| Node runtime (docker-dev) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/42281205201) 26.13.0 is the latest patch |
| VirusTotal — artisyn-hooks-installer.tgz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/f9963a7e696166a877465c4b4481bf1de264764a13198cffedcfda6c97e6748f) as of 2026-11-06 10:50 UTC: 0/75 engines |
| VirusTotal — hooks.tar.gz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/cbbe56d1260f69a9d61e473d346f6533767b1e1c4fa5ddcc4cc12569ed62264b) as of 2026-11-06 10:50 UTC: 0/75 engines |

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

- VirusTotal — artisyn-hooks-installer.tgz: ✅ pass · as of 2026-11-06 10:50 UTC: 0/75 engines · [report](https://www.virustotal.com/gui/file/f9963a7e696166a877465c4b4481bf1de264764a13198cffedcfda6c97e6748f)
- VirusTotal — hooks.tar.gz: ✅ pass · as of 2026-11-06 10:50 UTC: 0/75 engines · [report](https://www.virustotal.com/gui/file/cbbe56d1260f69a9d61e473d346f6533767b1e1c4fa5ddcc4cc12569ed62264b)

## More

- [Code scanning alerts](https://github.com/DataArt/artisyn-log-hub/security/code-scanning) — Snyk and zizmor findings with file and line
- [Dependabot alerts](https://github.com/DataArt/artisyn-log-hub/security/dependabot)
