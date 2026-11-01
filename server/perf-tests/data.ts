import { randomBytes, randomUUID } from 'crypto';

export function makeArtisynNdjson(lineCount: number, repoUrl?: string): string {
  const resolvedRepoUrl =
    repoUrl ?? 'https://github.com/artisyn/perf-test-repo';
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

/**
 * A realistic, large claude transcript (~`targetBytes` of NDJSON) for the heavy session-list
 * seed: user prompts, assistant turns with `message.id`, `model`, `usage` and text + tool_use
 * blocks (every other one a Write with ~4 KB of file content), user lines carrying tool_result
 * blocks (padded Read output), and every 4th turn a
 * sidechain (`isSidechain: true`) assistant line. With `withWorkflow` the first assistant turn
 * also carries a `Workflow` tool_use (id `wf_<uuid>`), which makes the session's
 * `hasWorkflow` flag true. Synthetic data only.
 */
export function makeHeavyClaudeNdjson(opts: {
  targetBytes: number;
  withWorkflow: boolean;
}): string {
  const out: string[] = [];
  let bytes = 0;
  const push = (line: object): void => {
    const text = JSON.stringify(line);
    out.push(text);
    bytes += text.length + 1;
  };

  const base = Date.now() - 3_600_000;
  // Incompressible padding (base64 of random bytes, broken into "words"), like real
  // transcripts: a repeated-words pad shrinks the TOASTed jsonb ~20x and made a full body
  // scan look cheap enough to pass the budget.
  const randomPad = (chars: number): string =>
    randomBytes(Math.ceil((chars * 3) / 4))
      .toString('base64')
      .slice(0, chars)
      .replace(/(.{60})/g, '$1 ');
  let turn = 0;
  let workflowPending = opts.withWorkflow;

  while (bytes < opts.targetBytes) {
    const ts = (offsetMs: number): string =>
      new Date(base + turn * 4000 + offsetMs).toISOString();
    const userUuid = randomUUID();
    push({
      type: 'user',
      uuid: userUuid,
      timestamp: ts(0),
      isSidechain: false,
      message: {
        role: 'user',
        content: `Turn ${turn}: refactor the module and run the tests`,
      },
    });

    const toolUseId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const content: object[] = [
      { type: 'text', text: `Working on turn ${turn}. ${randomPad(600)}` },
      {
        type: 'tool_use',
        id: toolUseId,
        name: turn % 2 === 0 ? 'Write' : 'Read',
        // Write turns carry the file content in the assistant line itself (as real ones do),
        // so assistant events average a few KB like in real transcripts, not a few hundred
        // bytes — their size is what the old list query's per-line sort paid for.
        input:
          turn % 2 === 0
            ? {
                file_path: `src/module-${turn % 17}.ts`,
                content: randomPad(4000),
              }
            : { file_path: `src/module-${turn % 17}.ts` },
      },
    ];
    if (workflowPending) {
      content.push({
        type: 'tool_use',
        id: `wf_${randomUUID()}`,
        name: 'Workflow',
        input: { name: 'perf-heavy-workflow', args: {} },
      });
      workflowPending = false;
    }
    const assistantUuid = randomUUID();
    push({
      type: 'assistant',
      uuid: assistantUuid,
      parentUuid: userUuid,
      timestamp: ts(1000),
      isSidechain: false,
      message: {
        id: `msg_${randomUUID().replace(/-/g, '')}`,
        role: 'assistant',
        model: turn % 9 === 8 ? 'claude-haiku-4-5' : 'claude-sonnet-4-6',
        usage: {
          input_tokens: 1200 + (turn % 50) * 10,
          output_tokens: 300 + (turn % 30) * 5,
          cache_read_input_tokens: 20000 + turn * 50,
          cache_creation_input_tokens: 800,
        },
        content,
      },
    });

    push({
      type: 'user',
      uuid: randomUUID(),
      parentUuid: assistantUuid,
      timestamp: ts(2000),
      isSidechain: false,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content:
              turn % 2 === 0
                ? 'File written successfully'
                : `1\t${randomPad(2200)}`,
          },
        ],
      },
    });

    if (turn % 4 === 3) {
      push({
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: ts(3000),
        isSidechain: true,
        message: {
          id: `msg_${randomUUID().replace(/-/g, '')}`,
          role: 'assistant',
          model: 'claude-haiku-4-5',
          usage: {
            input_tokens: 400,
            output_tokens: 120,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 0,
          },
          content: [{ type: 'text', text: `Sidechain summary ${turn}` }],
        },
      });
    }
    turn++;
  }
  return out.join('\n');
}
