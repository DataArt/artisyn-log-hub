# Security scan report

_Commit [`0d49889`](https://github.com/DataArt/artisyn-log-hub/commit/0d498893f1433797af1138b20fa35ef061949d58) on `main` · updated 2026-11-27 12:11 UTC · [workflow run](https://github.com/DataArt/artisyn-log-hub/actions/runs/45996198616)_

The README badge counts every row below except Snyk Open Source (dev) — devDependencies do not
ship — and skipped rows. How the scans work: [ci-security-scans.md](https://github.com/DataArt/artisyn-log-hub/blob/main/docs/knowledgebase/ci-security-scans.md).

## Summary

| Tool | Status | Critical | High | Medium | Low | Details |
|---|---|---|---|---|---|---|
| Snyk Open Source (prod) | ✅ pass | 0 | 0 | 2 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45996198616) 2 medium |
| Snyk Open Source (dev) | ✅ pass | 0 | 0 | 5 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45996198616) 5 medium |
| Snyk — installer tarballs | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45996198616) no issues |
| Executable-config guard | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45996198616) |
| Lock-file registry | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45996198616) ok |
| npm registry signatures | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45996198616) ok |
| actionlint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45996198616) ok |
| zizmor | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45996198616) no issues |
| hadolint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45996198616) no issues |
| docker compose config | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45996198616) ok |
| Snyk Container | ✅ pass | 0 | 0 | 0 | 6 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45996198616) 6 low |
| Node runtime (Dockerfile) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45996198616) 26.13.1 is the latest patch |
| Node runtime (docker-dev) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/45996198616) 26.13.1 is the latest patch |
| VirusTotal — artisyn-hooks-installer.tgz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/d235baa2a5eabafcc93df366b997143d1bed45bad85bf8eda167b21174692729) 0/74 engines |
| VirusTotal — hooks.tar.gz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/7edd469bc7b1ce86bdcf27fed6abfb5c09988b71004743f337a5e7ba639af47a) 0/74 engines |

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

- VirusTotal — artisyn-hooks-installer.tgz: ✅ pass · 0/74 engines · [report](https://www.virustotal.com/gui/file/d235baa2a5eabafcc93df366b997143d1bed45bad85bf8eda167b21174692729)
- VirusTotal — hooks.tar.gz: ✅ pass · 0/74 engines · [report](https://www.virustotal.com/gui/file/7edd469bc7b1ce86bdcf27fed6abfb5c09988b71004743f337a5e7ba639af47a)

## More

- [Code scanning alerts](https://github.com/DataArt/artisyn-log-hub/security/code-scanning) — Snyk and zizmor findings with file and line
- [Dependabot alerts](https://github.com/DataArt/artisyn-log-hub/security/dependabot)
