---
type: "Idea"
title: "Product idea: code → session reverse lookup"
description: "Backlog idea, not built: start from a file, a line or a commit and jump to the Claude Code session (and the transcript turn) that wrote it. What Log Hub already stores for it, what is missing, open questions. Read before planning provenance / blame-style features."
tags:
  - product
  - idea
  - provenance
timestamp: "2026-11-06T15:00:00+04:00"
---

# Product idea: code → session reverse lookup

**Status:** idea, not planned. Spotted by the morning check on 2026-11-06.

## The idea

Today Log Hub goes **session → code**: a session shows the files it changed (Map tab, change
surface). The reverse direction is missing: given a **file**, a **line range** or a **commit**,
show which agent session(s) produced it and open the transcript at the turn with that Edit/Write.

Questions it answers:

- "Why is this code like this?" — read the prompt and the agent's reasoning that produced it.
- "Which sessions touched `src/billing/`?" — cost and history of a folder, not only of a session.
- Code review: from a PR / commit, open the sessions that wrote it.

## Seen at

- **KeepPlain** (`keepplain/keepplain-plugin`, Show HN 2026-11) — records Claude Code, Codex and
  Cursor sessions to a paid service and links a piece of code back to the conversation segment
  that wrote it. https://github.com/keepplain/keepplain-plugin

## What Log Hub already has

- `session_changed_paths` — one row per session × logical file (`rel_path`, `rel_path_key`,
  `folder_key`, `lines_added` / `lines_removed`), written on transcript ingest
  (`session-changed-paths-writer.ts`). This alone gives **file → sessions** and
  **folder → sessions** with a plain query.
- The full transcript, including every Edit/Write tool call with its diff — enough to locate the
  turn that changed a file and, from the diff, the lines.
- `sessions.git_branch`, `git_repo_root`, `git_worktree_root`; per-session `commit_count` /
  `pr_count`.

## What is missing

- **Commit linkage:** only a commit *count* is stored, not SHAs, so **commit → session** needs the
  SHA (from the `git commit` Bash call output in the transcript, or from the hook).
- **Line-level match:** lines drift after later edits; mapping a current line to the original
  edit needs either `git blame` → commit → session, or fuzzy matching of the diff text.
- **UI entry point:** e.g. a "Files" view per repo with a path search, each file listing its
  sessions, each session deep-linking to the transcript turn.

## Possible slicing

1. **S–M:** file / folder → sessions list, from `session_changed_paths` only, with deep links to
   the session Map tab.
2. **M:** deep link to the exact transcript turn of the Edit/Write.
3. **M–L:** commit → session via captured commit SHAs (needs a hook or parser change — keep hook
   API backward compatible).
4. **L:** line → session via `git blame` + commit linkage.

## Open questions

- Visibility: repos are private to their owner; a teammate's file lookup must not expose sessions
  they cannot see.
- Retention: purged sessions (`data-retention.md`) leave files without provenance — show
  "session expired" or hide?
- Renames / moves: follow `git mv` or treat as a new path?

## Related

- [Change Surface](../../knowledgebase/change-surface.md) — changed-path facts and the union rule.
- [Session Map Tab](../../knowledgebase/session-map.md) — per-session file list.
- [Competitors](../competitors.md)
