import { readFile, mkdir, cp, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = resolve('.artifacts/packages/event-kit');
// Never reuse a directory that might already hold event credentials.
try { await readdir(target); throw new Error('event-kit already exists; move the existing kit aside before packaging.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(target);
await cp('.artifacts/build/lab', `${target}/.artifacts/build/lab`, { recursive: true });
const allowlist = ['backend/lab', 'data', '.env.example', 'README.md', 'THIRD_PARTY.md', 'package-lock.json', 'verification.json'];
for (const file of allowlist) await cp(file, `${target}/${file}`, { recursive: true });
await mkdir(`${target}/scripts`);
await cp('scripts/doctor.mjs', `${target}/scripts/doctor.mjs`);
const original = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(`${target}/package.json`, `${JSON.stringify({ ...original, scripts: { start: original.scripts.start, doctor: original.scripts.doctor } }, null, 2)}\n`);
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
let dependencies = 0;
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.startsWith('node_modules/') || entry.dev) continue;
  await cp(path, `${target}/${path}`, { recursive: true });
  dependencies++;
}
await writeFile(`${target}/START.cmd`, '@echo off\r\ncd /d "%~dp0"\r\nnode --env-file-if-exists=.env backend/lab/main.mjs\r\npause\r\n');
console.log(JSON.stringify({ event: 'event-kit.packaged', directory: target, runtimePackages: dependencies, credentialsIncluded: false, nodeRequired: '24+' }));
