---
reviewed: no
reviewer: none
---

# Harness snapshot: skill/workflow/command catalog and its id

## Purpose

System Context (Skills, Agents, MCP, Files, Rules) is built entirely from one `harness-snapshot`
line the hook uploads, never from older per-tab events. Two things decide what shows up and
whether a resend is needed: **which** project/user/plugin skills, workflows and commands the
catalog scanner finds (and under what name and path), and the **content-only** id that lets the
hook send the full snapshot just once per distinct harness and a cheap ref on every other upload.
A wrong catalog hides or mis-labels a skill; a wrong id either resends the full snapshot every
turn (every file read becomes an upload) or never resends it after a real change (stale System
Context).

## Code

- Implementation:
  - `hook/.claude/telemetry_tool/skill-catalog.js`, `buildSkillCatalog({projectRoot, cwd, env,
    log})` — the catalog scanner (which plugins are enabled, where each resolves to, what gets
    scanned, naming and the project/user collision rule).
  - `hook/.claude/telemetry_tool/harness-snapshot.js`, `computeSnapshotId(sections)` — the id
    algorithm over the catalog plus agents, MCP servers and system-context files.
- Twins: none. The server never recomputes `snapshotId` — it only validates the `^[0-9a-f]{64}$`
  shape and trusts the hook's value (design decision, `2026-10-16-sysctx-skill-source` plan, DD-2)
  — so there is nothing on the server side to test against this doc.
- Test: `hook/.claude/telemetry_tool/__tests__/harness-snapshot.algo.test.js`.

## Rules

**Catalog scan** (`buildSkillCatalog`):

1. **Sources and folders.** Project (`<projectRoot>/.claude/`) and user (`claudeConfigDir(env)`,
   `~/.claude` unless `CLAUDE_CONFIG_DIR` is set) are each scanned the same way: `skills/<dir>/
   SKILL.md` (kind `skill`; name from frontmatter `name`, else the directory name), `workflows/
   *.js` (kind `workflow`; name/description from a `meta = {...}` object literal matched by regex
   — the file is text-matched, never executed; name falls back to the file basename),
   `commands/*.md` at the top level only (kind `command`; name is **always** the file basename,
   frontmatter `name` is not read for commands).
2. **Plugin enablement.** `enabledPlugins` is merged from three settings files, in order:
   `<claudeConfigDir>/settings.json`, `<projectRoot>/.claude/settings.json`, `<projectRoot>/
   .claude/settings.local.json`. Each later file overwrites the same `<id>@<marketplace>` key —
   `false` in a later file disables a plugin an earlier file enabled, and only `true` survives to
   the next step.
3. **Plugin resolution.** For each enabled id, `<claudeConfigDir>/plugins/installed_plugins.json`
   (v2) is read for `plugins["<id>"]`, an array of install records. The first match wins, in order:
   `scope: "local"` with a `projectPath` that normalises (via `path.resolve`, backslashes to
   forward slashes, no trailing slash, lower-cased on win32) to the project root or cwd; then
   `scope: "project"` with the same match; then any `scope: "user"` record (no `projectPath` check
   at all). No match (empty/missing array, or every record failing the scope-and-path test) skips
   the plugin and logs `harness: plugin <id> enabled but not installed for this project —
   skipped`.
4. **Plugin scan.** Only the single resolved `installPath` is scanned — the same `skills/
   workflows/commands` folders as rule 1, plus any extra relative paths its own `.claude-plugin/
   plugin.json` lists under `skills`/`commands` (a string or an array). A plugin's name is that
   manifest's `name`, or the id part before `@` if the manifest is missing or names nothing. Every
   plugin entry's name is namespaced `<pluginName>:<name>`, so plugin entries never collide with a
   bare project/user name. Nothing outside the resolved `installPath` is ever read: an old cached
   copy of the same plugin elsewhere on disk contributes nothing.
5. **Project/user collision.** When a project and a user entry share the same `kind` and `name`,
   only the project one is kept.
6. **Path and hash.** Every entry's `path` is: `project` → relative to `projectRoot` with forward
   slashes; `user` → the literal string `~/.claude/<rel>`, `<rel>` relative to `claudeConfigDir`
   (never the real OS home directory, even when `CLAUDE_CONFIG_DIR` points elsewhere); `plugin` →
   `<pluginName>@<version>/<rel inside installPath>`. `contentHash` is the sha256 hex digest of the
   exact UTF-8 text the scanner read for that file — never a function of its mtime or size.

**Snapshot id** (`computeSnapshotId`):

7. `snapshotId = sha256Hex(JSON.stringify(canon))`, where `canon` projects only: `skills` sorted by
   `(source, name)` as `[name, source, plugin ? "<id>@<version>" : "", contentHash]`; `agents`
   sorted by `path` as `[name, path, contentHash]`; `mcp` sorted by `name` as `[name, command,
   args, url ?? "", configSource]`; `context` (the `systemContext` files) sorted by `path` as
   `[path, contentHash]`.
8. Everything not in that projection is invisible to the id: an MCP server's probe results
   (`connected`, `tools`) and the body-level `perToolDetailSupported` flag never affect it, and
   neither does any file's mtime — only `contentHash`, which is itself a pure function of text.

## Edge cases

- A stray second copy of a plugin on disk that `installed_plugins.json` does not point to: HS-01.
- A plugin enabled at one settings level and disabled at a later one: HS-02.
- An `installed_plugins.json` record whose scope requires a `projectPath` match and gets none:
  HS-03.
- A workflow's name/description coming from the `meta` regex, never the file name: HS-04.
- A command's name always the file basename, never its frontmatter: HS-05.
- A plugin enabled but entirely absent from `installed_plugins.json`: HS-06.
- An mtime-only change leaves the id unchanged: HS-07. A content change under a frozen mtime still
  changes the id: HS-08.
- MCP probe fields attached after the static read leave the id unchanged: HS-09. A real static MCP
  config change does change it: HS-10.
- A user-level skill with no project equivalent, and its literal `~/.claude/...` path: HS-11.
- A project/user name collision resolving to exactly the project entry: HS-12.

## Examples

Each row's `kind` picks which of three input shapes the test uses — a virtual **file tree**, plus
(for the plugin rows) **settings** objects and an **installed_plugins** map, all written to a fresh
temp directory before the call:

- A `tree` key with no prefix is a project-relative file, written under a temp project root (used
  as both `projectRoot` and `cwd`). A `user:<rel>` key is written under a temp directory used as
  `CLAUDE_CONFIG_DIR` (so `user:settings.json` is that directory's `settings.json`, `user:skills/
  x/SKILL.md` a user-level skill). A `plugin:<key>/<rel>` key is written under its own temp
  directory named `<key>`, referenced from `installedPlugins` by that same `<key>`.
- `settings.user` / `.project` / `.local` are objects written as the `enabledPlugins` of,
  respectively, `<CLAUDE_CONFIG_DIR>/settings.json`, `<project>/.claude/settings.json` and
  `<project>/.claude/settings.local.json`.
- `installedPlugins` is the `plugins` map of `<CLAUDE_CONFIG_DIR>/plugins/installed_plugins.json`
  (v2): `{"<id>": [{scope, projectPath, installPath, version, gitCommitSha}]}`. `projectPath` is
  the literal string `"self"` (the temp project root) or `"foreign"` (an unrelated temp
  directory); `installPath` is a `<key>` resolved to its `plugin:<key>` directory.
- `mtimeOverride` (`before`/`after` rows only) re-stamps a tree file's mtime to a fixed value after
  it is written, so content and mtime can be varied independently.

Three `kind`s:

- **`catalog`**: one `{tree, settings?, installedPlugins?}`. `expected.present` lists partial
  entries (`name`, `kind`, `source`, `path`) that must be found in `buildSkillCatalog(...)`;
  `expected.absentNames` lists names that must not appear; `expected.exactlyOne` lists names that
  must appear exactly once; `expected.logContains` is a substring the `log` callback must have
  received.
- **`compare`**: `{before, after}`, each a `{tree, mtimeOverride?}` written to its own temp
  directory and passed to `buildHarnessSnapshot`. `expected.sameId` says whether the two resulting
  `snapshotId`s are equal.
- **`probe`**: one `{tree, probeServerName, probeFields}`. `buildHarnessSnapshot` runs once; a
  second id is computed from the same sections after merging `probeFields` onto the named MCP
  server's entry. `expected.sameId` says whether the two ids are equal.

```examples
[
  {
    "id": "HS-01",
    "kind": "catalog",
    "input": {
      "tree": {
        "plugin:v1/skills/foo/SKILL.md": "---\nname: foo-old\n---\nOld body",
        "plugin:v2/skills/foo/SKILL.md": "---\nname: foo\n---\nNew body"
      },
      "settings": { "project": { "enabledPlugins": { "demo@mp": true } } },
      "installedPlugins": { "demo@mp": [{ "scope": "user", "installPath": "v2", "version": "2.0.0" }] }
    },
    "expected": {
      "present": [{ "name": "demo:foo", "kind": "skill", "source": "plugin" }],
      "absentNames": ["demo:foo-old"]
    },
    "note": "Rule 3 resolves demo@mp to the single installed_plugins record, installPath v2; rule 4 scans only that path, so the stray v1 copy on disk (no record points at it) contributes nothing: demo:foo is present, demo:foo-old is not."
  },
  {
    "id": "HS-02",
    "kind": "catalog",
    "input": {
      "tree": { "plugin:v1/skills/foo/SKILL.md": "---\nname: foo\n---\nBody" },
      "settings": {
        "user": { "enabledPlugins": { "demo@mp": true } },
        "local": { "enabledPlugins": { "demo@mp": false } }
      },
      "installedPlugins": { "demo@mp": [{ "scope": "user", "installPath": "v1" }] }
    },
    "expected": { "absentNames": ["demo:foo"] },
    "note": "Rule 2 merges user, then project (absent), then local; local's false for the same key overwrites the user-level true, so the plugin never reaches rule 3 and demo:foo is absent."
  },
  {
    "id": "HS-03",
    "kind": "catalog",
    "input": {
      "tree": { "plugin:v1/skills/foo/SKILL.md": "---\nname: foo\n---\nBody" },
      "settings": { "project": { "enabledPlugins": { "demo@mp": true } } },
      "installedPlugins": { "demo@mp": [{ "scope": "project", "projectPath": "foreign", "installPath": "v1" }] }
    },
    "expected": { "absentNames": ["demo:foo"], "logContains": "demo@mp" },
    "note": "The only record is scope project but its projectPath normalises to an unrelated directory, not the project root or cwd, so rule 3 finds no match: the plugin is skipped and the skip line is logged."
  },
  {
    "id": "HS-04",
    "kind": "catalog",
    "input": {
      "tree": { "plugin:v1/workflows/sample.js": "const meta = {\n  name: 'demo-workflow',\n  description: 'Sample workflow',\n};\nmodule.exports = { meta };\n" },
      "settings": { "project": { "enabledPlugins": { "demo@mp": true } } },
      "installedPlugins": { "demo@mp": [{ "scope": "user", "installPath": "v1", "version": "1.2.0" }] }
    },
    "expected": { "present": [{ "name": "demo:demo-workflow", "kind": "workflow", "source": "plugin" }] },
    "note": "Rule 1's meta regex reads name demo-workflow from the un-executed file text; the manifest is absent so the plugin name falls back to the id part demo, giving demo:demo-workflow."
  },
  {
    "id": "HS-05",
    "kind": "catalog",
    "input": { "tree": { ".claude/commands/x.md": "---\ndescription: test command\n---\nBody text" } },
    "expected": { "present": [{ "name": "x", "kind": "command", "source": "project", "path": ".claude/commands/x.md" }] },
    "note": "Rule 1: a command's name is always its file basename; the frontmatter here has no name field anyway, so x is the name regardless, at its project-relative path."
  },
  {
    "id": "HS-06",
    "kind": "catalog",
    "input": {
      "tree": {},
      "settings": { "project": { "enabledPlugins": { "ghost@mp": true } } },
      "installedPlugins": {}
    },
    "expected": { "logContains": "ghost@mp enabled but not installed for this project — skipped" },
    "note": "ghost@mp has no installed_plugins.json record at all (empty map), so rule 3's record list is empty and nothing matches: the skip line names ghost@mp exactly as rule 3 specifies."
  },
  {
    "id": "HS-07",
    "kind": "compare",
    "input": {
      "before": { "tree": { ".claude/skills/foo/SKILL.md": "---\nname: foo\n---\nHello" }, "mtimeOverride": { ".claude/skills/foo/SKILL.md": 1577836800000 } },
      "after": { "tree": { ".claude/skills/foo/SKILL.md": "---\nname: foo\n---\nHello" }, "mtimeOverride": { ".claude/skills/foo/SKILL.md": 1735689600000 } }
    },
    "expected": { "sameId": true },
    "note": "Rule 6/8: identical content gives the identical contentHash regardless of the forced mtime (2020 vs. 2025), so the two canon.skills tuples match and the ids are equal."
  },
  {
    "id": "HS-08",
    "kind": "compare",
    "input": {
      "before": { "tree": { ".claude/skills/foo/SKILL.md": "---\nname: foo\n---\nHello" }, "mtimeOverride": { ".claude/skills/foo/SKILL.md": 1577836800000 } },
      "after": { "tree": { ".claude/skills/foo/SKILL.md": "---\nname: foo\n---\nHello world" }, "mtimeOverride": { ".claude/skills/foo/SKILL.md": 1577836800000 } }
    },
    "expected": { "sameId": false },
    "note": "Rule 6/8: the forced mtime is identical in both trees, but the text differs, so contentHash differs and the ids differ — mtime never masks a real content change."
  },
  {
    "id": "HS-09",
    "kind": "probe",
    "input": {
      "tree": { ".mcp.json": "{\"mcpServers\":{\"demo\":{\"command\":\"node\",\"args\":[\"server.js\"]}}}" },
      "probeServerName": "demo",
      "probeFields": { "connected": true, "tools": [{ "name": "ping", "schemaSizeTokens": 12 }] }
    },
    "expected": { "sameId": true },
    "note": "Rule 7's mcp tuple is [name, command, args, url, configSource] only; rule 8 excludes connected/tools, so attaching them to the demo entry after the static read leaves canon.mcp, and the id, unchanged."
  },
  {
    "id": "HS-10",
    "kind": "compare",
    "input": {
      "before": { "tree": { ".mcp.json": "{\"mcpServers\":{\"demo\":{\"command\":\"node\",\"args\":[\"server.js\"]}}}" } },
      "after": { "tree": { ".mcp.json": "{\"mcpServers\":{\"demo\":{\"command\":\"node\",\"args\":[\"server-v2.js\"]}}}" } }
    },
    "expected": { "sameId": false },
    "note": "Rule 7: args is part of the mcp tuple, so a real static-config change (server.js to server-v2.js) changes canon.mcp and the id, unlike the probe-only change in HS-09."
  },
  {
    "id": "HS-11",
    "kind": "catalog",
    "input": { "tree": { "user:skills/bar/SKILL.md": "No frontmatter, just a body." } },
    "expected": { "present": [{ "name": "bar", "kind": "skill", "source": "user", "path": "~/.claude/skills/bar/SKILL.md" }] },
    "note": "No project skills dir exists, so the user-level entry is read; it has no frontmatter name, so rule 1's directory-name fallback gives bar; rule 6 writes the path as the literal ~/.claude/skills/bar/SKILL.md, never the real CLAUDE_CONFIG_DIR used to run the test."
  },
  {
    "id": "HS-12",
    "kind": "catalog",
    "input": {
      "tree": {
        ".claude/skills/dup/SKILL.md": "---\nname: dup\n---\nProject body",
        "user:skills/dup/SKILL.md": "---\nname: dup\n---\nUser body"
      }
    },
    "expected": {
      "present": [{ "name": "dup", "kind": "skill", "source": "project", "path": ".claude/skills/dup/SKILL.md" }],
      "exactlyOne": ["dup"]
    },
    "note": "Rule 5: project and user both define a skill named dup; only the project one survives, so dup appears exactly once and it is the project entry at its project-relative path."
  }
]
```

## Mutations

- The removed recursive `~/.claude/plugins/` scan reinstated (both cached copies read) -> HS-01.
- A later settings file's `false` not overwriting an earlier `true` -> HS-02.
- `scope: "project"` accepted without checking `projectPath` -> HS-03.
- A workflow's name taken from the file basename instead of the `meta` regex -> HS-04.
- A command's name read from frontmatter when present, instead of always the basename -> HS-05.
- No skip log when an enabled plugin has no `installed_plugins.json` record at all -> HS-06.
- `contentHash` derived from `mtime`/size instead of the file text -> HS-07 (would differ) and
  HS-08 (would match).
- MCP `connected`/`tools` included in the canon -> HS-09 (would differ). The `args` field dropped
  from the mcp tuple -> HS-10 (would match).
- The user path built from the real OS home directory instead of the literal `~/.claude/<rel>`
  (would still pass in a developer's own home but fail under the test's `CLAUDE_CONFIG_DIR`
  redirection) -> HS-11.
- User entries kept alongside a same-named project entry instead of dropped -> HS-12.

## Where the result is visible

- Session -> System Context: the Skills, Agents, MCP, Files and Rules tabs, built from the hook's
  `harness-snapshot` line (see `docs/knowledgebase/session-log-view.md`).
- API: `GET /api/v1/repositories/:repoId/sessions/:sessionId/logs`'s `harnessSnapshot` field, and
  `POST /api/v2/logs`'s `unknownSnapshotId` (whether a resend was needed).
- Not here: the server-side extraction of rule/skill/MCP inventory rows from a stored snapshot
  body (`server/src/logs/artisyn-extractor.ts`) is a straight field mapping (DD-10), not an
  algorithm with rules worth a table test.
