// Session matrix S1–S7. Sessions run sequentially in
// this order.
//
// Each entry: { id, title, repo, owner, model, prompt, requires, mcp }
//   owner    — key in USERS (the repo's owner per REPOS)
//   model    — `claude --model` alias
//   prompt   — sent on stdin, a single paragraph
//   requires — what an attempt must actually exercise:
//              { skills?, workflows?, rules?, mcp?: string[], subagent?: number, reads?: string[] }
//              where `subagent` is a minimum count and `reads` are repo-relative files a `Read`
//              call must open. An EMPTY object means "nothing at all": no skill, rule, workflow or
//              MCP call and zero subagents (S1).
//   mcp      — MCP server names the session is started with (`--mcp-config`); [] for no MCP.
import { MCP_SERVER_NAME, REPOS } from './lib/config.mjs';

function scenario(s) {
  return Object.freeze({
    ...s,
    owner: REPOS[s.repo],
    requires: Object.freeze({ ...s.requires }),
    mcp: Object.freeze([...(s.mcp ?? [])]),
  });
}

export const SCENARIOS = Object.freeze([
  scenario({
    id: 'S1',
    title: 'plain edit, no harness',
    repo: 'node-service',
    model: 'sonnet',
    prompt:
      'Add `multiply(a, b)` to `src/calc.js` and a node:test case in `tests/calc.test.js`. ' +
      'Do not use subagents, skills or workflows; do not install packages.',
    requires: {},
  }),
  scenario({
    id: 'S2',
    title: 'project skill via slash command',
    repo: 'node-service',
    model: 'haiku',
    prompt: '/add-jsdoc src/calc.js',
    requires: { skills: ['add-jsdoc'] },
  }),
  scenario({
    id: 'S3',
    title: 'subagent survey + refactor',
    repo: 'ts-webapp',
    model: 'opus',
    prompt:
      'Use the Agent tool to spawn one subagent that surveys `packages/*` and reports duplicated helpers; ' +
      'then move the duplicate into `packages/core` and update imports.',
    requires: { subagent: 1 },
  }),
  scenario({
    id: 'S4',
    title: 'saved workflow',
    repo: 'java-lib',
    model: 'sonnet',
    prompt:
      'Run the saved workflow `java-refactor` with the Workflow tool, wait for it to finish, ' +
      'then summarize the changes.',
    requires: { workflows: ['java-refactor'] },
  }),
  scenario({
    id: 'S5',
    title: 'path-scoped rule',
    repo: 'js-cli',
    model: 'haiku',
    prompt: 'Read `lib/args.js`, then add a `--verbose` flag to the CLI following the project rules.',
    requires: { rules: ['cli-flags'] },
  }),
  scenario({
    id: 'S6',
    title: 'skill + subagent',
    repo: 'dotnet-api',
    model: 'sonnet',
    prompt:
      '/api-endpoint GET /version returning the assembly version — then use the Agent tool to spawn ' +
      'a subagent that writes the xUnit test in `tests/Api.Tests`.',
    requires: { skills: ['api-endpoint'], subagent: 1 },
  }),
  scenario({
    id: 'S7',
    title: 'MCP query to Postgres + file categories',
    repo: 'node-service',
    model: 'sonnet',
    prompt:
      'First read `src/calc.js` and `tests/calc.test.js`. Then use the ' +
      `${MCP_SERVER_NAME} MCP server's query tool to run \`SELECT name, price FROM products ORDER BY id\` ` +
      'and write the rows as a markdown table to `docs/products.md`. Do not use subagents, skills or workflows.',
    requires: { mcp: [MCP_SERVER_NAME], reads: ['src/calc.js', 'tests/calc.test.js'] },
    mcp: [MCP_SERVER_NAME],
  }),
]);

export function scenarioById(id) {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario "${id}"`);
  return s;
}
