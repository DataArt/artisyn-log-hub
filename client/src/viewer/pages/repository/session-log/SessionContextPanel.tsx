import { useState } from 'react';
import { ChevronRight, FileText } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../ui/tabs';
import type {
  ClaudeMdFile,
  McpServerConfig,
  SkillDefinition,
  AgentDefinition,
  SessionSummary,
} from './types';
import { formatBytes, formatCompact, resolveCharsPerToken } from './log-parser';
import { cn } from '../../../lib/cn';
import { McpServerModal } from './McpServerModal';
import { SkillDetailModal } from './SkillDetailModal';
import { AgentDetailModal } from './AgentDetailModal';
import { FileDetailModal } from './FileDetailModal';
import { RuleDetailModal } from './RuleDetailModal';
import { SourceBadge } from './SourceBadge';
import { shortenClaudeMdPath, getRuleShortName } from './context-panel-helpers';
import type { ModelPricingMap } from '../../../../models/pricing';

interface Props {
  summary: SessionSummary;
  mcpCalls?: Record<string, number>;
  pricing?: ModelPricingMap;
}

// ---- MCP helpers ------------------------------------------------------------

interface McpRow {
  server: string;
  toolCount: number;
  estTokens: number;
}

function buildMcpRows(deferredTools: string[]): McpRow[] {
  const counts = new Map<string, number>();
  for (const name of deferredTools) {
    if (!name.startsWith('mcp__')) continue;
    const parts = name.split('__');
    if (parts.length < 3) continue;
    const server = parts[1];
    counts.set(server, (counts.get(server) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([server, toolCount]) => ({
      server,
      toolCount,
      estTokens: toolCount * 150,
    }))
    .sort((a, b) => a.server.localeCompare(b.server));
}

// ---- Main export ------------------------------------------------------------

export function SessionContextPanel({ summary, mcpCalls, pricing }: Props) {
  const charsPerToken = resolveCharsPerToken(pricing, summary.model);
  const [expanded, setExpanded] = useState(false);
  const [selectedFile, setSelectedFile] = useState<ClaudeMdFile | null>(null);
  const [selectedRule, setSelectedRule] = useState<ClaudeMdFile | null>(null);
  const [selectedMcp, setSelectedMcp] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillDefinition | null>(
    null,
  );
  const [selectedAgent, setSelectedAgent] = useState<AgentDefinition | null>(
    null,
  );

  const { deferredTools } = summary;
  const claudeMdFiles = summary.claudeMd?.files ?? [];
  const nonRuleFiles = claudeMdFiles.filter((f) => f.role !== 'rule');
  const ruleFiles = claudeMdFiles.filter((f) => f.role === 'rule');

  const hasFiles = nonRuleFiles.length > 0;
  const hasRules = ruleFiles.length > 0;
  const hasMcpTools = deferredTools.some((t) => t.startsWith('mcp__'));
  const hasMcpConfig = (summary.mcpConfig?.length ?? 0) > 0;
  const hasMcp = hasMcpTools || hasMcpConfig;
  const hasNonMcpTools = deferredTools.some((t) => !t.startsWith('mcp__'));
  const hasAgents = summary.registeredAgents.length > 0;
  const hasSkills = summary.registeredSkills.length > 0;

  if (
    !hasFiles &&
    !hasRules &&
    !hasMcp &&
    !hasNonMcpTools &&
    !hasAgents &&
    !hasSkills
  )
    return null;

  // Chips for the summary line
  const chips: string[] = [];
  if (hasFiles || hasRules) {
    const n = claudeMdFiles.length;
    chips.push(`${n} ${n === 1 ? 'file' : 'files'}`);
  }
  if (hasMcp) {
    const serverCount = new Set([
      ...deferredTools
        .filter((t) => t.startsWith('mcp__'))
        .map((t) => t.split('__')[1]),
      ...(summary.mcpConfig?.map((c) => c.name) ?? []),
    ]).size;
    chips.push(`${serverCount} MCP`);
  }
  if (hasNonMcpTools)
    chips.push(
      `${deferredTools.filter((t) => !t.startsWith('mcp__')).length} tools`,
    );
  if (hasSkills) chips.push(`${summary.registeredSkills.length} skills`);
  if (hasAgents) chips.push(`${summary.registeredAgents.length} agents`);

  const defaultTab = hasFiles
    ? 'files'
    : hasMcp
      ? 'mcp'
      : hasNonMcpTools
        ? 'tools'
        : hasSkills
          ? 'skills'
          : hasAgents
            ? 'agents'
            : 'rules';

  // MCP rows
  const mcpRowsFromTools = buildMcpRows(deferredTools);
  const mcpToolServerNames = new Set(mcpRowsFromTools.map((r) => r.server));
  const allMcpRows: McpRow[] = [
    ...mcpRowsFromTools,
    ...(summary.mcpConfig ?? [])
      .filter((cfg) => !mcpToolServerNames.has(cfg.name))
      .map((cfg) => ({ server: cfg.name, toolCount: 0, estTokens: 0 })),
  ].sort((a, b) => a.server.localeCompare(b.server));
  const totalMcpTools = allMcpRows.reduce((s, r) => s + r.toolCount, 0);

  const getInvCount = (srv: string): number => {
    if (!mcpCalls) return 0;
    const pfx = `mcp__${srv}__`;
    return Object.entries(mcpCalls)
      .filter(([k]) => k.startsWith(pfx))
      .reduce((s, [, v]) => s + v, 0);
  };

  const getToolNames = (srv: string): string[] =>
    deferredTools.filter((t) => t.startsWith(`mcp__${srv}__`));

  const getServerConfig = (srv: string): McpServerConfig =>
    summary.mcpConfig?.find((c) => c.name === srv) ?? {
      name: srv,
      command: '',
      args: '',
    };

  const nonMcpTools = deferredTools.filter((t) => !t.startsWith('mcp__'));
  const filePaths = nonRuleFiles.map((f) => f.path);

  return (
    <div className="border-b border-border bg-violet-500/5 px-4 py-3">
      <div className="flex items-center gap-2">
        <FileText className="size-3.5 shrink-0 text-violet-500" />
        <span className="text-sm font-semibold text-foreground">
          System Context
        </span>
        <span className="text-xs text-muted-foreground">
          {chips.join(' · ')}
        </span>
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-2 flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 transition-transform',
            expanded && 'rotate-90',
          )}
        />
        {expanded ? 'Hide details' : 'Show details'}
      </button>

      {expanded && (
        <div className="mt-3 border-t border-border/50 pt-3">
          <Tabs defaultValue={defaultTab}>
            <TabsList className="h-7 gap-0.5">
              {hasFiles && (
                <TabsTrigger value="files" className="h-6 px-2.5 text-xs">
                  Files
                </TabsTrigger>
              )}
              {hasMcp && (
                <TabsTrigger value="mcp" className="h-6 px-2.5 text-xs">
                  MCP
                </TabsTrigger>
              )}
              {hasNonMcpTools && (
                <TabsTrigger value="tools" className="h-6 px-2.5 text-xs">
                  Tools
                </TabsTrigger>
              )}
              {hasSkills && (
                <TabsTrigger value="skills" className="h-6 px-2.5 text-xs">
                  Skills
                </TabsTrigger>
              )}
              {hasAgents && (
                <TabsTrigger value="agents" className="h-6 px-2.5 text-xs">
                  Agents
                </TabsTrigger>
              )}
              {hasRules && (
                <TabsTrigger value="rules" className="h-6 px-2.5 text-xs">
                  Rules
                </TabsTrigger>
              )}
            </TabsList>

            {/* Files */}
            {hasFiles && (
              <TabsContent value="files" className="mt-2">
                <table className="text-xs">
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="pb-1 pr-3 text-left font-medium text-muted-foreground">
                        Path
                      </th>
                      <th className="pb-1 pr-3 text-left font-medium text-muted-foreground">
                        Type
                      </th>
                      <th className="pb-1 pr-3 text-right font-medium text-muted-foreground">
                        Size
                      </th>
                      <th className="pb-1 text-right font-medium text-muted-foreground">
                        Tokens
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {nonRuleFiles.map((file, i) => {
                      const displayPath = shortenClaudeMdPath(
                        file.path,
                        filePaths,
                      );
                      const estTok = Math.round(file.bytes / charsPerToken);
                      const roleMeta =
                        file.role === 'local-md'
                          ? {
                              label: 'local',
                              cls: 'text-orange-600 dark:text-orange-400',
                            }
                          : {
                              label: 'project',
                              cls: 'text-emerald-600 dark:text-emerald-400',
                            };
                      return (
                        <tr
                          key={i}
                          className="cursor-pointer hover:bg-muted/30"
                          onClick={() => setSelectedFile(file)}
                        >
                          <td className="py-1 pr-3 font-mono text-foreground/80">
                            {displayPath}
                          </td>
                          <td className="py-1 pr-3">
                            <span className={cn('text-xs', roleMeta.cls)}>
                              {roleMeta.label}
                            </span>
                          </td>
                          <td className="py-1 pr-3 whitespace-nowrap text-right font-mono text-muted-foreground">
                            {formatBytes(file.bytes)}
                          </td>
                          <td className="py-1 whitespace-nowrap text-right font-mono text-muted-foreground">
                            ~{formatCompact(estTok)} tok
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TabsContent>
            )}

            {/* MCP */}
            {hasMcp && (
              <TabsContent value="mcp" className="mt-2">
                <table className="text-xs">
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="pb-1 pr-3 text-left font-medium text-muted-foreground">
                        Server
                      </th>
                      <th className="pb-1 pr-3 text-right font-medium text-muted-foreground">
                        Tools
                      </th>
                      <th className="pb-1 pr-3 text-right font-medium text-muted-foreground">
                        Calls
                      </th>
                      <th className="pb-1 text-right font-medium text-muted-foreground">
                        Est. tokens
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {allMcpRows.map((row) => (
                      <tr
                        key={row.server}
                        className="cursor-pointer hover:bg-muted/30"
                        onClick={() => setSelectedMcp(row.server)}
                      >
                        <td className="py-1 pr-3 font-mono text-foreground/80">
                          {row.server}
                        </td>
                        <td className="py-1 pr-3 whitespace-nowrap text-right font-mono text-muted-foreground">
                          {row.toolCount}
                        </td>
                        <td className="py-1 pr-3 whitespace-nowrap text-right font-mono text-muted-foreground">
                          {getInvCount(row.server)}
                        </td>
                        <td className="py-1 whitespace-nowrap text-right font-mono text-muted-foreground">
                          {row.estTokens > 0 ? `~${row.estTokens}` : '—'}
                        </td>
                      </tr>
                    ))}
                    {allMcpRows.length > 1 && (
                      <tr className="border-t border-border/50">
                        <td className="pt-1 font-semibold text-foreground/80">
                          Total
                        </td>
                        <td className="pt-1 whitespace-nowrap text-right font-mono text-muted-foreground">
                          {totalMcpTools}
                        </td>
                        <td />
                        <td />
                      </tr>
                    )}
                  </tbody>
                </table>
              </TabsContent>
            )}

            {/* Tools */}
            {hasNonMcpTools && (
              <TabsContent value="tools" className="mt-2">
                <ul className="space-y-0">
                  {nonMcpTools.map((t) => (
                    <li
                      key={t}
                      className="py-0 text-xs font-mono text-foreground/80"
                    >
                      {t}
                    </li>
                  ))}
                </ul>
              </TabsContent>
            )}

            {/* Skills */}
            {hasSkills && (
              <TabsContent value="skills" className="mt-2">
                <table className="text-xs">
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="pb-1 pr-3 text-left font-medium text-muted-foreground">
                        Name
                      </th>
                      <th className="pb-1 pr-3 text-left font-medium text-muted-foreground">
                        Source
                      </th>
                      <th className="pb-1 text-right font-medium text-muted-foreground">
                        Tokens
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.registeredSkills.map((name) => {
                      const def = summary.skillDefinitions?.get(name);
                      const tokens = def?.bytes
                        ? Math.round(def.bytes / charsPerToken)
                        : null;
                      return (
                        <tr
                          key={name}
                          className={cn(
                            'group',
                            def && 'cursor-pointer hover:bg-muted/30',
                          )}
                          onClick={
                            def ? () => setSelectedSkill(def) : undefined
                          }
                        >
                          <td className="py-1 pr-3 font-mono text-foreground/80 group-hover:text-foreground">
                            {name}
                          </td>
                          <td className="py-1 pr-3">
                            <SourceBadge source={def?.source} />
                          </td>
                          <td className="py-1 whitespace-nowrap text-right font-mono text-muted-foreground">
                            {tokens !== null
                              ? `~${formatCompact(tokens)} tok`
                              : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TabsContent>
            )}

            {/* Agents */}
            {hasAgents && (
              <TabsContent value="agents" className="mt-2">
                <table className="text-xs">
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="pb-1 pr-3 text-left font-medium text-muted-foreground">
                        Name
                      </th>
                      <th className="pb-1 pr-3 text-left font-medium text-muted-foreground">
                        Source
                      </th>
                      <th className="pb-1 pr-3 text-left font-medium text-muted-foreground">
                        Description
                      </th>
                      <th className="pb-1 text-right font-medium text-muted-foreground">
                        Tokens
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.registeredAgents.map((name) => {
                      const def = summary.agentDefinitions?.get(name);
                      const tokens = def?.bytes
                        ? Math.round(def.bytes / charsPerToken)
                        : null;
                      return (
                        <tr
                          key={name}
                          className={cn(
                            'group',
                            def && 'cursor-pointer hover:bg-muted/30',
                          )}
                          onClick={
                            def ? () => setSelectedAgent(def) : undefined
                          }
                        >
                          <td className="py-1 pr-3 font-mono text-foreground/80 group-hover:text-foreground">
                            {name}
                          </td>
                          <td className="py-1 pr-3">
                            <SourceBadge source={def?.source} />
                          </td>
                          <td className="py-1 pr-3 max-w-[180px] truncate text-muted-foreground">
                            {def?.description ?? ''}
                          </td>
                          <td className="py-1 whitespace-nowrap text-right font-mono text-muted-foreground">
                            {tokens !== null
                              ? `~${formatCompact(tokens)} tok`
                              : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TabsContent>
            )}

            {/* Rules */}
            {hasRules && (
              <TabsContent value="rules" className="mt-2">
                <table className="text-xs">
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="pb-1 pr-3 text-left font-medium text-muted-foreground">
                        Name
                      </th>
                      <th className="pb-1 pr-3 text-right font-medium text-muted-foreground">
                        Size
                      </th>
                      <th className="pb-1 text-right font-medium text-muted-foreground">
                        Tokens
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {ruleFiles.map((file, i) => {
                      const name = getRuleShortName(file.path);
                      const estTok = Math.round(file.bytes / charsPerToken);
                      return (
                        <tr
                          key={i}
                          className="cursor-pointer hover:bg-muted/30"
                          onClick={() => setSelectedRule(file)}
                        >
                          <td className="py-1 pr-3 font-mono text-foreground/80">
                            {name}
                          </td>
                          <td className="py-1 pr-3 whitespace-nowrap text-right font-mono text-muted-foreground">
                            {formatBytes(file.bytes)}
                          </td>
                          <td className="py-1 whitespace-nowrap text-right font-mono text-muted-foreground">
                            ~{formatCompact(estTok)} tok
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TabsContent>
            )}
          </Tabs>
        </div>
      )}

      {selectedFile && (
        <FileDetailModal
          file={selectedFile}
          onClose={() => setSelectedFile(null)}
          charsPerToken={charsPerToken}
        />
      )}
      {selectedRule && (
        <RuleDetailModal
          file={selectedRule}
          onClose={() => setSelectedRule(null)}
          charsPerToken={charsPerToken}
        />
      )}
      {selectedMcp && (
        <McpServerModal
          server={getServerConfig(selectedMcp)}
          toolCount={
            allMcpRows.find((r) => r.server === selectedMcp)?.toolCount ?? 0
          }
          estTokens={
            allMcpRows.find((r) => r.server === selectedMcp)?.estTokens ?? 0
          }
          invocationCount={getInvCount(selectedMcp)}
          toolNames={getToolNames(selectedMcp)}
          onClose={() => setSelectedMcp(null)}
        />
      )}
      {selectedSkill && (
        <SkillDetailModal
          skill={selectedSkill}
          onClose={() => setSelectedSkill(null)}
          charsPerToken={charsPerToken}
        />
      )}
      {selectedAgent && (
        <AgentDetailModal
          agent={selectedAgent}
          onClose={() => setSelectedAgent(null)}
          charsPerToken={charsPerToken}
        />
      )}
    </div>
  );
}
