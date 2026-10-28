// POC: inject a shim dir into the agent's shell PATH via CLAUDE_ENV_FILE.
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
const envFile = process.env.CLAUDE_ENV_FILE;
const shim = path.resolve(process.cwd(), '..', 'shim');
const dbg = path.resolve(process.cwd(), '..', 'out', 'envtest-hook.log');
appendFileSync(dbg, JSON.stringify({ envFile, platform: process.platform, shell: process.env.SHELL, input }) + '\n');
if (envFile) {
  // Git Bash on Windows wants /c/x/y; Linux/mac paths pass through unchanged.
  const posix = process.platform === 'win32'
    ? '/' + shim[0].toLowerCase() + shim.slice(2).split(path.sep).join('/')
    : shim;
  appendFileSync(envFile, `export PATH="${posix}:$PATH"\nexport LOGHUB_TOOL_LOG_TEST=1\n`);
}
