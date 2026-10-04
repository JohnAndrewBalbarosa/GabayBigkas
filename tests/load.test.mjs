import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const collection = JSON.parse(readFileSync(new URL('../scripts/load/learner-read.postman_collection.json', import.meta.url), 'utf8'))
const workload = collection.item[0]
const preflight = workload.event.find((event) => event.listen === 'prerequest').script.exec.join('\n')
const validFixture = {
  baseUrl: 'http://127.0.0.1:4320',
  sessionToken: 'local-test-token',
  sessionId: '11111111-1111-4111-8111-111111111111',
}

function runPreflight(variables) {
  const pm = { variables: { get: (key) => variables[key] } }
  runInNewContext(preflight, { pm, Error, String })
}

test('learner workload contains only the intended authenticated GETs', () => {
  assert.deepEqual(workload.item.map(({ request }) => [request.method, request.url]), [
    ['GET', '{{baseUrl}}/api/auth/session'],
    ['GET', '{{baseUrl}}/api/coaching/sessions/{{sessionId}}'],
    ['GET', '{{baseUrl}}/api/coaching/sessions/{{sessionId}}/result'],
  ])
  for (const item of workload.item) {
    assert.deepEqual(item.request.header, [{ key: 'Cookie', value: 'coach_session={{sessionToken}}' }])
  }
  assert.equal(collection.variable.find(({ key }) => key === 'sessionToken').value, '')
})

test('preflight accepts local fixture and blocks missing or unapproved remote fixture', () => {
  assert.doesNotThrow(() => runPreflight(validFixture))
  assert.throws(() => runPreflight({ ...validFixture, sessionToken: '' }), /sessionToken/)
  assert.throws(() => runPreflight({ ...validFixture, sessionId: 'other' }), /sessionId/)
  assert.throws(() => runPreflight({ ...validFixture, baseUrl: 'https://example.test' }), /approvedBaseUrl/)
  assert.throws(() => runPreflight({ ...validFixture, baseUrl: 'https://example.test', approvedBaseUrl: 'https://different.test' }), /approvedBaseUrl/)
  assert.doesNotThrow(() => runPreflight({ ...validFixture, baseUrl: 'https://example.test', approvedBaseUrl: 'https://example.test' }))
})
