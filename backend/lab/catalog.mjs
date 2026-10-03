import { readFileSync } from 'node:fs';

const read = file => JSON.parse(readFileSync(new URL(`../../data/${file}`, import.meta.url), 'utf8'));
export const products = [...read('contracts.json'), ...read('supplemental.json')];
export const operations = new Map(products.flatMap(product => product.operations.map(operation => [operation.id, { ...operation, product }])));

export function findOperation(id) {
  const operation = operations.get(id);
  if (!operation) throw Object.assign(new Error('Hindi kilalang operation.'), { status: 404 });
  return operation;
}
