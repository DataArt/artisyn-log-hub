---
reviewed: no
reviewer: none
---

# Harness snapshot: skill/workflow/command catalog and its id

## Purpose

System Context (Skills, Agents, MCP, Files, Rules) is built from one `harness-snapshot` line the
hook uploads, never from older per-tab events; the Files and Rules tabs additionally merge the
Claude log's own `instructions` / `nested_memory` attachments (log wins per path — see
`docs/knowledgebase/session-log-view.md` § "System Context Files / Rules — sources and merge"). Two things decide what shows up and
whether a resend is needed: **which** project/user/plugin skills, workflows and commands the
catalog scanner finds (and under what name and path), each entry's optional `gitStatus`
(`tracked` | `untracked` | `ignored` | `outside-repo`, on `skills[]`, `agents[]` and
`systemContext.files[]`, absent when git gave no answer), and the **content-only** id that lets the
hook send the full snapshot just once per distinct harness and a cheap ref on every other upload.
A wrong catalog hides or mis-labels a skill; a wrong id either resends the full snapshot every
turn (every file read becomes an upload) or never resends it after a real change (stale System
Context).

## Code

- Implementation:
  - `hook/.claude/telemetry_tool/skill-catalog.js`, `buildSkillCatalog({projectRoot, cwd, env,
    log})` — the catalog scanner (which plugins are enabled, where each resolves to, what gets
    scanned, naming, the org-synced scan and the project/user collision rule).
  - `hook/.claude/telemetry_tool/harness-snapshot.js`, `computeSnapshotId(sections)` — the id
    algorithm over the catalog plus agents, MCP servers and system-context files.
  - `hook/.claude/telemetry_tool/harness-git-status.js`, `annotateGitStatus({projectRoot, skills,
    agents, systemContext})` — the per-entry `gitStatus`, set in place by `buildHarnessSnapshot`
    before the id is computed.
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
5a. **Org-synced scan.** After the plugins, every subdirectory `<org>` of
   `<claudeConfigDir>/skills/synced/` is scanned like a `skills/` folder (`<org>/<skill>/
   SKILL.md`, kind `skill`, name from frontmatter `name` else the directory name, never
   namespaced). The entry has `source: "org-synced"` and an **empty `body`** (metadata only —
   `description`, `bytes` and `contentHash` are still read). An org-synced skill whose name
   matches a project or user skill is skipped. The user scan of `<claudeConfigDir>/skills/` never
   picks up `synced` itself, because `synced/SKILL.md` does not exist.
6. **Path and hash.** Every entry's `path` is: `project` → relative to `projectRoot` with forward
   slashes; `user` → the literal string `~/.claude/<rel>`, `<rel>` relative to `claudeConfigDir`
   (never the real OS home directory, even when `CLAUDE_CONFIG_DIR` points elsewhere); `plugin` →
   `<pluginName>@<version>/<rel inside installPath>`; `org-synced` →
   `~/.claude/skills/synced/<org>/<skill>/SKILL.md`, with the literal text `<org>` in place of the
   real org folder name. `contentHash` is the sha256 hex digest of the
   exact UTF-8 text the scanner read for that file — never a function of its mtime or size.

**Snapshot id** (`computeSnapshotId`):

7. `snapshotId = sha256Hex(JSON.stringify(canon))`, where `canon` is `{v: 1, skills, agents, mcp,
   context}` and projects only: `skills` sorted by `(source, name)` as `[name, source, plugin ?
   "<id>@<version>" : "", contentHash, gitStatus?]`; `agents` sorted by `path` as `[name, path,
   contentHash, gitStatus?]`; `mcp` sorted by `name` as `[name, command, args, url ?? "",
   configSource]`; `context` (the `systemContext` files) sorted by `path` as `[path, contentHash,
   gitStatus?]`. `gitStatus?` is appended **only** when the entry's `gitStatus` is a non-empty
   string, so a snapshot without the field (an older hook, or git gave no answer) keeps exactly the
   id it had before the field existed; a changed status changes the id.
8. Everything not in that projection is invisible to the id: an MCP server's probe results
   (`connected`, `tools`) and the body-level `perToolDetailSupported` flag never affect it, and
   neither does any file's mtime — only `contentHash`, which is itself a pure function of text.

**Git status** (`annotateGitStatus`, run inside `buildHarnessSnapshot` before the id):

9. **Candidates.** A skill of source `project`, every agent and every `systemContext` file is an
   in-root candidate, unless its `path` leaves the project root (`../…`, or absolute). Every other
   entry — `user`/`plugin`/`org-synced` skills and `../…` context files — is
   `outside-repo` without asking git.
10. **At most two git processes**, cwd = `projectRoot`. Process 1 is `git ls-files -z --
    :(literal)<path>…` over the candidates (or `git rev-parse --git-dir` as a pure repo probe when
    there are none); an output path equal to a candidate is `tracked`. Process 2, only when some
    candidate is not tracked, is `git check-ignore --stdin -z` over those: exit 0 or 1 → each
    returned path is `ignored`, every other one `untracked`; any other exit leaves those paths
    without a status.
11. **Fail-open.** Process 1 failing (git missing, timeout, not a repository) or a joined pathspec
    longer than 24 000 characters leaves **every** entry without `gitStatus` — including the
    `outside-repo` ones — and never throws.

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
- An org-synced skill: masked `<org>` path, `source: org-synced`, empty body, and an org-synced
  skill that collides with a project skill skipped: HS-17.
- All four git statuses in one repository (tracked skill/agent/file, ignored file, untracked skill,
  user skill and `../` context file outside the repo): HS-13.
- Not a git repository: no entry gets a `gitStatus`, and the id is the literal pre-`gitStatus`
  canon id: HS-14.
- The same file tracked in one snapshot and untracked in the other gives different ids: HS-15.
- A repository with no in-root candidate (only a user skill): the repo probe still marks it
  `outside-repo`: HS-16.

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

Four `kind`s:

- **`catalog`**: one `{tree, settings?, installedPlugins?}`. `expected.present` lists partial
  entries (`name`, `kind`, `source`, `path`) that must be found in `buildSkillCatalog(...)`;
  `expected.absentNames` lists names that must not appear; `expected.exactlyOne` lists names that
  must appear exactly once; `expected.logContains` is a substring the `log` callback must have
  received. Every key of a `present` entry is compared, so `"body": ""` checks an empty body.
- **`compare`**: `{before, after}`, each a `{tree, mtimeOverride?}` written to its own temp
  directory and passed to `buildHarnessSnapshot`. `expected.sameId` says whether the two resulting
  `snapshotId`s are equal.
- **`probe`**: one `{tree, probeServerName, probeFields}`. `buildHarnessSnapshot` runs once; a
  second id is computed from the same sections after merging `probeFields` onto the named MCP
  server's entry. `expected.sameId` says whether the two ids are equal.
- **`git`**: one `{tree, git?, gitAdd?, gitignore?}`, or `{before, after}` of two of them. The tree
  is written as above (a `../<rel>` key lands in the temp directory that holds the project, i.e.
  outside the repository); then, unless `git: false`, `git init` runs in the project root, the
  `gitignore` lines are written to its `.gitignore` and the `gitAdd` paths are `git add`ed. Git
  runs with `GIT_CEILING_DIRECTORIES` at the temp directory and no global/system config, so the
  machine's own repositories and excludes never leak in. `expected.statuses` maps every entry
  `path` (skills, agents, context files) to its `gitStatus`, or `null` when absent;
  `expected.snapshotId`, when given, is the literal id. For `{before, after}`, `expected.sameId`
  says whether the two ids are equal.

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
  },
  {
    "id": "HS-13",
    "kind": "git",
    "input": {
      "tree": {
        "CLAUDE.md": "# Project\n",
        "CLAUDE.local.md": "# Local\n",
        ".claude/skills/hello/SKILL.md": "---\nname: hello\n---\nHello",
        ".claude/skills/shipped/SKILL.md": "---\nname: shipped\n---\nShipped",
        ".claude/agents/rev/AGENT.md": "---\nname: rev\n---\nReview",
        "user:skills/bar/SKILL.md": "---\nname: bar\n---\nUser",
        "../CLAUDE.md": "# Parent\n"
      },
      "gitAdd": ["CLAUDE.md", ".claude/skills/shipped/SKILL.md", ".claude/agents/rev/AGENT.md"],
      "gitignore": ["CLAUDE.local.md"]
    },
    "expected": {
      "statuses": {
        "CLAUDE.md": "tracked",
        "CLAUDE.local.md": "ignored",
        ".claude/skills/hello/SKILL.md": "untracked",
        ".claude/skills/shipped/SKILL.md": "tracked",
        ".claude/agents/rev/AGENT.md": "tracked",
        "~/.claude/skills/bar/SKILL.md": "outside-repo",
        "../CLAUDE.md": "outside-repo"
      }
    },
    "note": "Rule 9: the user skill and the ../ context file are outside-repo without asking git. Rule 10: ls-files returns the three git-added paths (tracked); check-ignore over the other two returns CLAUDE.local.md (ignored) and leaves the hello skill untracked."
  },
  {
    "id": "HS-14",
    "kind": "git",
    "input": {
      "git": false,
      "tree": {
        "CLAUDE.md": "# Hi\n",
        ".claude/skills/hello/SKILL.md": "---\nname: hello\n---\nHello"
      }
    },
    "expected": {
      "statuses": { "CLAUDE.md": null, ".claude/skills/hello/SKILL.md": null },
      "snapshotId": "57a1bdff8f18063521ee9a0936ac389fcc877ac41a87aee893e0aa838bebf223"
    },
    "note": "Rule 11: ls-files fails outside a repository, so no entry gets a gitStatus. Rule 7: with no gitStatus the tuples are the old ones, and the id equals sha256 of {v:1, skills:[[hello, project, '', <hash>]], agents:[], mcp:[], context:[[CLAUDE.md, <hash>]]} — the id an older hook computed for the same files."
  },
  {
    "id": "HS-15",
    "kind": "git",
    "input": {
      "before": { "tree": { "CLAUDE.md": "# Hi\n" }, "gitAdd": ["CLAUDE.md"] },
      "after": { "tree": { "CLAUDE.md": "# Hi\n" } }
    },
    "expected": { "sameId": false },
    "note": "Rule 7: same content and path, but the context tuple ends in tracked in one snapshot and untracked in the other, so the ids differ."
  },
  {
    "id": "HS-16",
    "kind": "git",
    "input": { "tree": { "user:skills/bar/SKILL.md": "---\nname: bar\n---\nUser" } },
    "expected": { "statuses": { "~/.claude/skills/bar/SKILL.md": "outside-repo" } },
    "note": "Rule 10: there is no in-root candidate, so process 1 is the rev-parse repo probe; it succeeds in the git-init project, and the user skill is marked outside-repo."
  },
  {
    "id": "HS-17",
    "kind": "catalog",
    "input": {
      "tree": {
        "user:skills/synced/acme-org/greet/SKILL.md": "---\nname: greet\ndescription: Say hello\n---\nSecret org body",
        "user:skills/synced/acme-org/dup/SKILL.md": "---\nname: dup\n---\nOrg dup body",
        ".claude/skills/dup/SKILL.md": "---\nname: dup\n---\nProject dup body"
      }
    },
    "expected": {
      "present": [
        { "name": "greet", "kind": "skill", "source": "org-synced", "path": "~/.claude/skills/synced/<org>/greet/SKILL.md", "body": "", "description": "Say hello" },
        { "name": "dup", "kind": "skill", "source": "project", "path": ".claude/skills/dup/SKILL.md" }
      ],
      "exactlyOne": ["greet", "dup"]
    },
    "note": "Rule 5a: greet under synced/acme-org becomes an org-synced entry with the bare name, an empty body (description is still read) and, per rule 6, the org folder masked as the literal <org>. The org-synced dup collides with the project dup and is skipped, so dup appears once, as the project entry. The user scan finds no synced/SKILL.md and adds nothing."
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
- `check-ignore` output ignored (every non-tracked candidate `untracked`), or user/`../` entries
  sent to git instead of marked `outside-repo` -> HS-13.
- `gitStatus` appended to a tuple even when absent (e.g. as `""`), or `outside-repo` set before the
  repo check succeeded -> HS-14 (the literal id, or the null statuses, would differ).
- `gitStatus` left out of the id tuples -> HS-15 (would match).
- No repo probe when there are no candidates (user skills left without a status) -> HS-16.
- The org-synced body kept, the real org folder name in the path, the name namespaced, or a
  project/user collision not skipped -> HS-17.

## Where the result is visible

- Session -> System Context: the Skills, Agents, MCP, Files and Rules tabs, built from the hook's
  `harness-snapshot` line (Files and Rules merged with the Claude log's `instructions` /
  `nested_memory` attachments; see `docs/knowledgebase/session-log-view.md`).
- API: `GET /api/v1/repositories/:repoId/sessions/:sessionId/logs`'s `harnessSnapshot` field, and
  `POST /api/v2/logs`'s `unknownSnapshotId` (whether a resend was needed).
- Not here: the server-side extraction of rule/skill/MCP inventory rows from a stored snapshot
  body (`server/src/logs/artisyn-extractor.ts`) is a straight field mapping (DD-10), not an
  algorithm with rules worth a table test.
