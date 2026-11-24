// Network layout check (plan D2): workspace-like containers are created on the default `bridge`
// and connected afterwards to an `internal` user-defined network; the sidecar sits on `bridge`
// (egress) and on that network with the alias `wh-git`. Checks alias resolution, reachability and
// the sidecar's internet egress. Run from this folder: node net-check.cjs
const { spawnSync } = require('child_process');
const path = require('path');

const NET = 'whpoc-net-internal';
const SIDE = 'whpoc-sidecar';
const CLI = 'whpoc-client';
const results = [];

function docker(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 600000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function check(name, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${(detail || '').trim().split('\n').join('\n      ')}\n`);
}
function cleanup() {
  docker(['rm', '-f', SIDE, CLI]);
  docker(['network', 'rm', NET]);
}

try {
  cleanup();
  let r = docker(['compose', '-f', path.join(__dirname, 'compose.yml'), 'build', 'sidecar', 'client']);
  if (r.code !== 0) throw new Error(r.out);
  r = docker(['network', 'create', '--internal', NET]);
  if (r.code !== 0) throw new Error(r.out);
  docker(['create', '--name', SIDE, '--network', 'bridge', '--tmpfs', '/run/wh', 'wh-git-poc-sidecar']);
  docker(['network', 'connect', '--alias', 'wh-git', NET, SIDE]);
  r = docker(['start', SIDE]);
  if (r.code !== 0) throw new Error(r.out);
  docker(['run', '-d', '--name', CLI, '--network', 'bridge', '--tmpfs', '/tmp', 'wh-git-poc-client', 'sleep', 'infinity']);
  r = docker(['network', 'connect', NET, CLI]);
  check('connect a running bridge container to the internal network', r.code === 0, r.out);
  r = docker(['network', 'connect', NET, CLI]);
  check('second connect reports "already exists" (to treat as ok)', r.code !== 0 && /already exists|already attached/i.test(r.out), r.out);

  r = docker(['exec', CLI, 'getent', 'hosts', 'wh-git']);
  check('client resolves the alias wh-git', r.code === 0 && /wh-git/.test(r.out), r.out);
  r = docker(['exec', CLI, 'git', 'ls-remote', 'http://wh-git/git/nope.git']);
  check('client reaches the sidecar over HTTP', /unknown remote/.test(r.out), r.out);
  r = docker(['exec', CLI, 'sh', '-c', 'wget -q -T 10 -O /dev/null https://example.com && echo EGRESS-OK || echo EGRESS-FAIL']);
  check('client keeps internet egress via bridge', /EGRESS-OK/.test(r.out), r.out);
  r = docker(['exec', SIDE, 'sh', '-c', 'curl -sS -m 10 -o /dev/null -w "%{http_code}" https://example.com || echo EGRESS-FAIL']);
  check('sidecar has internet egress (bridge + internal network)', /^[23]\d\d/.test(r.out.trim()), r.out);
  r = docker(['restart', SIDE]);
  r = docker(['exec', CLI, 'git', 'ls-remote', 'http://wh-git/git/nope.git']);
  check('alias still resolves after the sidecar restarts', /unknown remote/.test(r.out), r.out);

  cleanup();
  process.stdout.write(`\n${results.join('\n')}\n`);
  process.exit(results.some((l) => l.startsWith('FAIL')) ? 1 : 0);
} catch (err) {
  cleanup();
  process.stderr.write(`net-check error: ${err.message}\n`);
  process.exit(1);
}
