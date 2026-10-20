import { useMemo } from 'react';
import type { CallTreeNode } from './types';
import { computeActualCost, computeLeafCost } from './cost-utils';
import {
  parseSessionLogs,
  extractSystemPromptBytes,
  buildChildrenByParentMap,
} from '../log-parser';
import type { SessionLogsData } from '../../../../api';
import type { AgentActivation, TelemetryEvent } from '../types';
import type { ModelPricingMap } from '../../../../../models/pricing';
import type { DetailRow } from '../../../../components/DetailTooltip';
import { formatCost, formatLocalTimestamp } from '../../../../lib/format';

/**
 * Builds a `CallTreeNode` for a single agent activation, recursing into its
 * nested/child agents. Children come from two sources merged and deduped by
 * `agentId`:
 *  - transcript-derived: `Agent` tool_use + matching completion found inside
 *    this agent's own re-parsed transcript (`agentParsed.turns[].agentActivations`).
 *  - parent-map-derived: DB-authoritative `childrenByParent` entries (built from
 *    `sessions.parent_session_id`), which catch children whose completion never
 *    made it back into the parent's own transcript (the sub-agent nesting gap).
 *
 * `explicitModel` is only available for depth-1 activations (looked up from the
 * enclosing turn's `subAgents`); recursive calls pass `undefined` and instead
 * fall back to this agent's own parsed transcript model, then to `parentModel`
 * — mirroring `chart-data.ts`'s `resolveAgent()` fallback chain.
 */
function buildAgentNode(
  activation: AgentActivation,
  explicitModel: string | undefined,
  parentModel: string | undefined,
  subagentLogsMap: Map<string, Record<string, unknown>[]>,
  childrenByParent: Map<string, string[]>,
  pricing: ModelPricingMap | undefined,
): CallTreeNode {
  const agentChildren: CallTreeNode[] = [];
  const nestedActivations: AgentActivation[] = [];
  const rawAgentLogs = subagentLogsMap.get(activation.agentId);
  let agentParsed: ReturnType<typeof parseSessionLogs> | null = null;

  if (rawAgentLogs) {
    agentParsed = parseSessionLogs(rawAgentLogs, {
      isSubagent: true,
    });

    let agentUserBytes = 0;
    let agentSkillsTokens = 0;
    let agentSkillsCount = 0;
    let agentRulesTokens = 0;
    let agentRulesCount = 0;
    let agentCodeTokens = 0;
    let agentCodeCount = 0;
    let agentDocsTokens = 0;
    let agentDocsCount = 0;
    let agentVisionTokens = 0;
    let agentVisionCount = 0;
    let agentOutputTokens = 0;
    // Accumulated per TTL, not as one aggregate: the two are billed at different rates
    // so a single leaf could not be priced correctly.
    let agentCacheWrite5mTokens = 0;
    let agentCacheWrite1hTokens = 0;
    let agentCacheReadTokens = 0;

    for (const agentTurn of agentParsed.turns) {
      const agentContent = agentTurn.userEvent.message?.content;
      let agentTurnText = '';
      if (typeof agentContent === 'string') {
        agentTurnText = agentContent;
      } else if (Array.isArray(agentContent)) {
        for (const block of agentContent) {
          if (block.type === 'text' && block.text) {
            agentTurnText = block.text;
            break;
          }
        }
      }
      if (agentTurnText) {
        agentUserBytes += new TextEncoder().encode(agentTurnText).length;
      }
      for (const skill of agentTurn.skills) {
        if (skill.estTokens !== undefined) {
          agentSkillsTokens += skill.estTokens;
          agentSkillsCount++;
        }
      }
      for (const rule of agentTurn.rulesInjected) {
        if (rule.estTokens !== undefined) {
          agentRulesTokens += rule.estTokens;
          agentRulesCount++;
        }
      }
      for (const file of agentTurn.files) {
        if (file.tool === 'Read' && file.estTokens !== undefined) {
          if (file.category === 'code') {
            agentCodeTokens += file.estTokens;
            agentCodeCount++;
          } else {
            // All non-code categories contribute to the "docs" bucket
            agentDocsTokens += file.estTokens;
            agentDocsCount++;
          }
        }
      }
      for (const img of agentTurn.images) {
        if (img.estInputTokens !== undefined) {
          agentVisionTokens += img.estInputTokens;
          agentVisionCount++;
        }
      }
      if (agentTurn.tokenBreakdown) {
        agentOutputTokens += agentTurn.tokenBreakdown.output;
        agentCacheWrite5mTokens += agentTurn.tokenBreakdown.cacheWrite5m;
        agentCacheWrite1hTokens += agentTurn.tokenBreakdown.cacheWrite1h;
        agentCacheReadTokens += agentTurn.tokenBreakdown.cacheRead;
      }
      nestedActivations.push(...agentTurn.agentActivations);
    }

    if (agentUserBytes > 0) {
      agentChildren.push({
        type: 'user-prompt',
        label: 'Prompt: user prompt',
        tokens: Math.round(agentUserBytes / 3.5),
        pricingType: 'input',
        expandable: false,
        tooltipRows: [],
      });
    }
    if (agentSkillsTokens > 0) {
      agentChildren.push({
        type: 'skills-group',
        label: `Skills  ${agentSkillsCount} skills`,
        tokens: agentSkillsTokens,
        pricingType: 'input',
        expandable: false,
        tooltipRows: [],
      });
    }
    if (agentRulesTokens > 0) {
      agentChildren.push({
        type: 'rules-group',
        label: `Rules  ${agentRulesCount} rules`,
        tokens: agentRulesTokens,
        pricingType: 'input',
        expandable: false,
        tooltipRows: [],
      });
    }
    if (agentCodeTokens > 0) {
      agentChildren.push({
        type: 'code-group',
        label: `Code  ${agentCodeCount} files`,
        tokens: agentCodeTokens,
        pricingType: 'input',
        expandable: false,
        tooltipRows: [],
      });
    }
    if (agentDocsTokens > 0) {
      agentChildren.push({
        type: 'docs-group',
        label: `Docs  ${agentDocsCount} files`,
        tokens: agentDocsTokens,
        pricingType: 'input',
        expandable: false,
        tooltipRows: [],
      });
    }
    if (agentVisionTokens > 0) {
      agentChildren.push({
        type: 'vision-group',
        label: `Vision  ${agentVisionCount} image${agentVisionCount === 1 ? '' : 's'}`,
        tokens: agentVisionTokens,
        pricingType: 'input',
        expandable: false,
        tooltipRows: [],
      });
    }
    if (agentOutputTokens > 0) {
      agentChildren.push({
        type: 'output',
        label: 'Output: output',
        tokens: agentOutputTokens,
        pricingType: 'output',
        expandable: false,
        tooltipRows: [],
      });
    }
    if (agentCacheWrite5mTokens > 0) {
      agentChildren.push({
        type: 'cache-write',
        label: 'Cache: write (5m)',
        tokens: agentCacheWrite5mTokens,
        pricingType: 'cache-write-5m',
        expandable: false,
        tooltipRows: [],
      });
    }
    if (agentCacheWrite1hTokens > 0) {
      agentChildren.push({
        type: 'cache-write',
        label: 'Cache: write (1h)',
        tokens: agentCacheWrite1hTokens,
        pricingType: 'cache-write-1h',
        expandable: false,
        tooltipRows: [],
      });
    }
    if (agentCacheReadTokens > 0) {
      agentChildren.push({
        type: 'cache-read',
        label: 'Cache: read',
        tokens: agentCacheReadTokens,
        pricingType: 'cache-read',
        expandable: false,
        tooltipRows: [],
      });
    }
  }

  const agentModel = explicitModel ?? agentParsed?.summary.model ?? parentModel;

  // Merge parent-map-derived children into the transcript-derived ones, deduped
  // by agentId — this is the actual nesting fix: children whose completion never
  // landed in this agent's own transcript are still discovered and recursed into.
  const childIds = childrenByParent.get(activation.agentId) ?? [];
  const seenChildIds = new Set(nestedActivations.map((a) => a.agentId));
  const mergedNested: AgentActivation[] = [...nestedActivations];
  for (const childId of childIds) {
    if (seenChildIds.has(childId)) continue;
    seenChildIds.add(childId);
    mergedNested.push({ agentId: childId, prompt: '' });
  }

  for (const nested of mergedNested) {
    agentChildren.push(
      buildAgentNode(
        nested,
        undefined,
        agentModel,
        subagentLogsMap,
        childrenByParent,
        pricing,
      ),
    );
  }

  return {
    type: 'sub-agent',
    label: `Agent: ${activation.description ?? activation.agentId.slice(0, 20)}`,
    tokens: activation.totalTokens ?? null,
    model: agentModel,
    // Use the completion-event breakdown (same source as session total) to avoid over-counting.
    actualCost: computeActualCost(
      activation.tokens ?? null,
      agentModel,
      pricing,
    ),
    expandable: true,
    children: agentChildren,
    tooltipRows: [
      { label: 'Agent ID', value: activation.agentId },
      { label: 'Prompt', value: activation.prompt.slice(0, 120) },
      {
        label: 'Total tokens',
        value:
          activation.totalTokens != null ? String(activation.totalTokens) : '—',
      },
      {
        label: 'Duration',
        value:
          activation.durationMs != null ? `${activation.durationMs} ms` : '—',
      },
    ],
  };
}

export function useCallTreeNodes(
  parsed: ReturnType<typeof parseSessionLogs> | null,
  logsData: SessionLogsData | undefined,
  subagentLogsMap: Map<string, Record<string, unknown>[]>,
  pricing: ModelPricingMap | undefined,
  agentParentMap?: Map<string, string | null>,
): CallTreeNode[] {
  return useMemo((): CallTreeNode[] => {
    if (!parsed) return [];

    const childrenByParent = agentParentMap
      ? buildChildrenByParentMap(agentParentMap)
      : new Map<string, string[]>();

    const nodes: CallTreeNode[] = [];

    // -------------------------------------------------------------------------
    // 1. System Context group
    // -------------------------------------------------------------------------
    const systemPromptBytes = extractSystemPromptBytes(
      (logsData?.main as unknown as TelemetryEvent[]) ?? [],
    );

    const systemChildren: CallTreeNode[] = [];

    if (systemPromptBytes !== undefined) {
      const tokens = Math.round(systemPromptBytes / 3.5);
      systemChildren.push({
        type: 'claude-md',
        label: 'System: system prompt',
        tokens,
        pricingType: 'input',
        expandable: false,
        tooltipRows: [{ label: 'Est. tokens', value: `~${tokens}` }],
      });
    }

    for (const file of parsed.summary.claudeMd?.files ?? []) {
      const tokens = Math.round(file.bytes / 3.5);
      systemChildren.push({
        type: 'claude-md',
        label: `CLAUDE.md: ${file.path}`,
        tokens,
        pricingType: 'input',
        expandable: false,
        tooltipRows: [
          { label: 'Path', value: file.path },
          { label: 'Size', value: `${file.bytes} B` },
          { label: 'Est. tokens', value: `~${tokens}` },
        ],
      });
    }

    if (systemChildren.length > 0) {
      const systemTokens = systemChildren.reduce(
        (sum, c) => sum + (c.tokens ?? 0),
        0,
      );
      nodes.push({
        type: 'system-context',
        label: 'System Context',
        tokens: systemTokens,
        expandable: true,
        children: systemChildren,
        tooltipRows: [
          { label: 'Est. tokens', value: `~${systemTokens}` },
          { label: 'Files', value: String(systemChildren.length) },
        ],
      });
    }

    // -------------------------------------------------------------------------
    // 2. Prompt turn rows — numbered 1-based sequentially
    // -------------------------------------------------------------------------
    for (let turnIdx = 0; turnIdx < parsed.turns.length; turnIdx++) {
      const turn = parsed.turns[turnIdx];
      const promptNumber = turnIdx + 1;
      const turnChildren: CallTreeNode[] = [];

      // a) User prompt leaf
      const content = turn.userEvent.message?.content;
      let userText = '';
      if (typeof content === 'string') {
        userText = content;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            userText = block.text;
            break;
          }
        }
      }
      if (userText) {
        const userBytes = new TextEncoder().encode(userText).length;
        if (userBytes > 0) {
          const userTokens = Math.round(userBytes / 3.5);
          turnChildren.push({
            type: 'user-prompt',
            label: 'Prompt: user prompt',
            tokens: userTokens,
            pricingType: 'input',
            expandable: false,
            tooltipRows: [{ label: 'Est. tokens', value: `~${userTokens}` }],
          });
        }
      }

      // b) Skills group
      const qualifyingSkills = turn.skills.filter(
        (s) => s.estTokens !== undefined,
      );
      if (qualifyingSkills.length > 0) {
        const skillsTokens = qualifyingSkills.reduce(
          (sum, s) => sum + (s.estTokens ?? 0),
          0,
        );
        const skillChildren: CallTreeNode[] = qualifyingSkills.map((skill) => ({
          type: 'skill',
          label: `Skill: ${skill.name}`,
          tokens: skill.estTokens!,
          pricingType: 'input',
          expandable: false,
          tooltipRows: [
            { label: 'Name', value: skill.name },
            { label: 'Path', value: skill.path ?? '' },
            { label: 'Size', value: `${skill.bytes} B` },
            { label: 'Est. tokens', value: String(skill.estTokens) },
          ],
        }));
        turnChildren.push({
          type: 'skills-group',
          label: `Skills  ${qualifyingSkills.length} skills`,
          tokens: skillsTokens,
          expandable: true,
          children: skillChildren,
          tooltipRows: [
            { label: 'Skills', value: String(qualifyingSkills.length) },
            { label: 'Est. tokens', value: `~${skillsTokens}` },
          ],
        });
      }

      // c) Rules group
      const qualifyingRules = turn.rulesInjected.filter(
        (r) => r.estTokens !== undefined,
      );
      if (qualifyingRules.length > 0) {
        const rulesTokens = qualifyingRules.reduce(
          (sum, r) => sum + (r.estTokens ?? 0),
          0,
        );
        const ruleLabel =
          qualifyingRules.length === 1
            ? `Rules  ${qualifyingRules[0].name}`
            : `Rules  ${qualifyingRules.length} rules`;
        const ruleChildren: CallTreeNode[] = qualifyingRules.map((rule) => ({
          type: 'rule',
          label: `Rule: ${rule.name}`,
          tokens: rule.estTokens!,
          pricingType: 'input',
          expandable: false,
          tooltipRows: [
            { label: 'Name', value: rule.name },
            { label: 'Path', value: rule.path ?? '' },
            { label: 'Size', value: `${rule.bytes} B` },
            { label: 'Est. tokens', value: String(rule.estTokens) },
          ],
        }));
        turnChildren.push({
          type: 'rules-group',
          label: ruleLabel,
          tokens: rulesTokens,
          expandable: true,
          children: ruleChildren,
          tooltipRows: [
            { label: 'Rules', value: String(qualifyingRules.length) },
            { label: 'Est. tokens', value: `~${rulesTokens}` },
          ],
        });
      }

      // d) Code group
      const qualifyingCodeFiles = turn.files.filter(
        (f) =>
          f.category === 'code' &&
          f.tool === 'Read' &&
          f.estTokens !== undefined,
      );
      if (qualifyingCodeFiles.length > 0) {
        const codeTokens = qualifyingCodeFiles.reduce(
          (sum, f) => sum + (f.estTokens ?? 0),
          0,
        );
        const codeFileChildren: CallTreeNode[] = qualifyingCodeFiles.map(
          (file) => ({
            type: 'file',
            label: `File: ${file.path}`,
            tokens: file.estTokens!,
            pricingType: 'input',
            expandable: false,
            tooltipRows: [
              { label: 'Path', value: file.path },
              { label: 'Tool', value: 'Read' },
              { label: 'Size', value: `${file.bytes} B` },
              { label: 'Est. tokens', value: String(file.estTokens) },
            ],
          }),
        );
        turnChildren.push({
          type: 'code-group',
          label: `Code  ${qualifyingCodeFiles.length} files`,
          tokens: codeTokens,
          expandable: true,
          children: codeFileChildren,
          tooltipRows: [
            { label: 'Files', value: String(qualifyingCodeFiles.length) },
            { label: 'Est. tokens', value: `~${codeTokens}` },
          ],
        });
      }

      // e) Non-code files group ("other" bucket: any category that is not 'code')
      const qualifyingDocFiles = turn.files.filter(
        (f) =>
          f.category !== 'code' &&
          f.tool === 'Read' &&
          f.estTokens !== undefined,
      );
      if (qualifyingDocFiles.length > 0) {
        const docsTokens = qualifyingDocFiles.reduce(
          (sum, f) => sum + (f.estTokens ?? 0),
          0,
        );
        const docFileChildren: CallTreeNode[] = qualifyingDocFiles.map(
          (file) => ({
            type: 'file',
            label: `File: ${file.path}`,
            tokens: file.estTokens!,
            pricingType: 'input',
            expandable: false,
            tooltipRows: [
              { label: 'Path', value: file.path },
              { label: 'Tool', value: 'Read' },
              { label: 'Size', value: `${file.bytes} B` },
              { label: 'Est. tokens', value: String(file.estTokens) },
            ],
          }),
        );
        turnChildren.push({
          type: 'docs-group',
          label: `Docs  ${qualifyingDocFiles.length} files`,
          tokens: docsTokens,
          expandable: true,
          children: docFileChildren,
          tooltipRows: [
            { label: 'Files', value: String(qualifyingDocFiles.length) },
            { label: 'Est. tokens', value: `~${docsTokens}` },
          ],
        });
      }

      // f) Vision group
      const qualifyingImages = turn.images.filter(
        (img) => img.estInputTokens !== undefined,
      );
      if (qualifyingImages.length > 0) {
        const visionTokens = qualifyingImages.reduce(
          (sum, img) => sum + (img.estInputTokens ?? 0),
          0,
        );
        const imageChildren: CallTreeNode[] = qualifyingImages.map((img) => {
          const shortName = img.toolName.split('__').pop() ?? img.toolName;
          const tooltipRows = [
            { label: 'Tool', value: img.toolName },
            { label: 'Media type', value: img.mediaType },
            { label: 'Size', value: `${img.bytes} B` },
          ];
          if (img.width && img.height) {
            tooltipRows.push({
              label: 'Dimensions',
              value: `${img.width}×${img.height}`,
            });
          }
          tooltipRows.push({
            label: 'Est. tokens',
            value: String(img.estInputTokens),
          });
          return {
            type: 'image' as const,
            label: `Image: ${shortName}`,
            tokens: img.estInputTokens!,
            pricingType: 'input' as const,
            expandable: false,
            tooltipRows,
          };
        });
        turnChildren.push({
          type: 'vision-group',
          label: `Vision  ${qualifyingImages.length} image${qualifyingImages.length === 1 ? '' : 's'}`,
          tokens: visionTokens,
          expandable: true,
          children: imageChildren,
          tooltipRows: [
            { label: 'Images', value: String(qualifyingImages.length) },
            { label: 'Est. tokens', value: `~${visionTokens}` },
          ],
        });
      }

      // g) Agent rows
      for (const activation of turn.agentActivations) {
        const agentModel = turn.subAgents.find(
          (s) => s.agentId === activation.agentId,
        )?.model;

        turnChildren.push(
          buildAgentNode(
            activation,
            agentModel,
            parsed.summary.model,
            subagentLogsMap,
            childrenByParent,
            pricing,
          ),
        );
      }

      // g) Output leaf
      if (turn.tokenBreakdown && turn.tokenBreakdown.output > 0) {
        const outputCost = parsed.summary.model
          ? computeLeafCost(
              turn.tokenBreakdown.output,
              'output',
              parsed.summary.model,
              pricing,
            )
          : null;
        const outputTooltipRows: DetailRow[] = [
          { label: 'Output tokens', value: String(turn.tokenBreakdown.output) },
        ];
        if (outputCost !== null) {
          outputTooltipRows.push({
            label: 'Cost',
            value: formatCost(outputCost),
          });
        }
        turnChildren.push({
          type: 'output',
          label: 'Output: output',
          tokens: turn.tokenBreakdown.output,
          pricingType: 'output',
          expandable: false,
          tooltipRows: outputTooltipRows,
        });
      }

      // h) Cache write leaves — one per TTL, since each TTL is priced differently. The two
      // still sum to `cacheWrite`, so the parent's token total is unchanged.
      if (turn.tokenBreakdown && turn.tokenBreakdown.cacheWrite5m > 0) {
        turnChildren.push({
          type: 'cache-write',
          label: 'Cache: write (5m)',
          tokens: turn.tokenBreakdown.cacheWrite5m,
          pricingType: 'cache-write-5m',
          expandable: false,
          tooltipRows: [],
        });
      }
      if (turn.tokenBreakdown && turn.tokenBreakdown.cacheWrite1h > 0) {
        turnChildren.push({
          type: 'cache-write',
          label: 'Cache: write (1h)',
          tokens: turn.tokenBreakdown.cacheWrite1h,
          pricingType: 'cache-write-1h',
          expandable: false,
          tooltipRows: [],
        });
      }

      // i) Cache read leaf
      if (turn.tokenBreakdown && turn.tokenBreakdown.cacheRead > 0) {
        turnChildren.push({
          type: 'cache-read',
          label: 'Cache: read',
          tokens: turn.tokenBreakdown.cacheRead,
          pricingType: 'cache-read',
          expandable: false,
          tooltipRows: [],
        });
      }

      const promptLabel = `Prompt ${promptNumber}: "${userText.slice(0, 60)}${userText.length > 60 ? '…' : ''}"`;

      let promptTokens: number | undefined;
      if (turn.tokenBreakdown !== null) {
        promptTokens = turnChildren.reduce(
          (sum, c) => sum + (c.tokens ?? 0),
          0,
        );
      }

      const promptTooltipRows: DetailRow[] = [
        { label: 'Turn', value: String(promptNumber) },
      ];
      if (turn.userEvent.timestamp) {
        promptTooltipRows.push({
          label: 'Timestamp',
          value: formatLocalTimestamp(turn.userEvent.timestamp),
        });
      }
      if (turn.workTimeMs !== null) {
        promptTooltipRows.push({
          label: 'Work time',
          value: `${turn.workTimeMs} ms`,
        });
      }
      if (turn.tokenBreakdown) {
        promptTooltipRows.push(
          { label: 'Input', value: String(turn.tokenBreakdown.input) },
          { label: 'Output', value: String(turn.tokenBreakdown.output) },
          { label: 'Cache read', value: String(turn.tokenBreakdown.cacheRead) },
          {
            label: 'Cache write',
            value: String(turn.tokenBreakdown.cacheWrite),
          },
        );
      }

      nodes.push({
        type: 'prompt',
        label: promptLabel,
        tokens: promptTokens,
        actualCost: computeActualCost(
          turn.tokenBreakdown,
          parsed.summary.model,
          pricing,
        ),
        expandable: true,
        children: turnChildren,
        tooltipRows: promptTooltipRows,
      });
    }

    // -------------------------------------------------------------------------
    // 3. Session Total
    // -------------------------------------------------------------------------
    const promptNodes = nodes.filter((n) => n.type === 'prompt');
    const sessionTotalTokens = promptNodes.reduce(
      (sum, n) => sum + (n.tokens ?? 0),
      0,
    );

    nodes.push({
      type: 'session-total',
      label: 'Session Total',
      tokens: sessionTotalTokens,
      actualCost: computeActualCost(
        parsed.summary.tokenBreakdown,
        parsed.summary.model,
        pricing,
      ),
      expandable: false,
      tooltipRows: [
        { label: 'Total tokens', value: String(sessionTotalTokens) },
      ],
    });

    return nodes;
  }, [parsed, logsData, subagentLogsMap, pricing, agentParentMap]);
}
