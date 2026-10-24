# Security scan report

_Commit [`8975ec5`](https://github.com/DataArt/artisyn-log-hub/commit/8975ec51feee178dbb73c69614935b608e116626) on `main` · updated 2026-10-24 15:30 UTC · [workflow run](https://github.com/DataArt/artisyn-log-hub/actions/runs/40107128729)_

The README badge counts every row below except Snyk Open Source (dev) — devDependencies do not
ship — and skipped rows. How the scans work: [ci-security-scans.md](https://github.com/DataArt/artisyn-log-hub/blob/main/docs/knowledgebase/ci-security-scans.md).

## Summary

| Tool | Status | Critical | High | Medium | Low | Details |
|---|---|---|---|---|---|---|
| Snyk Open Source (prod) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40107128729) no issues |
| Snyk Open Source (dev) | ❌ findings | 1 | 13 | 14 | 1 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40107128729) 11 fixable high/critical |
| Snyk — installer tarballs | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40107128729) no issues |
| Executable-config guard | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40107128729) |
| Lock-file registry | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40107128729) ok |
| npm registry signatures | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40107128729) ok |
| actionlint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40107128729) ok |
| zizmor | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40107128729) no issues |
| hadolint | ⚠️ warning | 0 | 0 | 20 | 4 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40107128729) 20 medium, 4 low: DL3016, DL3003, DL3008, DL4006, SC2010 |
| docker compose config | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40107128729) ok |
| Snyk Container | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40107128729) no issues |
| Node runtime (Dockerfile) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40107128729) 24.22.1 is the latest patch |
| Node runtime (docker-dev) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40107128729) 24.22.1 is the latest patch |
| VirusTotal — artisyn-hooks-installer.tgz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/d82efdfdd12004d4e6cb5675e92c4d436bd70e418279dd955e858f85bd1722c9) 0/75 engines |
| VirusTotal — hooks.tar.gz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/74f54ca8e38af6896acc493eb193c84029b41e4193e78a02ab1ff66ff358ac79) 0/75 engines |

## Snyk — critical and high issues

### Snyk Open Source (prod)

_No critical or high issues._

### Snyk Open Source (dev)

| Severity | Issue | Package | Fixed in | Project |
|---|---|---|---|---|
| critical | [SNYK-JS-ESBUILD-17750822](https://security.snyk.io/vuln/SNYK-JS-ESBUILD-17750822) Resources Downloaded over Insecure Protocol | `esbuild@0.18.20` | 0.28.1 | `server/package-lock.json` |
| high | [SNYK-JS-VITESTMOCKER-21347793](https://security.snyk.io/vuln/SNYK-JS-VITESTMOCKER-21347793) Directory Traversal | `@vitest/mocker@4.1.11` | 4.1.12 | `client/package.json` |
| high | [SNYK-JS-BRACEEXPANSION-17706650](https://security.snyk.io/vuln/SNYK-JS-BRACEEXPANSION-17706650) Inefficient Algorithmic Complexity | `brace-expansion@1.1.15` | 1.1.16, 2.1.2, 5.0.7 | `package-lock.json` |
| high | [SNYK-JS-BRACEEXPANSION-18313044](https://security.snyk.io/vuln/SNYK-JS-BRACEEXPANSION-18313044) Allocation of Resources Without Limits or Throttling | `brace-expansion@1.1.15` | 1.1.16, 2.1.2, 5.0.8 | `package-lock.json` |
| high | [SNYK-JS-BRACEEXPANSION-18512280](https://security.snyk.io/vuln/SNYK-JS-BRACEEXPANSION-18512280) Allocation of Resources Without Limits or Throttling | `brace-expansion@1.1.15` | 1.1.18, 2.1.4, 3.0.6, 5.0.9 | `package-lock.json` |
| high | [SNYK-JS-BRACEEXPANSION-20244948](https://security.snyk.io/vuln/SNYK-JS-BRACEEXPANSION-20244948) Uncontrolled Recursion | `brace-expansion@1.1.15` | 1.1.20, 2.1.6, 3.0.8, 5.0.11 | `package-lock.json` |
| high | [SNYK-JS-BRACEEXPANSION-20244952](https://security.snyk.io/vuln/SNYK-JS-BRACEEXPANSION-20244952) Uncontrolled Recursion | `brace-expansion@1.1.15` | 1.1.19, 2.1.5, 3.0.7, 5.0.10 | `package-lock.json` |
| high | [SNYK-JS-JSYAML-17900054](https://security.snyk.io/vuln/SNYK-JS-JSYAML-17900054) Inefficient Algorithmic Complexity | `js-yaml@4.1.1` | 3.15.0, 4.3.0 | `hook/package-lock.json` |
| high | [SNYK-JS-JSYAML-18593780](https://security.snyk.io/vuln/SNYK-JS-JSYAML-18593780) Inefficient Algorithmic Complexity | `js-yaml@4.1.1` | 3.15.1, 4.3.1 | `hook/package-lock.json` |
| high | [SNYK-JS-JSYAML-19496768](https://security.snyk.io/vuln/SNYK-JS-JSYAML-19496768) Allocation of Resources Without Limits or Throttling | `js-yaml@4.1.1` | 3.15.2, 4.3.2 | `hook/package-lock.json` |
| high | [SNYK-JS-PICOMATCH-21248802](https://security.snyk.io/vuln/SNYK-JS-PICOMATCH-21248802) Regular Expression Denial of Service (ReDoS) | `picomatch@4.0.7` | no fix yet | `client/package.json` |
| high | [SNYK-JS-POSTCSSSELECTORPARSER-20510276](https://security.snyk.io/vuln/SNYK-JS-POSTCSSSELECTORPARSER-20510276) Inefficient Algorithmic Complexity | `postcss-selector-parser@6.0.10` | 6.1.5, 7.1.6 | `client/package.json` |
| high | [SNYK-JS-QS-20943482](https://security.snyk.io/vuln/SNYK-JS-QS-20943482) Uncaught Exception | `qs@6.15.1` | 6.16.1 | `server/package-lock.json` |
| high | [SNYK-JS-URIJS-19963963](https://security.snyk.io/vuln/SNYK-JS-URIJS-19963963) Infinite loop | `uri-js@4.4.1` | no fix yet | `client/package.json` |

### Snyk — installer tarballs

_No critical or high issues._

### Snyk Container

_No critical or high issues._

## VirusTotal

- VirusTotal — artisyn-hooks-installer.tgz: ✅ pass · 0/75 engines · [report](https://www.virustotal.com/gui/file/d82efdfdd12004d4e6cb5675e92c4d436bd70e418279dd955e858f85bd1722c9)
- VirusTotal — hooks.tar.gz: ✅ pass · 0/75 engines · [report](https://www.virustotal.com/gui/file/74f54ca8e38af6896acc493eb193c84029b41e4193e78a02ab1ff66ff358ac79)

## More

- [Code scanning alerts](https://github.com/DataArt/artisyn-log-hub/security/code-scanning) — Snyk and zizmor findings with file and line
- [Dependabot alerts](https://github.com/DataArt/artisyn-log-hub/security/dependabot)
