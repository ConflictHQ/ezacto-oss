import { Miniflare } from 'miniflare'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuthDelivery } from '@ezacto/api'
import { createApp, type WorkerEnv } from '../src/app.js'
import { createRuntimeServices } from '../src/runtime.js'

/**
 * Issue 951, end to end: a signed-in read is a read. Hosted eZacto commits the
 * whole database file whenever SQLite reports a change, so any write a page
 * view makes -- the session's last-seen time or anything else on the request
 * path -- doubles its commits. This counts writes on every table, not just the
 * one the fix touched, so a new per-request write anywhere fails here too.
 */

const cursorKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const password = 'correct horse battery staple 🙂'
const signedInAt = Date.parse('2026-09-20T09:00:00.000Z')

describe('Worker signed-in reads inside the last-seen interval', () => {
  let miniflare: Miniflare
  let database: D1Database
  let app: ReturnType<typeof createApp>
  const deliveries: AuthDelivery[] = []
  const env = {
    API_CURSOR_SIGNING_KEY: cursorKey,
    ENVIRONMENT: 'test',
    RELEASE: 'last-seen-writes-test',
  }

  beforeAll(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    database = await miniflare.getD1Database('DB')
    app = createApp({
      ...(await createRuntimeServices({ DB: database, ...env })),
      deploymentAuthMailer: {
        assertAvailable: async () => undefined,
        enqueue: async (delivery) => void deliveries.push(delivery),
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  afterAll(async () => miniflare.dispose())

  const at = (offsetMs: number): void => {
    vi.setSystemTime(signedInAt + offsetMs)
  }

  const call = (path: string, init: RequestInit = {}) =>
    app.request(path, init, { DB: database, ...env } satisfies WorkerEnv)

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '198.51.100.21',
        origin: 'http://localhost',
        ...headers,
      },
      body: JSON.stringify(body),
    })

  /** One AFTER trigger per table and verb, all logging to one table. */
  const logEveryWrite = async (): Promise<() => Promise<string[]>> => {
    const tables = (
      await database
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'`,
        )
        .all<{ name: string }>()
    ).results.map((row) => row.name)
    expect(tables).toContain('sessions')
    expect(tables).toContain('api_tokens')
    await database.prepare(`CREATE TABLE test_write_log (target TEXT NOT NULL)`).run()
    await database.batch(
      tables.flatMap((table) =>
        ['INSERT', 'UPDATE', 'DELETE'].map((verb) =>
          database.prepare(
            `CREATE TRIGGER "test_log_${table}_${verb}" AFTER ${verb} ON "${table}"
              BEGIN INSERT INTO test_write_log (target) VALUES ('${verb} ${table}'); END`,
          ),
        ),
      ),
    )
    return async () => {
      const logged = (
        await database.prepare(`SELECT target FROM test_write_log`).all<{ target: string }>()
      ).results.map((row) => row.target)
      await database.prepare(`DELETE FROM test_write_log`).run()
      return logged
    }
  }

  it('[security] writes nothing for reads inside the interval, by session or token, and records the first after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    at(0)
    expect((await post('/auth/signup', {
      organization_name: 'Fieldstone Atelier',
      first_name: 'Rowan',
      last_name: 'Vale',
      email: 'owner@example.test',
      password,
    })).status).toBe(202)
    expect((await post('/auth/verify-email', { token: deliveries[0]!.token })).status).toBe(200)
    const signedIn = await post('/auth/sign-in', { email: 'owner@example.test', password })
    expect(signedIn.status).toBe(200)
    const cookie = signedIn.headers.get('set-cookie')!.split(';', 1)[0]!
    const minted = await post(
      '/api/v1/api-tokens',
      { name: 'Phone', scopes: ['time_entries:read'] },
      { cookie },
    )
    expect(minted.status).toBe(201)
    const token = ((await minted.json()) as { data: { token: string } }).data.token
    const bearer = { authorization: `Bearer ${token}` }
    // The token's first use is a write: it has never been used.
    at(1_000)
    expect((await call('/api/v1/whoami', { headers: bearer })).status).toBe(200)

    const writes = await logEveryWrite()
    for (const offset of [60_000, 2 * 60_000, 4 * 60_000 + 59_999]) {
      at(offset)
      const bySession = await call('/api/v1/whoami', { headers: { cookie } })
      expect(bySession.status).toBe(200)
      expect(bySession.headers.get('set-cookie')).toBeNull()
      expect((await call('/api/v1/whoami', { headers: bearer })).status).toBe(200)
    }
    expect(await writes()).toEqual([])

    at(5 * 60_000)
    expect((await call('/api/v1/whoami', { headers: { cookie } })).status).toBe(200)
    expect(await writes()).toEqual(['UPDATE sessions'])
    at(5 * 60_000 + 1_000)
    expect((await call('/api/v1/whoami', { headers: bearer })).status).toBe(200)
    expect(await writes()).toEqual(['UPDATE api_tokens'])
  })
})
