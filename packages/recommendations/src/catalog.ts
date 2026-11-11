import type { CatalogEntry, DocLink, MatchedItem, StartupFacts, StartupMcpServer } from './types.ts';

/** Bumped whenever an entry is added, removed or changes its meaning. */
export const CATALOG_VERSION = 1;

const DOCS_BASE = 'https://code.claude.com/docs/en/';

/** Claude Code documentation pages the entries link to. */
const DOC = {
  permissions: { label: 'Permissions', url: `${DOCS_BASE}permissions` },
  settings: { label: 'Settings', url: `${DOCS_BASE}settings` },
  mcp: { label: 'MCP', url: `${DOCS_BASE}mcp` },
  envVars: { label: 'Environment variables', url: `${DOCS_BASE}env-vars` },
  memory: { label: 'Memory', url: `${DOCS_BASE}memory` },
  skills: { label: 'Skills', url: `${DOCS_BASE}skills` },
  plugins: { label: 'Plugins', url: `${DOCS_BASE}plugins` },
  subAgents: { label: 'Subagents', url: `${DOCS_BASE}sub-agents` },
} as const satisfies Record<string, DocLink>;

const CLAUDEAI_PREFIX = 'claude_ai_';
const PLUGIN_PREFIX = 'plugin_';
const STUB_SUFFIXES = ['__authenticate', '__complete_authentication'];
const ORG_SKILL_PREFIX = 'anthropic-skills:';
const UNKNOWN_PLUGIN = '(unknown plugin)';

/** A built-in tool is any tool whose name is not an MCP tool name. */
function isBuiltIn(name: string): boolean {
  return !/^mcp__/.test(name);
}

/** Built-in tools whose name is in `names`, in the facts' order. */
function builtInTools(f: StartupFacts, names: readonly string[]): MatchedItem[] | null {
  if (f.tools === null) return null;
  return f.tools
    .filter((t) => isBuiltIn(t.name) && names.includes(t.name))
    .map((t) => ({ name: t.name, bytes: t.bytes }));
}

function denySnippet(items: MatchedItem[]): string {
  return `"permissions": { "deny": [${items.map((i) => JSON.stringify(i.name)).join(', ')}] }`;
}

function isClaudeAi(s: StartupMcpServer): boolean {
  return s.key.startsWith(CLAUDEAI_PREFIX);
}

function isStubName(name: string): boolean {
  return STUB_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** A claude.ai connector that only offers its sign-in stub tools. */
function isStubConnector(s: StartupMcpServer): boolean {
  return isClaudeAi(s) && s.names.length > 0 && s.names.every(isStubName);
}

/** Item of a non-claude.ai server row (#7, #10): names + instructions, or 0 B when it failed. */
function serverItem(s: StartupMcpServer, note?: string): MatchedItem {
  const item: MatchedItem = s.failed
    ? { name: s.label, bytes: 0, status: 'failed' }
    : { name: s.label, bytes: s.namesBytes + s.instrBytes };
  if (note) item.note = note;
  return item;
}

function isOrgSkill(skill: StartupFacts['skills'][number]): boolean {
  return skill.source === 'org-synced' || skill.name.startsWith(ORG_SKILL_PREFIX);
}

const CLAUDEAI_SWITCH = 'ENABLE_CLAUDEAI_MCP_SERVERS=false';

/**
 * Startup context recommendations, in display order. The only file to edit when adding an entry.
 * Ids are `startup.<slug>`, stable and never reused.
 */
export const CATALOG: CatalogEntry[] = [
  // #1
  {
    id: 'startup.rare-builtin-tools',
    title: 'Rarely needed built-in tools',
    controller: 'built-in',
    explanation:
      'Tool schemas Claude Code sends with every request: pages, workflows, wake-ups, feedback, onboarding guides, review findings. Rarely used in a coding session.',
    disable: {
      text: 'Deny the tools you do not use in ~/.claude/settings.json (or the project .claude/settings.json):',
      snippet: denySnippet,
    },
    docs: [DOC.permissions, DOC.settings],
    match: (f) =>
      builtInTools(f, ['Artifact', 'Workflow', 'ScheduleWakeup', 'SendFeedback', 'ShareOnboardingGuide', 'ReportFindings']),
  },
  // #2
  {
    id: 'startup.two-shells',
    title: 'Two shell tools',
    controller: 'built-in',
    explanation: 'Both Bash and PowerShell are offered (usually on Windows); one of them is usually enough.',
    disable: {
      text: 'Deny the unused shell in settings.json:',
      snippet: () => '"permissions": { "deny": ["PowerShell"] }',
    },
    docs: [DOC.permissions],
    match: (f) => {
      const items = builtInTools(f, ['Bash', 'PowerShell']);
      return items && items.length === 2 ? items : null;
    },
  },
  // #3
  {
    id: 'startup.claudeai-connector-stubs',
    title: 'claude.ai connectors, not signed in',
    controller: 'claudeai-account',
    explanation:
      'Connectors of your claude.ai account that are not authorised: each only adds two sign-in stub tools, in every session of every project.',
    disable: {
      text: 'Turn claude.ai connectors off for Claude Code, or remove them in the claude.ai connector settings:',
      snippet: () => CLAUDEAI_SWITCH,
    },
    docs: [DOC.mcp, DOC.envVars],
    note: (items) => (items.length === 1 ? '1 connector' : `${items.length} connectors`),
    match: (f) =>
      f.mcpServers.filter(isStubConnector).map((s) => ({ name: s.label, bytes: s.namesBytes })),
  },
  // #4
  {
    id: 'startup.claudeai-connectors',
    title: 'claude.ai connectors',
    controller: 'claudeai-account',
    explanation:
      'Signed-in connectors of your claude.ai account. Their tool names load in every session of every project, even ones that never use them.',
    disable: {
      text: 'Turn claude.ai connectors off for Claude Code, or disconnect the unused ones in claude.ai:',
      snippet: () => CLAUDEAI_SWITCH,
    },
    docs: [DOC.mcp, DOC.envVars],
    match: (f) =>
      f.mcpServers
        .filter((s) => isClaudeAi(s) && s.names.some((n) => !isStubName(n)))
        .map((s) => ({ name: s.label, bytes: s.namesBytes })),
  },
  // #5
  {
    id: 'startup.claudeai-instructions',
    title: 'claude.ai connector instructions (Claude Docs / Data)',
    controller: 'claudeai-account',
    explanation:
      'claude.ai connectors with their own instruction text in the prompt. Side effect: the model may create a claude.ai doc instead of a repo file.',
    disable: {
      text: 'Same switch as for the connectors, or disconnect Claude Docs / Data in claude.ai:',
      snippet: () => CLAUDEAI_SWITCH,
    },
    docs: [DOC.mcp, DOC.envVars],
    match: (f) =>
      f.mcpServers
        .filter((s) => isClaudeAi(s) && s.instrBytes > 0)
        .map((s) => ({ name: s.label, bytes: s.instrBytes })),
  },
  // #6
  {
    id: 'startup.org-synced-skills',
    title: 'Organisation skills',
    controller: 'org',
    explanation:
      'Skills your claude.ai organisation pushes to every member. Only their listing lines load at startup.',
    disable: {
      text: 'Managed by your organisation and not removable locally. Ask the claude.ai org admin if most members do not need them.',
    },
    docs: [DOC.skills],
    match: (f) => f.skills.filter(isOrgSkill).map((s) => ({ name: s.name, bytes: s.bytes })),
  },
  // #7
  {
    id: 'startup.user-mcp-servers',
    title: 'User-level MCP servers',
    controller: 'user',
    explanation:
      'Declared in your user profile, so loaded in every project, even ones that never use them.',
    disable: {
      text: "If only one project needs it, move it to that project's .mcp.json and remove the user-level copy:",
      snippet: (items) => items.map((i) => `claude mcp remove ${i.name} -s user`).join('\n'),
    },
    docs: [DOC.mcp],
    match: (f) =>
      f.mcpServers
        .filter((s) => !isClaudeAi(s))
        .flatMap((s) => {
          if (s.configSource === 'user') return [serverItem(s)];
          if (f.snapshot && s.configSource === null && !s.key.startsWith(PLUGIN_PREFIX)) {
            return [serverItem(s, 'user/local scope (~/.claude.json)')];
          }
          return [];
        }),
  },
  // #8
  {
    id: 'startup.auto-memory',
    title: 'Auto-memory',
    controller: 'user',
    explanation:
      'Instructions that let Claude save notes across sessions, plus the memory index it reads at start.',
    disable: {
      text: 'Turn auto-memory off in settings.json:',
      snippet: () => '"autoMemoryEnabled": false',
    },
    docs: [DOC.memory],
    match: (f) => (f.memoryBytes > 0 ? [{ name: 'MEMORY.md', bytes: f.memoryBytes }] : null),
  },
  // #9
  {
    id: 'startup.project-claude-md',
    title: 'Project CLAUDE.md and rules',
    controller: 'project',
    explanation: 'Project instruction files loaded in full at the start of every session in this repository.',
    disable: {
      text: 'Trim them: move rarely needed parts into path-scoped rules or skills, which load only when needed.',
    },
    docs: [DOC.memory, DOC.skills],
    match: (f) =>
      f.instructionFiles
        .filter((file) => file.source === 'project' && file.bytes > 0)
        .map((file) => ({ name: file.path, bytes: file.bytes })),
  },
  // #10
  {
    id: 'startup.project-mcp-servers',
    title: 'Project MCP servers',
    controller: 'project',
    explanation: "Declared in the project's .mcp.json, so loaded in every session of this repository.",
    disable: {
      text: 'Remove unused servers from .mcp.json, or deny their tools with "mcp__<server>__*" in permissions.deny.',
    },
    docs: [DOC.mcp, DOC.permissions],
    match: (f) =>
      f.mcpServers.filter((s) => !isClaudeAi(s) && s.configSource === 'project').map((s) => serverItem(s)),
  },
  // #11
  {
    id: 'startup.failed-mcp-servers',
    title: 'MCP servers that failed to connect',
    controller: 'project',
    explanation: 'Configured MCP servers that did not connect at startup. They add no tools but slow the start and hide a broken setup.',
    disable: {
      text: 'Fix the server or remove it from the MCP config it is declared in.',
    },
    docs: [DOC.mcp],
    match: (f) =>
      f.mcpServers.filter((s) => s.failed).map((s) => ({ name: s.label, bytes: 0, status: 'failed' as const })),
  },
  // #12
  {
    id: 'startup.plugin-skills',
    title: 'Plugin skills',
    controller: 'user',
    explanation: 'Skills of the plugins enabled in your profile. Their listing lines load in every session.',
    disable: {
      text: 'Disable the plugins you do not use in settings.json:',
      snippet: (items) => {
        const ids = items.map((i) => i.name).filter((name) => name !== UNKNOWN_PLUGIN);
        const keys = ids.length > 0 ? ids : ['<plugin>@<marketplace>'];
        return `"enabledPlugins": { ${keys.map((id) => `${JSON.stringify(id)}: false`).join(', ')} }`;
      },
    },
    docs: [DOC.plugins, DOC.settings],
    match: (f) => {
      const groups = new Map<string, number>();
      for (const skill of f.skills) {
        // #6 takes precedence: an organisation skill is never counted here as well.
        if (skill.source !== 'plugin' || isOrgSkill(skill)) continue;
        const id = skill.pluginId ?? UNKNOWN_PLUGIN;
        groups.set(id, (groups.get(id) ?? 0) + skill.bytes);
      }
      return [...groups].map(([name, bytes]) => ({ name, bytes }));
    },
  },
  // #13
  {
    id: 'startup.interaction-tools',
    title: 'Agent and question tools',
    controller: 'built-in',
    explanation:
      'AskUserQuestion asks you multiple-choice questions, Agent starts subagents, ListAgents lists agents to message. Unneeded in unattended or single-agent work.',
    disable: {
      text: 'Deny the ones you do not use in settings.json:',
      snippet: denySnippet,
    },
    docs: [DOC.permissions],
    match: (f) => builtInTools(f, ['AskUserQuestion', 'Agent', 'ListAgents']),
  },
  // #14
  {
    id: 'startup.subagent-types',
    title: 'Subagent types listing',
    controller: 'built-in',
    explanation: 'The list of subagent types the Agent tool can start: built-in ones, plugin agents and .claude/agents/ files.',
    disable: {
      text: 'Remove unused agent files from .claude/agents/ or disable the plugins that bring them; built-in types stay.',
    },
    docs: [DOC.subAgents],
    match: (f) => (f.agentTypes.length > 0 ? f.agentTypes.map((a) => ({ name: a.name, bytes: a.bytes })) : null),
  },
];

// A duplicate id would merge two rows in the UI and break the stable-id contract: fail at import.
{
  const seen = new Set<string>();
  for (const entry of CATALOG) {
    if (seen.has(entry.id)) throw new Error(`Duplicate recommendation id: ${entry.id}`);
    seen.add(entry.id);
  }
}
