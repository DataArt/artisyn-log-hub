// Builds the Work Hub default devcontainer image by hand (plan D6):
//   docker build -t artisyn-work-hub-default:<server crate version> work-hub/image
// The server builds the same image at startup when it is missing; this is the manual path.
// Usage: npm run image (from work-hub/). Extra args are passed to `docker build`.
// The file is .mjs because work-hub/package.json is "type": "module"; the code itself stays
// synchronous and uses only Node built-ins.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IMAGE_NAME = 'artisyn-work-hub-default';

function readCrateVersion(cargoTomlPath) {
  const text = fs.readFileSync(cargoTomlPath, 'utf8');
  let inPackage = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inPackage = line === '[package]';
      continue;
    }
    if (!inPackage) continue;
    const m = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (m) return m[1];
  }
  throw new Error(`no [package] version in ${cargoTomlPath}`);
}

try {
  const workHubDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const version = readCrateVersion(path.join(workHubDir, 'server', 'Cargo.toml'));
  const tag = `${IMAGE_NAME}:${version}`;
  const context = path.join(workHubDir, 'image');
  const args = ['build', '-t', tag, ...process.argv.slice(2), context];
  process.stderr.write(`docker ${args.join(' ')}\n`);
  const res = spawnSync('docker', args, { stdio: 'inherit' });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    process.stderr.write(`image: docker build failed with exit code ${res.status}\n`);
    process.exit(res.status === null ? 1 : res.status);
  }
  process.stderr.write(`image: built ${tag}\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`image error: ${err.message}\n`);
  process.exit(1);
}
