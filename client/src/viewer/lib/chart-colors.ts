import type { CSSProperties } from 'react';

export const CONTEXT_COLORS: Record<string, string> = {
  system: 'var(--color-ctx-system)',
  'system-claude-md': 'var(--color-ctx-system)',
  'system-local-md': 'var(--color-ctx-system)',
  'system-rules': 'var(--color-ctx-system)',
  'tool-results': 'var(--color-ctx-tool-results)',
  vision: 'var(--color-ctx-vision)',
  skills: 'var(--color-ctx-skills)',
  'rules-injected': 'var(--color-ctx-rules-injected)',
  'mcp-tools': 'var(--color-ctx-mcp-tools)',
  'prompt-text': 'var(--color-ctx-prompt-text)',
  'conversation-history': 'var(--color-ctx-conversation-history)',
  files: 'var(--color-ctx-files)',
  other: 'var(--color-ctx-other)',
};

const DYNAMIC_CHART_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
];

export function contextColorDynamic(key: string): string {
  if (CONTEXT_COLORS[key]) return CONTEXT_COLORS[key];
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash += key.charCodeAt(i);
  }
  return DYNAMIC_CHART_COLORS[hash % 4];
}

export function modelColor(model: string | undefined): string {
  if (!model) return 'var(--chart-4)';
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'var(--chart-1)';
  if (lower.includes('sonnet')) return 'var(--chart-2)';
  if (lower.includes('haiku')) return 'var(--chart-3)';
  return 'var(--chart-4)';
}

export function modelBorderStyle(
  model: string | undefined,
  hasError?: boolean,
  hasRejection?: boolean,
): CSSProperties {
  if (!model || hasError || hasRejection) return {};
  return { borderLeftWidth: 2, borderLeftColor: `hsl(${modelColor(model)})` };
}
