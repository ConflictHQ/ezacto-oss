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
})
