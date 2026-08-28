import { createApiTokenStore, createD1Database } from '@ezacto/db/d1'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseCursorSigningKey } from '../src/runtime.js'

const timestamp = '2026-08-28T08:00:00.000Z'
const cursorSecret = encodeBase64Url(new Uint8Array(32).fill(0x41))

let miniflare: Miniflare
let database: D1Database
let bootstrapResponse: Response
let bearer: string

const request = (path: string, init?: RequestInit): Promise<Response> =>
  miniflare.dispatchFetch(
    new URL(path, 'https://worker.test').toString(),
    init as never,
  ) as unknown as Promise<Response>

const run = async (statement: string, ...bindings: unknown[]): Promise<void> => {
  await database
    .prepare(statement)
    .bind(...bindings)
    .run()
}

beforeAll(async () => {
  const bundled = await build({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    bundle: true,
    conditions: ['development'],
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  })
  miniflare = new Miniflare({
    bindings: {
      API_CURSOR_SIGNING_KEY: cursorSecret,
      ENVIRONMENT: 'test',
      RELEASE: 'runtime-d1-test',
    },
    // Latest compatibility date accepted by the pinned stable workerd.
    compatibilityDate: '2026-08-06',
    d1Databases: ['DB'],
    modules: true,
    script: bundled.outputFiles[0]!.text,
  })

  // The first fetch, not test setup, must install the complete schema before
  // authentication performs its first query.
  bootstrapResponse = await request('/api/v1/time-entries')
  database = await miniflare.getD1Database('DB')

  await run(
    `INSERT INTO organizations (
      id, name, time_entry_mode, time_rounding, modules, created_at, updated_at
    ) VALUES (1, 'Runtime Organization', 'duration', 'none', ?, ?, ?)`,
    JSON.stringify({ expenses: true, invoices: true, approval: false }),
    timestamp,
    timestamp,
  )
  await run(
    `INSERT INTO users (
      id, first_name, last_name, profile, manager_grants, created_at, updated_at
    ) VALUES
      (1, 'Runtime', 'Owner', 'administrator', '[]', ?, ?),
      (2, 'Runtime', 'Member', 'member', '[]', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Runtime Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
  )
  await run(
    `INSERT INTO projects (
      id, client_id, name, code, hourly_rate_cents, created_at, updated_at
    ) VALUES (1, 1, 'Runtime Project', 'RUN', 10000, ?, ?)`,
    timestamp,
    timestamp,
  )
  await run(
    `INSERT INTO tasks (id, name, created_at, updated_at)
     VALUES (1, 'Runtime Task', ?, ?)`,
    timestamp,
    timestamp,
  )
  await run(
    `INSERT INTO user_assignments (
      id, project_id, user_id, created_at, updated_at
    ) VALUES (1, 1, 2, ?, ?)`,
    timestamp,
    timestamp,
  )
  await run(
    `INSERT INTO task_assignments (
      id, project_id, task_id, billable, created_at, updated_at
    ) VALUES (1, 1, 1, 1, ?, ?)`,
    timestamp,
    timestamp,
  )
  await run(
    `INSERT INTO time_entries (
      id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
      spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
      billable_rate_cents, cost_rate_cents, created_at, updated_at
    ) VALUES
      (1, 2, 1, 1, 1, 1, '2026-08-27', 600, 600, 600, 1, 10000, 5000, ?, ?),
      (2, 2, 1, 1, 1, 1, '2026-08-28', 900, 900, 900, 1, 10000, 5000, ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )

  const store = createApiTokenStore(createD1Database(database), {
    now: () => timestamp,
  })
  bearer = (
    await store.issue({
      userId: 2,
      name: 'Runtime fetch test',
      scopes: ['time_entries:read'],
    })
  ).token
  expect(await store.authenticate(bearer)).toMatchObject({ profile: 'member' })
}, 20_000)

afterAll(async () => miniflare.dispose())

describe('Worker D1 runtime composition', () => {
  it('[api] migrates the real D1 binding before its first DB-backed fetch', async () => {
    expect(bootstrapResponse.status).toBe(401)
    expect(bootstrapResponse.headers.get('www-authenticate')).toBe('Bearer realm="ezacto"')
    const migrations = await database
      .prepare('SELECT id FROM _ezacto_migrations ORDER BY id')
      .all<{ id: string }>()
    expect(migrations.results.at(-1)?.id).toBe('0011_api_tokens')
    expect(migrations.results).toHaveLength(12)
  })

  it('[security] keeps unverified session-like cookies fail-closed', async () => {
    const response = await request('/api/v1/time-entries', {
      headers: { cookie: 'session=attacker; CF_Authorization=unverified' },
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: 'authentication_required', fields: [] },
    })
  })

  it('[api] authenticates a real stored bearer and pages real D1 resources over fetch', async () => {
    const firstResponse = await request('/api/v1/time-entries?per_page=1', {
      headers: { authorization: `Bearer ${bearer}` },
    })
    expect(firstResponse.status).toBe(200)
    const first = (await firstResponse.json()) as {
      data: Record<string, unknown>[]
      links: { next: string | null }
    }
    expect(first.data).toEqual([expect.objectContaining({ id: 1, user_id: 2, seconds: 600 })])
    expect(first.data[0]).not.toHaveProperty('billable_rate_cents')
    expect(first.data[0]).not.toHaveProperty('cost_rate_cents')
    expect(first.links.next).not.toBeNull()

    const secondResponse = await request(first.links.next!, {
      headers: { authorization: `Bearer ${bearer}` },
    })
    expect(secondResponse.status).toBe(200)
    expect(await secondResponse.json()).toMatchObject({
      data: [expect.objectContaining({ id: 2, user_id: 2, seconds: 900 })],
      links: { next: null },
    })

    const used = await database
      .prepare('SELECT last_used_at AS lastUsedAt FROM api_tokens')
      .first<{ lastUsedAt: string | null }>()
    expect(used?.lastUsedAt).not.toBeNull()
  })
})

describe('cursor signing binding', () => {
  it('[security] accepts only canonical base64url for exactly 32 stable bytes', () => {
    expect(parseCursorSigningKey(cursorSecret)).toEqual(new Uint8Array(32).fill(0x41))
    expect(() => parseCursorSigningKey('A'.repeat(42))).toThrow(/exactly 32 bytes/)
    expect(() => parseCursorSigningKey(`${cursorSecret}=`)).toThrow(/canonical base64url/)
    expect(() => parseCursorSigningKey(` ${cursorSecret}`)).toThrow(/canonical base64url/)
    expect(() => parseCursorSigningKey('')).toThrow(/canonical base64url/)
  })
})

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
