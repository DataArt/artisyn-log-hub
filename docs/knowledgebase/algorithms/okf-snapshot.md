---
reviewed: no
reviewer: none
---

# OKF snapshot: KB bundle detection, ignored flags and the snapshot id

## Purpose

The OKF tabs judge KB use "as of session start": which bundles (knowledge bases) the repository
had, which files each held, how big they were and which were gitignored (private, never shown in a
team view). The hook builds that picture — the `okf-snapshot` line — at upload time. Two things
decide what the server gets: **which** folders count as bundles and which `.md` files belong to
them, and the **content-only** id that lets the hook send the full body once per distinct KB state
and a cheap `okf-snapshot-ref` line on every other upload. A wrong detection shows the wrong KB or
leaks a private one; a wrong id either resends the body every upload or never resends it after a
real change.

## Code

- Implementation: `hook/.claude/telemetry_tool/okf-snapshot.js` — `buildOkfSnapshot({projectRoot,
  config, log, workDir})`, `detectOkfBundles`, `hasOkfFrontMatter`, `globToRegExp`,
  `computeOkfSnapshotId`, `buildOkfSnapshotRef`; constants `OKF_SNAPSHOT_SCHEMA_VERSION` = 1,
  `OKF_SNAPSHOT_MAX_FILES` = 20000, `OKF_FRONT_MATTER_READ_BYTES` = 512,
  `OKF_CHECK_IGNORE_TIMEOUT_MS` = 5000, `OKF_DETECTION_BUDGET_MS` = 300,
  `OKF_DEFAULT_EXCLUDE` = `["tmp/**"]`.
- `hook/.claude/telemetry_tool/git-context.js` — `gitWithInput(args, cwd, input, timeoutMs)`
  (`execFileSync` with stdin, never throws, returns `{status, stdout}`).
- `hook/.claude/telemetry_tool/okf-state.js` — `okf-state.json`: known ids
  (`OKF_KNOWN_SNAPSHOTS_MAX` = 20, `OKF_STATE_VERSION` = 1) and the content-hash cache.
- `hook/.claude/telemetry_tool/env-context.js` — the `okf` config key (`{ exclude: string[] }`).
- Delivery: `send-logs-hook.js` `getOkfPrefix()` (see [../okf-usage.md](../okf-usage.md)).
- Twins: none. The server never recomputes the id; it only accepts `^[0-9a-f]{64}$`
  (`server/src/logs/okf/okf-snapshot.ts`, `OKF_SNAPSHOT_ID_RE`) and ignores an invalid one.
- Test: `hook/.claude/telemetry_tool/__tests__/okf-snapshot.algo.test.js` (`node --test`).

## Input and output

The line (DD-13); `size` is bytes on disk, `hash` the sha256 hex of the content, paths are
repo-relative with `/`, a bundle's `ignored` is its `index.md`'s flag. No `timestamp`.

```json
{ "type": "okf-snapshot", "okfSnapshotId": "<64 hex>", "schemaVersion": 1,
  "bundles": [ { "root": "docs/knowledgebase", "index": "docs/knowledgebase/index.md",
                 "ignored": false,
                 "files": [ { "path": "docs/knowledgebase/db-tables.md", "ignored": false,
                              "size": 12345, "hash": "<sha256 hex>" } ] } ] }
```

Ref line: `{ "type": "okf-snapshot-ref", "okfSnapshotId": "<64 hex>" }`.

## Rules

**Detection** (`detectOkfBundles`, DD-15, DD-43):

1. The walk starts at the project (git) root and never enters a directory named `.git` or
   `node_modules` (at any depth), a symlinked directory (a symlinked file is read like a file), or
   a path matching an exclude glob. The globs are `OKF_DEFAULT_EXCLUDE` (`tmp/**`, always) plus
   `config.okf.exclude`, matched against the repo-relative path of every folder and file.
2. **Globs** (`globToRegExp`): `**` = any number of segments (`a/**` matches `a` itself and
   everything under it; `**/b` matches `b` at any depth), `*` = any characters inside one segment,
   `?` = one character; anything else is literal, a leading `./` or `/` and a trailing `/` are
   dropped. A glob without wildcards excludes exactly that path (a folder: everything under it).
3. A file named `index.md` (any case) roots a bundle when its first
   `OKF_FRONT_MATTER_READ_BYTES` = 512 bytes, after an optional UTF-8 BOM and with `\r\n` read as
   `\n`, start with a `---` line and contain a line starting `okf_version` + optional spaces + `:`
   before the next `---` line (or the end of the 512 bytes). The bundle `root` is that index's
   folder (`''` for the repo root).
4. Every `.md` file (any case) found by the walk belongs to the **deepest** bundle root containing
   it; files under no root are dropped. A nested `index.md` without `okf_version` is an ordinary
   file of its parent bundle. Links inside an index are never followed, so nothing outside the
   walk is ever read.
5. Bundles are sorted by `root`, files by `path` (plain code-unit order).
6. More than `OKF_SNAPSHOT_MAX_FILES` = 20000 files in all bundles → no snapshot (logged).

**Ignored flags** (DD-16):

7. One `git check-ignore --stdin -z` over all found file paths (`OKF_CHECK_IGNORE_TIMEOUT_MS` =
   5000). Exit 0 → the listed paths are ignored; exit 1 → none is ignored; any other outcome (not
   a git repo, git missing, timeout) → **every** file is ignored (fail closed: a private file must
   never reach a team view). A bundle's `ignored` = its `index.md`'s flag.

**Content and id** (DD-14):

8. Each file is read once: `size` = bytes, `hash` = sha256 hex of the content. With `workDir`
   the hash is reused from `okf-state.json`'s cache when the file's `(mtimeMs, size)` is
   unchanged (files modified in the last 2 s are not cached); the cache never changes the result.
9. `okfSnapshotId = sha256Hex(JSON.stringify(canon))`, `canon` = the bundles sorted by `root`,
   each projected to `{root, index, ignored, files}` with its files sorted by `path` and projected
   to `{path, ignored, size, hash}`. Nothing else enters the id — never an mtime — so the id is
   independent of input order and changes on any change of a file's content, path, size or
   ignored flag.
10. A repository without any bundle still gets a snapshot with `bundles: []`, so the server can
    tell "no KB" from "hook too old to say".

**Timing** (DD-18): detection runs only at upload (`send-logs-hook.js`), never at `SessionStart`.
Over `OKF_DETECTION_BUDGET_MS` = 300 ms it is logged (a measurement threshold, not a cut-off).
Measured on Windows: this repo (2 bundles, 84 files) ~55–60 ms with or without the cache; a
generated tree of 5 002 `.md` files in 2 bundles ~1.4 s without the cache (read + sha256 ≈
1.35 s of it) and ~0.14 s with a warm cache. Detection-only probes on this repo: the fs walk ~80
ms, `git check-ignore --stdin` ~70 ms; `git ls-files -o -i --exclude-standard` (~500 ms) is not
used.

## Edge cases

- Two bundles, files outside every bundle dropped: OS-01.
- A nested `index.md` without `okf_version` is a file of the parent bundle: OS-02; with
  `okf_version` it roots its own, deeper bundle: OS-03.
- `tmp/` excluded by default: OS-04; `okf.exclude` drops a bundle and the default still applies:
  OS-05.
- A link from an index to `../private_kb` outside the repository is not followed: OS-06.
- Front matter not at the start, `okf_version` after the closing `---`, beyond 512 bytes, and
  under `node_modules`; a BOM and CRLF accepted: OS-07.
- Gitignored file and gitignored bundle flagged: OS-08; not a git repository → everything
  ignored: OS-09.
- No bundle → `bundles: []`: OS-10.
- Id stable under an mtime-only change: OS-11; changes on content: OS-12; changes on an ignored
  flag: OS-13; independent of bundle and file order (an extra field ignored): OS-14.

## Examples

Three `kind`s. In `detect` and `compare` rows a `tree` maps a path to file content; it is written
under a fresh temporary directory `<tmp>/repo` used as `projectRoot` (a key starting `../` lands
beside it, outside the repository). Unless the row says `"git": false`, `git init` runs in
`<tmp>/repo` first; with `"git": false` the temporary directory must not be inside any git
repository.

- **`detect`**: `buildOkfSnapshot({projectRoot, config: input.config})`. `expected.bundles` lists
  each bundle as `{root, index, files}` with `files` the paths in order; `expected.ignored` is the
  list of file paths flagged `ignored: true` (bundle order, then file order);
  `expected.ignoredBundles` the roots of bundles flagged `ignored: true`.
- **`compare`**: `{before, after}`, each a `{tree, mtimeOverride?}` written to its own directory
  (`mtimeOverride` re-stamps a file's mtime, in ms, after writing). `expected.sameId` says whether
  the two `okfSnapshotId`s are equal.
- **`order`**: `computeOkfSnapshotId(input.bundles)` and the same call on the bundles in reverse
  order, each with its files reversed. `expected.sameId` compares the two; `expected.id` is the id
  of the first call.

```examples
[
  {
    "id": "OS-01",
    "kind": "detect",
    "input": {"tree": {
      "docs/kb/index.md": "---\nokf_version: 1\ntitle: KB\n---\n# KB\n",
      "docs/kb/db.md": "# DB\n",
      "docs/kb/sub/api.md": "# API\n",
      "notes/index.md": "---\nokf_version: 1\n---\n",
      "notes/todo.md": "todo\n",
      "README.md": "# readme\n",
      "src/a.ts": "export {};\n"
    }},
    "expected": {
      "bundles": [
        {"root": "docs/kb", "index": "docs/kb/index.md", "files": ["docs/kb/db.md", "docs/kb/index.md", "docs/kb/sub/api.md"]},
        {"root": "notes", "index": "notes/index.md", "files": ["notes/index.md", "notes/todo.md"]}
      ],
      "ignored": [], "ignoredBundles": []
    },
    "note": "Rule 3: both index.md files declare okf_version -> two bundles. Rule 4: sub/api.md belongs to docs/kb; README.md is under no root and a.ts is not .md -> dropped. Rule 5: sorted by root and path ('db' < 'index' < 'sub'). Rule 7: fresh repo, nothing ignored."
  },
  {
    "id": "OS-02",
    "kind": "detect",
    "input": {"tree": {
      "docs/kb/index.md": "---\nokf_version: 1\n---\n",
      "docs/kb/log-schema/index.md": "---\ntitle: Log schema\n---\n",
      "docs/kb/log-schema/lines.md": "x\n"
    }},
    "expected": {
      "bundles": [{"root": "docs/kb", "index": "docs/kb/index.md", "files": ["docs/kb/index.md", "docs/kb/log-schema/index.md", "docs/kb/log-schema/lines.md"]}],
      "ignored": [], "ignoredBundles": []
    },
    "note": "Rule 3: the nested index has front matter but no okf_version -> no bundle of its own. Rule 4: it and lines.md belong to the parent docs/kb."
  },
  {
    "id": "OS-03",
    "kind": "detect",
    "input": {"tree": {
      "docs/kb/index.md": "---\nokf_version: 1\n---\n",
      "docs/kb/a.md": "a\n",
      "docs/kb/api/index.md": "---\nokf_version: 1\n---\n",
      "docs/kb/api/b.md": "b\n"
    }},
    "expected": {
      "bundles": [
        {"root": "docs/kb", "index": "docs/kb/index.md", "files": ["docs/kb/a.md", "docs/kb/index.md"]},
        {"root": "docs/kb/api", "index": "docs/kb/api/index.md", "files": ["docs/kb/api/b.md", "docs/kb/api/index.md"]}
      ],
      "ignored": [], "ignoredBundles": []
    },
    "note": "Rule 3: the nested index declares okf_version -> its own bundle. Rule 4: docs/kb/api/* goes to the deepest root docs/kb/api, not to docs/kb."
  },
  {
    "id": "OS-04",
    "kind": "detect",
    "input": {"tree": {
      "docs/kb/index.md": "---\nokf_version: 1\n---\n",
      "tmp/kb-baseline/index.md": "---\nokf_version: 1\n---\n",
      "tmp/kb-baseline/a.md": "a\n"
    }},
    "expected": {
      "bundles": [{"root": "docs/kb", "index": "docs/kb/index.md", "files": ["docs/kb/index.md"]}],
      "ignored": [], "ignoredBundles": []
    },
    "note": "Rule 1: OKF_DEFAULT_EXCLUDE tmp/** matches the folder tmp itself, so the walk never enters it and the junk copy tmp/kb-baseline is no bundle. A bundle of only its index.md still lists it."
  },
  {
    "id": "OS-05",
    "kind": "detect",
    "input": {"config": {"okf": {"exclude": ["docs/private/**"]}}, "tree": {
      "docs/kb/index.md": "---\nokf_version: 1\n---\n",
      "docs/private/index.md": "---\nokf_version: 1\n---\n",
      "docs/private/x.md": "x\n",
      "tmp/old/index.md": "---\nokf_version: 1\n---\n"
    }},
    "expected": {
      "bundles": [{"root": "docs/kb", "index": "docs/kb/index.md", "files": ["docs/kb/index.md"]}],
      "ignored": [], "ignoredBundles": []
    },
    "note": "Rule 1/2: docs/private/** (from config) excludes the folder docs/private; the user list does not replace the default, so tmp/** still excludes tmp/old. One bundle left."
  },
  {
    "id": "OS-06",
    "kind": "detect",
    "input": {"tree": {
      "docs/kb/index.md": "---\nokf_version: 1\n---\n- [Private](../../../private_kb/secret.md)\n",
      "../private_kb/index.md": "---\nokf_version: 1\n---\n",
      "../private_kb/secret.md": "secret\n"
    }},
    "expected": {
      "bundles": [{"root": "docs/kb", "index": "docs/kb/index.md", "files": ["docs/kb/index.md"]}],
      "ignored": [], "ignoredBundles": []
    },
    "note": "Rule 4: the link in the index points to <tmp>/private_kb, outside the project root; links are never followed and the walk stays inside the root, so the private bundle is not found."
  },
  {
    "id": "OS-07",
    "kind": "detect",
    "input": {"tree": {
      "a/index.md": "# A\n\n---\nokf_version: 1\n---\n",
      "b/index.md": "---\ntitle: B\n---\nokf_version: 1\n",
      "c/index.md": "﻿---\r\nokf_version: 2\r\n---\r\n",
      "d/index.md": "---\ndescription: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\nokf_version: 1\n---\n",
      "node_modules/pkg/index.md": "---\nokf_version: 1\n---\n"
    }},
    "expected": {
      "bundles": [{"root": "c", "index": "c/index.md", "files": ["c/index.md"]}],
      "ignored": [], "ignoredBundles": []
    },
    "note": "Rule 3: a does not start with ---; in b okf_version comes after the closing ---; d's 516-character description line puts okf_version at byte 521, past the first 512 bytes; c starts with a BOM and uses CRLF, both accepted -> only c. Rule 1: node_modules is never entered."
  },
  {
    "id": "OS-08",
    "kind": "detect",
    "input": {"tree": {
      ".gitignore": "docs/kb/private.md\ndocs/kb-local/\n",
      "docs/kb/index.md": "---\nokf_version: 1\n---\n",
      "docs/kb/private.md": "p\n",
      "docs/kb-local/index.md": "---\nokf_version: 1\n---\n",
      "docs/kb-local/me.md": "m\n"
    }},
    "expected": {
      "bundles": [
        {"root": "docs/kb", "index": "docs/kb/index.md", "files": ["docs/kb/index.md", "docs/kb/private.md"]},
        {"root": "docs/kb-local", "index": "docs/kb-local/index.md", "files": ["docs/kb-local/index.md", "docs/kb-local/me.md"]}
      ],
      "ignored": ["docs/kb/private.md", "docs/kb-local/index.md", "docs/kb-local/me.md"],
      "ignoredBundles": ["docs/kb-local"]
    },
    "note": "Rule 7: git check-ignore lists private.md and both kb-local files (exit 0). Ignored files stay in the snapshot, flagged. docs/kb-local's index.md is ignored, so the bundle is ignored; docs/kb's index is not."
  },
  {
    "id": "OS-09",
    "kind": "detect",
    "input": {"git": false, "tree": {
      "docs/kb/index.md": "---\nokf_version: 1\n---\n",
      "docs/kb/a.md": "a\n"
    }},
    "expected": {
      "bundles": [{"root": "docs/kb", "index": "docs/kb/index.md", "files": ["docs/kb/a.md", "docs/kb/index.md"]}],
      "ignored": ["docs/kb/a.md", "docs/kb/index.md"],
      "ignoredBundles": ["docs/kb"]
    },
    "note": "Rule 7: outside a git repository check-ignore fails (exit 128, neither 0 nor 1) -> fail closed: every file and the bundle are ignored."
  },
  {
    "id": "OS-10",
    "kind": "detect",
    "input": {"tree": {"README.md": "# no kb\n", "docs/index.md": "# Docs\n"}},
    "expected": {"bundles": [], "ignored": [], "ignoredBundles": []},
    "note": "Rule 3: docs/index.md has no front matter -> no bundle. Rule 10: the snapshot is still built, with bundles []."
  },
  {
    "id": "OS-11",
    "kind": "compare",
    "input": {
      "before": {"tree": {"docs/kb/index.md": "---\nokf_version: 1\n---\n", "docs/kb/a.md": "a\n"}, "mtimeOverride": {"docs/kb/a.md": 1577836800000}},
      "after": {"tree": {"docs/kb/index.md": "---\nokf_version: 1\n---\n", "docs/kb/a.md": "a\n"}, "mtimeOverride": {"docs/kb/a.md": 1735689600000}}
    },
    "expected": {"sameId": true},
    "note": "Rule 9: same paths, sizes, hashes and flags; the mtime (2020 vs 2025) is not in the canon -> same id."
  },
  {
    "id": "OS-12",
    "kind": "compare",
    "input": {
      "before": {"tree": {"docs/kb/index.md": "---\nokf_version: 1\n---\n", "docs/kb/a.md": "a\n"}, "mtimeOverride": {"docs/kb/a.md": 1577836800000}},
      "after": {"tree": {"docs/kb/index.md": "---\nokf_version: 1\n---\n", "docs/kb/a.md": "b\n"}, "mtimeOverride": {"docs/kb/a.md": 1577836800000}}
    },
    "expected": {"sameId": false},
    "note": "Rule 8/9: a.md has the same size (2) and the same forced mtime, but the content differs -> different hash -> different id."
  },
  {
    "id": "OS-13",
    "kind": "compare",
    "input": {
      "before": {"tree": {".gitignore": "", "docs/kb/index.md": "---\nokf_version: 1\n---\n", "docs/kb/a.md": "a\n"}},
      "after": {"tree": {".gitignore": "docs/kb/a.md\n", "docs/kb/index.md": "---\nokf_version: 1\n---\n", "docs/kb/a.md": "a\n"}}
    },
    "expected": {"sameId": false},
    "note": "Rule 7/9: identical KB content, but a.md becomes ignored; ignored is part of the canon -> different id (so the server learns the new privacy flag)."
  },
  {
    "id": "OS-14",
    "kind": "order",
    "input": {"bundles": [
      {"root": "docs/kb", "index": "docs/kb/index.md", "ignored": false, "files": [
        {"path": "docs/kb/index.md", "ignored": false, "size": 20, "hash": "1111111111111111111111111111111111111111111111111111111111111111"},
        {"path": "docs/kb/a.md", "ignored": false, "size": 2, "hash": "2222222222222222222222222222222222222222222222222222222222222222", "mtimeMs": 1577836800000}
      ]},
      {"root": "notes", "index": "notes/index.md", "ignored": true, "files": [
        {"path": "notes/index.md", "ignored": true, "size": 20, "hash": "3333333333333333333333333333333333333333333333333333333333333333"}
      ]}
    ]},
    "expected": {"sameId": true, "id": "3dac7b3dc5d79f55e1c512dae5f76fcb4f472fa28ed6b9240d8ccbdc41748b91"},
    "note": "Rule 9: both orders sort to docs/kb then notes, files a.md then index.md, and the extra mtimeMs field is projected away -> same canon -> same id. The id is sha256 of the canon JSON [{\"root\":\"docs/kb\",\"index\":\"docs/kb/index.md\",\"ignored\":false,\"files\":[{\"path\":\"docs/kb/a.md\",\"ignored\":false,\"size\":2,\"hash\":\"22…22\"},{\"path\":\"docs/kb/index.md\",…}]},{\"root\":\"notes\",…}] (hashes abbreviated here)."
  }
]
```

## Mutations

- Files assigned to the shallowest instead of the deepest root -> OS-03.
- A nested index without `okf_version` treated as a bundle -> OS-02.
- `tmp/**` not applied, or replaced by the user's list -> OS-04, OS-05.
- The front-matter check scanning the whole file or past the closing `---` -> OS-07 (`b`, `d`);
  BOM or CRLF not handled -> OS-07 (`c` missing); `node_modules` entered -> OS-07.
- Index links followed -> OS-06.
- `git check-ignore` failure read as "nothing ignored" (fail open) -> OS-09; exit 0 output not
  applied -> OS-08.
- mtime in the id -> OS-11; size-only instead of content hash -> OS-12; `ignored` left out of the
  canon -> OS-13; canon not sorted, or extra fields kept -> OS-14.
- No snapshot when there is no bundle -> OS-10.

## Where the result is visible

- Session pane → **OKF** tab: bundle cards (tracked / gitignored chip, file count), the "not in
  KB at start" chip, the "No KB snapshot for this session" banner when absent.
- Repository → **OKF** tab: bundle select, KB FILES and NOT READ tiles, the not-read list, the
  "No longer in KB" group, the team view's hiding of ignored files.
- API: `POST /api/v2/logs` `okfSnapshotId` / `okfSnapshotFull` and `unknownOkfSnapshotId`;
  `okf_snapshots.body`.
