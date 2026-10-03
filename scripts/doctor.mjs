import { readConfig, publicConfig, missingCredentials } from '../backend/lab/config.mjs';
import { products } from '../backend/lab/catalog.mjs';
import { existsSync } from 'node:fs';

const config = readConfig();
console.log(JSON.stringify({ event: 'readiness.checked', node: process.version, buildPresent: existsSync('.artifacts/build/lab/index.html'), mode: config.liveEnabled ? 'live-enabled' : 'offline', configuration: publicConfig(config), products: products.map(p => ({ id: p.id, operations: p.operations.length, missing: missingCredentials(config, p) })), liveVerified: false }));
