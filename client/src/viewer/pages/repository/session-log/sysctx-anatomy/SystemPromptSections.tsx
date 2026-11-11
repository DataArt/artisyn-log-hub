/**
 * The three tab panels of the System prompt modal: prompt parts (grouped by the dynamic boundary
 * when there is one), tool definitions and flags. Each takes its slice of `SystemPromptView`
 * plus the tab's own Set of expanded item keys (`part-<index>`, `tool-<index>`, `flag-<key>`).
 */
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { fmtInt } from './AnatomyCells';
import {
  JsonBlock,
  MarkdownBody,
  PromptItemRow,
  SubLabel,
  type PromptItemSection,
} from './SystemPromptItems';
import {
  MSG_NO_DESCRIPTION,
  MSG_NO_FLAGS,
  MSG_NO_PARTS,
  MSG_NO_TOOLS,
  MSG_UNRECOGNISED,
  type FlagItem,
  type PromptGroup,
  type PromptPartItem,
  type SystemPromptView,
} from './system-prompt-view';

export interface ExpandProps {
  expanded: Set<string>;
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
}

export function toggleKey(
  setExpanded: ExpandProps['setExpanded'],
  key: string,
): void {
  setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
}

export function StatusLine({ text }: { text: string }) {
  return (
    <div
      className="px-1 py-4 text-sm text-muted-foreground"
      data-testid="sysprompt-empty"
    >
      {text}
    </div>
  );
}

export function SectionToolbar({
  summary,
  onExpandAll,
  onCollapseAll,
}: {
  summary: ReactNode;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-3">
      <span
        className="text-xs text-muted-foreground tabular-nums"
        data-testid="sysprompt-toolbar"
      >
        {summary}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={onExpandAll}
        data-testid="sysprompt-expand-all"
      >
        Expand all
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={onCollapseAll}
        data-testid="sysprompt-collapse-all"
      >
        Collapse all
      </Button>
    </div>
  );
}

/** The part the anatomy counts as "Memory index (MEMORY.md)" instead of the system prompt. */
function isMemoryPart(p: PromptPartItem): boolean {
  return p.title === '# Memory';
}

const GROUP_LABEL: Record<PromptGroup, string> = {
  shared: 'Shared',
  session: 'Session-specific',
};

function PartRows({
  parts,
  section,
  expanded,
  setExpanded,
}: { parts: PromptPartItem[]; section: PromptItemSection } & ExpandProps) {
  return (
    <div className="space-y-1.5">
      {parts.map((p) => {
        const key = `part-${p.index}`;
        return (
          <PromptItemRow
            key={key}
            title={p.title}
            meta={`${fmtInt(p.bytes)} B · ≈ ${fmtInt(p.tokens)} tok${isMemoryPart(p) ? ' · Memory index row' : ''}`}
            section={section}
            expandable
            expanded={expanded.has(key)}
            onToggle={() => toggleKey(setExpanded, key)}
          >
            <MarkdownBody text={p.text} />
          </PromptItemRow>
        );
      })}
    </div>
  );
}

export function PromptSection({
  prompt,
  expanded,
  setExpanded,
}: { prompt: SystemPromptView['prompt'] } & ExpandProps) {
  if (prompt.status === 'unrecognised') {
    return <StatusLine text={MSG_UNRECOGNISED} />;
  }
  if (prompt.parts.length === 0) return <StatusLine text={MSG_NO_PARTS} />;
  const keys = prompt.parts.map((p) => `part-${p.index}`);
  // The anatomy shows the `# Memory` part as its own "Memory index" row; say how the two add up.
  const memoryBytes = prompt.parts
    .filter(isMemoryPart)
    .reduce((s, p) => s + p.bytes, 0);
  const split =
    memoryBytes > 0
      ? ` = harness core ${fmtInt(prompt.bytes - memoryBytes)} B + memory index ${fmtInt(memoryBytes)} B`
      : '';
  return (
    <div>
      <SectionToolbar
        summary={`${fmtInt(prompt.parts.length)} parts · ${fmtInt(prompt.bytes)} B · ≈ ${fmtInt(prompt.tokens)} tok${split}`}
        onExpandAll={() => setExpanded(new Set(keys))}
        onCollapseAll={() => setExpanded(new Set())}
      />
      {prompt.grouped ? (
        <div className="space-y-4">
          {(['shared', 'session'] as const).map((group) => {
            const parts = prompt.parts.filter((p) => p.group === group);
            if (parts.length === 0) return null;
            return (
              <div key={group} className="space-y-1.5">
                <div
                  className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                  data-testid="sysprompt-group"
                  data-group={group}
                >
                  {`${GROUP_LABEL[group]} · ${fmtInt(parts.length)} parts`}
                </div>
                <PartRows
                  parts={parts}
                  section={group}
                  expanded={expanded}
                  setExpanded={setExpanded}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <PartRows
          parts={prompt.parts}
          section="ungrouped"
          expanded={expanded}
          setExpanded={setExpanded}
        />
      )}
    </div>
  );
}

export function ToolsSection({
  tools,
  expanded,
  setExpanded,
}: { tools: SystemPromptView['tools'] } & ExpandProps) {
  if (tools.items.length === 0) return <StatusLine text={MSG_NO_TOOLS} />;
  const keys = tools.items.map((t) => `tool-${t.index}`);
  return (
    <div>
      <div
        className="mb-1 text-sm tabular-nums"
        data-testid="sysprompt-tools-summary"
      >
        {`${fmtInt(tools.items.length)} tools · ${fmtInt(tools.bytes)} B · ≈ ${fmtInt(tools.tokens)} tokens — the Tool definitions row of the anatomy tab, ${tools.source === 'wire' ? 'as sent in the first API request' : 'from the prompt snapshot'}`}
      </div>
      <SectionToolbar
        summary={`${fmtInt(tools.items.length)} tools`}
        onExpandAll={() => setExpanded(new Set(keys))}
        onCollapseAll={() => setExpanded(new Set())}
      />
      <div className="space-y-1.5">
        {tools.items.map((t) => {
          const key = `tool-${t.index}`;
          return (
            <PromptItemRow
              key={key}
              title={
                <span className="inline-flex items-center gap-2">
                  <span className="font-mono">{t.name}</span>
                  {t.server !== null && (
                    <Badge variant="outline">{`MCP · ${t.server}`}</Badge>
                  )}
                </span>
              }
              meta={`${fmtInt(t.bytes)} B · ${t.share.toFixed(1)} %`}
              section="tool"
              expandable
              expanded={expanded.has(key)}
              onToggle={() => toggleKey(setExpanded, key)}
            >
              <div className="space-y-3">
                <div>
                  <SubLabel>Description</SubLabel>
                  {t.description !== null ? (
                    <MarkdownBody text={t.description} />
                  ) : (
                    <div
                      className="text-sm italic text-muted-foreground"
                      data-testid="sysprompt-empty"
                    >
                      {MSG_NO_DESCRIPTION}
                    </div>
                  )}
                </div>
                {t.schemaJson !== null && (
                  <div>
                    <SubLabel>Input schema</SubLabel>
                    <JsonBlock json={t.schemaJson} />
                  </div>
                )}
              </div>
            </PromptItemRow>
          );
        })}
      </div>
    </div>
  );
}

export function FlagsSection({
  flags,
  expanded,
  setExpanded,
}: { flags: FlagItem[] } & ExpandProps) {
  if (flags.length === 0) return <StatusLine text={MSG_NO_FLAGS} />;
  // Expand all / Collapse all affect object flags only (DD 13).
  const keys = flags.filter((f) => f.isObject).map((f) => `flag-${f.key}`);
  return (
    <div>
      <SectionToolbar
        summary={`${fmtInt(flags.length)} keys`}
        onExpandAll={() => setExpanded(new Set(keys))}
        onCollapseAll={() => setExpanded(new Set())}
      />
      <div className="space-y-1.5">
        {flags.map((f) => {
          const key = `flag-${f.key}`;
          const title = <span className="font-mono">{f.key}</span>;
          if (!f.isObject) {
            return (
              <PromptItemRow
                key={key}
                title={title}
                meta={
                  <span className="font-mono text-foreground">{f.value}</span>
                }
                section="flag"
                expandable={false}
                expanded={false}
              />
            );
          }
          return (
            <PromptItemRow
              key={key}
              title={title}
              meta={<span className="font-mono">{'{…}'}</span>}
              section="flag"
              expandable
              expanded={expanded.has(key)}
              onToggle={() => toggleKey(setExpanded, key)}
            >
              <JsonBlock json={f.value} />
            </PromptItemRow>
          );
        })}
      </div>
    </div>
  );
}
