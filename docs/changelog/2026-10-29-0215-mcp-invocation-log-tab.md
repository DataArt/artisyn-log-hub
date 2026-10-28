# Tools/MCP tab: monitoring of MCP servers and command-line tools

- New repository and session "Tools/MCP" tab lists every MCP server call and every call of the
  command-line tools you choose to monitor: input, output, errors, duration and usefulness signals,
  aggregated per tool and operation, with drill-down to a single call.
- MCP calls are picked up automatically from the transcripts, including past sessions.
- The hook (2.27.0) can wrap monitored command-line tools in Bash and PowerShell to capture their
  real exit code and full output; the list of tools is set per repository and per team in the
  new "Monitored tools" dialog. Older hooks keep working and still show calls from the transcript.
