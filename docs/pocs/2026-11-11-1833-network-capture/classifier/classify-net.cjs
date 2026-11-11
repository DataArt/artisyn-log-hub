'use strict';
// PoC layer-1 classifier: which network accesses does one Bash / PowerShell command text make?
// classifyCommand(command, shell) -> [{ kind, host, url, port?, tool, inferred? }]
//   kind: http | ssh | file-transfer | socket | git | package-registry
//   host: lower-case host name, or null when it is not known from the text (env var, git remote name)
// Tokenizer: the same idea as server/src/logs/tool-monitoring/cli-command-recognition.ts rule 3 (split on
// ; | || && newlines outside quotes, quotes removed). The real implementation would reuse the
// tree-sitter-bash walk of that module.

function splitCommands(text) {
  const cmds = [];
  let cur = [];
  let word = '';
  let inWord = false;
  let q = null;
  const pushWord = () => { if (inWord) cur.push(word); word = ''; inWord = false; };
  const pushCmd = () => { pushWord(); if (cur.length) cmds.push(cur); cur = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (c === '\\' && q === '"' && (text[i + 1] === '"' || text[i + 1] === '\\')) { word += text[++i]; continue; }
      word += c; continue;
    }
    if (c === '"' || c === "'") { q = c; inWord = true; continue; }
    if (c === '\\' && text[i + 1] === '\n') { i++; continue; }
    if (/\s/.test(c) && c !== '\n') { pushWord(); continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '`' || c === '{' || c === '}') {
      if (c === '(' && word === '$') { word = ''; inWord = false; }
      if ((c === '{' || c === '}') && inWord) { word += c; continue; } // ${VAR}
      pushCmd(); continue;
    }
    word += c; inWord = true;
  }
  pushCmd();
  return cmds;
}

const PREFIX = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'command', 'builtin', 'xargs', 'nice', 'then', 'do', 'else', '!']);
const norm = (w) => w.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
const isDynamic = (s) => /\$[{(A-Za-z_]|%[A-Za-z_]+%/.test(s);

function hostOfUrl(u) {
  if (isDynamic(u.split(/[/?#]/).slice(0, 3).join('/'))) return null;
  try { return new URL(u).hostname.toLowerCase() || null; } catch { return null; }
}
const URL_RE = /\b(?:https?|ftp|wss?|rsync|ssh|git):\/\/[^\s'"`<>)\]]+/gi;

function rec(kind, tool, url, host, extra = {}) {
  return { kind, tool, url: url || null, host: host === undefined ? (url ? hostOfUrl(url) : null) : host, ...extra };
}

// Option parsing helper: returns positional args, skipping options that take a value.
function positionals(args, valueOpts) {
  const out = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { out.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.split('=');
      if (v === undefined && valueOpts.has(k)) opts[k] = args[++i]; else opts[k] = v ?? true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const k = a.slice(0, 2);
      if (valueOpts.has(k)) opts[k] = a.length > 2 ? a.slice(2) : args[++i]; else opts[k] = true;
      continue;
    }
    out.push(a);
  }
  return { out, opts };
}

const CURL_V = new Set(['-o', '-H', '-d', '-X', '-u', '-A', '-e', '-F', '-T', '-x', '-m', '-w', '-K', '-b', '-c', '-r', '-E', '-U', '-Y', '-y', '-z', '-C',
  '--output', '--header', '--data', '--data-raw', '--data-binary', '--request', '--user', '--user-agent', '--referer', '--form', '--max-time',
  '--connect-timeout', '--proxy', '--write-out', '--retry', '--cookie', '--cert', '--resolve', '--url', '--json', '--data-urlencode']);
const WGET_V = new Set(['-O', '-o', '-P', '-U', '-t', '-T', '-e', '--output-document', '--header', '--user-agent', '--directory-prefix', '--tries', '--timeout', '--post-data']);
const SSH_V = new Set(['-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-b', '-c', '-E', '-m', '-O', '-Q', '-S', '-W', '-w', '-B', '-P']);
const GIT_GLOBAL_V = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const GIT_NET = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'remote', 'submodule']);

function parseUserHost(s) {
  // [user@]host[:path]   (scp-like), returns host or null
  const m = /^(?:[^@\s/]+@)?(\[[^\]]+\]|[A-Za-z0-9._-]+)(?::|$)/.exec(s);
  if (!m || isDynamic(s)) return null;
  return m[1].replace(/^\[|\]$/g, '').toLowerCase();
}

function scanScript(text, tool, apis) {
  const out = [];
  const urls = text.match(URL_RE) || [];
  for (const u of urls) out.push(rec('http', tool, u.replace(/[.,;]+$/, ''), undefined, { inferred: true }));
  if (!urls.length && apis.test(text)) out.push(rec('http', tool, null, null, { inferred: true }));
  return out;
}

function classifyArgv(argv, shell) {
  let i = 0;
  if (shell === 'powershell' && /^\$[\w:]+$/.test(argv[0] || '') && argv[1] === '=') i = 2; // $r = <cmd>
  while (i < argv.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]) || PREFIX.has(argv[i]) || argv[i] === '&')) i++;
  if (argv[i] === 'timeout') i += 2;
  const w = argv[i];
  if (!w) return [];
  const tool = norm(w);
  const args = argv.slice(i + 1);
  const ps = shell === 'powershell';

  if ((tool === 'bash' || tool === 'sh' || tool === 'zsh' || tool === 'pwsh' || tool === 'powershell' || tool === 'cmd') && args.length) {
    const ci = args.findIndex((a) => /^(-c|-command|\/c)$/i.test(a));
    if (ci !== -1 && args[ci + 1]) return classifyCommand(args.slice(ci + 1).join(' '), /pwsh|powershell/.test(tool) ? 'powershell' : 'bash');
    return [];
  }
  // PowerShell cmdlets (and PS 5.1 aliases curl/wget -> Invoke-WebRequest)
  const psWeb = ['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'start-bitstransfer'];
  if (psWeb.includes(tool) || (ps && (tool === 'curl' || tool === 'wget') && !/\.exe$/i.test(w))) {
    let url = null;
    for (let k = 0; k < args.length; k++) {
      if (/^-(uri|source|url)$/i.test(args[k])) { url = args[k + 1]; break; }
    }
    if (!url) url = args.find((a) => !a.startsWith('-') && /^(https?:|ftp:|\$|[\w.-]+\.[a-z]{2,})/i.test(a));
    return url ? [rec('http', tool, url, hostOfUrl(/^\w+:/.test(url) || isDynamic(url) ? url : 'https://' + url))] : [];
  }
  switch (tool) {
    case 'curl': case 'wget': {
      const { out, opts } = positionals(args, tool === 'curl' ? CURL_V : WGET_V);
      if (opts['--url']) out.unshift(opts['--url']);
      return out.filter((a) => a && !/^[<>]/.test(a)).map((a) => {
        if (isDynamic(a) && !/^\w+:\/\//.test(a)) return rec('http', tool, a, null);
        const u = /^\w+:\/\//.test(a) ? a : 'http://' + a;
        return rec('http', tool, a, hostOfUrl(u));
      }).filter((r) => r.host || isDynamic(r.url));
    }
    case 'ssh': case 'mosh': {
      const { out, opts } = positionals(args, SSH_V);
      if (!out[0]) return [];
      const host = parseUserHost(out[0].replace(/^ssh:\/\//, ''));
      return [rec('ssh', tool, null, host, { port: opts['-p'] ? Number(opts['-p']) : undefined })];
    }
    case 'scp': case 'sftp': case 'rsync': {
      const { out, opts } = positionals(args, new Set([...SSH_V, '-e', '--rsh', '--exclude', '--include', '--port']));
      const res = [];
      for (const a of out) {
        if (/^(rsync|sftp|scp):\/\//i.test(a)) { res.push(rec('file-transfer', tool, a)); continue; }
        if (tool === 'sftp' || (/^(?:[^@\s/\\]+@)?[A-Za-z0-9._-]+:/.test(a) && !/^[A-Za-z]:[\\/]/.test(a))) {
          const h = parseUserHost(a);
          if (h) res.push(rec('file-transfer', tool, null, h, { port: opts['-P'] || opts['-p'] ? Number(opts['-P'] || opts['-p']) : undefined }));
        }
      }
      return res;
    }
    case 'nc': case 'ncat': case 'netcat': case 'telnet': case 'ftp': {
      const { out } = positionals(args, new Set(['-p', '-w', '-s', '-x', '-i']));
      return out[0] && !isDynamic(out[0]) ? [rec('socket', tool, null, out[0].toLowerCase(), { port: out[1] ? Number(out[1]) : undefined })] : [];
    }
    case 'git': {
      const { out } = positionals(args, GIT_GLOBAL_V);
      const sub = out[0];
      if (!GIT_NET.has(sub)) return [];
      if ((sub === 'remote' && !['update', 'show', 'prune'].includes(out[1])) || (sub === 'submodule' && out[1] !== 'update')) return [];
      const target = out.slice(1).find((a) => /^\w+:\/\/|^[^@\s]+@[^:\s]+:/.test(a));
      if (!target) return [rec('git', 'git', null, null, { remote: out[1] || 'origin' })];
      return [rec('git', 'git', target, /^\w+:\/\//.test(target) ? hostOfUrl(target) : parseUserHost(target))];
    }
    case 'gh': {
      const { out, opts } = positionals(args, new Set(['-R', '--repo', '--hostname', '-X', '--method', '-f', '-F', '-H', '--jq', '-q', '--template', '-t']));
      if (!out.length || ['help', 'version', 'completion', 'alias', 'config'].includes(out[0])) return [];
      return [rec('http', 'gh', out[0] === 'api' ? out[1] || null : null, opts['--hostname'] ? String(opts['--hostname']).toLowerCase() : 'api.github.com')];
    }
    case 'docker': case 'podman': {
      const sub = args.find((a) => !a.startsWith('-'));
      if (!['pull', 'push', 'login'].includes(sub)) return [];
      const ref = args.slice(args.indexOf(sub) + 1).find((a) => !a.startsWith('-'));
      if (!ref) return [rec('package-registry', tool, null, 'docker.io')];
      const first = ref.split('/')[0];
      const host = sub === 'login' ? first : (ref.includes('/') && /[.:]|^localhost$/.test(first) ? first.replace(/:\d+$/, '') : 'docker.io');
      return [rec('package-registry', tool, null, host.toLowerCase())];
    }
    case 'npm': case 'pnpm': case 'yarn': case 'bun': {
      const sub = args.find((a) => !a.startsWith('-'));
      const install = ['install', 'i', 'ci', 'add', 'update', 'up', 'publish', 'view', 'info', 'outdated', 'audit'];
      if (!(install.includes(sub) || (tool === 'yarn' && !sub))) return [];
      const reg = args.find((a) => a.startsWith('--registry'));
      const regUrl = reg ? (reg.includes('=') ? reg.split('=')[1] : args[args.indexOf(reg) + 1]) : null;
      return [rec('package-registry', tool, regUrl, regUrl ? hostOfUrl(regUrl) : (tool === 'yarn' ? 'registry.yarnpkg.com' : 'registry.npmjs.org'))];
    }
    case 'pip': case 'pip3': case 'uv': case 'poetry': case 'pipx': {
      const words = args.filter((a) => !a.startsWith('-'));
      const net = tool === 'uv' ? (words[0] === 'pip' ? ['install', 'download'].includes(words[1]) : ['add', 'sync', 'lock', 'tool', 'run'].includes(words[0]))
        : ['install', 'download', 'add', 'update', 'lock'].includes(words[0]);
      if (!net) return [];
      const ix = args.findIndex((a) => /^(-i|--index-url)$/.test(a));
      return [rec('package-registry', tool, ix !== -1 ? args[ix + 1] : null, ix !== -1 ? hostOfUrl(args[ix + 1]) : 'pypi.org')];
    }
    case 'certutil': {
      if (!args.some((a) => /^[-/]urlcache$/i.test(a))) return [];
      const u = args.find((a) => /^\w+:\/\//.test(a));
      return u ? [rec('http', tool, u)] : [];
    }
    case 'bitsadmin': {
      const u = args.find((a) => /^\w+:\/\//.test(a));
      return u ? [rec('http', tool, u)] : [];
    }
    case 'node': case 'deno': case 'bun-eval': {
      const ix = args.findIndex((a) => /^(-e|--eval|-p|--print)$/.test(a));
      if (ix === -1 || !args[ix + 1]) return [];
      return scanScript(args[ix + 1], tool, /\bfetch\s*\(|\bhttps?\.(get|request)\b|require\(['"]node:(http|https|net)/);
    }
    case 'python': case 'python3': case 'py': {
      if (args[0] === '-m' && /^pip$/.test(args[1])) return classifyArgv(['pip', ...args.slice(2)], shell);
      const ix = args.indexOf('-c');
      if (ix === -1 || !args[ix + 1]) return [];
      return scanScript(args[ix + 1], tool, /\b(requests|urllib|httpx|aiohttp|socket|http\.client)\b/);
    }
    default:
      return [];
  }
}

function classifyCommand(command, shell = 'bash') {
  if (!command || !command.trim()) return [];
  const out = [];
  for (const argv of splitCommands(command)) {
    try { out.push(...classifyArgv(argv, shell)); } catch { /* one odd command never breaks the rest */ }
  }
  return out;
}

module.exports = { classifyCommand, splitCommands };
