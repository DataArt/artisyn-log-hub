// Prints AgentBook's version: `version` under `[workspace.package]` in agentbook/Cargo.toml (the
// version every crate, AgentBook.exe and AgentBook-Setup.exe carry). Used by
// .github/workflows/agentbook-release.yml for the release tag `agentbook-v<version>`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lines = fs.readFileSync(path.join(ROOT, 'Cargo.toml'), 'utf8').split(/\r?\n/);

let section = '';
let version = null;
for (const line of lines) {
  const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
  if (header) {
    section = header[1].trim();
    continue;
  }
  const m = line.match(/^\s*version\s*=\s*"([^"]+)"/);
  if (m && section === 'workspace.package') {
    version = m[1];
    break;
  }
}

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  process.stderr.write(`version: no X.Y.Z version under [workspace.package] in agentbook/Cargo.toml (got ${version})\n`);
  process.exit(1);
}
process.stdout.write(`${version}\n`);
