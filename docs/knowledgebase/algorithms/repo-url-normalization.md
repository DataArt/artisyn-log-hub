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

```examples
[
  {
    "id": "RU-01",
    "input": {"url":"git@github.com:org/repo.git"},
    "expected": {"normalized":"https://github.com/org/repo"},
    "note": "Rule 3.3: host github.com, path org/repo with .git removed. The same spelling is in S-REPO-01; this is the plain GitHub SSH example of rule 3.3."
  },
  {
    "id": "RU-03",
    "input": {"url":"git@ssh.dev.azure.com:v3/org/project/repo"},
    "expected": {"normalized":"https://dev.azure.com/org/project/_git/repo"},
    "note": "Rule 3.1: org, project, repo placed into the HTTPS Azure form with _git. The same spelling is in S-REPO-01; at unit level it kills \"Azure handled by the generic SSH rule\", which would give https://ssh.dev.azure.com/v3/org/project/repo."
  },
  {
    "id": "RU-04",
    "input": {"url": "org@vs-ssh.visualstudio.com:v3/org/project/repo"},
    "expected": {"normalized": "https://dev.azure.com/org/project/_git/repo"},
    "note": "Rule 3.2: the legacy Azure SSH host gives the same canonical form as RU-03."
  },
  {
    "id": "RU-05",
    "input": {"url":"http://arrakis.test/org/repo"},
    "expected": {"normalized":"https://arrakis.test/org/repo"},
    "note": "Rule 3.6: http becomes https. Also in S-REPO-01; this is the plain http example."
  },
  {
    "id": "RU-06",
    "input": {"url": "https://user:secret@Arrakis.TEST/Org/Repo"},
    "expected": {"normalized": "https://arrakis.test/Org/Repo"},
    "note": "Rule 3.6: credentials dropped, host lowercased, path case kept."
  },
  {
    "id": "RU-07",
    "input": {"url": "https://arrakis.test/org/repo.git/"},
    "expected": {"normalized": "https://arrakis.test/org/repo"},
    "note": "Rule 2: pass 1 cannot remove .git (path ends in /), removes the / -> .../repo.git; pass 2 removes .git; pass 3 changes nothing."
  },
  {
    "id": "RU-08",
    "input": {"url": "https://arrakis.test/org/repo//"},
    "expected": {"normalized": "https://arrakis.test/org/repo"},
    "note": "Rule 3.6 removes one / per pass: .../repo/ then .../repo, then stable."
  },
  {
    "id": "RU-09",
    "input": {"url": "https://arrakis.test:8443/org/repo"},
    "expected": {"normalized": "https://arrakis.test/org/repo"},
    "note": "Rule 3.6 keeps only the host name: the port 8443 is dropped (current behaviour: two servers on one host with different ports would merge)."
  },
  {
    "id": "RU-10",
    "input": {"url": "https://arrakis.test/org/repo?tab=readme#top"},
    "expected": {"normalized": "https://arrakis.test/org/repo"},
    "note": "Rule 3.6: query and fragment are not part of the path and are dropped."
  },
  {
    "id": "RU-11",
    "input": {"url": "git://github.com/org/repo.git"},
    "expected": {"normalized": "git://github.com/org/repo.git"},
    "note": "Rule 3.5: git:// is returned unchanged, .git included."
  },
  {
    "id": "RU-12",
    "input": {"url": "not a url"},
    "expected": {"normalized": "not a url"},
    "note": "Rule 3.4: does not parse as a URL, returned unchanged."
  },
  {
    "id": "RU-13",
    "input": {"url": "C:\\work\\project"},
    "expected": {"normalized": "https://work/project"},
    "note": "Rule 2: pass 1 parses scheme 'c:' and gives https://\\work\\project; pass 2 parses that as https, which turns backslashes into slashes: host work, path /project."
  },
  {
    "id": "RU-14",
    "input": {"url": "/home/dev/project"},
    "expected": {"normalized": "/home/dev/project"},
    "note": "Rule 3.4: a POSIX path has no scheme, so it does not parse as a URL and stays."
  },
  {
    "id": "RU-16",
    "input": {"url": "git@arrakis.test/C:/work/p"},
    "expected": {"normalized": "git@arrakis.test/C:/work/p"},
    "note": "Rule 1 runs before rule 3.3: no ':' between '@' and the first '/', so it is an identity whose local part happens to be 'git', not an SSH remote."
  },
  {
    "id": "RU-17",
    "input": {"url":"https://arrakis.test/r.git///"},
    "expected": {"normalized":"https://arrakis.test/r"},
    "note": "Rule 2 at the limit: pass 1 /r.git// (one /), pass 2 /r.git/, pass 3 /r.git, pass 4 /r. Exactly 4 passes; a limit of 3 would return https://arrakis.test/r.git."
  },
  {
    "id": "RU-18",
    "input": {"url":"https://arrakis.test/r/////"},
    "expected": {"normalized":"https://arrakis.test/r/","fixedPoint":false},
    "note": "Rule 2 past the limit: each pass removes one /, 4 passes leave /r/, which is returned as it is; normalizing it again would give /r, so it is not a fixed point."
  },
  {
    "id": "RU-19",
    "input": {"url":"https://arrakis.test/org/my.github.io"},
    "expected": {"normalized":"https://arrakis.test/org/my.github.io"},
    "note": "Rule 3.6 removes .git only at the very end; the .git inside my.github.io stays."
  },
  {
    "id": "RU-20",
    "input": {"url":"deploy@arrakis.test:org/repo"},
    "expected": {"normalized":"deploy@arrakis.test:org/repo"},
    "note": "Rule 3.3 needs the user git; deploy@... is no URL either (no scheme), so rule 3.4 returns it unchanged."
  },
  {
    "id": "RU-21",
    "input": {"url":""},
    "expected": {"normalized":""},
    "note": "Rule 3.4: the empty string is not a URL, returned unchanged."
  },
  {
    "id": "RU-22",
    "input": {"url":"git@SSH.dev.azure.com:v3/org/project/repo"},
    "expected": {"normalized":"https://ssh.dev.azure.com/v3/org/project/repo"},
    "note": "Rule 3.1 is case-sensitive, so the upper-case host falls to rule 3.3: host lowercased, path v3/org/project/repo kept."
  },
  {
    "id": "RU-23",
    "input": {"url":"git@ssh.dev.azure.com:v3/org/project/repo.git"},
    "expected": {"normalized":"https://dev.azure.com/org/project/_git/repo"},
    "note": "Rule 3.1 keeps repo.git as the repo; pass 2 (rule 3.6) removes the trailing .git."
  },
  {
    "id": "RU-24",
    "input": {"url":"ssh://git@arrakis.test/org/repo.git"},
    "expected": {"normalized":"https://arrakis.test/org/repo"},
    "note": "Rule 3.6 for an ssh:// URL: user dropped, host arrakis.test, path /org/repo without .git."
  },
  {
    "id": "RU-25",
    "input": {"url":"file:///home/dev/repo"},
    "expected": {"normalized":"https://home/dev/repo"},
    "note": "Rule 3.6: a file URL has an empty host and path /home/dev/repo, so pass 1 gives https:///home/dev/repo; the URL parser reads the first path segment of that as the host (an https URL needs one), so pass 2 gives https://home/dev/repo."
  },
  {
    "id": "RU-26",
    "input": {"url":"git@My Host:org/repo"},
    "expected": {"normalized":"https://my host/org/repo"},
    "note": "Rule 3.3 lowercases the host itself: \"My Host\" becomes \"my host\". Pass 2 cannot parse a host with a space, so it keeps the value (rule 3.4)."
  },
  {
    "id": "RU-27",
    "input": {"url":"ssh://git@Ho%zz/r"},
    "expected": {"normalized":"https://ho%zz/r"},
    "note": "Rule 3.6 lowercases the host of a non-http URL itself (for ssh:// the parser keeps Ho%zz as written); pass 2 cannot parse ho%zz as an https host (a % that starts no valid escape is not allowed there) and keeps the value."
  },
  {
    "id": "RU-28",
    "input": {"url":"git@ssh.dev.azure.com:v3/org/project/team/repo"},
    "expected": {"normalized":"https://dev.azure.com/org/project/_git/team/repo"},
    "note": "Rule 3.1: org and project are the first two segments; the repo is all the rest, team/repo."
  },
  {
    "id": "RU-29",
    "input": {"url":"git@ssh.dev.azure.com:v3/org/project"},
    "expected": {"normalized":"https://ssh.dev.azure.com/v3/org/project"},
    "note": "Rule 3.1 needs three segments; with two it falls to rule 3.3: host ssh.dev.azure.com, path v3/org/project."
  },
  {
    "id": "RU-30",
    "input": {"url":"https://arrakis.test/org/Repo.GIT"},
    "expected": {"normalized":"https://arrakis.test/org/Repo.GIT"},
    "note": "Rule 3.6 removes .git case-sensitively; .GIT stays."
  },
  {
    "id": "RU-31",
    "input": {"url":"https://arrakis.test/r.git////"},
    "expected": {"normalized":"https://arrakis.test/r.git","fixedPoint":false},
    "note": "Rule 2 past the limit with the removal order visible: each pass first tries .git (not at the end while a / follows) then removes one /: /r.git///, /r.git//, /r.git/, /r.git after 4 passes, returned as is; a 5th pass would give /r."
  },
  {
    "id": "RU-32",
    "input": {"url":"x@VS-SSH.visualstudio.com:v3/o/p/r"},
    "expected": {"normalized":"x@VS-SSH.visualstudio.com:v3/o/p/r"},
    "note": "Rule 3.2 is case-sensitive, so the upper-case host does not match; the user is not git (3.3) and it is no URL (3.4): unchanged."
  },
  {
    "id": "RU-33",
    "input": {"url":"x@vs-ssh.visualstudio.com:v3/org/project"},
    "expected": {"normalized":"x@vs-ssh.visualstudio.com:v3/org/project"},
    "note": "Rule 3.2 needs three segments; with two it falls through to 3.4: unchanged."
  },
  {
    "id": "RU-34",
    "input": {"url":"x@vs-ssh.visualstudio.com:v3/o/p/r.git"},
    "expected": {"normalized":"https://dev.azure.com/o/p/_git/r"},
    "note": "Rule 3.2 gives .../_git/r.git; pass 2 (3.6) removes the .git."
  },
  {
    "id": "RU-35",
    "input": {"url":"git@arrakis.test:"},
    "expected": {"normalized":"git@arrakis.test:"},
    "note": "Rule 3.3 needs a non-empty path; without one it is no URL either (3.4): unchanged."
  },
  {
    "id": "RU-36",
    "input": {"url":"git@a b/c:d"},
    "expected": {"normalized":"https://a b/c/d"},
    "note": "Rule 1 allows no whitespace after the @, so this is no identity; rule 3.3 takes \"a b/c\" as the host and \"d\" as the path: https://a b/c/d, which the URL parser then cannot read, so pass 2 keeps it."
  },
  {
    "id": "RU-37",
    "input": {"url":"git@ssh.dev.azure.com:v3/org//p/r"},
    "expected": {"normalized":"https://dev.azure.com/org//p/_git/r"},
    "note": "Rule 3.1 with an empty segment: org is \"org\", project the shortest non-empty text before the next / is \"/p\", repo \"r\"."
  },
  {
    "id": "RU-38",
    "input": {"url":"git@vs-ssh.visualstudio.com:v3/org/project"},
    "expected": {"normalized":"https://vs-ssh.visualstudio.com/v3/org/project"},
    "note": "Rule 3.2 needs three segments; with two and the user git it falls to rule 3.3: host vs-ssh.visualstudio.com, path v3/org/project."
  },
  {
    "id": "RU-39",
    "input": {"url":"git@My Host:org/repo.git"},
    "expected": {"normalized":"https://my host/org/repo"},
    "note": "Rule 3.3 itself removes the final .git (the next pass cannot parse \"my host\" and keeps the value, so no later pass would remove it)."
  },
  {
    "id": "RU-40",
    "input": {"url":"GIT://github.com/org/repo.git"},
    "expected": {"normalized":"GIT://github.com/org/repo.git"},
    "note": "Rule 3.5 looks at the parsed scheme, which the parser lowercases to git:, so GIT:// is returned unchanged too."
  },
  {
    "id": "RU-41",
    "input": {"url":"deploy@ssh.dev.azure.com:v3/o/p/r"},
    "expected": {"normalized":"deploy@ssh.dev.azure.com:v3/o/p/r"},
    "note": "Rule 3.1 needs the user git, 3.2 another host, 3.3 the user git; it is no URL either (3.4): unchanged."
  },
  {
    "id": "RU-42",
    "input": {"url":"git@vs-ssh.visualstudio.com:v3/o/p/r"},
    "expected": {"normalized":"https://dev.azure.com/o/p/_git/r"},
    "note": "Rule 3.2 is checked before 3.3: the legacy Azure host with the user git still gets the Azure form, not https://vs-ssh.visualstudio.com/v3/o/p/r."
  },
  {
    "id": "RU-43",
    "input": {"url":"git@arrakis.test:.git"},
    "expected": {"normalized":"https://arrakis.test"},
    "note": "Rule 3.3 keeps the path \".git\" (it must not be empty): https://arrakis.test/.git; pass 2 (3.6) removes .git, then the trailing /: https://arrakis.test."
  },
  {
    "id": "RU-44",
    "input": {"url":"GIT@github.com:o/r"},
    "expected": {"normalized":"GIT@github.com:o/r"},
    "note": "Rule 3.3 needs the user git in lower case; GIT is no SSH remote here, and it is no URL (3.4): unchanged."
  },
  {
    "id": "RU-45",
    "input": {"url":"GIT@ssh.dev.azure.com:v3/o/p/r"},
    "expected": {"normalized":"GIT@ssh.dev.azure.com:v3/o/p/r"},
    "note": "Rule 3.1 (and 3.3) need the user git in lower case: unchanged by rule 3.4."
  },
  {
    "id": "RU-46",
    "input": {"url":"@vs-ssh.visualstudio.com:v3/o/p/r"},
    "expected": {"normalized":"@vs-ssh.visualstudio.com:v3/o/p/r"},
    "note": "Rule 3.2 needs a non-empty user: unchanged by rule 3.4."
  },
  {
    "id": "RU-47",
    "input": {"url":"a@b@vs-ssh.visualstudio.com:v3/o/p/r"},
    "expected": {"normalized":"a@b@vs-ssh.visualstudio.com:v3/o/p/r"},
    "note": "Rule 3.2: the user may not contain @, so \"a@b\" does not match: unchanged by rule 3.4."
  },
  {
    "id": "RU-48",
    "input": {"url":"https://arrakis.test/r.git.git///"},
    "expected": {"normalized":"https://arrakis.test/r.git","fixedPoint":false},
    "note": "Rule 3.6 removes one .git per pass: passes 1-3 remove the three / (a .git is not at the end before that), pass 4 removes one .git: /r.git is returned after the limit; a 5th pass would give /r."
  },
  {
    "id": "RU-49",
    "input": {"url":"git@:org/repo"},
    "expected": {"normalized":"git@:org/repo"},
    "note": "Rule 3.3 needs a non-empty host; with none it is no URL either (3.4): unchanged."
  },
  {
    "id": "RU-50",
    "input": {"url":"git@/C:/w"},
    "expected": {"normalized":"https://c//w"},
    "note": "Rule 1 needs a non-empty host before the first /, so no identity. Rule 3.3: host \"/C\" (up to the first :), path \"/w\": https:///c//w; pass 2 reads the empty-host https URL with \"c\" as the host and path //w: https://c//w, stable."
  },
  {
    "id": "RU-51",
    "input": {"url":"git@arrakis.test:o/r.GIT"},
    "expected": {"normalized":"https://arrakis.test/o/r.GIT"},
    "note": "Rule 3.3 removes .git case-sensitively; .GIT stays, and rule 3.6 on the next pass keeps it too."
  },
  {
    "id": "RU-52",
    "input": {"url":"c:x@arrakis.test/p"},
    "expected": {"normalized":"https://arrakis.test/p"},
    "note": "Rule 1 allows no \":\" before the @, so no identity. Rule 3.6: the scheme c: has no //, so pass 1 gives https://x@arrakis.test/p; pass 2 drops the user: https://arrakis.test/p."
  },
  {
    "id": "RU-53",
    "input": {"url":"git@x@y/p:q"},
    "expected": {"normalized":"git@x@y/p:q"},
    "note": "Rule 1: the part between the first @ and the first / may contain another @ (\"x@y\"), so this is an identity and is returned unchanged."
  },
  {
    "id": "RU-54",
    "input": {"url":"mygit@arrakis.test:o/r"},
    "expected": {"normalized":"mygit@arrakis.test:o/r"},
    "note": "Rule 3.3 needs the user to be exactly git (the pattern is anchored at the start); \"mygit\" is not, and it is no URL: unchanged."
  },
  {
    "id": "RU-55",
    "input": {"url":"git@arrakis.test:o/legit"},
    "expected": {"normalized":"https://arrakis.test/o/legit"},
    "note": "Rule 3.3 removes \".git\" with its dot; \"legit\" ends in \"git\" without a dot and stays."
  },
  {
    "id": "RU-56",
    "input": {"url":"git@arrakis.test:o/a:b"},
    "expected": {"normalized":"https://arrakis.test/o/a:b"},
    "note": "Rule 3.3: the host ends at the first \":\", the rest \"o/a:b\" is the path, kept with its colon."
  },
  {
    "id": "RU-57",
    "input": {"url":"git@arrakis.test:o/r.git/x"},
    "expected": {"normalized":"https://arrakis.test/o/r.git/x"},
    "note": "Rule 3.3 removes .git only at the very end; inside the path it stays."
  },
  {
    "id": "RU-58",
    "input": {"url":"git@My Host:o/r/"},
    "expected": {"normalized":"https://my host/o/r/"},
    "note": "Rule 3.3 leaves a trailing / (only rule 3.6 removes it, and the next pass cannot parse \"my host\"): https://my host/o/r/."
  },
  {
    "id": "RU-59",
    "input": {"url":"git@My Host:o/r.git.git"},
    "expected": {"normalized":"https://my host/o/r.git"},
    "note": "Rule 3.3 removes one final .git; with a host the parser cannot read no later pass removes the second."
  },
  {
    "id": "RU-60",
    "input": {"url":"git@a@b:o/r"},
    "expected": {"normalized":"https://b/o/r"},
    "note": "Rule 3.3: the host is \"a@b\" (everything up to the first \":\"), giving https://a@b/o/r; pass 2 reads \"a\" as a user name and drops it: https://b/o/r."
  },
  {
    "id": "RU-61",
    "input": {"url":"my-org@vs-ssh.visualstudio.com:v3/o/p/r"},
    "expected": {"normalized":"https://dev.azure.com/o/p/_git/r"},
    "note": "Rule 3.2: any non-empty user without @ is accepted, a hyphen included."
  }
]
```

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
