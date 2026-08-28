import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuthDelivery } from '@ezacto/api'
import { createApp, type WorkerEnv } from '../src/app.js'
import { createRuntimeServices } from '../src/runtime.js'

const cursorKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const password = 'correct horse battery staple 🙂'

describe('Worker password authentication composition', () => {
  let miniflare: Miniflare
  let database: D1Database
  let app: ReturnType<typeof createApp>
  const deliveries: AuthDelivery[] = []

  beforeAll(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    database = await miniflare.getD1Database('DB')
    const services = await createRuntimeServices({
      DB: database,
      API_CURSOR_SIGNING_KEY: cursorKey,
      ENVIRONMENT: 'test',
      RELEASE: 'password-auth-test',
    })
    app = createApp({
      ...services,
      authMailer: {
        enqueue: async (delivery) => void deliveries.push(delivery),
      },
    })
  })

  afterAll(async () => miniflare.dispose())

  const request = (path: string, body: unknown) =>
    app.request(
      path,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '198.51.100.20',
        },
        body: JSON.stringify(body),
      },
      {
        DB: database,
        API_CURSOR_SIGNING_KEY: cursorKey,
        ENVIRONMENT: 'test',
        RELEASE: 'password-auth-test',
      } satisfies WorkerEnv,
    )

  it('[e2e:first-run] persists signup, consumes verification, and authenticates', async () => {
    const signup = await request('/auth/signup', {
      organization_name: 'Halcyon Studio',
      first_name: 'Avery',
      last_name: 'Ng',
      email: 'owner@example.test',
      password,
    })
    expect(signup.status).toBe(202)
    expect(await signup.json()).toEqual({
      data: { status: 'verification_sent' },
    })
    expect(deliveries).toHaveLength(1)

    const before = await request('/auth/sign-in', {
      email: 'owner@example.test',
      password,
    })
    expect(before.status).toBe(403)
    expect(await before.json()).toMatchObject({
      error: { code: 'email_verification_required' },
    })

    const verified = await request('/auth/verify-email', {
      token: deliveries[0]!.token,
    })
    expect(verified.status).toBe(200)
    expect(await verified.json()).toMatchObject({
      data: { status: 'verified', user_id: 1, profile: 'administrator' },
    })

    const signedIn = await request('/auth/sign-in', {
      email: 'owner@example.test',
      password,
    })
    expect(signedIn.status).toBe(200)
    expect(await signedIn.json()).toEqual({
      data: {
        status: 'authenticated',
        user_id: 1,
        profile: 'administrator',
        manager_grants: [],
      },
    })

    const apiStillRequiresSession = await app.request(
      '/api/v1/whoami',
      {},
      {
        DB: database,
        API_CURSOR_SIGNING_KEY: cursorKey,
        ENVIRONMENT: 'test',
        RELEASE: 'password-auth-test',
      },
    )
    expect(apiStillRequiresSession.status).toBe(401)
  })
})
