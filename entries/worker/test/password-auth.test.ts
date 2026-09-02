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
      deploymentAuthMailer: {
        assertAvailable: async () => undefined,
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
    const initialSetCookie = signedIn.headers.get('set-cookie')
    expect(initialSetCookie).toContain('__Host-ezacto_session=')
    expect(initialSetCookie).toContain('Path=/')
    expect(initialSetCookie).toContain('HttpOnly')
    expect(initialSetCookie).toContain('Secure')
    expect(initialSetCookie).toContain('SameSite=Lax')
    expect(initialSetCookie).not.toContain('Domain=')
    const initialCookie = initialSetCookie!.split(';', 1)[0]!

    const authenticated = await app.request(
      '/api/v1/whoami',
      { headers: { cookie: initialCookie } },
      {
        DB: database,
        API_CURSOR_SIGNING_KEY: cursorKey,
        ENVIRONMENT: 'test',
        RELEASE: 'password-auth-test',
      },
    )
    expect(authenticated.status).toBe(200)
    expect(await authenticated.json()).toMatchObject({
      data: {
        user_id: 1,
        profile: 'administrator',
        authentication: { kind: 'session' },
      },
    })

    const listed = await app.request(
      '/api/v1/sessions',
      { headers: { cookie: initialCookie } },
      {
        DB: database,
        API_CURSOR_SIGNING_KEY: cursorKey,
        ENVIRONMENT: 'test',
        RELEASE: 'password-auth-test',
      },
    )
    expect(listed.status).toBe(200)
    const firstSessions = (await listed.json()) as {
      data: Array<{ id: number; current: boolean }>
    }
    expect(firstSessions.data).toEqual([
      expect.objectContaining({ current: true }),
    ])

    await database
      .prepare(
        `UPDATE users
         SET manager_grants = ?, updated_at = ?
         WHERE id = 1`,
      )
      .bind(
        JSON.stringify(['team:finance']),
        new Date(Date.now() + 1_000).toISOString(),
      )
      .run()

    const rotated = await app.request(
      '/api/v1/whoami',
      { headers: { cookie: initialCookie } },
      {
        DB: database,
        API_CURSOR_SIGNING_KEY: cursorKey,
        ENVIRONMENT: 'test',
        RELEASE: 'password-auth-test',
      },
    )
    expect(rotated.status).toBe(200)
    expect(await rotated.json()).toMatchObject({
      data: { manager_grants: ['team:finance'] },
    })
    const rotatedSetCookie = rotated.headers.get('set-cookie')
    expect(rotatedSetCookie).toContain('__Host-ezacto_session=')
    const rotatedCookie = rotatedSetCookie!.split(';', 1)[0]!
    expect(rotatedCookie).not.toBe(initialCookie)

    const oldCookie = await app.request(
      '/api/v1/whoami',
      { headers: { cookie: initialCookie } },
      {
        DB: database,
        API_CURSOR_SIGNING_KEY: cursorKey,
        ENVIRONMENT: 'test',
        RELEASE: 'password-auth-test',
      },
    )
    expect(oldCookie.status).toBe(401)

    const afterRotation = await app.request(
      '/api/v1/sessions',
      { headers: { cookie: rotatedCookie } },
      {
        DB: database,
        API_CURSOR_SIGNING_KEY: cursorKey,
        ENVIRONMENT: 'test',
        RELEASE: 'password-auth-test',
      },
    )
    expect(afterRotation.status).toBe(200)
    const sessions = (await afterRotation.json()) as {
      data: Array<{
        id: number
        current: boolean
        revocation_reason: string | null
      }>
    }
    expect(sessions.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          current: false,
          revocation_reason: 'privilege_change',
        }),
        expect.objectContaining({ current: true, revocation_reason: null }),
      ]),
    )
    const current = sessions.data.find((session) => session.current)
    expect(current).toBeDefined()

    const revoked = await app.request(
      `/api/v1/sessions/${current!.id}`,
      {
        method: 'DELETE',
        headers: { cookie: rotatedCookie, origin: 'http://localhost' },
      },
      {
        DB: database,
        API_CURSOR_SIGNING_KEY: cursorKey,
        ENVIRONMENT: 'test',
        RELEASE: 'password-auth-test',
      },
    )
    expect(revoked.status).toBe(200)
    expect(revoked.headers.get('set-cookie')).toContain('Max-Age=0')

    const revokedCookie = await app.request(
      '/api/v1/whoami',
      { headers: { cookie: rotatedCookie } },
      {
        DB: database,
        API_CURSOR_SIGNING_KEY: cursorKey,
        ENVIRONMENT: 'test',
        RELEASE: 'password-auth-test',
      },
    )
    expect(revokedCookie.status).toBe(401)
  })
})
