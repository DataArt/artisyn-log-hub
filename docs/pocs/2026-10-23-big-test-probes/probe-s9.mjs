// Probe S9: a haiku `claude -p` session with a background Agent. Records whether `-p` waits for
// the <task-notification>, how that entry is written (string or text block, main thread or not),
// whether the main thread does work after it, and how many `result` events the stream has.
import { probeEnv, runClaude, transcriptLines, workspace, writeResult } from './probe-lib.mjs';

const ws = workspace();
const prompt =
  'Use the Agent tool with run_in_background set to true to start one subagent that reads ' +
  '`lib/args.js` and reports its exported function names. While it runs, do nothing else. ' +
  'When you are notified that it finished, read `lib/commands.js` yourself with the Read tool ' +
  'and then answer with both lists.';

const run = await runClaude({
  name: 's9',
  cwd: ws.repoDir('js-cli'),
  env: probeEnv(ws),
  args: ['--model', 'haiku', '--permission-mode', 'bypassPermissions'],
  prompt,
});

const init = run.events.find((e) => e.type === 'system' && e.subtype === 'init');
const results = run.events.filter((e) => e.type === 'result');
const sid = init?.session_id;
const { file, lines } = transcriptLines(ws, sid);

const isNotification = (c) =>
  (typeof c === 'string' && c.startsWith('<task-notification>')) ||
  (Array.isArray(c) && c.some((b) => b.type === 'text' && String(b.text).startsWith('<task-notification>')));

const timeline = lines
  .filter((l) => l.type === 'user' || l.type === 'assistant')
  .map((l) => {
    const c = l.message?.content;
    const blocks = Array.isArray(c) ? c : [];
    return {
      ts: l.timestamp,
      type: l.type,
      sidechain: Boolean(l.isSidechain),
      notification: l.type === 'user' && isNotification(c),
      contentShape: typeof c === 'string' ? 'string' : blocks.map((b) => b.type).join(','),
      toolUses: blocks.filter((b) => b.type === 'tool_use').map((b) => `${b.name}${b.input?.run_in_background ? '(bg)' : ''}`),
      extraKeys: Object.keys(l).filter((k) => !['parentUuid', 'isSidechain', 'userType', 'cwd', 'sessionId', 'version', 'gitBranch', 'type', 'message', 'uuid', 'timestamp', 'requestId', 'promptId', 'entrypoint'].includes(k)),
    };
  });

const notifLine = lines.find((l) => l.type === 'user' && isNotification(l.message?.content));
const nIdx = timeline.findIndex((t) => t.notification);
writeResult('s9', {
  exitCode: run.exitCode,
  ms: run.ms,
  sessionId: sid,
  transcript: file,
  resultEvents: results.map((r) => ({ subtype: r.subtype, total_cost_usd: r.total_cost_usd, num_turns: r.num_turns, duration_ms: r.duration_ms })),
  streamTypes: run.events.map((e) => `${e.type}${e.subtype ? `/${e.subtype}` : ''}`).filter((t, i, a) => t !== a[i - 1]),
  notification: notifLine
    ? {
        contentType: typeof notifLine.message.content === 'string' ? 'string' : 'array',
        raw: JSON.stringify(notifLine.message.content).slice(0, 400),
        lineKeys: Object.keys(notifLine),
        isMeta: notifLine.isMeta ?? null,
        origin: notifLine.origin ?? null,
      }
    : null,
  toolUseAfterNotification: nIdx >= 0 && timeline.slice(nIdx + 1).some((t) => !t.sidechain && t.toolUses.length > 0),
  firstUserTs: timeline.find((t) => t.type === 'user' && !t.sidechain)?.ts,
  lastMainAssistantTs: [...timeline].reverse().find((t) => t.type === 'assistant' && !t.sidechain)?.ts,
  timeline,
});
