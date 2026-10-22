// Key input for the full-screen menu without Node's raw mode.
//
// On Windows the menu never calls process.stdin.setRawMode: in the WebStorm (JetBrains/pty4j)
// terminal, Node switching raw mode off after a key press closed the whole terminal. Instead a small
// PowerShell child reads keys with [Console]::ReadKey($true) — ReadConsoleInput underneath, which
// returns key events whatever the console mode is, so nobody changes the mode — and streams one line
// per key over a pipe. Node's own stdin is never read. Ctrl+C stays a console signal (SIGINT).
// Elsewhere (Linux/macOS terminals) the classic raw-mode keypress stream is used.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const READER = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::Out.WriteLine("ready"); [Console]::Out.Flush()',
  'while ($true) {',
  '  $k = [Console]::ReadKey($true)',
  "  [Console]::Out.WriteLine(('{0} {1} {2}' -f [int]$k.Key, [int]$k.KeyChar, [int]$k.Modifiers))",
  '  [Console]::Out.Flush()',
  '}',
].join('\n');

/** System.ConsoleKey codes → the keypress names the menu uses (readline's naming). */
const KEY_NAMES = {
  8: 'backspace',
  9: 'tab',
  13: 'return',
  27: 'escape',
  32: 'space',
  33: 'pageup',
  34: 'pagedown',
  35: 'end',
  36: 'home',
  37: 'left',
  38: 'up',
  39: 'right',
  40: 'down',
  46: 'delete',
};

/** One reader line `<ConsoleKey> <KeyChar> <ConsoleModifiers>` → [str, key] like readline's keypress. */
export function parseKeyLine(line) {
  const m = /^(\d+) (\d+) (\d+)$/.exec(String(line).trim());
  if (!m) return null;
  const code = Number(m[1]);
  const ch = Number(m[2]);
  const mods = Number(m[3]);
  let name = KEY_NAMES[code];
  if (!name && code >= 65 && code <= 90) name = String.fromCharCode(code + 32);
  if (!name && code >= 48 && code <= 57) name = String.fromCharCode(code);
  const str = code === 13 ? '\r' : ch >= 32 ? String.fromCharCode(ch) : undefined;
  return [str, { name, ctrl: Boolean(mods & 4), meta: Boolean(mods & 1), shift: Boolean(mods & 2) }];
}

/** True when keys come from the PowerShell reader (Windows) instead of Node's raw mode. */
export function usesConsoleKeyReader(platform = process.platform) {
  return platform === 'win32';
}

/**
 * Starts delivering keys to onKey(str, key). Returns stop(), which ends the reader (Windows) or
 * restores the terminal (raw mode). onError(err) is called if the reader cannot start or dies.
 */
export function startKeys(onKey, onError) {
  if (!usesConsoleKeyReader()) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', onKey);
    process.stdin.resume();
    return () => {
      process.stdin.off('keypress', onKey);
      try {
        process.stdin.setRawMode(false);
      } catch {
        // the terminal may already be gone
      }
      process.stdin.pause();
    };
  }
  const encoded = Buffer.from(READER, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    stdio: ['inherit', 'pipe', 'ignore'],
    windowsHide: true,
  });
  let stopped = false;
  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  rl.on('line', (line) => {
    if (stopped || line === 'ready') return;
    const parsed = parseKeyLine(line);
    if (parsed) onKey(...parsed);
  });
  child.on('error', (err) => {
    if (!stopped) onError(err);
  });
  child.on('exit', (code) => {
    if (!stopped) onError(new Error(`the key reader (powershell) exited with ${code}`));
  });
  return () => {
    stopped = true;
    rl.close();
    child.kill();
  };
}
