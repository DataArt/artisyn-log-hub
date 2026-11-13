'use strict';
// PoC: branch a workstream container off a workspace container with `docker commit`, check
// what is inherited and what is isolated, then bring the workstream's work back with a git
// bundle piped through `docker exec` (no network between containers) and merge it.
//
// Creates only docker objects named wh-poc-br-* and removes them at the end (--keep to leave).

const { execFileSync, spawnSync } = require('child_process');

const IMAGE = 'workhub-poc-branch';
const WS = 'wh-poc-br-ws';
const VOL = 'wh-poc-br-vol';
const REPO = '/workspace/repo';
const keep = process.argv.includes('--keep');
const results = [];

function docker(args, opts = {}) {
  return execFileSync('docker', args, { encoding: opts.binary ? null : 'utf8', input: opts.input,
    maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}

function sh(container, script, opts = {}) {
  const args = ['exec', '-i'];
  if (opts.root) args.push('-u', 'root');
  args.push(container, 'sh', '-c', script);
  return docker(args, opts);
}

function tryDocker(args) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}\n`);
}

function timed(fn) {
  const t = process.hrtime.bigint();
  const r = fn();
  return { r, ms: Number((process.hrtime.bigint() - t) / 1000000n) };
}

function cleanup() {
  for (const c of [WS, `${WS}-a`, `${WS}-b`]) tryDocker(['rm', '-f', c]);
  for (const i of [`${IMAGE}-snap:a`, `${IMAGE}-snap:b`]) tryDocker(['rmi', '-f', i]);
  tryDocker(['volume', 'rm', '-f', VOL]);
}

/** Opens a workstream: snapshot of the workspace container -> new container -> worktree. */
function openWorkstream(name) {
  const snap = `${IMAGE}-snap:${name}`;
  const commit = timed(() => docker(['commit', WS, snap]));
  const run = timed(() => docker(['run', '-d', '--name', `${WS}-${name}`, '-v', `${VOL}:/data`, snap]));
  const wt = timed(() => sh(`${WS}-${name}`,
    `git -C ${REPO} worktree add -q -b ws/${name} /workspace/worktrees/${name} main`));
  process.stdout.write(`      open workstream ${name}: commit ${commit.ms} ms, run ${run.ms} ms, worktree ${wt.ms} ms\n`);
  return `${WS}-${name}`;
}

try {
  cleanup();

  // --- workspace container: repo on the working branch, a tool installed, a fake Claude login
  docker(['run', '-d', '--name', WS, '-v', `${VOL}:/data`, IMAGE]);
  sh(WS, `git init -q ${REPO} && cd ${REPO} && echo "# Expenses dashboard" > README.md && ` +
    'echo "a,b" > data.csv && git add -A && git commit -qm "initial"');
  sh(WS, 'printf "#!/bin/sh\\necho tool-ok\\n" > /usr/local/bin/mytool && chmod +x /usr/local/bin/mytool', { root: true });
  sh(WS, 'mkdir -p ~/.claude && echo \'{"fake":"login"}\' > ~/.claude/.credentials.json');
  sh(WS, 'echo in-volume > /data/volume-file.txt');

  // --- branch two workstreams off it
  const a = openWorkstream('a');
  // a change on the working branch after workstream a was opened
  sh(WS, `cd ${REPO} && echo late > late-on-main.txt && git add -A && git commit -qm "late"`);
  const b = openWorkstream('b');

  // AC-3: what is inherited
  check('tool installed in workspace container is present in workstream', sh(a, 'mytool').trim() === 'tool-ok');
  check('Claude login file is inherited by the workstream container',
    sh(a, 'cat ~/.claude/.credentials.json').includes('fake'));
  check('file committed on main after opening is absent in workstream a',
    sh(a, `test -e /workspace/worktrees/a/late-on-main.txt && echo yes || echo no`).trim() === 'no');
  check('workstream b (opened later) does see it',
    sh(b, `test -e /workspace/worktrees/b/late-on-main.txt && echo yes || echo no`).trim() === 'yes');

  // Volumes are NOT part of `docker commit`: the same named volume is simply shared.
  sh(a, 'echo from-a > /data/written-by-a.txt');
  check('a named volume is shared, not branched (data written in a is visible in b) — keep repo/home out of volumes',
    sh(b, 'test -e /data/written-by-a.txt && echo yes || echo no').trim() === 'yes');

  // AC-4: isolation of files and processes between workstreams and the workspace
  sh(a, 'echo secret > /workspace/worktrees/a/only-a.txt');
  sh(a, 'nohup sleep 1234 >/dev/null 2>&1 &');
  check('file written in a is absent in b and in the workspace',
    sh(b, 'ls /workspace/worktrees/a 2>/dev/null; test -e /workspace/worktrees/b/only-a.txt && echo yes || echo no').includes('no') &&
    sh(WS, `test -e ${REPO}/only-a.txt && echo yes || echo no`).trim() === 'no');
  check('process started in a is invisible in b and in the workspace',
    sh(a, 'ps -eo args').includes('sleep 1234') && !sh(b, 'ps -eo args').includes('sleep 1234') &&
    !sh(WS, 'ps -eo args').includes('sleep 1234'));

  // --- close a with "keep": commit everything, bring the branch home as a bundle, merge
  sh(a, 'cd /workspace/worktrees/a && echo "total,42" > report.csv && git add -A && git commit -qm "workstream a"');
  const bundle = timed(() => sh(a, `git -C ${REPO} bundle create - main..ws/a 2>/dev/null`, { binary: true }));
  docker(['exec', '-i', WS, 'sh', '-c', 'cat > /tmp/ws-a.bundle'], { input: bundle.r });
  sh(WS, `git -C ${REPO} fetch -q /tmp/ws-a.bundle ws/a:ws/a`);
  check(`branch ws/a transferred to the workspace repo via bundle (${bundle.r.length} bytes, ${bundle.ms} ms)`,
    sh(WS, `git -C ${REPO} log --oneline ws/a -1`).includes('workstream a'));
  const merge = spawnSync('docker', ['exec', WS, 'sh', '-c', `cd ${REPO} && git merge --no-ff -q -m "merge ws/a" ws/a`],
    { encoding: 'utf8' });
  check('merge of ws/a into main (main moved on meanwhile, no conflict) succeeds',
    merge.status === 0 && sh(WS, `cat ${REPO}/report.csv`).includes('42'));

  // --- conflict case: b and a hand edit on main change the same line
  sh(b, 'cd /workspace/worktrees/b && echo "# Dashboard by b" > README.md && git commit -qam "b edits readme"');
  sh(WS, `cd ${REPO} && echo "# Dashboard edited by hand" > README.md && git commit -qam "hand edit"`);
  const bundleB = sh(b, `git -C ${REPO} bundle create - main..ws/b 2>/dev/null`, { binary: true });
  docker(['exec', '-i', WS, 'sh', '-c', 'cat > /tmp/ws-b.bundle'], { input: bundleB });
  sh(WS, `git -C ${REPO} fetch -q /tmp/ws-b.bundle ws/b:ws/b`);
  const mergeB = spawnSync('docker', ['exec', WS, 'sh', '-c', `cd ${REPO} && git merge --no-ff -q -m "merge ws/b" ws/b`],
    { encoding: 'utf8' });
  sh(WS, `cd ${REPO} && git merge --abort 2>/dev/null; true`);
  check('conflicting merge is detected and can be aborted cleanly (branch kept)',
    mergeB.status !== 0 && sh(WS, `cd ${REPO} && git status --porcelain`).trim() === '' &&
    sh(WS, `git -C ${REPO} branch --list ws/b`).includes('ws/b'));

  // --- close (stop) and reopen a: files kept, processes gone
  docker(['stop', '-t', '1', a]);
  docker(['start', a]);
  check('reopened workstream keeps its files', sh(a, 'test -e /workspace/worktrees/a/only-a.txt && echo yes').trim() === 'yes');
  check('reopened workstream has no old processes (the agent must be restarted, e.g. with --continue)',
    !sh(a, 'ps -eo args').includes('sleep 1234'));

  // --- checkpoint of the workspace container after a "configuration" change: is it a full copy?
  sh(WS, 'dd if=/dev/urandom of=/usr/local/lib/config-blob bs=1M count=20 2>/dev/null', { root: true });
  const cp = timed(() => docker(['commit', WS, `${IMAGE}-snap:checkpoint`]));
  const layers = docker(['history', '--format', '{{.Size}}', `${IMAGE}-snap:checkpoint`]).trim().split('\n');
  const baseLayers = docker(['history', '--format', '{{.Size}}', IMAGE]).trim().split('\n').length;
  process.stdout.write(`      checkpoint after installing 20 MB: commit ${cp.ms} ms, new layers on top of the ` +
    `${baseLayers}-layer base: ${layers.slice(0, layers.length - baseLayers).join(', ')}\n`);
  check('a checkpoint stores only the changes (new top layer ~ size of the change), not a copy of the image',
    layers.length > baseLayers && /^2\d(\.\d+)?MB$/.test(layers[0]), `top layer ${layers[0]}`);
  tryDocker(['rmi', '-f', `${IMAGE}-snap:checkpoint`]);

  // --- cost of a workstream
  const sizes = docker(['ps', '-a', '-s', '--filter', `name=${WS}`, '--format', '{{.Names}}\t{{.Size}}']).trim();
  const snapSize = docker(['image', 'ls', `${IMAGE}-snap`, '--format', '{{.Tag}}\t{{.Size}}']).trim();
  process.stdout.write(`\ncontainer sizes (writable layer, virtual):\n${sizes}\nsnapshot images:\n${snapSize}\n`);

  // --- discard b: container and snapshot go, the workspace repo is untouched except ws/b ref
  tryDocker(['rm', '-f', b]);
  tryDocker(['rmi', '-f', `${IMAGE}-snap:b`]);
  sh(WS, `git -C ${REPO} branch -D ws/b`);
  check('discard removes container, snapshot and branch',
    tryDocker(['inspect', b]).status !== 0 && !sh(WS, `git -C ${REPO} branch`).includes('ws/b'));

  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
  if (!keep) cleanup();
  process.exit(failed ? 1 : 0);
} catch (err) {
  process.stderr.write(`branching PoC error: ${err.message}\n${err.stderr || ''}\n`);
  if (!keep) cleanup();
  process.exit(1);
}
