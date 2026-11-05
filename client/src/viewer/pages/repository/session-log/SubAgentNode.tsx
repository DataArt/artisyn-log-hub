import { useState } from 'react';
import type { SubAgentNode as SubAgentNodeType } from './types';
import { formatDuration } from './log-parser';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '../../../ui/collapsible';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/cn';
import type { ModelPricingMap } from '../../../../models/pricing';
import { truncateAgentId } from './prompt-turn-helpers';
import { SubAgentDetail } from './SubAgentDetail';
import { agentDescriptionText, cutAgentLabel } from './workflow-agent-rows';

interface Props {
  agent: SubAgentNodeType;
  depth: number;
  pricing?: ModelPricingMap;
  sessionModel?: string;
}

export function SubAgentNode({ agent, depth, pricing, sessionModel }: Props) {
  const [open, setOpen] = useState(false);
  const desc = agentDescriptionText(agent.agentDescription);

  return (
    <div style={{ paddingLeft: depth * 16 }}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-1.5 py-1 text-left text-xs text-muted-foreground hover:text-foreground">
          <ChevronRight
            className={cn(
              'size-3 shrink-0 transition-transform',
              open && 'rotate-90',
            )}
          />
          {desc !== null ? (
            <span className="font-medium text-foreground" title={agent.agentId}>
              {cutAgentLabel(desc)}
            </span>
          ) : (
            <span className="font-mono font-medium text-foreground">
              {truncateAgentId(agent.agentId)}
            </span>
          )}
          {agent.durationMs !== undefined && (
            <span className="ml-1 text-muted-foreground">
              {formatDuration(agent.durationMs)}
            </span>
          )}
        </CollapsibleTrigger>

        <CollapsibleContent>
          <SubAgentDetail
            agent={agent}
            pricing={pricing}
            sessionModel={sessionModel}
          />

          {agent.children.map((child) => (
            <SubAgentNode
              key={child.agentId}
              agent={child}
              depth={depth + 1}
              pricing={pricing}
              sessionModel={sessionModel}
            />
          ))}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
