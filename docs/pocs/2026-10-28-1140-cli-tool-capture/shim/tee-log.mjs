// POC: logging tee for the POSIX shim. The shell runs the real tool itself (so arguments, path
// conversion and PATH lookup are exactly native); this process only sits on the tool's stdout:
//   "$real" "$@" | node tee-log.mjs <callId> <tool> <real> <args...>
// It writes the `start` record, forwards stdin → stdout, appends everything to out/<callId>.out,
// and writes `stream_end`. If the consumer closes the pipe (`| head`), it stops forwarding but keeps
// draining, so the log holds the tool's FULL output (we are debugging the tool, not the agent).
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shimDir = path.dirname(fileURLToPath(import.meta.url));
const [callId, tool, real, ...args] = process.argv.slice(2);
const logDir = process.env.TOOL_SHIM_DIR || path.join(shimDir, '..', 'out');
const logFile = path.join(logDir, 'tool-calls.jsonl');
const outFile = path.join(logDir, 'out', `${callId}.out`);
const MAX_CAPTURE = 1024 * 1024;
const started = Date.now();

const log = (rec) => { try { mkdirSync(path.dirname(outFile), { recursive: true }); appendFileSync(logFile, JSON.stringify(rec) + '\n'); } catch { /* never break the tool */ } };
log({ phase: 'start', callId, ts: new Date(started).toISOString(), tool, args, real, cwd: process.cwd(),
  session_id: process.env.CLAUDE_CODE_SESSION_ID || null, platform: process.platform, shell: 'posix' });

let bytes = 0, captured = 0, consumerClosed = false;
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') consumerClosed = true; });
process.stdin.on('data', (b) => {
  bytes += b.length;
  if (captured < MAX_CAPTURE) { captured += b.length; try { appendFileSync(outFile, b); } catch { /* ignore */ } }
  if (!consumerClosed) process.stdout.write(b);
});
process.stdin.on('end', () => log({ phase: 'stream_end', callId, stdout_bytes: bytes, consumer_closed: consumerClosed,
  truncated: bytes > MAX_CAPTURE, duration_ms: Date.now() - started }));
