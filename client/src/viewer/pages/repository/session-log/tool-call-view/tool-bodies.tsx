import { useMemo, type ReactNode } from 'react';
import { toRepoRelative } from '@loghub/bash-view';
import { formatBytes, formatCompact } from '../log-parser';
import type { FileAccess, SubAgentNode, ToolCallDetail } from '../types';
import { ToolOutputBlock } from './ToolOutputBlock';
import { useToolView } from './ToolViewContext';

const SECTION_LABEL =
  'text-[10px] font-bold uppercase tracking-wide text-muted-foreground';

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' ? v : undefined;

function InputBlock({ input }: { input: Record<string, unknown> }) {
  const { repoRoot } = useToolView();
  // Relativise each string value before serialising: JSON escapes `\` as `\\`, so a Windows
  // repo root inside the serialised text would no longer match `toRepoRelative`.
  const json = useMemo(
    () =>
      JSON.stringify(
        input,
        (_key, value: unknown) =>
          typeof value === 'string' ? toRepoRelative(value, repoRoot) : value,
        2,
      ),
    [input, repoRoot],
  );
  return (
    <div
      className="rounded border border-border bg-muted/40 p-3 text-xs font-mono"
      data-testid="tool-input-block"
    >
      <div className={`mb-2 ${SECTION_LABEL}`}>Input</div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all text-foreground/80 leading-relaxed">
        {json}
      </pre>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all">{children}</span>
    </>
  );
}

/**
 * File tools (section `'file'`, DD-11): repo-relative Path, Range (`offset`/`limit`), Size from
 * the turn's `FileAccess` of the same call, the input and the output. For Read, a note that file
 * contents are not stored.
 */
export function FileToolBody({
  call,
  charsPerToken,
  turnFiles,
}: {
  call: ToolCallDetail;
  charsPerToken: number;
  turnFiles?: FileAccess[];
}) {
  const { repoRoot } = useToolView();
  const path =
    str(call.input.file_path) ??
    str(call.input.notebook_path) ??
    str(call.input.path) ??
    str(call.input.pattern);
  const offset = num(call.input.offset);
  const limit = num(call.input.limit);
  const file =
    call.id !== undefined
      ? turnFiles?.find((f) => f.toolUseId === call.id)
      : undefined;

  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="file-tool-body">
      <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono">
        {path !== undefined && (
          <Field label="Path">{toRepoRelative(path, repoRoot)}</Field>
        )}
        {(offset !== undefined || limit !== undefined) && (
          <Field label="Range">
            {offset !== undefined ? `from line ${offset}` : 'from the start'}
            {limit !== undefined ? `, ${limit} lines` : ''}
          </Field>
        )}
        {file?.bytes !== undefined && (
          <Field label="Size">
            {formatBytes(file.bytes)}
            {/* The view's own ratio, as the Logs Code row and the output header use — the
                parsed `estTokens` may come from a parse made before pricing loaded. */}
            {` · ≈${formatCompact(Math.round(file.bytes / charsPerToken))} tok`}
          </Field>
        )}
      </div>
      {call.name === 'Read' && (
        <div className="text-[11px] italic text-muted-foreground">
          File content is not stored
        </div>
      )}
      <InputBlock input={call.input} />
      <ToolOutputBlock result={call.result} charsPerToken={charsPerToken} />
    </div>
  );
}

function findByToolUseId(
  nodes: SubAgentNode[] | undefined,
  id: string,
): SubAgentNode | undefined {
  for (const node of nodes ?? []) {
    if (node.toolUseID === id) return node;
    const child = findByToolUseId(node.children, id);
    if (child) return child;
  }
  return undefined;
}

/**
 * The Agent tool (DD-11): description, prompt, "Open sub-agent →" when the session can open one
 * and a sub-agent node was started by this call, then the output.
 */
export function AgentToolBody({
  call,
  charsPerToken,
  subAgents,
}: {
  call: ToolCallDetail;
  charsPerToken: number;
  subAgents?: SubAgentNode[];
}) {
  const { openSubAgent } = useToolView();
  const description = str(call.input.description);
  const prompt = str(call.input.prompt);
  const node =
    call.id !== undefined ? findByToolUseId(subAgents, call.id) : undefined;

  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="agent-tool-body">
      {description !== undefined && (
        <div>
          <div className={SECTION_LABEL}>Description</div>
          <div className="text-sm">{description}</div>
        </div>
      )}
      {prompt !== undefined && (
        <div>
          <div className={SECTION_LABEL}>Prompt</div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/40 p-2 font-mono text-foreground/80 leading-relaxed">
            {prompt}
          </pre>
        </div>
      )}
      {openSubAgent && node && (
        <button
          type="button"
          onClick={() => openSubAgent(node.agentId, description)}
          className="self-start text-xs text-blue-600 underline dark:text-blue-400"
          data-testid="open-sub-agent"
        >
          Open sub-agent →
        </button>
      )}
      <ToolOutputBlock result={call.result} charsPerToken={charsPerToken} />
    </div>
  );
}

/** Any other tool (DD-11): the pretty-printed input, then the output. */
export function GenericToolBody({
  call,
  charsPerToken,
}: {
  call: ToolCallDetail;
  charsPerToken: number;
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="generic-tool-body">
      <InputBlock input={call.input} />
      <ToolOutputBlock result={call.result} charsPerToken={charsPerToken} />
    </div>
  );
}
