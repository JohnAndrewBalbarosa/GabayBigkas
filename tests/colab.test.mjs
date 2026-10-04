import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const notebookPath = new URL('../backend/model/experiments/colab/buzzasr_colab_gpu.ipynb', import.meta.url);
const bundlePath = new URL('../backend/api/src/inference_bundle.rs', import.meta.url);
const routesPath = new URL('../backend/api/src/routes.rs', import.meta.url);

test('Colab notebook validates the bounded bundle and pinned CUDA runtime', async () => {
  const notebook = JSON.parse(await readFile(notebookPath, 'utf8'));
  const source = notebook.cells.flatMap(cell => cell.source ?? []).join('');

  assert.equal(notebook.nbformat, 4);
  assert.match(source, /transformers==4\.57\.1/);
  assert.match(source, /torch\.cuda\.is_available\(\)/);
  assert.match(source, /torch\.cuda\.get_device_name/);
  assert.match(source, /fb8cf0d93e2437f8d639549c67733ca9db10e055/);
  assert.match(source, /\{'manifest\.json', 'audio\.wav'\}/);
  assert.match(source, /hashlib\.sha256\(audio\)\.hexdigest\(\)/);
  assert.match(source, /files\.upload\(\)/);
  assert.match(source, /files\.download\(output_name\)/);
  assert.match(source, /return_timestamps='word'/);
  assert.doesNotMatch(source, /torch_xla/);
  assert.doesNotMatch(source, /ngrok|cloudflare|serveo|ssh|127\.0\.0\.1:4318/i);
  assert.doesNotMatch(source, /AGORA_|AWS_|session_cookie/i);
});

test('Colab direct mode processes one HTTPS job without a persistent worker', async () => {
  const notebook = JSON.parse(await readFile(notebookPath, 'utf8'));
  const source = notebook.cells.flatMap(cell => cell.source ?? []).join('');

  assert.match(source, /getpass\.getpass/);
  assert.match(source, /\/poc-export/);
  assert.match(source, /\/poc-import/);
  assert.match(source, /Bearer \{POC_TOKEN\}/);
  assert.match(source, /scheme == 'https'/);
  assert.doesNotMatch(source, /while\s+True|brpop|lpop|redis\.|time\.sleep\(|auto.?retry/i);
});

test('Rust export and Colab agree on the manifest contract', async () => {
  const [bundle, notebook] = await Promise.all([
    readFile(bundlePath, 'utf8'),
    readFile(notebookPath, 'utf8'),
  ]);
  for (const field of [
    'schema_version', 'job_id', 'audio_sha256', 'sample_rate', 'channels',
    'model_id', 'model_revision', 'created_at', 'expires_at',
  ]) {
    assert.ok(bundle.includes(field), `Rust bundle is missing ${field}`);
    assert.ok(notebook.includes(field), `Colab notebook is missing ${field}`);
  }
});

test('Rust does not expose deprecated manual inference or Colab routes', async () => {
  const routes = await readFile(routesPath, 'utf8');

  assert.doesNotMatch(routes, /\.route\("\/api\/inference\/jobs/);
  assert.doesNotMatch(routes, /poc-(ticket|export|import)/);
  assert.doesNotMatch(routes, /modal-run/);
});
