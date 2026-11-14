#!/usr/bin/env node
// Fake coding agent for the Work Hub test stand (plan D14). Test infrastructure only: it is baked
// into the image `artisyn-work-hub-fake-agent:test` (tests/fake-agent/Dockerfile) as
// /usr/local/bin/claude and is never shipped. It answers exactly the commands the Claude adapter
// (server/src/agent/claude.rs) runs:
//
//   claude --version
//   claude auth status         exit 0 + {"loggedIn":true} when ~/.claude/.credentials.json holds
//                              "fake":"ok", else exit 1 + {"loggedIn":false}
//   claude auth login          arrow-key menu (2 methods, Enter picks) → prints
//                              https://example.invalid/oauth and "Paste code here:" → the code
//                              good-code writes the credentials and prints "Login successful."
//   claude [--session-id <id>] [--resume <id>] [--append-system-prompt <text>]
//                              interactive chat: ANSI colours, a "> " prompt, raw mode; the
//                              conversation is appended to ~/.claude/projects/fake/<session>.log.
//                              --resume of a session without a log fails (exit 1), as the real
//                              CLI does, so the adapter's fallback to --session-id is exercised.
//
// Chat inputs: make <path> <text> · run <command> · ask · commit · recall · busy <s> ·
// install <name> · logout · anything else is echoed. Without a login every input answers
// "Not logged in" instead (so "answered without a login" checks mean something). Ctrl+D on an
// empty line or `exit` ends the chat.
//
// Interactive input is event driven (raw-mode stdin), so unlike the repo's CLI scripts this one is
// not synchronous; it still uses only Node built-ins. It is an .mjs file because the image links
// /usr/local/bin/claude to it and Node picks the module type from the real path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const VERSION = '0.0.0-fake (Work Hub fake agent)';
const HOME = os.homedir();
const CREDENTIALS = path.join(HOME, '.claude', '.credentials.json');
const LOG_DIR = path.join(HOME, '.claude', 'projects', 'fake');
const GOOD_CODE = 'good-code';
const LOGIN_METHODS = ['Claude account with subscription', 'Anthropic Console account'];
const ASK_OPTIONS = ['Yes', 'No', 'Maybe later'];
const SPINNER = ['|', '/', '-', '\\'];

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const out = (text) => process.stdout.write(text);
const line = (text = '') => out(`${text}\r\n`);

function isLoggedIn() {
  try {
    return fs.readFileSync(CREDENTIALS, 'utf8').includes('"fake":"ok"');
  } catch {
    return false;
  }
}

function writeCredentials() {
  fs.mkdirSync(path.dirname(CREDENTIALS), { recursive: true });
  fs.writeFileSync(CREDENTIALS, '{"fake":"ok"}\n', { encoding: 'utf8', mode: 0o600 });
}

// ---------------------------------------------------------------------------------------------
// Raw-mode key input shared by the login menu and the chat.

/** Splits one stdin chunk into keys: escape sequences stay whole, everything else is per char. */
function splitKeys(chunk) {
  const keys = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === '\x1b') {
      if (chunk[i + 1] === '[' || chunk[i + 1] === 'O') {
        let j = i + 2;
        while (j < chunk.length && !/[A-Za-z~]/.test(chunk[j])) j++;
        keys.push(chunk.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      keys.push('\x1b');
      i++;
      continue;
    }
    if (chunk[i] === '\r' && chunk[i + 1] === '\n') {
      keys.push('\r');
      i += 2;
      continue;
    }
    keys.push(chunk[i]);
    i++;
  }
  return keys;
}

const KEY_UP = new Set(['\x1b[A', '\x1bOA']);
const KEY_DOWN = new Set(['\x1b[B', '\x1bOB']);
const isEnter = (k) => k === '\r' || k === '\n';

let keyHandler = () => {};

function startInput() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    for (const key of splitKeys(chunk)) keyHandler(key);
  });
  process.stdin.on('end', () => finish(0));
}

function finish(code) {
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // the terminal is already gone
    }
  }
  process.exit(code);
}

/** An arrow-key menu: Up/Down move, Enter picks (onPick(index)), Esc cancels (onCancel). */
function menu(title, options, onPick, onCancel) {
  let selected = 0;
  const render = (first) => {
    if (!first) out(`\x1b[${options.length}A`);
    options.forEach((opt, idx) => {
      const mark = idx === selected ? `${C.cyan}> ${opt}${C.reset}` : `  ${opt}`;
      out(`\r\x1b[2K${idx + 1}. ${mark}\r\n`);
    });
  };
  line(`${C.bold}${title}${C.reset}`);
  render(true);
  keyHandler = (key) => {
    if (KEY_UP.has(key)) {
      selected = (selected + options.length - 1) % options.length;
      render(false);
    } else if (KEY_DOWN.has(key)) {
      selected = (selected + 1) % options.length;
      render(false);
    } else if (isEnter(key)) {
      onPick(selected);
    } else if (key === '\x1b') {
      if (onCancel) onCancel();
    } else if (key === '\x03') {
      line('');
      finish(130);
    }
  };
}

/** A line editor: printable keys echo, Backspace deletes, Enter calls onLine(text). */
// `echo: false` echoes nothing, like the real CLI's login-code prompt.
function readLine(prompt, onLine, { onEof, echo = true } = {}) {
  let buf = '';
  out(prompt);
  keyHandler = (key) => {
    if (isEnter(key)) {
      out('\r\n');
      const text = buf;
      buf = '';
      onLine(text);
    } else if (key === '\x7f' || key === '\b') {
      if (buf.length > 0) {
        buf = [...buf].slice(0, -1).join('');
        if (echo) out('\b \b');
      }
    } else if (key === '\x03') {
      if (buf.length > 0) {
        buf = '';
        out(`\r\n${prompt}`);
      } else {
        out('\r\n');
        finish(130);
      }
    } else if (key === '\x04') {
      if (buf.length === 0) {
        out('\r\n');
        if (onEof) onEof();
        else finish(0);
      }
    } else if (key.startsWith('\x1b')) {
      // arrows and other escape sequences are ignored at the prompt
    } else if (key >= ' ') {
      buf += key;
      if (echo) out(key);
    }
  };
}

// ---------------------------------------------------------------------------------------------
// auth subcommands

function authStatus() {
  const loggedIn = isLoggedIn();
  process.stdout.write(`${JSON.stringify({ loggedIn })}\n`);
  process.exit(loggedIn ? 0 : 1);
}

function authLogin() {
  startInput();
  line(`${C.bold}Fake agent login${C.reset}`);
  menu('Select login method:', LOGIN_METHODS, (idx) => {
    line(`Logging in with ${LOGIN_METHODS[idx]}.`);
    line('Open this link in your browser to sign in:');
    line(`${C.blue}https://example.invalid/oauth${C.reset}`);
    const ask = () => {
      readLine('Paste code here: ', (code) => {
        if (code.trim() === GOOD_CODE) {
          writeCredentials();
          line(`${C.green}Login successful.${C.reset}`);
          finish(0);
        } else {
          line(`${C.red}Invalid code. Try again.${C.reset}`);
          ask();
        }
      }, { onEof: () => finish(1), echo: false });
    };
    ask();
  });
}

// ---------------------------------------------------------------------------------------------
// Interactive chat

function parseChatArgs(argv) {
  const opts = { sessionId: null, resume: null, systemPrompt: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session-id') opts.sessionId = argv[++i] ?? null;
    else if (a === '--resume' || a === '-r') opts.resume = argv[++i] ?? null;
    else if (a === '--append-system-prompt') opts.systemPrompt = argv[++i] ?? null;
  }
  return opts;
}

function logFile(sessionId) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
  return path.join(LOG_DIR, `${sessionId}.log`);
}

/** Previous user messages from the log, oldest first. */
function readUserMessages(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((l) => l.startsWith('user: '))
    .map((l) => l.slice('user: '.length));
}

function chat(argv) {
  const opts = parseChatArgs(argv);
  let sessionId = opts.sessionId;
  if (opts.resume) {
    if (!fs.existsSync(logFile(opts.resume))) {
      process.stderr.write(`No conversation found with session ID: ${opts.resume}\n`);
      process.exit(1);
    }
    sessionId = opts.resume;
  }
  if (!sessionId) sessionId = crypto.randomUUID();
  const file = logFile(sessionId);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = (role, text) => fs.appendFileSync(file, `${role}: ${text.replace(/\n/g, ' ')}\n`, 'utf8');
  const history = readUserMessages(file);

  startInput();
  line(`${C.magenta}${C.bold}* Fake agent${C.reset} ${C.dim}${VERSION}${C.reset}`);
  line(`${C.dim}cwd: ${process.cwd()} · session: ${sessionId}${C.reset}`);
  if (opts.resume) line(`${C.dim}Resumed conversation (${history.length} earlier messages).${C.reset}`);
  if (opts.systemPrompt) line(`${C.dim}Extra instructions: ${opts.systemPrompt}${C.reset}`);
  line('');

  const say = (text, colour = C.green) => {
    line(`${colour}* ${C.reset}${text}`);
    log('agent', text);
  };
  const prompt = () => readLine(`${C.bold}> ${C.reset}`, onMessage);

  /** Runs argv with the terminal handed over to it; returns the exit code. */
  const runInTerminal = (cmd, args) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    const r = spawnSync(cmd, args, { stdio: 'inherit' });
    process.stdin.resume();
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    if (r.error) return 127;
    return r.status === null ? 128 : r.status;
  };

  function onMessage(raw) {
    const text = raw.trim();
    if (text === '') {
      prompt();
      return;
    }
    if (text === 'exit') finish(0);
    const previous = history.length > 0 ? history[history.length - 1] : null;
    history.push(text);
    log('user', text);

    if (!isLoggedIn()) {
      say('Not logged in. Run claude auth login.', C.red);
      prompt();
      return;
    }

    const [cmd, ...rest] = text.split(/\s+/);
    const restText = text.slice(cmd.length).trim();
    switch (cmd) {
      case 'make': {
        const target = rest[0];
        if (!target) {
          say('Usage: make <path> <text>', C.yellow);
          break;
        }
        const content = restText.slice(target.length).trim();
        const abs = path.resolve(process.cwd(), target);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, `${content}\n`, 'utf8');
        say(`Wrote ${target}`);
        break;
      }
      case 'run': {
        if (!restText) {
          say('Usage: run <command>', C.yellow);
          break;
        }
        line(`${C.dim}$ ${restText}${C.reset}`);
        const code = runInTerminal('sh', ['-c', restText]);
        say(`Run finished: exit ${code}`, code === 0 ? C.green : C.red);
        break;
      }
      case 'ask':
        menu('Pick an answer:', ASK_OPTIONS, (idx) => {
          say(`You picked: ${ASK_OPTIONS[idx]}`);
          prompt();
        }, () => {
          say('Cancelled', C.yellow);
          prompt();
        });
        return;
      case 'commit': {
        const code = runInTerminal('sh', ['-c', 'git add -A && git commit -m fake']);
        say(`Commit finished: exit ${code}`, code === 0 ? C.green : C.red);
        break;
      }
      case 'recall':
        say(previous === null ? 'You said nothing before.' : `You said before: ${previous}`, C.cyan);
        break;
      case 'busy': {
        const seconds = Number.parseInt(rest[0] ?? '', 10);
        if (!Number.isFinite(seconds) || seconds < 0) {
          say('Usage: busy <seconds>', C.yellow);
          break;
        }
        keyHandler = () => {};
        const started = Date.now();
        let tick = 0;
        const timer = setInterval(() => {
          const left = Math.max(0, seconds - Math.floor((Date.now() - started) / 1000));
          // "esc to interrupt" like the real CLI's status line: Work Hub's busy check looks for it.
          out(`\r\x1b[2K${C.yellow}${SPINNER[tick++ % SPINNER.length]} Working... ${left}s left (esc to interrupt)${C.reset}`);
          if (Date.now() - started >= seconds * 1000) {
            clearInterval(timer);
            out('\r\x1b[2K');
            say(`Done after ${seconds}s.`);
            prompt();
          }
        }, 250);
        return;
      }
      case 'install': {
        const name = rest[0];
        if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
          say('Usage: install <name>', C.yellow);
          break;
        }
        const code = runInTerminal('sudo', ['touch', `/opt/${name}`]);
        say(code === 0 ? `Installed ${name}` : `Install failed: exit ${code}`, code === 0 ? C.green : C.red);
        break;
      }
      case 'logout':
        fs.rmSync(CREDENTIALS, { force: true });
        say('Logged out.');
        break;
      default:
        say(`You said: ${text}`);
    }
    prompt();
  }

  prompt();
}

// ---------------------------------------------------------------------------------------------

try {
  const argv = process.argv.slice(2);
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  } else if (argv[0] === 'auth' && argv[1] === 'status') {
    authStatus();
  } else if (argv[0] === 'auth' && argv[1] === 'login') {
    authLogin();
  } else if (argv[0] === 'auth' && argv[1] === 'logout') {
    fs.rmSync(CREDENTIALS, { force: true });
    process.exit(0);
  } else {
    chat(argv);
  }
} catch (err) {
  process.stderr.write(`fake agent error: ${err.message}\n`);
  process.exit(1);
}
