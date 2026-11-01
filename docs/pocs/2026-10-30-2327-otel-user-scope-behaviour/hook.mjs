// Hook command for the sample sessions: reports the hook event and its time to the mock collector.
import http from 'node:http';

const port = Number(process.argv[2]);
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let ev = {};
  try { ev = JSON.parse(input); } catch { /* keep empty */ }
  const body = JSON.stringify({ t: Date.now(), event: ev.hook_event_name, sessionId: ev.session_id });
  const req = http.request({ host: '127.0.0.1', port, path: '/hook', method: 'POST',
    headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
  req.on('error', () => process.exit(0));
  req.end(body);
});
