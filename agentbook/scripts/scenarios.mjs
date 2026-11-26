// AgentBook scenario suite runner (`npm run test:scenarios` from agentbook/).
// Runs the `scenarios` test target of agentbook-engine (agentbook/tests/scenarios/main.rs, its own
// harness) and passes any extra arguments through to it. The suite drives the engine on real
// Docker; its data dir and fake home live under the repo's tmp/ and it removes only the Docker
// objects labelled with its own instance. Exits with the suite's exit code.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extra = process.argv.slice(2);
const args = ['test', '-p', 'agentbook-engine', '--test', 'scenarios', '--locked'];
if (extra.length > 0) args.push('--', ...extra);

const result = spawnSync('cargo', args, { cwd: ROOT, stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`scenarios: cannot run cargo: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
