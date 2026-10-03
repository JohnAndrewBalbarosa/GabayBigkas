import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('canonical MVP modules exist at their owned paths', async () => {
  const required = [
    'backend/api/Cargo.toml',
    'backend/model/api/Cargo.toml',
    'backend/model/inference/buzzasr_gpu_worker.py',
    'backend/api/src/inference_bundle.rs',
    'backend/model/experiments/colab/buzzasr_colab_gpu.ipynb',
    'backend/deployment/lightsail/gabaybigkas.service',
    'frontend/learner/session.mjs',
    'frontend/annotator/review.mjs',
    'frontend/voice/capture/session-recorder.mjs',
    'SYSTEM.md',
    'docs/MODULE_MAP.md',
  ];
  await Promise.all(required.map(path => access(new URL(path, root))));
  assert.equal(required.length, 11);
});

test('paid AWS GPU deployment artifacts are absent from the MVP', async () => {
  const deferredArtifacts = [
    'backend/model/deployment/aws/template.yaml',
    'backend/model/deployment/aws/Dockerfile',
    'backend/model/deployment/aws/requirements.lock',
  ];
  for (const path of deferredArtifacts) {
    await assert.rejects(access(new URL(path, root)), `${path} must remain post-MVP`);
  }
});

test('legacy top-level source folders are not canonical modules', async () => {
  const legacy = ['server', 'web', 'rust', 'colab', 'notebooks', 'pronunciation-coach'];
  for (const path of legacy) {
    await assert.rejects(access(new URL(`${path}/`, root)), `${path} should not exist`);
  }
});
