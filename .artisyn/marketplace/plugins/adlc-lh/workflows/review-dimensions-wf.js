// Named `-wf` for consistency with the other workflows (and so a future `review-dimensions` skill
// could never shadow it) — see review-deep-wf.js for why the suffix exists.
export const meta = {
  name: 'review-dimensions-wf',
  description: 'Sub-workflow of adlc-lh:review-deep-wf — analyzes a task requirements.md across independent review dimensions in parallel, then filters out suggestions answerable from existing code/docs',
  phases: [
    { title: 'Analyze' },
    { title: 'Filter' },
  ],
}

const DIMENSIONS_CONFIG_PATH = '.claude/repo_config/review-dimensions.yaml'

const SUGGESTION_SCHEMA = {
  type: 'object',
  properties: {
    section: { type: 'string', description: 'The specific section, field, or line the issue applies to (a doc section, or a code file:line if the issue is a mismatch with actual code).' },
    problem: { type: 'string', description: 'Concise explanation of the problem.' },
    suggestion: { type: 'string', description: 'A concrete improvement — specific enough to apply directly.' },
  },
  required: ['section', 'problem', 'suggestion'],
}

const DIMENSION_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: SUGGESTION_SCHEMA,
      description: 'Every issue found for this dimension. Empty array if none.',
    },
  },
  required: ['suggestions'],
}

const FILTER_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: SUGGESTION_SCHEMA,
      description: 'Suggestions that survived filtering, verbatim and unmodified.',
    },
    dropped: {
      type: 'number',
      description: 'How many suggestions were dropped. Must equal droppedItems.length.',
    },
    droppedItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          section: { type: 'string' },
          problem: { type: 'string' },
          resolution: { type: 'string', description: 'One line: where the answer already lives (file, doc section, convention) and what it is.' },
        },
        required: ['section', 'problem', 'resolution'],
      },
      description: 'Every dropped suggestion with a one-line resolution, so a wrong drop can be vetoed by the user.',
    },
  },
  required: ['suggestions', 'dropped', 'droppedItems'],
}

const DIMENSIONS_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          label: { type: 'string' },
          guidance: { type: 'string' },
        },
        required: ['key', 'label', 'guidance'],
      },
    },
  },
  required: ['dimensions'],
}

function buildDimensionPrompt(dim, reqFile, taskLabel, allDimensions, granular) {
  const others = allDimensions.filter(d => d.key !== dim.key).map(d => d.label).join(', ')
  const selfFilterBlock = granular ? '' : `

### Self-filter before reporting

Before finalizing your list, apply this filter to each candidate issue: drop it if a competent
implementer could already resolve it without asking anyone, from the requirements doc itself (its
stated scope, decisions, and constraints), the actual code in this repo, or project conventions
(CLAUDE.md, \`.claude/repo_config/\`, \`docs/knowledgebase/\`). When in doubt, drop it — a defensive
question costs the user more than a small risk of a gap.

Report the survivors in \`suggestions\`. Report every dropped candidate in \`droppedItems\` with its
\`section\`, \`problem\`, and a one-line \`resolution\` saying where the answer already lives and what
it is. Set \`dropped\` = \`droppedItems.length\`.`

  return `You are reviewing the requirements file for task ${taskLabel}, focused ONLY on the
**${dim.label}** dimension. Other dimensions (${others}) are being reviewed independently by
other agents — do not comment on them.

Requirements file: \`${reqFile}\`

Read the file. Where relevant to your dimension, also read the actual code, schema, or API files
this task touches, and treat the source code as ground truth over the doc.

### What to look for

${dim.guidance}

### Reporting

Do NOT edit the requirements file or any other file — you are producing suggestions only.

Report at most the **5 most important** issues for this dimension, ranked by how much a wrong guess
would cost the implementation — drop the rest. Do not pad the list; an empty \`suggestions\` array is
a good result. Skip purely defensive questions whose answer is already dictated by the doc's stated
scope, the existing code, or project conventions (CLAUDE.md, \`docs/knowledgebase/\`).

For every issue you keep, add a \`suggestions\` entry with:
- \`section\`: the specific section/field/line it applies to (or \`file:line\` if it's a code mismatch)
- \`problem\`: a concise explanation of the problem
- \`suggestion\`: a concrete improvement, specific enough to apply directly

If you find no issues for this dimension, return an empty \`suggestions\` array.${selfFilterBlock}`
}

function buildFilterPrompt(dim, reqFile, taskLabel, suggestions) {
  return `You are filtering review suggestions for task ${taskLabel} (dimension: ${dim.label}) before
they are turned into Open Questions for the user to answer.

Requirements file: \`${reqFile}\`

For EACH suggestion below, decide whether a competent implementer could already resolve it without
asking anyone, from:
- the requirements doc itself (its stated scope, decisions, and constraints),
- the actual code in this repo (read the relevant files — source code is ground truth), or
- project conventions (CLAUDE.md, \`.claude/repo_config/\`, \`docs/knowledgebase/\`).

Drop every such suggestion. Keep ONLY suggestions that require a genuine product or scope decision
the doc does not make. When in doubt, drop it — a defensive question costs the user more than a
small risk of a gap.

### Suggestions

${JSON.stringify(suggestions, null, 2)}

Do NOT edit any file. Return:
- \`suggestions\`: the survivors, verbatim (unmodified \`section\`/\`problem\`/\`suggestion\`)
- \`droppedItems\`: every dropped suggestion with its \`section\`, \`problem\`, and a one-line
  \`resolution\` saying where the answer already lives and what it is
- \`dropped\` = droppedItems.length`
}

// See review-deep-wf.js: `args` may be an object, a JSON string, or a bare string. Here the bare
// string is the requirements-file path; unparsable JSON halts rather than throwing.
let input
try {
  input = typeof args === 'string'
    ? (args.trim().startsWith('{') ? JSON.parse(args) : { reqFile: args.trim() })
    : (args ?? {})
} catch (e) {
  return {
    dimensions: [],
    failed: [],
    halted: { reason: 'invalid-args-json', argsType: typeof args, message: String(e.message) },
  }
}

if (!input.reqFile) {
  return { dimensions: [], failed: [], halted: { reason: 'no-reqFile', argsType: typeof args } }
}

// Workflow scripts can't touch the filesystem themselves, so an agent reads the YAML config and
// hands back structured data validated against the schema below.
log(`Loading review dimensions from ${DIMENSIONS_CONFIG_PATH}`)
const loaded = await agent(
  `Read the YAML file \`${DIMENSIONS_CONFIG_PATH}\` (path relative to the repo root) and return ` +
    'its `dimensions` list. Each item has `key`, `label`, and `guidance` (a multi-line YAML block ' +
    'scalar — return it as a single string with the line breaks between bullets preserved). ' +
    'Transcribe exactly what the file contains: do not reorder, reword, or invent entries.',
  { label: 'load-config', phase: 'Analyze', schema: DIMENSIONS_CONFIG_SCHEMA, model: 'haiku', effort: 'low' },
)

const DIMENSIONS = loaded?.dimensions
if (!Array.isArray(DIMENSIONS) || DIMENSIONS.length === 0) {
  throw new Error(`adlc-lh:review-dimensions-wf could not load a dimensions array from ${DIMENSIONS_CONFIG_PATH}.`)
}

const granular = input.granularReview === true

phase('Analyze')
// granularReview=true: review → filter as two independent agents per dimension (no barrier) — the
// filter drops suggestions a competent implementer could already resolve from existing code, the
// doc itself, or conventions. granularReview=false (default): the review agent self-filters in the
// same pass, halving the agent count for the same outcome.
const raw = await pipeline(
  DIMENSIONS,
  dim => agent(buildDimensionPrompt(dim, input.reqFile, input.taskLabel, DIMENSIONS, granular), {
    phase: 'Analyze',
    label: `dimension-${dim.key}`,
    schema: granular ? DIMENSION_RESULT_SCHEMA : FILTER_SCHEMA,
  }),
  async (review, dim) => {
    if (!review) return null
    if (!granular) {
      return {
        suggestions: review.suggestions ?? [],
        dropped: review.dropped ?? 0,
        droppedItems: review.droppedItems ?? [],
      }
    }
    if (review.suggestions.length === 0) return { suggestions: [], dropped: 0, droppedItems: [] }
    const filtered = await agent(buildFilterPrompt(dim, input.reqFile, input.taskLabel, review.suggestions), {
      phase: 'Filter',
      label: `filter-${dim.key}`,
      schema: FILTER_SCHEMA,
    })
    // If the filter agent itself fails, fall back to the unfiltered suggestions rather than losing them.
    return filtered ?? { suggestions: review.suggestions, dropped: 0, droppedItems: [] }
  },
)

const dimensions = []
const failed = []
raw.forEach((result, i) => {
  if (result) {
    dimensions.push({
      dimension: DIMENSIONS[i].label,
      suggestions: result.suggestions,
      dropped: result.dropped ?? 0,
      droppedItems: result.droppedItems ?? [],
    })
  } else {
    failed.push(DIMENSIONS[i].label)
  }
})

if (failed.length > 0) {
  log(`${failed.length} dimension(s) produced no result and were skipped: ${failed.join(', ')}`)
}

log(`Analysis done: ${dimensions.reduce((n, d) => n + d.suggestions.length, 0)} suggestion(s) kept, ${dimensions.reduce((n, d) => n + d.dropped, 0)} dropped by filter, across ${dimensions.length}/${DIMENSIONS.length} dimension(s)`)
return { dimensions, failed, halted: null }
