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

Rows (28): [`docs/algorithm-examples/release-assets.json`](../../algorithm-examples/release-assets.json) — test data for the table test; the rules above are enough to understand the algorithm.

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
