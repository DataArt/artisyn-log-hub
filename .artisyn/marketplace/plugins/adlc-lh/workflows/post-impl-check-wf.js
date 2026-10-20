// Named `-wf` so it never shadows the `adlc-lh:post-impl-check` SKILL — see review-deep-wf.js for why.
export const meta = {
  name: 'post-impl-check-wf',
  description: 'Engine behind the adlc-lh:post-impl-check skill — invoke /adlc-lh:post-impl-check instead. Runs post-implementation checks one by one, fully automatic, halting only on a hard blocker',
  phases: [
    { title: 'Checks' },
  ],
}

const CHECK_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['ok', 'hard-blocker'],
      description:
        '"ok" if the check ran to completion, regardless of how many findings it reported. "hard-blocker" ' +
        'ONLY if the check itself could not be performed (e.g. required files/plan missing) or it found a ' +
        'problem so fundamental that running further checks would be meaningless (e.g. the app does not build). ' +
        'An ordinary list of issues (security, performance, missing indexes, slow tests, etc.) is NOT a hard ' +
        'blocker — report those via "findings" with status "ok".',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          description: { type: 'string' },
          file: { type: 'string' },
        },
        required: ['severity', 'description'],
      },
      description: 'Issues found by this check. Empty array if none.',
    },
    hardBlockerReason: {
      type: 'string',
      description: 'If status is "hard-blocker": why the check could not complete, or why it must stop remaining checks. Empty string if status is "ok".',
    },
    summary: {
      type: 'string',
      description: 'One or two sentence summary of what was checked and what was found.',
    },
  },
  required: ['status', 'findings', 'hardBlockerReason', 'summary'],
}

// Optional live progress: when the skill created a session task for this check, the check agent
// owns it and moves its status. Best-effort by design — the instruction is defensive so a missing
// Task* tool surface or a failed call can never stall the real check.
function progressTaskLines(taskId) {
  if (!taskId) return ''
  return `

### Progress task

Session task \`${taskId}\` shows this check as a checkbox in the user's task list, and you own it.
Before anything else, load the tool schema with \`ToolSearch("select:TaskUpdate")\`, then call
\`TaskUpdate({ taskId: '${taskId}', status: 'in_progress' })\`. Set it \`completed\` only when the
check genuinely ran to completion; if it could not, leave it \`in_progress\`. If ToolSearch does not
find TaskUpdate or any call fails, silently skip all further task updates — a tracking failure is
never a hard blocker and must not affect your reported result.`
}

function buildCheckPrompt(check, taskLabel, index, total) {
  return `You are running post-implementation check **${index + 1}/${total}: ${check.name}** for task ${taskLabel}.

Invoke the \`${check.skill}\` skill (via the Skill tool) with argument \`${taskLabel}\`, and follow its
instructions exactly, then report your result.

### Run to completion before reporting

Run the check to completion BEFORE reporting. If a command is long-running, launch it in the
background and wait for its completion notification — never end your turn while it is still
running, and never report a result you have not actually observed. Call StructuredOutput exactly
once, with real results only — placeholder, interim, or "will be replaced later" values are
forbidden (there is no later: StructuredOutput ends your run). If you cannot complete the check,
report status "hard-blocker" with the reason instead of guessing.

### Report your result

- \`status\`: "ok" unless you could not perform the check at all, or found a problem so fundamental (e.g. the
  app does not build) that running further checks would be meaningless — that is the ONLY case for
  "hard-blocker". Ordinary findings are NOT a hard blocker; report them via \`findings\` with status "ok".
- \`findings\`: every issue found, with severity, a description, and the file it applies to (if any).
- \`hardBlockerReason\`: why, when status is "hard-blocker". Empty string when status is "ok".
- \`summary\`: what you checked and what you found, in one or two sentences.${progressTaskLines(check.taskId)}`
}

// This workflow needs a structured `checks` array, so a bare slash-command argument
// (`/adlc-lh:post-impl-check-wf SHAD-241` → the raw string `"SHAD-241"`) can only ever be a caller
// error — but it must halt with a reason, not throw a stack trace out of JSON.parse.
let input
try {
  const parsed = typeof args === 'string' ? JSON.parse(args) : (args ?? {})
  input = Array.isArray(parsed) ? { checks: parsed } : parsed
} catch (e) {
  return {
    checks: [],
    halted: { index: -1, reason: 'invalid-args-json', argsType: typeof args, message: String(e.message) },
  }
}

if (!Array.isArray(input.checks) || input.checks.length === 0) {
  return { checks: [], halted: { index: -1, reason: 'no-checks', argsType: typeof args } }
}

phase('Checks')
const results = []
let halted = null
for (let i = 0; i < input.checks.length; i++) {
  const check = input.checks[i]
  log(`Starting check ${i + 1}/${input.checks.length}: ${check.name}`)
  const result = await agent(buildCheckPrompt(check, input.taskLabel, i, input.checks.length), {
    phase: 'Checks',
    label: `check-${i + 1}-${check.id ?? 'unknown'}`,
    schema: CHECK_RESULT_SCHEMA,
  })
  // Guard against fake-success results: an agent that ends prematurely (e.g. waiting on a
  // background command) may emit a placeholder StructuredOutput instead of a real report.
  const suspect = result && (
    /placeholder|will be replaced|to be filled|TBD/i.test(result.summary ?? '') ||
    (result.summary ?? '').trim().length < 10
  )
  if (suspect) {
    log(`Check ${i + 1}/${input.checks.length} (${check.name}) returned a placeholder/empty summary — treating as no-result`)
  }
  results.push({ check: check.name, id: check.id, result: suspect ? null : result })

  if (!result || suspect) {
    log(`Check ${i + 1}/${input.checks.length} (${check.name}) produced no result — halting, remaining checks skipped`)
    halted = { index: i, reason: 'no-result' }
    break
  }
  if (result.status === 'hard-blocker') {
    log(`Check ${i + 1}/${input.checks.length} (${check.name}) hit a hard blocker — halting, remaining checks skipped`)
    halted = { index: i, reason: 'hard-blocker' }
    break
  }
  log(`Check ${i + 1}/${input.checks.length} (${check.name}) complete: ${result.findings.length} finding(s)`)
}

const totalFindings = results.reduce((sum, r) => sum + (r.result?.findings?.length ?? 0), 0)
log(`Checks done: ${results.length}/${input.checks.length} ran, ${totalFindings} finding(s) total${halted ? `, halted (${halted.reason})` : ''}`)
return { checks: results, halted }
