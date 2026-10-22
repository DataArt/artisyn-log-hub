#!/usr/bin/env pwsh
# Thin wrapper: runs the claude-docker launcher with the given arguments (see --help).
node "$PSScriptRoot/claude-docker.mjs" @args
exit $LASTEXITCODE
