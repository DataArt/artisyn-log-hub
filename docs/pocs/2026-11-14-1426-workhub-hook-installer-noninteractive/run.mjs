// Runs the Log Hub hook installer the way Work Hub would: `docker exec` with no stdin and no TTY,
// as the container user in /workspace/repo, key passed through the exec env. One container per case.
// Usage: node run.mjs <image> <serve-port> [case-prefix]   (serve.mjs must already listen on <serve-port>)
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [image, port] = process.argv.slice(2);
if (!image || !port) {
  console.error('usage: node run.mjs <image> <serve-port>');
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'results');
mkdirSync(outDir, { recursive: true });
const KEY = 'pocKEY-7f3a9c1e5b';
const LIVE = `http://host.docker.internal:${port}`;

// Second round: npm env that drops the ~70 s fetch retries and the npm debug log (which records argv).
const QUIET = ['npm_config_fetch_retries=0', 'npm_config_logs_max=0', 'npm_config_update_notifier=false'];
const all = [
  { name: 'A-no-claude-dir', url: LIVE, claudeDir: false },
  { name: 'B-claude-settings', url: LIVE, claudeDir: true },
  { name: 'C-refused-port', url: 'http://host.docker.internal:1', claudeDir: true },
  { name: 'D-unknown-host', url: 'http://loghub.invalid:3000', claudeDir: true },
  { name: 'E-quiet-ok', url: LIVE, claudeDir: true, env: QUIET },
  { name: 'F-quiet-refused', url: 'http://host.docker.internal:1', claudeDir: true, env: QUIET },
  { name: 'G-quiet-404', url: `${LIVE}/not-log-hub`, claudeDir: true, env: QUIET },
];
const only = process.argv[4];
const cases = only ? all.filter(k => k.name.startsWith(only)) : all;

function docker(args, timeoutMs = 60_000) {
  const t0 = Date.now();
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs });
  return { code: r.status, timedOut: r.error?.code === 'ETIMEDOUT', ms: Date.now() - t0, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const sh = (c, script, timeoutMs) => docker(['exec', '-w', '/workspace/repo', c, 'sh', '-c', script], timeoutMs);

const summary = [];
for (const k of cases) {
  const c = `poc-installer-${k.name.toLowerCase()}`;
  docker(['rm', '-f', c]);
  docker(['run', '-d', '--name', c, '--add-host', 'host.docker.internal:host-gateway', image]);
  docker(['exec', '-u', 'root', c, 'sh', '-c', 'mkdir -p /workspace/repo && chown workhub:workhub /workspace/repo']);
  sh(c, 'git init -q && git config user.email poc@example.invalid && git config user.name poc');
  sh(c, "printf 'node_modules/\\n' > .gitignore");
  if (k.claudeDir) sh(c, "mkdir -p .claude && printf '{}\\n' > .claude/settings.json");

  const install = docker([
    'exec', '-w', '/workspace/repo', '-e', `LH_URL=${k.url}`, '-e', `LH_KEY=${KEY}`,
    ...(k.env ?? []).flatMap(e => ['-e', e]), c,
    'sh', '-c', 'npx --yes "$LH_URL/static/artisyn-hooks-installer.tgz" install --server-url "$LH_URL" --api-key "$LH_KEY"',
  ], 300_000);

  const after = sh(c, [
    'echo "--- status before add"; git status --porcelain',
    'git add -A; git commit -qm "Start workspace"',
    'echo "--- status after commit"; git status --porcelain',
    'echo "--- tracked files"; git ls-files',
    'echo "--- key in tracked content"; git grep -c "' + KEY + '" HEAD || echo none',
    'echo "--- key anywhere in repo"; grep -rl "' + KEY + '" . --exclude-dir=.git || echo none',
    'echo "--- key in home"; grep -rl "' + KEY + '" "$HOME" 2>/dev/null || echo none',
    'echo "--- node processes"; ps -eo pid,args | grep [n]ode || echo none',
  ].join('; '));

  const keyInOutput = (install.out + install.err).includes(KEY);
  const rec = { case: k.name, exit: install.code, timedOut: install.timedOut, ms: install.ms, keyInInstallerOutput: keyInOutput };
  summary.push(rec);
  writeFileSync(join(outDir, `${k.name}.txt`),
    `${JSON.stringify(rec, null, 2)}\n\n=== installer stdout\n${install.out}\n=== installer stderr\n${install.err}\n\n=== after\n${after.out}${after.err}`);
  docker(['rm', '-f', c]);
  console.log(JSON.stringify(rec));
}
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
