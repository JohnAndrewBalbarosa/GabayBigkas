import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const TEMPLATE = resolve('docs/pitch/gabaybigkas-semi-finals.html')
const OUTPUT = resolve('.artifacts/pitch/gabaybigkas-semi-finals.html')
const STATE = resolve('.artifacts/pitch/slide-state.json')
const MARKER = '<!-- BENCHMARK_SLIDE_DATA -->'

export function slideFields(state, report, sourceHash) {
  if (report) validateReport(report)
  const peak = report?.stages?.filter((stage) => stage.requests > 0).at(-1)
  const measured = Boolean(peak)
  const suiteCurrent = state.suiteSourceHash && state.suiteSourceHash === sourceHash
  return {
    ...Object.fromEntries([1, 10, 25, 50, 100].map((vus) => {
      const stage = report?.stages.find((candidate) => candidate.vus === vus)
      const label = `${vus} ${vus === 1 ? 'VU' : 'VUs'}`
      return [`stage${vus}`, stage?.requests > 0 ? formatStageMetrics(stage, label) : `${label} · Awaiting measured results`]
    })),
    suite: state.suitePassedAt ? `${suiteCurrent ? 'Passed' : 'Prior snapshot passed'} ${state.suitePassedAt.slice(0, 10)}${suiteCurrent ? '' : '; reverify changes'}` : 'Awaiting full verification',
    loadStatus: report?.outcome === 'preflight_failed' ? 'Fixture preflight failed' : report?.outcome === 'stopped' ? 'Stopped early' : measured ? 'Measured live' : 'Awaiting live run',
    peakVus: measured ? String(peak.vus) : '—',
    requests: measured ? peak.requests.toLocaleString('en-US') : '—',
    rps: measured ? peak.rps.toFixed(1) : '—',
    p95: measured ? `${peak.p95Ms} ms` : '—',
    p99: measured ? `${peak.p99Ms} ms` : '—',
    errorRate: measured ? `${peak.errorRatePercent}%` : '—',
    runDate: report ? report.generatedAt.slice(0, 10) : 'No live benchmark yet',
    runCommit: report ? `generator ${report.commit}${report.generatorDirty ? ' (modified)' : ''}; VPS version unrecorded` : '—',
    runNote: report
      ? `Three learner GETs; max ${report.maxRps} RPS; ${report.outcome === 'passed' ? 'all stages completed' : report.stopReason}.`
      : 'Performance fields fill after an approved, authenticated live run.',
  }
}

function formatStageMetrics(stage, label) {
  return `${label} · ${stage.rps.toFixed(1)} req/s · p95 ${stage.p95Ms} ms · p99 ${stage.p99Ms} ms · ${stage.errorRatePercent}% errors${stage.completed ? '' : ' · Stopped early'}`
}

export function validateReport(report) {
  if (report.kind !== 'learner-read' || report.target !== 'https://54.179.89.16') {
    throw new Error('Unexpected benchmark target or report kind')
  }
  const profile = [1, 10, 25, 50, 100]
  if (!['passed', 'stopped', 'preflight_failed'].includes(report.outcome) || report.maxRps !== 150 || report.maxRequests !== 12_000) throw new Error('Invalid benchmark limits or outcome')
  if (!Array.isArray(report.stages) || report.stages.length > profile.length) throw new Error('Invalid benchmark stages')
  for (const [index, stage] of report.stages.entries()) {
    for (const key of ['vus', 'requests', 'rps', 'p95Ms', 'p99Ms', 'errorRatePercent', 'successes', 'failures']) {
      if (stage.requests === 0 && ['p95Ms', 'p99Ms', 'errorRatePercent'].includes(key) && stage[key] === null) continue
      if (!Number.isFinite(stage[key]) || stage[key] < 0) throw new Error(`Invalid benchmark ${key}`)
    }
    if (stage.vus !== profile[index] || !Number.isInteger(stage.requests) || stage.successes + stage.failures !== stage.requests || stage.errorRatePercent > 100 || typeof stage.completed !== 'boolean') throw new Error('Inconsistent benchmark stage')
  }
  if (!Number.isFinite(Date.parse(report.generatedAt)) || !/^[0-9a-f]{7,40}$/.test(report.commit)) {
    throw new Error('Invalid benchmark identity')
  }
  if (report.stages.reduce((sum, stage) => sum + stage.requests, 3) > report.maxRequests) throw new Error('Benchmark exceeds request cap')
  if (report.outcome === 'passed' && (report.stages.length !== profile.length || report.stages.some((stage) => !stage.completed || stage.requests === 0 || stage.errorRatePercent > 10 || stage.p95Ms > 2000))) throw new Error('Passed benchmark has incomplete or unhealthy stages')
  if (report.outcome === 'preflight_failed' && report.stages.length) throw new Error('Failed preflight cannot have load stages')
  if (report.outcome !== 'passed' && !/^[a-z0-9_]{1,80}$/.test(report.stopReason ?? '')) throw new Error('Invalid benchmark stop reason')
}

// Hash tracked and untracked source, never ignored runtime data or secrets.
export function sourceFingerprint() {
  const files = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  if (files.status !== 0) throw new Error('Cannot identify verification source snapshot')
  const hash = createHash('sha256')
  for (const file of [...new Set(files.stdout.split('\0').filter(Boolean))].sort()) {
    hash.update(file).update('\0')
    try { hash.update(readFileSync(file)) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      hash.update('deleted')
    }
  }
  return hash.digest('hex')
}

async function readExisting(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

async function refresh() {
  const args = process.argv.slice(2)
  const reportArgument = args.indexOf('--report')
  const state = await readExisting(STATE, {})
  const sourceHash = sourceFingerprint()
  if (args.includes('--suite-passed')) {
    state.suitePassedAt = new Date().toISOString()
    state.suiteSourceHash = sourceHash
  }
  const reportPath = reportArgument >= 0 ? resolve(args[reportArgument + 1]) : resolve('.artifacts/benchmarks/learner-read-latest.json')
  const report = await readExisting(reportPath, null)
  if (report) validateReport(report)
  const template = await readFile(TEMPLATE, 'utf8')
  if (!template.includes(MARKER)) throw new Error('Slide-data marker missing from HTML template')
  const data = JSON.stringify(slideFields(state, report, sourceHash)).replaceAll('<', '\\u003c')
  const html = template.replace(MARKER, `<script>window.GABAYBIGKAS_SLIDE_DATA=${data}</script>`)
  await mkdir(resolve('.artifacts/pitch'), { recursive: true })
  const temporary = `${OUTPUT}.tmp`
  await writeFile(temporary, html)
  await rename(temporary, OUTPUT)
  await writeFile(STATE, `${JSON.stringify(state)}\n`)
  process.stdout.write(`${JSON.stringify({ event: 'pitch.slide_data.refreshed', output: OUTPUT, loadStatus: slideFields(state, report, sourceHash).loadStatus })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  refresh().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
