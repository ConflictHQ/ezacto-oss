#!/usr/bin/env node
/** Read-only #549 API probe. Credentials stay in an operator-owned private file. */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const origin = 'https://ezacto.io'
// Financial keys exercised by the native money-isolation suite; the guard test
// requires this registry to stay in sync. Suffixes also catch new monetary aliases.
export const financialFieldNames = [
  'amount_cents',
  'balance_cents',
  'billable_rate',
  'billable_rate_cents',
  'billable_rates',
  'budget_burn_cents',
  'budget_cents',
  'cost_budget_cents',
  'cost_cents',
  'cost_rate',
  'cost_rate_cents',
  'cost_rates',
  'default_hourly_rate',
  'default_hourly_rate_cents',
  'expense_cents',
  'fee_cents',
  'hourly_rate',
  'hourly_rate_cents',
  'money_budget_cents',
  'node_budget_cents',
  'paid_cents',
  'remaining_cents',
  'spent_cents',
  'time_cents',
  'total_cents',
  'uninvoiced_expense_cents',
  'uninvoiced_time_cents',
  'uninvoiced_total_cents',
]
const fields = new Set(financialFieldNames)
const fail = (code) => {
  throw new Error(code)
}
const id = (value) => Number.isSafeInteger(value) && value > 0
const exactKeys = (value, allowed) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key))
export const validateConfig = (config) => {
  if (
    !exactKeys(config, ['origin', 'expected_release', 'from', 'to', 'fixtures', 'actors']) ||
    config.origin !== origin ||
    !/^[0-9a-f]{40}$/.test(config.expected_release ?? '')
  )
    fail('invalid_probe_config')
  for (const key of ['from', 'to'])
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(config[key] ?? '') ||
      new Date(config[key]).toISOString().slice(0, 10) !== config[key]
    )
      fail('invalid_probe_dates')
  if (config.from > config.to) fail('invalid_probe_dates')
  if (
    !exactKeys(config.fixtures, ['foreign_user_id', 'foreign_entry_id', 'foreign_invoice_id']) ||
    !Object.values(config.fixtures).every(id) ||
    Object.keys(config.fixtures).length !== 3
  )
    fail('invalid_probe_fixtures')
  if (!Array.isArray(config.actors) || config.actors.length !== 2) fail('invalid_probe_actors')
  const aliases = new Set(),
    ids = new Set()
  for (const actor of config.actors) {
    if (
      !exactKeys(actor, ['alias', 'user_id', 'own_entry_id', 'session_cookie']) ||
      !['employee', 'contractor'].includes(actor.alias) ||
      aliases.has(actor.alias) ||
      !id(actor.user_id) ||
      ids.has(actor.user_id) ||
      !id(actor.own_entry_id) ||
      actor.user_id === config.fixtures.foreign_user_id ||
      actor.own_entry_id === config.fixtures.foreign_entry_id ||
      typeof actor.session_cookie !== 'string' ||
      !actor.session_cookie.includes('=') ||
      /[\r\n]/.test(actor.session_cookie) ||
      actor.session_cookie.length > 8192
    )
      fail('invalid_probe_actor')
    aliases.add(actor.alias)
    ids.add(actor.user_id)
  }
  return config
}
const moneyKeys = (value) => {
  if (!value || typeof value !== 'object') return []
  return [
    ...new Set(
      Object.entries(value).flatMap(([key, item]) => [
        ...(fields.has(key) || /(?:_cents|_rates?|_amounts?)$/.test(key) ? [key] : []),
        ...moneyKeys(item),
      ]),
    ),
  ].sort()
}
const readJson = async (response) => {
  if (!response.body) return null
  const reader = response.body.getReader(),
    chunks = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 2 * 1024 * 1024) {
      await reader.cancel()
      fail('probe_response_too_large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}
export async function runProbe(raw, request = globalThis.fetch) {
  const config = validateConfig(raw),
    evidence = {
      origin,
      expected_release: config.expected_release,
      method: 'GET only; redirects refused',
      actors: [],
      passed: false,
    }
  const get = async (path, cookie) => {
    if (!path.startsWith('/api/v1/') && path !== '/healthz') fail('invalid_probe_path')
    let response
    try {
      response = await request(origin + path, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/json', ...(cookie ? { cookie } : {}) },
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      fail('probe_transport_failed')
    }
    if (response.status >= 300 && response.status < 400) fail('probe_redirect_refused')
    return { status: response.status, body: await readJson(response) }
  }
  const health = await get('/healthz')
  if (
    health.status !== 200 ||
    health.body?.release !== config.expected_release ||
    health.body?.environment !== 'dev'
  )
    fail('probe_release_mismatch')
  const range = `from=${config.from}&to=${config.to}`
  for (const actor of config.actors) {
    const who = await get('/api/v1/whoami', actor.session_cookie),
      principal = who.body?.data
    if (
      who.status !== 200 ||
      principal?.user_id !== actor.user_id ||
      principal.profile !== 'member' ||
      principal.authentication?.kind !== 'session' ||
      !Array.isArray(principal.manager_grants) ||
      principal.manager_grants.length
    )
      fail('probe_actor_mismatch')
    const cases = [
      ['own_entry', `/api/v1/time-entries/${actor.own_entry_id}`, 200],
      ['foreign_entry', `/api/v1/time-entries/${config.fixtures.foreign_entry_id}`, 404],
      [
        'foreign_entry_filter',
        `/api/v1/time-entries?user_id=${config.fixtures.foreign_user_id}&per_page=1`,
        403,
      ],
      ['own_billable_rates', `/api/v1/users/${actor.user_id}/billable-rates`, 403],
      [
        'foreign_billable_rates',
        `/api/v1/users/${config.fixtures.foreign_user_id}/billable-rates`,
        403,
      ],
      ['foreign_cost_rates', `/api/v1/users/${config.fixtures.foreign_user_id}/cost-rates`, 403],
      ['invoices', '/api/v1/invoices?per_page=1', 403],
      ['foreign_invoice', `/api/v1/invoices/${config.fixtures.foreign_invoice_id}`, 403],
      ['financial_report', `/api/v1/reports/uninvoiced?${range}`, 403],
      ['financial_export', `/api/v1/reports/detailed-time/export?${range}&format=csv`, 403],
      [
        'foreign_self_report_filter',
        `/api/v1/reports/detailed-time?${range}&self=true&user_id=${config.fixtures.foreign_user_id}`,
        403,
      ],
      [
        'foreign_self_export_filter',
        `/api/v1/reports/detailed-time/export?${range}&self=true&format=csv&user_id=${config.fixtures.foreign_user_id}`,
        403,
      ],
      ['own_money_off', '/api/v1/me/payments', 403],
    ]
    const checks = []
    for (const [name, path, expected] of cases) {
      const result = await get(path, actor.session_cookie),
        found = moneyKeys(result.body)
      const subject =
        name !== 'own_entry' ||
        (result.body?.data?.id === actor.own_entry_id &&
          result.body?.data?.user_id === actor.user_id)
      const setting = name !== 'own_money_off' || result.body?.error?.code === 'own_money_disabled'
      checks.push({
        case: name,
        status: result.status,
        expected_status: expected,
        money_fields_present: found,
        passed: result.status === expected && found.length === 0 && subject && setting,
      })
    }
    evidence.actors.push({ alias: actor.alias, identity_verified: true, checks })
  }
  evidence.passed = evidence.actors.every((actor) => actor.checks.every((check) => check.passed))
  return evidence
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--output')
      fail('usage: --config PRIVATE_JSON --output NEW_EVIDENCE_JSON')
    const info = await stat(args[1])
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 32768)
      fail('private_config_required')
    const result = await runProbe(JSON.parse(await readFile(args[1], 'utf8')))
    await writeFile(args[3], JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    process.stdout.write(
      result.passed
        ? 'Read-only denial checks passed.\n'
        : 'Read-only denial checks failed; inspect sanitized evidence.\n',
    )
    process.exitCode = result.passed ? 0 : 1
  } catch (error) {
    process.stderr.write(
      (error instanceof Error &&
      new Set([
        'invalid_probe_config',
        'invalid_probe_dates',
        'invalid_probe_fixtures',
        'invalid_probe_actors',
        'invalid_probe_actor',
        'invalid_probe_path',
        'probe_response_too_large',
        'probe_transport_failed',
        'probe_redirect_refused',
        'probe_release_mismatch',
        'probe_actor_mismatch',
        'private_config_required',
        'usage: --config PRIVATE_JSON --output NEW_EVIDENCE_JSON',
      ]).has(error.message)
        ? error.message
        : 'probe_failed') + '\n',
    )
    process.exitCode = 1
  }
}
