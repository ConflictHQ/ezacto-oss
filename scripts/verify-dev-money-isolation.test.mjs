import { readFile } from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'
import { financialFieldNames, runProbe, validateConfig } from './verify-dev-money-isolation.mjs'
const config = () => ({
  origin: 'https://ezacto.io',
  expected_release: 'a'.repeat(40),
  from: '2026-09-01',
  to: '2026-09-30',
  fixtures: { foreign_user_id: 30, foreign_entry_id: 31, foreign_invoice_id: 32 },
  actors: [
    { alias: 'employee', user_id: 10, own_entry_id: 11, session_cookie: 'session=employee' },
    { alias: 'contractor', user_id: 20, own_entry_id: 21, session_cookie: 'session=contractor' },
  ],
})
const response = (body, status = 200) => Response.json(body, { status })
test('refuses production, extra fields and confused subject fixtures before requesting', async () => {
  for (const change of [
    (c) => (c.origin = 'https://app.example.com'),
    (c) => (c.url = 'https://evil.invalid'),
    (c) => (c.fixtures.foreign_user_id = 10),
    (c) => (c.actors[0].session_cookie = 'x=y\r\nAuthorization: secret'),
  ]) {
    const c = config()
    change(c)
    let called = false
    await assert.rejects(
      runProbe(c, async () => {
        called = true
      }),
      /invalid_probe/,
    )
    assert.equal(called, false)
  }
})
test('rejects redirects without following credentials', async () => {
  let calls = 0
  await assert.rejects(
    runProbe(config(), async (_url, options) => {
      calls++
      assert.equal(options.redirect, 'manual')
      return new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid' } })
    }),
    /probe_redirect_refused/,
  )
  assert.equal(calls, 1)
})
test('verifies actual member session identity before fixture reads', async () => {
  const paths = []
  await assert.rejects(
    runProbe(config(), async (url) => {
      paths.push(new URL(url).pathname)
      return paths.length === 1
        ? response({ release: 'a'.repeat(40), environment: 'dev' })
        : response({
            data: {
              user_id: 10,
              profile: 'administrator',
              manager_grants: [],
              authentication: { kind: 'session' },
            },
          })
    }),
    /probe_actor_mismatch/,
  )
  assert.deepEqual(paths, ['/healthz', '/api/v1/whoami'])
})
const fixtureFetch =
  (calls, leak = false, key = 'cost_rate_cents') =>
  async (url, options) => {
    calls.push({ url, options })
    assert.equal(options.method, 'GET')
    assert.equal(new URL(url).origin, 'https://ezacto.io')
    const path = new URL(url).pathname,
      actor = options.headers.cookie === 'session=contractor' ? 20 : 10
    if (path === '/healthz') return response({ release: 'a'.repeat(40), environment: 'dev' })
    if (path === '/api/v1/whoami')
      return response({
        data: {
          user_id: actor,
          profile: 'member',
          manager_grants: [],
          authentication: { kind: 'session' },
        },
      })
    if (path === `/api/v1/time-entries/${actor + 1}`)
      return response({
        data: {
          id: actor + 1,
          user_id: actor,
          seconds: 3600,
          ...(leak ? { [key]: 'PRIVATE_SENTINEL' } : {}),
        },
      })
    if (path === '/api/v1/time-entries/31') return response({ error: { code: 'not_found' } }, 404)
    return response(
      {
        error: {
          code: path === '/api/v1/me/payments' ? 'own_money_disabled' : 'profile_forbidden',
        },
      },
      403,
    )
  }
test('executes both declared subjects with GET only and records sanitized assertions', async () => {
  const calls = [],
    result = await runProbe(config(), fixtureFetch(calls))
  assert.equal(result.passed, true)
  assert.equal(result.actors.length, 2)
  assert.equal(result.actors[0].checks.length, 13)
  assert.equal(calls.length, 29)
  assert.ok(!JSON.stringify(result).includes('session='))
})
test('a forbidden money field fails without leaking its value into evidence', async () => {
  const result = await runProbe(config(), fixtureFetch([], true))
  assert.equal(result.passed, false)
  assert.deepEqual(result.actors[0].checks[0].money_fields_present, ['cost_rate_cents'])
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'))
})

test('financial registry covers native wire-suite fields and new computed monetary aliases', async () => {
  const source = await readFile(
    new URL('../entries/worker/test/money-isolation.e2e.test.ts', import.meta.url),
    'utf8',
  )
  const canonical = [
    ...source.matchAll(
      /\b([a-z_]+):\s*(?:BILLABLE|COST|BUDGET|PROJECT_BILLABLE|PROJECT_COST_BUDGET)\b/g,
    ),
  ].map((match) => match[1])
  assert.ok(canonical.length > 15)
  for (const key of canonical)
    assert.ok(financialFieldNames.includes(key), `Missing native financial field: ${key}`)
  for (const key of ['computed_cost_cents', 'billable_amount_cents', 'budget_burn_cents']) {
    const result = await runProbe(config(), fixtureFetch([], true, key))
    assert.equal(result.passed, false)
    assert.deepEqual(result.actors[0].checks[0].money_fields_present, [key])
    assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'))
  }
})
