import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { products, findOperation } from './catalog.mjs';
import { publicConfig, missingCredentials } from './config.mjs';
import { sampleInput } from './contracts.mjs';
import { executeOperation } from './transport.mjs';
import { issueToken } from './tokens.mjs';

export function createLabServer(config, { log = () => {}, fetcher = fetch, dist = resolve('.artifacts/build/lab') } = {}) {
  const session = randomBytes(32).toString('hex');
  let inFlight = 0;
  let windowStart = Date.now();
  let requests = 0;
  const server = createServer(async (req, res) => {
    const port = server.address().port;
    const expectedHost = `127.0.0.1:${port}`;
    const allowedHosts = [expectedHost, `localhost:${port}`];
    const origin = `http://${req.headers.host}`;
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' https: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
    const send = (status, data) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (!allowedHosts.includes(req.headers.host) || (req.headers.origin && req.headers.origin !== origin)) return send(403, { error: 'Local origin required.' });
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { status: 'ok', liveEnabled: config.liveEnabled });
      if (req.method === 'GET' && url.pathname === '/api/catalog') return send(200, { session, config: publicConfig(config), products: products.map(p => ({ ...p, missing: missingCredentials(config, p), operations: p.operations.map(op => ({ ...op, input: sampleInput(op, config.AGORA_APP_ID) })) })) });
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (!equalSession(req.headers['x-lab-session'], session)) return send(403, { error: 'Invalid local session.' });
        if (Date.now() - windowStart > 60000) { windowStart = Date.now(); requests = 0; }
        if (++requests > 120 || inFlight >= 4) return send(429, { error: 'Subukan ulit mamaya; request limit reached.' });
        const body = await readJson(req);
        inFlight++;
        try {
          if (url.pathname === '/api/execute') {
            if (!['dry-run', 'live'].includes(body.mode) || !isObject(body.path ?? {}) || !isObject(body.query ?? {})) return send(400, { error: 'Kailangan ang valid mode, path object, at query object.' });
            return send(200, await executeOperation(findOperation(body.operationId), body, config, { fetcher, log }));
          }
          if (url.pathname === '/api/token') {
            const token = issueToken(config, body);
            log({ event: 'agora.token.issued', component: 'token-service', operation: body.type, outcome: 'success' });
            return send(200, token);
          }
          return send(404, { error: 'Unknown route.' });
        } finally { inFlight--; }
      }
      if (req.method !== 'GET') return send(405, { error: 'Method not allowed.' });
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
      const file = resolve(dist, relative);
      if (!file.startsWith(`${dist}${sep}`) || !['.html', '.css', '.js'].includes(extname(file))) return send(404, { error: 'Not found.' });
      const content = await readFile(file);
      res.writeHead(200, { ...headers, 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' })[extname(file)] });
      res.end(content);
    } catch (error) {
      const status = error.status ?? (error.code === 'ENOENT' ? 404 : 500);
      log({ event: 'http.request.failed', component: 'http', operation: req.method, status: 'error', httpStatus: status });
      send(status, { error: status >= 500 ? 'Internal error; tingnan ang bounded event log.' : error.message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function equalSession(value, session) {
  return typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(session) && timingSafeEqual(Buffer.from(value), Buffer.from(session));
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('JSON content type required.'), { status: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('Payload limit: 64 KB.'), { status: 413 });
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
  if (!isObject(result)) throw Object.assign(new Error('JSON object required.'), { status: 400 });
  return result;
}
