---
reviewed: 2026-10-15
reviewer: ai
---

# Repository URL normalization: one project, one repository row

## Purpose

The hook reports each session's git remote as the developer typed it: SSH or HTTPS, with or
without `.git`, with credentials, in any host case. The server folds every spelling of the same
project into one canonical URL, so one project is one row in the repository list. A wrong rule
splits a project into two repositories and its sessions "vanish" from the one the user looks at.

## Code

- Implementation: `server/src/logs/repo-url-normalizer.ts` (`normalizeRepoUrl`), with
  `isLocalRepoIdentity` from `server/src/logs/local-repo-identity.ts`.
- Twins: none run against these rows. Related, not a twin: the one-off startup migration of
  former local paths (`server/src/logs/repo-backfill.service.ts`) pre-filters candidates in SQL
  with a pattern shaped like rule 1, `'^[^[:space:]/:@]+@[^[:space:]/:]+/'`. Its `[:space:]` is
  ASCII whitespace only, while rule 1's `\s` also covers Unicode spaces. The rows it keeps are
  re-checked in TS with `normalizeRepoUrl`; rows it filters out are not.
- Test: `server/src/logs/repo-url-normalizer.algo.spec.ts`. Besides each row's value it checks
  whether normalizing the expected value again returns it unchanged (`fixedPoint`, true unless
  the row says otherwise).

## Rules

`normalizeRepoUrl(raw)`:

1. **Local identity first** (checked once, on the raw input only). If `raw` matches
   `<name>@<host>/...` (both non-empty; no whitespace, `/`, `:` or
   `@` before the `@`; no whitespace, `/` or `:` between `@` and the first `/`) it is a local
   repository identity built by ingest (`<email>/<path>`) and is returned unchanged.
   "Whitespace" is JavaScript's `\s` class; in the patterns below `.` matches any character
   except a line break.
2. Otherwise apply one pass (rule 3) repeatedly until the value stops changing, but at most 4
   passes in all, and return the last value. Every remote that needs at most 4 changing passes
   (all real ones) comes out as a fixed point (RU-17 needs exactly 4); an input that would need a 5th changing pass is
   returned after the 4th as it is, which is not a fixed point (RU-18).
3. **One pass**, first matching case wins:
   1. `git@ssh.dev.azure.com:v3/<org>/<project>/<repo>` (case-sensitive, user exactly `git`, at
      least three non-empty segments after `v3/`; with fewer it falls through to case 3) ->
      `https://dev.azure.com/<org>/<project>/_git/<repo>`; `<org>` and `<project>` are each the
      shortest non-empty text up to the next `/` (so an empty segment is swallowed into the next
      one: `org//p/r` gives project `/p`), `<repo>` is all the rest (slashes and a `.git` included; the next pass removes
      a trailing `.git`);
   2. `<user>@vs-ssh.visualstudio.com:v3/<org>/<project>/<repo>` (case-sensitive; any non-empty
      user without `@`; at least three segments, else it falls through: to case 3 when the user
      is `git`, otherwise on to case 4) -> the same form;
   3. `git@<host>:<path>` with the user exactly `git`, a non-empty path, and a non-empty `<host>`:
      everything up to the first `:` (it may contain spaces, `/` or `@`; a host the URL parser would reject is
      then kept as it is by the next pass) -> `https://<host lowercased>/<path>`, without a `.git` at the very end (case-sensitive) (a trailing `/` is
      left for the next pass). A path that is only `.git` is kept by this case (the path must not be
      empty) and removed by case 6 on the next pass. Another user (`deploy@host:path`) is not an
      SSH remote here and falls through to case 4;
   4. not parseable as a URL -> unchanged;
   5. a `git://` URL -> unchanged (checked after parsing, so `GIT://` too);
   6. any other URL (any scheme: `http`, `https`, `ssh`, `file`, ...) -> `https://` + lowercased
      host name + path, where one `.git` at the very end and then one trailing `/` are removed
      from the path (a `.git` inside the path stays). Credentials, **port**, query string and
      fragment are dropped; the case of the path is kept, and `.git` is matched case-sensitively.
      Everything else is the standard URL parser's: an `https` URL with an empty host takes its
      first path segment as the host; a special scheme's host may not contain a space or a `%`
      that starts no valid escape (the parse fails), while other schemes keep their host as
      written; a non-numeric port fails the parse; it percent-encodes the path, resolves `.`
      and `..` segments, lowercases (and punycodes) the hosts of special schemes (`http`, `https`,
      `ws`, `wss`, `ftp`, `file`), and for a scheme without
      `//` (`mailto:x`, `C:/work/p`) yields `https://` followed by the path.

The pass is repeated because one pass can leave a removable suffix behind (`repo.git/` loses the
`/` first, then `.git` on the next pass) and because a bare Windows path parses as a URL with the
drive letter as scheme (`C:\work\project` -> `https://\work\project`), which the next pass turns
into `https://work/project`.

## Edge cases

- SSH GitHub/GitLab: RU-01; host case: RU-26.
- Azure DevOps SSH, current and legacy host: RU-03, RU-04.
- `http`, credentials, host case, path case: RU-05, RU-06.
- Suffixes needing more than one pass: RU-07, RU-08.
- Port, query and fragment dropped: RU-09, RU-10.
- `git://` and unparseable input unchanged: RU-11, RU-12.
- Local paths and local identities: RU-13, RU-14, RU-16.
- Pass limit: needs exactly 4 passes (RU-17), needs more (RU-18).
- `.git` inside the path stays: RU-19. Another SSH user: RU-20. Empty input: RU-21.
- Azure host in another case, Azure `.git`: RU-22, RU-23.
- Other schemes: `ssh://` (RU-24, RU-27), `file://` (RU-25).
- Hosts the URL parser cannot read: RU-26, RU-27. Azure with more or fewer segments: RU-28,
  RU-29, and an empty segment: RU-37. `.GIT`: RU-30. Removal order at the limit: RU-31.
- Legacy Azure host case, segments, `.git`: RU-32, RU-33, RU-34; two segments with the user
  `git`: RU-38; with the user `git` and three segments: RU-42.
- `.git` behind a host the parser cannot read: RU-39. Upper-case `GIT://`: RU-40. Azure SSH with
  another user: RU-41. A path of only `.git`: RU-43. Empty SSH path: RU-35. Spaces
  around the `@`: RU-36. Upper-case user `GIT`: RU-44, RU-45. Legacy Azure user empty or with
  `@`: RU-46, RU-47. Two `.git` at the pass limit: RU-48.

## Examples

`input.url` is the raw remote; `expected.normalized` the stored value.

Rows (59): [`docs/algorithm-examples/repo-url-normalization.json`](../../algorithm-examples/repo-url-normalization.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Rule 2 dropped (single pass) -> RU-07, RU-08, RU-13; pass limit 3 instead of 4 -> RU-17;
  a loop until stable -> RU-18.
- Path lowercased -> RU-06.
- `.git` removal applied to `git://` -> RU-11.
- Credentials kept (`url.host` with `username`) -> RU-06.
- Port kept (`url.host` instead of `url.hostname`) -> RU-09.
- SSH rule before the identity check -> RU-16 (host `arrakis.test/C`, becomes
  `https://arrakis.test/c//work/p`).
- `.git` removed anywhere in the path -> RU-19.
- SSH rule for any user -> RU-20.
- Azure rule case-insensitive -> RU-22.
- Only http(s) URLs normalized -> RU-24.
- Host lowercasing dropped in the SSH rule -> RU-26; in the URL rule -> RU-27.
- Azure `<repo>` limited to one segment -> RU-28; Azure rule with fewer segments -> RU-29.
- `.git` removed case-insensitively -> RU-30; `/` removed before `.git` within a pass -> RU-31
  (would end at `/r`).
- SSH rule keeping a final `.git` -> RU-39 (elsewhere the next pass would hide it).
- `git://` checked on the raw text, case-sensitively -> RU-40. Azure rule 3.1 for any user ->
  RU-41. Rule 3.3 before 3.2 -> RU-42. A path of only `.git` refused by 3.3 -> RU-43.
- Legacy Azure rule case-insensitive -> RU-32; with fewer segments -> RU-33.
- `.git` removed anywhere in the SSH path -> RU-57; SSH rule removing a trailing `/` -> RU-58;
  every final `.git` removed at once -> RU-59. Host 3.3 refusing `@` -> RU-60. Legacy Azure user
  limited to letters -> RU-61.
- `.git` removed case-insensitively in the SSH rule -> RU-51; without its dot -> RU-55. SSH user
  matched anywhere (pattern not anchored) -> RU-54. Host taken up to the last ":" -> RU-56. Identity allowing ":" in the name
  -> RU-52; refusing "@" in the host -> RU-53.
- SSH rule accepting an empty path -> RU-35; an empty host -> RU-49. Identity with an empty host
  -> RU-50. Identity pattern allowing spaces -> RU-36.
- Azure segments required non-empty -> RU-37.
- User `git` matched case-insensitively -> RU-44, RU-45. Legacy Azure user allowed empty or with
  `@` -> RU-46, RU-47. Every trailing `.git` removed in one pass -> RU-48.
- Azure SSH handled by the generic SSH rule -> RU-03 (`https://ssh.dev.azure.com/v3/...`).

## Where the result is visible

Repository list: one row per canonical URL (`repositories.repo_url`), and the repository header
shows it. A session uploaded with any spelling of the remote lands in that repository's session
list.
