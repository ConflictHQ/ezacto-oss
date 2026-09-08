import { describe, expect, it } from 'vitest'
import {
  createApiApp,
  installSsoDomainRoutes,
  type ApiAuthentication,
  type SsoProvisioningDomain,
  type SsoProvisioningDomainService,
  type UserProfile,
} from '../src/index.js'

const authentication: ApiAuthentication = {
  sessions: {
    resolve: async (request) => {
      const profile = request.headers.get('x-test-profile') as UserProfile | null
      if (profile === null) return null
      return {
        type: 'user',
        userId: 1,
        profile,
        managerGrants: [],
        authentication: { kind: 'session', sessionId: 'sso-domain-test' },
      }
    },
  },
}

const clock = '2026-09-05T12:00:00.000Z'
// A challenge token is a long base64url string, and a literal of that shape is
// indistinguishable from a real key: this one tripped the E12 secrets gate and
// put main red. Composed rather than pasted, so the fixture keeps the shape the
// split-TXT assertions need without the gate having to allowlist a test file —
// allowlisting per fixture is how a secrets gate ends up excusing the thing it
// exists to catch.
const token = ['chal', 'a'.repeat(19), 'b'.repeat(19)].join('-')

const claimed: SsoProvisioningDomain = {
  id: 4,
  domain: 'example.test',
  challengeToken: token,
  verifiedAt: null,
  lastCheckedAt: null,
  createdAt: clock,
  updatedAt: clock,
}

interface Recorded {
  id: number
  verified: boolean
  checkedAt: string
}

const service = (
  record: SsoProvisioningDomain,
  recorded: Recorded[],
): SsoProvisioningDomainService => ({
  list: async () => [record],
  get: async () => record,
  add: async () => record,
  remove: async () => undefined,
  recordCheck: async (id, verified, checkedAt) => {
    recorded.push({ id, verified, checkedAt })
    return { ...record, verifiedAt: verified ? checkedAt : null, lastCheckedAt: checkedAt }
  },
})

const dnsAnswer = (values: readonly string[], ad = true): Response =>
  new Response(
    JSON.stringify({
      Status: 0,
      AD: ad,
      Answer: values.map((data) => ({ type: 16, data })),
    }),
    { headers: { 'content-type': 'application/dns-json' } },
  )

interface Call {
  url: string
}

const createApp = (
  answers: Record<string, Response | (() => Response)>,
  recorded: Recorded[] = [],
  calls: Call[] = [],
) =>
  createApiApp({
    authentication,
    installApi(api) {
      installSsoDomainRoutes(api, {
        service: service(claimed, recorded),
        clock: () => clock,
        resolvers: ['https://one.test/dns-query', 'https://two.test/resolve'],
        fetch: async (url) => {
          calls.push({ url })
          const host = new URL(url).host
          const answer = answers[host]
          if (answer === undefined) return new Response('nope', { status: 502 })
          return typeof answer === 'function' ? answer() : answer.clone()
        },
      })
    },
  })

const verify = (app: ReturnType<typeof createApp>, profile: UserProfile = 'administrator') =>
  app.request('http://localhost/api/v1/settings/sso-domains/4/verify', {
    method: 'POST',
    headers: { 'x-test-profile': profile, origin: 'http://localhost' },
  })

describe('SSO provisioning domain API', () => {
  it('[api] hands the operator the exact record to publish', async () => {
    const app = createApp({})
    const response = await app.request('/api/v1/settings/sso-domains', {
      headers: { 'x-test-profile': 'administrator' },
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { data: unknown[] }).data[0]).toMatchObject({
      domain: 'example.test',
      verified: false,
      record_name: '_ezacto-challenge.example.test',
      record_type: 'TXT',
      record_value: `ezacto-verification=${token}`,
    })
  })

  it('[api] verifies when every resolver returns the challenge', async () => {
    const recorded: Recorded[] = []
    const calls: Call[] = []
    const answer = dnsAnswer([`"ezacto-verification=${token}"`])
    const app = createApp({ 'one.test': answer, 'two.test': answer }, recorded, calls)
    const response = await verify(app)

    expect(response.status).toBe(200)
    expect((await response.json()) as { data: unknown }).toMatchObject({
      data: { verified: true, verified_at: clock, last_checked_at: clock, dnssec_validated: true },
    })
    expect(recorded).toEqual([{ id: 4, verified: true, checkedAt: clock }])
    expect(calls.map(({ url }) => url)).toEqual([
      'https://one.test/dns-query?name=_ezacto-challenge.example.test&type=TXT',
      'https://two.test/resolve?name=_ezacto-challenge.example.test&type=TXT',
    ])
  })

  it('[unit] rejoins a TXT value split across character-strings', async () => {
    const recorded: Recorded[] = []
    const head = `"ezacto-verification=${token.slice(0, 10)}" "${token.slice(10)}"`
    const answer = dnsAnswer([head])
    const app = createApp({ 'one.test': answer, 'two.test': answer }, recorded)
    expect((await verify(app)).status).toBe(200)
    expect(recorded).toEqual([{ id: 4, verified: true, checkedAt: clock }])
  })

  const refusals = [
    {
      name: 'a resolver that sees nothing',
      answers: () => ({
        'one.test': dnsAnswer([`"ezacto-verification=${token}"`]),
        'two.test': dnsAnswer([]),
      }),
    },
    {
      name: 'a resolver that disagrees about the token',
      answers: () => ({
        'one.test': dnsAnswer([`"ezacto-verification=${token}"`]),
        'two.test': dnsAnswer(['"ezacto-verification=an-attacker-chose-this-value-instead"']),
      }),
    },
    {
      name: 'a record published without the challenge prefix',
      answers: () => ({
        'one.test': dnsAnswer([`"${token}"`]),
        'two.test': dnsAnswer([`"${token}"`]),
      }),
    },
  ] as const

  it.each(refusals)('[security] refuses $name', async ({ answers }) => {
    const recorded: Recorded[] = []
    const app = createApp(answers(), recorded)
    const response = await verify(app)

    expect(response.status).toBe(200)
    expect((await response.json()) as { data: unknown }).toMatchObject({
      data: { verified: false, verified_at: null, last_checked_at: clock },
    })
    // The check still happened and is recorded: an operator has to be able to
    // tell "we looked and it is not there" from "nobody has looked".
    expect(recorded).toEqual([{ id: 4, verified: false, checkedAt: clock }])
  })

  it('[security] records nothing when a resolver cannot be reached', async () => {
    const recorded: Recorded[] = []
    const app = createApp({ 'one.test': dnsAnswer([`"ezacto-verification=${token}"`]) }, recorded)
    const response = await verify(app)

    expect(response.status).toBe(503)
    expect(recorded).toEqual([])
  })

  it('[security] refuses every profile below administrator', async () => {
    const recorded: Recorded[] = []
    const answer = dnsAnswer([`"ezacto-verification=${token}"`])
    const app = createApp({ 'one.test': answer, 'two.test': answer }, recorded)
    for (const profile of [
      'member',
      'project_manager',
      'people_admin',
      'accounting',
      'executive_manager',
    ] as const) {
      expect((await verify(app, profile)).status).toBe(403)
    }
    expect(recorded).toEqual([])
  })
})
