#!/usr/bin/env node
// PoC: repository + profile live in named volumes; opening a workstream copies both volumes with a
// helper container (tar pipe) and starts a container from the checkpoint image. Uses only the
// docker CLI. Creates wh-poc-vol-* containers/volumes/images and removes them at the end
// (--keep leaves them for inspection).
'use strict';
const { spawnSync } = require('node:child_process');

const IMAGE = process.env.WH_POC_IMAGE || 'workhub-poc-branch';
const P = 'wh-poc-vol';
const keep = process.argv.includes('--keep');
const FILES = Number(process.env.WH_POC_FILES || 20000);
let passed = 0;
let failed = 0;

function docker(args, opts = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`docker ${args.join(' ')} failed: ${r.stderr}`);
  }
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const sh = (ctr, cmd, opts = {}) => docker(['exec', ...(opts.root ? ['-u', '0'] : []), ctr, 'sh', '-c', cmd], opts);
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) passed++; else failed++;
}
function timed(fn) {
  const t = Date.now();
  const r = fn();
  return [r, Date.now() - t];
}

function cleanup() {
  const ctrs = docker(['ps', '-aq', '--filter', `name=^${P}-`], { allowFail: true }).out;
  if (ctrs) docker(['rm', '-f', ...ctrs.split(/\s+/)], { allowFail: true });
  const vols = docker(['volume', 'ls', '-q', '--filter', `name=^${P}-`], { allowFail: true }).out;
  if (vols) docker(['volume', 'rm', '-f', ...vols.split(/\s+/)], { allowFail: true });
  docker(['rmi', '-f', `${P}-checkpoint:1`], { allowFail: true });
}

function runContainer(name, image, repoVol, homeVol) {
  docker(['run', '-d', '--name', name, '-v', `${repoVol}:/workspace`, '-v', `${homeVol}:/home/node`, image]);
}

// Helper container from the default image: copy one volume into a new one with a tar pipe,
// keeping owner, mode and symlinks.
function copyVolume(from, to) {
  docker(['volume', 'create', to]);
  docker(['run', '--rm', '-u', '0', '-v', `${from}:/from:ro`, '-v', `${to}:/to`, '--entrypoint', 'sh', IMAGE,
    '-c', 'cd /from && tar cf - . | tar xpf - -C /to']);
}

function main() {
  cleanup();
  const ws = `${P}-ws`;
  docker(['volume', 'create', `${P}-ws-repo`]);
  docker(['volume', 'create', `${P}-ws-home`]);
  runContainer(ws, IMAGE, `${P}-ws-repo`, `${P}-ws-home`);

  // An empty named volume mounted over an image dir is populated from the image on first mount.
  check('fresh profile volume is populated from the image home (.gitconfig present)',
    sh(ws, 'test -f /home/node/.gitconfig && echo yes', { allowFail: true }).out === 'yes');
  check('volumes are owned by the container user (node) after populate',
    sh(ws, 'stat -c %U /workspace /home/node').out.split('\n').every((u) => u === 'node'));

  sh(ws, 'cd /workspace && git init -q && printf "node_modules/\\n" > .gitignore && git add . && git commit -qm init');
  sh(ws, 'mkdir -p /home/node/.claude && echo \'{"t":"secret"}\' > /home/node/.claude/.credentials.json && chmod 600 /home/node/.claude/.credentials.json');
  sh(ws, 'cd /workspace && ln -s .gitignore link-to-ignore && chmod 755 .gitignore && git add . && git commit -qm link');
  // Many small files, like an installed node_modules.
  sh(ws, `cd /workspace && mkdir -p node_modules && i=0; while [ $i -lt ${FILES} ]; do d=node_modules/p$((i/200)); mkdir -p $d; echo $i > $d/f$i.js; i=$((i+1)); done`);

  // Configure session: install a tool into the container layer, then checkpoint.
  sh(ws, 'mkdir -p /opt/tool && echo v1 > /opt/tool/version', { root: true });
  const [, commitMs] = timed(() => docker(['commit', ws, `${P}-checkpoint:1`]));
  const chkHasRepo = docker(['run', '--rm', '--entrypoint', 'sh', `${P}-checkpoint:1`, '-c',
    'ls -A /workspace | wc -l; test -e /home/node/.claude/.credentials.json && echo cred || echo nocred']).out.split('\n');
  check(`docker commit of the workspace container holds neither the repo nor the login (commit ${commitMs} ms)`,
    chkHasRepo[0] === '0' && chkHasRepo[1] === 'nocred');

  // Open workstream a: copy volumes, run from checkpoint, branch.
  const [, copyMs] = timed(() => {
    copyVolume(`${P}-ws-repo`, `${P}-a-repo`);
    copyVolume(`${P}-ws-home`, `${P}-a-home`);
  });
  const [, runMs] = timed(() => runContainer(`${P}-a`, `${P}-checkpoint:1`, `${P}-a-repo`, `${P}-a-home`));
  console.log(`open workstream a: volume copy (${FILES} extra files) ${copyMs} ms, run ${runMs} ms`);
  const a = `${P}-a`;
  check('tool from the checkpoint is present in the workstream', sh(a, 'cat /opt/tool/version').out === 'v1');
  check('repo is copied, git works without safe.directory complaints',
    sh(a, 'cd /workspace && git status --porcelain && git log --oneline | wc -l', { allowFail: true }).out.endsWith('2'));
  check('owner, mode and symlink are kept',
    sh(a, 'cd /workspace && stat -c "%U %a" .gitignore && readlink link-to-ignore && stat -c "%U %a" /home/node/.claude/.credentials.json').out
      === 'node 755\n.gitignore\nnode 600');
  check(`all ${FILES} extra files are copied`, sh(a, 'find /workspace/node_modules -type f | wc -l').out === String(FILES));
  check('login file is copied into the workstream profile', sh(a, 'cat /home/node/.claude/.credentials.json').out === '{"t":"secret"}');

  sh(a, 'cd /workspace && git checkout -qb ws/a && echo a > a.txt && git add a.txt && git commit -qm a');
  check('file written in workstream a is absent in the workspace repo volume',
    sh(ws, 'test -e /workspace/a.txt && echo yes || echo no').out === 'no');
  sh(ws, 'cd /workspace && echo later > later.txt && git add later.txt && git commit -qm later');
  check('commit on the working branch after opening is absent in workstream a',
    sh(a, 'test -e /workspace/later.txt && echo yes || echo no').out === 'no');

  // Bundle back over exec stdout/stdin.
  const bundle = spawnSync('docker', ['exec', a, 'sh', '-c', 'cd /workspace && git bundle create - main..ws/a'], { maxBuffer: 64 * 1024 * 1024 });
  const fetch = spawnSync('docker', ['exec', '-i', ws, 'sh', '-c', 'cd /workspace && cat > /tmp/b.bundle && git fetch -q /tmp/b.bundle ws/a:ws/a && git merge -q --no-edit ws/a && rm /tmp/b.bundle'], { input: bundle.stdout, encoding: 'utf8' });
  check('bundle from the workstream volume merges into the workspace volume', fetch.status === 0
    && sh(ws, 'test -e /workspace/a.txt && echo yes').out === 'yes');

  // Upload / download through the archive endpoint (docker cp) into a path that is a volume.
  docker(['cp', `${__dirname}/README.md`, `${a}:/workspace/uploaded.md`]);
  check('docker cp writes into the volume-mounted repo', sh(a, 'test -s /workspace/uploaded.md && echo yes').out === 'yes');
  const dl = spawnSync('docker', ['cp', `${a}:/workspace/a.txt`, '-'], { maxBuffer: 1024 * 1024 });
  check('docker cp reads a file out of the volume as a tar stream', dl.status === 0 && dl.stdout.length > 0);

  // Close for now / reopen keeps volumes.
  docker(['stop', '-t', '1', a]);
  docker(['start', a]);
  check('stop/start keeps the workstream files', sh(a, 'cat /workspace/a.txt').out === 'a');

  console.log(`${passed}/${passed + failed} checks passed`);
}

try {
  main();
} catch (e) {
  console.error(e.message);
  failed++;
} finally {
  if (!keep) cleanup();
}
process.exitCode = failed ? 1 : 0;
