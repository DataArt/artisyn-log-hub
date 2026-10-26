#!/usr/bin/env node
/*
 * Task docs <-> GitHub Issues bridge for the `github-issues` skill.
 *
 *   node gh-issues.js fetch <GH-42 | #42 | 42 | issue URL>
 *       Prints the issue (title, state, labels, body, comments) as markdown for adlc-lh:scratch.
 *
 *   node gh-issues.js sync <created|reviewed|archived> <task dir>
 *       Creates or updates the issue of a task folder from its requirements.md, sets the stage
 *       label, writes the `**Tracker:**` line back into requirements.md, closes on `archived`.
 *
 * The first stdout line is always `GH_STATUS: <ok|not-installed|not-logged-in|no-permission|
 * not-found|error>`; on anything but `ok` a `HINT:` line says what the user should do. Exit code:
 * 0 ok, 3 gh/auth/permission problem (remind the user, do not fail the calling skill), 1 other.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const KEY_PREFIX = 'GH';
const TASK_LABEL = 'adlc-task';
const STAGE_LABELS = {
  created: { name: 'adlc:todo', color: 'c5def5', description: 'adlc task: scratched, not reviewed yet' },
  reviewed: { name: 'adlc:reviewed', color: '0e8a16', description: 'adlc task: requirements reviewed' },
  archived: { name: 'adlc:done', color: '5319e7', description: 'adlc task: archived as done' },
};
const TYPE_LABELS = { bug: 'bug', feature: 'enhancement' };
const MAX_BODY = 60000;
const TOKEN_HINT = 'Give your GitHub token "Issues: Read and write" on this repository '
  + '(fine-grained PAT: https://github.com/settings/personal-access-tokens; classic PAT: the `repo` '
  + 'scope), or run `gh auth refresh -s repo` if you are logged in through the browser.';

class GhError extends Error {
  constructor(status, message, hint) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

function gh(args, input) {
  const res = spawnSync('gh', args, {
    encoding: 'utf8',
    input: input === undefined ? undefined : JSON.stringify(input),
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error && res.error.code === 'ENOENT') {
    throw new GhError('not-installed', 'GitHub CLI `gh` is not installed.',
      'Install it from https://cli.github.com/ and run `gh auth login`.');
  }
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const msg = `${res.stderr || ''}${res.stdout || ''}`.trim();
    if (/not logged in|gh auth login|authentication required|bad credentials|HTTP 401/i.test(msg)) {
      throw new GhError('not-logged-in', `gh is not logged in: ${firstLine(msg)}`,
        'Run `gh auth login` (GitHub.com, HTTPS), then repeat the command.');
    }
    if (/not accessible by|HTTP 403|must have (admin|push|triage)|permission/i.test(msg)) {
      throw new GhError('no-permission', `The GitHub token lacks permission: ${firstLine(msg)}`, TOKEN_HINT);
    }
    if (/HTTP 404|HTTP 410|Could not resolve/i.test(msg)) {
      throw new GhError('not-found', `Not found on GitHub: ${firstLine(msg)}`, null);
    }
    throw new GhError('error', `gh ${args.slice(0, 3).join(' ')} failed: ${firstLine(msg)}`, null);
  }
  return res.stdout;
}

function ghJson(args, input) {
  const out = gh(args, input);
  return out.trim() ? JSON.parse(out) : null;
}

function api(method, endpoint, input) {
  const args = ['api', '-X', method, endpoint];
  if (input !== undefined) args.push('--input', '-');
  return ghJson(args, input);
}

function firstLine(s) {
  return (s.split(/\r?\n/).find((l) => l.trim()) || '').trim();
}

function checkAuth() {
  const res = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', timeout: 30000 });
  if (res.error && res.error.code === 'ENOENT') gh(['--version']);
  if (res.status !== 0) {
    throw new GhError('not-logged-in', 'gh is not logged in to github.com.',
      'Run `gh auth login` (GitHub.com, HTTPS), then repeat the command.');
  }
}

function repoInfo() {
  const r = ghJson(['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef']);
  return { name: r.nameWithOwner, url: r.url, branch: r.defaultBranchRef.name };
}

function parseIssueRef(ref) {
  const m = String(ref).trim().match(/^(?:GH-|#)?(\d+)$/i)
    || String(ref).match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/i);
  if (!m) throw new GhError('error', `Not a GitHub issue reference: ${ref}`, 'Use GH-42, #42 or an issue URL.');
  return Number(m[1]);
}

// ---- fetch ---------------------------------------------------------------------------------

function fetchIssue(ref) {
  checkAuth();
  const num = parseIssueRef(ref);
  const issue = api('GET', `repos/{owner}/{repo}/issues/${num}`);
  if (issue.pull_request) throw new GhError('not-found', `#${num} is a pull request, not an issue.`, null);
  const comments = api('GET', `repos/{owner}/{repo}/issues/${num}/comments?per_page=100`) || [];
  const out = [
    'GH_STATUS: ok',
    `KEY: ${KEY_PREFIX}-${num}`,
    `URL: ${issue.html_url}`,
    `TITLE: ${issue.title}`,
    `STATE: ${issue.state}`,
    `AUTHOR: ${issue.user && issue.user.login}`,
    `LABELS: ${(issue.labels || []).map((l) => l.name).join(', ') || '(none)'}`,
    '',
    '## Body',
    '',
    stripSyncBlocks(issue.body || '').trim() || '(empty)',
  ];
  const human = comments.filter((c) => !(c.body || '').includes('<!-- adlc-sync'));
  if (human.length) {
    out.push('', '## Comments');
    for (const c of human) out.push('', `### ${c.user && c.user.login} — ${c.created_at}`, '', c.body.trim());
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

// ---- sync ----------------------------------------------------------------------------------

const BLOCK_RE = /<!-- adlc-sync:start task=([^\s>]+) -->[\s\S]*?<!-- adlc-sync:end -->/g;

function stripSyncBlocks(body) {
  return body.replace(BLOCK_RE, '').replace(/\n-{3,}\s*$/, '').trim();
}

function syncBlockFolders(body) {
  return [...(body || '').matchAll(BLOCK_RE)].map((m) => m[1]);
}

function readRequirements(taskDir) {
  const file = path.join(taskDir, 'requirements.md');
  if (!fs.existsSync(file)) throw new GhError('error', `No requirements.md in ${taskDir}`, null);
  const raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const text = raw.replace(/\r\n/g, '\n');
  const h1 = text.match(/^#\s+(.+)$/m);
  const heading = h1 ? h1[1].trim() : path.basename(taskDir);
  const title = heading.replace(/^[A-Za-z0-9._-]+:\s*/, '') || heading;
  const field = (name) => {
    const m = text.match(new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*(.*)$`, 'mi'));
    return m ? m[1].trim() : '';
  };
  return { file, raw, eol, text, heading, title, type: field('Type').toLowerCase(), tracker: field('Tracker') };
}

function findIssueNumber(folder, req) {
  const fromTracker = req.tracker.match(/(?:GH-|#|\/issues\/)(\d+)/i);
  if (fromTracker) return Number(fromTracker[1]);
  const fromFolder = folder.match(new RegExp(`^${KEY_PREFIX}-(\\d+)-`, 'i'));
  if (fromFolder) return Number(fromFolder[1]);
  // A previous run may have created the issue but failed to write the Tracker line back.
  for (let page = 1; page <= 10; page += 1) {
    const list = api('GET', `repos/{owner}/{repo}/issues?state=all&labels=${TASK_LABEL}&per_page=100&page=${page}`) || [];
    const hit = list.find((i) => syncBlockFolders(i.body).includes(folder));
    if (hit) return hit.number;
    if (list.length < 100) break;
  }
  return null;
}

function buildBlock(folder, req, repo, event, taskDir) {
  const rel = path.relative(gitRoot(taskDir), path.join(taskDir, 'requirements.md')).split(path.sep).join('/');
  const link = `${repo.url}/blob/${repo.branch}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  let content = req.text
    .replace(/^#\s+.+\n+/, '')
    .replace(/^\*\*Tracker:\*\*.*\n/mi, '')
    .trim();
  if (content.length > MAX_BODY) content = `${content.slice(0, MAX_BODY)}\n\n…(truncated — see the file)`;
  const date = new Date().toISOString().slice(0, 10);
  return [
    `<!-- adlc-sync:start task=${folder} -->`,
    `> Synced from [\`${rel}\`](${link}) — stage **${STAGE_LABELS[event].name}**, ${date}.`,
    '> Edit the file in the repo, not this block: it is overwritten on the next sync.',
    '',
    content,
    '<!-- adlc-sync:end -->',
  ].join('\n');
}

function mergeBody(oldBody, folder, block) {
  const body = (oldBody || '').replace(/\r\n/g, '\n');
  const own = new RegExp(`<!-- adlc-sync:start task=${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -->[\\s\\S]*?<!-- adlc-sync:end -->`);
  if (own.test(body)) return body.replace(own, () => block);
  return body.trim() ? `${body.trim()}\n\n---\n\n${block}` : block;
}

function gitRoot(dir) {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  if (res.status !== 0) throw new GhError('error', `${dir} is not inside a git repository`, null);
  return path.resolve(res.stdout.trim());
}

function ensureLabels(names) {
  const existing = new Set((api('GET', 'repos/{owner}/{repo}/labels?per_page=100') || []).map((l) => l.name));
  const defs = [{ name: TASK_LABEL, color: 'ededed', description: 'Mirrors a task folder under docs/tasks' },
    ...Object.values(STAGE_LABELS)];
  for (const d of defs) {
    if (names.includes(d.name) && !existing.has(d.name)) api('POST', 'repos/{owner}/{repo}/labels', d);
  }
  return names.filter((n) => existing.has(n) || defs.some((d) => d.name === n));
}

function writeTrackerLine(req, num, url) {
  const line = `**Tracker:** ${KEY_PREFIX}-${num} ${url}`;
  let text = req.text;
  if (/^\*\*Tracker:\*\*.*$/mi.test(text)) {
    text = text.replace(/^\*\*Tracker:\*\*.*$/mi, line);
  } else {
    // Metadata lines sit between the H1 and the first `##` section; bold lines below are body text.
    const firstSection = text.search(/^##\s/m);
    const head = firstSection === -1 ? text : text.slice(0, firstSection);
    const meta = [...head.matchAll(/^\*\*[A-Za-z() ]+:\*\*.*$/gm)];
    if (!meta.length) return false;
    const last = meta[meta.length - 1];
    const at = last.index + last[0].length;
    text = `${text.slice(0, at)}\n${line}${text.slice(at)}`;
  }
  const out = req.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
  if (out === req.raw) return false;
  fs.writeFileSync(req.file, out, 'utf8');
  return true;
}

function openFolders(taskDir) {
  // <tasks>/{todo,done}/<folder>: the sibling todo dir lists the tasks still open.
  const todo = path.join(path.dirname(path.dirname(taskDir)), 'todo');
  try {
    return new Set(fs.readdirSync(todo, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));
  } catch {
    return new Set();
  }
}

function syncTask(event, taskDirArg) {
  if (!STAGE_LABELS[event]) throw new GhError('error', `Unknown event: ${event}`, 'Use created, reviewed or archived.');
  const taskDir = path.resolve(taskDirArg);
  const folder = path.basename(taskDir);
  // gh resolves {owner}/{repo} from the working directory's git remote.
  process.chdir(gitRoot(taskDir));
  checkAuth();
  const repo = repoInfo();
  const req = readRequirements(taskDir);
  const block = buildBlock(folder, req, repo, event, taskDir);
  const stage = STAGE_LABELS[event].name;
  const typeLabel = TYPE_LABELS[req.type.split(/[\s|]/)[0]];
  const wanted = ensureLabels([TASK_LABEL, stage, ...(typeLabel ? [typeLabel] : [])]);

  let num = findIssueNumber(folder, req);
  let issue = num ? api('GET', `repos/{owner}/{repo}/issues/${num}`) : null;
  const actions = [];

  if (!issue) {
    issue = api('POST', 'repos/{owner}/{repo}/issues', { title: req.title, body: block, labels: wanted });
    num = issue.number;
    actions.push('created');
  } else {
    const body = mergeBody(issue.body, folder, block);
    const patch = {};
    if (body !== (issue.body || '').replace(/\r\n/g, '\n')) patch.body = body;
    // Retitle only issues that are nothing but sync blocks, i.e. the ones this script created.
    if (!stripSyncBlocks(body) && syncBlockFolders(body).length === 1 && issue.title !== req.title) patch.title = req.title;
    if (event !== 'archived' && issue.state === 'closed') {
      patch.state = 'open';
      actions.push('reopened');
    }
    if (Object.keys(patch).length) {
      issue = api('PATCH', `repos/{owner}/{repo}/issues/${num}`, patch);
      actions.push('updated');
    }
    const have = new Set((issue.labels || []).map((l) => l.name));
    for (const l of Object.values(STAGE_LABELS)) {
      if (l.name !== stage && have.has(l.name)) {
        api('DELETE', `repos/{owner}/{repo}/issues/${num}/labels/${encodeURIComponent(l.name)}`);
      }
    }
    const missing = wanted.filter((n) => !have.has(n));
    if (missing.length) {
      api('POST', `repos/{owner}/{repo}/issues/${num}/labels`, { labels: missing });
      actions.push('labelled');
    }
  }

  if (event === 'archived' && issue.state !== 'closed') {
    // A follow-up task under the same key may still be open — keep the issue open for it.
    const open = openFolders(taskDir);
    const stillOpen = syncBlockFolders(issue.body).filter((f) => f !== folder && open.has(f));
    if (stillOpen.length) {
      actions.push(`kept-open(${stillOpen.join(',')})`);
    } else {
      api('POST', `repos/{owner}/{repo}/issues/${num}/comments`,
        { body: `<!-- adlc-sync -->Task \`${folder}\` archived as done — closing.` });
      api('PATCH', `repos/{owner}/{repo}/issues/${num}`, { state: 'closed', state_reason: 'completed' });
      actions.push('closed');
    }
  }

  const trackerWritten = writeTrackerLine(req, num, issue.html_url);
  process.stdout.write([
    'GH_STATUS: ok',
    `ISSUE: ${KEY_PREFIX}-${num} ${issue.html_url}`,
    `ACTION: ${actions.join(', ') || 'unchanged'}`,
    `TRACKER_LINE: ${trackerWritten ? 'written' : 'unchanged'}`,
  ].join('\n') + '\n');
}

// ---- main ----------------------------------------------------------------------------------

try {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'fetch' && a) fetchIssue(a);
  else if (cmd === 'sync' && a && b) syncTask(a, b);
  else throw new GhError('error', 'Usage: gh-issues.js fetch <ref> | sync <created|reviewed|archived> <task dir>', null);
  process.exit(0);
} catch (err) {
  const status = err instanceof GhError ? err.status : 'error';
  const lines = [`GH_STATUS: ${status}`, `MESSAGE: ${err.message}`];
  if (err.hint) lines.push(`HINT: ${err.hint}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(['not-installed', 'not-logged-in', 'no-permission'].includes(status) ? 3 : 1);
}
