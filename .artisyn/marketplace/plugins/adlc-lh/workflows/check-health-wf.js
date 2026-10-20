// Named `-wf` so it never shadows the `adlc-lh:check-health` SKILL — see review-deep-wf.js for why.
export const meta = {
  name: 'check-health-wf',
  description: 'Engine behind the adlc-lh:check-health skill — invoke that skill instead. Runs a list of repo health checks (build/lint/tests/etc.) and auto-fixes any failures',
  phases: [
    { title: 'Checks' },
  ],
}

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'fail'] },
    fixesApplied: {
      type: 'array',
      items: { type: 'string' },
      description: 'One line per real fix made (file + what was wrong), not per run of the check.',
    },
    blockers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Unresolved blockers written to docs/BLOCKED.md for this check, if any. Empty array if status is "pass".',
    },
    durationSeconds: {
      type: 'number',
      description: 'The secs= value printed by the __CHECK_DONE marker on the final/deciding run of the command.',
    },
    commandRuns: {
      type: 'number',
      description: 'How many times you launched the command (1 if it passed first try). Must never exceed 3.',
    },
    errorSummary: {
      type: 'string',
      description: 'On failure: a short (<=2 line) human-readable summary of the key error(s) — e.g. "server-unit: 2 failing tests in auth.spec.ts (expected 200, got 401)". On a timeout, must start with "TIMEOUT after Ns". Empty string when status is "pass".',
    },
    timedOut: {
      type: 'boolean',
      description: 'True only if the foreground Bash call hit its timeout and was killed. False for a normal pass and for a normal (non-timeout) failure.',
    },
  },
  required: ['status', 'fixesApplied', 'blockers', 'durationSeconds', 'commandRuns', 'errorSummary', 'timedOut'],
}

// One foreground call per run. This is deliberate and load-bearing:
//   - TaskOutput is NOT available to workflow subagents (ToolSearch("select:TaskOutput") returns
//     "No matching deferred tools found"), so any prompt telling an agent to background the command
//     and wait on a bounded TaskOutput is unimplementable.
//   - The fallback agents reach for is background + manual `sleep` polling, but standalone sleeps
//     are blocked by the harness, so it degenerates into dozens of short sleeps at ~8s round-trip
//     each. Measured cost: a 102s `server-unit` command took 441s of agent wall time that way.
// A single foreground Bash call with an explicit timeout gets the output AND the exit code in one
// tool call, with no polling and no orphaned processes to clean up.
function buildPrompt(check, environmentNotes) {
  const timeoutSeconds = check.timeoutSeconds ?? 600
  return `You are running exactly one health check for this repo.

### Check
- Name: ${check.name}
- Directory (relative to repo root): ${check.dir}
- Command: \`${check.command}\`
- Description: ${check.module}
- Instructions: ${check.instructions ?? '(none)'}

### How to run it

${environmentNotes ? `- ${environmentNotes}\n` : ''}- Run it in the FOREGROUND, in ONE Bash call, using this exact wrapper so the exit code and the
  runtime come back together:

  \`\`\`
  cd "<repo-root>/${check.dir}" && s=$(date +%s); ${check.command}; rc=$?; e=$(date +%s); echo "__CHECK_DONE rc=$rc secs=$((e-s))"
  \`\`\`

  Pass \`timeout: ${timeoutSeconds * 1000}\` (milliseconds) on that Bash call.
- Do NOT background this command, and do NOT poll for it. \`TaskOutput\` does not exist for you —
  do not go looking for it. Backgrounding here has been measured to cost several extra minutes per
  check and buys nothing: the foreground call already returns the complete output.
- Judge pass/fail by the \`rc=\` value in the \`__CHECK_DONE\` marker, not by your impression of the
  log text. Many of these tools print alarming-looking lines (error-log fixtures, deprecation
  warnings, open-handle notices) on a completely successful run. Report \`durationSeconds\` from the
  \`secs=\` value of the deciding run.
- If the Bash call itself times out (no \`__CHECK_DONE\` marker came back and the tool reports a
  timeout), the command was killed at ${timeoutSeconds}s. That is a TIMEOUT, not an ordinary
  failure:
  1. Look at the output captured before the kill. If the tool had already printed its own final
     summary (e.g. Jest's "Tests:" line), the work finished and it is the process EXIT that hung —
     an open handle (unclosed DB pool, uncleared timer), which is an infra bug, not a code or test
     regression.
  2. On Windows, killing the wrapper does not reliably kill children. Check for a survivor
     (\`Get-CimInstance Win32_Process | Where-Object CommandLine -match '<something specific>'\`) and
     kill it by PID so nothing is left running for the next check.
  3. Set \`status\` "fail" and \`timedOut\` true, and append a \`docs/BLOCKED.md\` entry describing which
     of the two cases above applied. Do NOT burn fix-attempts rewriting code over a timeout you
     cannot confirm is a real regression.

### Re-run discipline (this is where runs get slow)

- Launch the command ONCE. Do not re-run it "to be sure", to re-measure the duration, or because
  the output looked noisy.
- Re-run ONLY immediately after you have actually edited a file to fix a failure.
- Hard cap: **3 launches total** (initial + 2 fix attempts). Report the real number in
  \`commandRuns\`.

### If the check fails

Diagnose the ROOT CAUSE and fix it directly in the source (application code, test code, or test
fixtures/helpers — wherever the actual bug is). Do NOT make a failure disappear by deleting,
skipping, or weakening an assertion, and do not mask a real bug as "flaky" without evidence.

If it is still failing after the 3rd launch, stop, append a clear entry to \`docs/BLOCKED.md\`
describing the check, the symptom, and what you tried, then report.

### Report

\`status\` is "pass" only if the deciding run ended \`rc=0\`. List every real fix in \`fixesApplied\`
(one line: file + what was wrong) — passing is not a "fix". List every \`docs/BLOCKED.md\` entry you
wrote in \`blockers\`. On failure set \`errorSummary\` to a short summary of the key error(s); leave
it "" when status is "pass".`
}

const CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          dir: { type: 'string' },
          module: { type: 'string' },
          command: { type: 'string' },
          instructions: { type: 'string' },
          group: { type: 'string' },
          finalOnly: { type: 'boolean' },
          timeoutSeconds: { type: 'number' },
        },
        required: ['name', 'dir', 'command'],
      },
    },
    environmentNotes: { type: 'string' },
  },
  required: ['checks'],
}

phase('Checks')

// Defensive parse: in some environments the Workflow tool's `args` arrives as a raw JSON string
// rather than an already-parsed object/array, even when the caller passed a real structured
// value. Without this, `input.checks`/`input.finalRun` silently read as undefined off a string
// primitive (no thrown error — a string just has no such properties), so finalOnly checks (a full
// e2e suite, say) would keep getting skipped even on a "final" run.
let rawArgs = args
if (typeof rawArgs === 'string') {
  try {
    rawArgs = JSON.parse(rawArgs)
  } catch {
    log('args arrived as a non-JSON string — could not parse it, falling back to self-bootstrap')
    rawArgs = undefined
  }
}

let input = Array.isArray(rawArgs) ? { checks: rawArgs } : (rawArgs ?? {})

// Self-bootstrap: the caller (adlc-lh:check-health skill) is supposed to pass the checks array, but
// forgetting it should not hard-fail the whole run. Workflow scripts can't touch the filesystem,
// but an agent can — so when no checks arrive, load them straight from the repo config.
if (!Array.isArray(input.checks) || input.checks.length === 0) {
  log('No checks in args — loading from .claude/repo_config/repo-health-checks.json')
  const loaded = await agent(
    'Read the file `.claude/repo_config/repo-health-checks.json` (path relative to the repo root) ' +
      'and return its parsed contents verbatim: the `checks` array and the `environmentNotes` ' +
      'string, exactly as written. Do not modify, reorder, or invent anything.',
    { label: 'load-config', phase: 'Checks', schema: CONFIG_SCHEMA, model: 'haiku', effort: 'low' },
  )
  if (loaded && Array.isArray(loaded.checks) && loaded.checks.length > 0) {
    input = { ...loaded, finalRun: input.finalRun }
  }
}

const allChecks = input.checks
const environmentNotes = input.environmentNotes ?? ''
const finalRun = input.finalRun === true
if (!Array.isArray(allChecks) || allChecks.length === 0) {
  throw new Error('adlc-lh:check-health-wf could not obtain a checks array: none passed in args and .claude/repo_config/repo-health-checks.json could not be loaded. Expected args: { checks: [{ name, dir, module, command, instructions, group?, finalOnly?, timeoutSeconds? }], environmentNotes?, finalRun? } (or a bare checks array).')
}

// Checks flagged `finalOnly` (e.g. the slow full e2e suite) run only on the final verification
// pass. On an iterative pass (finalRun !== true) they are filtered out here — callers always pass
// the FULL checks array and let this flag decide, rather than pre-filtering themselves.
const checks = finalRun ? allChecks : allChecks.filter(c => !c.finalOnly)
const skippedFinalOnly = allChecks.length - checks.length
if (skippedFinalOnly > 0) {
  log(`Iterative run: skipping ${skippedFinalOnly} finalOnly check(s). Pass finalRun: true to include them.`)
}

// `group` is the concurrency unit: checks in DIFFERENT groups run at the same time, checks in the
// SAME group run one after another. A group is therefore a shared-resource claim — put every check
// that touches the same mutable resource (this repo: the real DB and the running watch-mode dev
// app, group "app") in one group, and let the checks that only read sources (group "static") run
// alongside them.
//
// A check with no `group` falls into "_default". That default is deliberately shared rather than
// per-check: an older config written before this field existed assumed strictly serial execution,
// and lumping those checks into one group preserves exactly that behaviour.
const groups = []
const byName = new Map()
for (const check of checks) {
  const key = check.group ?? '_default'
  let group = byName.get(key)
  if (!group) {
    group = { name: key, checks: [] }
    byName.set(key, group)
    groups.push(group)
  }
  group.checks.push(check)
}

const fmtDur = (s) => (typeof s === 'number' && s >= 0 ? `${s < 10 ? s.toFixed(1) : Math.round(s)}s` : '?s')

log(`Starting ${checks.length} check(s) in ${groups.length} parallel group(s): ${groups.map(g => `${g.name}[${g.checks.map(c => c.name).join(' → ')}]`).join('  ')}`)

const groupResults = await parallel(groups.map(group => async () => {
  const out = []
  for (let i = 0; i < group.checks.length; i++) {
    const check = group.checks[i]
    const pos = `[${group.name} ${i + 1}/${group.checks.length}]`
    log(`${pos} ▶ ${check.name}: \`${check.command}\` (in ${check.dir})`)

    const result = await agent(buildPrompt(check, environmentNotes), {
      phase: 'Checks',
      label: check.name,
      schema: CHECK_SCHEMA,
    })

    if (!result) {
      log(`${pos} ❌ ${check.name}: produced no result — treating as failed`)
      out.push({
        name: check.name,
        group: group.name,
        status: 'fail',
        fixesApplied: [],
        blockers: [`Agent for check "${check.name}" produced no result.`],
        durationSeconds: -1,
        commandRuns: 0,
        errorSummary: 'Agent produced no result.',
        timedOut: false,
      })
    } else {
      const dur = fmtDur(result.durationSeconds)
      const fixNote = result.fixesApplied.length ? `, ${result.fixesApplied.length} fix(es)` : ''
      if (result.status === 'pass') {
        log(`${pos} ✅ ${check.name}: passed in ${dur}${fixNote}`)
      } else {
        const why = result.errorSummary ? ` — ${result.errorSummary}` : ''
        const blk = result.blockers.length ? `, ${result.blockers.length} blocker(s)` : ''
        const tag = result.timedOut ? `⏱️ ${check.name}: TIMED OUT after` : `❌ ${check.name}: FAILED in`
        log(`${pos} ${tag} ${dur}${fixNote}${blk}${why}`)
      }
      out.push({ name: check.name, group: group.name, ...result })
    }

    // Later checks in the same group are ordered behind this one for a reason (shared DB, or a
    // build whose output they consume). Running them on top of an unresolved failure produces
    // cascading noise rather than new signal, so stop the group here. Other groups are unaffected
    // — they are running concurrently and run to completion. Nothing is dropped silently: the
    // skipped checks are reported explicitly below and in the returned result.
    if (out[out.length - 1].status !== 'pass') {
      const rest = group.checks.slice(i + 1)
      if (rest.length > 0) {
        log(`[${group.name}] ⏭️ skipping ${rest.length} later check(s) in this group after ${check.name} failed: ${rest.map(c => c.name).join(', ')}`)
        for (const r of rest) {
          out.push({
            name: r.name,
            group: group.name,
            status: 'skipped',
            fixesApplied: [],
            blockers: [],
            durationSeconds: -1,
            commandRuns: 0,
            errorSummary: `Not run — earlier check "${check.name}" in group "${group.name}" failed.`,
            timedOut: false,
          })
        }
      }
      break
    }
  }
  return out
}))

// parallel() resolves a thrown thunk to null rather than rejecting, so drop those before flattening.
const results = groupResults.filter(Boolean).flat()

const overallStatus = results.every(r => r.status === 'pass') ? 'ok' : 'blocked'
const fixesApplied = results.flatMap(r => r.fixesApplied.map(f => `[${r.name}] ${f}`))
const blockers = results.flatMap(r => r.blockers.map(b => `[${r.name}] ${b}`))
const skipped = results.filter(r => r.status === 'skipped').map(r => r.name)

const icon = (r) => (r.status === 'pass' ? '✅' : r.status === 'skipped' ? '⏭️' : r.timedOut ? '⏱️' : '❌')
log(results.map(r => `${icon(r)} ${r.name} ${fmtDur(r.durationSeconds)}`).join('  '))
if (skipped.length > 0) log(`Not run this pass: ${skipped.join(', ')}`)
log(`Done: status=${overallStatus}, ${fixesApplied.length} fix(es) applied, ${blockers.length} blocker(s)`)

return {
  status: overallStatus,
  checks: results,
  fixesApplied,
  blockers,
  skipped,
}
