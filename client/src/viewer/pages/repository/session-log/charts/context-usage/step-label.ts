import type { AssistantStep } from '../../types';

const ABSOLUTE_PATH = /^([A-Za-z]:[\\/]|\/)/;

/** Full one-line detail of a tool call for the step tooltip. */
export function fullToolDetail(
  name: string,
  input: Record<string, unknown>,
): string {
  const s = (v: unknown) => String(v ?? '');
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return s(input.file_path);
    case 'Bash':
      return s(input.command);
    case 'Glob':
    case 'Grep': {
      const parts = [s(input.pattern)];
      if (input.path) {
        const p = s(input.path);
        // Skip absolute paths (local machine root) — only show relative subdirs
        if (!ABSOLUTE_PATH.test(p)) parts.push(`in ${p}`);
      }
      return parts.join(' ');
    }
    case 'Agent':
      return s(input.description ?? input.prompt);
    default:
      return '';
  }
}

/** Label of sub-step `si` of `count`: `final` / `step N`, `Tool: summary`, or `First (+N)`. */
export function stepLabel(
  step: AssistantStep,
  si: number,
  count: number,
): string {
  const names = step.toolCallNames;
  const summaries = step.toolCallSummaries;
  if (names.length === 0) return si === count - 1 ? 'final' : `step ${si + 1}`;
  if (names.length === 1) {
    const summary = summaries[0] ?? '';
    return summary ? `${names[0]}: ${summary}` : names[0];
  }
  const firstSummary = summaries[0] ?? '';
  const firstPart = firstSummary ? `${names[0]}: ${firstSummary}` : names[0];
  const truncFirst =
    firstPart.length > 28 ? firstPart.slice(0, 28) + '…' : firstPart;
  return `${truncFirst} (+${names.length - 1})`;
}
