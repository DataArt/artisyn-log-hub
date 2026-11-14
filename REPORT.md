# Security scan report

_Commit [`a55bb28`](https://github.com/DataArt/artisyn-log-hub/commit/a55bb2887b804286c822e0cd64a902cdce3f75ea) on `main` · updated 2026-11-14 10:20 UTC · [workflow run](https://github.com/DataArt/artisyn-log-hub/actions/runs/43584557463)_

The README badge counts every row below except Snyk Open Source (dev) — devDependencies do not
ship — and skipped rows. How the scans work: [ci-security-scans.md](https://github.com/DataArt/artisyn-log-hub/blob/main/docs/knowledgebase/ci-security-scans.md).

## Summary

| Tool | Status | Critical | High | Medium | Low | Details |
|---|---|---|---|---|---|---|
| Snyk Open Source (prod) | ✅ pass | 0 | 0 | 2 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43584557463) 2 medium |
| Snyk Open Source (dev) | ✅ pass | 0 | 0 | 5 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43584557463) 5 medium |
| Snyk — installer tarballs | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43584557463) no issues |
| Executable-config guard | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43584557463) |
| Lock-file registry | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43584557463) ok |
| npm registry signatures | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43584557463) ok |
| actionlint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43584557463) ok |
| zizmor | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43584557463) no issues |
| hadolint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43584557463) no issues |
| docker compose config | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43584557463) ok |
| Snyk Container | ✅ pass | 0 | 0 | 0 | 1 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43584557463) 1 low |
| Node runtime (Dockerfile) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43584557463) 26.13.1 is the latest patch |
| Node runtime (docker-dev) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/43584557463) 26.13.1 is the latest patch |
| VirusTotal — artisyn-hooks-installer.tgz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/ecbfb7a24de996e6fba132555e7e98d3a610c9330c1a98e067f65d0c2caa4e04) 0/75 engines |
| VirusTotal — hooks.tar.gz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/d8c319ca3d9f2f54fcc986aad5b8fe7f31167d13ab123f47e043f9195d091978) 0/75 engines |

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

- VirusTotal — artisyn-hooks-installer.tgz: ✅ pass · 0/75 engines · [report](https://www.virustotal.com/gui/file/ecbfb7a24de996e6fba132555e7e98d3a610c9330c1a98e067f65d0c2caa4e04)
- VirusTotal — hooks.tar.gz: ✅ pass · 0/75 engines · [report](https://www.virustotal.com/gui/file/d8c319ca3d9f2f54fcc986aad5b8fe7f31167d13ab123f47e043f9195d091978)

## More

- [Code scanning alerts](https://github.com/DataArt/artisyn-log-hub/security/code-scanning) — Snyk and zizmor findings with file and line
- [Dependabot alerts](https://github.com/DataArt/artisyn-log-hub/security/dependabot)
