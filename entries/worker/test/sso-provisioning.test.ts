import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuthDelivery } from '@ezacto/api'
import { createApp, type WorkerEnv } from '../src/app.js'
import { createRuntimeServices } from '../src/runtime.js'

const cursorKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const password = 'correct horse battery staple 🙂'
const workDomain = 'work.test'

interface DomainResource {
  id: number
  domain: string
  verified: boolean
  verified_at: string | null
  record_name: string
  record_value: string
}

/**
 * Migration 0039 creates `sso_provisioning_domains` empty and the identity
 * store enforces it, so every instance deploys with provisioning closed. That
 * is the right default only if the product can open it again: these routes are
 * the only supported way to add a domain and prove it, and they were shipped in
 * the contract without being mounted, which left an instance that relied on
 * Google auto-provisioning recoverable only by hand-writing D1 rows. The path
 * from off to on is therefore what gets tested, end to end, not the routes in
 * isolation.
 */
describe('Worker SSO provisioning domains', () => {
  let miniflare: Miniflare
  let database: D1Database
  let services: Awaited<ReturnType<typeof createRuntimeServices>>
  let app: ReturnType<typeof createApp>
  let cookie: string
  const deliveries: AuthDelivery[] = []

  const env = (): WorkerEnv => ({
    DB: database,
    API_CURSOR_SIGNING_KEY: cursorKey,
    ENVIRONMENT: 'test',
    RELEASE: 'sso-provisioning-test',
  })

  // Session-authenticated mutations are same-origin only, so the fixture sends
  // the request the browser would.
  const origin = 'http://localhost'

  const post = (path: string, body: unknown, headers: HeadersInit = {}) =>
    app.request(
      `${origin}${path}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '198.51.100.30',
          origin,
          ...headers,
        },
        body: JSON.stringify(body),
      },
      env(),
    )

  const assertion = (subject: string, email: string) => ({
    provider: 'google',
    subject,
    email,
    emailVerified: true,
    hostedDomain: workDomain,
    firstName: 'Robin',
    lastName: 'Vale',
  })

  /**
   * Both configured resolvers answer with the published record. Only the DoH
   * hosts are intercepted; anything else the runtime fetches goes through
   * untouched, so the stub cannot quietly answer for something it is not.
   */
  const withPublishedRecord = async <Result>(
    value: string,
    act: () => Result | Promise<Result>,
  ): Promise<Result> => {
    const real = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const { hostname } = new URL(
        typeof input === 'string' || input instanceof URL
          ? input.toString()
          : input.url,
      )
      if (hostname === 'cloudflare-dns.com' || hostname === 'dns.google') {
        return Response.json({
          Status: 0,
          AD: true,
          Answer: [{ type: 16, data: `"${value}"` }],
        })
      }
      return real(input as RequestInfo, init)
    }) as typeof globalThis.fetch
    try {
      return await act()
    } finally {
      globalThis.fetch = real
    }
  }

  beforeAll(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    database = await miniflare.getD1Database('DB')
    services = await createRuntimeServices(env())
    app = createApp({
      ...services,
      deploymentAuthMailer: {
        assertAvailable: async () => undefined,
        enqueue: async (delivery) => void deliveries.push(delivery),
      },
    })

    await post('/auth/signup', {
      organization_name: 'Halcyon Studio',
      first_name: 'Avery',
      last_name: 'Ng',
      email: 'owner@example.test',
      password,
    })
    await post('/auth/verify-email', { token: deliveries[0]!.token })
    const signedIn = await post('/auth/sign-in', {
      email: 'owner@example.test',
      password,
    })
    cookie = signedIn.headers.get('set-cookie')!.split(';', 1)[0]!
    // 30s, against vitest's 10s default. This hook boots Miniflare, builds the
    // runtime services, then signs up, verifies an email and signs in -- and
    // that sign-in pays for an Argon2id verify. Alone it takes about 6.8s, so
    // the default left roughly three seconds of headroom, and on a two-vCPU
    // runner with the other suites alongside it that is not enough: it has
    // failed twice as "Hook timed out in 10000ms", which reads as a broken
    // worker rather than a busy machine.
    //
    // The siblings that do comparable work already say so -- brand-assets and
    // email-queue at 20s, money-isolation at 60s. This one never did.
  }, 30_000)

  afterAll(async () => miniflare.dispose())

  it('[e2e] moves an instance from provisioning nothing to provisioning the work domain', async () => {
    // Fail-closed, as deployed: nobody has proved a domain yet.
    expect(
      await services.identities.resolveProvider(
        assertion('google-refused', `robin@${workDomain}`),
      ),
    ).toEqual({ status: 'provisioning_not_permitted' })

    const added = await post(
      '/api/v1/settings/sso-domains',
      { domain: workDomain },
      { cookie },
    )
    expect(added.status).toBe(201)
    const claimed = ((await added.json()) as { data: DomainResource }).data
    expect(claimed).toMatchObject({
      domain: workDomain,
      verified: false,
      record_name: `_ezacto-challenge.${workDomain}`,
    })
    expect(claimed.record_value).toMatch(/^ezacto-verification=[A-Za-z0-9_-]+$/)

    // Claiming is not proving: the gate stays shut until DNS agrees.
    expect(
      await services.identities.resolveProvider(
        assertion('google-unproved', `robin@${workDomain}`),
      ),
    ).toEqual({ status: 'provisioning_not_permitted' })

    const verified = await withPublishedRecord(claimed.record_value, () =>
      post(`/api/v1/settings/sso-domains/${claimed.id}/verify`, null, {
        cookie,
      }),
    )
    expect(verified.status).toBe(200)
    expect(
      ((await verified.json()) as { data: DomainResource & { dnssec_validated: boolean } })
        .data,
    ).toMatchObject({ verified: true, dnssec_validated: true })

    const provisioned = await services.identities.resolveProvider(
      assertion('google-provisioned', `robin@${workDomain}`),
    )
    expect(provisioned).toMatchObject({ status: 'active', matchedBy: 'created' })

    const listed = await app.request(
      '/api/v1/settings/sso-domains',
      { headers: { cookie } },
      env(),
    )
    expect(listed.status).toBe(200)
    expect(
      ((await listed.json()) as { data: DomainResource[] }).data,
    ).toMatchObject([{ domain: workDomain, verified: true }])
  })

  it('[e2e] adds a second address to an existing user without moving the first', async () => {
    const added = await post(
      '/api/v1/users/1/emails',
      { email: `avery@${workDomain}` },
      { cookie },
    )
    expect(added.status).toBe(202)
    expect(await added.json()).toEqual({
      data: { status: 'verification_sent', email: `avery@${workDomain}` },
    })

    const delivery = deliveries.at(-1)!
    expect(delivery).toMatchObject({
      kind: 'verify_email',
      to: `avery@${workDomain}`,
    })
    const verified = await post('/auth/verify-email', { token: delivery.token })
    expect(verified.status).toBe(200)

    // The personal address is what payroll reconciles against, so it stays
    // primary and stays verified; the new one arrives beside it.
    const addresses = await database
      .prepare(
        `SELECT address, is_primary, verified_at IS NOT NULL AS verified
         FROM user_emails WHERE user_id = 1 ORDER BY address`,
      )
      .all<{ address: string; is_primary: number; verified: number }>()
    expect(addresses.results).toEqual([
      { address: `avery@${workDomain}`, is_primary: 0, verified: 1 },
      { address: 'owner@example.test', is_primary: 1, verified: 1 },
    ])
  })
})
