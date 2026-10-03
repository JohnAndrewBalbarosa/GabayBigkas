import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const specs = [
  ['pull', 'Media Pull', 'Kumuha ng external stream papasok sa RTC.', 'media-pull', 'basic'],
  ['push', 'Media Push', 'I-push ang RTC output papunta sa CDN.', 'media-push', 'basic'],
  ['chat', 'Chat', 'Persistent messaging, users, groups, at presence.', 'im', 'chat'],
  ['whiteboard', 'Interactive Whiteboard', 'Shared rooms para sa drawing at collaboration.', 'whiteboard/room-management', 'whiteboard'],
  ['analytics', 'Analytics', 'Call quality, session diagnostics, at usage reports.', 'agora-analytics/analytics-rest-api', 'basic'],
  ['classroom', 'Flexible Classroom', 'Classroom orchestration para sa education apps.', 'flexible-classroom/classroom-rest-api', 'education'],
];
const products = [];
// Legacy reference pages expose endpoint facts without machine-readable body schemas.
for (const [id, name, description, page, auth] of specs) {
  const docs = `https://docs.agora.io/en/api-reference/api-ref/${page}`;
  const response = await fetch(`${docs}.md`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Reference download failed: ${id}`);
  const text = await response.text();
  const entries = [];
  if (['pull', 'push'].includes(id)) {
    for (const match of text.matchAll(/^(GET|POST|PUT|PATCH|DELETE) (https:\/\/api\.agora\.io\/[^\s`]+)/gm)) entries.push([match[1], match[2].replace(/\?.*$/, '')]);
  } else if (id === 'chat') {
    for (const line of text.split('\n')) {
      const match = line.match(/\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`/);
      if (match) entries.push([match[1], `https://CHAT_HOST/${match[2].replace(/^\//, '')}`]);
    }
  } else if (id === 'whiteboard') {
    entries.push(['POST', 'https://api.netless.link/v5/rooms'], ['GET', 'https://api.netless.link/v5/rooms'], ['GET', 'https://api.netless.link/v5/rooms/{uuid}']);
  } else if (id === 'analytics') {
    for (const match of text.matchAll(/^GET (\/[^\s?]+)\?([^\s]+)/gm)) entries.push(['GET', `https://api.agora.io${match[1]}`, [...new URLSearchParams(match[2]).keys()]]);
  } else if (id === 'classroom') {
    entries.push(['POST', 'https://api.agora.io/{region}/edu/apps/{appid}/v2/rooms/{roomUuid}'], ['GET', 'https://api.agora.io/{region}/edu/apps/{appid}/v2/rooms/{roomUuid}']);
  }
  const seen = new Set();
  const operations = [];
  for (const [method, raw, query = []] of entries) {
    if (raw.includes('<') || raw.includes('>')) continue;
    const url = raw.replace(/\{(?:appId|app_id|YourAppId|yourAppId)\}/g, '{appid}');
    const key = `${method} ${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hostEnd = url.indexOf('/', 8);
    const path = url.slice(hostEnd);
    operations.push({ id: `${id}.${operations.length + 1}`, label: `${method} ${path}`, method, server: url.slice(0, hostEnd), path, parameters: [...path.matchAll(/\{([^}]+)\}/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } })).concat(query.map(name => ({ name, in: 'query', required: true, schema: { type: 'string' } }))), bodyRequired: ['POST', 'PUT', 'PATCH'].includes(method), security: [{ [auth]: [] }], validation: 'partial', ...(method === 'GET' || method === 'DELETE' ? {} : { bodySchema: { type: 'object', minProperties: 1 } }) });
  }
  products.push({ id, name, description, auth, docs, operations, provenance: { url: `${docs}.md`, sha256: createHash('sha256').update(text).digest('hex'), retrieved: new Date().toISOString() }, note: 'Endpoint reference lang: JSON syntax at route parameters ang locally validated; sundin ang official docs para sa payload at business rules.' });
}
products.find(p => p.id === 'chat').github = 'https://github.com/AgoraIO-Usecase/AgoraChat-UIKit-web';
products.find(p => p.id === 'whiteboard').github = 'https://github.com/netless-io/fastboard';
for (const [id, name, description, docs, github] of [
  ['extensions', 'Extensions Marketplace', 'Vendor provisioning, usage, at billing callbacks. Provider-side contracts ito; kailangan ng partner integration.', 'https://docs.agora.io/en/api-reference/api-ref/extensions-marketplace/provisioning', ''],
  ['onprem', 'On-Premise Recording', 'Native recording SDK; kailangan ng Linux host at native build.', 'https://docs.agora.io/en/api-reference/api-ref/on-premise-recording', 'https://github.com/AgoraIO/Recording'],
  ['servergateway', 'Server Gateway', 'Native server media integration; kailangan ng Linux SDK.', 'https://docs.agora.io/en/api-reference/api-ref', ''],
  ['iot', 'IoT SDK', 'Device integration; kailangan ng compatible hardware at native SDK.', 'https://docs.agora.io/en/api-reference/api-ref', ''],
]) products.push({ id, name, description, docs, github, auth: 'specialized', operations: [], note: 'May setup guide; walang executable adapter sa browser lab na ito.' });
await writeFile('data/supplemental.json', `${JSON.stringify(products, null, 2)}\n`);
console.log(JSON.stringify({ event: 'references.imported', products: products.length, operations: products.reduce((n, p) => n + p.operations.length, 0) }));
