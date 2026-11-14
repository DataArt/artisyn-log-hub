// Minimal stand-in for a Log Hub server: serves <dir>/<file> at /static/<file> and answers every
// other path with 404. Usage: node serve.mjs <static-dir> <port>
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const [dir, portArg] = process.argv.slice(2);
if (!dir || !portArg) {
  console.error('usage: node serve.mjs <static-dir> <port>');
  process.exit(2);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  console.log(`${req.method} ${url.pathname}`);
  if (url.pathname.startsWith('/static/')) {
    const file = join(dir, basename(url.pathname));
    if (existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      createReadStream(file).pipe(res);
      return;
    }
  }
  res.writeHead(404).end();
});
server.listen(Number(portArg), '0.0.0.0', () => console.log(`serving ${dir} on ${portArg}`));
