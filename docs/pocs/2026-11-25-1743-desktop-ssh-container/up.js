// PoC: bring up a container that Claude Desktop (Code tab) can open as an SSH environment.
// Usage (from this folder):
//   node up.js [--image debian|alpine] [--port 2222] [--mount <hostDir>[:ro]]... [--write-ssh-config]
//   node up.js --image debian --config-only    # keep the running container, only write ~/.ssh/config
// Only touches: Docker objects labelled poc=desktop-ssh, ./keys, ./out and (opt-in) a marked block
// in ~/.ssh/config (backed up first).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const KEY_DIR = path.join(HERE, 'keys');
const OUT_DIR = path.join(HERE, 'out');
const KEY = path.join(KEY_DIR, 'id_ed25519');
const LABEL = 'poc=desktop-ssh';

function parseArgs(argv) {
  const args = { image: 'debian', port: 0, mounts: [], writeSshConfig: false, configOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--image') args.image = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--mount') args.mounts.push(argv[++i]);
    else if (a === '--write-ssh-config') args.writeSshConfig = true;
    else if (a === '--config-only') { args.configOnly = true; args.writeSshConfig = true; }
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!['debian', 'alpine'].includes(args.image)) throw new Error('--image must be debian or alpine');
  if (!args.port) args.port = args.image === 'debian' ? 2222 : 2223;
  return args;
}

function run(cmd, cmdArgs, opts) {
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}

function docker(cmdArgs, opts) {
  return run('docker', cmdArgs, opts);
}

function execIn(name, user, script) {
  return docker(['exec', '-u', user, name, 'sh', '-c', script]);
}

function ensureKey() {
  fs.mkdirSync(KEY_DIR, { recursive: true });
  if (fs.existsSync(KEY)) return;
  run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'poc-desktop-ssh', '-f', KEY]);
  if (process.platform === 'win32') {
    // Windows OpenSSH refuses a private key readable by other accounts.
    run('icacls', [KEY, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`]);
  } else {
    fs.chmodSync(KEY, 0o600);
  }
}

function parseMount(spec) {
  let src = spec;
  let readonly = false;
  if (src.toLowerCase().endsWith(':ro')) {
    readonly = true;
    src = src.slice(0, -3);
  }
  src = path.resolve(src);
  if (!fs.existsSync(src)) throw new Error(`mount source does not exist: ${spec}`);
  let base = path.basename(src);
  if (!base) base = `drive-${src.charAt(0).toLowerCase()}`; // e.g. E:\ -> drive-e
  return { src, dst: `/mnt/host/${base}`, readonly };
}

// Pre-seeds the container's host key in a tool-owned known_hosts file, so Desktop never shows its
// "Trust and connect" prompt for this alias.
function writeKnownHosts(name) {
  const hostKey = docker(['exec', name, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']).trim().split(' ').slice(0, 2).join(' ');
  const file = path.join(KEY_DIR, `known_hosts_${name}`);
  fs.writeFileSync(file, `${name} ${hostKey}\n`, 'utf8');
  return file;
}

function sshConfigBlock(name, port, knownHostsFile) {
  const toSlash = (p) => p.split(path.sep).join('/');
  return [
    `# >>> ${name}`,
    `Host ${name}`,
    '  HostName 127.0.0.1',
    `  Port ${port}`,
    '  User claude',
    `  IdentityFile "${toSlash(KEY)}"`,
    '  IdentitiesOnly yes',
    `  HostKeyAlias ${name}`,
    `  UserKnownHostsFile "${toSlash(knownHostsFile)}"`,
    '  StrictHostKeyChecking yes',
    `# <<< ${name}`,
    '',
  ].join('\n');
}

function writeSshConfig(name, block) {
  const sshDir = path.join(os.homedir(), '.ssh');
  const cfg = path.join(sshDir, 'config');
  fs.mkdirSync(sshDir, { recursive: true });
  const current = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';
  if (current) fs.writeFileSync(`${cfg}.poc-backup-${Date.now()}`, current, 'utf8');
  const re = new RegExp(`# >>> ${name}[\\s\\S]*?# <<< ${name}\\r?\\n?`, 'g');
  const cleaned = current.replace(re, '');
  const sep = cleaned && !cleaned.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(cfg, `${cleaned}${sep}${block}`, 'utf8');
}

function selfCheck(name, port) {
  const known = path.join(OUT_DIR, 'known_hosts');
  const base = ['-i', KEY, '-p', String(port), '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${known}`, '-o', 'BatchMode=yes'];
  const shell = run('ssh', [...base, 'claude@127.0.0.1',
    'uname -sm; (ldd --version 2>&1 || true) | head -1; echo "shell=$SHELL"; df -h ~ | tail -1; ls /work/sample -a']);
  const sftpPort = ['-i', KEY, '-P', String(port), '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${known}`, '-b', '-'];
  const sftp = run('sftp', [...sftpPort, 'claude@127.0.0.1'], { input: 'pwd\nls /work/sample\n' });
  return `--- ssh ---\n${shell}--- sftp ---\n${sftp}`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const name = `poc-desk-${args.image}`;
  const image = `poc-desktop-ssh:${args.image}`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  ensureKey();

  const link = `claude://code/new?ssh_host=${name}&ssh_folder=${encodeURIComponent('/work/sample')}`;
  if (args.configOnly) {
    // Keep the running container (and the live Desktop session); only (re)write the ssh config.
    const block = sshConfigBlock(name, args.port, writeKnownHosts(name));
    writeSshConfig(name, block);
    process.stdout.write(`~/.ssh/config block written:\n${block}\nlink: ${link}\n`);
    process.exit(0);
  }

  process.stderr.write(`building ${image}...\n`);
  docker(['build', '-t', image, path.join(HERE, 'images', args.image)], { stdio: ['ignore', 'ignore', 'inherit'] });

  try { docker(['rm', '-f', name]); } catch { /* not running */ }
  const mounts = args.mounts.map(parseMount);
  const runArgs = ['run', '-d', '--name', name, '--label', LABEL, '-p', `127.0.0.1:${args.port}:22`];
  for (const m of mounts) {
    runArgs.push('--mount', `type=bind,src=${m.src},dst=${m.dst}${m.readonly ? ',readonly' : ''}`);
  }
  runArgs.push(image);
  docker(runArgs);

  // Key, sample folder (claude-config -> .claude), two git repos, user-level skill.
  docker(['cp', `${KEY}.pub`, `${name}:/home/claude/.ssh/authorized_keys`]);
  docker(['cp', path.join(HERE, 'sample'), `${name}:/work/`]);
  docker(['exec', name, 'mkdir', '-p', '/home/claude/.claude/skills']);
  docker(['cp', path.join(HERE, 'user-skills', 'poc-user-skill'), `${name}:/home/claude/.claude/skills/`]);
  execIn(name, 'root', [
    'mv /work/sample/claude-config /work/sample/.claude',
    'chown -R claude:claude /work /home/claude',
    'chmod 600 /home/claude/.ssh/authorized_keys',
  ].join(' && '));
  execIn(name, 'claude', [
    'for r in repo-a repo-b; do cd /work/sample/$r && git init -q -b main',
    'git -c user.name=poc -c user.email=poc@example.invalid add -A',
    'git -c user.name=poc -c user.email=poc@example.invalid commit -qm init; done',
  ].join(' && '));

  const mountLines = mounts.length
    ? mounts.map((m) => `- \`${m.dst}\` — host folder \`${path.basename(m.src) || m.src}\`, ${m.readonly ? 'read-only' : 'read-write (live)'}`).join('\n')
    : '- none';
  const claudeMd = [
    '# Workstream (PoC)',
    '',
    'You run inside an isolated container. The project copy is `/work/sample`.',
    'Host folders connected to this workstream:',
    mountLines,
    '',
  ].join('\n');
  const mdFile = path.join(OUT_DIR, `CLAUDE.${args.image}.md`);
  fs.writeFileSync(mdFile, claudeMd, 'utf8');
  docker(['cp', mdFile, `${name}:/home/claude/.claude/CLAUDE.md`]);
  execIn(name, 'root', 'chown -R claude:claude /home/claude/.claude');

  const report = selfCheck(name, args.port);
  const block = sshConfigBlock(name, args.port, writeKnownHosts(name));
  if (args.writeSshConfig) writeSshConfig(name, block);

  const linkNoAlias = `claude://code/new?ssh_host=${encodeURIComponent('claude@127.0.0.1')}&ssh_port=${args.port}&ssh_folder=${encodeURIComponent('/work/sample')}`;
  process.stdout.write([
    report,
    `container: ${name} (127.0.0.1:${args.port})`,
    '',
    args.writeSshConfig ? '~/.ssh/config block written:' : 'ssh config block (not written; pass --write-ssh-config):',
    block,
    `link (alias):    ${link}`,
    `link (no alias): ${linkNoAlias}`,
    `key for the Desktop "Add SSH connection" form: ${KEY}`,
    '',
  ].join('\n'));
  process.exit(0);
} catch (err) {
  process.stderr.write(`up.js error: ${err.message}\n${err.stderr || ''}\n`);
  process.exit(1);
}
