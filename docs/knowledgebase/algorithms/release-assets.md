---
reviewed: no
reviewer: none
---

# Release assets: install kit, checksums, release notes and VirusTotal scopes

## Purpose

Decides what a GitHub Release ships and what its page says: which install-kit files are filled
with the version and which are copied byte for byte, the `SHA256SUMS` file people verify their
download with, and the release notes with the change list and the per-file VirusTotal verdict.
A wrong rule here ships an installer that pulls the wrong image, a checksum file `sha256sum -c`
rejects, or a VirusTotal cell that claims a file was scanned when it was not.

## Code

- Implementation:
  - `scripts/release-kit.js` (`kitFiles`, `sha256sums`); its CLI is the `kit` job of
    `.github/workflows/release.yml`, which reads `release-template/` and writes the loose files,
    the zip and `SHA256SUMS`.
  - `scripts/ci/release-notes.js` (`renderNotes`, `parseSums`, `parseChangelogEntry`,
    `renderChanges`); its CLI is the `publish` job, which also writes the `CHANGES.md` asset.
  - `scripts/ci/virustotal-scan.js` (`scopeFor`); its CLI is the `vt-scan` job (and the PR
    security scans for the installer tarballs).
- Twins: none. `generateReleaseEnv` (also in `release-kit.js`) is random and has no rows.
- Test: `scripts/__tests__/release-assets.algo.test.js` (`npm run test:scripts`).

## Rules

**`kitFiles(templates, {version, commit})`**: `templates` maps a `release-template/` file name
to its text. The result is one `{name, zipName, content}` per entry of `KIT_LAYOUT`, in this
order:

| Template | `name` (loose asset) | `zipName` | Placeholders filled |
|---|---|---|---|
| `INSTALL.md` | `README.md` | `README.md` | yes |
| `docker-compose.yml` | `docker-compose.yml` | `docker-compose.yml` | yes |
| `.env.example` | `env.example` | `.env.example` | no |
| `install.sh` | `install.sh` | `install.sh` | no |
| `install.ps1` | `install.ps1` | `install.ps1` | no |

1. "Filled" replaces every occurrence of `{{VERSION}}` with `version` and of `{{GIT_COMMIT}}`
   with `commit`; other text, including unknown `{{…}}` placeholders, is unchanged. Unfilled
   files are returned exactly as given, placeholders included.
2. The loose asset `env.example` has no leading dot, because GitHub renames release assets whose
   names start with `.`; inside the zip it is `.env.example` again.
3. Any other template (e.g. `LOCAL-BUNDLE.md`, which belongs to the local test bundle) is never
   shipped.
4. A missing template throws `release-template/<file> is missing`.

**`sha256sums(files)`**: `files` is `[{name, content}]`. One line `<sha256 hex of content>  <name>\n`
per file (two spaces, the `sha256sum -c` text format), sorted by `name` in plain code-unit order
(uppercase before lowercase). An empty list gives `''`.

**`parseSums(text)`**: splits on `\n` or `\r\n`, trims each line and keeps the lines matching
`^([0-9a-f]{64}) [ *]?(.+)$` (case-insensitive): one space, then an optional second space or a
binary-mode `*`, then the name. Returns `[{name, sha256}]` in file order with the hex lowercased;
blank and malformed lines are skipped.

**`scopeFor(name)`** maps a file base name to the VirusTotal row scope:

- `artisyn-hooks-installer.tgz` -> `installer-tgz`
- `hooks.tar.gz` -> `hooks-tgz`
- `artisyn-log-hub-X.Y.Z.zip` with three integer fields (`^artisyn-log-hub-\d+\.\d+\.\d+\.zip$`)
  -> `release-zip`
- `install.sh` -> `install-sh`
- `install.ps1` -> `install-ps1`
- anything else -> `null` (the CLI turns it into a usage error).

**`renderNotes({version, tag, previousTag, repo, entries, commits, digest, sums, rows})`**:
`entries` are the changelog files (see "Changelog entry lines" below), `commits` is
`[{sha, subject}]` newest first, `sums` is the `parseSums` list, `rows` the VirusTotal rows
`{scope, status, note, link?}`. `IMAGE` is `ghcr.io/dataart/artisyn-log-hub`, `COMMIT_CAP` is 500.
The human-readable changelog comes first; the raw commit list is folded away. Lines, joined
with `\n`:

1. `## What's new`, then the changelog entry lines with marker `###`.
2. An empty line, `## Commits`, an empty line.
3. No commits: `No commits.` Otherwise `<details>`, `<summary><n> commits</summary>` (`1 commit`
   for one), an empty line, then one `- <subject> (<sha>)` line for each of the first
   `COMMIT_CAP` commits; when there are more, one more line `- […and <n> more](<href>)` with
   `n` = commits − 500 and `href` = `https://github.com/<repo>/compare/<previousTag>...<tag>`, or
   `https://github.com/<repo>/commits/<tag>` when `previousTag` is empty (first release); then an
   empty line and `</details>`.
4. An empty line, `## Security scan`, an empty line.
5. ``Image `<IMAGE>:<version>`, digest `<digest>`.``, an empty line.
6. `| File | SHA-256 | VirusTotal |`, `|---|---|---|`, then per sums entry, in sums order:
   ``| `<name>` | `<sha256>` | <cell> |``. In the name and the cell, `|` becomes `\|` and line
   breaks become spaces.
7. An empty line, `Verify the downloaded files and the image:`, an empty line, then the fenced
   `sh` block with `sha256sum -c SHA256SUMS --ignore-missing` (the reader rarely downloads every
   file), `gh attestation verify <file> -R <repo>` and
   `gh attestation verify oci://<IMAGE>:<version> -R <repo>`, the closing fence and an empty
   line.
8. The line ``On Windows, and for what to do with a scanner warning, see "Verify the downloads" in the release's `README.md`.``
   and an empty line (so the text ends with `.\n`).

The VirusTotal cell of a file (rows are keyed by `scope`; the last row of a scope wins):

1. `scopeFor(name)` is `null`: `not scanned`.
2. No row for that scope (the scan timed out or produced nothing): `no result`.
3. Status `pass`: `<note> [permalink](<link>)`, or just `<note>` without a link.
4. Any other status: `<status>: <note>`.

**`parseChangelogEntry(name, text)`** turns one `docs/changelog/` file into `{name, title, body}`:
the title is the text after the first line matching `^#\s+\S` (trimmed), the body is every
other line joined with `\n` and trimmed. Without such a line the title is `name` without its
`.md` and the body is the whole text, trimmed.

**Changelog entry lines** (shared by `renderNotes` and `renderChanges`, with a heading marker of
`###` or `##`): `entries` is `[{name, text}]`; the CLI passes the changelog files whose name
matches `^\d{4}-\d{2}-\d{2}-\d{4}-.+\.md$` that were added between `previousTag` and the release
commit (all of them at the release commit on the first release), so `README.md` and entries that
were only edited never appear. No entries: an empty line and `No changelog entries.` Otherwise,
per entry sorted by `name` descending (newest timestamp first, plain code-unit order): an empty
line, `<marker> <title>`, and, when the body is not empty, an empty line and the body.

**`renderChanges({tag, previousTag, repo, entries})`** is the `CHANGES.md` release asset. Lines,
joined with `\n`:

1. `# What's new in <tag>`, an empty line.
2. `Changes since [<previousTag>](https://github.com/<repo>/releases/tag/<previousTag>).`, or
   `First release.` when `previousTag` is empty.
3. The changelog entry lines with marker `##`.
4. A final empty line (the text ends with `\n`).

## Edge cases

- `kitFiles`: the full layout with filled and unfilled files: RA-01; a placeholder used twice and
  an unknown placeholder: RA-02; `LOCAL-BUNDLE.md` not shipped: RA-03; a missing template: RA-04.
- `sha256sums`: format and code-unit sort: RA-05; empty list: RA-06.
- `parseSums`: CRLF, blank, malformed lines, binary marker and uppercase hex: RA-07; empty text:
  RA-08.
- `scopeFor`: every known name: RA-09 to RA-13; names that are almost right: RA-14 to RA-17.
- `renderNotes`: the full page with changelog entries out of order, a title-only CRLF entry, a
  pass row with link, a neutral row, a missing row and unscanned files: RA-18; a pass row without link and an escaped `|`: RA-19; exactly 500 commits
  (no extra line): RA-20; 503 commits with a previous tag: RA-21; 501 commits on the first
  release: RA-22; no commits and no rows: RA-23.
- `parseChangelogEntry`: CRLF with a heading and bullets: RA-24; no heading: RA-25; a second
  heading stays in the body: RA-26.
- `renderChanges`: sorting, an entry with no body and the previous-tag link: RA-27; first
  release with no entries: RA-28.

## Examples

`input.module` names the script (`release-kit`, `release-notes` or `virustotal-scan`),
`input.fn` the exported function and `input.args` its argument list. `expected` is one of:

- `{"result": …}` — the exact return value;
- `{"includes": [...], "excludes": [...]}` — for the long notes text: every `includes` string
  occurs in it and no `excludes` string does;
- `{"error": "<text>"}` — the call throws and the message contains `<text>`.

In `args`, an object of the exact shape `{"$commits": <n>}` stands for `n` commits
`{sha: "c<i>", subject: "s<i>"}` for `i` = 1 … n (newest first). Digests and checksums in the
`renderNotes` rows are shortened: the function prints them as given.

```examples
[
  {"id":"RA-01","input":{"module":"release-kit","fn":"kitFiles","args":[{"INSTALL.md":"# Log Hub {{VERSION}}\nBuilt from {{GIT_COMMIT}}.\n","docker-compose.yml":"services:\n  app:\n    image: ghcr.io/dataart/artisyn-log-hub:{{VERSION}}\n",".env.example":"POSTGRES_PASSWORD=change-me\n# {{VERSION}}\n","install.sh":"#!/bin/sh\necho {{VERSION}}\n","install.ps1":"Write-Host '{{GIT_COMMIT}}'\r\n"},{"version":"1.2.3","commit":"abc123"}]},"expected":{"result":[{"name":"README.md","zipName":"README.md","content":"# Log Hub 1.2.3\nBuilt from abc123.\n"},{"name":"docker-compose.yml","zipName":"docker-compose.yml","content":"services:\n  app:\n    image: ghcr.io/dataart/artisyn-log-hub:1.2.3\n"},{"name":"env.example","zipName":".env.example","content":"POSTGRES_PASSWORD=change-me\n# {{VERSION}}\n"},{"name":"install.sh","zipName":"install.sh","content":"#!/bin/sh\necho {{VERSION}}\n"},{"name":"install.ps1","zipName":"install.ps1","content":"Write-Host '{{GIT_COMMIT}}'\r\n"}]},"note":"Layout order; README.md (from INSTALL.md) and docker-compose.yml are filled, so the image line is IMAGE:1.2.3; env.example (zip .env.example) and both installers keep their placeholders and CRLF byte for byte."},
  {"id":"RA-02","input":{"module":"release-kit","fn":"kitFiles","args":[{"INSTALL.md":"{{VERSION}} and {{VERSION}} {{DATE}}","docker-compose.yml":"{{GIT_COMMIT}}/{{GIT_COMMIT}}",".env.example":"","install.sh":"","install.ps1":""},{"version":"0.1.0","commit":"f00"}]},"expected":{"result":[{"name":"README.md","zipName":"README.md","content":"0.1.0 and 0.1.0 {{DATE}}"},{"name":"docker-compose.yml","zipName":"docker-compose.yml","content":"f00/f00"},{"name":"env.example","zipName":".env.example","content":""},{"name":"install.sh","zipName":"install.sh","content":""},{"name":"install.ps1","zipName":"install.ps1","content":""}]},"note":"Rule 1: every occurrence is replaced; the unknown {{DATE}} stays; empty templates are allowed."},
  {"id":"RA-03","input":{"module":"release-kit","fn":"kitFiles","args":[{"LOCAL-BUNDLE.md":"local only","INSTALL.md":"a","docker-compose.yml":"b",".env.example":"c","install.sh":"d","install.ps1":"e"},{"version":"1.0.0","commit":"x"}]},"expected":{"result":[{"name":"README.md","zipName":"README.md","content":"a"},{"name":"docker-compose.yml","zipName":"docker-compose.yml","content":"b"},{"name":"env.example","zipName":".env.example","content":"c"},{"name":"install.sh","zipName":"install.sh","content":"d"},{"name":"install.ps1","zipName":"install.ps1","content":"e"}]},"note":"Rule 3: LOCAL-BUNDLE.md is not in the layout, so the kit still has exactly the five files."},
  {"id":"RA-04","input":{"module":"release-kit","fn":"kitFiles","args":[{"INSTALL.md":"a","docker-compose.yml":"b","install.sh":"d","install.ps1":"e"},{"version":"1.0.0","commit":"x"}]},"expected":{"error":"release-template/.env.example is missing"},"note":"Rule 4: .env.example is absent from the map."},
  {"id":"RA-05","input":{"module":"release-kit","fn":"sha256sums","args":[[{"name":"install.sh","content":"abc"},{"name":"README.md","content":""},{"name":"artisyn-log-hub-1.2.3.zip","content":"abc"}]]},"expected":{"result":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  README.md\nba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  artisyn-log-hub-1.2.3.zip\nba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  install.sh\n"},"note":"SHA-256 of '' is e3b0c442…b855 and of 'abc' ba7816bf…15ad (FIPS 180-2 test vectors); code-unit order puts 'R' (0x52) before 'a' before 'i'; two spaces, each line ends with \\n."},
  {"id":"RA-06","input":{"module":"release-kit","fn":"sha256sums","args":[[]]},"expected":{"result":""},"note":"No files: no lines."},
  {"id":"RA-07","input":{"module":"release-notes","fn":"parseSums","args":["BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD  install.sh\r\n\r\nnot a checksum line\r\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 *artisyn-log-hub-1.2.3.zip\r\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 README.md\r\nabc  short.txt\r\n"]},"expected":{"result":[{"name":"install.sh","sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},{"name":"artisyn-log-hub-1.2.3.zip","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},{"name":"README.md","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]},"note":"CRLF split; uppercase hex accepted and lowercased; '*' binary marker and a single space accepted; the blank line, the text line and the 3-character hash are skipped; file order kept."},
  {"id":"RA-08","input":{"module":"release-notes","fn":"parseSums","args":[""]},"expected":{"result":[]},"note":"Empty text: no entries."},
  {"id":"RA-09","input":{"module":"virustotal-scan","fn":"scopeFor","args":["artisyn-hooks-installer.tgz"]},"expected":{"result":"installer-tgz"},"note":"Exact name."},
  {"id":"RA-10","input":{"module":"virustotal-scan","fn":"scopeFor","args":["hooks.tar.gz"]},"expected":{"result":"hooks-tgz"},"note":"Exact name."},
  {"id":"RA-11","input":{"module":"virustotal-scan","fn":"scopeFor","args":["artisyn-log-hub-1.12.0.zip"]},"expected":{"result":"release-zip"},"note":"Three integer fields, .zip: release-zip."},
  {"id":"RA-12","input":{"module":"virustotal-scan","fn":"scopeFor","args":["install.sh"]},"expected":{"result":"install-sh"},"note":"Exact name."},
  {"id":"RA-13","input":{"module":"virustotal-scan","fn":"scopeFor","args":["install.ps1"]},"expected":{"result":"install-ps1"},"note":"Exact name."},
  {"id":"RA-14","input":{"module":"virustotal-scan","fn":"scopeFor","args":["artisyn-log-hub-1.2.zip"]},"expected":{"result":null},"note":"Only two version fields: no match, null."},
  {"id":"RA-15","input":{"module":"virustotal-scan","fn":"scopeFor","args":["artisyn-log-hub-1.2.3-rc1.zip"]},"expected":{"result":null},"note":"Suffix after the version: no match, null."},
  {"id":"RA-16","input":{"module":"virustotal-scan","fn":"scopeFor","args":["env.example"]},"expected":{"result":null},"note":"Not a scanned file: null."},
  {"id":"RA-17","input":{"module":"virustotal-scan","fn":"scopeFor","args":["dist/install.sh"]},"expected":{"result":null},"note":"The scope is chosen by base name; a path is not an exact name: null."},
  {"id":"RA-18","input":{"module":"release-notes","fn":"renderNotes","args":[{"version":"1.2.3","tag":"v1.2.3","previousTag":"v1.2.2","repo":"DataArt/artisyn-log-hub","entries":[{"name":"2026-10-22-1455-old.md","text":"# Old change\r\n"},{"name":"2026-10-25-1358-new.md","text":"# New change\n\n- a\n- b\n"}],"commits":[{"sha":"bbb2222","subject":"fix: two"},{"sha":"aaa1111","subject":"feat: one"}],"digest":"sha256:d0d0","sums":[{"name":"README.md","sha256":"1111"},{"name":"artisyn-log-hub-1.2.3.zip","sha256":"2222"},{"name":"docker-compose.yml","sha256":"3333"},{"name":"env.example","sha256":"4444"},{"name":"install.ps1","sha256":"5555"},{"name":"install.sh","sha256":"6666"}],"rows":[{"tool":"virustotal","scope":"install-sh","status":"neutral","note":"1 suspicious (EngineA)","link":"https://www.virustotal.com/gui/file/6666"},{"tool":"virustotal","scope":"release-zip","status":"pass","note":"0/76 engines","link":"https://www.virustotal.com/gui/file/2222"}]}]},"expected":{"result":"## What's new\n\n### New change\n\n- a\n- b\n\n### Old change\n\n## Commits\n\n<details>\n<summary>2 commits</summary>\n\n- fix: two (bbb2222)\n- feat: one (aaa1111)\n\n</details>\n\n## Security scan\n\nImage `ghcr.io/dataart/artisyn-log-hub:1.2.3`, digest `sha256:d0d0`.\n\n| File | SHA-256 | VirusTotal |\n|---|---|---|\n| `README.md` | `1111` | not scanned |\n| `artisyn-log-hub-1.2.3.zip` | `2222` | 0/76 engines [permalink](https://www.virustotal.com/gui/file/2222) |\n| `docker-compose.yml` | `3333` | not scanned |\n| `env.example` | `4444` | not scanned |\n| `install.ps1` | `5555` | no result |\n| `install.sh` | `6666` | neutral: 1 suspicious (EngineA) |\n\nVerify the downloaded files and the image:\n\n```sh\nsha256sum -c SHA256SUMS --ignore-missing\ngh attestation verify <file> -R DataArt/artisyn-log-hub\ngh attestation verify oci://ghcr.io/dataart/artisyn-log-hub:1.2.3 -R DataArt/artisyn-log-hub\n```\n\nOn Windows, and for what to do with a scanner warning, see \"Verify the downloads\" in the release's `README.md`.\n"},"note":"Changelog entries first, newest first by file name whatever the input order, as ### headings; the CRLF title-only entry is just its heading. Two commits, no cap, folded into <details> with '2 commits'. Cells: README/compose/env.example have no scope (not scanned); the zip's pass row gives note + permalink; install.ps1 has a scope but no row (no result); install.sh's neutral row gives 'neutral: <note>' and its link is not shown. Ends with the fence and an empty line."},
  {"id":"RA-19","input":{"module":"release-notes","fn":"renderNotes","args":[{"version":"1.0.0","tag":"v1.0.0","previousTag":"","repo":"DataArt/artisyn-log-hub","commits":[{"sha":"aaa1111","subject":"init"}],"digest":"sha256:d0d0","sums":[{"name":"install.ps1","sha256":"5555"},{"name":"install.sh","sha256":"6666"}],"rows":[{"tool":"virustotal","scope":"install-ps1","status":"pass","note":"0/76 engines"},{"tool":"virustotal","scope":"install-sh","status":"neutral","note":"API error|retry"}]}]},"expected":{"includes":["| `install.ps1` | `5555` | 0/76 engines |","| `install.sh` | `6666` | neutral: API error\\|retry |","<summary>1 commit</summary>\n\n- init (aaa1111)\n"],"excludes":["permalink","more]("]},"note":"A pass row without link shows only the note; '|' in a cell is escaped as '\\|'; one commit: singular '1 commit', no extra line."},
  {"id":"RA-20","input":{"module":"release-notes","fn":"renderNotes","args":[{"version":"1.0.1","tag":"v1.0.1","previousTag":"v1.0.0","repo":"DataArt/artisyn-log-hub","commits":{"$commits":500},"digest":"sha256:d0d0","sums":[],"rows":[]}]},"expected":{"includes":["<summary>500 commits</summary>\n\n- s1 (c1)\n","- s500 (c500)\n\n</details>\n\n## Security scan"],"excludes":["more]("]},"note":"Exactly COMMIT_CAP (500) commits: all listed, the last one directly before the blank line that closes the <details> block; no '…and n more' line."},
  {"id":"RA-21","input":{"module":"release-notes","fn":"renderNotes","args":[{"version":"1.0.1","tag":"v1.0.1","previousTag":"v1.0.0","repo":"DataArt/artisyn-log-hub","commits":{"$commits":503},"digest":"sha256:d0d0","sums":[],"rows":[]}]},"expected":{"includes":["- s500 (c500)\n- […and 3 more](https://github.com/DataArt/artisyn-log-hub/compare/v1.0.0...v1.0.1)\n"],"excludes":["(c501)","(c503)"]},"note":"503 commits: the first 500 are listed, then n = 503 - 500 = 3 with the compare link previousTag...tag."},
  {"id":"RA-22","input":{"module":"release-notes","fn":"renderNotes","args":[{"version":"1.0.0","tag":"v1.0.0","previousTag":"","repo":"DataArt/artisyn-log-hub","commits":{"$commits":501},"digest":"sha256:d0d0","sums":[],"rows":[]}]},"expected":{"includes":["- […and 1 more](https://github.com/DataArt/artisyn-log-hub/commits/v1.0.0)\n"],"excludes":["/compare/","(c501)"]},"note":"First release (no previous tag): 501 - 500 = 1 more, linking the commit list of the tag instead of a compare view."},
  {"id":"RA-23","input":{"module":"release-notes","fn":"renderNotes","args":[{"version":"1.0.0","tag":"v1.0.0","previousTag":"","repo":"DataArt/artisyn-log-hub","commits":[],"digest":"sha256:d0d0","sums":[{"name":"artisyn-log-hub-1.0.0.zip","sha256":"2222"}],"rows":[]}]},"expected":{"includes":["## What's new\n\nNo changelog entries.\n\n## Commits\n\nNo commits.\n\n## Security scan","| `artisyn-log-hub-1.0.0.zip` | `2222` | no result |"],"excludes":["\n- ","<details>"]},"note":"No entries (the entries argument is absent): 'No changelog entries.'; no commits: the single line 'No commits.' and no <details> block; no rows at all (vt-scan uploaded nothing): the zip has a scope but no row, so 'no result'."},
  {"id":"RA-24","input":{"module":"release-notes","fn":"parseChangelogEntry","args":["2026-10-25-1358-github-release-pipeline.md","# GitHub release pipeline\r\n\r\n- First bullet.\r\n- Second bullet.\r\n"]},"expected":{"result":{"name":"2026-10-25-1358-github-release-pipeline.md","title":"GitHub release pipeline","body":"- First bullet.\n- Second bullet."}},"note":"CRLF text: the first \"# \" heading is the title; the rest, trimmed, is the body with \n line breaks."},
  {"id":"RA-25","input":{"module":"release-notes","fn":"parseChangelogEntry","args":["2026-10-22-1455-changelog-skill.md","Just one sentence.\n"]},"expected":{"result":{"name":"2026-10-22-1455-changelog-skill.md","title":"2026-10-22-1455-changelog-skill","body":"Just one sentence."}},"note":"No \"# \" heading: the title is the file name without .md and the whole text is the body."},
  {"id":"RA-26","input":{"module":"release-notes","fn":"parseChangelogEntry","args":["2026-10-22-1455-x.md","# Title\n\n## Sub\n\n# Second\n"]},"expected":{"result":{"name":"2026-10-22-1455-x.md","title":"Title","body":"## Sub\n\n# Second"}},"note":"Only the first level-1 heading is the title; \"## Sub\" and a later \"# Second\" stay in the body."},
  {"id":"RA-27","input":{"module":"release-notes","fn":"renderChanges","args":[{"tag":"v1.0.1","previousTag":"v1.0.0","repo":"DataArt/artisyn-log-hub","entries":[{"name":"2026-10-22-1455-old.md","text":"# Old change\n\nOld body.\n"},{"name":"2026-10-25-1358-new.md","text":"# New change\n\n- a\n- b\n"},{"name":"2026-10-23-0900-title-only.md","text":"# Title only\n"}]}]},"expected":{"result":"# What's new in v1.0.1\n\nChanges since [v1.0.0](https://github.com/DataArt/artisyn-log-hub/releases/tag/v1.0.0).\n\n## New change\n\n- a\n- b\n\n## Title only\n\n## Old change\n\nOld body.\n"},"note":"Entries newest first by file name (the timestamp prefix), whatever the input order; an entry without body is just its heading; the text ends with one \n."},
  {"id":"RA-28","input":{"module":"release-notes","fn":"renderChanges","args":[{"tag":"v1.0.0","previousTag":"","repo":"DataArt/artisyn-log-hub","entries":[]}]},"expected":{"result":"# What's new in v1.0.0\n\nFirst release.\n\nNo changelog entries.\n"},"note":"First release with no entries: \"First release.\" and \"No changelog entries.\", no link."}
]
```

## Mutations

- Filling the placeholders of the installers or `.env.example` -> RA-01; naming the loose asset
  `.env.example` -> RA-01; replacing only the first occurrence -> RA-02; shipping every template
  in the map -> RA-03; silently skipping a missing template -> RA-04.
- One space or `name hash` order in `SHA256SUMS`, or a locale-aware / case-insensitive sort ->
  RA-05.
- `parseSums` rejecting uppercase hex or the `*` marker, or keeping malformed lines -> RA-07.
- A loose zip pattern (`artisyn-log-hub-.*\.zip`) -> RA-14, RA-15; matching by suffix instead of
  the exact base name -> RA-17.
- Showing `no result` for unscanned files or `not scanned` for a missing row -> RA-18, RA-23;
  showing the permalink for a non-pass row -> RA-18; not escaping `|` -> RA-19.
- `>=` instead of `>` for the cap -> RA-20; wrong `n`, or a compare link on the first release ->
  RA-21, RA-22.
- Commits before the changelog, oldest-first entries, `##` instead of `###` in the notes, or a
  `<details>` block around no commits -> RA-18, RA-23; `1 commits` -> RA-19.
- Taking the last heading, or a `##` heading, as the title -> RA-26; dropping the body when there
  is no heading -> RA-25; keeping `` in the body -> RA-24.
- Oldest-first or input-order entries -> RA-27; a previous-tag link or no placeholder line on an
  empty first release -> RA-28.

## Where the result is visible

The assets of a GitHub Release (`README.md`, `docker-compose.yml`, `env.example`, `install.sh`,
`install.ps1`, `artisyn-log-hub-<version>.zip`, `SHA256SUMS`, `CHANGES.md`) and the release notes on its page:
"What's new" from `docs/changelog/`, the folded commit list and the `File | SHA-256 | VirusTotal`
table. Safe behaviour: a file that was not
scanned or whose scan produced nothing never shows a verdict.
