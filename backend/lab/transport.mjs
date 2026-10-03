import { randomUUID } from 'node:crypto';
import { missingCredentials } from './config.mjs';
import { validateInput } from './contracts.mjs';

const hosts = new Set(['api.agora.io', 'api.sd-rtn.com', 'api.netless.link']);
const secretKey = /token|secret|password|certificate|authorization|api.?key|access.?key|signature|credential/i;

// Mental model: validate locally, preview by default, then issue exactly one approved request.
export async function executeOperation(operation, input, config, { fetcher = fetch, log = () => {} } = {}) {
  const traceId = randomUUID();
  const started = performance.now();
  const safeInput = { path: { ...input.path }, query: { ...input.query }, ...(input.body !== undefined ? { body: input.body } : {}) };
  for (const p of operation.parameters) if (p.in === 'path' && /^(appid|app_id)$/i.test(p.name) && config.AGORA_APP_ID && !safeInput.path[p.name]) safeInput.path[p.name] = config.AGORA_APP_ID;
  const issues = validateInput(operation, safeInput);
  if (issues.length) return outcome('invalid', { issues });
  let url;
  try { url = buildUrl(operation, safeInput, config); } catch (error) { return outcome('invalid', { issues: [error.message] }); }
  const preview = { method: operation.method, url: redact(url, config), body: redact(safeInput.body, config), authorization: '[server-side only]', validation: operation.validation ?? 'schema', limitations: 'Local validation lang; hindi nito pinapatunayan ang account access, provider business rules, o response schema.' };
  if (input.mode !== 'live') return outcome('dry-run', { preview, networkCalled: false });
  const missing = missingCredentials(config, operation.product, operation);
  if (!config.liveEnabled || missing.length) return outcome('blocked', { missing, reason: !config.liveEnabled ? 'Naka-disable ang live mode sa .env.' : 'Kulang ang product credentials.', networkCalled: false });
  if (input.confirm !== operation.id) return outcome('blocked', { reason: 'Kailangan ang operation confirmation bago tumawag sa Agora.', networkCalled: false });
  if (/REPLACE_ME|YOUR_APP_ID|YOUR_|<[^>]+>/.test(JSON.stringify(safeInput))) return outcome('blocked', { reason: 'Palitan muna ang lahat ng placeholder.', networkCalled: false });
  let providerBody;
  try { providerBody = resolvePayloadSecrets(safeInput.body, config.payloadSecrets ?? {}); }
  catch { return outcome('blocked', { reason: 'May kulang na LAB_SECRET_ value sa server .env.', networkCalled: false }); }
  try {
    const response = await fetcher(url, { method: operation.method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders(operation.product, config) }, ...(providerBody !== undefined ? { body: JSON.stringify(providerBody) } : {}), signal: AbortSignal.timeout(12000), redirect: 'error' });
    const text = await readBoundedResponse(response);
    let data;
    try { data = JSON.parse(text); } catch { data = { message: 'Non-JSON response; raw body omitted.' }; }
    const providerFailed = data?.success === false || data?.status === 'error' || Boolean(data?.error);
    return outcome(response.ok && !providerFailed ? 'live-response' : 'provider-error', { httpStatus: response.status, data: redact(data, config), networkCalled: true, note: 'Response received lang; kailangan pa ng feature-specific verification.' });
  } catch (error) {
    return outcome('network-error', { reason: error.name === 'TimeoutError' ? 'Nag-timeout pagkatapos ng 12 segundo.' : 'Nabigo ang request; walang automatic retry para maiwasan ang duplicate tasks.', networkCalled: true });
  }

  function outcome(status, details) {
    log({ event: 'agora.operation.completed', component: 'middleware', operation: operation.id, traceId, status, durationMs: Math.round(performance.now() - started), httpStatus: details.httpStatus });
    return { status, traceId, ...details };
  }
}

export function buildUrl(operation, input, config) {
  const server = operation.server === 'https://CHAT_HOST' ? chatServer(config.AGORA_CHAT_HOST || 'https://example.chat.agora.io') : operation.server;
  const path = operation.path.replace(/\{([^}]+)\}/g, (_, key) => {
    const value = String(input.path?.[key] ?? '');
    if (!value || value.length > 256 || /[\\/]/.test(value) || [...value].some(character => character.charCodeAt(0) < 32) || value === '.' || value === '..') throw new Error(`Invalid path parameter: ${key}`);
    return encodeURIComponent(value);
  });
  const url = new URL(`${server.replace(/\/$/, '')}${path}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('Invalid provider URL.');
  if (!hosts.has(url.hostname) && !(operation.product.auth === 'chat' && isChatHost(url.hostname))) throw new Error('Provider host is not allowlisted.');
  for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
  return url.toString();
}

function isChatHost(host) {
  return /^[a-z\d.-]+\.(chat\.agora\.io|easemob\.com)$/.test(host);
}

function chatServer(value) {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (!isChatHost(url.hostname) || url.pathname !== '/' || url.search || url.hash || url.username || url.password || url.port || url.protocol !== 'https:') throw new Error('AGORA_CHAT_HOST must be the HTTPS Chat domain from Agora Console.');
  return url.origin;
}

function authHeaders(product, config) {
  if (product.auth === 'whiteboard') return { token: config.AGORA_WHITEBOARD_TOKEN, region: config.whiteboardRegion };
  if (product.auth === 'chat') return { Authorization: `Bearer ${config.AGORA_CHAT_TOKEN}` };
  if (product.auth === 'education') return { Authorization: `agora token=${config.AGORA_EDUCATION_TOKEN}` };
  if (product.auth === 'convo' && config.AGORA_CONVO_TOKEN) return { Authorization: `agora token=${config.AGORA_CONVO_TOKEN}` };
  return { Authorization: `Basic ${Buffer.from(`${config.AGORA_CUSTOMER_ID}:${config.AGORA_CUSTOMER_SECRET}`).toString('base64')}` };
}

async function readBoundedResponse(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 256 * 1024) { await reader.cancel(); throw new Error('Response limit exceeded'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function redact(value, config = {}) {
  if (Array.isArray(value)) return value.map(item => redact(item, config));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? '[REDACTED]' : redact(item, config)]));
  if (typeof value !== 'string') return value;
  let result = value;
  for (const [key, secret] of Object.entries({ ...config, ...config.payloadSecrets })) if (secretKey.test(key) && typeof secret === 'string' && secret.length > 3) result = result.replaceAll(secret, '[REDACTED]');
  return result.replace(/(Bearer|Basic)\s+[A-Za-z\d+/=._-]+/gi, '$1 [REDACTED]');
}

function resolvePayloadSecrets(value, secrets) {
  if (Array.isArray(value)) return value.map(item => resolvePayloadSecrets(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolvePayloadSecrets(item, secrets)]));
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{(LAB_SECRET_[A-Z\d_]+)\}\}/g, (_, key) => {
    if (!secrets[key]) throw new Error('Missing payload secret');
    return secrets[key];
  });
}
