// PoC cleanup: remove the PoC containers (label poc=desktop-ssh) and the marked blocks from
// ~/.ssh/config that up.js --write-ssh-config added. Keys in ./keys are left in place (git-ignored).
// Usage: node down.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

try {
  const ids = execFileSync('docker', ['ps', '-aq', '--filter', 'label=poc=desktop-ssh'], { encoding: 'utf8' })
    .split(/\s+/).filter(Boolean);
  if (ids.length) execFileSync('docker', ['rm', '-f', ...ids], { encoding: 'utf8' });
  process.stdout.write(`removed containers: ${ids.length}\n`);

  const cfg = path.join(os.homedir(), '.ssh', 'config');
  if (fs.existsSync(cfg)) {
    const current = fs.readFileSync(cfg, 'utf8');
    const cleaned = current.replace(/# >>> poc-desk-[a-z]+[\s\S]*?# <<< poc-desk-[a-z]+\r?\n?/g, '');
    if (cleaned !== current) {
      fs.writeFileSync(cfg, cleaned, 'utf8');
      process.stdout.write('removed PoC blocks from ~/.ssh/config\n');
    }
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`down.js error: ${err.message}\n`);
  process.exit(1);
}
