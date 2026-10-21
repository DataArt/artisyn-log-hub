import { BYTES_PER_TOKEN } from '../../log-parser';
import type { ParsedSession, PromptTurn, SessionSummary } from '../../types';

export interface ContextSlice {
  key: string;
  label: string;
  bytes: number;
  tokens: number;
  subRows?: { label: string; bytes: number; tokens: number }[];
}

/**
 * Hover descriptions for context-usage categories, used by the Context Usage
 * table.
 */
export const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  system:
    'Fixed overhead in every Claude Code session: CLAUDE.md files, rules, MCP tool schemas, skill definitions, and built-in tool schemas.',
  files:
    'Contents of source files read into the conversation context via Read, Edit, Glob, or Grep tools.',
  'tool-results':
    'Output returned by tool calls (Bash commands, file reads, search results, etc.).',
  vision:
    "Images attached to prompts. Token count sourced from API usage data when available; otherwise estimated as image bytes ÷ the model's chars-per-token ratio (falls back to 3.5 when unknown).",
  'prompt-text':
    'The literal text of your prompt messages (user input only, excluding file contents and tool results).',
  'conversation-history':
    "Prior turns' assistant responses re-sent verbatim with each API call. Estimated from output token counts of preceding turns.",
  other:
    'Unattributed residual context (Claude Code built-in system prompt, native tool schemas like Read/Edit/Bash).',
};

// ---------------------------------------------------------------------------
// Turn-level accumulation helpers
// ---------------------------------------------------------------------------

interface TurnAccumulator {
  fileCategoryBytes: Map<string, number>;
  fileCategoryTokens: Map<string, number>;
  toolResultBytes: Map<string, number>;
  toolResultTokens: Map<string, number>;
  visionBytes: number;
  visionTokens: number;
  skillsBytes: number;
  skillsTokens: number;
  rulesBytes: number;
  rulesTokens: number;
  promptTextBytes: number;
  promptTextTokens: number;
}

function accumulateTurns(
  turns: PromptTurn[],
  charsPerToken: number,
): TurnAccumulator {
  const fileCategoryBytes = new Map<string, number>();
  const fileCategoryTokens = new Map<string, number>();
  const toolResultBytes = new Map<string, number>();
  const toolResultTokens = new Map<string, number>();
  let visionBytes = 0;
  let visionTokens = 0;
  let skillsBytes = 0;
  let skillsTokens = 0;
  let rulesBytes = 0;
  let rulesTokens = 0;
  let promptTextBytes = 0;
  let promptTextTokens = 0;

  for (const turn of turns) {
    for (const file of turn.files) {
      const cat = file.category;
      const b = file.bytes ?? 0;
      const t = file.estTokens ?? 0;
      fileCategoryBytes.set(cat, (fileCategoryBytes.get(cat) ?? 0) + b);
      fileCategoryTokens.set(cat, (fileCategoryTokens.get(cat) ?? 0) + t);
    }

    for (const tc of turn.toolCalls) {
      const b = tc.result?.length ?? 0;
      const t = Math.round(b / charsPerToken);
      toolResultBytes.set(tc.name, (toolResultBytes.get(tc.name) ?? 0) + b);
      toolResultTokens.set(tc.name, (toolResultTokens.get(tc.name) ?? 0) + t);
    }

    for (const img of turn.images) {
      visionBytes += img.bytes;
      visionTokens +=
        img.estInputTokens ?? Math.round(img.bytes / charsPerToken);
    }

    for (const skill of turn.skills) {
      skillsBytes += skill.bytes ?? 0;
      skillsTokens += skill.estTokens ?? 0;
    }

    for (const rule of turn.rulesInjected) {
      rulesBytes += rule.bytes ?? 0;
      rulesTokens += rule.estTokens ?? 0;
    }

    const content = turn.userEvent.message?.content;
    if (content && Array.isArray(content)) {
      const textBlock = content.find((b) => b.type === 'text');
      if (textBlock?.text) {
        const bytes = textBlock.text.length;
        promptTextBytes += bytes;
        promptTextTokens += Math.round(bytes / charsPerToken);
      }
    } else if (typeof content === 'string' && content.length > 0) {
      promptTextBytes += content.length;
      promptTextTokens += Math.round(content.length / charsPerToken);
    }
  }

  return {
    fileCategoryBytes,
    fileCategoryTokens,
    toolResultBytes,
    toolResultTokens,
    visionBytes,
    visionTokens,
    skillsBytes,
    skillsTokens,
    rulesBytes,
    rulesTokens,
    promptTextBytes,
    promptTextTokens,
  };
}

// ---------------------------------------------------------------------------
// Build non-system slices from accumulator
// ---------------------------------------------------------------------------

function buildNonSystemSlices(acc: TurnAccumulator): ContextSlice[] {
  const slices: ContextSlice[] = [];

  // Files — one top-level slice with per-category sub-rows
  const totalFilesBytes = Array.from(acc.fileCategoryBytes.values()).reduce(
    (s, v) => s + v,
    0,
  );
  const totalFilesTokens = Array.from(acc.fileCategoryTokens.values()).reduce(
    (s, v) => s + v,
    0,
  );
  if (totalFilesBytes > 0) {
    const subRows = Array.from(acc.fileCategoryBytes.entries())
      .map(([cat, bytes]) => ({
        label: cat,
        bytes,
        tokens: acc.fileCategoryTokens.get(cat) ?? 0,
      }))
      .sort((a, b) => b.bytes - a.bytes);
    slices.push({
      key: 'files',
      label: 'Files',
      bytes: totalFilesBytes,
      tokens: totalFilesTokens,
      subRows,
    });
  }

  // Tool results
  const totalToolResultBytes = Array.from(acc.toolResultBytes.values()).reduce(
    (s, v) => s + v,
    0,
  );
  const totalToolResultTokens = Array.from(
    acc.toolResultTokens.values(),
  ).reduce((s, v) => s + v, 0);
  if (totalToolResultBytes > 0) {
    slices.push({
      key: 'tool-results',
      label: 'Tool Results',
      bytes: totalToolResultBytes,
      tokens: totalToolResultTokens,
      subRows: Array.from(acc.toolResultBytes.entries()).map(
        ([name, bytes]) => ({
          label: name,
          bytes,
          tokens: acc.toolResultTokens.get(name) ?? 0,
        }),
      ),
    });
  }

  // Vision
  if (acc.visionBytes > 0) {
    slices.push({
      key: 'vision',
      label: 'Vision / Images',
      bytes: acc.visionBytes,
      tokens: acc.visionTokens,
    });
  }

  // Prompt text
  if (acc.promptTextBytes > 0) {
    slices.push({
      key: 'prompt-text',
      label: 'Prompt Text',
      bytes: acc.promptTextBytes,
      tokens: acc.promptTextTokens,
    });
  }

  return slices;
}

// ---------------------------------------------------------------------------
// System slice builder for a full session
// ---------------------------------------------------------------------------

function buildSessionSystemSlice(
  summary: SessionSummary,
  acc: TurnAccumulator,
  charsPerToken: number,
): ContextSlice | null {
  // On-demand files are already counted per turn via `rulesInjected` (acc.rulesBytes).
  const files = (summary.claudeMd?.files ?? []).filter((f) => !f.onDemand);

  // System Files = claude-md + local-md + user-md roles
  const systemFilesBytes = files
    .filter(
      (f) =>
        f.role === 'claude-md' || f.role === 'local-md' || f.role === 'user-md',
    )
    .reduce((sum, f) => sum + f.bytes, 0);
  const systemFilesTokens = Math.round(systemFilesBytes / charsPerToken);

  // Rules = rule-role files + injected rules from turns
  const ruleFilesBytes = files
    .filter((f) => f.role === 'rule')
    .reduce((sum, f) => sum + f.bytes, 0);
  const rulesBytes = ruleFilesBytes + acc.rulesBytes;
  const rulesTokens =
    Math.round(ruleFilesBytes / charsPerToken) + acc.rulesTokens;

  // MCP Definitions
  const mcpCount = summary.deferredTools.length;
  const mcpTokens = mcpCount * 150;
  const mcpBytes = mcpTokens * charsPerToken;

  // Sub-rows (skip zero-byte entries)
  const subRows: { label: string; bytes: number; tokens: number }[] = [];

  if (systemFilesBytes > 0) {
    subRows.push({
      label: 'System Files',
      bytes: systemFilesBytes,
      tokens: systemFilesTokens,
    });
  }
  if (mcpBytes > 0) {
    subRows.push({
      label: 'MCP Definitions',
      bytes: mcpBytes,
      tokens: mcpTokens,
    });
  }
  if (acc.skillsBytes > 0) {
    subRows.push({
      label: 'Skills',
      bytes: acc.skillsBytes,
      tokens: acc.skillsTokens,
    });
  }
  if (rulesBytes > 0) {
    subRows.push({
      label: 'Rules',
      bytes: rulesBytes,
      tokens: rulesTokens,
    });
  }

  // Built-in Tools (est.) is added later after other slices are computed
  // For now compute the known total (excluding built-in)
  const knownBytes = systemFilesBytes + mcpBytes + acc.skillsBytes + rulesBytes;
  const knownTokens =
    systemFilesTokens + mcpTokens + acc.skillsTokens + rulesTokens;

  if (knownBytes === 0 && subRows.length === 0) return null;

  return {
    key: 'system',
    label: 'System',
    bytes: knownBytes,
    tokens: knownTokens,
    subRows,
  };
}

// ---------------------------------------------------------------------------
// System slice builder for a single turn
// ---------------------------------------------------------------------------

function buildTurnSystemSlice(acc: TurnAccumulator): ContextSlice | null {
  if (acc.skillsBytes === 0 && acc.rulesBytes === 0) return null;

  const subRows: { label: string; bytes: number; tokens: number }[] = [];
  if (acc.skillsBytes > 0) {
    subRows.push({
      label: 'Skills',
      bytes: acc.skillsBytes,
      tokens: acc.skillsTokens,
    });
  }
  if (acc.rulesBytes > 0) {
    subRows.push({
      label: 'Rules',
      bytes: acc.rulesBytes,
      tokens: acc.rulesTokens,
    });
  }

  return {
    key: 'system',
    label: 'System',
    bytes: acc.skillsBytes + acc.rulesBytes,
    tokens: acc.skillsTokens + acc.rulesTokens,
    subRows,
  };
}

// ---------------------------------------------------------------------------
// Conversation history slice
// ---------------------------------------------------------------------------

function conversationHistorySlice(
  turns: PromptTurn[],
  charsPerToken: number,
): ContextSlice | null {
  const priorOutputTokens = turns
    .slice(0, -1)
    .reduce((sum, t) => sum + (t.tokenBreakdown?.output ?? 0), 0);
  if (priorOutputTokens <= 0) return null;
  const bytes = Math.round(priorOutputTokens * charsPerToken);
  return {
    key: 'conversation-history',
    label: 'Conversation History',
    bytes,
    tokens: priorOutputTokens,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build context slices for the entire session (all turns combined).
 */
export function buildSessionSlices(
  session: ParsedSession,
  charsPerToken: number = BYTES_PER_TOKEN,
): ContextSlice[] {
  const { summary, turns } = session;

  const acc = accumulateTurns(turns, charsPerToken);
  const systemSlice = buildSessionSystemSlice(summary, acc, charsPerToken);
  const nonSystemSlices = buildNonSystemSlices(acc);
  const convHistory = conversationHistorySlice(turns, charsPerToken);

  // Assemble all slices except built-in tools residual
  const allSlices: ContextSlice[] = [
    ...(systemSlice !== null ? [systemSlice] : []),
    ...(convHistory !== null ? [convHistory] : []),
    ...nonSystemSlices,
  ];

  // Compute Built-in Tools (est.) as residual
  const maxCtx =
    turns.length > 0 ? Math.max(...turns.map((t) => t.contextTokens ?? 0)) : 0;
  const contextTokens = maxCtx > 0 ? maxCtx : null;

  if (contextTokens !== null) {
    const accountedTokens = allSlices.reduce((sum, s) => sum + s.tokens, 0);
    const builtInTokens = Math.max(0, contextTokens - accountedTokens);

    if (builtInTokens > 0 && systemSlice !== null) {
      const builtInBytes = Math.round(builtInTokens * charsPerToken);

      // Add sub-row to system slice
      systemSlice.subRows = [
        ...(systemSlice.subRows ?? []),
        {
          label: 'Built-in Tools (est.)',
          bytes: builtInBytes,
          tokens: builtInTokens,
        },
      ];

      // Update system slice totals
      systemSlice.bytes += builtInBytes;
      systemSlice.tokens += builtInTokens;
    }
  }

  return allSlices.filter((s) => s.bytes > 0);
}

/**
 * Build context slices for a single prompt turn (no session-level system overhead).
 * Pass `priorOutputTokens` (sum of output tokens from all prior turns) to
 * include a Conversation History slice.
 */
export function buildTurnSlices(
  turn: PromptTurn,
  priorOutputTokens = 0,
  charsPerToken: number = BYTES_PER_TOKEN,
): ContextSlice[] {
  const acc = accumulateTurns([turn], charsPerToken);
  const systemSlice = buildTurnSystemSlice(acc);
  const nonSystemSlices = buildNonSystemSlices(acc);

  const slices: ContextSlice[] = [
    ...(systemSlice !== null ? [systemSlice] : []),
    ...nonSystemSlices,
  ];

  if (priorOutputTokens > 0) {
    const bytes = Math.round(priorOutputTokens * charsPerToken);
    slices.push({
      key: 'conversation-history',
      label: 'Conversation History',
      bytes,
      tokens: priorOutputTokens,
    });
  }

  return slices.filter((s) => s.bytes > 0);
}
