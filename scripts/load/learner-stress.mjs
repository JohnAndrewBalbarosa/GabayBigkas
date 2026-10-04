import { spawnSync } from 'node:child_process'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const LIVE_ORIGIN = 'https://54.179.89.16'
const PROFILE = [1, 10, 25, 50, 100]
const STAGE_SECONDS = 15
const MAX_RPS = 150
const MAX_REQUESTS = 12_000
const REQUEST_TIMEOUT_MS = 4_000
const MAX_RESPONSE_BYTES = 1_048_576
const RESULT_PATH = resolve('.artifacts/benchmarks/learner-read-latest.json')

export function validateLiveTarget(rawOrigin, live) {
  if (!live) throw new Error('Live run requires --live; no requests were sent')
  if (!rawOrigin) throw new Error('Set --base-url to the approved HTTPS VPS origin')
  const origin = new URL(rawOrigin)
  if (origin.origin !== LIVE_ORIGIN || origin.href !== `${LIVE_ORIGIN}/` || origin.username || origin.password) {
    throw new Error(`Target must be exactly ${LIVE_ORIGIN}`)
  }
  return origin.origin
}

export function percentile(values, rank) {
  if (!values.length) return null
  const ordered = [...values].sort((a, b) => a - b)
  return Math.round(ordered[Math.ceil(rank * ordered.length) - 1])
}

export function summarizeStage(samples, durationMs, vus) {
  const successes = samples.filter((sample) => sample.status === 200).length
  const failures = samples.length - successes
  const latency = samples.map((sample) => sample.latencyMs)
  const statuses = {}
  for (const sample of samples) {
    const key = String(sample.status ?? sample.failure)
    statuses[key] = (statuses[key] ?? 0) + 1
  }
  return {
    vus,
    durationSeconds: Math.round(durationMs) / 1000,
    requests: samples.length,
    successes,
    failures,
    errorRatePercent: samples.length ? Math.round(10_000 * failures / samples.length) / 100 : null,
    rps: Math.round(100 * samples.length / (durationMs / 1000)) / 100,
    p50Ms: percentile(latency, 0.5),
    p95Ms: percentile(latency, 0.95),
    p99Ms: percentile(latency, 0.99),
    statuses,
  }
}

function workloadPaths(sessionId) {
  return [
    '/api/auth/session',
    `/api/coaching/sessions/${sessionId}`,
    `/api/coaching/sessions/${sessionId}/result`,
  ]
}

async function readBoundedResponse(response, retain) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('response_too_large')
    }
    if (retain) chunks.push(value)
  }
  return retain ? Buffer.concat(chunks).toString('utf8') : undefined
}

export async function sendRead(origin, path, token, readBody = false) {
  const started = performance.now()
  try {
    const response = await fetch(`${origin}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Cookie: `coach_session=${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
      cache: 'no-store',
    })
    const body = await readBoundedResponse(response, readBody)
    return {
      status: response.status,
      latencyMs: Math.round(performance.now() - started),
      body: readBody ? body : undefined,
    }
  } catch (error) {
    return {
      failure: error.name === 'TimeoutError' ? 'timeout' : error.message === 'response_too_large' ? 'response_too_large' : 'transport',
      latencyMs: Math.round(performance.now() - started),
    }
  }
}

export async function verifyFixture(origin, paths, token, sessionId) {
  const [auth, session, result] = await Promise.all(paths.map((path) => sendRead(origin, path, token, true)))
  if ([auth, session, result].some((response) => response.status !== 200)) {
    throw new Error('Fixture preflight failed: all three learner reads must return 200')
  }
  try {
    if (JSON.parse(auth.body).role !== 'learner') throw new Error('role')
    if (JSON.parse(session.body).id !== sessionId) throw new Error('session')
    if (JSON.parse(result.body).session_id !== sessionId) throw new Error('result')
  } catch {
    throw new Error('Fixture preflight failed: learner role or owned session mismatch')
  }
}

// Mental model: paced workers share one request budget; a failed guard stops admission.
export async function runStage(origin, paths, token, vus, requestBudget, options = {}) {
  const durationMs = options.durationMs ?? STAGE_SECONDS * 1000
  const maxRps = options.maxRps ?? MAX_RPS
  const send = options.send ?? sendRead
  const samples = []
  const started = performance.now()
  const deadline = started + durationMs
  let nextSlot = started
  let issued = 0
  let stopped = false
  let stopReason = null

  async function worker() {
    let pathIndex = 0
    while (!stopped && performance.now() < deadline && issued < requestBudget) {
      const scheduled = Math.max(nextSlot, performance.now())
      nextSlot = scheduled + 1000 / maxRps
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, scheduled - performance.now())))
      if (stopped || performance.now() >= deadline || issued >= requestBudget) break
      issued += 1
      const sample = await send(origin, paths[pathIndex], token)
      pathIndex = (pathIndex + 1) % paths.length
      samples.push(sample)
      if (samples.length >= 50 && samples.length % 25 === 0) {
        const summary = summarizeStage(samples, performance.now() - started, vus)
        if (stageStopReason(summary)) {
          stopped = true
          stopReason = stageStopReason(summary)
        }
      }
    }
  }

  await Promise.all(Array.from({ length: vus }, () => worker()))
  const summary = summarizeStage(samples, performance.now() - started, vus)
  stopReason ??= stageStopReason(summary)
  if (issued >= requestBudget) stopReason ??= 'request_cap_reached'
  return { ...summary, stopReason, completed: !stopReason && performance.now() >= deadline }
}

function stageStopReason(summary) {
  if (!summary.requests) return 'no_samples'
  if (summary.errorRatePercent > 10) return 'error_rate_above_10_percent'
  if (summary.p95Ms > 2_000) return 'p95_above_2000_ms'
  return null
}

async function writeReport(report) {
  await mkdir(resolve('.artifacts/benchmarks'), { recursive: true })
  const temporary = `${RESULT_PATH}.tmp`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`)
  await rename(temporary, RESULT_PATH)
}

async function run() {
  const args = process.argv.slice(2)
  const live = args.includes('--live')
  const baseUrlPosition = args.indexOf('--base-url')
  if (!live) {
    process.stdout.write(`${JSON.stringify({ event: 'benchmark.plan', target: LIVE_ORIGIN, profile: PROFILE, stageSeconds: STAGE_SECONDS, maxRps: MAX_RPS, maxRequests: MAX_REQUESTS, requestsSent: 0, instruction: 'Gamitin ang --live --base-url sa aprubadong VPS at dedicated learner fixture.' })}\n`)
    return
  }
  const origin = validateLiveTarget(baseUrlPosition >= 0 ? args[baseUrlPosition + 1] : '', live)
  const sessionId = process.env.LOAD_TEST_SESSION_ID
  const token = process.env.LOAD_TEST_SESSION_TOKEN
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId ?? '')) {
    throw new Error('LOAD_TEST_SESSION_ID must be an owned UUID')
  }
  if (!token || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) {
    throw new Error('LOAD_TEST_SESSION_TOKEN must be a private learner cookie value')
  }
  const paths = workloadPaths(sessionId)
  const report = {
    kind: 'learner-read',
    target: LIVE_ORIGIN,
    generatedAt: new Date().toISOString(),
    commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    generatorDirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()),
    serverVersion: 'unrecorded',
    workload: 'three authenticated GETs; one test learner and owned session',
    maxRps: MAX_RPS,
    maxRequests: MAX_REQUESTS,
    stages: [],
    outcome: 'preflight_failed',
  }
  try {
    await verifyFixture(origin, paths, token, sessionId)
  } catch (error) {
    report.stopReason = 'fixture_preflight_failed'
    await writeReport(report)
    refreshSlides()
    throw error
  }
  process.stdout.write(`${JSON.stringify({ event: 'benchmark.fixture.verified', target: LIVE_ORIGIN, at: new Date().toISOString() })}\n`)
  report.outcome = 'passed'
  let remaining = MAX_REQUESTS - paths.length
  for (const vus of PROFILE) {
    process.stdout.write(`${JSON.stringify({ event: 'benchmark.stage.started', vus, durationSeconds: STAGE_SECONDS, at: new Date().toISOString() })}\n`)
    const stage = await runStage(origin, paths, token, vus, remaining)
    report.stages.push(stage)
    process.stdout.write(`${JSON.stringify({ event: 'benchmark.stage.completed', vus, requests: stage.requests, rps: stage.rps, p95Ms: stage.p95Ms, errorRatePercent: stage.errorRatePercent, stopReason: stage.stopReason, at: new Date().toISOString() })}\n`)
    remaining -= stage.requests
    if (stage.stopReason || !stage.completed || remaining <= 0) {
      report.outcome = 'stopped'
      report.stopReason = stage.stopReason ?? (remaining <= 0 ? 'request_cap_reached' : 'stage_incomplete')
      break
    }
  }
  await writeReport(report)
  refreshSlides()
  process.stdout.write(`${JSON.stringify({ outcome: report.outcome, stages: report.stages.map(({ vus, requests, rps, p95Ms, errorRatePercent, stopReason }) => ({ vus, requests, rps, p95Ms, errorRatePercent, stopReason })), report: RESULT_PATH })}\n`)
  if (report.outcome !== 'passed') process.exitCode = 1
}

function refreshSlides() {
  const refresh = spawnSync(process.execPath, ['scripts/pitch/refresh-slide-data.mjs', '--report', RESULT_PATH], { stdio: 'inherit' })
  if (refresh.status !== 0) throw new Error('Slide refresh failed')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
