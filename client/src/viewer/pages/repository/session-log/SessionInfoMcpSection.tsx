import { CollapsibleSection, InfoRow } from './session-info-primitives';
import { groupMcpCallsByServer } from './session-info-derive';

interface Props {
  mcpCalls: Record<string, number> | undefined;
}

/**
 * Session Info tab — "MCP Usage" collapsible section: groups `mcpCalls`
 * (flat `mcp__server__tool` call counts) by server, showing per-tool
 * breakdown and a grand total. Renders nothing when there are no MCP calls.
 * Extracted from `SessionInfoTab.tsx` to keep that file under the project's
 * component-size guidance; grouping logic lives in `session-info-derive.ts`
 * so it can be reused by the session export runner.
 */
export function SessionInfoMcpSection({ mcpCalls }: Props) {
  const servers = groupMcpCallsByServer(mcpCalls);
  if (servers.length === 0) return null;

  const grandTotal = servers.reduce((s, r) => s + r.total, 0);

  return (
    <CollapsibleSection title="MCP Usage">
      {servers.map(({ server, total, tools }) => (
        <div key={server}>
          <InfoRow label={server}>{total} calls</InfoRow>
          <div className="pl-4 text-xs mb-1">
            {tools.map(([tool, count]) => (
              <div key={tool} className="flex justify-between">
                <span className="text-muted-foreground font-mono">{tool}</span>
                <span className="font-mono ml-2">{count}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <InfoRow label="Total MCP calls">{grandTotal}</InfoRow>
    </CollapsibleSection>
  );
}
