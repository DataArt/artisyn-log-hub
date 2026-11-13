'use strict';
// Drives the bridge like a browser would (Node's built-in WebSocket) and checks the session
// state on the tmux side with `capture-pane`. A WebSocket client is inherently asynchronous, so
// this PoC script uses async code (deviation from the repo's sync-script convention).
//
//   node test.js <session>            first connect, interactive prompt, resize, reconnect
//   node test.js <session> --after-restart   reconnect after the server process was restarted

const { execFileSync } = require('child_process');

const CONTAINER = process.env.WH_CONTAINER || 'wh-poc-term';
const BASE = `127.0.0.1:${process.env.WH_PORT || '7801'}`;
const session = process.argv[2] || 't1';
const afterRestart = process.argv.includes('--after-restart');
const results = [];

const tmux = (...args) => execFileSync('docker', ['exec', '-u', 'node', CONTAINER, 'tmux', ...args],
  { encoding: 'utf8' });
const screen = () => { try { return tmux('capture-pane', '-p', '-t', session); } catch { return ''; } };
const clients = () => tmux('list-clients', '-t', session).split('\n').filter(Boolean).length;
const panePid = () => tmux('display', '-p', '-t', session, '#{pane_pid}').trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail) {
  results.push(ok);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n${detail}` : ''}\n`);
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${BASE}/ws?session=${session}`);
    ws.binaryType = 'arraybuffer';
    const received = [];
    ws.onmessage = (e) => received.push(Buffer.from(e.data));
    ws.onopen = () => resolve({
      ws,
      text: () => Buffer.concat(received).toString('utf8'),
      bytes: () => Buffer.concat(received).length,
      key: (s) => ws.send(Buffer.from(s, 'utf8')),
      resize: (cols, rows) => ws.send(JSON.stringify({ cols, rows })),
    });
    ws.onerror = (e) => reject(new Error(`ws error ${e.message || ''}`));
  });
}

async function waitFor(pred, ms, step = 250) {
  for (let t = 0; t < ms; t += step) {
    if (pred()) return true;
    await wait(step);
  }
  return pred();
}

async function main() {
  if (afterRestart) {
    const pidBefore = process.env.PANE_PID;
    const c = await connect();
    c.resize(100, 30);
    const got = await waitFor(() => c.bytes() > 200, 5000);
    check('after a server restart the reconnect gets the screen redrawn', got, `  ${c.bytes()} bytes`);
    check('the CLI process is the same one (tmux kept it alive)', panePid() === pidBefore,
      `  pane pid ${pidBefore} -> ${panePid()}`);
    c.ws.close();
    await wait(1000);
    check('no tmux client is left behind (stale clients of the killed server dropped too)',
      clients() === 0, `  clients: ${clients()}`);
    return;
  }

  const c = await connect();
  c.resize(100, 30);
  const appeared = await waitFor(() => /[a-z]/i.test(screen()), 20000);
  const first = screen();
  check('the CLI started in the container and its screen reached the browser', appeared && c.bytes() > 0,
    `--- tmux screen ---\n${first}\n--- ${c.bytes()} bytes received over WS ---`);
  check('browser size is applied to the session (resize)',
    tmux('display', '-p', '-t', session, '#{window_width}x#{window_height}').trim() === '100x30');
  check('ANSI colour / cursor sequences pass through untouched',
    /\x1b\[[0-9;]*m/.test(c.text()) && /\x1b\[[0-9;]*H/.test(c.text()));

  // Interactive selection prompt: arrow down must move the selection, like in a real terminal.
  // Compare only the selected line (the welcome screen has an animated logo).
  const selected = () => (screen().split('\n').find((l) => l.includes('❯')) || '').trim();
  const sel0 = selected();
  c.key('\x1b[B');
  await wait(800);
  const sel1 = selected();
  check('arrow-down key reaches the CLI and moves its selection', sel1 !== '' && sel1 !== sel0,
    `  "${sel0}" -> "${sel1}"`);
  c.key('\x1b[A');
  await wait(800);
  check('arrow-up moves it back', selected() === sel0);

  c.resize(80, 24);
  await wait(800);
  check('resize to 80x24 re-flows the session',
    tmux('display', '-p', '-t', session, '#{window_width}x#{window_height}').trim() === '80x24');

  // Page reload: drop the socket, reconnect, the same process must still be there.
  const pid = panePid();
  c.ws.close();
  await wait(1000);
  const c2 = await connect();
  c2.resize(100, 30);
  const redrawn = await waitFor(() => c2.bytes() > 200, 5000);
  check('page reload: reconnect shows the running session (same process, screen redrawn)',
    redrawn && panePid() === pid, `  pane pid ${pid}, ${c2.bytes()} bytes on reconnect`);
  c2.ws.close();
  await wait(1000);
  check('no tmux client is left behind after the browser disconnects', clients() === 0,
    `  clients: ${clients()}`);

  const hist = Buffer.from(await (await fetch(`http://${BASE}/history?session=${session}`)).arrayBuffer());
  check('history: raw pane output is recorded (replayable in a read-only terminal)',
    hist.length > 0 && hist.includes(0x1b), `  ${hist.length} bytes recorded`);
  process.stdout.write(`PANE_PID=${pid}\n`);
}

main()
  .then(() => {
    const failed = results.filter((r) => !r).length;
    process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    process.stderr.write(`terminal PoC error: ${err.message}\n`);
    process.exit(1);
  });
