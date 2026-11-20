// Fake OpenAI-compatible chat-completions server for the PoC (runs inside the container).
// Logs every request body to <log file> and streams a slow answer, so the TUI stays "busy"
// long enough to capture the screen. No real model and no API key needed.
//
//   node fake-llm.mjs <port> <log file> [seconds to stream]
import http from 'node:http';
import fs from 'node:fs';

const [portArg, logFile, secondsArg] = process.argv.slice(2);
if (!portArg || !logFile) {
  console.error('usage: node fake-llm.mjs <port> <log file> [seconds]');
  process.exit(2);
}
const port = Number(portArg);
const seconds = Number(secondsArg ?? '20');

function chunk(delta, finish) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-poc',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'poc-model',
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  })}\n\n`;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => {
    body += d;
  });
  req.on('end', () => {
    fs.appendFileSync(logFile, `${req.method} ${req.url}\n${body}\n\n`);
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(chunk({ role: 'assistant', content: '' }));
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (n > seconds) {
        clearInterval(timer);
        res.write(chunk({}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write(chunk({ content: `word${n} ` }));
    }, 1000);
    req.on('close', () => clearInterval(timer));
  });
});
server.listen(port, '127.0.0.1', () => console.log(`fake llm on ${port}`));
