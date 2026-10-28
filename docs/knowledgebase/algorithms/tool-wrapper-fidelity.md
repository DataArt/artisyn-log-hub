---
reviewed: no
reviewer: none
---

# Tool wrapper fidelity: a wrapped CLI call behaves exactly like the unwrapped one

## Purpose

When a user monitors a CLI tool, the hook puts a wrapper in front of it in the agent's shell
(a Bash shim on `PATH`, a PowerShell function prefix). The agent must never notice: the bytes on
stdout and stderr and the exit code have to be the same as without the wrapper, whatever the
tool writes (binary, huge output, a consumer that closes early) and whatever goes wrong inside
the wrapper itself (no log dir, no `node`, a broken config cache, nesting) — in that case the
wrapper steps aside and the tool runs unchanged ("fail-open"). This doc lists the cases the
fidelity check runs and what it additionally expects from the wrapper's own records.

## Code

- Implementation: the hook's tool wrapper — `hook/.claude/telemetry_tool/tool-wrap-shims.js`
  (`generateShimDir`, `renderPosixShim`, `runPreflight`, `setupSessionToolWrap`),
  `tool-wrap-tee.js` (the stdout tee), `tool-wrap-powershell.js` (`buildPowerShellPrefix`),
  `tool-wrap-config.js` (cache, kill switches).
- Twins: none.
- Test: `hook/.claude/telemetry_tool/__tests__/tool-wrap-fidelity.algo.test.js` (`node --test`).
  It spawns real shells, so it is **skipped unless `LOGHUB_FIDELITY_TEST=1`**: the hook `npm test`
  of the fast set stays environment-free. It is run from the verification project
  `<repo>/../loghub-tool-wrap-check/` (created by `scripts/tool-wrap-check/create-check-project.mjs`):
  `npm run check` on the host, `npm run check:linux` in a Linux container. Fixture tools come from
  `LOGHUB_FIDELITY_PROJECT/bin` (the test writes its own copy into the run dir when that is
  absent; the fixture texts live in `__tests__/tool-wrap-fixtures.js`). Shims and records are
  written into a new `runs/<timestamp>/` folder (`LOGHUB_FIDELITY_RUN_DIR`, else under the
  project, else a temp dir); nothing is ever deleted.

## Rules

1. **Two runs per row.** The row's `command` runs twice in the row's shell, with the fixture
   `bin/` dir first on `PATH`:
   - *unwrapped*: nothing else changed;
   - *wrapped*: Bash — the shims of the row's `tools` are generated (`generateShimDir`, then the
     pre-flight `runPreflight` must pass), `CLAUDE_CODE_SESSION_ID` is set, and the command is
     preceded by the SessionStart export line (`envFileExportLine`: `export PATH="<shim dir>:$PATH"`),
     exactly as Claude Code sources `CLAUDE_ENV_FILE` inside the started shell;
     PowerShell — the command is rewritten by the PreToolUse hook itself (`planPowerShellWrap`
     with a cached config and a passed pre-flight, which prefixes `buildPowerShellPrefix(tools)`).
2. **Fidelity.** Both runs must give the same exit code and the same stdout and stderr. Bash
   rows compare raw bytes. PowerShell rows compare the text PowerShell prints (DD-14: PowerShell
   decodes native output to strings on both paths, so fidelity there is text-level).
3. **Records.** The wrapped run's `calls/<callId>.jsonl` files are merged per call
   (`start` + `stream_end` + `exit`). `expected.records` is the number of calls;
   `expected.record` is a subset of the first call's merged record (`tool`, `args`, `exitCode`,
   `stdoutBytes`, `capturedBytes`, `consumerClosed`, `truncated`); `expected.exitRecord` says
   whether that call has an `exit` record (a call without one is shown as `killed`).
4. **Capture limits.** stdout is captured up to `CAPTURE_LIMIT_BYTES` = 102400 bytes;
   `truncated` is true when the tool wrote more. When the consumer closes early (`| head -1`),
   the tee stops forwarding but keeps reading until 102400 bytes (`consumerClosed: true`), then
   exits, so the tool gets SIGPIPE as it would have without the wrapper.
5. **Fail-open.** When the wrapper cannot or must not log — the log dir is unusable, `node` is
   not on `PATH`, `LOGHUB_SHIM_ACTIVE` is set (nesting), the config cache is corrupt — it writes
   no records and runs the real tool unchanged. A failure that happened inside the shim trips the
   tool's breaker (`breaker/<tool>`).
6. **Missing tool.** A monitored tool that is not on `PATH` gets no shim (`generated` lacks it),
   so the shell's own `command not found` / 127 is untouched.
7. **Availability.** A row runs only where its `os` (`any`, `windows`, `linux`, `posix`) matches
   and its `shell` (`bash`; `powershell` = Windows PowerShell 5.1; `pwsh` = PowerShell 7) is
   installed; otherwise it is skipped, never failed. Each run has a 10 s timeout.
8. **Signal deaths.** When the tool dies of SIGHUP, SIGINT, SIGQUIT, SIGPIPE or SIGTERM (exit code
   129, 130, 131, 141 or 143), the shim writes the `exit` record with that code and then kills
   itself with the same signal, so its parent sees a signal death as without the wrapper. (Without
   this, bash would carry on and exit normally, because the tee ignores SIGINT. A tool that *exits*
   with one of those codes cannot be told apart and is treated the same.)
9. **Overhead.** A row with `measure: N` also runs both variants N more times and reports the
   median wall time of each (FR-8.8); it never fails on time.

### Fixture tools (`bin/`)

- `zz [lines N | args A…]`: `lines N` (default, N = 20000) prints `line <i> of zz output` for
  i = 1…N; `args` prints each argument as `[<arg>]` on its own line. Then it writes
  `zz: <mode> done` to stderr and exits with `$ZZ_EXIT` (default 0). One line is
  `19 + digits(i)` bytes, so 20000 lines are 9×20 + 90×21 + 900×22 + 9000×23 + 10001×24 =
  468894 bytes and 4000 lines are 9×20 + 90×21 + 900×22 + 3001×23 = 90893 bytes.
- `zzbin`: writes the 256 bytes 0x00…0xFF once.
- `zzin`: copies each stdin line to stdout and, prefixed `err:`, to stderr.
- `zzsleep [S]`: sleeps S seconds (default 30).
- `zzc.cmd` (Windows): prints `zzc line 1`, `zzc line 2`, the arguments, writes
  `zzc: stderr line` to stderr and exits 3.

## Edge cases

- Binary output: FW-01. Huge output and a non-zero exit code: FW-02. Stdin pipe: FW-03.
- Arguments with spaces, quotes, Unicode and an empty argument: FW-04.
- Missing tool: FW-05. SIGINT: FW-06. A failing system tool (`find`), with the overhead
  measurement: FW-07.
- PowerShell `.cmd` tool, 5.1 and 7: FW-08, FW-09.
- `| head -1`: FW-10. Under the capture limit: FW-11.
- Fail-open: unusable log dir FO-01, no `node` FO-02, corrupt config cache FO-03, nesting FO-04.

## Examples

`input`: `os`, `shell`, `tools` (monitored names), `command` (run as `bash -c <command>` or
`powershell -NoProfile -NonInteractive -Command <command>`), optional `env` (extra variables for
both runs), optional `setup` (`calls-is-file`: a file named `calls` in the session dir, so the
shim cannot create its log dir; `no-node`: every `PATH` dir holding `node` is removed for both
runs; `corrupt-cache`: the row runs `setupSessionToolWrap` against a project whose
`config-cache.json` is not JSON and no server is configured; `shim-active`:
`LOGHUB_SHIM_ACTIVE=1` in the wrapped run's environment), optional `measure`.
`expected`: `exitCode` and, when given, `stdout` (text) are checked on both runs (they are also
equal by rule 2); `records`, `record`, `exitRecord`, `outMatchesStdout` (the `.out` capture equals
stdout), `stdin` (the `.in` capture), `generated`, `breaker` and `setup` check the wrapper's side.

```examples
[
  {
    "id": "FW-01",
    "input": {"os": "any", "shell": "bash", "tools": ["zzbin"], "command": "zzbin"},
    "expected": {"exitCode": 0, "records": 1, "record": {"tool": "zzbin", "exitCode": 0, "stdoutBytes": 256, "capturedBytes": 256, "truncated": false}, "outMatchesStdout": true},
    "note": "Rules 2-4: 256 bytes < 102400, so all are captured unchanged and forwarded byte for byte; zzbin exits 0."
  },
  {
    "id": "FW-02",
    "input": {"os": "any", "shell": "bash", "tools": ["zz"], "command": "zz", "env": {"ZZ_EXIT": "3"}},
    "expected": {"exitCode": 3, "records": 1, "record": {"exitCode": 3, "stdoutBytes": 468894, "capturedBytes": 102400, "truncated": true, "consumerClosed": false}, "exitRecord": true},
    "note": "Fixture: 20000 lines = 468894 bytes. Rule 4: 468894 > 102400 -> captured 102400, truncated; nobody closed the pipe. The shim exits with the tool's own code 3 (ZZ_EXIT)."
  },
  {
    "id": "FW-03",
    "input": {"os": "any", "shell": "bash", "tools": ["zzin"], "command": "printf 'one\\ntwo\\n' | zzin"},
    "expected": {"exitCode": 0, "stdout": "one\ntwo\n", "records": 1, "stdin": "one\ntwo\n"},
    "note": "zzin copies each stdin line to stdout. stdin is a pipe, so the shim copies it to .in on the way (DD-13): the same two lines."
  },
  {
    "id": "FW-04",
    "input": {"os": "any", "shell": "bash", "tools": ["zz"], "command": "zz args \"a b\" \"it's\" 'say \"hi\"' \"żółw ✓\" \"\""},
    "expected": {"exitCode": 0, "stdout": "[a b]\n[it's]\n[say \"hi\"]\n[żółw ✓]\n[]\n", "records": 1, "record": {"args": ["args", "a b", "it's", "say \"hi\"", "żółw ✓", ""]}},
    "note": "The shim passes \"$@\" unchanged: 5 arguments after 'args', each printed in brackets, the empty one as []. The start record lists all 6 argv words as typed (rule 3)."
  },
  {
    "id": "FW-05",
    "input": {"os": "any", "shell": "bash", "tools": ["zzmissing"], "command": "zzmissing --version"},
    "expected": {"exitCode": 127, "generated": [], "records": 0},
    "note": "Rule 6: zzmissing is not on PATH -> no shim; bash itself answers command not found, 127, in both runs."
  },
  {
    "id": "FW-06",
    "input": {"os": "linux", "shell": "bash", "tools": ["zzsleep"], "command": "set -m; zzsleep 5 & p=$!; sleep 1; kill -INT -$p; wait $p; echo \"status=$?\""},
    "expected": {"exitCode": 0, "stdout": "status=130\n", "records": 1, "record": {"exitCode": 130}, "exitRecord": true},
    "note": "Job control puts zzsleep in its own process group; SIGINT to the group kills sleep (128 + 2 = 130). Rule 8: the shim records exit 130, then dies of SIGINT itself, so wait reports 130 and job control prints 'Interrupt' on stderr in both runs."
  },
  {
    "id": "FW-07",
    "input": {"os": "any", "shell": "bash", "tools": ["find"], "command": "find /nonexistent", "measure": 5},
    "expected": {"exitCode": 1, "records": 1, "record": {"tool": "find", "args": ["/nonexistent"], "exitCode": 1, "stdoutBytes": 0}},
    "note": "find reports the missing path on stderr and exits 1 (GNU and busybox alike); no stdout. Rule 9: also timed 5 more times per variant."
  },
  {
    "id": "FW-08",
    "input": {"os": "windows", "shell": "powershell", "tools": ["zzc"], "command": "zzc one two; \"exit=$LASTEXITCODE\""},
    "expected": {"exitCode": 0, "records": 1, "record": {"tool": "zzc", "args": ["one", "two"], "exitCode": 3}},
    "note": "Rule 1: the prefix defines a zzc function that runs zzc.cmd; it restores $LASTEXITCODE = 3, so the next statement prints exit=3 in both runs, and the last statement succeeds -> PowerShell exits 0. The exit record holds the tool's 3."
  },
  {
    "id": "FW-09",
    "input": {"os": "windows", "shell": "pwsh", "tools": ["zzc"], "command": "zzc one two; \"exit=$LASTEXITCODE\""},
    "expected": {"exitCode": 0, "records": 1, "record": {"tool": "zzc", "exitCode": 3}},
    "note": "Same as FW-08 under PowerShell 7; skipped where pwsh is not installed (rule 7)."
  },
  {
    "id": "FW-10",
    "input": {"os": "any", "shell": "bash", "tools": ["zz"], "command": "zz | head -1"},
    "expected": {"exitCode": 0, "stdout": "line 1 of zz output\n", "records": 1, "record": {"consumerClosed": true, "capturedBytes": 102400, "truncated": true}},
    "note": "head prints the first line and exits 0 (the pipeline's status). Rule 4: the tee keeps reading after EPIPE until 102400 bytes, all of them captured, then exits; zz (468894 bytes) gets SIGPIPE as unwrapped."
  },
  {
    "id": "FW-11",
    "input": {"os": "any", "shell": "bash", "tools": ["zz"], "command": "zz lines 4000"},
    "expected": {"exitCode": 0, "records": 1, "record": {"stdoutBytes": 90893, "capturedBytes": 90893, "truncated": false}, "outMatchesStdout": true},
    "note": "Fixture: 4000 lines = 90893 bytes < 102400 -> captured whole, not truncated (rule 4)."
  },
  {
    "id": "FO-01",
    "input": {"os": "any", "shell": "bash", "tools": ["zz"], "command": "zz args x", "setup": "calls-is-file"},
    "expected": {"exitCode": 0, "stdout": "[x]\n", "records": 0, "breaker": ["zz"]},
    "note": "Rule 5: mkdir of the calls dir fails (a file is in the way) -> the shim counts a fault (breaker/zz) and execs zz unchanged; no records."
  },
  {
    "id": "FO-02",
    "input": {"os": "any", "shell": "bash", "tools": ["zz"], "command": "zz args x", "setup": "no-node"},
    "expected": {"exitCode": 0, "stdout": "[x]\n", "records": 0},
    "note": "Rule 5: type -P node finds nothing -> the shim passes through before writing any record."
  },
  {
    "id": "FO-03",
    "input": {"os": "any", "shell": "bash", "tools": ["zz"], "command": "zz args x", "setup": "corrupt-cache"},
    "expected": {"exitCode": 0, "stdout": "[x]\n", "records": 0, "setup": {"status": "skipped", "reason": "no config"}},
    "note": "Rule 5: no server is configured and the cache does not parse -> SessionStart has no config, generates no shim and writes no PATH export; the command runs untouched."
  },
  {
    "id": "FO-04",
    "input": {"os": "any", "shell": "bash", "tools": ["zz"], "command": "zz args x", "setup": "shim-active"},
    "expected": {"exitCode": 0, "stdout": "[x]\n", "records": 0},
    "note": "Rule 5: LOGHUB_SHIM_ACTIVE is set (a wrapped tool calling a wrapped tool) -> pass through, no records."
  }
]
```

## Mutations

- The tee decodes / re-encodes stdout as text -> FW-01 (bytes 0x80-0xFF change).
- The shim exits with the tee's code instead of `PIPESTATUS[0]` -> FW-02 (0 instead of 3).
- stdin not passed to the tool when it is copied to `.in` -> FW-03.
- Arguments re-joined into one string (`$*`) -> FW-04.
- A shim generated for a missing tool answering with its own message -> FW-05 (stderr differs).
- The tee exits at once on EPIPE (no drain) -> FW-10 (`capturedBytes` < 102400); the tee keeps
  forwarding after EPIPE -> FW-10 hangs or zz never gets SIGPIPE.
- `truncated` set at the limit instead of above it -> FW-11.
- The shim exiting with 130 instead of re-raising SIGINT -> FW-06 (job control prints `Exit 130`
  instead of `Interrupt` on stderr).
- A failed `mkdir` aborting the call instead of passing through -> FO-01.
- `LOGHUB_SHIM_ACTIVE` ignored -> FO-04 (a record is written).

## Where the result is visible

- Safe behaviour: the agent's Bash and PowerShell calls of a monitored tool behave as if no
  wrapper existed; the Tools/MCP tab shows the captured call (`cut`, `truncated`, `killed`).
- Verification: `npm run check` / `npm run check:linux` in `loghub-tool-wrap-check` print a
  pass / fail / skipped line per row and the `find` overhead; results are recorded in the task's
  `notes.md`.
