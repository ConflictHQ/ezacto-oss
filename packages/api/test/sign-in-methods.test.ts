import { describe, expect, it, vi } from 'vitest'
import {
  createApiApp,
  createSignInMethodPolicy,
  installAppleRoutes,
  installPasswordAuthRoutes,
  installSignInMethodRoutes,
  type PasswordAuthService,
  type SignInMethod,
  type SignInMethodState,
} from '../src/index.js'

/**
 * Issue 761. Which ways in an instance offers used to be three separate secret
 * checks at deploy time, and password could not be switched off at all. These
 * assert the two things that make the setting safe to hand an operator: the
 * refusals that stop it emptying the set of ways in, and the routes actually
 * going away rather than the form merely being hidden.
 */

const sessionResolver = {
  resolve: async (request: Request) =>
    request.headers.get('cookie')?.includes('session=admin') === true
      ? {
          principal: {
            type: 'user' as const,
            userId: 42,
            profile: 'administrator' as const,
            managerGrants: [] as string[],
            authentication: { kind: 'session' as const, sessionId: '1' },
          },
        }
      : request.headers.get('cookie')?.includes('session=member') === true
        ? {
            principal: {
              type: 'user' as const,
              userId: 9,
              profile: 'member' as const,
              managerGrants: [] as string[],
              authentication: { kind: 'session' as const, sessionId: '2' },
            },
          }
        : null,
}

const service = (
  initial: Partial<Record<SignInMethod, boolean>> = {},
  usable: readonly SignInMethod[] = ['password', 'google'],
) => {
  const state = new Map<SignInMethod, boolean>([
    ['password', initial.password ?? true],
    ['magic_link', initial.magic_link ?? true],
    ['google', initial.google ?? true],
    ['github', initial.github ?? true],
    ['apple', initial.apple ?? true],
  ])
  const list = async (): Promise<readonly SignInMethodState[]> =>
    [...state].map(([method, enabled]) => ({ method, enabled }))
  return {
    list: vi.fn(list),
    usableBy: vi.fn(async () => usable),
    setEnabled: vi.fn(async (method: SignInMethod, enabled: boolean) => {
      state.set(method, enabled)
      return list()
    }),
  }
}

const harness = (
  settings = service(),
  configured: readonly SignInMethod[] = ['password', 'google'],
) => {
  const app = createApiApp({
    authentication: { sessions: sessionResolver },
    installApi: (api) => {
      installSignInMethodRoutes(api, {
        service: settings,
        configured: () => configured,
        clock: () => '2026-09-15T12:00:00.000Z',
      })
    },
  })
  return { app, settings }
}

const patch = (
  app: ReturnType<typeof createApiApp>,
  method: string,
  enabled: boolean,
  cookie = 'session=admin',
) =>
  app.request(`/api/v1/admin/sign-in-methods/${method}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify({ enabled }),
  })

describe('the sign-in method setting', () => {
  it('[api] reports configured and enabled apart', async () => {
    // "We never set this up" and "we switched this off" are different problems
    // with different fixes, and collapsing them into one flag hides which.
    const { app } = harness(service({ google: false }), ['password', 'google'])
    const response = await app.request('/api/v1/admin/sign-in-methods', {
      headers: { cookie: 'session=admin' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: readonly { method: string; configured: boolean; enabled: boolean }[]
    }
    expect(body.data).toEqual([
      { method: 'password', configured: true, enabled: true },
      { method: 'magic_link', configured: false, enabled: true },
      { method: 'google', configured: true, enabled: false },
      { method: 'github', configured: false, enabled: true },
      { method: 'apple', configured: false, enabled: true },
    ])
  })

  it('[security] is administrators only', async () => {
    const { app } = harness()
    expect(
      (await app.request('/api/v1/admin/sign-in-methods', {
        headers: { cookie: 'session=member' },
      })).status,
    ).toBe(403)
    expect((await patch(app, 'password', false, 'session=member')).status).toBe(403)
    expect(
      (await app.request('/api/v1/admin/sign-in-methods')).status,
    ).toBe(401)
  })

  it('[security] refuses to switch off the last way in', async () => {
    // The one mistake with no recovery short of database surgery.
    const { app, settings } = harness(
      service({ google: false }),
      ['password', 'google'],
    )
    const response = await patch(app, 'password', false)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'last_sign_in_method' },
    })
    expect(settings.setEnabled).not.toHaveBeenCalled()
  })

  it('[security] refuses to switch off the way the administrator gets in', async () => {
    // The likelier mistake, and one a count cannot catch: Google stays live for
    // everyone else, and the administrator turning password off has never
    // signed in with it.
    const { app, settings } = harness(
      service({}, ['password']),
      ['password', 'google'],
    )
    const response = await patch(app, 'password', false)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'would_lock_out_administrator' },
    })
    expect(settings.setEnabled).not.toHaveBeenCalled()
  })

  it('[api] switches one off when another the administrator can use remains', async () => {
    const { app, settings } = harness(
      service({}, ['password', 'google']),
      ['password', 'google'],
    )
    const response = await patch(app, 'password', false)
    expect(response.status).toBe(200)
    expect(settings.setEnabled).toHaveBeenCalledWith(
      'password',
      false,
      '2026-09-15T12:00:00.000Z',
    )
    const body = (await response.json()) as {
      data: readonly { method: string; enabled: boolean }[]
    }
    expect(body.data.find((state) => state.method === 'password')?.enabled).toBe(false)
  })

  it('[api] refuses to switch on what the deployment never configured', async () => {
    // The fix is a deployment change, so say which state is missing rather than
    // accepting a setting that would put a dead button on the sign-in page.
    const { app, settings } = harness(service({ github: false }), ['password'])
    const response = await patch(app, 'github', true)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'sign_in_method_not_configured' },
    })
    expect(settings.setEnabled).not.toHaveBeenCalled()
  })

  it('[api] refuses an unknown method and a malformed body', async () => {
    const { app } = harness()
    expect((await patch(app, 'carrier-pigeon', false)).status).toBe(404)
    const bad = await app.request('/api/v1/admin/sign-in-methods/password', {
      method: 'PATCH',
      headers: {
        cookie: 'session=admin',
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({ enabled: 'no' }),
    })
    expect(bad.status).toBe(422)
  })
})

const passwordService = (): PasswordAuthService => ({
  signup: vi.fn(),
  verifyEmail: vi.fn(),
  signIn: vi.fn(async () => ({
    status: 'authenticated' as const,
    principal: { userId: 42, profile: 'administrator' as const, managerGrants: [] },
    credentialVersion: 1,
  })),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
})

const passwordHarness = (enabled: boolean) => {
  const service = passwordService()
  const sessions = { issue: vi.fn(async () => ({ setCookie: 'x=y' })) }
  const app = createApiApp({
    installApp: (app) => {
      installPasswordAuthRoutes(app, {
        service,
        sessions,
        policy: createSignInMethodPolicy({
          service: { list: async () => [{ method: 'password', enabled }] },
          configured: () => ['password'],
        }),
        clientKey: () => 'test-client',
      })
    },
  })
  return { app, service, sessions }
}

describe('switching a sign-in method off', () => {
  it('[security] stops the routes, not just the form', async () => {
    // A hidden form is still a mounted endpoint, and the endpoint is what an
    // attacker uses. Every leg of the family goes, not only the sign-in.
    const { app, service, sessions } = passwordHarness(false)
    for (const path of [
      '/auth/sign-in',
      '/auth/signup',
      '/auth/password/forgot',
      '/auth/password/reset',
      '/auth/verify-email',
    ]) {
      const response = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(response.status, path).toBe(404)
      expect(await response.json()).toMatchObject({
        error: { code: 'sign_in_method_unavailable' },
      })
    }
    // Refused before the credential is read, so a switched-off method is not a
    // place to test whether an email exists.
    expect(service.signIn).not.toHaveBeenCalled()
    expect(sessions.issue).not.toHaveBeenCalled()
  })

  it('[security] leaves the routes working while it is on', async () => {
    const { app, sessions } = passwordHarness(true)
    const response = await app.request('/auth/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'ada@example.test',
        password: 'correct horse battery staple',
      }),
    })
    expect(response.status).toBe(200)
    expect(sessions.issue).toHaveBeenCalled()
  })

  it('[security] an unconfigured method is never live, whatever the setting says', async () => {
    // A row claiming Google is on would be a lie the moment the credentials
    // were removed, so "configured" is resolved at the edge and wins.
    const policy = createSignInMethodPolicy({
      service: { list: async () => [{ method: 'google', enabled: true }] },
      configured: () => ['password'],
    })
    expect(await policy.isLive('google', {})).toBe(false)
    expect(await policy.isLive('password', {})).toBe(true)
  })

  it('[security] an untouched setting leaves every configured method live', async () => {
    // The upgrade path: nothing was ever switched off, so nothing is.
    const policy = createSignInMethodPolicy({
      service: { list: async () => [] },
      configured: () => ['password', 'google'],
    })
    expect(await policy.isLive('password', {})).toBe(true)
    expect(await policy.isLive('google', {})).toBe(true)
  })
})

describe('the Apple route under the setting', () => {
  // Apple draws no button on the sign-in card, so switching it off has to stop
  // the route -- there is no control to hide. That is the whole point of the
  // setting enforcing server-side rather than in the markup.
  const appleHarness = (enabled: boolean) => {
    const sessions = { issue: vi.fn(async () => ({ setCookie: 'x=y' })) }
    const verify = vi.fn(async () => ({
      subject: 'apple-subject',
      email: 'ada@example.test',
      emailVerified: true,
    }))
    const app = createApiApp({
      installApp: (app) => {
        installAppleRoutes(app, {
          identities: {
            resolveProvider: vi.fn(async () => ({
              status: 'active' as const,
              matchedBy: 'verified_email' as const,
              userId: 42,
              profile: 'administrator' as const,
              managerGrants: [] as string[],
            })),
          },
          sessions,
          provider: () => ({ clientId: 'com.example.app' }),
          verifier: { verify },
          policy: createSignInMethodPolicy({
            service: { list: async () => [{ method: 'apple', enabled }] },
            configured: () => ['apple'],
          }),
        })
      },
    })
    return { app, sessions, verify }
  }

  const postToken = (app: ReturnType<typeof createApiApp>) =>
    app.request('/auth/apple', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identityToken: 'a.b.c' }),
    })

  it('[security] refuses before verifying the token when it is switched off', async () => {
    const { app, sessions, verify } = appleHarness(false)
    const response = await postToken(app)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: 'sign_in_method_unavailable' },
    })
    // Refused before the credential is read, as every other family is.
    expect(verify).not.toHaveBeenCalled()
    expect(sessions.issue).not.toHaveBeenCalled()
  })

  it('[security] still signs in while it is on', async () => {
    const { app, sessions } = appleHarness(true)
    expect((await postToken(app)).status).toBe(200)
    expect(sessions.issue).toHaveBeenCalledWith(42)
  })
})
