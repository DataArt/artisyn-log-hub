// AgentBook release build (`npm run build` from agentbook/).
// 1. Builds the workspace in release mode except the installer (AgentBook.exe among it).
// 2. Builds AgentBook-Setup.exe with AGENTBOOK_EMBED_EXE pointing at that AgentBook.exe, so the
//    installer embeds it (crates/setup/build.rs; any other build of the setup embeds nothing).
// Output: target/release/AgentBook.exe and target/release/AgentBook-Setup.exe. Writes only into
// agentbook/target — never Log Hub's dist/. Exits with the first failing cargo's exit code.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = path.join(ROOT, 'target', 'release');
const exeSuffix = process.platform === 'win32' ? '.exe' : '';
const APP_EXE = path.join(RELEASE, `AgentBook${exeSuffix}`);
const SETUP_EXE = path.join(RELEASE, `AgentBook-Setup${exeSuffix}`);

function cargo(args, env) {
  process.stdout.write(`build: cargo ${args.join(' ')}\n`);
  const result = spawnSync('cargo', args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.error) {
    process.stderr.write(`build: cannot run cargo: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

cargo(['build', '--release', '--workspace', '--exclude', 'agentbook-setup', '--locked']);
if (!fs.existsSync(APP_EXE)) {
  process.stderr.write(`build: ${APP_EXE} was not produced\n`);
  process.exit(1);
}
cargo(['build', '--release', '--locked', '-p', 'agentbook-setup'], { AGENTBOOK_EMBED_EXE: APP_EXE });

const appSize = fs.statSync(APP_EXE).size;
const setupSize = fs.statSync(SETUP_EXE).size;
if (setupSize <= appSize) {
  process.stderr.write(`build: ${SETUP_EXE} (${setupSize} bytes) is not larger than AgentBook.exe (${appSize} bytes): the exe was not embedded\n`);
  process.exit(1);
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
process.stdout.write(`build: ${APP_EXE} (${mb(appSize)})\nbuild: ${SETUP_EXE} (${mb(setupSize)}, embeds AgentBook.exe)\n`);
