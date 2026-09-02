import { describe, expect, it, vi } from 'vitest'
import {
  createApiApp,
  installPasswordAuthRoutes,
  type AuthDelivery,
  type PasswordAuthService,
} from '../src/index.js'

const verification: AuthDelivery = {
  kind: 'verify_email',
  to: 'owner@example.test',
  token:
    'ezacto_verify_abcdefghijklmnop_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi1234567',
  expiresAt: '2026-08-29T20:00:00.000Z',
}

const principal = {
  userId: 1,
  profile: 'administrator' as const,
  managerGrants: [] as string[],
}

const createHarness = () => {
  const deploymentDeliveries: AuthDelivery[] = []
  const service: PasswordAuthService = {
    signup: vi.fn(async () => verification),
    verifyEmail: vi.fn(async (token) => {
      if (token === 'used') {
        const error = new Error('used')
        error.name = 'InvalidAuthTokenError'
        throw error
      }
      return principal
    }),
    signIn: vi.fn(async ({ password }) =>
      password === 'correct password'
        ? { status: 'authenticated' as const, principal, credentialVersion: 7 }
        : password === 'pending password'
          ? { status: 'verification_required' as const }
          : { status: 'invalid_credentials' as const },
    ),
    requestPasswordReset: vi.fn(async (email) =>
      email === 'owner@example.test'
        ? {
            ...verification,
            kind: 'password_reset' as const,
            token: 'reset-token',
          }
        : null,
    ),
    resetPassword: vi.fn(async (token) => {
      if (token === 'used' || token === 'expired') {
        const error = new Error('invalid token')
        error.name = 'InvalidAuthTokenError'
        throw error
      }
      if (token === 'limited') {
        const error = new Error('limited') as Error & {
          retryAfterSeconds: number
        }
        error.name = 'AuthRateLimitError'
        error.retryAfterSeconds = 37
        throw error
      }
      return principal
    }),
  }
  const sessions = {
    issue: vi.fn(async () => ({
      setCookie:
        '__Host-ezacto_session=test-session; Path=/; HttpOnly; Secure; SameSite=Lax',
    })),
  }
  const app = createApiApp({
    installApp(app) {
      installPasswordAuthRoutes(app, {
        service,
        sessions,
        deploymentMailer: {
          assertAvailable: async () => undefined,
          enqueue: async (delivery) => void deploymentDeliveries.push(delivery),
        },
        clientKey: (request) =>
          request.headers.get('cf-connecting-ip') ?? 'test-client',
      })
    },
  })
  return { app, service, sessions, deploymentDeliveries }
}

const post = (
  app: ReturnType<typeof createApiApp>,
  path: string,
  body: unknown,
) =>
  app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '198.51.100.8',
    },
    body: JSON.stringify(body),
  })

describe('password authentication routes', () => {
  it('[api] queues verification without returning bearer material', async () => {
    const { app, service, deploymentDeliveries } = createHarness()
    const response = await post(app, '/auth/signup', {
      organization_name: 'Halcyon Studio',
      first_name: 'Avery',
      last_name: 'Ng',
      email: 'owner@example.test',
      password: 'correct horse battery staple',
    })
    expect(response.status).toBe(202)
    const wire = await response.text()
    expect(wire).not.toContain(verification.token)
    expect(JSON.parse(wire)).toEqual({ data: { status: 'verification_sent' } })
    expect(deploymentDeliveries).toEqual([verification])
    expect(service.signup).toHaveBeenCalledWith(
      expect.objectContaining({ clientKey: '198.51.100.8' }),
    )
  })

  it('[api] returns the same reset-request response for known and unknown addresses', async () => {
    const { app, deploymentDeliveries } = createHarness()
    const known = await post(app, '/auth/password/forgot', {
      email: 'owner@example.test',
    })
    const unknown = await post(app, '/auth/password/forgot', {
      email: 'nobody@example.test',
    })
    expect(known.status).toBe(202)
    expect(unknown.status).toBe(202)
    expect(await known.json()).toEqual(await unknown.json())
    expect(deploymentDeliveries).toHaveLength(1)
    expect(deploymentDeliveries[0]?.kind).toBe('password_reset')
  })

  it('[security] preflights deployment mail before lookup with known/unknown failure parity', async () => {
    const responses: Response[] = []
    for (const email of ['owner@example.test', 'nobody@example.test']) {
      const { service } = createHarness()
      const app = createApiApp({
        installApp(app) {
          installPasswordAuthRoutes(app, {
            service,
            sessions: { issue: async () => ({ setCookie: 'unused' }) },
            deploymentMailer: {
              assertAvailable: vi.fn(async () => {
                throw new Error('deployment provider unavailable')
              }),
              enqueue: vi.fn(async () => undefined),
            },
            clientKey: () => 'test-client',
          })
        },
      })
      responses.push(await post(app, '/auth/password/forgot', { email }))
      expect(service.requestPasswordReset).not.toHaveBeenCalled()
    }
    expect(responses.map((response) => response.status)).toEqual([500, 500])
    expect(
      await Promise.all(responses.map(async (response) => response.json())),
    ).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: 'internal_error' }) }),
      expect.objectContaining({ error: expect.objectContaining({ code: 'internal_error' }) }),
    ])
  })

  it('[security] rejects known and unknown reset requests identically when deployment mail is absent', async () => {
    const responses: Response[] = []
    for (const email of ['owner@example.test', 'nobody@example.test']) {
      const { service } = createHarness()
      const app = createApiApp({
        installApp(app) {
          installPasswordAuthRoutes(app, {
            service,
            sessions: { issue: async () => ({ setCookie: 'unused' }) },
            clientKey: () => 'test-client',
          })
        },
      })
      responses.push(await post(app, '/auth/password/forgot', { email }))
      expect(service.requestPasswordReset).not.toHaveBeenCalled()
    }
    expect(responses.map((response) => response.status)).toEqual([503, 503])
    expect(
      await Promise.all(responses.map(async (response) => response.json())),
    ).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: 'internal_error' }) }),
      expect.objectContaining({ error: expect.objectContaining({ code: 'internal_error' }) }),
    ])
  })

  it('[api] maps authenticated, unverified, and invalid sign-in outcomes', async () => {
    const { app, sessions } = createHarness()
    const authenticated = await post(app, '/auth/sign-in', {
      email: 'owner@example.test',
      password: 'correct password',
    })
    expect(authenticated.status).toBe(200)
    expect(authenticated.headers.get('set-cookie')).toContain(
      '__Host-ezacto_session=test-session',
    )
    expect(await authenticated.json()).toEqual({
      data: {
        status: 'authenticated',
        user_id: 1,
        profile: 'administrator',
        manager_grants: [],
      },
    })
    expect(sessions.issue).toHaveBeenCalledWith(1, 7)

    const pending = await post(app, '/auth/sign-in', {
      email: 'owner@example.test',
      password: 'pending password',
    })
    expect(pending.status).toBe(403)
    expect(await pending.json()).toMatchObject({
      error: { code: 'email_verification_required' },
    })

    const invalid = await post(app, '/auth/sign-in', {
      email: 'owner@example.test',
      password: 'wrong password',
    })
    expect(invalid.status).toBe(401)
    expect(await invalid.json()).toMatchObject({
      error: { code: 'invalid_credentials' },
    })
  })

  it('[security] rejects a session when the verified credential epoch changed', async () => {
    const { app, sessions } = createHarness()
    const changed = new Error('changed')
    changed.name = 'SessionCredentialChangedError'
    sessions.issue.mockRejectedValueOnce(changed)

    const response = await post(app, '/auth/sign-in', {
      email: 'owner@example.test',
      password: 'correct password',
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_credentials' },
    })
  })

  it('[security] makes derivation overload non-enumerating', async () => {
    const responses: Response[] = []
    for (const email of ['owner@example.test', 'unknown@example.test']) {
      const { app, service } = createHarness()
      const overloaded = new Error('overloaded')
      overloaded.name = 'PasswordDerivationOverloadedError'
      vi.mocked(service.signIn).mockRejectedValueOnce(overloaded)
      responses.push(
        await post(app, '/auth/sign-in', {
          email,
          password: 'correct password',
        }),
      )
    }

    expect(responses.map((response) => response.status)).toEqual([503, 503])
    const bodies = (await Promise.all(
      responses.map((response) => response.json()),
    )) as Array<{ error: { code: string } }>
    expect(bodies.map((body) => body.error.code)).toEqual([
      'internal_error',
      'internal_error',
    ])
  })

  it('[api] makes used tokens 401 and rate limits 429', async () => {
    const { app } = createHarness()
    const used = await post(app, '/auth/verify-email', { token: 'used' })
    expect(used.status).toBe(401)
    expect(await used.json()).toMatchObject({
      error: { code: 'invalid_auth_token' },
    })

    const usedReset = await post(app, '/auth/password/reset', {
      token: 'used',
      password: 'replacement password',
    })
    expect(usedReset.status).toBe(401)
    expect(await usedReset.json()).toMatchObject({
      error: { code: 'invalid_auth_token' },
    })

    const limited = await post(app, '/auth/password/reset', {
      token: 'limited',
      password: 'replacement password',
    })
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({
      error: { code: 'rate_limit_exceeded' },
    })
  })

  it('[api] rejects unknown fields before invoking the service', async () => {
    const { app, service } = createHarness()
    const response = await post(app, '/auth/sign-in', {
      email: 'owner@example.test',
      password: 'correct password',
      redirect: 'https://attacker.example',
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      error: { fields: [{ field: 'redirect', code: 'unknown' }] },
    })
    expect(service.signIn).not.toHaveBeenCalled()
  })

  it('[api] fails closed before identity mutation when the Mailer queue is unavailable', async () => {
    const { service } = createHarness()
    const unavailable = createApiApp({
      installApp(app) {
        installPasswordAuthRoutes(app, {
          service,
          sessions: { issue: async () => ({ setCookie: 'unused' }) },
          clientKey: () => 'test-client',
        })
      },
    })
    const response = await post(unavailable, '/auth/signup', {
      organization_name: 'Halcyon Studio',
      first_name: 'Avery',
      last_name: 'Ng',
      email: 'owner@example.test',
      password: 'correct horse battery staple',
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: { code: 'internal_error' },
    })
    expect(service.signup).not.toHaveBeenCalled()
  })
})
