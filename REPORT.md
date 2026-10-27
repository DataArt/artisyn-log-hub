# Security scan report

_Commit [`0453f0d`](https://github.com/DataArt/artisyn-log-hub/commit/0453f0dddb4472d0fea0e69561ff4034837e8bcc) on `main` · updated 2026-10-27 12:08 UTC · [workflow run](https://github.com/DataArt/artisyn-log-hub/actions/runs/40501237723)_

The README badge counts every row below except Snyk Open Source (dev) — devDependencies do not
ship — and skipped rows. How the scans work: [ci-security-scans.md](https://github.com/DataArt/artisyn-log-hub/blob/main/docs/knowledgebase/ci-security-scans.md).

## Summary

| Tool | Status | Critical | High | Medium | Low | Details |
|---|---|---|---|---|---|---|
| Snyk Open Source (prod) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40501237723) no issues |
| Snyk Open Source (dev) | ❌ findings | 1 | 13 | 14 | 1 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40501237723) 11 fixable high/critical |
| Snyk — installer tarballs | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40501237723) no issues |
| Executable-config guard | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40501237723) |
| Lock-file registry | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40501237723) ok |
| npm registry signatures | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40501237723) ok |
| actionlint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40501237723) ok |
| zizmor | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40501237723) no issues |
| hadolint | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40501237723) no issues |
| docker compose config | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40501237723) ok |
| Snyk Container | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40476901952) as of 2026-10-27 08:56 UTC: no issues |
| Node runtime (Dockerfile) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40501237723) 24.22.1 is the latest patch |
| Node runtime (docker-dev) | ✅ pass | 0 | 0 | 0 | 0 | [link](https://github.com/DataArt/artisyn-log-hub/actions/runs/40501237723) 24.22.1 is the latest patch |
| VirusTotal — artisyn-hooks-installer.tgz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/089e7d2598946bb78427a426f91f4bbbf61cf9323be976a5bf4f10dcaa3ea3f9) as of 2026-10-27 08:56 UTC: 0/75 engines |
| VirusTotal — hooks.tar.gz | ✅ pass | 0 | 0 | 0 | 0 | [link](https://www.virustotal.com/gui/file/e56503a752c8f0713c84d8c07043b17e1d30a108ee90d8b2695f94c2998e549e) as of 2026-10-27 08:56 UTC: 0/75 engines |

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

- VirusTotal — artisyn-hooks-installer.tgz: ✅ pass · as of 2026-10-27 08:56 UTC: 0/75 engines · [report](https://www.virustotal.com/gui/file/089e7d2598946bb78427a426f91f4bbbf61cf9323be976a5bf4f10dcaa3ea3f9)
- VirusTotal — hooks.tar.gz: ✅ pass · as of 2026-10-27 08:56 UTC: 0/75 engines · [report](https://www.virustotal.com/gui/file/e56503a752c8f0713c84d8c07043b17e1d30a108ee90d8b2695f94c2998e549e)

## More

- [Code scanning alerts](https://github.com/DataArt/artisyn-log-hub/security/code-scanning) — Snyk and zizmor findings with file and line
- [Dependabot alerts](https://github.com/DataArt/artisyn-log-hub/security/dependabot)
