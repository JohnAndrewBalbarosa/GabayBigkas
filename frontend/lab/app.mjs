import { setupRtc } from './rtc.mjs';

const $ = id => document.getElementById(id);
const state = { catalog: null, product: null, operation: null, result: null, liveResponses: 0 };

// Mental model: load the local catalog, choose a capability, then preview or explicitly execute.
async function boot() {
  try {
    const response = await fetch('/api/catalog');
    if (!response.ok) throw new Error('The catalog could not be loaded.');
    state.catalog = await response.json();
    const { products, config } = state.catalog;
    setupRtc({ config, api });
    bindActions();
    $('products-count').textContent = products.length;
    $('operations-count').textContent = products.reduce((n, p) => n + p.operations.length, 0);
    $('schema-count').textContent = products.reduce((n, p) => n + p.operations.filter(o => o.validation !== 'partial').length, 0);
    $('mode').textContent = config.liveEnabled ? 'LIVE MODE ENABLED' : 'OFFLINE MODE';
    $('notice').textContent = config.liveEnabled ? 'Live requests are enabled. Every request is manual, and live tasks may incur usage charges.' : 'Offline mode — validate without keys. Dry runs make no Agora API calls and do not count as live verification.';
    $('readiness').textContent = JSON.stringify({ credentialsPresent: config.credentials, rtcConfigured: config.rtcReady, liveVerified: false }, null, 2);
    renderProducts();
    selectProduct(products[0]);
  } catch (error) { $('notice').textContent = error.message; $('notice').classList.add('error'); }
}

function bindActions() {
  $('search').addEventListener('input', renderProducts);
  $('operation').addEventListener('change', () => selectOperation(state.product.operations.find(o => o.id === $('operation').value)));
  $('reset').addEventListener('click', () => selectOperation(state.operation));
  $('dry-run').addEventListener('click', () => run('dry-run'));
  $('live-run').addEventListener('click', () => run('live'));
  $('export-result').addEventListener('click', exportResult);
  $('generate-token').addEventListener('click', generateToken);
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b === button));
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('hidden', panel.id !== button.dataset.tab));
  }));
}

function renderProducts() {
  $('product-list').replaceChildren();
  const term = $('search').value.toLowerCase();
  for (const product of state.catalog.products.filter(p => `${p.name} ${p.description}`.toLowerCase().includes(term))) {
    const button = document.createElement('button');
    button.className = `product-button${state.product?.id === product.id ? ' active' : ''}`;
    const name = document.createElement('span'); name.textContent = product.name;
    const count = document.createElement('small'); count.textContent = product.operations.length || 'SDK';
    button.append(name, count);
    button.addEventListener('click', () => selectProduct(product));
    $('product-list').append(button);
  }
}

function selectProduct(product) {
  state.product = product;
  renderProducts();
  const heading = document.createElement('h2'); heading.textContent = product.name;
  const description = document.createElement('p'); description.className = 'description'; description.textContent = product.description;
  const links = document.createElement('div'); links.className = 'links';
  for (const [label, url] of [['Official docs ↗', product.docs], ['GitHub sample ↗', product.github]]) if (url) {
    const link = document.createElement('a'); link.href = url; link.textContent = label; link.target = '_blank'; link.rel = 'noopener noreferrer'; links.append(link);
  }
  $('product-heading').replaceChildren(heading, description, links);
  $('operation').replaceChildren(...product.operations.map(op => { const option = document.createElement('option'); option.value = op.id; option.textContent = `${op.method} · ${op.label}`; return option; }));
  selectOperation(product.operations[0]);
}

function selectOperation(operation) {
  state.operation = operation;
  state.result = null;
  const available = Boolean(operation);
  $('dry-run').disabled = !available;
  $('live-run').disabled = !available || !state.catalog.config.liveEnabled;
  $('request').disabled = !available;
  $('reset').disabled = !available;
  $('operation').disabled = !available;
  $('request').value = available ? JSON.stringify(operation.input, null, 2) : '';
  $('operation-details').textContent = available ? `${operation.method} ${operation.server}${operation.path} · ${operation.validation === 'partial' ? 'PARTIAL VALIDATION — legacy reference' : 'OPENAPI CONTRACT'}` : state.product.note;
  $('schema').textContent = available ? JSON.stringify({ parameters: operation.parameters, bodySchema: operation.bodySchema, source: state.product.provenance }, null, 2) : state.product.note;
  $('result').textContent = state.product.note || 'No request yet. Run local validation before a live test.';
  $('result-status').textContent = available ? 'NOT TESTED YET' : 'SPECIALIZED SETUP';
}

async function run(mode) {
  if (!state.operation) return;
  const operation = state.operation;
  if (mode === 'live' && !window.confirm(`Send ${operation.method} ${operation.label} to Agora? This may create or change live resources. Stop any created tasks after the test.`)) return;
  $('dry-run').disabled = true; $('live-run').disabled = true;
  try {
    const input = JSON.parse($('request').value);
    state.result = await api('/api/execute', { ...input, operationId: operation.id, mode, ...(mode === 'live' ? { confirm: operation.id } : {}) });
    $('result').textContent = JSON.stringify(state.result, null, 2);
    $('result-status').textContent = ({ 'dry-run': 'LOCAL VALIDATION ONLY', invalid: 'FIX THE INPUT', blocked: 'SETUP REQUIRED', 'live-response': 'LIVE RESPONSE RECEIVED', 'provider-error': 'PROVIDER ERROR', 'network-error': 'NETWORK ERROR' })[state.result.status];
    if (state.result.status === 'live-response') $('live-count').textContent = ++state.liveResponses;
  } catch (error) { $('result-status').textContent = 'INPUT / REQUEST ERROR'; $('result').textContent = error.message; }
  finally { $('dry-run').disabled = !state.operation; $('live-run').disabled = !state.operation || !state.catalog.config.liveEnabled; }
}

async function api(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lab-Session': state.catalog.session }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function exportResult() {
  if (!state.result) { $('result').textContent = 'Run validation before exporting.'; return; }
  const blob = new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), operation: state.operation.id, result: state.result }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = 'agora-test-result.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function generateToken() {
  $('generate-token').disabled = true;
  try {
    const type = $('token-type').value;
    const data = await api('/api/token', { type, channel: $('token-channel').value, uid: type === 'rtc' ? Number($('token-uid').value) : $('token-uid').value, ttl: 900 });
    $('token-result').textContent = JSON.stringify(data, null, 2);
  } catch (error) { $('token-result').textContent = error.message; }
  finally { $('generate-token').disabled = false; }
}

boot();
