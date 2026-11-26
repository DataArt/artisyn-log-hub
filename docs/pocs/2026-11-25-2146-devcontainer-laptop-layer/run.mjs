// PoC: laptop layer as a local devcontainer Feature injected through --override-config.
// Usage (from this folder, after `npm install`):
//   node run.mjs --variant debian|alpine [--port 2241]
//   node run.mjs --api-bind          # Engine API over the named pipe with a Windows bind path
//   node run.mjs --down              # remove every Docker object labelled poc=dc-laptop
// Only touches Docker objects labelled poc=dc-laptop and the ignored ./keys and ./out folders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LABEL = 'poc=dc-laptop';
const DC = path.join(HERE, 'node_modules', '@devcontainers', 'cli', 'devcontainer.js');
const GIVEN = path.join(HERE, 'fixtures', 'given Ж');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}
function tryRun(cmd, args, opts = {}) {
  try { return { ok: true, out: run(cmd, args, opts) }; } catch (e) { return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` }; }
}
const log = (title, body) => process.stdout.write(`\n=== ${title} ===\n${typeof body === 'string' ? body : JSON.stringify(body, null, 2)}\n`);

function keygen(file, comment) {
  if (fs.existsSync(file)) return;
  run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', comment, '-f', file]);
  if (process.platform === 'win32') run('icacls', [file, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`]);
}

function down() {
  const ids = run('docker', ['ps', '-aq', '--filter', `label=${LABEL}`]).split(/\s+/).filter(Boolean);
  for (const id of ids) tryRun('docker', ['rm', '-f', id]);
  for (const v of ['poc-dc-home-debian', 'poc-dc-home-alpine']) tryRun('docker', ['volume', 'rm', v]);
  log('down', `removed ${ids.length} container(s) and the two PoC volumes`);
}

// Docker Engine API over the Docker Desktop named pipe, with a Windows path as bind source.
function api(method, apiPath, body) {
  const ctx = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.docker', 'config.json'), 'utf8')).currentContext || 'default';
  let pipe = '\\\\.\\pipe\\docker_engine';
  if (ctx !== 'default') {
    const { createHash } = awaitCrypto;
    const meta = path.join(os.homedir(), '.docker', 'contexts', 'meta', createHash('sha256').update(ctx).digest('hex'), 'meta.json');
    const host = JSON.parse(fs.readFileSync(meta, 'utf8')).Endpoints.docker.Host; // npipe:////./pipe/<name>
    pipe = `\\\\.\\pipe\\${host.split('/pipe/')[1]}`;
  }
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ socketPath: pipe, method, path: apiPath, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const awaitCrypto = await import('node:crypto');

async function apiBind() {
  const create = await api('POST', '/v1.43/containers/create', {
    Image: 'alpine:3.20', Cmd: ['sh', '-c', 'ls -la "/work/given/given Ж"; echo from-api > "/work/given/given Ж/api.txt"'],
    Labels: { poc: 'dc-laptop' },
    HostConfig: { Binds: [`${GIVEN}:/work/given/given Ж`] },
  });
  log('api create', create);
  const id = JSON.parse(create.body).Id;
  await api('POST', `/v1.43/containers/${id}/start`);
  await api('POST', `/v1.43/containers/${id}/wait`);
  log('api container output', run('docker', ['logs', id]));
  log('host sees api.txt', fs.readFileSync(path.join(GIVEN, 'api.txt'), 'utf8'));
  fs.rmSync(path.join(GIVEN, 'api.txt'));
}

function sshBase(keyDir, port) {
  return ['-i', path.join(keyDir, 'id_ed25519'), '-p', String(port), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlias=poc-dc', '-o', `UserKnownHostsFile=${path.join(keyDir, 'known_hosts').split(path.sep).join('/')}`];
}

async function variant(name, port) {
  const ws = path.join(HERE, `sample-${name}`);
  const keyDir = path.join(HERE, 'keys', name);
  const hostKeyDir = path.join(keyDir, 'mount');
  fs.mkdirSync(hostKeyDir, { recursive: true });
  keygen(path.join(keyDir, 'id_ed25519'), 'poc-client');
  keygen(path.join(hostKeyDir, 'ssh_host_ed25519_key'), 'poc-host');
  fs.copyFileSync(path.join(keyDir, 'id_ed25519.pub'), path.join(hostKeyDir, 'authorized_keys'));
  const hostPub = fs.readFileSync(path.join(hostKeyDir, 'ssh_host_ed25519_key.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
  fs.writeFileSync(path.join(keyDir, 'known_hosts'), `poc-dc ${hostPub}\n`);

  // 1. What the devcontainer CLI resolves (user, workspace folder, env) before anything is built.
  const rc = JSON.parse(run('node', [DC, 'read-configuration', '--workspace-folder', ws, '--include-merged-configuration']));
  const cfgFile = rc.configuration.configFilePath.fsPath || rc.configuration.configFilePath.path;
  log('read-configuration (selected keys)', {
    configFile: path.relative(HERE, cfgFile), workspaceFolder: rc.workspace?.workspaceFolder,
    remoteUser: rc.mergedConfiguration?.remoteUser, containerUser: rc.mergedConfiguration?.containerUser,
    containerEnv: rc.mergedConfiguration?.containerEnv, remoteEnv: rc.mergedConfiguration?.remoteEnv,
  });
  const sshUser = rc.mergedConfiguration?.remoteUser || rc.mergedConfiguration?.containerUser || 'claude';
  const home = sshUser === 'root' ? '/root' : `/home/${sshUser}`;

  // 2a. Build the project's Equipment exactly as the devcontainer CLI does (Dockerfile + features).
  const baseImage = `poc-dc-base:${name}`;
  const layerImage = `poc-dc-layer:${name}`;
  let t0 = Date.now();
  const build = tryRun('node', [DC, 'build', '--workspace-folder', ws, '--image-name', baseImage]);
  log(`devcontainer build (${Date.now() - t0} ms, ok=${build.ok})`, build.out.split('\n').filter((l) => /outcome|rror/.test(l)).slice(-5).join('\n'));
  if (!build.ok) return;
  // 2b. Laptop layer on top; its entrypoint is appended to the image's devcontainer.metadata label,
  //     so `devcontainer up` chains it into the container command (survives docker start/restart).
  const metaRaw = run('docker', ['image', 'inspect', '-f', '{{index .Config.Labels "devcontainer.metadata"}}', baseImage]).trim();
  const meta = metaRaw && metaRaw !== '<no value>' ? JSON.parse(metaRaw) : [];
  const metaOut = [...(Array.isArray(meta) ? meta : [meta]), { id: 'agentbook-laptop', entrypoint: '/usr/local/share/agentbook/entry.sh' }];
  log('base image devcontainer.metadata', metaRaw.slice(0, 600));
  t0 = Date.now();
  const layer = tryRun('docker', ['build', '-q', '--build-arg', `BASE=${baseImage}`, '--build-arg', `SSHUSER=${sshUser}`,
    '--label', `devcontainer.metadata=${JSON.stringify(metaOut)}`, '--label', LABEL, '-t', layerImage, path.join(HERE, 'laptop-layer')]);
  log(`laptop layer build (${Date.now() - t0} ms, ok=${layer.ok})`, layer.out.slice(-800));
  if (!layer.ok) return;

  // 2c. Generated override config: only what the image's devcontainer.metadata label does NOT carry
  //     (lifecycle commands, env, users and the project's mounts are in the label already; repeating
  //     them runs postCreateCommand twice). The tool's own run args and mounts are added on top.
  const outDc = path.join(HERE, 'out', name);
  fs.rmSync(outDc, { recursive: true, force: true });
  fs.mkdirSync(outDc, { recursive: true });
  const original = rc.configuration;
  const gen = { name: original.name, image: layerImage };
  if (original.workspaceMount) {
    gen.workspaceMount = original.workspaceMount;
    gen.workspaceFolder = original.workspaceFolder;
  } else {
    gen.workspaceMount = `source=${ws},target=/work/${path.basename(ws)},type=bind`;
    gen.workspaceFolder = original.workspaceFolder && process.env.KEEP_WSF ? original.workspaceFolder : `/work/${path.basename(ws)}`;
  }
  gen.runArgs = [...(original.runArgs || []), '-p', `127.0.0.1:${port}:22`, '--tmpfs', '/run/agentbook', '--label', LABEL];
  gen.mounts = [
    `source=poc-dc-home-${name},target=${home},type=volume`,
    `source=${hostKeyDir},target=/opt/agentbook/key,type=bind,readonly`,
    `source=${GIVEN},target=/work/given/given Ж,type=bind`];
  if (original.dockerComposeFile) {
    // Compose: keep the project's compose files, add a tool compose file that swaps the primary
    // service's image for the layered one and adds the tool's ports, tmpfs, volumes and label.
    const cfgDir = path.dirname(cfgFile);
    const files = [].concat(original.dockerComposeFile).map((f) => path.resolve(cfgDir, f));
    const toolCompose = path.join(outDc, 'agentbook-compose.yml');
    const vol = `poc-dc-home-${name}`;
    fs.writeFileSync(toolCompose, [
      'services:',
      `  ${original.service}:`,
      `    image: ${layerImage}`,
      `    ports: ["127.0.0.1:${port}:22"]`,
      '    tmpfs: ["/run/agentbook"]',
      '    labels: { poc: dc-laptop }',
      '    volumes:',
      `      - "${vol}:${home}"`,
      `      - "${hostKeyDir.split(path.sep).join('/')}:/opt/agentbook/key:ro"`,
      `      - "${GIVEN.split(path.sep).join('/')}:/work/given/given Ж"`,
      'volumes:',
      `  ${vol}: { name: ${vol} }`,
      '',
    ].join('\n'));
    for (const k of ['image', 'workspaceMount', 'runArgs', 'mounts']) delete gen[k];
    Object.assign(gen, { dockerComposeFile: [...files, toolCompose], service: original.service, workspaceFolder: original.workspaceFolder });
    if (original.runServices) gen.runServices = original.runServices;
  }
  const genFile = path.join(outDc, 'devcontainer.json');
  fs.writeFileSync(genFile, JSON.stringify(gen, null, 2));

  // 3. devcontainer up with the override config.
  t0 = Date.now();
  const up = tryRun('node', [DC, 'up', '--workspace-folder', ws, '--override-config', genFile, '--id-label', `poc.slot=${name}`, '--id-label', LABEL, '--remove-existing-container']);
  log(`devcontainer up (${Date.now() - t0} ms, ok=${up.ok})`, up.out.split('\n').filter((l) => /outcome|error|Error|containerId|agentbook/.test(l)).slice(-15).join('\n'));
  if (!up.ok) return;
  const cid = JSON.parse(up.out.trim().split('\n').pop()).containerId;
  const wsFolder = JSON.parse(up.out.trim().split('\n').pop()).remoteWorkspaceFolder;
  log('container', { cid: cid.slice(0, 12), wsFolder, inspectEntrypoint: run('docker', ['inspect', '-f', '{{json .Config.Entrypoint}} {{json .Config.Cmd}}', cid]).trim() });

  // 4. Variables delivered to SSH sessions: tool writes a tmpfs env file over docker exec stdin.
  const env = { JIRA_URL: 'https://jira.example.invalid', JIRA_PAT: "s3cr3t 'quoted' $x", FROM_REMOTE: 'r1' };
  const envText = Object.entries(env).map(([k, v]) => `${k}='${v.replaceAll("'", "'\\''")}'`).join('\n') + '\n';
  run('docker', ['exec', '-i', '-u', 'root', cid, 'sh', '-c', `umask 077; mkdir -p /run/agentbook/env && chown ${sshUser} /run/agentbook/env; cat > /run/agentbook/env/session.env.tmp && chown ${sshUser} /run/agentbook/env/session.env.tmp && mv /run/agentbook/env/session.env.tmp /run/agentbook/env/session.env`], { input: envText });
  log('env file location', run('docker', ['exec', cid, 'sh', '-c', 'df -h /run/agentbook | tail -1; ls -l /run/agentbook/env']));

  // 5. SSH exec, sftp, password refusal.
  const target = `${sshUser}@127.0.0.1`;
  log('ssh exec', tryRun('ssh', [...sshBase(keyDir, port), target,
    `id; echo JIRA_URL=$JIRA_URL; echo JIRA_PAT=$JIRA_PAT; echo FROM_REMOTE=$FROM_REMOTE; echo postcreate-lines=$(wc -l < /tmp/postcreate.ok); cat /etc/os-release | head -1; ls "${wsFolder}"; ls "/work/given/given Ж"; echo by-ssh > "${wsFolder}/ssh-made.txt"; command -v jq || true`]).out);
  log('sftp', tryRun('sftp', ['-i', path.join(keyDir, 'id_ed25519'), '-P', String(port), '-o', 'IdentitiesOnly=yes', '-o', 'HostKeyAlias=poc-dc',
    '-o', `UserKnownHostsFile=${path.join(keyDir, 'known_hosts').split(path.sep).join('/')}`, '-b', '-', target], { input: `pwd\nls ${wsFolder}\n` }).out);
  log('password login refused', tryRun('ssh', ['-p', String(port), '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', target, 'true']).out.trim());
  const made = path.join(ws, 'ssh-made.txt');
  log('host sees file made over ssh', `${fs.readFileSync(made, 'utf8').trim()}; can delete: ${(() => { fs.rmSync(made); return !fs.existsSync(made); })()}`);

  // 6. Session count from /proc/net/tcp while one ssh session is held open.
  const held = spawn('ssh', [...sshBase(keyDir, port), target, 'sleep 6'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
  const count = (await countSessions(cid));
  held.kill();
  await new Promise((r) => setTimeout(r, 1500));
  log('session count (held / after)', `${count} / ${await countSessions(cid)}`);

  // 7. Restart outside the tool: sshd back, same host key, no fingerprint change.
  run('docker', ['restart', cid]);
  await new Promise((r) => setTimeout(r, 2000));
  log('after docker restart', tryRun('ssh', [...sshBase(keyDir, port), target, 'echo reconnected; ls /run/agentbook; cat /tmp/poststart.log 2>/dev/null | wc -l']).out);
}

function countSessions(cid) {
  // ESTABLISHED (state 01) sockets whose local port is 22 (0x0016), IPv4 and IPv6; plain sh + cat only.
  const out = run('docker', ['exec', cid, 'sh', '-c', 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null']);
  return out.split('\n').filter((l) => { const f = l.trim().split(/\s+/); return f[1]?.endsWith(':0016') && f[3] === '01'; }).length;
}

const argv = process.argv.slice(2);
if (argv.includes('--down')) down();
else if (argv.includes('--api-bind')) await apiBind();
else {
  const name = argv[argv.indexOf('--variant') + 1];
  if (!['debian', 'alpine', 'compose'].includes(name)) throw new Error('--variant debian|alpine|compose');
  const port = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : ({ debian: 2241, alpine: 2242, compose: 2243 })[name];
  await variant(name, port);
}
