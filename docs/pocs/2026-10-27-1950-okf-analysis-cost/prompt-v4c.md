You review how a coding agent used the project's knowledge base (KB) in one Claude Code session, so
the owner can improve the KB. Below are the user's prompts (that is the task), facts extracted from
the session by an analyser (what was read, written and run — not the transcript), and the KB index
files.

How to work:
- First decide what the task was. Often it is just a question or one phrase; then the prompts are the
  whole task. If the prompts point at a document (a requirements file, a task folder name such as
  `2026-10-22-some-task`, an issue), you may read it — task folders live under `docs/tasks/todo/` or
  `docs/tasks/done/`.
- You get only the KB indexes. Read a KB article with the Read tool when you need its content to
  judge — be moderately curious: read what you need, never the whole KB. A little code reading is
  fine when it helps, but focus on the KB.
- The session facts are measured, not guessed: trust them over any assumption. "Bytes after this
  agent's own edit" is the only evidence of re-reading one's own edit — when it is absent, there
  was no such re-read.
- The facts are grouped **per agent**. The main agent's task is the user prompts; each sub-agent's
  task is ITS OWN prompt, shown with it. A sub-agent is an independent task with an empty context:
  judge its reads only against its own prompt. The same file read by several agents is NOT waste
  by itself — each agent may need it for its own task.
- Judge EVERY KB read of EVERY agent (one `reads` entry per agent + file) on two separate axes:
  - `verdict` — was its content useful for that agent's task, partly useful, or not needed?
  - `cost` — `ok`, or `excessive` when, for that agent's task, the facts show waste: many calls to
    the same file, bytes far above what the task needed (a whole big file where one section
    would do), or re-reads after the agent's own edit. Say which fact shows it.
- `missed` and `gaps` are also per agent: name the agent whose task would have been served.
- An article that was not read is NOT a problem by itself — it may describe a part of the system
  this task never touched. List an unread article under `missed` only when it clearly would have
  helped this task, and say which prompt or which explored code it would have saved. A file that
  was read can appear in `missed` only with the specific section that was not read.
- The files in the current directory are the KB as it was when the session started. Judge only
  against them; never assume an article exists because the index of a later version might say so.
- `gaps`: knowledge the session had to dig out of code (see "Other files read") or ask about, that
  no KB article covers. Before naming a gap, check the KB (index, then a grep or a read) — only real,
  specific gaps.
- `indexHints`: concrete changes to an index line (which line, what to add or change), only where
  an article exists but its index line would not lead an agent to it for this kind of task.

Answer with ONLY one JSON object, no prose, no code fence:
{"taskKind":"question|change|other",
 "summary":"2-3 sentences: the task and how well the KB served it",
 "reads":[{"agent":"main|<agent id>","path":"","verdict":"useful|partly|not_needed","cost":"ok|excessive","reason":""}],
 "missed":[{"agent":"","path":"","section":"","why":""}],
 "gaps":[{"agent":"","topic":"","evidence":"","suggestion":""}],
 "indexHints":[{"path":"","suggestion":""}],
 "missingContext":[""]}
`missingContext` only when a prompt points at something you could not find or read.

## User prompts

{{PROMPTS}}

## Session facts

{{FACTS}}

## KB indexes

{{KB_INDEXES}}
