import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const port = Number(process.env.COACH_TEST_PORT ?? 4316);
const root = resolve('.artifacts/build/coach');
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
]);

const server = createServer(async (request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"status":"ok"}');
    return;
  }
  try {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const path = resolve(root, relative);
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error('invalid path');
    const body = await readFile(path);
    response.writeHead(200, { 'Content-Type': contentTypes.get(extname(path)) ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'coach.test_server.ready', port }));
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
