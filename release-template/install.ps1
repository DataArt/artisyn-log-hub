# Artisyn Log Hub installer / upgrader (Windows PowerShell 5.1 and PowerShell 7).
#
#   irm https://github.com/DataArt/artisyn-log-hub/releases/latest/download/install.ps1 | iex
#
# Environment (all optional):
#   $env:VERSION      release to install: 'latest' (default), 'X.Y.Z' or 'vX.Y.Z'
#   $env:INSTALL_DIR  install directory (default: $env:USERPROFILE\artisyn-log-hub)
#   $env:FORCE = '1'  allow installing a version lower than the one already installed
#
# It downloads docker-compose.yml and env.example of the release into INSTALL_DIR, generates a
# .env with random secrets on the first install only (an existing .env is never touched), then
# runs `docker compose pull` and `docker compose up -d`. Mirrors install.sh step for step.
#
# Everything runs inside Install-ArtisynLogHub, so under `irm | iex` the preference variables,
# the current directory and the shell itself are left as they were: a failure prints one clean
# line and sets $LASTEXITCODE = 1; `exit 1` is used only when this file runs as a script.
# The file is pure ASCII on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.

function Install-ArtisynLogHub {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $Image = 'ghcr.io/dataart/artisyn-log-hub'
  $ReleasesUrl = 'https://github.com/DataArt/artisyn-log-hub/releases'
  $DefaultUrl = 'http://localhost:5003'
  $SemverRe = '^[0-9]+\.[0-9]+\.[0-9]+$'
  $ImageLineRe = '^\s*image:\s*ghcr\.io/dataart/artisyn-log-hub:(\S+)'

  function Stop-Install([string]$Message) {
    throw (New-Object System.InvalidOperationException $Message)
  }

  # Runs `docker <args>` silently and reports success. Native stderr under
  # $ErrorActionPreference = 'Stop' would be a terminating error on 5.1, hence 'Continue' here.
  function Test-Docker([string[]]$DockerArgs) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & docker @DockerArgs *> $null
      return ($LASTEXITCODE -eq 0)
    } catch {
      return $false
    } finally {
      $ErrorActionPreference = $prev
    }
  }

  # Runs `docker <args>` with its output on the console and reports success.
  function Invoke-Docker([string[]]$DockerArgs) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & docker @DockerArgs | Out-Host
      return ($LASTEXITCODE -eq 0)
    } catch {
      return $false
    } finally {
      $ErrorActionPreference = $prev
    }
  }

  function Get-ImageTag([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
      if ($line -match $ImageLineRe) { return ($Matches[1] -replace '["'']', '') }
    }
    return ''
  }

  function Get-RandomHex([int]$Count) {
    $bytes = New-Object byte[] $Count
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return (-join ($bytes | ForEach-Object { $_.ToString('x2') }))
  }

  function Save-ReleaseFile([string]$Url, [string]$OutFile, [string]$Version) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile
    } catch {
      $status = 0
      $response = $_.Exception.Response
      if ($null -ne $response) { $status = [int]$response.StatusCode }
      if ($status -eq 404) { Stop-Install "release $Version not found ($Url)" }
      Stop-Install "download failed ($($_.Exception.Message)): $Url"
    }
  }

  # GitHub requires TLS 1.2, which older .NET Framework builds do not enable by default.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  # 1. Docker, Compose and a running daemon.
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Stop-Install 'Docker/Compose not found: install a Docker Engine with the Compose v2 plugin'
  }
  if (-not (Test-Docker @('compose', 'version'))) {
    Stop-Install "Docker/Compose not found: 'docker compose version' failed - install the Compose v2 plugin"
  }
  if (-not (Test-Docker @('info'))) {
    Stop-Install 'Docker is not running (or this user cannot reach the Docker daemon)'
  }

  # 2. Requested version and the download base URL.
  $version = $env:VERSION
  if ([string]::IsNullOrEmpty($version)) { $version = 'latest' }
  if ($version.StartsWith('v')) { $version = $version.Substring(1) }
  if ($version -eq 'latest') {
    $baseUrl = "$ReleasesUrl/latest/download"
  } else {
    if ($version -notmatch $SemverRe) { Stop-Install "VERSION must be latest or X.Y.Z, got '$version'" }
    $baseUrl = "$ReleasesUrl/download/v$version"
  }
  $installDir = $env:INSTALL_DIR
  if ([string]::IsNullOrEmpty($installDir)) {
    $userHome = $env:USERPROFILE
    if ([string]::IsNullOrEmpty($userHome)) { $userHome = $HOME }
    $installDir = Join-Path $userHome 'artisyn-log-hub'
  }
  $force = $env:FORCE -eq '1'

  $tmpDir = Join-Path ([IO.Path]::GetTempPath()) ('artisyn-log-hub-' + [IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $tmpDir | Out-Null
  try {
    # 3. Download the release files into a temp directory.
    Write-Host "Downloading release $version..."
    $newCompose = Join-Path $tmpDir 'docker-compose.yml'
    $newEnvExample = Join-Path $tmpDir 'env.example'
    Save-ReleaseFile "$baseUrl/docker-compose.yml" $newCompose $version
    Save-ReleaseFile "$baseUrl/env.example" $newEnvExample $version

    # 4. Refuse a downgrade: DB migrations only go forward.
    $newTag = Get-ImageTag $newCompose
    if ($newTag -notmatch $SemverRe) {
      Stop-Install "unexpected docker-compose.yml: no 'image: ${Image}:X.Y.Z' line"
    }
    $composePath = Join-Path $installDir 'docker-compose.yml'
    $oldTag = Get-ImageTag $composePath
    if (($oldTag -match $SemverRe) -and ([version]$newTag -lt [version]$oldTag)) {
      if (-not $force) {
        Stop-Install "downgrade not supported - DB migrations are forward-only (installed $oldTag, requested $newTag). Set `$env:FORCE = '1' to override."
      }
      Write-Host "FORCE=1: downgrading $oldTag -> $newTag"
    }

    # 5. Move the new files in, keeping the previous compose file.
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    $prevPath = Join-Path $installDir 'docker-compose.yml.prev'
    $hadPrev = Test-Path -LiteralPath $composePath -PathType Leaf
    if ($hadPrev) { Copy-Item -LiteralPath $composePath -Destination $prevPath -Force }
    Move-Item -LiteralPath $newCompose -Destination $composePath -Force
    $envExamplePath = Join-Path $installDir '.env.example'
    Move-Item -LiteralPath $newEnvExample -Destination $envExamplePath -Force

    # 6. First install only: generate .env with random secrets.
    $envPath = Join-Path $installDir '.env'
    $utf8NoBom = New-Object Text.UTF8Encoding $false
    if (-not (Test-Path -LiteralPath $envPath)) {
      $text = [IO.File]::ReadAllText($envExamplePath) -replace "`r", ''
      $text = $text -replace '(?m)^POSTGRES_PASSWORD=.*$', ('POSTGRES_PASSWORD=' + (Get-RandomHex 18))
      $text = $text -replace '(?m)^SESSION_SECRET=.*$', ('SESSION_SECRET=' + (Get-RandomHex 32))
      if (-not $text.EndsWith("`n")) { $text += "`n" }
      $text += "`nNODE_ENV=production`n"
      $envTmp = Join-Path $installDir ('.env.tmp.' + [IO.Path]::GetRandomFileName())
      [IO.File]::WriteAllText($envTmp, $text, $utf8NoBom)
      Move-Item -LiteralPath $envTmp -Destination $envPath
      Write-Host "Generated $envPath with random secrets."
    } else {
      Write-Host "Keeping the existing $envPath."
    }

    # 7. Pull and start.
    Push-Location -LiteralPath $installDir
    try {
      if (-not (Invoke-Docker @('compose', 'pull'))) {
        if ($hadPrev) {
          Move-Item -LiteralPath $prevPath -Destination $composePath -Force
          Stop-Install 'docker compose pull failed - restored the previous docker-compose.yml'
        }
        Stop-Install 'docker compose pull failed'
      }
      if (-not (Invoke-Docker @('compose', 'up', '-d'))) {
        Stop-Install "docker compose up -d failed - see 'docker compose logs app'"
      }
    } finally {
      Pop-Location
    }

    # 8. Where to find it.
    $url = ''
    foreach ($line in [IO.File]::ReadAllLines($envPath)) {
      if ($line -match '^PUBLIC_BASE_URL=(.*)$') { $url = $Matches[1].Trim().Trim('"', "'") }
    }
    if ([string]::IsNullOrEmpty($url)) { $url = $DefaultUrl }
    Write-Host ''
    Write-Host "Artisyn Log Hub $newTag is installed in $installDir"
    Write-Host "Open $url"
  } finally {
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$artisynRunAsFile = $MyInvocation.MyCommand.CommandType -eq 'ExternalScript'
try {
  Install-ArtisynLogHub
  $global:LASTEXITCODE = 0
} catch {
  Write-Host "install.ps1: $($_.Exception.Message)" -ForegroundColor Red
  $global:LASTEXITCODE = 1
  if ($artisynRunAsFile) { exit 1 }
}
