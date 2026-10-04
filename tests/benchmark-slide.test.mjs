import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { percentile, summarizeStage, validateLiveTarget, sendRead, verifyFixture, runStage } from '../scripts/load/learner-stress.mjs'
import { slideFields, validateReport } from '../scripts/pitch/refresh-slide-data.mjs'

function completedReport() {
  return {
    kind: 'learner-read', target: 'https://54.179.89.16', outcome: 'passed',
    generatedAt: '2026-10-04T00:00:00Z', commit: 'abcdef0', maxRps: 150, maxRequests: 12_000,
    stages: [1, 10, 25, 50, 100].map((vus) => ({ vus, completed: true, requests: 300, successes: 300, failures: 0, rps: 20, p95Ms: 42, p99Ms: 55, errorRatePercent: 0 })),
  }
}

test('live target requires explicit flag and exact approved HTTPS origin', () => {
  assert.throws(() => validateLiveTarget('https://54.179.89.16', false), /--live/)
  assert.throws(() => validateLiveTarget('http://54.179.89.16', true), /exactly/)
  assert.throws(() => validateLiveTarget('https://example.test', true), /exactly/)
  assert.throws(() => validateLiveTarget('https://54.179.89.16/path', true), /exactly/)
  assert.throws(() => validateLiveTarget('https://user:secret@54.179.89.16', true), /exactly/)
  assert.equal(validateLiveTarget('https://54.179.89.16', true), 'https://54.179.89.16')
})

test('stage summary counts rejections and uses nearest-rank tail latency', () => {
  const summary = summarizeStage([
    { status: 200, latencyMs: 10 },
    { status: 200, latencyMs: 20 },
    { status: 503, latencyMs: 30 },
    { failure: 'timeout', latencyMs: 4000 },
  ], 2000, 4)
  assert.equal(percentile([], 0.95), null)
  assert.equal(summary.p95Ms, 4000)
  assert.equal(summary.rps, 2)
  assert.equal(summary.errorRatePercent, 50)
  assert.equal(summary.statuses['503'], 1)
  assert.equal(summary.statuses.timeout, 1)
})

test('slide fields do not turn read traffic into completed sessions or invent absent metrics', () => {
  const absent = slideFields({}, null)
  assert.equal(absent.rps, '—')
  assert.equal(absent.loadStatus, 'Awaiting live run')
  const report = completedReport()
  const fields = slideFields({ suitePassedAt: '2026-10-04T00:00:00Z', suiteSourceHash: 'same' }, report, 'same')
  assert.equal(fields.rps, '20.0')
  assert.equal(fields.p95, '42 ms')
  assert.equal(fields.peakVus, '100')
  assert.equal(fields.p99, '55 ms')
  assert.equal(fields.suite, 'Passed 2026-10-04')
  assert.equal(Object.values(fields).join(' ').includes('sessionToken'), false)
})

test('stale suite state and stopped first stage remain explicit evidence', () => {
  const report = completedReport()
  report.outcome = 'stopped'
  report.stopReason = 'error_rate_above_10_percent'
  report.stages = [{ ...report.stages[0], completed: false, failures: 30, successes: 270, errorRatePercent: 10 }]
  const fields = slideFields({ suitePassedAt: report.generatedAt, suiteSourceHash: 'old' }, report, 'new')
  assert.match(fields.suite, /Prior snapshot.*reverify/)
  assert.equal(fields.loadStatus, 'Stopped early')
  assert.equal(fields.requests, '300')
  assert.match(fields.runCommit, /generator.*VPS version unrecorded/)
  report.outcome = 'preflight_failed'
  report.stopReason = 'fixture_preflight_failed'
  report.stages = []
  assert.equal(slideFields({}, report).loadStatus, 'Fixture preflight failed')
  assert.equal(slideFields({}, report).rps, '—')
})

test('report validation rejects forged success, invalid metrics, and excess traffic', () => {
  assert.doesNotThrow(() => validateReport(completedReport()))
  const incomplete = completedReport()
  incomplete.stages.pop()
  assert.throws(() => validateReport(incomplete), /incomplete/)
  const invalid = completedReport()
  invalid.stages[0].p95Ms = NaN
  assert.throws(() => validateReport(invalid), /p95Ms/)
  const excess = completedReport()
  excess.stages[0].requests = excess.stages[0].successes = 12000
  assert.throws(() => validateReport(excess), /request cap/)
})

test('default CLI previews load without credentials or network traffic', () => {
  const result = spawnSync(process.execPath, ['scripts/load/learner-stress.mjs'], { encoding: 'utf8', env: { ...process.env, LOAD_TEST_SESSION_ID: '', LOAD_TEST_SESSION_TOKEN: '' } })
  assert.equal(result.status, 0)
  assert.equal(JSON.parse(result.stdout).requestsSent, 0)
})

test('HTTP adapter sends only guarded GETs and never retains load response bodies', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    return new Response('{"private":"do-not-retain"}', { status: 200 })
  })
  const sample = await sendRead('https://54.179.89.16', '/api/auth/session', 'private-fixture-token')
  assert.equal(sample.status, 200)
  assert.equal(sample.body, undefined)
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.headers.Cookie, 'coach_session=private-fixture-token')
  assert.equal(calls[0].options.signal instanceof AbortSignal, true)
})

test('preflight validates role and both session identities using exactly three reads', async (t) => {
  const paths = ['/api/auth/session', '/api/coaching/sessions/fixture', '/api/coaching/sessions/fixture/result']
  let bodies = [{ role: 'learner' }, { id: 'fixture' }, { session_id: 'fixture' }]
  const mock = t.mock.method(globalThis, 'fetch', async (url) => new Response(JSON.stringify(bodies[paths.indexOf(new URL(url).pathname)])))
  await verifyFixture('https://54.179.89.16', paths, 'private-fixture-token', 'fixture')
  assert.equal(mock.mock.callCount(), 3)
  bodies = [{ role: 'annotator' }, { id: 'fixture' }, { session_id: 'fixture' }]
  await assert.rejects(verifyFixture('https://54.179.89.16', paths, 'private-fixture-token', 'fixture'), /mismatch/)
  bodies = [{ role: 'learner' }, { id: 'other' }, { session_id: 'fixture' }]
  await assert.rejects(verifyFixture('https://54.179.89.16', paths, 'private-fixture-token', 'fixture'), /mismatch/)
})

test('HTTP failures and oversized responses expose only bounded failure categories', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('private payload or token') })
  const failure = await sendRead('https://54.179.89.16', '/api/auth/session', 'private-fixture-token')
  assert.equal(failure.failure, 'transport')
  assert.doesNotMatch(JSON.stringify(failure), /private/)
  mock.mock.mockImplementation(async () => new Response(new Uint8Array(1_048_577)))
  assert.equal((await sendRead('https://54.179.89.16', '/api/auth/session', 'private-fixture-token')).failure, 'response_too_large')
})

test('shared stage budget stays bounded under concurrency and workers rotate routes', async () => {
  const calls = []
  const stage = await runStage('unused', ['auth', 'session', 'result'], 'unused', 2, 8, {
    durationMs: 200, maxRps: 200,
    send: async (_origin, path) => { calls.push(path); return { status: 200, latencyMs: 10 } },
  })
  assert.equal(stage.requests, 8)
  assert.equal(stage.stopReason, 'request_cap_reached')
  assert.equal(stage.completed, false)
  assert.deepEqual([...new Set(calls)].sort(), ['auth', 'result', 'session'])
})

test('stage guard checks sparse stages before escalating and distinguishes latency failures', async () => {
  for (const [sample, reason] of [[{ status: 503, latencyMs: 10 }, 'error_rate_above_10_percent'], [{ status: 200, latencyMs: 2500 }, 'p95_above_2000_ms']]) {
    const stage = await runStage('unused', ['auth'], 'unused', 1, 100, { durationMs: 35, maxRps: 100, send: async () => sample })
    assert.ok(stage.requests < 50)
    assert.equal(stage.stopReason, reason)
    assert.equal(stage.completed, false)
  }
})

test('HTML template has all dynamic evidence fields and human-review boundary', () => {
  const html = readFileSync(new URL('../docs/pitch/gabaybigkas-semi-finals.html', import.meta.url), 'utf8')
  assert.match(html, /BENCHMARK_SLIDE_DATA/)
  assert.match(html, /data-slide-field="rps"/)
  assert.match(html, /data-slide-field="p95"/)
  assert.match(html, /human-reviewed label/)
  assert.doesNotMatch(html, /Slide \d+ of 13/)
})
