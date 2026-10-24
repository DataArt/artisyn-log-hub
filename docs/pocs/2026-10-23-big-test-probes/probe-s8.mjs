// Probe S8: `--permission-mode default` with an allow list, through the joined `shell: true`
// command string. Records what a denied Write and a denied (not allow-listed) Bash call look like
// in the transcript: is_error, toolDenialKind, the denial text.
import { probeEnv, runClaude, transcriptLines, workspace, writeResult } from './probe-lib.mjs';

const ws = workspace();
const prompt =
  'Do these steps in order and do not stop early. ' +
  '1) Run exactly this Bash command: node --version ' +
  '2) Run exactly this Bash command: node -e "process.exit(3)" ' +
  '3) Use the Write tool to create the file denied.txt with the text hi ' +
  '4) Run exactly this Bash command: git status ' +
  'Then say which steps were refused.';

const run = await runClaude({
  name: 's8',
  cwd: ws.repoDir('js-cli'),
  env: probeEnv(ws),
  args: ['--model', 'haiku', '--permission-mode', 'default', '--allowedTools', '"Read"', '"Bash(node:*)"'],
  prompt,
});

const init = run.events.find((e) => e.type === 'system' && e.subtype === 'init');
const result = run.events.filter((e) => e.type === 'result');
const sid = init?.session_id;
const { file, lines } = transcriptLines(ws, sid);

const uses = new Map();
for (const l of lines) {
  for (const c of Array.isArray(l.message?.content) ? l.message.content : []) {
    if (c.type === 'tool_use') uses.set(c.id, { name: c.name, input: c.input });
  }
}
const calls = [];
for (const l of lines) {
  for (const c of Array.isArray(l.message?.content) ? l.message.content : []) {
    if (c.type !== 'tool_result') continue;
    const use = uses.get(c.tool_use_id) ?? {};
    const text = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x) => x.text ?? '').join('');
    calls.push({
      tool: use.name,
      input: use.input?.command ?? use.input?.file_path,
      is_error: c.is_error ?? false,
      text: text.slice(0, 240),
      // every key on the transcript line besides the usual ones — where a denial kind would live
      lineKeys: Object.keys(l).filter((k) => !['parentUuid', 'isSidechain', 'userType', 'cwd', 'sessionId', 'version', 'gitBranch', 'type', 'message', 'uuid', 'timestamp'].includes(k)),
      toolDenialKind: l.toolDenialKind ?? l.toolUseResult?.toolDenialKind ?? null,
      toolUseResult: typeof l.toolUseResult === 'string' ? l.toolUseResult.slice(0, 200) : l.toolUseResult ? Object.keys(l.toolUseResult) : null,
    });
  }
}

writeResult('s8', {
  command: run.command,
  exitCode: run.exitCode,
  ms: run.ms,
  permissionMode: init?.permissionMode,
  sessionId: sid,
  transcript: file,
  resultEvents: result.length,
  permissionDenials: result.at(-1)?.permission_denials ?? null,
  calls,
});
