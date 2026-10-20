export interface WorkflowFinding {
  claim: string;
  confidence: string;
}

export interface WorkflowRun {
  taskId: string | null;
  toolUseId: string;
  name: string;
  args: string | null;
  status: 'completed' | 'failed' | 'running';
  durationMs: number | null;
  agentCount: number | null;
  subagentTokens: number | null;
  toolUses: number | null;
  summary: string | null;
  findings: WorkflowFinding[];
  wfId: string | null;
  agentSessionIds: string[];
}
