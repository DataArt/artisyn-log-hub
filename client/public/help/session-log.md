# Session Log

The Session Log view displays a complete record of a single Claude Code session. Open it by clicking any row in the repository's session list.

## Tabs

### Timeline

Shows each **prompt turn** in chronological order. Expand a turn to see:

- The user message and assistant response
- Tool calls made during the turn (file reads, bash commands, MCP calls, etc.)
- A call tree showing nested tool invocations

### Charts

Visual breakdown of the session:

- **Cost** — cumulative spend over time
- **Token usage** — input vs output tokens per turn
- **Work time** — active vs idle periods
- **Productivity** — lines added / removed per turn

### Info

Session metadata including:

| Field | Description |
|---|---|
| Model | The Claude model used (e.g. claude-sonnet-4-5) |
| Duration | Wall-clock time from first to last event |
| Files touched | Source files read or modified |
| MCP servers | External MCP servers invoked |
| Total cost | Estimated USD cost for the session |

### Raw Logs

The unprocessed JSONL log lines captured by the hook. Useful for debugging hook issues or writing custom analysis.

## Navigation

Use the **back arrow** in the session header to return to the repository session list without losing your scroll position.
