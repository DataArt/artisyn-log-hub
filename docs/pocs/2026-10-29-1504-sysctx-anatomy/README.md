# PoC: System context anatomy from a real session

Task: [2026-10-29-sysctx-anatomy-tab](../../tasks/todo/2026-10-29-sysctx-anatomy-tab/requirements.md)

## Question

How detailed can the startup system context of a Claude Code session be broken down? The breakdown
covers size per section and per item, plus origin down to the file, its size and its git status.
Only metadata is used, never content. Which parts are measured exactly, which are estimated, and
how much stays unallocated?

## How to run

From this folder:

```sh
node anatomy.cjs --project <repo root> [--transcript <path to session .jsonl>]
```

If `--transcript` is not given, the script takes the newest transcript in
`~/.claude/projects/<project-slug>/`. It prints Markdown to stdout. `sample-output.md` is one run
over a real session of this repo.

## Result

The breakdown is far more detailed than the task assumed. The Claude Code transcript (2.1.3xx)
carries the startup context as typed `attachment` lines before the first assistant message:

| Attachment | What it gives | Precision |
|---|---|---|
| `prompt_snapshot.systemPrompt[]` | the harness system prompt, per block (11 blocks) | exact length per block |
| `skill_listing` (`content`, `names[]`, `skillCount`) | every listed skill / workflow; per-skill size by splitting `content` on `- <name>: ` | exact per skill |
| `instructions.files[]` (`path`, `type`, `content`) | CLAUDE.md / CLAUDE.local.md / user CLAUDE.md | exact per file |
| `deferred_tools_delta` (`addedNames`, `addedLines`, `failedMcpServers`) | deferred tool names, grouped per MCP server; failed servers | exact |
| `mcp_instructions_delta` | MCP server instructions per server | exact |
| `agent_listing_delta` | subagent types with their listing lines | exact |
| `session_context` (`userEmail`, `gitStatus`) | system reminders | exact |
| `environment`, `model`, `language`, `date`, `auto_mode`, … | env block pieces | JSON size ≈ rendered text |
| first assistant `message.usage` | **total** = input + cache write + cache read | exact (tokens) |

Disk adds the origin of each item. Skills resolve to the project (`.claude/skills`), to a plugin
(`installed_plugins.json` → cache `installPath`, including `workflows/*.js`), to org-synced
(`~/.claude/skills/synced/<org>/`) or to built-in (no file). Each file gets its size and its git
status (`tracked`, `tracked, modified`, `ignored`, `untracked`, `outside repo`, `missing`).

Numbers for the sample session (55 513 tokens total):

| Partition | ≈ Tokens | Share |
|---|---:|---:|
| P1 System prompt (11 blocks) | 1 757 | 3.2 % |
| P3 Deferred tool names (119, 14 MCP groups + 1 failed) | 1 031 | 1.9 % |
| P4 MCP server instructions | 512 | 0.9 % |
| P5 Subagent types (6) | 683 | 1.2 % |
| P6 Skill listing (78: 28 project, 21 plugin, 15 org-synced, 14 built-in) | 7 209 | 13.0 % |
| P7 Instruction files (CLAUDE.md 4 885 + CLAUDE.local.md 521) | 5 406 | 9.7 % |
| P9 Reminders & environment | 639 | 1.2 % |
| **U Unallocated** | 38 254 | 68.9 % |

Findings:

1. **Not in the transcript: tool JSON schemas.** These are the built-in tools plus the loaded MCP
   tools. They are the bulk of the Unallocated partition, and they cannot be split per tool from
   the log. The only exception is `deferred_tools_record`, which records loaded deferred tools.
2. **Path-scoped rules** (`.claude/rules/*.md` with `paths:`) are not part of the startup context.
   They arrive later via `nested_memory`. The tab should list them as "on demand, 0 at start".
3. **Git status is cheap to compute on the hook side** (`git ls-files --error-unmatch`,
   `git check-ignore -q`). Plugin and org-synced files are `outside repo`, even when the plugin's
   source lives in the repo (`.artisyn/marketplace/…`). Claude Code loads the cache copy.
4. **Token split is estimated** (chars / 3.7). Only the total is exact. The owner accepted a
   byte-based estimate.
5. Paths must be masked. The org-synced folder name is an account id and the project slug encodes
   the local checkout path. The PoC shows them as `<org>` and `<project-slug>`.
