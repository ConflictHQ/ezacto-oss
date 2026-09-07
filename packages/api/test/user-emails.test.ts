import { describe, expect, it } from 'vitest'
import {
  createApiApp,
  installUserEmailRoutes,
  type ApiAuthentication,
  type AuthDelivery,
  type AuthMailer,
  type UserEmailService,
  type UserProfile,
} from '../src/index.js'

const authentication: ApiAuthentication = {
  sessions: {
    resolve: async (request) => {
      const profile = request.headers.get('x-test-profile') as UserProfile | null
      const userId = Number(request.headers.get('x-test-user') ?? '1')
      if (profile === null) return null
      return {
        type: 'user',
        userId,
        profile,
        managerGrants: [],
        authentication: { kind: 'session', sessionId: 'user-email-test' },
      }
    },
  },
}

const named = (name: string): Error => {
  const error = new Error(name)
  error.name = name
  return error
}

const createApp = (
  addEmail: UserEmailService['addEmail'],
  enqueued: AuthDelivery[] = [],
  mailer?: AuthMailer,
) =>
  createApiApp({
    authentication,
    installApi(api) {
      installUserEmailRoutes(api, {
        service: { addEmail },
        deploymentMailer:
          mailer ??
          ({
            assertAvailable: async () => undefined,
            enqueue: async (delivery) => {
              enqueued.push(delivery)
            },
          } satisfies AuthMailer),
        clientKey: () => '198.51.100.7',
      })
    },
  })

const post = (
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  headers: Record<string, string> = { 'x-test-profile': 'member' },
) =>
  app.request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', ...headers },
    body: JSON.stringify(body),
  })

describe('user email API', () => {
  it('[api] adds a second address for the person themselves and mails the verification', async () => {
    const enqueued: AuthDelivery[] = []
    const seen: unknown[] = []
    const app = createApp(async (input) => {
      seen.push(input)
      return {
        kind: 'verify_email',
        to: 'avery@work.test',
        token: 'ezacto_verify_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        expiresAt: '2026-09-06T12:00:00.000Z',
      }
    }, enqueued)

    const response = await post(app, '/api/v1/users/1/emails', { email: 'Avery@Work.test' })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      data: { status: 'verification_sent', email: 'avery@work.test' },
    })
    expect(seen).toEqual([
      { userId: 1, email: 'Avery@Work.test', clientKey: '198.51.100.7' },
    ])
    expect(enqueued).toHaveLength(1)
  })

  it('[security] refuses to add an address to somebody else without a people role', async () => {
    let called = false
    const app = createApp(async () => {
      called = true
      throw new Error('unreachable')
    })
    const response = await post(app, '/api/v1/users/2/emails', { email: 'avery@work.test' })
    expect(response.status).toBe(403)
    expect(called).toBe(false)
  })

  it('[api] lets a people administrator add an address on somebody else', async () => {
    const app = createApp(async () => ({
      kind: 'verify_email',
      to: 'avery@work.test',
      token: 'ezacto_verify_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      expiresAt: '2026-09-06T12:00:00.000Z',
    }))
    const response = await post(app, '/api/v1/users/2/emails', { email: 'avery@work.test' }, {
      'x-test-profile': 'people_admin',
    })
    expect(response.status).toBe(202)
  })

  const failures = [
    { error: 'EmailAddressUnavailableError', status: 409, code: 'email_in_use' },
    { error: 'UnknownUserError', status: 404, code: 'not_found' },
    { error: 'AuthRateLimitError', status: 429, code: 'rate_limit_exceeded' },
  ] as const

  it.each(failures)('[api] translates $error to $status', async ({ error, status, code }) => {
    const app = createApp(async () => {
      throw named(error)
    })
    const response = await post(app, '/api/v1/users/1/emails', { email: 'avery@work.test' })
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { code } })
  })

  it('[security] sends nothing when the mail transport is unavailable', async () => {
    let called = false
    const app = createApp(
      async () => {
        called = true
        throw new Error('unreachable')
      },
      [],
      {
        assertAvailable: async () => {
          throw new Error('no active auth_email_verification template')
        },
        enqueue: async () => undefined,
      },
    )
    await expect(
      post(app, '/api/v1/users/1/emails', { email: 'avery@work.test' }),
    ).resolves.toMatchObject({ status: 500 })
    expect(called).toBe(false)
  })

  it('[api] rejects a body that is missing or carries unknown fields', async () => {
    const app = createApp(async () => {
      throw new Error('unreachable')
    })
    expect((await post(app, '/api/v1/users/1/emails', {})).status).toBe(422)
    expect(
      (await post(app, '/api/v1/users/1/emails', { email: 'a@b.test', is_primary: true })).status,
    ).toBe(422)
  })
})
