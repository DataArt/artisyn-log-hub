# FR-6 investigation — paired identical Reads in sub-agent data

Date: 2026-10-28. Data: the local dev database (read-only SQL over `logs.body`), 1 179
`claude-subagent` logs, 596 `claude` logs, 1 822 `artisyn` logs.

## Question

FR-6: why do identical Reads appear in pairs for sub-agents (one path spelled with `\`, one with
`/`, same result size)? Is it one log uploaded twice, two `tool_use` ids, or two sessions?

## Findings

1. **No `tool_use` id appears twice** in any `claude` / `claude-subagent` transcript, neither within
   one log nor across logs or `sessions` rows (0 duplicate ids among 5 072 transcript Reads).
2. **No sub-agent log is uploaded twice:** every `claude-subagent` log has its own `sessions` row
   (1 179 logs, 1 179 sessions) and no two sub-agent logs under different session rows share their
   first line `uuid`.
3. **Within one transcript there is no pair of the same file under two spellings** (0 groups of
   one normalised path with more than one raw spelling). Repeated Reads of the same file inside one
   sub-agent (429 groups) have distinct `tool_use` ids and different line positions — real
   re-reads (mostly `offset`/`limit` chunks of one long file), not duplicates.
4. **The pairs are one call recorded twice by two sources.** The hook's `PostToolUse` records in the
   root session's `artisyn` log (`type: "artisyn"`, `tool_name: "Read"`, `agent_id` set for a
   sub-agent) carry the Windows-native spelling (`D:\_work\...`); the transcript's `tool_use`
   block carries the same call under the **same `tool_use_id`**, mostly with `/` slashes:
   - 4 556 of 5 315 hook Read records match a transcript Read by `tool_use_id`, all with the same
     path after `\` → `/` and case folding;
   - 3 448 of those pairs are exactly "`\` in the hook record, `/` in the transcript";
   - 3 327 matches sit in a `claude-subagent` log whose `sessions` row differs from the root
     session row holding the `artisyn` record — i.e. the pair spans the sub-agent node and the
     root node, which is why it looked like "two agents".
   Same result size follows: it is one tool call with one `tool_result`.

## Consequence for the OKF extraction

- The extraction (`server/src/logs/okf/okf-access-extractor.ts`) reads only `claude` /
  `claude-subagent` transcripts, never the hook's `artisyn` `PostToolUse` records, so the pairs are
  **not counted twice**; nothing to de-duplicate across sources.
- The DD-8 guard (a `tool_use` id seen twice within one node counts once, first occurrence wins)
  stays as a cheap safety net; on current data it never fires.
- No separate bug: there is no double upload of a sub-agent log.

This finding goes into `docs/knowledgebase/algorithms/okf-access-extraction.md` → Edge cases
(Chunk 15).
