export function makeArtisynNdjson(lineCount: number, repoUrl?: string): string {
  const resolvedRepoUrl = repoUrl ?? 'https://github.com/artisyn/perf-test-repo';
  const base = Date.now() - lineCount * 1000;
  const lines: string[] = [];

  lines.push(
    JSON.stringify({
      event: 'session_start',
      timestamp: new Date(base).toISOString(),
      git: {
        repo: resolvedRepoUrl,
        branch: 'main',
      },
      context: { environment: 'perf-test', version: '1.0.0' },
    }),
  );

  for (let i = 1; i < lineCount - 1; i++) {
    const ts = new Date(base + i * 1000).toISOString();
    if (i === 1) {
      lines.push(
        JSON.stringify({
          event: 'prompt',
          timestamp: ts,
          prompt: 'Implement performance test scenarios for all API endpoints',
          git: {
            repo: resolvedRepoUrl,
            branch: 'main',
          },
          context: { taskId: `task-${i}`, sprint: 'sprint-42' },
        }),
      );
    } else if (i % 10 === 0) {
      lines.push(
        JSON.stringify({
          event: 'tool_use',
          timestamp: ts,
          tool: 'bash',
          command: 'npm run build',
          exitCode: 0,
          durationMs: 3200 + i * 10,
          context: { step: i, phase: 'build' },
        }),
      );
    } else {
      lines.push(
        JSON.stringify({
          event: 'thinking',
          timestamp: ts,
          tokens: 200 + i * 15,
          cost: parseFloat((0.0002 * i).toFixed(6)),
          model: 'claude-sonnet-4-6',
        }),
      );
    }
  }

  lines.push(
    JSON.stringify({
      event: 'session_end',
      timestamp: new Date(base + lineCount * 1000).toISOString(),
      totalTokens: lineCount * 150,
      totalCost: parseFloat((lineCount * 0.0002).toFixed(6)),
      git: {
        repo: resolvedRepoUrl,
        branch: 'main',
      },
    }),
  );

  return lines.join('\n');
}

export function makeHookStatusLine(hookVersion = '1.6.0'): string {
  return JSON.stringify({
    type: 'hook-status',
    hookVersion,
    timestamp: new Date().toISOString(),
    logTail: [],
    nonUploadableLogs: [],
    recommendations: [],
  });
}

// Real claude/claude-subagent transcript event, sized to trigger the extraction
// paths in server/src/logs/claude-extractor.ts (message.usage token fields).
function makeAssistantEvent(
  ts: string,
  input: { input_tokens: number; output_tokens: number },
  content: unknown = `Step content`,
): object {
  return {
    type: 'assistant',
    timestamp: ts,
    message: {
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: input.input_tokens,
        output_tokens: input.output_tokens,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
      },
      content,
    },
  };
}

// A claude-type log carrying a completed `Workflow` tool_use, so
// extractWorkflows() (server/src/logs/workflow-extractor.ts) resolves a real
// WorkflowRun with the given wfId — used to seed a session that exercises the
// repos:session-logs workflow/subagent-linkage BFS instead of running it over
// an empty claude log.
export function makeWorkflowClaudeNdjson(wfId: string): string {
  const toolUseId = 'toolu_wf_perftest';
  const base = Date.now() - 5000;
  const lines: object[] = [
    {
      type: 'user',
      timestamp: new Date(base).toISOString(),
      message: { role: 'user', content: 'Run the perf-test workflow' },
    },
    makeAssistantEvent(
      new Date(base + 1000).toISOString(),
      { input_tokens: 500, output_tokens: 200 },
      [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Workflow',
          input: { name: 'perf-test-workflow', args: {} },
        },
      ],
    ),
    {
      type: 'queue-operation',
      timestamp: new Date(base + 2000).toISOString(),
      operation: 'enqueue',
      content:
        `<tool-use-id>${toolUseId}</tool-use-id>` +
        `<task-id>task-perftest</task-id>` +
        `<status>completed</status>` +
        `<summary>Perf-test workflow completed</summary>` +
        `<result>${JSON.stringify({ summary: 'done', findings: [] })}</result>` +
        `<usage>${JSON.stringify({ agent_count: 2, subagent_tokens: 500, tool_uses: 10, duration_ms: 5000 })}</usage>` +
        `<diagnostics>resumeFromRunId: '${wfId}'</diagnostics>`,
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

// A minimal but shape-correct claude-subagent transcript (assistant events with
// real message.usage fields) — used to seed a workflow/Task-tool subagent
// session so descendant-tree lookups have real rows to walk.
export function makeSubagentNdjson(lineCount = 3): string {
  const base = Date.now() - lineCount * 500;
  const lines: object[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push(
      makeAssistantEvent(
        new Date(base + i * 500).toISOString(),
        { input_tokens: 100 + i * 10, output_tokens: 50 + i * 5 },
        `Subagent step ${i}`,
      ),
    );
  }
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

export function makeClaudeNdjson(lineCount: number): string {
  const base = Date.now() - lineCount * 500;
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    const ts = new Date(base + i * 500).toISOString();
    const type = i === 0 ? 'user' : i % 3 === 0 ? 'assistant' : 'tool';
    lines.push(
      JSON.stringify({
        type,
        timestamp: ts,
        content: `Step ${i}: ${'x'.repeat(40 + (i % 20))}`,
        tokens: 40 + i * 3,
        cost: parseFloat((0.0001 * (i + 1)).toFixed(6)),
      }),
    );
  }
  return lines.join('\n');
}
