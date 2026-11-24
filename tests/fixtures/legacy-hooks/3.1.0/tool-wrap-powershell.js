#!/usr/bin/env node
/**
 * Claude Code PreToolUse Hook (matcher `PowerShell`) — the PowerShell side of the CLI tool wrapper
 * (DD-14).
 *
 * The PowerShell tool does not read `$CLAUDE_ENV_FILE`, so the Bash shims of tool-wrap-shims.js do
 * not reach it. Instead, when a PowerShell command mentions a monitored tool as a command word
 * (`toolMentionRegex`: start, whitespace, `;`, `|`, `&` or `(` before it, optional `.exe`, then
 * whitespace or the end; case-insensitive), this hook answers with
 *   { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...tool_input, command: prefix + command } } }
 * where `prefix` defines `__lhWrap` plus one function per mentioned tool (and `<tool>.exe`), each
 * defined only when the tool resolves as an application — a missing tool is never shadowed, so its
 * own "not recognized" error stays untouched. No permission decision is returned: the normal
 * permission flow still applies to the call.
 *
 * Bypass-only (DD-1): the command is rewritten only when the PreToolUse input has
 * `permission_mode === 'bypassPermissions'` (exact match). On Claude Code 2.1.311 / 2.1.326 any
 * prefix statement turns an allow-rule command into a prompt or a denial, so in every other mode —
 * or when the field is missing (older Claude Code) — the command is left exactly as typed.
 *
 * Skips are logged to `hook.log` once per session per reason (DD-3, via `claimSessionWarning`, key
 * `tool-wrap-ps:<reason>`): `permission-mode:<mode|none>`, `breaker:__global` and `breaker:<tool>`
 * (every mentioned tool has a tripped breaker), as "PowerShell call of <tools> left unwrapped:
 * <reason text>". A planning failure is logged once per session too (`tool-wrap-ps:error`). Each
 * wrapped call still logs its own "PowerShell call wraps …" line.
 *
 * FR-7: the text of a native stderr line is `Exception.Message` of its `RemoteException` (an empty
 * line stays empty), not `ErrorRecord.ToString()` (which gives the type name for an empty line);
 * other `ErrorRecord`s keep `ToString()`. This applies to the `.err` capture (and `stderrBytes`) and
 * to the raw re-emit; the `Write-Error -ErrorRecord` path re-emits the original record unchanged.
 *
 * `__lhWrap` (PowerShell 5.1 and 7):
 *   - resolves the real tool with `Get-Command -CommandType Application` (skips the function itself);
 *   - writes the `start` record to `<sessionDir>/calls/<callId>.jsonl`;
 *   - runs `& $real @args 2>&1` (pipeline input forwarded when the function received any), keeping
 *     `ErrorRecord`s apart as stderr;
 *   - writes `.out` / `.err` / `.in` (UTF-8, capture `full` only), then `stream_end` and `exit`;
 *   - re-emits stdout to the pipeline and stderr — raw to the process stderr when the command has no
 *     error-stream redirection, else via `Write-Error -ErrorRecord` (STDERR_REDIRECT) — in their
 *     original order, and restores `$LASTEXITCODE`.
 * Every logging step sits in a `try { } catch { }` that never rethrows; a logging failure trips the
 * tool's breaker. PowerShell decodes native output to strings in both the wrapped and the
 * unwrapped path, so fidelity is text-level, not byte-level (owner decision 2026-10-28).
 *
 * Nothing is wrapped — the hook exits 0 with no output — when: a local kill switch is set
 * (`LOGHUB_TOOL_WRAP=0`, `toolWrap: false`); the session has no `preflight.json` or its
 * `shells.powershell` is not true; the cached config is missing, paused or empty; `off/__all` or
 * `breaker/__global` exists; no enabled tool (without its own `off/` or `breaker/` marker) is
 * mentioned; the permission mode is not `bypassPermissions`; the command starts with `using`,
 * `#requires` or `param(` (those must stay first); or anything at all fails (fail-open).
 */

'use strict';
const fs = require('fs');
const path = require('path');

const {loadConfig} = require('./env-context');
const {hookLog} = require('./hook-log');
const {claimSessionWarning} = require('./throttle-state');
const toolWrapConfig = require('./tool-wrap-config');
const {toolMentionRegex, normalizeToolName, CAPTURE_LIMIT_BYTES, STDIN_CAPTURE_LIMIT_BYTES} =
  require('./tool-wrap-names');

const HOOK_FILE = 'tool-wrap-powershell.js';

// `--self-check`: the installer's post-install load check — every require above has run.
require('./hook-log').exitIfSelfCheck(HOOK_FILE);

/**
 * A redirection of the error stream anywhere in the command (`2>`, `2>&1`, `*>`). Without one,
 * a native tool's stderr never enters PowerShell's pipeline, so the wrapper writes it raw to the
 * process stderr exactly as unwrapped; with one, it re-emits each ErrorRecord via
 * `Write-Error -ErrorRecord` so the redirection (`2>$null`, `2>&1 | …`) acts on it as before.
 */
const STDERR_REDIRECT = /(^|[^\w$])(2|\*)>/;

/** Commands whose first statement must stay first — a prefix in front would break them. */
const MUST_STAY_FIRST = /^\s*(using\s|#requires\b|param\s*\()/i;

/**
 * Quote a string as one single-quoted PowerShell literal.
 * @param {string} s
 * @returns {string}
 */
function psQuote(s) {
  return `'${String(s).replace(/'/g, '\'\'')}'`;
}

/**
 * The text of a stderr `ErrorRecord` `$__l` (FR-7): a native tool's stderr line arrives as a
 * `RemoteException` whose `Message` is the line itself (`""` for an empty line), while
 * `ToString()` of an empty line gives the exception's type name. Other records keep `ToString()`.
 * Wrapped in `$( )` so it can be a method argument.
 */
const ERR_TEXT = '$(if ($__l.Exception -is [System.Management.Automation.RemoteException]) '
  + '{ $__l.Exception.Message } else { $__l.ToString() })';

/**
 * The `__lhWrap` function (one line). `@@CALLS@@`, `@@SDIR@@`, `@@SID@@` are replaced by
 * PowerShell literals; `@@LIMIT@@` / `@@INLIMIT@@` by numbers.
 */
const WRAP_FUNCTION = [
  'function __lhWrap { param([string]$__t, [string]$__cap, [object[]]$__a, [bool]$__hasIn, [object[]]$__in)',
  '$ErrorActionPreference = \'Continue\'',
  'if ($null -eq $__a) { $__a = @() }',
  '$__d = @@CALLS@@',
  '$__sd = @@SDIR@@',
  '$__real = $null',
  'try { $__real = (Get-Command -Name $__t -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Path } catch { }',
  'if (-not $__real) { Write-Error -Message ("The term \'" + $__t + "\' is not recognized as the name of a cmdlet, function, script file, or operable program.") -Category ObjectNotFound; return }',
  '$__log = $false',
  '$__id = $null',
  '$__enc = New-Object System.Text.UTF8Encoding $false',
  '$__t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
  'try { [void][IO.Directory]::CreateDirectory($__d); $__id = (\'{0}-{1}-{2:x4}\' -f $__t0, $PID, (Get-Random -Maximum 65536)); '
    + '$__rec = [ordered]@{ type = \'start\'; schema = 1; callId = $__id; sessionId = @@SID@@; tool = $__t; args = @($__a | ForEach-Object { "$_" }); '
    + 'real = $__real; cwd = (Get-Location).ProviderPath; shell = \'powershell\'; capture = $__cap; startedAtMs = $__t0; pid = $PID }; '
    + '[IO.File]::AppendAllText([IO.Path]::Combine($__d, "$__id.jsonl"), ($__rec | ConvertTo-Json -Compress) + "`n", $__enc); $__log = $true } catch { $__log = $false }',
  'if ($__hasIn) { $__all = @($__in | & $__real @__a 2>&1) } else { $__all = @(& $__real @__a 2>&1) }',
  '$__code = $global:LASTEXITCODE',
  'if ($__log) { try { $__t1 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); '
    + '$__out = New-Object System.Text.StringBuilder; $__err = New-Object System.Text.StringBuilder; '
    + 'foreach ($__l in $__all) { if ($__l -is [System.Management.Automation.ErrorRecord]) { [void]$__err.AppendLine(@@ERRTEXT@@) } else { [void]$__out.AppendLine("$__l") } }; '
    + '$__o = $__out.ToString(); $__e = $__err.ToString(); $__ob = $__enc.GetByteCount($__o); $__eb = $__enc.GetByteCount($__e); $__tr = $false; $__cb = 0; '
    + 'if ($__cap -eq \'full\') { '
    + 'if ($__o.Length -gt @@LIMIT@@) { $__o = $__o.Substring(0, @@LIMIT@@); $__tr = $true }; '
    + 'if ($__e.Length -gt @@LIMIT@@) { $__e = $__e.Substring(0, @@LIMIT@@); $__tr = $true }; '
    + '$__cb = $__enc.GetByteCount($__o); '
    + 'if ($__o.Length -gt 0) { [IO.File]::WriteAllText([IO.Path]::Combine($__d, "$__id.out"), $__o, $__enc) }; '
    + 'if ($__e.Length -gt 0) { [IO.File]::WriteAllText([IO.Path]::Combine($__d, "$__id.err"), $__e, $__enc) }; '
    + 'if ($__hasIn) { $__i = (@($__in | ForEach-Object { "$_" }) -join "`n"); if ($__i.Length -gt @@INLIMIT@@) { $__i = $__i.Substring(0, @@INLIMIT@@); $__tr = $true }; '
    + '[IO.File]::WriteAllText([IO.Path]::Combine($__d, "$__id.in"), $__i, $__enc) } }; '
    + '$__se = [ordered]@{ type = \'stream_end\'; schema = 1; callId = $__id; stdoutBytes = $__ob; capturedBytes = $__cb; stderrBytes = $__eb; consumerClosed = $false; truncated = $__tr; captureFailed = $false; endedAtMs = $__t1; durationMs = ($__t1 - $__t0) }; '
    + '[IO.File]::AppendAllText([IO.Path]::Combine($__d, "$__id.jsonl"), ($__se | ConvertTo-Json -Compress) + "`n", $__enc); '
    + '$__xc = 0; if ($null -ne $__code) { $__xc = [int]$__code }; '
    + '$__x = [ordered]@{ type = \'exit\'; schema = 1; callId = $__id; exitCode = $__xc; endedAtMs = $__t1 }; '
    + '[IO.File]::AppendAllText([IO.Path]::Combine($__d, "$__id.jsonl"), ($__x | ConvertTo-Json -Compress) + "`n", $__enc) } '
    + 'catch { try { $__b = [IO.Path]::Combine($__sd, \'breaker\'); [void][IO.Directory]::CreateDirectory($__b); [IO.File]::WriteAllText([IO.Path]::Combine($__b, $__t), \'\'); '
    + '[IO.File]::AppendAllText([IO.Path]::Combine($__b, \'faults\'), ($__t + " powershell-record`n"), $__enc) } catch { } } }',
  'foreach ($__l in $__all) { if ($__l -is [System.Management.Automation.ErrorRecord]) { if (@@ERRRAW@@) { [Console]::Error.WriteLine(@@ERRTEXT@@) } else { Write-Error -ErrorRecord $__l } } else { $__l } }',
  '$global:LASTEXITCODE = $__code }',
].join('; ').replace(/@@ERRTEXT@@/g, () => ERR_TEXT);

/**
 * The definition of one tool's function (and its `.exe` spelling), only when the tool resolves as
 * an application. Pipeline input is forwarded only when the function actually received some, so a
 * tool that reads stdin when it is not a terminal behaves as unwrapped.
 * @param {string} tool - a valid tool name
 * @param {'full'|'meta'} capture
 * @returns {string}
 */
function renderToolFunction(tool, capture) {
  const t = psQuote(tool);
  const body = `{ if ($MyInvocation.ExpectingInput) { __lhWrap ${t} '${capture}' $args $true @($input) } `
    + `else { __lhWrap ${t} '${capture}' $args $false @() } }`;
  const names = [tool];
  if (!/\.exe$/i.test(tool)) names.push(`${tool}.exe`);
  const defs = names.map((n) => `Set-Item -LiteralPath ${psQuote(`function:${n}`)} -Value ${body}`).join('; ');
  return `if (Get-Command -Name ${t} -CommandType Application -ErrorAction SilentlyContinue) { ${defs} }`;
}

/**
 * The whole prefix for the mentioned tools: one line ending with `; `, so the original command's
 * own line numbers stay unchanged.
 * @param {{ name: string, capture: 'full'|'meta' }[]} tools
 * @param {{ sessionDir: string, sessionId: string, stderrRedirected?: boolean }} opts
 * @returns {string}
 */
function buildPowerShellPrefix(tools, opts) {
  const wrap = WRAP_FUNCTION
    .replace(/@@CALLS@@/g, () => psQuote(path.join(opts.sessionDir, 'calls')))
    .replace(/@@SDIR@@/g, () => psQuote(opts.sessionDir))
    .replace(/@@SID@@/g, () => psQuote(opts.sessionId))
    .replace(/@@ERRRAW@@/g, opts.stderrRedirected ? '$false' : '$true')
    .replace(/@@LIMIT@@/g, String(CAPTURE_LIMIT_BYTES))
    .replace(/@@INLIMIT@@/g, String(STDIN_CAPTURE_LIMIT_BYTES));
  return [wrap, ...tools.map((t) => renderToolFunction(t.name, t.capture))].join('; ') + '; ';
}

/**
 * Whether `file` exists. Never throws.
 * @param {string} file
 * @returns {boolean}
 */
function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/** The only permission mode in which a PowerShell call is rewritten (DD-1). */
const WRAP_PERMISSION_MODE = 'bypassPermissions';

/**
 * Drop repeated spellings of one tool (`Foo`, `foo`) — they would define the same function twice.
 * @template {{ name: string }} T
 * @param {T[]} list
 * @returns {T[]}
 */
function uniqueTools(list) {
  const unique = [];
  const seen = new Set();
  for (const t of list) {
    const key = normalizeToolName(t.name);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(t);
  }
  return unique;
}

/**
 * Decide whether and how to rewrite one PreToolUse(PowerShell) call. Pure apart from reading the
 * hook config, the cache and the session's marker files.
 *
 * Order of checks: cheap input checks → kill switch → session dir / preflight → `off/__all` →
 * effective tools and mention matching (`off/<tool>` dropped silently, `breaker/<tool>` dropped and
 * remembered) → `breaker/__global` → permission gate → prefix.
 * @param {object} input - the hook's stdin payload
 * @returns {{ updatedInput: object|null, tools: string[], skipReason: string|null }|null}
 *   `null` = nothing to do and nothing to log. Otherwise either wrapped (`updatedInput` = the
 *   rewritten `tool_input`, `skipReason: null`) or left unwrapped (`updatedInput: null`,
 *   `skipReason` one of `permission-mode:<mode|none>`, `breaker:__global`, `breaker:<tool>`).
 *   `tools` = the wrapped tool names, or the would-be-wrapped ones when skipped.
 */
function planPowerShellWrap(input) {
  if (!input || input.tool_name !== 'PowerShell') return null;
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== 'object' || typeof toolInput.command !== 'string') return null;
  const command = toolInput.command;
  if (!command.trim() || MUST_STAY_FIRST.test(command)) return null;

  const cwd = input.cwd || null;
  const sessionId = input.session_id || null;
  if (toolWrapConfig.isToolWrapDisabled(loadConfig(cwd))) return null;

  const sessionDir = toolWrapConfig.sessionDirPath(cwd, sessionId);
  if (!sessionDir) return null;

  let preflight = null;
  try {
    preflight = JSON.parse(fs.readFileSync(path.join(sessionDir, 'preflight.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!preflight || !preflight.shells || preflight.shells.powershell !== true) return null;

  if (exists(path.join(sessionDir, 'off', toolWrapConfig.OFF_ALL_MARKER))) return null;

  const tools = toolWrapConfig.effectiveTools(toolWrapConfig.readCache(cwd));
  const mentioned = [];
  const tripped = [];
  for (const t of tools) {
    if (exists(path.join(sessionDir, 'off', t.name))) continue;
    if (!toolMentionRegex(t.name).test(command)) continue;
    if (exists(path.join(sessionDir, 'breaker', t.name))) {
      tripped.push({ name: t.name });
      continue;
    }
    const meta = exists(path.join(sessionDir, 'mode', `${t.name}${toolWrapConfig.META_MARKER_SUFFIX}`));
    mentioned.push({ name: t.name, capture: meta ? 'meta' : t.capture });
  }
  if (mentioned.length === 0 && tripped.length === 0) return null;

  const unique = uniqueTools(mentioned);
  const uniqueTripped = uniqueTools(tripped);

  if (exists(path.join(sessionDir, 'breaker', '__global'))) {
    return {
      updatedInput: null,
      tools: uniqueTools([...unique, ...uniqueTripped]).map((t) => t.name),
      skipReason: 'breaker:__global',
    };
  }
  if (unique.length === 0) {
    return {
      updatedInput: null,
      tools: uniqueTripped.map((t) => t.name),
      skipReason: `breaker:${uniqueTripped[0].name}`,
    };
  }

  const mode = input.permission_mode;
  if (mode !== WRAP_PERMISSION_MODE) {
    return {
      updatedInput: null,
      tools: unique.map((t) => t.name),
      skipReason: `permission-mode:${typeof mode === 'string' ? mode : 'none'}`,
    };
  }

  const prefix = buildPowerShellPrefix(unique, { sessionDir, sessionId, stderrRedirected: STDERR_REDIRECT.test(command) });
  return {
    updatedInput: { ...toolInput, command: prefix + command },
    tools: unique.map((t) => t.name),
    skipReason: null,
  };
}

/**
 * The `hook.log` text for a skip reason of `planPowerShellWrap` (DD-3).
 * @param {string} skipReason
 * @returns {string}
 */
function skipReasonText(skipReason) {
  if (skipReason.startsWith('permission-mode:')) {
    const mode = skipReason.slice('permission-mode:'.length);
    return `permission mode ${mode} (PowerShell calls are wrapped only in ${WRAP_PERMISSION_MODE})`;
  }
  if (skipReason === 'breaker:__global') return 'breaker tripped for all tools';
  if (skipReason.startsWith('breaker:')) return `breaker tripped for ${skipReason.slice('breaker:'.length)}`;
  return skipReason;
}

if (require.main === module) {
  let sessionId = null;
  let cwd = null;
  try {
    let input = {};
    if (!process.stdin.isTTY) {
      try {
        const raw = fs.readFileSync(process.stdin.fd, 'utf8');
        input = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        // malformed or empty stdin
      }
    }
    sessionId = input.session_id || null;
    cwd = input.cwd || null;
    const plan = planPowerShellWrap(input);
    if (plan && plan.updatedInput) {
      const out = JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: plan.updatedInput },
      });
      hookLog(HOOK_FILE, sessionId, 'result', `tool-wrap: PowerShell call wraps ${plan.tools.join(', ')}`, cwd);
      process.stdout.write(out);
    } else if (plan && plan.skipReason && claimSessionWarning(sessionId, `tool-wrap-ps:${plan.skipReason}`, cwd)) {
      hookLog(HOOK_FILE, sessionId, 'result',
        `tool-wrap: PowerShell call of ${plan.tools.join(', ')} left unwrapped: ${skipReasonText(plan.skipReason)}`, cwd);
    }
  } catch (err) {
    // Fail open: the call runs unchanged. Logged once per session.
    try {
      if (claimSessionWarning(sessionId, 'tool-wrap-ps:error', cwd)) {
        hookLog(HOOK_FILE, sessionId, 'error', `tool-wrap PowerShell planning failed: ${err && err.message}`, cwd);
      }
    } catch {
      // never fail the call
    }
  }
  process.exitCode = 0;
}

module.exports = { planPowerShellWrap, buildPowerShellPrefix, renderToolFunction, psQuote };
