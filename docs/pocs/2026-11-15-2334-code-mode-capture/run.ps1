# Starts an interactive Claude Code session with Code Mode on and the capture hooks attached.
# Run it from a real terminal (Code Mode does not work with `claude -p`).
#
# It fills the hook script's absolute path into a copy of claude-config/settings.json
# (capture/settings.json, gitignored), so nothing machine-specific is stored in the PoC.

$ErrorActionPreference = 'Stop'
$poc = $PSScriptRoot -replace '\\', '/'
$capture = Join-Path $PSScriptRoot 'capture'
New-Item -ItemType Directory -Force $capture | Out-Null

$template = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'claude-config\settings.json'))
$settings = Join-Path $capture 'settings.json'
# WriteAllText writes UTF-8 without a BOM; Set-Content -Encoding utf8 would add one in PowerShell 5.1.
[IO.File]::WriteAllText($settings, $template.Replace('__POC_DIR__', $poc))

$env:CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
Set-Location $PSScriptRoot
claude --settings $settings --model opus
