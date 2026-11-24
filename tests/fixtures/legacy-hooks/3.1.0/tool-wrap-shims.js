'use strict';
/**
 * Claude Code Hook helper — the Bash side of the CLI tool wrapper (not a hook entry point): shim
 * generation, the SessionStart pre-flight, the `CLAUDE_ENV_FILE` PATH export, the breaker and the
 * pruning of old session dirs.
 *
 * At SessionStart (`setupSessionToolWrap`, called by lifecycle-hook.js) the hook writes one Bash
 * script per monitored tool into `<workDir>/tool-wrap/<sessionId>/shims/`, runs a pre-flight and,
 * when it passes, appends `export PATH="<shim dir>:$PATH"` to `$CLAUDE_ENV_FILE`, which Claude Code
 * sources before every Bash tool command. PowerShell does not read that file; it is wrapped by the
 * PreToolUse hook instead (tool-wrap-powershell.js).
 *
 * Session dir layout (`<workDir>/tool-wrap/<sessionId>/`):
 *   shims/<tool>, shims/__selftest — the generated scripts (0755);
 *   calls/<callId>.jsonl            — the call's records, written in order by that call only:
 *                                     `start` (shim) → `stream_end` (tool-wrap-tee.js) → `exit` (shim);
 *   calls/<callId>.out/.err/.in     — raw stdout / stderr / stdin bytes (capture `full` only);
 *   off/<tool>, off/__all           — kill markers (tool-wrap-config.js `writeSessionMarkers`);
 *   mode/<tool>.meta                — capture records only, no output text;
 *   breaker/<tool>, breaker/__global, breaker/faults — the wrapper's own circuit breaker;
 *   preflight.json                  — this session's pre-flight result (reported in `tool_wrap_status`).
 *
 * Record shapes (one JSON line each; tool-wrap-records.js assembles them into the `tool-calls` log):
 *   start:      { type:'start', schema:1, callId, sessionId, tool, args: string[], real, cwd,
 *                 shell:'bash', capture:'full'|'meta', startedAtMs, pid } — `real` and `cwd` are the
 *                 shell's own spelling (Git-Bash form `/c/...` on Windows);
 *   stream_end: see tool-wrap-tee.js;
 *   exit:       { type:'exit', schema:1, callId, exitCode, endedAtMs }.
 * A call with no `exit` record was killed (or is still running).
 *
 * Fail-open everywhere: nothing here throws to the caller, a shim that cannot log execs the real tool
 * unchanged, and a failed pre-flight injects nothing.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { ensureWorkDir } = require('./git-context');
const {
  validateToolName,
  normalizeToolName,
  SESSION_DIR_MAX_AGE_MS,
  BREAKER_GLOBAL_FAULTS,
  SELF_TEST_OUTPUT,
  SELF_TEST_SHIM_NAME,
} = require('./tool-wrap-names');
const toolWrapConfig = require('./tool-wrap-config');

const SHIMS_DIR = 'shims';
const CALLS_DIR = 'calls';
const BREAKER_DIR = 'breaker';
const BREAKER_FAULTS_FILE = 'faults';
const BREAKER_GLOBAL_MARKER = '__global';
const PREFLIGHT_FILE = 'preflight.json';
const TEE_SCRIPT = path.join(__dirname, 'tool-wrap-tee.js');
/** Upper bound on the `__selftest` run (bash + node start; slow on a cold Windows machine). */
const PREFLIGHT_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Templates (DD-13). Placeholders @@NAME@@ are replaced by single-quoted shell words.
// ---------------------------------------------------------------------------

const POSIX_SHIM_TEMPLATE = `#!/usr/bin/env bash
# Log Hub CLI tool wrapper for one monitored tool — generated at SessionStart by the Log Hub hook
# (tool-wrap-shims.js). Do not edit: it is regenerated for every session.
#
# The shell runs the real tool itself, exactly as without the wrapper (same PATH lookup, argv[0],
# arguments, stdin, stderr and exit code); node only tees stdout. Anything unusual — a kill switch,
# a breaker, nesting, no node, an internal failure — execs the real tool unchanged.
shopt -u patsub_replacement 2>/dev/null
__lh_tool=@@TOOL@@
__lh_sid=@@SID@@
__lh_shims=@@SHIMS@@
__lh_sdir=@@SDIR@@
__lh_calls_n=@@CALLS_NATIVE@@
__lh_tee_js=@@TEE_JS@@
__lh_max_faults=@@MAX_FAULTS@@

# PATH without the shim dir (every entry naming it, in any spelling the shell resolves to it).
__lh_path=
__lh_first=1
__lh_rest="$PATH:"
while [ -n "$__lh_rest" ]; do
  __lh_e=\${__lh_rest%%:*}
  __lh_rest=\${__lh_rest#*:}
  if [ -n "$__lh_e" ]; then
    if [ "$__lh_e" = "$__lh_shims" ] || [ "$__lh_e" = "$__lh_shims/" ] || [ "$__lh_e" -ef "$__lh_shims" ]; then
      continue
    fi
  fi
  if [ -n "$__lh_first" ]; then __lh_path=$__lh_e; __lh_first=; else __lh_path="$__lh_path:$__lh_e"; fi
done

# The real tool: the first match on PATH without the shim dir; empty when there is none.
__lh_real=$(PATH=$__lh_path type -P -- "$__lh_tool" 2>/dev/null)
if [ -n "$__lh_real" ] && [ "\${__lh_real%/*}" -ef "$__lh_shims" ]; then
  __lh_in_shims=1
else
  __lh_in_shims=
fi

# Count a wrapper fault: trips this tool's breaker, and the global one after __lh_max_faults.
__lh_fault() {
  {
    mkdir -p "$__lh_sdir/breaker" &&
      : > "$__lh_sdir/breaker/$__lh_tool" &&
      printf '%s %s\\n' "$__lh_tool" "$1" >> "$__lh_sdir/breaker/faults"
  } 2>/dev/null
  __lh_n=0
  if [ -f "$__lh_sdir/breaker/faults" ]; then
    while IFS= read -r __lh_l || [ -n "$__lh_l" ]; do __lh_n=$((__lh_n + 1)); done 2>/dev/null < "$__lh_sdir/breaker/faults"
  fi
  if [ "$__lh_n" -ge "$__lh_max_faults" ]; then : 2>/dev/null > "$__lh_sdir/breaker/__global"; fi
}

# Run the real tool unchanged, replacing this process.
__lh_pass() {
  if [ -z "$__lh_real" ] || [ -n "$__lh_in_shims" ]; then
    printf 'bash: %s: command not found\\n' "$__lh_tool" >&2
    exit 127
  fi
  PATH=$__lh_path
  export PATH
  exec -a "$__lh_tool" "$__lh_real" "$@"
}

# A fault before the tool started: count it, then run the tool unwrapped.
__lh_fault_pass() {
  __lh_fault "$1"
  __lh_pass "\${@:2}"
}

if [ -n "$__lh_in_shims" ]; then __lh_fault_pass resolved-to-shim "$@"; fi
if [ -n "$LOGHUB_SHIM_ACTIVE" ] || [ -z "$CLAUDE_CODE_SESSION_ID" ]; then __lh_pass "$@"; fi
if [ -e "$__lh_sdir/off/__all" ] || [ -e "$__lh_sdir/off/$__lh_tool" ] ||
  [ -e "$__lh_sdir/breaker/__global" ] || [ -e "$__lh_sdir/breaker/$__lh_tool" ]; then
  __lh_pass "$@"
fi
if [ -z "$(type -P node 2>/dev/null)" ]; then __lh_pass "$@"; fi
if [ -z "$__lh_real" ]; then __lh_pass "$@"; fi

__lh_mode=full
if [ -e "$__lh_sdir/mode/$__lh_tool.meta" ]; then __lh_mode=meta; fi
__lh_d="$__lh_sdir/calls"
mkdir -p "$__lh_d" 2>/dev/null || __lh_fault_pass mkdir "$@"

# Epoch milliseconds without a subprocess where the shell can (bash 5: EPOCHREALTIME).
__lh_now_ms() {
  if [ -n "$EPOCHREALTIME" ]; then
    __lh_t=\${EPOCHREALTIME//[.,]/}
    __lh_ms=\${__lh_t:0:\${#__lh_t}-3}
  else
    __lh_ms="$(date +%s)000"
  fi
}

# Append a JSON string literal of $1 to __lh_json (control characters other than \\n \\r \\t become ?).
__lh_jstr() {
  local s=$1
  s=\${s//\\\\/\\\\\\\\}
  s=\${s//\\"/\\\\\\"}
  s=\${s//$'\\n'/\\\\n}
  s=\${s//$'\\r'/\\\\r}
  s=\${s//$'\\t'/\\\\t}
  s=\${s//[$'\\001'-$'\\037']/?}
  __lh_json="$__lh_json\\"$s\\""
}

__lh_now_ms
__lh_start_ms=$__lh_ms
printf -v __lh_rnd '%04x' "$((RANDOM % 65536))"
__lh_id="$__lh_start_ms-$$-$__lh_rnd"

__lh_json='{"type":"start","schema":1,"callId":"'"$__lh_id"'","sessionId":"'"$__lh_sid"'","tool":'
__lh_jstr "$__lh_tool"
__lh_json="$__lh_json,\\"args\\":["
__lh_sep=
for __lh_a in "$@"; do
  __lh_json="$__lh_json$__lh_sep"
  __lh_jstr "$__lh_a"
  __lh_sep=,
done
__lh_json="$__lh_json],\\"real\\":"
__lh_jstr "$__lh_real"
__lh_json="$__lh_json,\\"cwd\\":"
__lh_jstr "$PWD"
__lh_json="$__lh_json,\\"shell\\":\\"bash\\",\\"capture\\":\\"$__lh_mode\\",\\"startedAtMs\\":$__lh_start_ms,\\"pid\\":$$}"
printf '%s\\n' "$__lh_json" 2>/dev/null >> "$__lh_d/$__lh_id.jsonl" || __lh_fault_pass start-record "$@"

# Run the tool. Each pipeline element runs in its own subshell, so \`exec -a\` keeps argv[0] as typed.
if [ "$__lh_mode" = full ]; then
  __lh_in_pid=
  if [ -p /dev/stdin ] || [ -f /dev/stdin ]; then
    # stdin is a pipe or a file: copy it to .in on the way. The copier is not waited for (a pipe
    # that never closes must not hang the call); it is stopped once the tool has exited.
    exec 3< <(tee "$__lh_d/$__lh_id.in" 2>/dev/null)
    __lh_in_pid=$!
  else
    # (braces: a redirection on a bare \`exec\` would apply to the shim for good)
    { exec 3<&0; } 2>/dev/null || exec 3</dev/null
  fi
  {
    export LOGHUB_SHIM_ACTIVE=1 PATH="$__lh_path"
    exec -a "$__lh_tool" "$__lh_real" "$@" <&3 3<&-
  } 2> >(tee "$__lh_d/$__lh_id.err" >&2) |
    MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' node "$__lh_tee_js" "$__lh_calls_n" "$__lh_id" full 3<&-
  __lh_st=("\${PIPESTATUS[@]}")
  exec 3<&-
  if [ -n "$__lh_in_pid" ]; then kill "$__lh_in_pid" 2>/dev/null; fi
else
  {
    export LOGHUB_SHIM_ACTIVE=1 PATH="$__lh_path"
    exec -a "$__lh_tool" "$__lh_real" "$@"
  } | MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' node "$__lh_tee_js" "$__lh_calls_n" "$__lh_id" meta
  __lh_st=("\${PIPESTATUS[@]}")
fi
__lh_code=\${__lh_st[0]}
if [ "\${__lh_st[1]}" != 0 ]; then __lh_fault "tee-exit-\${__lh_st[1]}"; fi

__lh_now_ms
printf '{"type":"exit","schema":1,"callId":"%s","exitCode":%d,"endedAtMs":%s}\\n' "$__lh_id" "$__lh_code" "$__lh_ms" 2>/dev/null >> "$__lh_d/$__lh_id.jsonl"
# A tool killed by HUP / INT / QUIT / PIPE / TERM: die of the same signal, so the parent sees a
# signal death as without the wrapper (bash itself carries on, because the tee ignores SIGINT).
case "$__lh_code" in
  129|130|131|141|143)
    __lh_sig=$((__lh_code - 128))
    trap - "$__lh_sig" 2>/dev/null
    kill -"$__lh_sig" "$$" 2>/dev/null
    ;;
esac
exit "$__lh_code"
`;

const SELF_TEST_SHIM_TEMPLATE = `#!/usr/bin/env bash
# Log Hub tool-wrap pre-flight self-test — generated at SessionStart by the Log Hub hook
# (tool-wrap-shims.js). Do not edit. Checks what every tool wrapper of this session relies on:
# bash with process substitution and PIPESTATUS, \`tee\`, \`node\` and the stdout tee script.
if [ -z "$(type -P tee 2>/dev/null)" ]; then echo 'loghub-selftest: tee not found' >&2; exit 3; fi
if [ -z "$(type -P node 2>/dev/null)" ]; then echo 'loghub-selftest: node not found' >&2; exit 4; fi
{
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' node @@TEE_JS@@ --self-test < /dev/null
} 2> >(tee >&2) | tee
__lh_st=("\${PIPESTATUS[@]}")
if [ "\${__lh_st[0]}" != 0 ] || [ "\${__lh_st[1]}" != 0 ]; then
  echo "loghub-selftest: pipeline failed (\${__lh_st[*]})" >&2
  exit 5
fi
exit 0
`;

/**
 * Quote a string as one single-quoted POSIX shell word.
 * @param {string} s
 * @returns {string}
 */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, '\'\\\'\'')}'`;
}

/**
 * Replace every `@@KEY@@` placeholder of a template with the shell-quoted value.
 * @param {string} template
 * @param {Record<string, string|number>} values
 * @returns {string}
 */
function fillTemplate(template, values) {
  return template.replace(/@@([A-Z_]+)@@/g, (whole, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return whole;
    const v = values[key];
    return typeof v === 'number' ? String(v) : shellQuote(v);
  });
}

/**
 * The path as Git Bash spells it: `C:\a\b` → `/c/a/b`, `\\srv\share\x` → `//srv/share/x`.
 * Any other path (Linux, macOS) is returned unchanged.
 * @param {string} p
 * @returns {string}
 */
function toGitBashPath(p) {
  const s = String(p);
  const drive = /^([A-Za-z]):(?:[\\/]|$)(.*)$/.exec(s);
  if (drive) {
    const rest = drive[2].replace(/\\/g, '/').replace(/\/+$/, '');
    return `/${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
  }
  if (/^\\\\/.test(s) || process.platform === 'win32') return s.replace(/\\/g, '/');
  return s;
}

/**
 * Render the Bash wrapper of one tool (DD-13). The wrapper:
 *   - passes through (execs the real tool from PATH minus the shim dir) when `LOGHUB_SHIM_ACTIVE`
 *     is set, `CLAUDE_CODE_SESSION_ID` is unset, an `off/` or `breaker/` marker exists, `node` is
 *     not on PATH, or a pre-run step fails (the failure is counted as a breaker fault);
 *   - resolving to a file inside the shim dir counts as a fault and answers `command not found`
 *     (127), so a wrapper can never call itself;
 *   - otherwise writes `start`, runs `"$real" "$@"` with `LOGHUB_SHIM_ACTIVE=1`, stdin copied to
 *     `.in` when it is a pipe or a file, stderr through `tee` into `.err`, stdout through
 *     tool-wrap-tee.js, then writes `exit` and exits with the tool's own code (`PIPESTATUS[0]`).
 * Capture `meta` (marker `mode/<tool>.meta`) writes the records but no `.out` / `.err` / `.in`.
 * @param {string} tool - a valid tool name (validateToolName)
 * @param {{ sessionId: string, sessionDir: string, shimDir?: string, teeScript?: string,
 *   maxFaults?: number }} opts - native paths; the shell-side spellings are derived here
 * @returns {string}
 */
function renderPosixShim(tool, opts) {
  const sessionDir = opts.sessionDir;
  const shimDir = opts.shimDir || path.join(sessionDir, SHIMS_DIR);
  return fillTemplate(POSIX_SHIM_TEMPLATE, {
    TOOL: tool,
    SID: opts.sessionId,
    SHIMS: toGitBashPath(shimDir),
    SDIR: toGitBashPath(sessionDir),
    CALLS_NATIVE: path.join(sessionDir, CALLS_DIR),
    TEE_JS: opts.teeScript || TEE_SCRIPT,
    MAX_FAULTS: Number.isInteger(opts.maxFaults) && opts.maxFaults > 0 ? opts.maxFaults : BREAKER_GLOBAL_FAULTS,
  });
}

/**
 * Render the `__selftest` script the pre-flight runs.
 * @param {{ teeScript?: string }} [opts]
 * @returns {string}
 */
function renderSelfTestShim(opts) {
  return fillTemplate(SELF_TEST_SHIM_TEMPLATE, { TEE_JS: (opts && opts.teeScript) || TEE_SCRIPT });
}

/**
 * Whether `file` is an existing regular file the current user may execute (Windows: exists).
 * @param {string} file
 * @returns {boolean}
 */
function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first file on `envPath` that runs as `name` — on Windows also `name.exe` (what Git Bash
 * finds; it cannot run `.cmd` / `.bat`). Null when there is none.
 * @param {string} name
 * @param {string} [envPath] - defaults to process.env.PATH
 * @param {{ skipDirs?: string[] }} [opts] - directories to ignore (compared resolved, case-insensitively on Windows)
 * @returns {string|null}
 */
function findOnPath(name, envPath, opts) {
  const pathValue = envPath === undefined ? (process.env.PATH || process.env.Path || '') : envPath;
  const win = process.platform === 'win32';
  const norm = (d) => (win ? path.resolve(d).toLowerCase() : path.resolve(d));
  const skip = new Set(((opts && opts.skipDirs) || []).map(norm));
  const names = win && !/\.exe$/i.test(name) ? [name, `${name}.exe`] : [name];
  for (const raw of pathValue.split(path.delimiter)) {
    const dir = raw.replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    if (skip.size > 0 && skip.has(norm(dir))) continue;
    for (const n of names) {
      const candidate = path.join(dir, n);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Write the shim dir of a session: every tool resolvable on PATH gets a wrapper, plus `__selftest`.
 * Written into a temp dir first and then renamed into place, so a running shell never sees a
 * half-written dir; a previous `shims/` of the same session (resume, /clear) is swapped out.
 * @param {string} sessionDir - `<workDir>/tool-wrap/<sessionId>`
 * @param {(string|{ name: string })[]} tools
 * @param {{ envPath?: string, teeScript?: string }} [opts]
 * @returns {{ shimDir: string, generated: string[], missing: string[] }|null} null on a write failure
 */
function generateShimDir(sessionDir, tools, opts) {
  const sessionId = path.basename(sessionDir);
  const shimDir = path.join(sessionDir, SHIMS_DIR);
  const stamp = `${process.pid}-${Date.now()}`;
  const tmpDir = path.join(sessionDir, `${SHIMS_DIR}.tmp-${stamp}`);
  const oldDir = path.join(sessionDir, `${SHIMS_DIR}.old-${stamp}`);
  const generated = [];
  const missing = [];
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const seen = new Set();
    for (const t of Array.isArray(tools) ? tools : []) {
      const name = typeof t === 'string' ? t : (t && t.name);
      if (typeof name !== 'string' || !validateToolName(name).ok) continue;
      const key = normalizeToolName(name);
      if (seen.has(key)) continue;
      seen.add(key);
      // A tool the shell cannot find gets no wrapper: its `command not found` / 127 stays untouched.
      if (!findOnPath(name, opts && opts.envPath)) {
        missing.push(name);
        continue;
      }
      const file = path.join(tmpDir, name);
      fs.writeFileSync(file, renderPosixShim(name, {
        sessionId,
        sessionDir,
        shimDir,
        teeScript: opts && opts.teeScript,
      }));
      fs.chmodSync(file, 0o755);
      generated.push(name);
    }
    const selfTest = path.join(tmpDir, SELF_TEST_SHIM_NAME);
    fs.writeFileSync(selfTest, renderSelfTestShim({ teeScript: opts && opts.teeScript }));
    fs.chmodSync(selfTest, 0o755);

    let swapped = false;
    if (fs.existsSync(shimDir)) {
      fs.renameSync(shimDir, oldDir);
      swapped = true;
    }
    fs.renameSync(tmpDir, shimDir);
    if (swapped) removeOwnDir(sessionDir, oldDir);
    return { shimDir, generated, missing };
  } catch {
    removeOwnDir(sessionDir, tmpDir);
    return null;
  }
}

/**
 * Best-effort removal of a temp / swapped-out shim dir this module created: only a direct child of
 * `sessionDir` named `shims.tmp-*` / `shims.old-*`, never a symlink.
 * @param {string} sessionDir
 * @param {string} dir
 */
function removeOwnDir(sessionDir, dir) {
  try {
    if (path.dirname(path.resolve(dir)) !== path.resolve(sessionDir)) return;
    if (!/^shims\.(tmp|old)-[0-9]+-[0-9]+$/.test(path.basename(dir))) return;
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return;
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // a file still open on Windows: left for the next prune of the whole session dir
  }
}

/**
 * The bash the agent's Bash tool runs. Windows: `CLAUDE_CODE_GIT_BASH_PATH`, else Git for Windows'
 * `bin\bash.exe` next to `git.exe`, else a `bash.exe` on PATH outside `System32` / `WindowsApps`
 * (those are WSL launchers). Elsewhere: `bash` on PATH. Null when none is found.
 * @returns {string|null}
 */
function resolveBash() {
  if (process.platform !== 'win32') return findOnPath('bash');
  const fromEnv = (process.env.CLAUDE_CODE_GIT_BASH_PATH || '').trim();
  if (fromEnv && isExecutableFile(fromEnv)) return fromEnv;
  const git = findOnPath('git');
  if (git) {
    const gitDir = path.dirname(git);
    for (const rel of ['../bin/bash.exe', '../../bin/bash.exe', '../usr/bin/bash.exe', 'bash.exe']) {
      const candidate = path.resolve(gitDir, rel);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  const pathValue = process.env.PATH || process.env.Path || '';
  const wsl = pathValue.split(path.delimiter)
    .filter((d) => /\\(System32|WindowsApps)\\?$/i.test(d.replace(/^"(.*)"$/, '$1')));
  return findOnPath('bash', pathValue, { skipDirs: wsl });
}

/**
 * SessionStart pre-flight (DD-15): bash resolves, and `<shimDir>/__selftest` — which checks that
 * `tee` and `node` resolve inside that bash and pipes the tee script's `--self-test` through
 * process substitution and `PIPESTATUS` — prints SELF_TEST_OUTPUT and exits 0.
 * @param {string} shimDir
 * @param {{ bash?: string|null, timeoutMs?: number }} [opts]
 * @returns {{ ok: boolean, reason: string|null, bash: string|null }}
 */
function runPreflight(shimDir, opts) {
  try {
    const bash = opts && opts.bash !== undefined ? opts.bash : resolveBash();
    if (!bash) return { ok: false, reason: 'bash not found', bash: null };
    const selfTest = path.join(shimDir, SELF_TEST_SHIM_NAME);
    if (!fs.existsSync(selfTest)) return { ok: false, reason: 'self-test script missing', bash };
    const env = { ...process.env };
    delete env.LOGHUB_SHIM_ACTIVE;
    const res = spawnSync(bash, [toGitBashPath(selfTest), '--self-test'], {
      encoding: 'utf8',
      timeout: (opts && opts.timeoutMs) || PREFLIGHT_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    if (res.error) {
      return { ok: false, reason: `self-test did not run: ${res.error.code || res.error.message}`, bash };
    }
    const out = String(res.stdout || '').trim();
    if (res.status !== 0 || out !== SELF_TEST_OUTPUT) {
      const err = String(res.stderr || '').trim().split(/\r?\n/).pop() || '';
      return {
        ok: false,
        reason: `self-test failed (exit ${res.status === null ? res.signal : res.status})${err ? `: ${err.slice(0, 200)}` : ''}`,
        bash,
      };
    }
    return { ok: true, reason: null, bash };
  } catch (err) {
    return { ok: false, reason: `self-test error: ${err && err.message}`, bash: null };
  }
}

/**
 * The line that puts the shim dir first on the Bash tool's PATH. `"`, `\`, `$` and backquotes in
 * the path are escaped for the double-quoted shell word.
 * @param {string} shimDir - native path
 * @returns {string}
 */
function envFileExportLine(shimDir) {
  const escaped = toGitBashPath(shimDir).replace(/(["\\$`])/g, '\\$1');
  return `export PATH="${escaped}:$PATH"`;
}

/**
 * Append the PATH export to `$CLAUDE_ENV_FILE` (DD-15), once: an identical line already in the
 * file is not repeated. Starts on a new line when the file does not end with one.
 * @param {string} envFile
 * @param {string} shimDir - native path
 * @returns {boolean} whether the export is in the file afterwards
 */
function appendEnvFileExport(envFile, shimDir) {
  try {
    if (!envFile) return false;
    const line = envFileExportLine(shimDir);
    let existing = '';
    try {
      existing = fs.readFileSync(envFile, 'utf8');
    } catch {
      existing = '';
    }
    if (existing.split(/\r?\n/).includes(line)) return true;
    const lead = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(envFile, `${lead}${line}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete session dirs under `<workDir>/tool-wrap/` older than SESSION_DIR_MAX_AGE_MS (DD-15),
 * with the DD-27 guards: only direct children whose name is a session id, checked with `lstat`
 * (a symlink or junction is never followed or deleted), never `tool-wrap` itself, never the
 * current session. Age = the newest mtime of the dir, its `calls/` and its `preflight.json`.
 * @param {string} workDir - `<root>/.artisyn/ai_work_dir`
 * @param {{ now?: number, keepSessionId?: string|null, maxAgeMs?: number }} [opts]
 * @returns {number} how many session dirs were removed
 */
function pruneOldSessionDirs(workDir, opts) {
  let removed = 0;
  try {
    if (!workDir) return 0;
    const root = path.resolve(workDir, toolWrapConfig.TOOL_WRAP_DIR);
    let rootStat;
    try {
      rootStat = fs.lstatSync(root);
    } catch {
      return 0;
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return 0;
    const now = (opts && typeof opts.now === 'number') ? opts.now : Date.now();
    const maxAge = (opts && typeof opts.maxAgeMs === 'number') ? opts.maxAgeMs : SESSION_DIR_MAX_AGE_MS;
    const keep = opts && opts.keepSessionId;
    for (const name of fs.readdirSync(root)) {
      if (!toolWrapConfig.SESSION_ID_PATTERN.test(name) || name === keep) continue;
      const dir = path.join(root, name);
      if (path.dirname(dir) !== root) continue;
      try {
        const st = fs.lstatSync(dir);
        if (st.isSymbolicLink() || !st.isDirectory()) continue;
        let newest = st.mtimeMs;
        for (const sub of [CALLS_DIR, PREFLIGHT_FILE]) {
          try {
            const s = fs.lstatSync(path.join(dir, sub));
            if (s.mtimeMs > newest) newest = s.mtimeMs;
          } catch {
            // absent
          }
        }
        if (now - newest <= maxAge) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch {
        // one unremovable dir (open file on Windows) never stops the others
      }
    }
  } catch {
    // pruning is best-effort
  }
  return removed;
}

/**
 * Count one wrapper fault (DD-15): trips `breaker/<tool>` and, once `breaker/faults` holds
 * BREAKER_GLOBAL_FAULTS lines, `breaker/__global`. The shims check both like the `off/` markers.
 * Same files as the shell-side `__lh_fault` of the Bash template.
 * @param {string} sessionDir
 * @param {string|null} tool - null / invalid: counts towards the global breaker only
 * @param {string} [reason]
 * @returns {{ count: number, global: boolean }}
 */
function recordBreakerFault(sessionDir, tool, reason) {
  try {
    const dir = path.join(sessionDir, BREAKER_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const valid = typeof tool === 'string' && validateToolName(tool).ok;
    if (valid) fs.writeFileSync(path.join(dir, tool), '');
    const label = valid ? tool : '-';
    const why = String(reason || 'fault').replace(/[\r\n]+/g, ' ').slice(0, 200);
    const faultsFile = path.join(dir, BREAKER_FAULTS_FILE);
    fs.appendFileSync(faultsFile, `${label} ${why}\n`);
    const count = fs.readFileSync(faultsFile, 'utf8').split('\n').filter((l) => l.trim()).length;
    const global = count >= BREAKER_GLOBAL_FAULTS;
    if (global) fs.writeFileSync(path.join(dir, BREAKER_GLOBAL_MARKER), '');
    return { count, global };
  } catch {
    return { count: 0, global: false };
  }
}

/**
 * The breaker state of a session: `{ global, tools }` (for `tool_wrap_status`).
 * @param {string} sessionDir
 * @returns {{ global: boolean, tools: string[] }}
 */
function readBreakerState(sessionDir) {
  try {
    const dir = path.join(sessionDir, BREAKER_DIR);
    const names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
    return {
      global: names.includes(BREAKER_GLOBAL_MARKER),
      tools: names.filter((n) => n !== BREAKER_GLOBAL_MARKER && n !== BREAKER_FAULTS_FILE && validateToolName(n).ok),
    };
  } catch {
    return { global: false, tools: [] };
  }
}

/**
 * Write `<sessionDir>/preflight.json`. Never throws.
 * @param {string} sessionDir
 * @param {object} result
 * @returns {boolean}
 */
function writePreflightFile(sessionDir, result) {
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, PREFLIGHT_FILE), JSON.stringify(result, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read `<sessionDir>/preflight.json`, or null.
 * @param {string} sessionDir
 * @returns {object|null}
 */
function readPreflightFile(sessionDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(sessionDir, PREFLIGHT_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The whole SessionStart sequence of DD-15. Skips everything — writing no file — under a kill
 * switch (`LOGHUB_TOOL_WRAP=0`, `toolWrap: false`), without `CLAUDE_ENV_FILE`, without a usable
 * session id, without a config (fetch failed and no cache), when paused or with no tools. Otherwise
 * prunes old session dirs, generates the shims, rewrites the session's markers, runs the pre-flight,
 * appends the PATH export on success and writes `preflight.json`. Never throws, never writes stdout.
 *
 * `preflight.json`: `{ schema:1, ok, reason|null, shells:{ bash, powershell }, tools:[{name,capture}],
 * generated: string[], missing: string[], os, at }` — `shells.bash` = the Bash shims are on PATH;
 * `shells.powershell` = the PowerShell wrapper may act (it needs only the config).
 *
 * @param {{ cwd: string|null, sessionId: string|null, config: Record<string, *>, envFile?: string|null }} args
 * @returns {Promise<{ status: 'skipped'|'ok'|'failed', reason: string|null, sessionDir?: string,
 *   generated?: string[], missing?: string[], pruned?: number }>}
 */
async function setupSessionToolWrap(args) {
  try {
    const { cwd, sessionId, config } = args;
    const envFile = args.envFile === undefined ? process.env.CLAUDE_ENV_FILE : args.envFile;
    if (toolWrapConfig.isToolWrapDisabled(config)) return { status: 'skipped', reason: 'disabled locally' };
    if (!envFile) return { status: 'skipped', reason: 'no CLAUDE_ENV_FILE' };
    const sessionDir = toolWrapConfig.sessionDirPath(cwd, sessionId);
    if (!sessionDir) return { status: 'skipped', reason: 'no usable session id' };

    const pruned = pruneOldSessionDirs(ensureWorkDir(cwd), { keepSessionId: sessionId });

    let cfg = await toolWrapConfig.fetchToolWrapConfig(cwd, config);
    if (cfg) toolWrapConfig.writeCache(cwd, cfg);
    else cfg = toolWrapConfig.readCache(cwd);
    if (!cfg) return { status: 'skipped', reason: 'no config', pruned };

    const tools = toolWrapConfig.effectiveTools(cfg);
    if (tools.length === 0) {
      // A resumed session may still have shims on PATH: make them pass through.
      if (fs.existsSync(sessionDir)) {
        toolWrapConfig.writeSessionMarkers(sessionDir, cfg, toolWrapConfig.listGeneratedTools(sessionDir));
      }
      return { status: 'skipped', reason: cfg.paused ? 'paused' : 'no monitored tools', pruned };
    }

    fs.mkdirSync(sessionDir, { recursive: true });
    const gen = generateShimDir(sessionDir, tools);
    let ok = false;
    let reason = null;
    if (!gen) {
      reason = 'could not write the shim dir';
    } else {
      toolWrapConfig.writeSessionMarkers(sessionDir, cfg, gen.generated);
      if (gen.generated.length === 0) {
        reason = 'none of the monitored tools is on PATH';
      } else {
        const pf = runPreflight(gen.shimDir);
        if (!pf.ok) reason = pf.reason;
        else if (!appendEnvFileExport(envFile, gen.shimDir)) reason = 'could not write CLAUDE_ENV_FILE';
        else ok = true;
      }
    }
    writePreflightFile(sessionDir, {
      schema: 1,
      ok,
      reason,
      shells: { bash: ok, powershell: true },
      tools,
      generated: gen ? gen.generated : [],
      missing: gen ? gen.missing : [],
      os: process.platform,
      at: new Date().toISOString(),
    });
    return {
      status: ok ? 'ok' : 'failed',
      reason,
      sessionDir,
      generated: gen ? gen.generated : [],
      missing: gen ? gen.missing : [],
      pruned,
    };
  } catch (err) {
    return { status: 'failed', reason: `tool-wrap setup error: ${err && err.message}` };
  }
}

module.exports = {
  SHIMS_DIR,
  CALLS_DIR,
  BREAKER_DIR,
  PREFLIGHT_FILE,
  TEE_SCRIPT,
  shellQuote,
  toGitBashPath,
  renderPosixShim,
  renderSelfTestShim,
  findOnPath,
  generateShimDir,
  resolveBash,
  runPreflight,
  envFileExportLine,
  appendEnvFileExport,
  pruneOldSessionDirs,
  recordBreakerFault,
  readBreakerState,
  writePreflightFile,
  readPreflightFile,
  setupSessionToolWrap,
};
