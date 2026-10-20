// ---------------------------------------------------------------------------
// Workflow extractor — parses Workflow tool_use + queue-operation enqueue events
// ---------------------------------------------------------------------------

// Internal interfaces — not exported

interface QueueOperationEvent {
  type: 'queue-operation';
  operation: string;
  content?: string;
}

interface TaskNotification {
  taskId: string | null;
  toolUseId: string;
  status: string;
  summary: string | null;
  result: string | null;
  usage: string | null;
  diagnostics: string | null;
}

// ---------------------------------------------------------------------------
// Exported types (mirrored in client/src/models/workflows.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractTagContent(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const match = re.exec(xml);
  return match ? match[1] : null;
}

function parseTaskNotification(xmlStr: string): TaskNotification | null {
  try {
    const toolUseIdRaw = extractTagContent(xmlStr, 'tool-use-id');
    if (!toolUseIdRaw) return null;
    const toolUseId = toolUseIdRaw.trim();
    const taskId = extractTagContent(xmlStr, 'task-id')?.trim() ?? null;
    const status = extractTagContent(xmlStr, 'status')?.trim() ?? '';
    const summary = extractTagContent(xmlStr, 'summary')?.trim() ?? null;
    const result = extractTagContent(xmlStr, 'result')?.trim() ?? null;
    const usage = extractTagContent(xmlStr, 'usage')?.trim() ?? null;
    const diagnostics =
      extractTagContent(xmlStr, 'diagnostics')?.trim() ?? null;
    return { taskId, toolUseId, status, summary, result, usage, diagnostics };
  } catch {
    return null;
  }
}

// Extracts the wf-id (e.g. "wf_b4978a0b-2af") from a completion notification's
// <diagnostics> text. Primary source is the explicit `resumeFromRunId: '...'`
// affordance the hook documents there; fallback is the wf-id path segment
// (`subagents/workflows/wf_xxx/...`) that also appears in that text.
function extractWfId(diagnostics: string | null): string | null {
  if (!diagnostics) return null;

  const primary = /resumeFromRunId:\s*'([^']+)'/.exec(diagnostics);
  if (primary) return primary[1];

  const fallback = /subagents[/\\]workflows[/\\](wf_[^/\\'"]+)[/\\]/.exec(
    diagnostics,
  );
  if (fallback) return fallback[1];

  return null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function extractWorkflows(events: unknown[]): WorkflowRun[] {
  // Step 1: collect Workflow tool_use blocks from assistant events
  interface WorkflowCall {
    toolUseId: string;
    name: string;
    args: string | null;
  }

  const workflowCalls: WorkflowCall[] = [];

  for (const evt of events) {
    if (!evt || typeof evt !== 'object') continue;
    const e = evt as Record<string, unknown>;
    if (e['type'] !== 'assistant') continue;

    const message = e['message'] as Record<string, unknown> | undefined;
    if (!message) continue;

    const content = message['content'];
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b['type'] !== 'tool_use') continue;
      if (b['name'] !== 'Workflow') continue;
      const toolUseId = typeof b['id'] === 'string' ? b['id'] : null;
      if (!toolUseId) continue;

      const input = b['input'] as Record<string, unknown> | undefined;
      const name = typeof input?.['name'] === 'string' ? input['name'] : '';

      let args: string | null = null;
      if (input?.['args'] !== undefined && input['args'] !== null) {
        const rawArgs = input['args'];
        if (typeof rawArgs === 'string') {
          args = rawArgs;
        } else {
          try {
            args = JSON.stringify(rawArgs);
          } catch {
            args = null;
          }
        }
      }

      workflowCalls.push({ toolUseId, name, args });
    }
  }

  if (workflowCalls.length === 0) return [];

  // Step 2: collect queue-operation enqueue events, index by toolUseId
  const enqueueMap = new Map<string, TaskNotification>();

  for (const evt of events) {
    if (!evt || typeof evt !== 'object') continue;
    const e = evt as Record<string, unknown>;
    const qe = e as unknown as QueueOperationEvent;
    if (qe.type !== 'queue-operation') continue;
    if (qe.operation !== 'enqueue') continue;
    if (typeof qe.content !== 'string') continue;

    const notification = parseTaskNotification(qe.content);
    if (!notification) continue;

    enqueueMap.set(notification.toolUseId, notification);
  }

  // Step 3: build WorkflowRun for each call
  const runs: WorkflowRun[] = [];

  for (const call of workflowCalls) {
    const notification = enqueueMap.get(call.toolUseId);

    if (!notification) {
      runs.push({
        taskId: null,
        toolUseId: call.toolUseId,
        name: call.name,
        args: call.args,
        status: 'running',
        durationMs: null,
        agentCount: null,
        subagentTokens: null,
        toolUses: null,
        summary: null,
        findings: [],
        wfId: null,
        agentSessionIds: [],
      });
      continue;
    }

    const rawStatus = notification.status.toLowerCase();
    const status: WorkflowRun['status'] =
      rawStatus === 'completed'
        ? 'completed'
        : rawStatus === 'failed'
          ? 'failed'
          : 'running';

    // Parse usage XML — <usage><agent_count>N</agent_count>...</usage>
    let durationMs: number | null = null;
    let agentCount: number | null = null;
    let subagentTokens: number | null = null;
    let toolUses: number | null = null;

    if (notification.usage) {
      let usageJson: Record<string, unknown> | null = null;
      try {
        usageJson = JSON.parse(notification.usage) as Record<string, unknown>;
      } catch {
        // not JSON — fall through to XML extraction
      }

      if (usageJson) {
        const pickInt = (...keys: string[]): number | null => {
          for (const k of keys) {
            const v = usageJson[k];
            if (typeof v === 'number' && !isNaN(v)) return v;
            if (typeof v === 'string') {
              const n = parseInt(v, 10);
              if (!isNaN(n)) return n;
            }
          }
          return null;
        };
        durationMs = pickInt('duration_ms', 'durationMs');
        agentCount = pickInt('agent_count', 'agentCount');
        subagentTokens = pickInt('subagent_tokens', 'subagentTokens');
        toolUses = pickInt('tool_uses', 'toolUses');
      } else {
        const parseIntTag = (tag: string): number | null => {
          const s = extractTagContent(notification.usage!, tag);
          if (!s) return null;
          const v = parseInt(s, 10);
          return isNaN(v) ? null : v;
        };
        agentCount = parseIntTag('agent_count');
        subagentTokens = parseIntTag('subagent_tokens');
        toolUses = parseIntTag('tool_uses');
        durationMs = parseIntTag('duration_ms');
      }
    }

    // Parse findings (and detailed summary) from result JSON.
    // The result JSON may be truncated by the workflow system — try full parse
    // first, then fall back to regex extraction on the partial string.
    const findings: WorkflowFinding[] = [];
    let resultSummary: string | null = null;

    if (notification.result) {
      let resultObj: Record<string, unknown> | null = null;
      try {
        resultObj = JSON.parse(notification.result) as Record<string, unknown>;
      } catch {
        // truncated JSON — fall through to regex extraction
      }

      if (resultObj) {
        if (typeof resultObj['summary'] === 'string') {
          resultSummary = resultObj['summary'];
        }
        if (Array.isArray(resultObj['findings'])) {
          for (const f of resultObj['findings'] as unknown[]) {
            if (!f || typeof f !== 'object') continue;
            const fo = f as Record<string, unknown>;
            const claim = typeof fo['claim'] === 'string' ? fo['claim'] : '';
            const confidence =
              typeof fo['confidence'] === 'string' ? fo['confidence'] : '';
            if (claim) findings.push({ claim, confidence });
          }
        }
      } else {
        // Regex extraction from potentially truncated JSON string.
        // Extract top-level summary field.
        const summaryMatch = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(
          notification.result,
        );
        if (summaryMatch) {
          try {
            resultSummary = JSON.parse('"' + summaryMatch[1] + '"') as string;
          } catch {
            resultSummary = summaryMatch[1];
          }
        }
        // Extract finding objects by matching claim+confidence key pairs.
        const findingRe =
          /"claim"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"confidence"\s*:\s*"([^"\\]*)"/g;
        let m: RegExpExecArray | null;
        while ((m = findingRe.exec(notification.result)) !== null) {
          let claim: string;
          try {
            claim = JSON.parse('"' + m[1] + '"') as string;
          } catch {
            claim = m[1];
          }
          const confidence = m[2];
          if (claim) findings.push({ claim, confidence });
        }
      }
    }

    runs.push({
      taskId: notification.taskId,
      toolUseId: call.toolUseId,
      name: call.name,
      args: call.args,
      status,
      durationMs,
      agentCount,
      subagentTokens,
      toolUses,
      summary: resultSummary ?? notification.summary,
      findings,
      wfId: extractWfId(notification.diagnostics),
      agentSessionIds: [],
    });
  }

  return runs;
}
