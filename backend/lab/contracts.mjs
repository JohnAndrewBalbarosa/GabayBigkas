import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false, logger: false });
addFormats(ajv);
const validators = new Map();

export function validateInput(operation, input) {
  const issues = [];
  for (const parameter of operation.parameters) {
    const values = parameter.in === 'path' ? input.path : input.query;
    const value = values?.[parameter.name];
    if (value === undefined || value === '') {
      if (parameter.required) issues.push(`${parameter.in}.${parameter.name}: required`);
      continue;
    }
    const normalized = coerceParameter(value, parameter.schema);
    issues.push(...checkSchema(parameter.schema, normalized, `${parameter.in}.${parameter.name}`));
  }
  if (operation.bodyRequired && input.body === undefined) issues.push('body: required');
  if (input.body !== undefined && operation.bodySchema) issues.push(...checkSchema(operation.bodySchema, input.body, 'body'));
  if (['GET', 'DELETE'].includes(operation.method) && input.body !== undefined) issues.push('Walang request body sa operation na ito.');
  for (const key of Object.keys(input.query ?? {})) if (!operation.parameters.some(p => p.in === 'query' && p.name === key)) issues.push(`query.${key}: hindi dokumentadong parameter`);
  return issues.slice(0, 20);
}

export function checkSchema(schema, value, prefix) {
  const key = JSON.stringify(schema);
  if (!validators.has(key)) validators.set(key, ajv.compile(schema));
  const validate = validators.get(key);
  if (validate(value)) return [];
  return validate.errors.map(error => `${prefix}${error.instancePath}: ${error.message}${error.params.missingProperty ? ` (${error.params.missingProperty})` : ''}`);
}

function coerceParameter(value, schema) {
  if (['integer', 'number'].includes(schema.type) && typeof value === 'string' && value.trim()) return Number(value);
  if (schema.type === 'boolean' && ['true', 'false'].includes(value)) return value === 'true';
  if (schema.type === 'array' && typeof value === 'string') return value.split(',').map(item => coerceParameter(item, schema.items ?? {}));
  return value;
}

export function sampleInput(operation, appId = '') {
  const path = {};
  const query = {};
  for (const p of operation.parameters) {
    const example = p.example ?? sampleSchema(p.schema);
    if (p.in === 'path') path[p.name] = /^(appid|app_id)$/i.test(p.name) ? appId || 'YOUR_APP_ID' : example;
    else if (p.required) query[p.name] = example;
  }
  return { path, query, ...(operation.bodySchema ? { body: sampleSchema(operation.bodySchema) } : {}) };
}

export function sampleSchema(schema, depth = 0) {
  if (!schema || depth > 12) return null;
  if (schema.default !== undefined) return schema.default;
  if (schema.example !== undefined) return schema.example;
  if (schema.examples?.length) return schema.examples[0];
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map(s => sampleSchema(s, depth + 1)));
  if (schema.oneOf || schema.anyOf) return sampleSchema((schema.oneOf ?? schema.anyOf)[0], depth + 1);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'object' || schema.properties) return Object.fromEntries((schema.required ?? []).filter(key => schema.properties?.[key]).map(key => [key, sampleSchema(schema.properties[key], depth + 1)]));
  if (type === 'array') return Array.from({ length: Math.min(Math.max(schema.minItems ?? 1, 1), 5) }, () => sampleSchema(schema.items, depth + 1));
  if (type === 'integer' || type === 'number') return schema.minimum ?? 1;
  if (type === 'boolean') return false;
  return 'REPLACE_ME';
}
