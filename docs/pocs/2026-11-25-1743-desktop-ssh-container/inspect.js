// PoC: show what Claude Desktop put into a container after an SSH session (names and sizes only,
// never file contents — the sign-in may live there).
// Usage: node inspect.js [--image debian|alpine]
'use strict';

const { execFileSync } = require('child_process');

function parseImage(argv) {
  const i = argv.indexOf('--image');
  return i === -1 ? 'debian' : argv[i + 1];
}

function sh(name, script) {
  try {
    return execFileSync('docker', ['exec', '-u', 'claude', name, 'sh', '-c', script], { encoding: 'utf8' });
  } catch (err) {
    return `(failed: ${err.message.split('\n')[0]})\n`;
  }
}

try {
  const name = `poc-desk-${parseImage(process.argv.slice(2))}`;
  const sections = [
    ['~/.claude tree (depth 3)', 'cd ~ && find .claude -maxdepth 3 | sort | head -200'],
    ['~/.claude/remote sizes', 'du -sh ~/.claude/remote/* 2>/dev/null || echo "(no ~/.claude/remote)"'],
    ['credential-like files (names only)', 'find ~ -maxdepth 4 \\( -iname "*cred*" -o -iname "*token*" -o -iname "*auth*" \\) 2>/dev/null'],
    ['claude processes', 'ps -eo pid,user,args | grep -i claude | grep -v grep || true'],
    ['claude env var NAMES', 'for p in $(pgrep -u claude -f claude 2>/dev/null); do tr "\\0" "\\n" < /proc/$p/environ 2>/dev/null | cut -d= -f1; done | sort -u | grep -iE "anthropic|claude|token|key" || true'],
    ['/work/sample listing', 'ls -la /work/sample'],
    ['git worktrees per repo', 'for r in /work/sample/repo-a /work/sample/repo-b; do echo "$r:"; git -C $r worktree list; done'],
    ['worktree dirs Desktop may have created', 'find /work ~ -maxdepth 4 -type d -name "*worktree*" 2>/dev/null'],
    ['/mnt/host', 'ls -la /mnt/host 2>/dev/null || echo "(no mounts)"'],
  ];
  for (const [title, script] of sections) {
    process.stdout.write(`=== ${title} ===\n${sh(name, script)}\n`);
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`inspect.js error: ${err.message}\n`);
  process.exit(1);
}
