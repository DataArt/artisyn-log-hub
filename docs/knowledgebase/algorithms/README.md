---
type: Knowledgebase Bundle
title: Algorithm docs (doc-driven table tests)
description: Format of the per-algorithm docs in docs/knowledgebase/algorithms/, how their single examples block becomes a table-driven unit test through scripts/algo-docs/load-examples.cjs in jest, vitest and node --test, and the AI-plus-owner review recorded in front-matter.
resource: scripts/algo-docs/load-examples.cjs
tags: [testing, algorithms, unit-tests, docs, review]
timestamp: 2026-10-15T00:00:00Z
---

# Algorithm docs

Unit tests in this repo are kept only for **readable algorithms**: pure logic whose rules a person
can read and repeat on paper (cost formula, login backoff, change-surface concentration, ...).
Everything else is covered by the scenario suite ([../test/scenarios.md](../test/scenarios.md)).

Each such algorithm has one doc here, and **the doc's worked examples are the test cases**. The
test holds no numbers of its own: it loads the doc's examples block and runs every row against
the real code. Editing a row changes the test without touching test code; changing the code
without the doc (or the doc without the code) turns the test red. Doc and test cannot drift.

Design background: `docs/qaa-overview/14-algorithm-units.md` (this README is the binding
format where the two differ).

## Docs

<!-- One row per doc; keep sorted by area. Review = the front-matter `reviewed`/`reviewer`. -->

| Doc | Code | Test runner |
|---|---|---|
| [cost-formula](cost-formula.md) | `packages/pricing/src/cost.ts` (server via `server/src/logs/cost.sql.ts`, client via `client/.../lib/format.ts`); twin hook `post-turn-analysis-worker.js` | jest, vitest, `node --test` |
| [anthropic-pricing-parse](anthropic-pricing-parse.md) | `server/src/model-pricing/anthropic-pricing-parser.ts` | jest |
| [otel-cost-selection](otel-cost-selection.md) | `server/src/logs/otel-cost.sql.ts` | jest |
| [cache-ratio-and-causes](cache-ratio-and-causes.md) | `server/src/logs/cache-ratio.sql.ts`, `reports/cache-read-ratio.service.ts`, `turn-walk.ts`; twin `client/.../lib/format.ts` | jest, vitest |
| [work-time](work-time.md) | `server/src/logs/claude-extractor.ts`; twin hook `post-turn-analysis-worker.js` | jest, `node --test` |
| [session-time-span](session-time-span.md) | `server/src/logs/artisyn-extractor.ts` | jest |
| [change-surface-concentration](change-surface-concentration.md) | `server/src/logs/change-surface/change-surface-metrics.ts` | jest |
| [repo-url-normalization](repo-url-normalization.md) | `server/src/logs/repo-url-normalizer.ts` | jest |
| [ndjson-tolerance](ndjson-tolerance.md) | hook `ndjson-sanitize.js`, `server/src/logs/ndjson-parser.ts` | `node --test`, jest |
| [login-backoff](login-backoff.md) | `server/src/auth/login-backoff.service.ts` | jest |
| [password-policy](password-policy.md) | `server/src/auth/utils/password-policy.ts` | jest |
| [auth-startup-config](auth-startup-config.md) | `server/src/auth/config/auth-startup-validation.ts` | jest |
| [local-request-detection](local-request-detection.md) | `server/src/auth/utils/localhost.util.ts`, `container-gateway.util.ts` | jest |
| [harness-snapshot](harness-snapshot.md) | hook `skill-catalog.js`, `harness-snapshot.js` | `node --test` |
| [workflow-agent-rows](workflow-agent-rows.md) | `client/.../session-log/workflow-agent-rows.ts` | vitest |
| [sysctx-anatomy](sysctx-anatomy.md) | `client/.../session-log/sysctx-anatomy/sysctx-anatomy.ts` | vitest |
| [tool-call-sections](tool-call-sections.md) | `client/.../session-log/tool-calls.ts` | vitest |
| [tool-call-outcome](tool-call-outcome.md) | `client/.../session-log/tool-outcome.ts`; twin `server/src/logs/tool-stats.ts` | vitest, jest |
| [bash-command-view](bash-command-view.md) | `packages/bash-view/src/*` (`@loghub/bash-view`; client loader `client/src/viewer/lib/bash-view/`) | vitest |
| [okf-access-extraction](okf-access-extraction.md) | `server/src/logs/okf/okf-access-extractor.ts` | jest |
| [okf-task-context](okf-task-context.md) | `server/src/logs/okf/okf-task-context.ts` | jest |
| [okf-verdict](okf-verdict.md) | `server/src/logs/okf/okf-verdict.ts` (+ team filter `okf-usage-tree.ts`) | jest |
| [okf-snapshot](okf-snapshot.md) | hook `okf-snapshot.js` | `node --test` |
| [tool-monitor-name-validation](tool-monitor-name-validation.md) | `packages/tool-monitor/src/index.ts` (`@loghub/tool-monitor`; server and client); twin hook `tool-wrap-names.js` | jest, `node --test` |
| [mcp-call-extraction](mcp-call-extraction.md) | `server/src/logs/tool-monitoring/mcp-call-extractor.ts` | jest |
| [cli-command-recognition](cli-command-recognition.md) | `server/src/logs/tool-monitoring/cli-command-recognition.ts` | jest |
| [tool-wrapper-matching](tool-wrapper-matching.md) | `server/src/logs/tool-monitoring/wrapper-record-matching.ts` | jest |
| [tool-usefulness-signals](tool-usefulness-signals.md) | `server/src/logs/tool-monitoring/tool-call-signals.ts` | jest |
| [tool-output-format](tool-output-format.md) | `client/.../repository/tools/output-format.ts` | vitest |
| [tool-wrapper-fidelity](tool-wrapper-fidelity.md) | hook `tool-wrap-shims.js`, `tool-wrap-tee.js`, `tool-wrap-powershell.js` (real shells; skipped unless `LOGHUB_FIDELITY_TEST=1`, run from `scripts/tool-wrap-check/`'s verification project) | `node --test` |
| [sandbox-prune-classification](sandbox-prune-classification.md) | `scripts/claude-docker/prune.mjs` | `node --test` (`npm run test:scripts`) |
| [executable-config-guard](executable-config-guard.md) | `scripts/ci/config-guard.js` | `node --test` (`npm run test:scripts`) |
| [security-scan-summary](security-scan-summary.md) | `scripts/ci/security-summary.js` | `node --test` (`npm run test:scripts`) |
| [release-version](release-version.md) | `scripts/ci/release-version.js` | `node --test` (`npm run test:scripts`) |
| [release-assets](release-assets.md) | `scripts/release-kit.js`, `scripts/ci/release-notes.js`, `scripts/ci/virustotal-scan.js` (`scopeFor`) | `node --test` (`npm run test:scripts`) |
| [user-docs-links](user-docs-links.md) | `scripts/user-docs/links.js` (`resolveLink`, `rewritePageLinks`) | `node --test` (`npm run test:scripts`) |
| [site-example-dataset](site-example-dataset.md) | `scripts/site/dataset.mjs` (`checkDataset`, `fillPlaceholders`) | `node --test` (`npm run test:scripts`) |

## File layout

- Doc: `docs/knowledgebase/algorithms/<name>.md`; `<name>` is a lowercase slug
  (`[a-z0-9-]`), e.g. `change-surface-concentration`.
- Test: next to the code it tests.
  - server (jest): `<module>.algo.spec.ts` beside the module in `server/src/...`;
  - client (vitest): `<module>.algo.test.ts` under `client/src/...`;
  - hook (`node --test`): `hook/.claude/telemetry_tool/__tests__/<name>.algo.test.js`.
- Loader: `scripts/algo-docs/load-examples.cjs` (types: `load-examples.d.cts`), tested by
  `scripts/__tests__/algo-docs.test.js` (`npm run test:scripts`). That test also loads every doc
  in this directory except this README, so a malformed doc fails there even before its own test
  runs.
- Reviewer prompt: `scripts/algo-docs/review-prompt.md`.

Docs are written in English.

## Doc format

````markdown
---
reviewed: no
reviewer: none
---

# <Algorithm name>

## Purpose
One or two sentences: why the user needs this number or behaviour.

## Code
- Implementation: `server/src/logs/change-surface/change-surface-metrics.ts` (`computeChangeSurface`)
- Twins: other copies of the same rule (e.g. in the client or the hook), or "none".
- Test: `server/src/logs/change-surface/change-surface-metrics.algo.spec.ts`

## Input and output
Only if the rules are unclear without it.

## Rules
Numbered steps, then the formulas, using the constant names from the code. A reader must be able
to compute every example by hand from this section alone.

## Edge cases
- One line per case, each naming the example id(s) that pin it: "Empty input: CS-13".

## Examples
Prose describing the input shape, then exactly one block:

```examples
[
  {
    "id": "CS-01",
    "input": {"folders": {"src/api": 1}},
    "expected": {"changedFiles": 1, "concentration": 100, "band": "focused"},
    "note": "K=1: E=S=M=D=1, score=1"
  }
]
```

## Mutations
3-6 plausible wrong implementations and the example id that kills each:
- "E = 0 instead of 1 when K = 1" -> CS-02.

## Where the result is visible
Screen and field, or API field, or "safe behaviour: ...".
````

### Required sections

`Purpose`, `Code`, `Rules`, `Edge cases`, `Examples`, `Mutations`, `Where the result is visible`.
`Input and output` and anything else are added only when the doc is unclear without them.

### The examples block

- The `## Examples` section holds **exactly one** fenced block whose info string is `examples`
  (the loader fails on zero, on two, or on one outside `## Examples`).
- Its body is a JSON array. Each row is an object:

  | Key | Required | Meaning |
  |---|---|---|
  | `id` | yes | Unique string within the doc (e.g. `CS-01`); the test title. |
  | `input` | yes | Any JSON; the doc's prose defines its shape and the test maps it to a call. |
  | `expected` | yes | Any JSON (`null`/`false` allowed); how it is compared is up to the test, normally a subset match (`expect.objectContaining`) of the listed keys. |
  | `note` | yes | The **independent derivation** of `expected` from the Rules section, with the arithmetic. Never "what the code returned". |
  | other | no | Passed through untouched, e.g. `tol` for a numeric tolerance the test honours, or `"only": "server"` for a row a twin cannot receive (the twin's test skips it, and the doc's Code section says why). |

- Rows are returned in doc order. One case per row: a boundary checked on both sides is two rows.
- Numbers are **verified by running the real code** before the doc is accepted; a mismatch with
  the hand derivation is a defect in either the doc or the code and is settled by review, never
  by silently copying the code's output into `expected`.

### Front-matter

| Key | Values |
|---|---|
| `reviewed` | `no` until reviewed, then the review date `YYYY-MM-DD`. |
| `reviewer` | `none`; `ai` once the AI review passed and the owner sign-off is pending; `ai+owner` once the owner signed. |

Re-review (reset to `reviewed: no`) whenever a rule or a formula changes. Adding or fixing a row
that only re-derives an existing rule does not need a re-review.

## Writing the test

The test maps `input` to a call of the real function and compares with `expected`. It contains
no numbers of its own.

Server, jest (ts-jest). The import compiles to a `require`; the jest transform does not match
`.cjs`, so node loads the loader as-is (no `allowJs`), and TypeScript takes the types from
`load-examples.d.cts`:

```ts
// server/src/logs/change-surface/change-surface-metrics.algo.spec.ts
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import { computeChangeSurface } from './change-surface-metrics';

const rows = loadExamples('change-surface-concentration');

it.each(rows)('$id', ({ input, expected }) => {
  // `expected` is `unknown`; objectContaining takes it without a cast.
  expect(computeChangeSurface(toFacts(input))).toEqual(expect.objectContaining(expected));
});
```

`loadExamples<I, E>(name)` may name the documented input and output shapes, typed the way
`JSON.parse` is (the loader checks the row shape, not the contents), so a test reads
`input.tokens` without casts: `loadExamples<{ tokens: Tokens }, { cost: number | null }>('cost-formula')`.

Client, vitest. Vite would transform the `.cjs` file as ESM, so load it through node's `require`:

```ts
// client/src/viewer/lib/<module>.algo.test.ts
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

const loader: typeof import('../../../../scripts/algo-docs/load-examples.cjs') = createRequire(
  import.meta.url,
)('../../../../scripts/algo-docs/load-examples.cjs');

it.each(loader.loadExamples('<name>'))('$id', ({ input, expected }) => { /* ... */ });
```

Hook, `node --test`:

```js
// hook/.claude/telemetry_tool/__tests__/<name>.algo.test.js
const { loadExamples } = require('../../../../scripts/algo-docs/load-examples.cjs');

for (const row of loadExamples('<name>')) {
  test(row.id, () => { /* ... */ });
}
```

The loader finds the repo root by walking up from its own directory to the first `.git`, or,
without one, to the first directory holding `docs/knowledgebase/algorithms/`; it is independent
of the runner's working directory. The hook test reaches outside `hook/`, which is fine because
`hook/` tests never ship with the plugin.

## Review process

1. The author writes the doc and the test, runs the real code on every row and fixes whichever
   side is wrong.
2. A **separate** AI review: a fresh sub-agent that did not write the doc runs
   `scripts/algo-docs/review-prompt.md` against the doc. It recomputes every row from `input`
   and the rules without looking at `expected`, checks doc against code, mutations and
   boundaries, and returns a verdict.
3. On `reviewed`, the front-matter becomes `reviewed: <date>` / `reviewer: ai`, and the doc goes on
   the owner's sign-off list. The owner reads only Purpose, Rules and the examples table; after
   sign-off the front-matter becomes `reviewer: ai+owner`.
4. On `needs-changes`, fix the doc or the code and re-run the review.

No automation beyond the loader: no hashes, no generated summaries, no release gate.
