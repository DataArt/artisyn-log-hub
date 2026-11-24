// Builds a Work Hub image by hand:
//   npm run image                 → docker build -t artisyn-work-hub-default:<server crate version> work-hub/image
//   npm run image -- --git-proxy  → docker build -t artisyn-work-hub-git-proxy:<server crate version> work-hub/sidecar
// The server builds the same images at startup when they are missing (default image: alpha plan
// D6; git proxy sidecar: remote git vault plan D2/D3); this is the manual path, e.g. to build on a
// machine with network access and move the image to an offline one with `docker save` /
// `docker load`. Other extra args are passed to `docker build`.
// The file is .mjs because work-hub/package.json is "type": "module"; the code itself stays
// synchronous and uses only Node built-ins.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IMAGES = {
  default: { name: 'artisyn-work-hub-default', context: 'image' },
  gitProxy: { name: 'artisyn-work-hub-git-proxy', context: 'sidecar' },
};
const GIT_PROXY_FLAG = '--git-proxy';

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
  const argv = process.argv.slice(2);
  const gitProxy = argv.includes(GIT_PROXY_FLAG);
  const extra = argv.filter((a) => a !== GIT_PROXY_FLAG);
  const image = gitProxy ? IMAGES.gitProxy : IMAGES.default;
  const version = readCrateVersion(path.join(workHubDir, 'server', 'Cargo.toml'));
  const tag = `${image.name}:${version}`;
  const context = path.join(workHubDir, image.context);
  if (!fs.existsSync(path.join(context, 'Dockerfile'))) {
    throw new Error(`no Dockerfile in ${context}`);
  }
  const args = ['build', '-t', tag, ...extra, context];
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
