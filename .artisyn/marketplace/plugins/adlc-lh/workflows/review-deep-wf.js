// Named `-wf` so it never shadows the `adlc-lh:review-deep` SKILL: a workflow and a skill sharing a
// name collide in the slash-command namespace, and the workflow wins — so `/adlc-lh:review-deep`
// would fire this engine directly and silently skip the skill's clean-context guard, chat report,
// common-sense resolution and distill steps. Every workflow in this plugin carries the suffix.
export const meta = {
  name: 'review-deep-wf',
  description: 'Engine behind the adlc-lh:review-deep skill — invoke /adlc-lh:review-deep instead. Locates a task, integrates answered open questions, analyzes requirements across review dimensions, then converts findings into Open Questions and draws wireframes back into the doc',
  phases: [
    { title: 'Locate' },
    { title: 'Integrate' },
    { title: 'Analyze' },
    { title: 'Write back' },
  ],
}

const LOCATE_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['found', 'done', 'not-found', 'no-requirements', 'ambiguous'],
      description: '"found" if the task folder and its requirements doc both exist in the todo directory. ' +
        '"done" if the task only exists in the done directory. "no-requirements" if the todo folder exists ' +
        'but its requirements doc does not. "ambiguous" if the task id matches more than one todo folder. ' +
        '"not-found" if the task cannot be located anywhere.',
    },
    candidates: {
      type: 'array',
      items: { type: 'string' },
      description: 'Task folder names that matched. Required when status is "ambiguous".',
    },
    reqFile: { type: 'string', description: 'Full path to requirements.md. Required when status is "found".' },
    taskSlug: { type: 'string', description: 'The task folder name, e.g. "PROJ-123-some-slug". Required when status is "found".' },
    todoIndex: { type: 'string', description: 'The TODO_INDEX path the resolver printed, so a halted run can point the user at the task index.' },
    granularReview: {
      type: 'boolean',
      description: 'The `granularReview` value from `.claude/repo_config/project-env.json` (false if the file or key is missing).',
    },
    openQuestionsIntegrated: {
      type: 'boolean',
      description: 'Only meaningful when granularReview is false and status is "found": whether answered Open Questions were integrated into the doc in this same pass.',
    },
    openQuestionsSummary: {
      type: 'string',
      description: 'Only meaningful when granularReview is false and status is "found": one-sentence summary of what, if anything, was integrated.',
    },
  },
  required: ['status', 'granularReview'],
}

const OPEN_QUESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    changed: { type: 'boolean', description: 'Whether any answered Open Questions were integrated into the doc.' },
    summary: { type: 'string', description: 'One sentence describing what, if anything, was integrated.' },
  },
  required: ['changed', 'summary'],
}

const OQ_WRITE_SCHEMA = {
  type: 'object',
  properties: {
    openQuestionsAdded: { type: 'number', description: 'How many new Open Questions were added to the doc (duplicates of existing ones don\'t count).' },
    summary: { type: 'string' },
  },
  required: ['openQuestionsAdded', 'summary'],
}

const WIREFRAMES_SCHEMA = {
  type: 'object',
  properties: {
    wireframesCreated: {
      type: 'array',
      items: { type: 'string' },
      description: 'Paths of SVG wireframe files created or updated, relative to the task folder.',
    },
    summary: { type: 'string' },
  },
  required: ['wireframesCreated', 'summary'],
}

function buildLocatePrompt(taskLabel, resolverCommand) {
  return `Locate the task requirements file for task **${taskLabel}**.

1. Read \`.claude/repo_config/project-env.json\` and extract its \`granularReview\` boolean field.
   Return it as \`granularReview\`. If the file or the key is missing, use \`false\`.
2. Run this command from the repo root — it resolves the task id to the whole paths of that task's
   docs, so nothing here has to be assembled from a directory and a folder name:

   \`\`\`bash
   ${resolverCommand}
   \`\`\`

   Use the paths it prints verbatim. Return its \`TODO_INDEX\` value as \`todoIndex\`.
3. Map its \`STATUS\` to what you return:
   - \`found-in-todo\` with \`REQUIREMENTS\` NOT marked \`(MISSING)\` → status "found", with
     \`REQUIREMENTS\` as \`reqFile\` and \`TASK_FOLDER_NAME\` as \`taskSlug\`.
   - \`found-in-todo\` with \`REQUIREMENTS\` marked \`(MISSING)\` → status "no-requirements".
   - \`ambiguous\` → status "ambiguous", with every \`CANDIDATE:\` path in \`candidates\`.
   - \`found-in-done\` → status "done".
   - \`not-found\` → status "not-found".
   - \`error\`, or the command cannot run at all → status "not-found", and put the \`ERROR\` line in
     \`candidates\` so the caller can show it.

Do not modify any files in this step, EXCEPT for the one case below.

If (and only if) \`granularReview\` is \`false\` AND status is "found": before returning, also check
the \`## Open Questions\` section (or similarly named) of \`reqFile\` for any questions that already
have answers filled in. If there are any, integrate those answers into the main body of the
document right now — rewrite the relevant section(s), update any existing wireframe references if
the answer changes what the wireframe should show, and remove the answered questions from Open
Questions. Report whether you changed anything as \`openQuestionsIntegrated\` and a one-sentence
\`openQuestionsSummary\`. If there are no answered open questions, make no changes and report
\`openQuestionsIntegrated: false\`.

If \`granularReview\` is \`true\`, or status is not "found", skip that integration step entirely —
it will be handled separately (or does not apply).`
}

function buildOpenQuestionsPrompt(reqFile) {
  return `Requirements file: \`${reqFile}\`

If the \`## Open Questions\` section (or similarly named) has any questions that already have
answers filled in, integrate those answers into the main body of the document — rewrite the
relevant section(s), update any existing wireframe references if the answer changes what the
wireframe should show, and remove the answered questions from the Open Questions section.

If there are no answered open questions, make no changes.

Report whether you changed anything and a one-sentence summary.`
}

function formatSuggestions(dimensions) {
  const withIssues = dimensions
    .map(d => d.suggestions.length === 0 ? null : { dimension: d.dimension, suggestions: d.suggestions })
    .filter(Boolean)

  if (withIssues.length === 0) {
    return '(no suggestions — no issues were found across any dimension)'
  }

  return withIssues
    .map(d => `**${d.dimension}**\n` + d.suggestions.map(s => `- [${s.section}] ${s.problem} → ${s.suggestion}`).join('\n'))
    .join('\n\n')
}

function buildOpenQuestionsWriteBackPrompt(reqFile, taskLabel, taskSlug, dimensions) {
  return `Requirements file: \`${reqFile}\` (task ${taskLabel}, folder \`${taskSlug}\`)

A review found the following issues (grouped here by internal analysis dimension purely so you can
see everything at once — that grouping is internal only and must NEVER appear in the file itself):

${formatSuggestions(dimensions)}

### Your task

Convert every issue above into a plain, self-contained **Open Question** and add it to the
requirements doc's \`## Open Questions\` section (add the section, right before \`## Notes\`,
following the template's format, if it doesn't already exist).
- Phrase each as an actual question a reader can understand and answer with zero extra context,
  e.g. "What priority should this task have?" or "Should the delete endpoint return 200 or 204
  on success?". Never write the raw \`problem\`/\`suggestion\` pair, a dimension label like
  "[Gaps]"/"[Ambiguities]", a heading naming an analysis dimension (no "#### Gaps", "### Review
  flags", or similar), or any rationale/analysis prose — the question itself is the entire
  entry.
- Skip an issue if an existing, unanswered Open Question in the file already covers the same
  ground — do not duplicate it. Otherwise append a new bullet.
- The document must end up containing only its normal sections (Description, Functional
  Requirements, Non-Functional Requirements, Acceptance Criteria, Common sense considerations,
  Open Questions, Notes, etc.) — never a separate scratch/analysis section. "Common sense
  considerations" is a legitimate section holding one-line decisions; keep it as-is. If the file
  has leftover scratch content from an earlier review format (e.g. a "Review Notes" section,
  "Round 1"/"Round 2" history, or any section named after an analysis dimension), fold any
  still-relevant point from it into a proper Open Question the same way described above, then
  delete that legacy section entirely.
- Do NOT touch Functional Requirements, Non-Functional Requirements, Acceptance Criteria, or any
  other section — this step only ever adds to Open Questions.
- If there is nothing left to convert, make no changes.

Report: how many new Open Questions you added (after skipping duplicates), and a short summary.`
}

function buildWireframesPrompt(reqFile, taskLabel, taskSlug) {
  return `Requirements file: \`${reqFile}\` (task ${taskLabel}, folder \`${taskSlug}\`)

Draw SVG wireframes for key UI elements described in the requirements:
- Save them under the task folder's \`wireframes/\` directory.
- Embed them in the requirements doc, e.g. \`![Search page wireframe](wireframes/search-page.svg)\` —
  this embed is the ONLY change you may make to the doc; do not touch any other content.
- Always use light theme.
- Before drawing, use Playwright to open the live app and screenshot the relevant existing UI
  first, so each wireframe stays visually consistent with the current UI/UX.
- If the task has no UI elements, create nothing and report an empty list.

Report: the list of wireframe files created or updated, and a short summary.`
}

// `args` can arrive as a real object (the skill passes one), as a JSON string (some environments
// stringify it), or as a bare slash-command argument — `/adlc-lh:review-deep-wf SHAD-241` hands the
// script the raw string `"SHAD-241"`. A bare string is the task label, and unparsable JSON halts
// with a reason instead of throwing a stack trace before any agent runs.
let input
try {
  input = typeof args === 'string'
    ? (args.trim().startsWith('{') ? JSON.parse(args) : { taskLabel: args.trim() })
    : (args ?? {})
} catch (e) {
  return {
    halted: { reason: 'invalid-args-json', argsType: typeof args, message: String(e.message) },
    reqFile: null,
  }
}

if (!input.taskLabel) {
  return { halted: { reason: 'no-task-label', argsType: typeof args }, reqFile: null }
}

// The label is interpolated into the shell command below, so a value that is not a folder-name
// prefix is refused outright rather than quoted and hoped for.
if (!/^[A-Za-z0-9._-]+$/.test(input.taskLabel)) {
  return { halted: { reason: 'invalid-task-label', candidates: [input.taskLabel] }, reqFile: null }
}

// ${CLAUDE_PLUGIN_ROOT} is substituted in skill markdown, never in workflow source, and a workflow
// script cannot look at the filesystem to find itself -- so the skill passes the resolved plugin
// root in. Guessing a path here would fail as a confusing "task not found" three steps later.
if (!input.pluginRoot) {
  return { halted: { reason: 'no-plugin-root' }, reqFile: null }
}

phase('Locate')
const resolverCommand = 'node "' + input.pluginRoot + '/scripts/adlc-task.js" --task "' + input.taskLabel + '"'
const located = await agent(buildLocatePrompt(input.taskLabel, resolverCommand), {
  phase: 'Locate',
  label: 'locate-task',
  schema: LOCATE_SCHEMA,
})

if (!located || located.status !== 'found') {
  const reason = located ? located.status : 'no-result'
  log(`Locate step ended with status "${reason}" — halting`)
  return {
    halted: { reason, candidates: located?.candidates ?? null },
    reqFile: located?.reqFile ?? null,
    todoIndex: located?.todoIndex ?? null,
  }
}

const reqFile = located.reqFile
const taskSlug = located.taskSlug
const granular = located.granularReview === true

// granularReview=true: dedicated Integrate agent (original behavior). granularReview=false
// (default): the Locate agent already folded this in — reuse its result instead of a second pass.
phase('Integrate')
let openQuestions
if (granular) {
  openQuestions = await agent(buildOpenQuestionsPrompt(reqFile), {
    phase: 'Integrate',
    label: 'integrate-open-questions',
    schema: OPEN_QUESTIONS_SCHEMA,
  }) ?? { changed: false, summary: 'Open-questions agent produced no result.' }
} else {
  openQuestions = {
    changed: located.openQuestionsIntegrated ?? false,
    summary: located.openQuestionsSummary ?? '',
  }
}

phase('Analyze')
let analysis
try {
  analysis = await workflow('adlc-lh:review-dimensions-wf', { reqFile, taskLabel: input.taskLabel, granularReview: granular })
} catch (e) {
  log(`adlc-lh:review-dimensions-wf workflow failed to run: ${e.message}`)
  analysis = null
}
const dimensions = analysis?.dimensions ?? []
const failedDimensions = analysis?.failed ?? []

if (failedDimensions.length > 0) {
  log(`Dimensions with no result: ${failedDimensions.join(', ')}`)
}

phase('Write back')
// Two sequential agents (both edit the same doc, so they can't run in parallel): the fast, critical
// Open-Questions write-back first, then the slow, Playwright-dependent wireframe pass — a wireframe
// failure can no longer stall or derail the doc write-back.
const oqWrite = await agent(buildOpenQuestionsWriteBackPrompt(reqFile, input.taskLabel, taskSlug, dimensions), {
  phase: 'Write back',
  label: 'write-back-open-questions',
  schema: OQ_WRITE_SCHEMA,
}) ?? { openQuestionsAdded: 0, summary: 'Open-questions write-back agent produced no result.' }

const wireframes = await agent(buildWireframesPrompt(reqFile, input.taskLabel, taskSlug), {
  phase: 'Write back',
  label: 'draw-wireframes',
  schema: WIREFRAMES_SCHEMA,
}) ?? { wireframesCreated: [], summary: 'Wireframes agent produced no result.' }

const writeBack = {
  openQuestionsAdded: oqWrite.openQuestionsAdded,
  wireframesCreated: wireframes.wireframesCreated,
  summary: `${oqWrite.summary} ${wireframes.summary}`.trim(),
}

log(`Review done: ${dimensions.reduce((n, d) => n + d.suggestions.length, 0)} suggestion(s) kept (${dimensions.reduce((n, d) => n + (d.dropped ?? 0), 0)} filtered out) across ${dimensions.length} dimension(s), ${writeBack.wireframesCreated.length} wireframe(s) created/updated`)
return {
  halted: null,
  reqFile,
  taskSlug,
  openQuestions,
  dimensions,
  failedDimensions,
  writeBack,
}
