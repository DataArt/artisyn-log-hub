# 2026-10-16: System Context — Show Instruction Files (CLAUDE.md, CLAUDE.local.md, User CLAUDE.md, Rules)

**Status:** todo
**Priority:** high
**Type:** bug
**Module(s):** client
**Owner:** denis.tsyplakov
**Created:** 2026-10-16

## Description

Original idea (verbatim):

> System Context panel: CLAUDE.md / CLAUDE.local.md / user CLAUDE.md are not visible (Files/Rules
> tabs missing) — client relies only on hook's synthetic system-context event, which is sent only
> when the harness fingerprint changes; Claude log already carries an `instructions` attachment
> with path, type (User/Project/Local) and full content

User: "the system context for a session currently shows misleading entries … you can't view the
claude.md and claude.local.md files themselves".

### What is visible now

Session `ffff6666-6666-4666-8666-666666666666` (repo artisyn-log-hub, 2026-10-15 21:31) →
**Logs** tab → **System Context** panel: header `6 MCP · 23 tools · 92 skills · 6 agents`,
only the MCP / Tools / Skills / Agents tabs. There are no **Files** and **Rules** tabs at all,
although the session loaded `~/.claude/CLAUDE.md` and the project's `CLAUDE.md` and
`CLAUDE.local.md`, and, during the work, `.claude/rules/*.md`.

### Cause

- The panel (`client/src/viewer/pages/repository/session-log/SessionContextPanel.tsx`) takes files
  only from `summary.claudeMd`, and `log-parser.ts` (≈ line 2390) fills it only from the hook's
  synthetic `system-context` event.
- The hook (`hook/.claude/telemetry_tool/send-logs-hook.js`, `getHarnessPrefix()`) intentionally
  sends `system-context` / `skill-definitions` / `agent-definitions` / `mcp-config` **only when the
  harness fingerprint changes** and only once per session: the events describe the repository, and
  the server upserts them per-repo into `harness_elements`. So the vast majority of sessions do not
  have this event in their log — and the panel is empty. This is the expected hook behaviour after
  the traffic optimization, not a hook bug.
- The hook scans only the project tree (`CLAUDE.md`/`CLAUDE.local.md` + `.claude/rules/`); it does
  not see the user-level `~/.claude/CLAUDE.md` at all; the client labels any non-`CLAUDE.local.md`
  file as `project`.
- Meanwhile the Claude Code log itself (namespace `claude`, uploaded as is) already contains
  everything needed:
  - attachment `type: "instructions"` — `files[]` with `path`, `type` (`User` | `Project` | `Local`)
    and the full `content`. Present in 165 of the 187 most recent logs of this repo, starting with
    Claude Code ~2.1.280;
  - attachment `type: "nested_memory"` — `path` + `content: { path, type, content }`; this is how
    path-scoped rules (`.claude/rules/*.md`) and nested `CLAUDE.md` files arrive, loaded when files
    are accessed during the session (present since ≤ 2.1.251).

## Functional Requirements

- FR-1. The client extracts the session's instruction files from the Claude log: the
  `instructions` attachment (initial set) and `nested_memory` (loaded during the session), with
  path, type and content.
- FR-2. The hook's synthetic `system-context` event stays supported (backward compatibility for
  old Claude Code versions without the `instructions` attachment) — it is used when the Claude log
  has no `instructions` attachment; if both sources are present, they are merged per file without
  duplicates (key — normalized path), data from the Claude log takes priority.
- FR-3. The **Files** tab shows `CLAUDE.md`, `CLAUDE.local.md` and the user-level `CLAUDE.md` with
  the correct type: `user` / `project` / `local` (the type is taken from the attachment's `type`
  field, not guessed from the file name).
- FR-4. The **Rules** tab shows `.claude/rules/*.md` that arrived via `nested_memory` (and via the
  hook's `system-context`, if present), marked as loaded during the session (path-scoped) rather
  than in the initial context.
- FR-5. Clicking a file/rule opens the existing `FileDetailModal` / `RuleDetailModal` with the
  content from the log — the file can be read in full.
- FR-6. Paths are shown without local information: project paths relative to the repo root,
  user-level as `~/.claude/CLAUDE.md` (no `C:\Users\<name>\…`), see `.claude/rules/client.md`
  § Path display.
- FR-7. The counter in the panel header row (`N files`) and the token estimate are computed over
  the merged set.

## Acceptance Criteria

- [ ] On a session without the hook's `system-context` event but with the `instructions`
      attachment (e.g. `ffff6666-…`), the panel has a Files tab with three rows:
      `~/.claude/CLAUDE.md` (`user`), `CLAUDE.md` (`project`), `CLAUDE.local.md` (`local`).
- [ ] Clicking a row opens a modal with the full file content.
- [ ] On a session where `.claude/rules/*.md` were loaded during the work, a Rules tab appears
      with these rules and a "loaded on demand" mark (or similar).
- [ ] On an old session (before Claude Code 2.1.280) with the hook's `system-context` event, the
      panel looks as before — no regression.
- [ ] A session that has both `instructions` and `system-context` shows no duplicate files.
- [ ] No absolute local path appears anywhere in the panel or the modals.
- [ ] Test: a step in an existing session-log scenario (grep `tests/scenarios/` for
      System Context / session-log) with a fixture containing the `instructions` and
      `nested_memory` attachments checks the Files and Rules tabs.

## Steps to Reproduce

1. Start the server and the client, log in as `muaddib@arrakis.test`.
2. My Repos → `https://git.example.com/group/artisyn-log-hub` → session 2026-10-15 21:31:42
   ("add to the implement-deep skill…").
3. **Logs** tab → System Context → **Show details**.

**Expected:** Files (user / project / local CLAUDE.md) and Rules tabs, content opens on click.
**Actual:** only MCP / Tools / Skills / Agents; CLAUDE.md and CLAUDE.local.md cannot be viewed.

## Open Questions

- Should the server-side extraction (`artisyn-extractor.ts` → `extractHarnessRuleInventory`,
  Harness usage tab) also be moved to the `instructions`/`nested_memory` attachments, or is that a
  separate task? Currently the rule inventory there is also built only from `system-context`.
- Should the content of the user-level `~/.claude/CLAUDE.md` be shown to other team members who
  can see the session (these are the session author's personal instructions)? The content is
  already in the uploaded Claude log, but it was not shown in the UI before.

## Notes

<!-- Append timestamped notes here as work progresses -->
- Related task: `2026-10-16-sysctx-skill-source` (same panel, skill classification).
