import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CloudflareAccessFetch } from '@ezacto/api'
import { createApp, type WorkerEnv } from '../src/app.js'
import { createRuntimeServices } from '../src/runtime.js'

const cursorKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const bootstrapToken = `ezacto_abcdefghijklmnop_${'A'.repeat(43)}`
const teamDomain = 'https://ezacto-test.cloudflareaccess.com'
const audience = 'a'.repeat(64)

describe('Worker Cloudflare Access composition', () => {
  let miniflare: Miniflare
  let database: D1Database
  let app: ReturnType<typeof createApp>
  let accessToken: string
  let accessFetch: CloudflareAccessFetch
  let freshAssertion: () => Promise<string>
  const jwksCalls: string[] = []

  const env = (): WorkerEnv => ({
    DB: database,
    API_CURSOR_SIGNING_KEY: cursorKey,
    ENVIRONMENT: 'test',
    RELEASE: 'cloudflare-access-test',
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_POLICY_AUD: audience,
  })

  beforeAll(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    database = await miniflare.getD1Database('DB')

    const pair = await generateKeyPair('RS256', { extractable: true })
    const jwk = {
      ...(await exportJWK(pair.publicKey)),
      alg: 'RS256',
      kid: 'worker-access-key',
      use: 'sig',
    }
    const fetch: CloudflareAccessFetch = vi.fn(async (url) => {
      jwksCalls.push(url)
      return Response.json({ keys: [jwk] })
    })
    accessFetch = fetch
    const services = await createRuntimeServices(env(), {
      cloudflareAccessFetch: fetch,
    })
    await services.bootstrap({
      organizationName: 'Ezacto Test',
      ownerFirstName: 'Avery',
      ownerLastName: 'Ng',
      ownerEmail: 'owner@example.test',
      token: bootstrapToken,
    })
    app = createApp(services)

    const now = Math.floor(Date.now() / 1_000)
    freshAssertion = () =>
      new SignJWT({ email: 'owner@example.test', type: 'app', jti: crypto.randomUUID() })
        .setProtectedHeader({ alg: 'RS256', kid: 'worker-access-key', typ: 'JWT' })
        .setIssuer(teamDomain)
        .setAudience([audience])
        .setSubject('access-user-1')
        .setIssuedAt(now - 1)
        .setNotBefore(now - 1)
        .setExpirationTime(now + 600)
        .sign(pair.privateKey)
    accessToken = await new SignJWT({
      email: 'owner@example.test',
      type: 'app',
    })
      .setProtectedHeader({
        alg: 'RS256',
        kid: 'worker-access-key',
        typ: 'JWT',
      })
      .setIssuer(teamDomain)
      .setAudience([audience])
      .setSubject('access-user-1')
      .setIssuedAt(now - 1)
      .setNotBefore(now - 1)
      .setExpirationTime(now + 600)
      .sign(pair.privateKey)
  })

  afterAll(async () => miniflare.dispose())

  it('[api] rejects forged Access identity headers before identity lookup', async () => {
    const response = await app.request(
      '/api/v1/whoami',
      {
        headers: {
          'cf-access-authenticated-user-email': 'owner@example.test',
          'cf-access-jwt-assertion': 'forged.header.signature',
        },
      },
      env(),
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: 'authentication_required' },
    })
    expect(jwksCalls).toHaveLength(0)
  })

  it('[api] exchanges a verified Access email for a normal revocable app session', async () => {
    const response = await app.request(
      '/api/v1/whoami',
      { headers: { 'cf-access-jwt-assertion': accessToken } },
      env(),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: {
        user_id: 1,
        profile: 'administrator',
        authentication: { kind: 'session' },
      },
    })
    expect(jwksCalls).toEqual([`${teamDomain}/cdn-cgi/access/certs`])

    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
    expect(cookie).toContain('__Host-ezacto_session=')
    const viaApplicationSession = await app.request(
      '/api/v1/whoami',
      {
        headers: {
          cookie: cookie!,
          'cf-access-jwt-assertion': 'forged.header.signature',
        },
      },
      env(),
    )
    expect(viaApplicationSession.status).toBe(200)
    expect(jwksCalls).toHaveLength(1)
  })
  it('[security] bounds repeated cookie-less requests to one native session per verified assertion', async () => {
    const count = async () =>
      (await database.prepare('SELECT count(*) AS count FROM sessions').first<{ count: number }>())!
        .count
    const before = await count()
    let cookies = 0
    for (let i = 0; i < 6; i++) {
      const response = await app.request(
        '/api/v1/whoami',
        { headers: { 'cf-access-jwt-assertion': accessToken } },
        env(),
      )
      expect(response.status).toBe(200)
      if (response.headers.has('set-cookie')) cookies++
    }
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const independent = createApp(
          await createRuntimeServices(env(), { cloudflareAccessFetch: accessFetch }),
        )
        return independent.request(
          '/api/v1/whoami',
          { headers: { 'cf-access-jwt-assertion': accessToken } },
          env(),
        )
      }),
    )
    expect(concurrent.map((response) => response.status)).toEqual(Array(6).fill(200))
    expect((await count()) - before).toBeLessThanOrEqual(1)
    cookies += concurrent.filter((response) => response.headers.has('set-cookie')).length
    expect(cookies).toBeLessThanOrEqual(before === 0 ? 1 : 0)
    const row = await database
      .prepare('SELECT selector FROM sessions ORDER BY id LIMIT 1')
      .first<{ selector: string }>()
    const forged = await app.request(
      '/api/v1/whoami',
      {
        headers: {
          cookie: `__Host-ezacto_session=ezacto_session_${row!.selector}_${'A'.repeat(43)}`,
          'x-access-session-selector': row!.selector,
        },
      },
      env(),
    )
    expect(forged.status).toBe(401)
    expect(forged.headers.has('set-cookie')).toBe(false)
  })

  it('[security] refuses a revoked assertion but permits a fresh verified assertion', async () => {
    const prior = await database
      .prepare('SELECT id FROM sessions ORDER BY id LIMIT 1')
      .first<{ id: number }>()
    expect(prior).not.toBeNull()
    const store = (await import('@ezacto/db')).createD1SessionStore(database)
    await store.revoke(1, prior!.id)
    const before = (await database
      .prepare('SELECT count(*) AS count FROM sessions')
      .first<{ count: number }>())!.count
    expect(
      (
        await app.request(
          '/api/v1/whoami',
          { headers: { 'cf-access-jwt-assertion': accessToken } },
          env(),
        )
      ).status,
    ).toBe(401)
    expect(
      (await database.prepare('SELECT count(*) AS count FROM sessions').first<{ count: number }>())!
        .count,
    ).toBe(before)
    const fresh = await app.request(
      '/api/v1/whoami',
      { headers: { 'cf-access-jwt-assertion': await freshAssertion() } },
      env(),
    )
    expect(fresh.status).toBe(200)
    expect(fresh.headers.get('set-cookie')).toContain('__Host-ezacto_session=')
  })
})
