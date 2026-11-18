// AC-2 guard (plan, Test coverage plan → Static checks). Part of `npm run lint`.
// Fails when the agent's name `claude` (any case) appears in server/src/**/*.rs outside
// server/src/agent/claude.rs and server/src/agent/mod.rs, or anywhere in web/src/**. Only the agent
// adapter names the agent; the UI shows the `agentName` the API sends. image/, tests/ and docs are
// not scanned.
// The file is .mjs because work-hub/package.json is "type": "module"; the code itself stays
// synchronous and uses only Node built-ins.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATTERN = /claude/i;

const SCANS = [
  {
    dir: path.join(ROOT, 'server', 'src'),
    include: (file) => file.endsWith('.rs'),
    allowed: new Set([
      path.join(ROOT, 'server', 'src', 'agent', 'claude.rs'),
      path.join(ROOT, 'server', 'src', 'agent', 'mod.rs'),
    ]),
  },
  {
    dir: path.join(ROOT, 'web', 'src'),
    include: () => true,
    allowed: new Set(),
  },
];

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

try {
  const hits = [];
  for (const scan of SCANS) {
    if (!fs.existsSync(scan.dir)) throw new Error(`missing folder ${scan.dir}`);
    for (const file of listFiles(scan.dir)) {
      if (!scan.include(file) || scan.allowed.has(file)) continue;
      // The file name counts too: a component named after the agent is a hit.
      if (PATTERN.test(path.basename(file))) hits.push(`${path.relative(ROOT, file)}: file name`);
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (PATTERN.test(line)) hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  if (hits.length > 0) {
    process.stderr.write(
      `agent-names-check: the agent's name appears outside the agent adapter (AC-2). ` +
        `Use the adapter (server) or the API's agentName (web) instead:\n`,
    );
    for (const hit of hits) process.stderr.write(`  ${hit}\n`);
    process.exit(1);
  }
  process.stdout.write('agent-names-check: ok\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(`agent-names-check error: ${err.message}\n`);
  process.exit(1);
}
