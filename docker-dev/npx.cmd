#!/bin/sh
# npx.cmd -> npx shim: the tracked .mcp.json is written for Windows hosts and launches MCP
# servers through `npx.cmd`; inside the Linux sandbox that name resolves here.
exec npx "$@"
