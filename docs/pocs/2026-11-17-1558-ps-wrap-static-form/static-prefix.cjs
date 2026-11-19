'use strict';
// PoC: a PowerShell wrapper prefix with no dynamic command name. The real tool is invoked by a
// literal absolute path resolved in the hook process; the runtime guard defines the function only
// when PowerShell resolves the tool to that same path (else the call runs unwrapped).
const fs = require('fs');
const path = require('path');

function psQuote(s) {
  return `'${String(s).replace(/'/g, '\'\'')}'`;
}

/** First application named `tool` on PATH, PowerShell-style (PATH order, then PATHEXT order). */
function resolveApplication(tool, env = process.env) {
  const pathVar = env.PATH || env.Path || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const hasExt = process.platform === 'win32' && exts.some((e) => tool.toLowerCase().endsWith(e.toLowerCase()));
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    const names = hasExt ? [tool] : exts.map((e) => tool + e);
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // not here
      }
    }
  }
  return null;
}

// __lhStart / __lhEnd: everything the old __lhWrap did except running the tool.
const START = [
  'function __lhStart { param([string]$__t, [string]$__cap, [string]$__real, [object[]]$__a)',
  '$__s = @{ log = $false; id = $null; t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); t = $__t; cap = $__cap }',
  'try { [void][IO.Directory]::CreateDirectory(@@CALLS@@); $__s.id = (\'{0}-{1}-{2:x4}\' -f $__s.t0, $PID, (Get-Random -Maximum 65536)); '
    + '$__rec = [ordered]@{ type = \'start\'; schema = 1; callId = $__s.id; sessionId = @@SID@@; tool = $__t; args = @($__a | ForEach-Object { "$_" }); '
    + 'real = $__real; cwd = (Get-Location).ProviderPath; shell = \'powershell\'; capture = $__cap; startedAtMs = $__s.t0; pid = $PID }; '
    + '[IO.File]::AppendAllText([IO.Path]::Combine(@@CALLS@@, "$($__s.id).jsonl"), ($__rec | ConvertTo-Json -Compress) + "`n", (New-Object System.Text.UTF8Encoding $false)); $__s.log = $true } catch { $__s.log = $false }',
  '$__s }',
].join('; ');

const END = [
  'function __lhEnd { param($__s, [object[]]$__all, $__code, [bool]$__hasIn, [object[]]$__in)',
  '$ErrorActionPreference = \'Continue\'',
  '$__enc = New-Object System.Text.UTF8Encoding $false',
  '$__d = @@CALLS@@',
  'if ($__s.log) { try { $__t1 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); '
    + '$__out = New-Object System.Text.StringBuilder; $__err = New-Object System.Text.StringBuilder; '
    + 'foreach ($__l in $__all) { if ($__l -is [System.Management.Automation.ErrorRecord]) { if ($__l.TargetObject -is [string] -and "$($__l.FullyQualifiedErrorId)".StartsWith(\'NativeCommandError\')) { [void]$__err.AppendLine($__l.TargetObject) } else { [void]$__err.AppendLine($__l.ToString()) } } else { [void]$__out.AppendLine("$__l") } }; '
    + '$__o = $__out.ToString(); $__e = $__err.ToString(); '
    + 'if ($__s.cap -eq \'full\') { if ($__o.Length -gt 0) { [IO.File]::WriteAllText([IO.Path]::Combine($__d, "$($__s.id).out"), $__o, $__enc) }; if ($__e.Length -gt 0) { [IO.File]::WriteAllText([IO.Path]::Combine($__d, "$($__s.id).err"), $__e, $__enc) } }; '
    + '$__se = [ordered]@{ type = \'stream_end\'; schema = 1; callId = $__s.id; stdoutBytes = $__enc.GetByteCount($__o); stderrBytes = $__enc.GetByteCount($__e); endedAtMs = $__t1; durationMs = ($__t1 - $__s.t0) }; '
    + '[IO.File]::AppendAllText([IO.Path]::Combine($__d, "$($__s.id).jsonl"), ($__se | ConvertTo-Json -Compress) + "`n", $__enc); '
    + '$__xc = 0; if ($null -ne $__code) { $__xc = [int]$__code }; '
    + '$__x = [ordered]@{ type = \'exit\'; schema = 1; callId = $__s.id; exitCode = $__xc; endedAtMs = $__t1 }; '
    + '[IO.File]::AppendAllText([IO.Path]::Combine($__d, "$($__s.id).jsonl"), ($__x | ConvertTo-Json -Compress) + "`n", $__enc) } catch { } }',
  'foreach ($__l in $__all) { if ($__l -is [System.Management.Automation.ErrorRecord]) { if (@@ERRRAW@@) { if ($__l.TargetObject -is [string] -and "$($__l.FullyQualifiedErrorId)".StartsWith(\'NativeCommandError\')) { [Console]::Error.WriteLine($__l.TargetObject) } else { [Console]::Error.WriteLine($__l.ToString()) } } else { Write-Error -ErrorRecord $__l } } else { $__l } }',
  '$global:LASTEXITCODE = $__code }',
].join('; ');

function renderTool(tool, capture, real) {
  const t = psQuote(tool);
  const r = psQuote(real);
  const body = `{ $__s = __lhStart ${t} '${capture}' ${r} $args; `
    + `if ($MyInvocation.ExpectingInput) { $__in = @($input); $__all = @($__in | & ${r} @args 2>&1); $__hi = $true } `
    + `else { $__in = @(); $__all = @(& ${r} @args 2>&1); $__hi = $false }; `
    + `$__code = $global:LASTEXITCODE; __lhEnd $__s $__all $__code $__hi $__in }`;
  const names = [tool];
  if (!/\.exe$/i.test(tool)) names.push(`${tool}.exe`);
  const defs = names.map((n) => `Set-Item -LiteralPath ${psQuote(`function:${n}`)} -Value ${body}`).join('; ');
  return `if ((Get-Command -Name ${t} -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Path -eq ${r}) { ${defs} }`;
}

function buildStaticPrefix(tools, opts) {
  const fill = (s) => s
    .replace(/@@CALLS@@/g, () => psQuote(path.join(opts.sessionDir, 'calls')))
    .replace(/@@SID@@/g, () => psQuote(opts.sessionId))
    .replace(/@@ERRRAW@@/g, opts.stderrRedirected ? '$false' : '$true');
  const parts = [];
  for (const t of tools) {
    const real = resolveApplication(t.name);
    if (real) parts.push(renderTool(t.name, t.capture, real));
  }
  if (parts.length === 0) return '';
  return [fill(START), fill(END), ...parts].join('; ') + '; ';
}

module.exports = { buildStaticPrefix, resolveApplication, psQuote };
