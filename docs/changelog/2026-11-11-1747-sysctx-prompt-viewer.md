# System prompt viewer and one consistent startup-context breakdown

- The System context anatomy tab has a **View system prompt** button: the session's system prompt
  parts, tool definitions and flags, with local paths masked, copyable and downloadable as Markdown.
- The anatomy table has a new **Tool definitions** row (one row per tool), so the parts now add up
  to the exact first-request total; the small remainder is shown as **Formatting & unlogged text**.
- Tool sizes no longer count each description twice, and the viewer's header shows how its numbers
  sit inside the first request.
