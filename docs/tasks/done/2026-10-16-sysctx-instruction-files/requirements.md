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
  only from `summary.claudeMd`, and `log-parser.ts` (≈ line 2410) fills it only from
  `options.harnessSnapshot.systemContext` — the hook-reported harness snapshot the server binds to
  the session and returns with the logs (DD-13/DD-17); with no bound snapshot `claudeMd` stays
  undefined. Snapshot non-rule files carry no `content` (`api.ts` ≈ line 1228).
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
  path, type and size (UTF-8 bytes of the attachment `content`); the text itself is not kept in
  the parsed summary.
- FR-2. The harness snapshot's `systemContext` stays supported (backward compatibility for old
  Claude Code versions without the `instructions` attachment); if both sources are present, they
  are merged per file without duplicates (key — normalized path), data from the Claude log takes
  priority.
- FR-3. The **Files** tab shows `CLAUDE.md`, `CLAUDE.local.md` and the user-level `CLAUDE.md` with
  the correct type: `user` / `project` / `local` (the type is taken from the attachment's `type`
  field, not guessed from the file name).
- FR-4. The **Rules** tab shows `.claude/rules/*.md` that arrived via `nested_memory` (and via the
  harness snapshot, if present); the ones from `nested_memory` are marked as loaded during the session (path-scoped) rather
  than in the initial context.
- FR-5. The System Context panel never shows the text of an instruction file — neither
  `CLAUDE.md` / `CLAUDE.local.md` / `~/.claude/CLAUDE.md` nor rules, from any source (including
  the rule `content` the harness snapshot carries). Only the list with path, type, size, token
  estimate and the on-demand mark is shown; `FileDetailModal` / `RuleDetailModal` show this
  metadata only, or row clicks are removed if the modals then add nothing.
- FR-6. Paths are shown without local information: project paths relative to the repo root,
  user-level as `~/.claude/CLAUDE.md` (no `C:\Users\<name>\…`), see `.claude/rules/client.md`
  § Path display.
- FR-7. The counter in the panel header row (`N files`) and the token estimate are computed over
  the merged set.
- FR-8. The hook and the uploaded Claude log are not changed — the log stays as is.

## Acceptance Criteria

- [ ] On a session without the hook's `system-context` event but with the `instructions`
      attachment (e.g. `ffff6666-…`), the panel has a Files tab with three rows:
      `~/.claude/CLAUDE.md` (`user`), `CLAUDE.md` (`project`), `CLAUDE.local.md` (`local`).
- [ ] No file or rule text is shown anywhere in the System Context panel or its modals — only
      path, type, size and tokens (also for old sessions whose snapshot carries rule content).
- [ ] On a session where `.claude/rules/*.md` were loaded during the work, a Rules tab appears
      with these rules and a "loaded on demand" mark (or similar).
- [ ] On an old session (before Claude Code 2.1.280) with a bound harness snapshot, the panel
      looks as before — no regression.
- [ ] A session that has both the `instructions` attachment and a harness snapshot shows no
      duplicate files.
- [ ] No absolute local path appears anywhere in the panel, the modals or the Session Info tab;
      project paths stay repo-relative when a user-level file is present.
- [ ] Test (scenario kind): a new step in `tests/scenarios/view/s-sess-03.spec.ts` (next to step 8,
      System Context) on a golden fixture extended with `instructions` and `nested_memory`
      attachments checks the Files tab (three rows with types and sizes), the Rules tab with the
      on-demand mark, and that a fixture file's text does not appear in the panel.

## Steps to Reproduce

1. Start the server and the client, log in as `muaddib@arrakis.test`.
2. My Repos → `https://git.example.com/group/artisyn-log-hub` → session 2026-10-15 21:31:42
   ("add to the implement-deep skill…").
3. **Logs** tab → System Context → **Show details**.

**Expected:** Files (user / project / local CLAUDE.md, with sizes) and Rules tabs.
**Actual:** only MCP / Tools / Skills / Agents; CLAUDE.md and CLAUDE.local.md are not listed.

## Common sense considerations

- Client-only change; the server-side rule inventory (`artisyn-extractor.ts` →
  `extractHarnessRuleInventory`, Harness usage tab) is out of scope — a separate task if needed.
- The raw Logs view keeps rendering attachments as it does today; only the System Context panel
  and its modals drop the text.
- `ClaudeMdFile.role` gains a user-level value; the Files tab type column shows `user` / `project`
  / `local` from the attachment's `type` (case-insensitive); an unknown `type` is shown lowercased
  as is.
- Several `instructions` attachments in one log (resume, compaction) are unioned per path; the
  last size wins.
- A `nested_memory` file that is not under `.claude/rules/` (nested `CLAUDE.md`) goes to the Files
  tab with its attachment type and the same on-demand mark.
- User-type paths are displayed as `~/.claude/<path below the user .claude dir>` and are excluded
  from the repo-root auto-detection in `log-parser.ts` (which picks the shortest absolute
  `CLAUDE.md` path and would otherwise strip at the home directory); merging by path happens after
  normalisation.
- The merged set feeds every `summary.claudeMd` consumer (System Context panel, Session Info tab,
  call tree, context-usage chart); the session export keeps omitting `claudeMdFiles`.
- `nested_memory` parsing reuses the existing per-turn `rulesInjected` extraction in
  `log-parser.ts` (≈ line 968) rather than a second parser.

## Open Questions

None.

## Notes

<!-- Append timestamped notes here as work progresses -->
- Related task: `2026-10-16-sysctx-skill-source` (same panel, skill classification).
- 2026-10-21 — implemented via adlc-lh:implement; checks green.
- 2026-10-21 — owner decision after review: do not track loaded vs. not loaded in the UI. The
  `on demand` badge and the modals' "Loaded" row are removed (supersedes the on-demand mark of FR-4
  and its acceptance criterion); Files/Rules show only name/path, type, size and tokens. The internal
  `onDemand` flag stays only so Call Tree / Context Usage do not double-count `nested_memory` bytes.
