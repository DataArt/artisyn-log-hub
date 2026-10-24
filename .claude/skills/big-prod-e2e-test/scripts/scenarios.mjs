// Session matrix S1–S11 plus the legacy-hook session L1. Sessions run sequentially in
// this order; L1 is kept outside SCENARIOS (LEGACY_SCENARIO) and runs after them.
//
// Each entry: { id, title, repo, owner, model, prompt, requires, mcp, permissionArgs, cwdRel, env,
//               useWorktree, rootSettings, expect, verifyChecks }
//   owner          — key in USERS; the repo's owner per REPOS unless the entry sets it (L1)
//   model          — `claude --model` alias
//   prompt         — sent on stdin, a single paragraph. `{{REPO_ROOT}}` is filled at run time by
//                    promptFor() with the session root (the run's repo dir, or the worktree for S11)
//                    in forward-slash form; always quoted, never within the first PROMPT_PREFIX_LEN chars
//   requires       — what an attempt must actually exercise:
//                    { skills?, workflows?, rules?, mcp?: string[], subagent?: number, reads?: string[],
//                      bash?: number, bashError?: true, denied?: string[], background?: true, cwd?: true,
//                      noHarness?: true }
//                    `subagent` / `bash` are minimum counts; `reads` are repo-relative files a `Read`
//                    call must open; `bashError` — a Bash result with is_error; `denied` — tool names
//                    whose call was refused by the permission system; `background` — a background
//                    Agent plus a main-thread tool call after its <task-notification>; `cwd` — the
//                    transcript cwd is `root/cwdRel` (and ARTISYN_PROJECT_ROOT reached the child when
//                    `env` sets it); `noHarness` — no skill, rule, workflow or MCP call and zero subagents.
//   mcp            — MCP server names the session is started with (`--mcp-config`); [] for no MCP.
//   permissionArgs — claude argv replacing the default permission flags; null = the runner's default
//   cwdRel         — session cwd relative to the session root; '' = the root itself
//   env            — extra child env; values may use `{{REPO_ROOT}}` (filled by envFor())
//   useWorktree    — run in the linked worktree of the repo instead of its main checkout (S11)
//   rootSettings   — pass the root's project settings with `--settings` (cwd below the root, S10/S11)
//   expect         — static per-check expected blocks copied into expected.json (bash, sysctx,
//                    agents, bashPaths, denied)
//   verifyChecks   — verifier check ids (see verify.mjs CHECKS); default DEFAULT_VERIFY_CHECKS
import { LEGACY_OWNER, LEGACY_REPO, MCP_SERVER_NAME, REPOS } from './lib/config.mjs';

export const DEFAULT_VERIFY_CHECKS = Object.freeze(['model', 'harness', 'prompt', 'cost']);
export const REPO_ROOT_PLACEHOLDER = '{{REPO_ROOT}}';

// S8: the call the permission system refuses (PoC 2026-10-23: a denied Write carries toolDenialKind).
export const S8_DENIED = Object.freeze({ tool: 'Write', target: 'denied.txt' });

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function scenario(s) {
  const owner = s.owner ?? REPOS[s.repo];
  if (!owner) throw new Error(`scenario ${s.id}: no owner for repo "${s.repo}"`);
  return Object.freeze({
    ...s,
    owner,
    requires: Object.freeze({ ...s.requires }),
    mcp: Object.freeze([...(s.mcp ?? [])]),
    permissionArgs: s.permissionArgs ? Object.freeze([...s.permissionArgs]) : null,
    cwdRel: s.cwdRel ?? '',
    env: Object.freeze({ ...(s.env ?? {}) }),
    useWorktree: s.useWorktree === true,
    rootSettings: s.rootSettings === true,
    expect: deepFreeze(structuredClone(s.expect ?? {})),
    verifyChecks: Object.freeze([...(s.verifyChecks ?? DEFAULT_VERIFY_CHECKS)]),
  });
}

const BASH_PATHS_PROMPT =
  'Without editing any file, run exactly this Bash command: ' +
  `cat "${REPO_ROOT_PLACEHOLDER}/packages/core/src/index.ts", ` +
  'then say how many exported functions it has.';

export const SCENARIOS = Object.freeze([
  scenario({
    id: 'S1',
    title: 'plain edit, no harness',
    repo: 'node-service',
    model: 'sonnet',
    prompt:
      'Add `multiply(a, b)` to `src/calc.js` and a node:test case in `tests/calc.test.js`. ' +
      'Do not use subagents, skills or workflows; do not install packages. ' +
      `Then run exactly this Bash command: cd "${REPO_ROOT_PLACEHOLDER}"; node --test tests/calc.test.js`,
    requires: { bash: 1, noHarness: true },
    verifyChecks: [...DEFAULT_VERIFY_CHECKS, 'bashTab', 'contextGrowth'],
    expect: {
      bash: [{ command: 'node --test tests/calc.test.js', status: 'ok', workDir: '.' }],
    },
  }),
  scenario({
    id: 'S2',
    title: 'project skill via slash command',
    repo: 'node-service',
    model: 'haiku',
    prompt: '/add-jsdoc src/calc.js',
    requires: { skills: ['add-jsdoc'] },
    verifyChecks: [...DEFAULT_VERIFY_CHECKS, 'systemContext'],
    expect: {
      sysctx: { rules: [], skills: [{ name: 'add-jsdoc', source: 'project' }], files: [] },
    },
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
    verifyChecks: [...DEFAULT_VERIFY_CHECKS, 'agentsTable'],
    expect: { agents: { count: 2 } },
  }),
  scenario({
    id: 'S5',
    title: 'path-scoped rule',
    repo: 'js-cli',
    model: 'haiku',
    prompt: 'Read `lib/args.js`, then add a `--verbose` flag to the CLI following the project rules.',
    requires: { rules: ['cli-flags'] },
    verifyChecks: [...DEFAULT_VERIFY_CHECKS, 'systemContext'],
    expect: {
      sysctx: { rules: ['cli-flags'], skills: [], files: [{ name: 'CLAUDE.md', type: 'Project' }] },
    },
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
    // dotnet-api, not node-service: FC depends on this session, so it must not share a repo with
    // other scenarios' failure modes (node-service's ESM package.json once took FC down with S1).
    repo: 'dotnet-api',
    model: 'sonnet',
    prompt:
      'First read `src/Api/Program.cs` and `tests/Api.Tests/HealthTests.cs`. Then use the ' +
      `${MCP_SERVER_NAME} MCP server's query tool to run \`SELECT name, price FROM products ORDER BY id\` ` +
      'and write the rows as a markdown table to `docs/products.md`. Do not use subagents, skills or workflows.',
    requires: { mcp: [MCP_SERVER_NAME], reads: ['src/Api/Program.cs', 'tests/Api.Tests/HealthTests.cs'] },
    mcp: [MCP_SERVER_NAME],
  }),
  scenario({
    id: 'S8',
    title: 'Bash ok/error + denied tool call',
    repo: 'js-cli',
    model: 'haiku',
    prompt:
      'Make exactly these three tool calls in this order and do not retry any of them, whatever the result. ' +
      '1) Run exactly this Bash command: node --version ' +
      '2) Run exactly this Bash command: node -e "process.exit(3)" ' +
      `3) Use the ${S8_DENIED.tool} tool to create the file ${S8_DENIED.target} with the text hi. ` +
      'Then report the result of each call in one line.',
    permissionArgs: ['--permission-mode', 'default', '--allowedTools', '"Read"', '"Bash(node:*)"'],
    requires: { bash: 2, bashError: true, denied: [S8_DENIED.tool] },
    verifyChecks: [...DEFAULT_VERIFY_CHECKS, 'bashTab', 'denied'],
    expect: {
      bash: [
        { command: 'node --version', status: 'ok', workDir: null },
        { command: 'node -e "process.exit(3)"', status: 'error', workDir: null },
      ],
      denied: { tool: S8_DENIED.tool, target: S8_DENIED.target, status: 'rejected' },
    },
  }),
  scenario({
    id: 'S9',
    title: 'background subagent + work time',
    repo: 'ts-webapp',
    model: 'haiku',
    prompt:
      'Use the Agent tool with run_in_background set to true to start one subagent that counts the lines ' +
      'of `packages/core/src/index.ts` and reports the number. While it runs, do nothing else. ' +
      'When you are notified that it finished, write that number to `packages/core/LINES.txt` with the Write tool.',
    requires: { background: true, subagent: 1 },
    verifyChecks: [...DEFAULT_VERIFY_CHECKS, 'workTime'],
  }),
  scenario({
    id: 'S10',
    // Sessions always start at the project root: a subdirectory cwd is out of scope for now (the
    // viewer then shows absolute paths; see task 2026-10-23-subdir-session-abs-paths).
    title: 'absolute repo path in a Bash command shown repo-relative',
    repo: 'ts-webapp',
    model: 'haiku',
    prompt: BASH_PATHS_PROMPT,
    requires: { bash: 1 },
    verifyChecks: [...DEFAULT_VERIFY_CHECKS, 'bashPaths'],
    expect: { bashPaths: { read: 'packages/core/src/index.ts' } },
  }),
  scenario({
    id: 'S11',
    title: 'linked worktree with ARTISYN_PROJECT_ROOT',
    repo: 'ts-webapp',
    model: 'haiku',
    prompt: BASH_PATHS_PROMPT,
    useWorktree: true,
    env: { ARTISYN_PROJECT_ROOT: REPO_ROOT_PLACEHOLDER },
    requires: { bash: 1 },
    verifyChecks: [...DEFAULT_VERIFY_CHECKS, 'bashPaths'],
    expect: { bashPaths: { read: 'packages/core/src/index.ts' } },
  }),
]);

// L1: a session in the repo where the previous-release hook is installed (FR-13).
export const LEGACY_SCENARIO = scenario({
  id: 'L1',
  title: 'previous-release hook',
  repo: LEGACY_REPO,
  owner: LEGACY_OWNER,
  model: 'haiku',
  prompt: 'Read `index.js` and say in one sentence what it prints.',
  requires: { noHarness: true },
  verifyChecks: ['model', 'prompt'],
});

function fillRepoRoot(text, rootAbs) {
  if (typeof text !== 'string' || !text.includes(REPO_ROOT_PLACEHOLDER)) return text;
  if (typeof rootAbs !== 'string' || rootAbs === '') {
    throw new Error(`${REPO_ROOT_PLACEHOLDER} needs a session root, got ${JSON.stringify(rootAbs)}`);
  }
  return text.split(REPO_ROOT_PLACEHOLDER).join(rootAbs.replace(/\\/g, '/'));
}

/** The scenario prompt with every `{{REPO_ROOT}}` replaced by `rootAbs` (forward slashes). */
export function promptFor(scenario, rootAbs) {
  return fillRepoRoot(scenario.prompt, rootAbs);
}

/** The scenario's extra child env with `{{REPO_ROOT}}` filled the same way as promptFor. */
export function envFor(scenario, rootAbs) {
  return Object.fromEntries(Object.entries(scenario.env ?? {}).map(([k, v]) => [k, fillRepoRoot(v, rootAbs)]));
}

export function scenarioById(id) {
  if (id === LEGACY_SCENARIO.id) return LEGACY_SCENARIO;
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario "${id}"`);
  return s;
}
