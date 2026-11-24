// PoC driver: plays the WH server (writes credentials / capabilities into the sidecar with
// `docker exec`) and the user / agent in the client container, and prints a PASS/FAIL line
// per check. Run from this folder: node run.cjs
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const COMPOSE = ['compose', '-f', path.join(__dirname, 'compose.yml')];
const results = [];

function docker(args, input) {
  const r = spawnSync('docker', args, { input: input || '', encoding: 'utf8', timeout: 600000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function exec(service, cmd, opts) {
  const o = opts || {};
  const args = [...COMPOSE, 'exec', '-T'];
  if (o.user) args.push('-u', o.user);
  args.push(service, 'sh', '-c', cmd);
  return docker(args, o.input);
}
function check(name, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n${detail ? `      ${detail.trim().split('\n').join('\n      ')}\n` : ''}`);
}
const side = (cmd, input) => exec('sidecar', cmd, { user: 'lighttpd', input });
const cli = (cmd) => exec('client', `cd /home/workhub && ${cmd}`);

try {
  let r = docker([...COMPOSE, 'up', '-d', '--build']);
  if (r.code !== 0) throw new Error(r.out);

  // --- Q: error message display in the git client --------------------------------------
  for (const kind of ['401', '403', 'err']) {
    r = cli(`git -c 'credential.helper=!f() { echo username=wh; echo password=x; }; f' ls-remote http://wh-git/msg/${kind}/x.git 2>&1`);
    check(`client shows message for ${kind}`, /MSG-/.test(r.out), r.out);
  }

  // --- conn c1: WH-generated SSH key, host key pinned ----------------------------------
  r = side('wh-git-ctl keygen workhub-c1');
  const priv = r.out.slice(0, r.out.indexOf('-----END OPENSSH PRIVATE KEY-----') + 34);
  const pub = r.out.split('\n').find((l) => l.startsWith('ssh-ed25519'));
  check('keygen returns private + public key', !!pub && priv.includes('BEGIN OPENSSH'), pub);
  exec('upstream', 'cat >> /home/git/.ssh/authorized_keys', { input: `${pub}\n` });
  r = side('wh-git-ctl scan upstream');
  check('host key scan shows fingerprint', /SHA256:/.test(r.out), r.out.split('\n').pop() || r.out);
  const knownHosts = r.out.split('\n').filter((l) => l.startsWith('upstream ')).join('\n');
  side('mkdir -p /run/wh/conns/c1 && umask 077 && cat > /run/wh/conns/c1/key', priv);
  side('cat > /run/wh/conns/c1/known_hosts', `${knownHosts}\n`);

  // --- conn c2: PAT over HTTP(S) ----------------------------------------------------------
  const basic = Buffer.from('x-access-token:secret-pat-1').toString('base64');
  side('mkdir -p /run/wh/conns/c2 && umask 077 && cat > /run/wh/conns/c2/header', `Authorization: Basic ${basic}`);

  // --- remotes + capability ---------------------------------------------------------------
  side('cat > /run/wh/remotes/r1', 'CONN=c1\nCONN_NAME=ssh-conn\nUPSTREAM=ssh://git@upstream/home/git/repo.git\nONLY_WS=0\n');
  side('cat > /run/wh/remotes/r2', 'CONN=c2\nCONN_NAME=pat-conn\nUPSTREAM=http://upstream/git/repo.git\nONLY_WS=0\n');
  side('cat > /run/wh/remotes/r3', 'CONN=c2\nCONN_NAME=pat-conn\nUPSTREAM=http://upstream/git/repo.git\nONLY_WS=0\n');
  const cap = crypto.randomBytes(32).toString('hex');
  const capHash = crypto.createHash('sha256').update(cap).digest('hex');
  side(`printf 'r1\\nr2\\n' > /run/wh/caps/${capHash}`);
  exec('client', 'umask 077 && cat > /tmp/wh-git-capability', { input: cap });

  // --- ls-remote from the server (dialog branch list), both transports ---------------------
  r = side('wh-git-ctl ls-remote c1 ssh://git@upstream/home/git/repo.git');
  check('ls-remote over SSH shows default branch symref', /ref: refs\/heads\/main\tHEAD/.test(r.out), r.out);
  r = side('wh-git-ctl ls-remote c2 http://upstream/git/repo.git');
  check('ls-remote over PAT shows branches', /refs\/heads\/dev/.test(r.out), r.out);

  // --- clone through the proxy with a credential helper reading /tmp ----------------------
  const helper = '!f() { test "$1" = get && printf "username=wh\\npassword=%s\\n" "$(cat /tmp/wh-git-capability)"; }; f';
  r = cli(`git -c 'credential.http://wh-git.helper=${helper}' clone --progress http://wh-git/git/r1.git repo 2>&1 && git -C repo config credential.http://wh-git.helper '${helper}' && git -C repo log --oneline && git -C repo branch -a`);
  check('clone through proxy (SSH upstream) with progress', /Receiving objects|readme/.test(r.out) && /readme/.test(r.out), r.out);
  r = cli('grep -c secret repo/.git/config; grep -rl "OPENSSH PRIVATE\\|secret-pat" / --exclude-dir=proc --exclude-dir=sys 2>/dev/null; env | grep -ci pat; true');
  check('no secret in client container (config / fs / env)', !/OPENSSH|secret-pat/.test(r.out.replace(/^0$/m, '')), r.out);

  // --- pushes and policy -------------------------------------------------------------------
  r = cli('cd repo && git switch -c ws/fix && git commit -q --allow-empty -m ws && git push origin ws/fix 2>&1');
  check('push new branch ws/fix', /\[new branch\]/.test(r.out), r.out);
  r = exec('upstream', 'git -C /home/git/repo.git branch');
  check('branch reached the real host', /ws\/fix/.test(r.out), r.out);
  r = cli('cd repo && git switch -q main && git commit -q --allow-empty -m ff && git push origin main 2>&1');
  check('fast-forward push to main', /main -> main/.test(r.out) && !/rejected/.test(r.out), r.out);
  r = cli('cd repo && git reset -q --hard HEAD~2 && git commit -q --allow-empty -m rewrite && git push --force origin main 2>&1');
  check('force push to default branch rejected readably', /force push to the default branch main is not allowed/.test(r.out), r.out);
  r = cli('cd repo && git push origin :main 2>&1');
  check('delete default branch rejected readably', /deleting the default branch/.test(r.out), r.out);
  r = cli('cd repo && git switch -q ws/fix && git commit -q --amend --allow-empty -m ws2 && git push --force origin ws/fix 2>&1');
  check('force push to a non-default branch allowed', /forced update/.test(r.out), r.out);
  r = cli('cd repo && head -c 3000000 /dev/urandom > big.bin && git add big.bin && git commit -q -m big && git push origin ws/fix 2>&1');
  check('3 MB push (chunked request body through lighttpd CGI)', /ws\/fix -> ws\/fix/.test(r.out) && !/error|rejected/.test(r.out), r.out);
  exec('upstream', 'cd /tmp && rm -rf c && git clone -q /home/git/repo.git c && cd c && git -c user.name=o -c user.email=o@x commit -q --allow-empty -m other && git push -q origin main');
  r = cli('cd repo && git switch -q main && git reset -q --hard origin/main && git commit -q --allow-empty -m stale && git push origin main 2>&1');
  check('stale push to main rejected (fetch first)', /rejected|fetch first|non-fast-forward/.test(r.out), r.out);

  // --- PAT remote r2 ------------------------------------------------------------------------
  r = cli(`git -c 'credential.http://wh-git.helper=${helper}' clone -q http://wh-git/git/r2.git repo2 2>&1 && cd repo2 && git config credential.http://wh-git.helper '${helper}' && git push origin HEAD:refs/heads/ws/pat 2>&1`);
  check('clone + push through PAT remote', /\[new branch\]/.test(r.out) && !/rejected/.test(r.out), r.out);

  // --- scope / revocation -------------------------------------------------------------------
  r = cli(`git -c 'credential.http://wh-git.helper=${helper}' ls-remote http://wh-git/git/r3.git 2>&1`);
  check('remote not in this capability rejected', /no grant/.test(r.out), r.out);
  r = cli('git -c "credential.http://wh-git.helper=!f() { echo username=wh; echo password=bogus; }; f" ls-remote http://wh-git/git/r1.git 2>&1');
  check('unknown capability rejected', /Authentication failed|revoked/.test(r.out), r.out);
  exec('upstream', 'echo secret-pat-2 > /etc/pat');
  r = cli('cd repo2 && git fetch 2>&1');
  check('revoked PAT -> "rejected by the host" message', /rejected by the host/.test(r.out), r.out);
  exec('upstream', 'rm -f /etc/ssh/ssh_host_*; ssh-keygen -A && pkill sshd; sleep 1; /usr/sbin/sshd -e');
  r = cli('cd repo && git fetch 2>&1');
  check('changed host key -> readable message', /host key of the git host changed/.test(r.out), r.out);
  side('rm -rf /run/wh/conns/c1');
  r = cli('cd repo && git fetch 2>&1');
  check('deleted connection -> readable message', /was deleted/.test(r.out), r.out);

  // --- uploaded key with passphrase ---------------------------------------------------------
  r = side('t=$(mktemp -d) && ssh-keygen -q -t ed25519 -N pw123 -f $t/k && cat $t/k | wh-git-ctl strip-passphrase pw123');
  check('uploaded key: passphrase stripped, public key derived', /BEGIN OPENSSH/.test(r.out) && /ssh-ed25519/.test(r.out), r.out.split('\n').pop());

  docker([...COMPOSE, 'down', '-v']);
  process.stdout.write(`\n${results.join('\n')}\n`);
  process.exit(results.some((l) => l.startsWith('FAIL')) ? 1 : 0);
} catch (err) {
  process.stderr.write(`poc error: ${err.message}\n`);
  process.exit(1);
}
