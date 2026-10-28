// POC: transparent wrapper for ANY command-line tool. Usage: node tool-shim.mjs <toolName> [args...]
// - finds the real <toolName> on PATH, skipping this shim dir;
// - forwards stdin/stdout/stderr and the exit code unchanged;
// - logs crash-safely: a `start` record before the tool runs, output streamed to
//   <logDir>/out/<callId>.out as it arrives, an `end` record when it exits. If the wrapper is
//   killed (PowerShell `Select-Object -First`, Ctrl+C, timeout) the start record and the partial
//   output survive and the missing `end` itself says "terminated".
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shimDir = path.dirname(fileURLToPath(import.meta.url));
const [tool, ...args] = process.argv.slice(2);
const logDir = process.env.TOOL_SHIM_DIR || path.join(shimDir, '..', 'out');
const logFile = path.join(logDir, 'tool-calls.jsonl');
const MAX_CAPTURE = 1024 * 1024; // per call; the agent still gets everything
const callId = randomUUID();
const outFile = path.join(logDir, 'out', `${callId}.out`);

function resolveReal(name) {
  const win = process.platform === 'win32';
  const exts = win ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir || path.resolve(dir) === shimDir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext.toLowerCase());
      try { if (existsSync(p) && statSync(p).isFile()) return p; } catch { /* unreadable dir */ }
    }
  }
  return null;
}

// Logging must never break the tool: every write is best-effort.
const log = (rec) => { try { mkdirSync(path.dirname(outFile), { recursive: true }); appendFileSync(logFile, JSON.stringify(rec) + '\n'); } catch { /* ignore */ } };
let captured = 0;
const capture = (stream, b) => {
  if (captured >= MAX_CAPTURE) return;
  captured += b.length;
  try { appendFileSync(outFile, `${stream === 'stderr' ? '\u0002' : ''}${b.toString('utf8')}`); } catch { /* ignore */ }
};

const real = resolveReal(tool);
if (!real) { process.stderr.write(`tool-shim: real '${tool}' not found on PATH\n`); process.exit(127); }

const started = Date.now();
log({ phase: 'start', callId, ts: new Date(started).toISOString(), tool, args, cwd: process.cwd(), real,
  session_id: process.env.CLAUDE_CODE_SESSION_ID || null, platform: process.platform });

// .cmd/.bat run through cmd.exe on Windows; everything else is spawned directly (no quoting games).
// Not `shell: true` — Node prints a DEP0190 warning to stderr for it, which would alter the tool's output.
const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(real);
const quote = (a) => `"${String(a).replace(/"/g, '""')}"`;
const child = isBatch
  ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[real, ...args].map(quote).join(' ')}"`],
    { stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: true })
  : spawn(real, args, { stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true });
let consumerClosed = false, outBytes = 0, errBytes = 0;

// The consumer (`| head`) closed our stdout: stop forwarding but keep draining the tool into the
// log — the point is to debug the tool, so we want everything it produced, not what the agent kept.
// Only a tool that keeps writing past MAX_CAPTURE after that is stopped (e.g. an endless stream).
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') consumerClosed = true; });
child.stdout.on('data', (b) => {
  outBytes += b.length; capture('stdout', b);
  if (!consumerClosed) process.stdout.write(b);
  else if (captured >= MAX_CAPTURE) child.kill();
});
child.stderr.on('data', (b) => { errBytes += b.length; capture('stderr', b); process.stderr.write(b); });
child.on('error', (e) => { log({ phase: 'end', callId, error: e.message, duration_ms: Date.now() - started }); process.exit(127); });
child.on('close', (code, signal) => {
  log({ phase: 'end', callId, exit_code: code, signal, consumer_closed: consumerClosed,
    duration_ms: Date.now() - started, stdout_bytes: outBytes, stderr_bytes: errBytes, truncated: captured >= MAX_CAPTURE });
  process.exitCode = code ?? 1;
});
