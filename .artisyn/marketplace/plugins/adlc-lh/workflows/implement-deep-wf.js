// Named `-wf` so it never shadows the `adlc-lh:implement-deep` SKILL — see review-deep-wf.js for why.
export const meta = {
  name: 'implement-deep-wf',
  description: 'Engine behind the adlc-lh:implement-deep skill — invoke /adlc-lh:implement-deep instead. Implements an approved chunk list for a task plan, chunk-by-chunk',
  phases: [
    { title: 'Implement' },
    { title: 'Plan check' },
  ],
}

// Final verification is deliberately NOT part of this workflow. The skill runs
// `adlc-lh:check-health` (finalRun: true) itself once this returns, so its structured result
// reaches the caller as-is — no agent re-typing it, and no second agent judging that re-typing.

const CHUNK_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['ok', 'blocked'],
      description: '"ok" only if the lint/typecheck/relevant tests you ran all passed and every item in this chunk is fully implemented. "blocked" if anything could not be completed.',
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

const PLAN_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    itemsChecked: {
      type: 'number',
      description: 'How many plan items you checked against the code.',
    },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          chunk: { type: 'string', description: 'Chunk name the item belongs to.' },
          item: { type: 'string', description: 'The plan item text, verbatim.' },
          problem: { type: 'string', description: 'What is missing or wrong in the code, with file path(s).' },
        },
        required: ['chunk', 'item', 'problem'],
      },
      description: 'Plan items that are not implemented, or only partly. Empty array if every item is done.',
    },
  },
  required: ['itemsChecked', 'gaps'],
}

// The checker gets the plan and the working tree — NOT the chunk agents' summaries or statuses, and is
// told to ignore checkboxes — so it reads the code without being anchored on the implementers' own claims.
function buildPlanCheckPrompt(planFile, chunks) {
  const list = chunks.map((c, i) => `#### Chunk ${i + 1}: ${c.name}\n${c.items.map(it => `- ${it}`).join('\n')}`).join('\n\n')
  return `You are independently checking that an implementation plan was actually carried out in the code.
You did not write this code. Do not modify any file — read only.

Plan file: \`${planFile}\` — read its "Design Decisions" section and every plan section the items below
reference (API changes, Database changes, Test coverage plan, ...).

How to find what changed: \`git status --short\` and \`git diff\` (read-only git only), then read new
(untracked) files directly. The working tree may also hold unrelated changes made before this run — ignore
them; judge only whether each item below is present.

For EACH item below, find the code that implements it and decide whether it is fully done. Judge by the code,
never by a checkbox in the plan file or by a comment claiming it is done. An item that is there but contradicts
a Design Decision, or a test item whose test is missing or does not exercise what the item says, is a gap.

Report every gap with the item text verbatim and the concrete problem (file paths). Do not report style
nitpicks, refactoring ideas or anything outside the items listed — only "this item is not (fully) done".

### Plan items

${list}`
}

function itemLines(items) {
  return items.map(i => `- [ ] ${i}`).join('\n')
}

// finalOnly checks (full e2e, scenario suites, contracts — the slow ones) are left out of the chunk
// prompt entirely: a chunk agent cannot run what it is never shown, and the final verification
// after the last chunk runs them. Only their names are listed, so the agent knows they exist.
function checkLines(checks) {
  if (!checks || checks.length === 0) {
    return '- Use the canonical commands from CLAUDE.md → "Test & build commands (canonical)".'
  }
  const iterative = checks.filter(c => !c.finalOnly)
  const finalOnly = checks.filter(c => c.finalOnly)
  const lines = iterative
    .map(c => `- ${c.module}: \`${c.command}\` (from \`${c.dir}\`)${c.instructions ? ` — ${c.instructions}` : ''}`)
  if (finalOnly.length > 0) {
    lines.push(`- Final-only, NOT yours to run (the final verification after the last chunk runs them): ${finalOnly.map(c => c.name).join(', ')}`)
  }
  return lines.join('\n')
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
- Prefer running only the spec file(s) relevant to your chunk for fast iteration — full suites are the final
  verification's job, not yours.

### You are one step of the work cycle, not all of it

Project instructions may tell you to follow a work cycle, to run a final/full health check, or to run a test
suite after every change. For this chunk, the iterate step of that cycle is exactly the "After implementing"
section below. The final verification — every final-only check and every skill that runs a full suite — is
run ONCE by the orchestrator after the last chunk. Do NOT invoke \`adlc-lh:check-health\`, \`adlc-lh:workcycle\`
or the \`Workflow\` tool, and do not run any final-only check.

### Context to read

- From the plan file, read the "Design Decisions" section, your own chunk's section, and any plan section your
  items reference (e.g. API changes, Database changes, Test coverage plan, Visual/UX notes) — skip other
  chunks' sections.
- Do NOT read the task's requirements.md unless one of your items is genuinely ambiguous without it — your
  item list plus the plan sections above are the contract.
- The plan splits chunks by code area so each chunk agent reads only its own part of the codebase. Read the
  code your items touch and what it directly calls; for what earlier chunks built, read the files listed under
  "Already done" and the interfaces the plan pins down. Do not survey areas that belong to other chunks.

### After implementing

1. From the conventions list above, run the lint and typecheck checks for the packages you touched — fix ALL
   errors. Typecheck, not the build, is what catches type errors here.
2. Run the full build check ONLY if your chunk changed how things are built (build scripts, bundler/compiler
   config, package manifests, files the build copies or generates). Otherwise skip it — the final verification
   runs it.
3. Run the test checks relevant to the packages you touched — fix failures. Skip checks for packages you did
   not touch.
4. If your chunk changes behaviour that a scenario / e2e test covers (or adds a step to one), run ONLY that
   test — the targeted single-test command from the project notes above (e.g. one scenario selected by its
   tag) — and fix failures. A targeted run like this is allowed; the full suite is the final verification's.
5. Report your result: \`status\` is "ok" only if every item in your task list below is fully implemented and
   the checks you ran passed; otherwise "blocked". List \`filesChanged\` (paths only) and any \`blockers\` that
   stopped you. If you report "blocked", later chunks will NOT run — only do so for real, unresolved problems,
   not minor warnings.

### Your chunk — Chunk ${index + 1}/${total}: ${chunk.name}

Implement ALL of these:

${itemLines(chunk.items)}

### Already done — earlier chunks (do not re-implement):

${doneText}

### Remaining — later chunks (not your concern):

${remainingText}

Do NOT implement items outside your task list.`
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
  return { chunks: results, halted, planCheck: null, verification: null }
}

// Plan check: chunk statuses are self-reported, and the final health checks only prove the code builds
// and the tests pass — neither catches a plan item that was silently skipped. One fresh reviewer checks
// every item against the code; any gaps get exactly one fix-up round (reusing the chunk prompt, so the
// fix-up agent gets the same conventions and check rules). The fix-up is not re-reviewed — its own
// checks plus the skill's final verification cover it, and its result says which gaps it closed.
phase('Plan check')
log('Checking every plan item against the code')
const planReview = await agent(buildPlanCheckPrompt(input.planFile, input.chunks), {
  phase: 'Plan check',
  label: 'plan-check',
  schema: PLAN_CHECK_SCHEMA,
})

let fixup = null
if (!planReview) {
  log('Plan check produced no result — reported as unchecked')
} else if (planReview.gaps.length === 0) {
  log(`Plan check: all ${planReview.itemsChecked} item(s) implemented`)
} else {
  log(`Plan check: ${planReview.gaps.length} gap(s) — running one fix-up round`)
  const gapChunk = {
    name: 'Plan gaps found by the plan check',
    items: planReview.gaps.map(g => `[${g.chunk}] ${g.item} — gap: ${g.problem}`),
  }
  fixup = await agent(
    buildChunkPrompt(input.planFile, gapChunk, doneLines(input.chunks, results), remainingLines([]), input.chunks.length, input.chunks.length + 1, conventions),
    { phase: 'Plan check', label: 'plan-gaps-fixup', schema: CHUNK_RESULT_SCHEMA },
  )
  log(fixup ? `Fix-up round: ${fixup.status}` : 'Fix-up round produced no result')
}

const planCheck = planReview
  ? {
      status: planReview.gaps.length === 0 ? 'ok' : (fixup?.status === 'ok' ? 'fixed' : 'gaps'),
      itemsChecked: planReview.itemsChecked,
      gaps: planReview.gaps,
      fixup,
    }
  : { status: 'unchecked', itemsChecked: 0, gaps: [], fixup: null }

log(`Implementation done: ${results.length}/${input.chunks.length} chunk(s) completed, plan check=${planCheck.status} — final verification is run by the skill`)
return { chunks: results, halted: null, planCheck, verification: null }
