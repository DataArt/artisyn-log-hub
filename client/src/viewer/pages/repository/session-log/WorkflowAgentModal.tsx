import { useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../ui/tabs';
import type { ModelPricingMap } from '../../../../models/pricing';
import type { SubAgentNode } from './types';
import { parseSessionLogs } from './log-parser';
import { PromptTurnList } from './PromptTurnList';
import { RawLogsTab } from './RawLogsTab';

interface Props {
  agent: SubAgentNode;
  label: string;
  logs: Record<string, unknown>[];
  /** Bare-id-keyed transcripts of the whole session, so the agent's own sub-agents resolve too. */
  subagentLogsMap?: Map<string, Record<string, unknown>[]>;
  pricing?: ModelPricingMap;
  sessionModel?: string;
  onClose: () => void;
}

/**
 * One workflow agent's session in a modal, with the same two views the session pane has: "Logs"
 * (the very same `PromptTurnList` the Logs tab renders, over the agent's own turns) and "Raw logs"
 * (the very same `RawLogsTab` the Raw Logs tab renders). The agent's transcript is parsed once,
 * only while the modal is open, and feeds both tabs.
 */
export function WorkflowAgentModal({
  agent,
  label,
  logs,
  subagentLogsMap,
  pricing,
  sessionModel,
  onClose,
}: Props) {
  const model = agent.model ?? sessionModel;
  const parsed = useMemo(
    () =>
      parseSessionLogs(logs, {
        isSubagent: true,
        pricing,
        subagentLogs: subagentLogsMap,
      }),
    [logs, pricing, subagentLogsMap],
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-5xl h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex flex-wrap items-baseline gap-2 text-base">
            <span>{label}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {agent.agentId}
            </span>
          </DialogTitle>
        </DialogHeader>
        {/* Tab state stays local: it belongs to this transient modal, not to the page URL. */}
        <Tabs defaultValue="logs" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="shrink-0 self-start">
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="raw">Raw logs</TabsTrigger>
          </TabsList>
          <TabsContent
            value="logs"
            data-testid="workflow-agent-logs"
            className="mt-2 min-h-0 flex-1 overflow-auto"
          >
            <PromptTurnList
              turns={parsed.turns}
              compactBoundaries={parsed.compactBoundaries}
              subagentLogsMap={subagentLogsMap}
              pricing={pricing}
              sessionModel={model}
              hasStopFailure={parsed.hasStopFailure}
            />
          </TabsContent>
          <TabsContent
            value="raw"
            data-testid="workflow-agent-raw-logs"
            className="mt-2 min-h-0 flex-1"
          >
            <RawLogsTab
              rawLogs={logs}
              isLoading={false}
              parsedSession={parsed}
              pricing={pricing}
              sessionModel={model}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
