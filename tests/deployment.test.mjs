import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('production frontend uses credentialed sessions and an injected API origin', async () => {
  const [transport, app, build, html] = await Promise.all([
    readFile(new URL('../frontend/transport/coach-api.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../frontend/shell/app.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../frontend/shell/index.html', import.meta.url), 'utf8'),
  ]);
  assert.equal(transport.match(/credentials: 'include'/g)?.length, 3);
  assert.match(app, /GABAYBIGKAS_API_BASE_URL/);
  assert.match(app, /api\.session\(\)/);
  assert.match(app, /api\.logout\(\)/);
  assert.doesNotMatch(app, /localStorage|sessionStorage/);
  assert.match(build, /COACH_PUBLIC_API_BASE_URL/);
  assert.doesNotMatch(html, /stylesheet|style=/);
});

test('deployment artifacts pin the public IP and preserve a loopback backend', async () => {
  const [workflow, nginx, service] = await Promise.all([
    readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8'),
    readFile(new URL('../backend/deployment/lightsail/gabaybigkas-nginx.conf', import.meta.url), 'utf8'),
    readFile(new URL('../backend/deployment/lightsail/gabaybigkas.service', import.meta.url), 'utf8'),
  ]);
  assert.match(workflow, /https:\/\/54\.179\.89\.16/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:4320/);
  assert.match(nginx, /ssl_certificate/);
  assert.match(service, /EnvironmentFile=\/etc\/gabaybigkas\/coach\.env/);
});

test('local Rust services load the repository environment file', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(manifest.scripts['start:coach'], /--env-file-if-exists=\.env/);
  assert.match(manifest.scripts['start:model'], /--env-file-if-exists=\.env/);
});
