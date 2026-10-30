import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuthDelivery } from '@ezacto/api'
import { createApp, type WorkerEnv } from '../src/app.js'
import { createRuntimeServices } from '../src/runtime.js'

/**
 * Issue 599: the one-year maximum on self-service API tokens, over the Worker
 * runtime and a real migrated D1. The container has the twin of this test.
 */

const password = 'correct horse battery staple 🙂'
const day = 86_400_000

describe('Worker API token maximum lifetime', () => {
  let miniflare: Miniflare
  let database: D1Database
  let app: ReturnType<typeof createApp>
  const deliveries: AuthDelivery[] = []
  const env = {
    API_CURSOR_SIGNING_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ENVIRONMENT: 'test',
    RELEASE: 'token-lifetime-test',
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

  afterAll(async () => miniflare.dispose())

  const call = (path: string, init: RequestInit) =>
    app.request(path, init, { DB: database, ...env } satisfies WorkerEnv)

  const post = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
    call(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '198.51.100.22',
        origin: 'http://localhost',
        ...headers,
      },
      body: JSON.stringify(payload),
    })

  it('[e2e] defaults to a year, lets an administrator go beyond it, and refuses anyone else', async () => {
    expect(
      (
        await post('/auth/signup', {
          organization_name: 'Fieldstone Atelier',
          first_name: 'Rowan',
          last_name: 'Vale',
          email: 'owner@example.test',
          password,
        })
      ).status,
    ).toBe(202)
    expect((await post('/auth/verify-email', { token: deliveries[0]!.token })).status).toBe(200)
    const signedIn = await post('/auth/sign-in', { email: 'owner@example.test', password })
    let cookie = signedIn.headers.get('set-cookie')!.split(';', 1)[0]!
    const mint = async (extra: object) => {
      const response = await post(
        '/api/v1/api-tokens',
        { name: 'Phone', scopes: ['time_entries:read'], ...extra },
        { cookie },
      )
      return {
        status: response.status,
        body: (await response.json()) as {
          data?: { expires_at: string | null; token: string }
          error?: { fields: Array<{ field: string; code: string }> }
        },
      }
    }

    const omitted = await mint({})
    expect(omitted.status).toBe(201)
    const days = (Date.parse(omitted.body.data!.expires_at!) - Date.now()) / day
    expect(days).toBeGreaterThan(364)
    expect(days).toBeLessThanOrEqual(366)

    const never = await mint({ expires_at: null })
    expect(never.status).toBe(201)
    expect(never.body.data!.expires_at).toBeNull()

    // The organization must keep an administrator, so hand ownership to a second one before demoting the signed-in user.
    const now = new Date().toISOString()
    await database
      .prepare(
        `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
         VALUES (900, 'Second', 'Admin', 'administrator', '[]', ?, ?)`,
      )
      .bind(now, now)
      .run()
    await database.prepare(`UPDATE organization_owner SET user_id = 900 WHERE id = 1`).run()
    await database.prepare(`UPDATE users SET profile = 'member' WHERE id <> 900`).run()
    // Demotion ends the old session; the person signs in again as a member.
    const again = await post('/auth/sign-in', { email: 'owner@example.test', password })
    expect(again.status).toBe(200)
    cookie = again.headers.get('set-cookie')!.split(';', 1)[0]!
    for (const extra of [
      { expires_at: null },
      { expires_at: new Date(Date.now() + 400 * day).toISOString() },
    ]) {
      const refused = await mint(extra)
      expect(refused.status).toBe(422)
      expect(refused.body.error!.fields).toMatchObject([{ field: 'expires_at', code: 'too_long' }])
    }
    const sooner = await mint({ expires_at: new Date(Date.now() + 30 * day).toISOString() })
    expect(sooner.status).toBe(201)

    // A no-expiry token issued before the rule keeps working after it.
    const whoami = await call('/api/v1/whoami', {
      headers: { authorization: `Bearer ${never.body.data!.token}` },
    })
    expect(whoami.status).toBe(200)
  })
})
