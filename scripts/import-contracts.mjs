import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

const sources = JSON.parse(await readFile('data/sources.json', 'utf8'));
const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
const keywords = new Set(['type', 'enum', 'const', 'required', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'additionalProperties', 'properties', 'items', 'allOf', 'anyOf', 'oneOf', 'not', 'format', 'default', 'examples', 'example']);
const products = [];

// Mental model: fetch published contracts, retain validation facts, then pin provenance.
for (const source of sources) {
  const url = `https://docs.agora.io${source.spec}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Contract download failed: ${source.id} ${response.status}`);
  const raw = await response.text();
  const spec = parse(raw);
  const operations = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!methods.has(method) || op.deprecated) continue;
      const server = (op.servers ?? item.servers ?? spec.servers)?.[0]?.url;
      if (!server) throw new Error(`Missing server: ${source.id} ${path}`);
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(p => resolve(p, spec));
      const request = resolve(op.requestBody ?? {}, spec);
      const media = request.content?.['application/json'];
      operations.push({
        id: `${source.id}.${op.operationId ?? `${method}-${operations.length}`}`,
        label: op.summary ?? `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(), server, path,
        parameters: params.filter(p => ['path', 'query'].includes(p.in)).map(p => ({ name: p.name, in: p.in, required: Boolean(p.required), schema: normalize(p.schema ?? {}, spec), ...(p.example !== undefined ? { example: p.example } : {}) })),
        bodyRequired: Boolean(request.required),
        ...(media ? { bodySchema: normalize(media.schema ?? {}, spec) } : {}),
        security: op.security ?? spec.security ?? [],
      });
    }
  }
  products.push({ ...source, docs: `https://docs.agora.io/en/api-reference/api-ref/${source.docs}`, provenance: { url, sha256: createHash('sha256').update(raw).digest('hex'), retrieved: new Date().toISOString(), openapi: spec.openapi }, operations });
}
await writeFile('data/contracts.json', `${JSON.stringify(products, null, 2)}\n`);
console.log(JSON.stringify({ event: 'contracts.imported', products: products.length, operations: products.reduce((n, p) => n + p.operations.length, 0) }));

function resolve(value, spec) {
  if (!value.$ref) return value;
  if (!value.$ref.startsWith('#/')) throw new Error('External schema references require review');
  return value.$ref.slice(2).split('/').reduce((node, key) => node[key.replaceAll('~1', '/').replaceAll('~0', '~')], spec);
}

function normalize(schema, spec, depth = 0) {
  if (depth > 40) throw new Error('Recursive schema requires an explicit adapter');
  if (typeof schema === 'boolean') return schema;
  schema = resolve(schema, spec);
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!keywords.has(key)) continue;
    if (key === 'properties') result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, normalize(child, spec, depth + 1)]));
    else if (['allOf', 'anyOf', 'oneOf'].includes(key)) result[key] = value.map(child => normalize(child, spec, depth + 1));
    else if (['items', 'additionalProperties', 'not'].includes(key) && typeof value === 'object') result[key] = normalize(value, spec, depth + 1);
    else if (key === 'exclusiveMinimum' && typeof value === 'boolean') { if (value) result[key] = schema.minimum; }
    else if (key === 'exclusiveMaximum' && typeof value === 'boolean') { if (value) result[key] = schema.maximum; }
    else result[key] = value;
  }
  if (schema.nullable && result.type) result.type = [result.type, 'null'].flat();
  return result;
}
