// Named `-wf` so it never shadows the `adlc-lh:implement-deep` SKILL — see review-deep-wf.js for why.
export const meta = {
  name: 'implement-deep-wf',
  description: 'Engine behind the adlc-lh:implement-deep skill — invoke /adlc-lh:implement-deep instead. Implements an approved chunk list for a task plan, chunk-by-chunk, then verifies',
  phases: [
    { title: 'Implement' },
    { title: 'Verify' },
  ],
}

const CHUNK_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['ok', 'blocked'],
      description: '"ok" only if build/lint/relevant tests all passed and every item in this chunk is fully implemented. "blocked" if anything could not be completed.',
    },
    filesChanged: {
      type: 'array',
      items: { type: 'string' },
      description: 'Paths of files created or modified for this chunk.',
    },
    blockers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Unresolved blockers preventing completion. Empty array if status is "ok".',
    },
    summary: {
      type: 'string',
      description: 'One or two sentence summary of what was implemented.',
    },
  },
  required: ['status', 'filesChanged', 'blockers', 'summary'],
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
          finalOnly: { type: 'boolean' },
        },
        required: ['name', 'dir', 'command'],
      },
    },
    environmentNotes: { type: 'string' },
  },
  required: ['checks'],
}

const HEALTH_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'blocked'] },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          status: { type: 'string', enum: ['pass', 'fail'] },
        },
        required: ['name', 'status'],
      },
      description: 'One entry per check the skill ran, in order, including any final-only/full-suite checks.',
    },
    fixesApplied: { type: 'array', items: { type: 'string' } },
    blockers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Entries written to docs/BLOCKED.md for this run, if any.',
    },
  },
  required: ['status', 'checks', 'fixesApplied', 'blockers'],
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ok', 'not_ok'] },
    reasoning: { type: 'string', description: 'One or two sentences justifying the verdict.' },
    concerns: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific discrepancies found (e.g. a check missing from the self-report, an unresolved docs/BLOCKED.md entry). Empty if none.',
    },
  },
  required: ['verdict', 'reasoning', 'concerns'],
}

function buildHealthCheckRunnerPrompt(taskLabel, verifyTaskId) {
  return `Run the full project health-check suite for task ${taskLabel} before it is reported as done.

Invoke the \`adlc-lh:check-health\` skill via the Skill tool, passing argument \`finalRun: true\`

When it finishes, report:
- \`status\`: "ok" only if every check ended green and no new unresolved entry was written to
  \`docs/BLOCKED.md\`; otherwise "blocked".
- \`checks\`: name + status for every check the skill ran, in order.
- \`fixesApplied\`: any real fixes made along the way.
- \`blockers\`: any entries written to \`docs/BLOCKED.md\` for this run.${progressTaskLines(verifyTaskId)}`
}

function buildHealthCheckJudgePrompt(taskLabel, runnerResult) {
  return `You are independently judging whether the health-check run for task ${taskLabel} genuinely
passed, before this task is reported as done. Do not take the runner's self-report at face value —
verify it against independent evidence:

1. Read \`.claude/repo_config/repo-health-checks.json\` and verify every configured check — including
   \`finalOnly\` ones, since this was a final run — appears in the runner's \`checks\` list with
   status "pass". A configured check missing from the self-report is a concern, not a pass.
2. Read \`docs/BLOCKED.md\` if it exists and check for unresolved entries relevant to this run.

### Runner's self-reported result

${JSON.stringify(runnerResult, null, 2)}

Report a \`verdict\`: "ok" only if every configured check appears in the report and truly passed and
there is no unresolved blocker. Otherwise "not_ok". Give a short \`reasoning\` and list any
\`concerns\` found (empty array if none).`
}

// Optional live progress: when the skill created a session task for this agent's work, the agent
// owns it and moves its status. Best-effort by design — the instruction is defensive so a missing
// Task* tool surface or a failed call can never stall the real work.
function progressTaskLines(taskId) {
  if (!taskId) return ''
  return `

### Progress task

Session task \`${taskId}\` shows this work as a checkbox in the user's task list, and you own it.
Before anything else, load the tool schema with \`ToolSearch("select:TaskUpdate")\`, then call
\`TaskUpdate({ taskId: '${taskId}', status: 'in_progress' })\`. Set it \`completed\` only when you
genuinely finished; if you end up blocked, leave it \`in_progress\`. If ToolSearch does not find
TaskUpdate or any call fails, silently skip all further task updates — a tracking failure is never
a blocker: do not put it in \`blockers\` and do not let it affect your result.`
}

function itemLines(items) {
  return items.map(i => `- [ ] ${i}`).join('\n')
}

function checkLines(checks) {
  if (!checks || checks.length === 0) {
    return '- Use the canonical commands from CLAUDE.md → "Test & build commands (canonical)".'
  }
  return checks
    .map(c => `- ${c.module}: \`${c.command}\` (from \`${c.dir}\`)${c.instructions ? ` — ${c.instructions}` : ''}`)
    .join('\n')
}

function conventionLines(conventions) {
  const lines = []
  if (conventions.environmentNotes) lines.push(`- ${conventions.environmentNotes}`)
  lines.push(checkLines(conventions.checks))
  return lines.join('\n')
}

// Other chunks are summarized as name + item count only — the agent doesn't need their item text,
// just the boundaries of its own work. Keeps chunk prompts small on large plans. Done chunks also
// carry their filesChanged so a later chunk can find helpers earlier chunks created without a search.
function doneLines(chunks, results) {
  if (chunks.length === 0) return '(none)'
  return chunks.map((c, j) => {
    const files = results[j]?.result?.filesChanged ?? []
    const fileNote = files.length > 0 ? ` — files: ${files.join(', ')}` : ''
    return `- [x] ${c.name} (${c.items.length} items)${fileNote}`
  }).join('\n')
}

function remainingLines(chunks) {
  if (chunks.length === 0) return '(none)'
  return chunks.map(c => `- ${c.name} (${c.items.length} items)`).join('\n')
}

// Invariant blocks (conventions, command rules, reading rules) come FIRST and the chunk-specific
// content LAST, so sequential chunk agents share the longest possible cached prompt prefix.
function buildChunkPrompt(planFile, chunk, doneText, remainingText, index, total, conventions) {
  return `You are implementing one chunk of an approved implementation plan.

Plan file: \`${planFile}\`

### Project conventions

These are the ONLY approved build/lint/test commands — do not invent variants:

${conventionLines(conventions)}

### Running long commands (full test suites, full builds)

- Run these commands in the FOREGROUND, one Bash call each, passing an explicit \`timeout\` in milliseconds
  (the Bash tool accepts up to 600000). One call returns the complete output and the exit code.
- Do NOT background them and do NOT poll. \`TaskOutput\` does not exist for you — do not go looking for it.
  The background-then-poll pattern degenerates into dozens of short sleeps at several seconds each and has
  been measured to add minutes per command while producing no earlier signal.
- Judge pass/fail by the EXIT CODE, not by how the log text reads. These tools print error-log fixtures,
  deprecation warnings and open-handle notices on completely successful runs.
- Run a command once. Re-run it only immediately after you have edited a file to fix a failure — never
  "to be sure" and never to re-measure.
- Prefer running only the spec file(s) relevant to your chunk for fast iteration; save one full-suite run for
  final verification, not a full-suite run after every fix attempt.

### Context to read

- From the plan file, read the "Design Decisions" section, your own chunk's section, and any plan section your
  items reference (e.g. API changes, Database changes, Test coverage plan, Visual/UX notes) — skip other
  chunks' sections.
- Do NOT read the task's requirements.md unless one of your items is genuinely ambiguous without it — your
  item list plus the plan sections above are the contract.

### After implementing

1. From the conventions list above, run the build and lint checks — fix ALL errors.
2. Run the test checks relevant to your chunk (skip checks marked as final-only/full-suite) — fix failures.
3. Report your result: \`status\` is "ok" only if every item in your task list below is fully implemented and
   build/lint/tests passed; otherwise "blocked". List \`filesChanged\` (paths only) and any \`blockers\` that
   stopped you. If you report "blocked", later chunks will NOT run — only do so for real, unresolved problems,
   not minor warnings.

### Your chunk — Chunk ${index + 1}/${total}: ${chunk.name}

Implement ALL of these:

${itemLines(chunk.items)}

### Already done — earlier chunks (do not re-implement):

${doneText}

### Remaining — later chunks (not your concern):

${remainingText}

Do NOT implement items outside your task list.${progressTaskLines(chunk.taskId)}`
}

let input
try {
  input = typeof args === 'string' ? JSON.parse(args) : (args ?? {})
} catch (e) {
  return {
    chunks: [],
    halted: { index: -1, reason: 'invalid-args-json', argsType: typeof args, message: String(e.message) },
    verification: null,
  }
}

if (!Array.isArray(input.chunks) || input.chunks.length === 0) {
  return {
    chunks: [],
    halted: { index: -1, reason: 'no-chunks', argsType: typeof args },
    verification: null,
  }
}

const invalidIndex = input.chunks.findIndex(
  c => !c || typeof c.name !== 'string' || !Array.isArray(c.items) || c.items.length === 0
)
if (invalidIndex !== -1) {
  log(`Chunk ${invalidIndex + 1}/${input.chunks.length} has an invalid shape (missing name or items) — halting before any chunk runs`)
  return {
    chunks: [],
    halted: { index: invalidIndex, reason: 'invalid-chunk-shape', argsType: typeof args },
    verification: null,
  }
}

phase('Implement')

log('Loading conventions from .claude/repo_config/repo-health-checks.json')
const loadedConventions = await agent(
  'Read the file `.claude/repo_config/repo-health-checks.json` (path relative to the repo root) ' +
    'and return its parsed contents verbatim: the `checks` array and the `environmentNotes` ' +
    'string, exactly as written. Do not modify, reorder, or invent anything.',
  { label: 'load-config', phase: 'Implement', schema: CONFIG_SCHEMA, model: 'haiku', effort: 'low' },
)
const conventions = loadedConventions ?? { checks: [], environmentNotes: '' }

const results = []
let halted = null
for (let i = 0; i < input.chunks.length; i++) {
  const chunk = input.chunks[i]
  const done = input.chunks.slice(0, i)
  const remaining = input.chunks.slice(i + 1)
  log(`Starting Chunk ${i + 1}/${input.chunks.length}: ${chunk.name}`)
  const prompt = buildChunkPrompt(input.planFile, chunk, doneLines(done, results), remainingLines(remaining), i, input.chunks.length, conventions)
  const result = await agent(prompt, {
    phase: 'Implement',
    label: `chunk-${i + 1}-${chunk.name}`,
    schema: CHUNK_RESULT_SCHEMA,
  })
  results.push({ chunk: chunk.name, result })

  if (!result) {
    log(`Chunk ${i + 1}/${input.chunks.length} (${chunk.name}) produced no result — halting, remaining chunks skipped`)
    halted = { index: i, reason: 'no-result' }
    break
  }
  if (result.status === 'blocked') {
    log(`Chunk ${i + 1}/${input.chunks.length} (${chunk.name}) reported blockers — halting, remaining chunks skipped`)
    halted = { index: i, reason: 'blocked' }
    break
  }
  log(`Chunk ${i + 1}/${input.chunks.length} complete`)
}

if (halted) {
  return { chunks: results, halted, verification: null }
}

phase('Verify')
const runnerResult = await agent(buildHealthCheckRunnerPrompt(input.taskLabel, input.verifyTaskId), {
  phase: 'Verify',
  label: 'run-health-check',
  schema: HEALTH_CHECK_SCHEMA,
}) ?? {
  status: 'blocked',
  checks: [],
  fixesApplied: [],
  blockers: ['Health-check runner agent produced no result.'],
}

const judgeResult = await agent(buildHealthCheckJudgePrompt(input.taskLabel, runnerResult), {
  phase: 'Verify',
  label: 'judge-health-check',
  schema: JUDGE_SCHEMA,
  effort: 'low',
}) ?? {
  verdict: 'not_ok',
  reasoning: 'Judge agent produced no result.',
  concerns: [],
}

const verification = {
  ...runnerResult,
  status: judgeResult.verdict === 'ok' ? runnerResult.status : 'blocked',
  judgeVerdict: judgeResult.verdict,
  judgeReasoning: judgeResult.reasoning,
  judgeConcerns: judgeResult.concerns,
}

log(`Implementation done: ${results.length}/${input.chunks.length} chunk(s) completed — verification=${verification.status} (judge=${judgeResult.verdict})`)
return { chunks: results, halted: null, verification }
