#!/usr/bin/env pwsh
# Thin wrapper: runs the claude-docker launcher with the given arguments (see --help).
# When the interactive menu picks a session, shell or new sandbox, it writes that command to
# CLAUDE_DOCKER_NEXT_FILE (one argument per line) and exits; the command then runs here as a fresh
# process (see handNext in claude-docker.mjs for why).
$next = Join-Path ([IO.Path]::GetTempPath()) "claude-docker-next-$PID.txt"
$env:CLAUDE_DOCKER_NEXT_FILE = $next
try {
  node "$PSScriptRoot/claude-docker.mjs" @args
  $code = $LASTEXITCODE
} finally {
  Remove-Item Env:CLAUDE_DOCKER_NEXT_FILE -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath $next) {
  $nextArgs = @(Get-Content -LiteralPath $next | Where-Object { $_ -ne '' })
  Remove-Item -LiteralPath $next -Confirm:$false
  node "$PSScriptRoot/claude-docker.mjs" @nextArgs
  $code = $LASTEXITCODE
}
exit $code
