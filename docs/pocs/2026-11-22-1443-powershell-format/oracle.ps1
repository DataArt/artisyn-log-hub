# Independent oracle: the real PowerShell parser (5.1 or 7) over out-pairs.json ([{src, fmt}]).
# For every pair: does the original parse, and is the formatted text the same token sequence
# (ignoring NewLine / Semi / LineContinuation / EndOfInput)?
# Usage: powershell -NoProfile -File oracle.ps1 [pairs.json] [out.json]
param([string]$PairsFile = 'out-pairs.json', [string]$OutFile = '')
$ErrorActionPreference = 'Stop'
$pairs = [System.IO.File]::ReadAllText((Resolve-Path $PairsFile), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$skip = @('NewLine', 'Semi', 'LineContinuation', 'EndOfInput')

function Get-Toks([string]$s) {
  $t = $null; $e = $null
  [void][System.Management.Automation.Language.Parser]::ParseInput($s, [ref]$t, [ref]$e)
  $list = foreach ($x in $t) { if ($skip -notcontains [string]$x.Kind) { "$($x.Kind)|$($x.Text)" } }
  [pscustomobject]@{ Toks = @($list); Errors = @($e).Count }
}

$n = 0; $srcErr = 0; $same = 0; $newErr = 0; $diff = @()
foreach ($p in $pairs) {
  $n++
  $a = Get-Toks $p.src
  $b = Get-Toks $p.fmt
  if ($a.Errors -gt 0) { $srcErr++ }
  if ($b.Errors -gt $a.Errors) { $newErr++ }
  if (($a.Toks -join "`u{1}") -ceq ($b.Toks -join "`u{1}")) { $same++ } else { $diff += $p }
}
"PowerShell $($PSVersionTable.PSVersion): pairs=$n srcParseErrors=$srcErr sameTokens=$same newErrors=$newErr"
if ($OutFile) { $diff | ConvertTo-Json -Depth 3 | Set-Content -Encoding utf8 $OutFile }
