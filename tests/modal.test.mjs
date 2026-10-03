import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Modal worker is private, bounded, pinned, and single-container', async () => {
  const source = await readFile(new URL('../backend/model/modal/app.py', import.meta.url), 'utf8');
  assert.match(source, /gpu="T4"/);
  assert.match(source, /max_containers=1/);
  assert.match(source, /requires_proxy_auth=True/);
  assert.match(source, /MODEL_REVISION = "fb8cf0d93e2437f8d639549c67733ca9db10e055"/);
  assert.match(source, /MAX_AUDIO_BYTES = 10 \* 1024 \* 1024/);
  assert.doesNotMatch(source, /unauthenticated=True|allow_origins/);
});

test('Modal credentials remain server-side', async () => {
  const sources = await Promise.all([
    readFile(new URL('../frontend/shell/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../frontend/shell/app.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../frontend/transport/coach-api.mjs', import.meta.url), 'utf8'),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /Modal-Key|Modal-Secret|COACH_MODAL_TOKEN/);
  }
});
