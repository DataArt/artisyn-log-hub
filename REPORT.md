# Security scan report

_Commit [`f775409`](https://github.com/DataArt/artisyn-log-hub/commit/f7754094bc454b2abc26204be030f21d64b4e832) on `main` · updated 2026-11-25 12:48 UTC · [workflow run](https://github.com/DataArt/artisyn-log-hub/actions/runs/45616906317)_

The README badge counts every row below except Snyk Open Source (dev) — devDependencies do not
ship — and skipped rows. How the scans work: [ci-security-scans.md](https://github.com/DataArt/artisyn-log-hub/blob/main/docs/knowledgebase/ci-security-scans.md).

## Summary

| Tool | Status | Critical | High | Medium | Low | Details |
|---|---|---|---|---|---|---|
| Snyk Open Source (prod) | ✅ pass | 0 | 0 | 2 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45616906317) 2 medium |
| Snyk Open Source (dev) | ✅ pass | 0 | 0 | 5 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45616906317) 5 medium |
| Snyk — installer tarballs | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45616906317) no issues |
| Executable-config guard | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45616906317) |
| Lock-file registry | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45616906317) ok |
| npm registry signatures | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45616906317) ok |
| actionlint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45616906317) ok |
| zizmor | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45616906317) no issues |
| hadolint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45616906317) no issues |
| docker compose config | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45616906317) ok |
| Snyk Container | ✅ pass | 0 | 0 | 0 | 6 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45616906317) 6 low |
| Node runtime (Dockerfile) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45616906317) 26.13.1 is the latest patch |
| Node runtime (docker-dev) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45616906317) 26.13.1 is the latest patch |
| VirusTotal — artisyn-hooks-installer.tgz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/7a26ebd23bfe814342daaebb49219825524447b19b4d929d494d97840f2a671a) 0/74 engines |
| VirusTotal — hooks.tar.gz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/1d3c627dba8865e6457a37fcc0df7d03f025b4608a7e5d6d764091dfaf7e45fc) 0/74 engines |

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

- VirusTotal — artisyn-hooks-installer.tgz: ✅ pass · 0/74 engines · [report](https://www.virustotal.com/gui/file/7a26ebd23bfe814342daaebb49219825524447b19b4d929d494d97840f2a671a)
- VirusTotal — hooks.tar.gz: ✅ pass · 0/74 engines · [report](https://www.virustotal.com/gui/file/1d3c627dba8865e6457a37fcc0df7d03f025b4608a7e5d6d764091dfaf7e45fc)

## More

- [Code scanning alerts](https://github.com/DataArt/artisyn-log-hub/security/code-scanning) — Snyk and zizmor findings with file and line
- [Dependabot alerts](https://github.com/DataArt/artisyn-log-hub/security/dependabot)
