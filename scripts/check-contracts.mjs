import { products, operations } from '../backend/lab/catalog.mjs';
import { checkSchema } from '../backend/lab/contracts.mjs';

let schemas = 0;
for (const operation of operations.values()) {
  if (!operation.server.startsWith('https://') || !operation.path.startsWith('/')) throw new Error(`Invalid route ${operation.id}`);
  const named = [...operation.path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
  for (const name of named) if (!operation.parameters.some(p => p.in === 'path' && p.name === name)) throw new Error(`Missing parameter ${operation.id} ${name}`);
  for (const schema of [...operation.parameters.map(p => p.schema), ...(operation.bodySchema ? [operation.bodySchema] : [])]) { checkSchema(schema, undefined, 'compile'); schemas++; }
}
const expected = products.reduce((n, p) => n + p.operations.length, 0);
if (operations.size !== expected) throw new Error('Duplicate operation IDs');
console.log(JSON.stringify({ event: 'contracts.checked', products: products.length, operations: operations.size, schemas }));
