import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const awsReadmePath = new URL('../backend/model/deployment/aws/README.md', import.meta.url);
const postMvpPath = new URL('../docs/POST_MVP_AWS_GPU_PLAN.md', import.meta.url);
const lightsailReadmePath = new URL('../backend/deployment/lightsail/README.md', import.meta.url);
const lightsailServicePath = new URL('../backend/deployment/lightsail/gabaybigkas.service', import.meta.url);

test('paid AWS GPU infrastructure is documentation-only and deferred', async () => {
  const [readme, plan] = await Promise.all([
    readFile(awsReadmePath, 'utf8'),
    readFile(postMvpPath, 'utf8'),
  ]);
  assert.match(readme, /deferred/i);
  assert.match(plan, /post-MVP/i);
  assert.match(plan, /paid GPU/i);
  for (const type of ['g4dn', 'g5', 'g6']) {
    assert.ok(plan.includes(type), `missing deferred AWS GPU family ${type}`);
  }
  for (const path of ['template.yaml', 'Dockerfile', 'requirements.lock', 'validate.ps1']) {
    await assert.rejects(access(new URL(`../backend/model/deployment/aws/${path}`, import.meta.url)));
  }
});

test('Lightsail guidance runs only the Rust backend and avoids free-plan guarantees', async () => {
  const [readme, service] = await Promise.all([
    readFile(lightsailReadmePath, 'utf8'),
    readFile(lightsailServicePath, 'utf8'),
  ]);
  assert.match(readme, /Rust backend only/i);
  assert.match(readme, /account-specific/i);
  assert.match(service, /ExecStart=.*coach-api/);
  assert.doesNotMatch(service, /python|docker|model|cuda/i);
  assert.doesNotMatch(readme, /permanently free|always free/i);
  await access(new URL('../backend/api/Cargo.toml', import.meta.url));
});
