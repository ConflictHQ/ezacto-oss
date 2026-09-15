import { describe, expect, it, vi } from 'vitest'
import {
  createApiApp,
  installPasswordAuthRoutes,
  installOidcRoutes,
  installStaffMagicLinkRoutes,
  installTwoFactorChallengeRoutes,
  type OidcAppCodeStorePort,
  type PasswordAuthService,
  type StaffMagicLinkStorePort,
  type TwoFactorGate,
} from '../src/index.js'

/**
 * Issue 731. Every sign-in path issued a session the moment the primary
 * credential checked out, so a user who had enrolled a second factor was
 * protected by the belief that they were and by nothing else. These are the
 * tests that would have caught it: they assert on the wire, because the bug was
 * never in the two-factor service -- it was in what the sign-in routes did with
 * it, which was nothing.
 */

const SESSION_COOKIE =
  '__Host-ezacto_session=test-session; Path=/; HttpOnly; Secure; SameSite=Lax'

const principal = {
  userId: 42,
  profile: 'administrator' as const,
  managerGrants: [] as string[],
}

const CHALLENGE = 'C'.repeat(43)

interface GateOptions {
  enrolled?: boolean
  verdict?: Awaited<ReturnType<TwoFactorGate['redeemChallenge']>>
}

const gate = ({ enrolled = true, verdict }: GateOptions = {}): TwoFactorGate => ({
  isEnrolled: vi.fn(async () => enrolled),
  issueChallenge: vi.fn(async () => ({
    token: CHALLENGE,
    expiresAt: '2026-09-09T12:05:00.000Z',
  })),
  redeemChallenge: vi.fn(async (_token, code) =>
    verdict !== undefined
      ? verdict
      : code === '123456'
        ? ({ status: 'accepted', userId: principal.userId } as const)
        : ({ status: 'rejected' } as const),
  ),
})

const passwordService = (): PasswordAuthService => ({
  signup: vi.fn(),
  verifyEmail: vi.fn(),
  signIn: vi.fn(async () => ({
    status: 'authenticated' as const,
    principal,
    credentialVersion: 7,
  })),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
})

const harness = (twoFactor?: TwoFactorGate) => {
  const sessions = { issue: vi.fn(async () => ({ setCookie: SESSION_COOKIE })) }
  const app = createApiApp({
    installApp(app) {
      installPasswordAuthRoutes(app, {
        service: passwordService(),
        sessions,
        ...(twoFactor === undefined ? {} : { twoFactor }),
        clientKey: () => 'test-client',
      })
      if (twoFactor !== undefined) {
        installTwoFactorChallengeRoutes(app, { gate: twoFactor, sessions })
      }
    },
  })
  return { app, sessions }
}

const post = (
  app: ReturnType<typeof createApiApp>,
  path: string,
  body: unknown,
  cookie?: string,
) =>
  app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  })

const cookies = (response: Response): string[] =>
  response.headers.getSetCookie?.() ??
  (response.headers.get('set-cookie') === null
    ? []
    : [response.headers.get('set-cookie')!])

const signIn = (app: ReturnType<typeof createApiApp>) =>
  post(app, '/auth/sign-in', {
    email: 'ada@example.test',
    password: 'correct horse battery staple',
  })

describe('the second factor at sign-in', () => {
  it('[security] an enrolled user gets a challenge and no session', async () => {
    const { app, sessions } = harness(gate())
    const response = await signIn(app)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        status: 'two_factor_required',
        challenge: CHALLENGE,
        expires_at: '2026-09-09T12:05:00.000Z',
      },
    })
    // The whole of the bug, in one assertion.
    expect(sessions.issue).not.toHaveBeenCalled()
    const set = cookies(response)
    expect(set.some((value) => value.includes('__Host-ezacto_session='))).toBe(false)
    const challengeCookie = set.find((value) =>
      value.startsWith('__Host-ezacto_2fa_challenge='),
    )
    expect(challengeCookie).toContain(CHALLENGE)
    expect(challengeCookie).toContain('HttpOnly')
    expect(challengeCookie).toContain('Secure')
  })

  it('[security] a user with no enrolment signs in exactly as before', async () => {
    const { app, sessions } = harness(gate({ enrolled: false }))
    const response = await signIn(app)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        status: 'authenticated',
        user_id: 42,
        profile: 'administrator',
        manager_grants: [],
      },
    })
    expect(sessions.issue).toHaveBeenCalledWith(42, 7)
    expect(cookies(response).some((value) => value.includes('__Host-ezacto_session='))).toBe(
      true,
    )
  })

  it('[security] the code is what turns the challenge into a session', async () => {
    const gateway = gate()
    const { app, sessions } = harness(gateway)
    const challenged = await signIn(app)
    expect(sessions.issue).not.toHaveBeenCalled()

    const completed = await post(
      app,
      '/auth/two-factor/challenge',
      { code: '123456' },
      cookies(challenged)
        .find((value) => value.startsWith('__Host-ezacto_2fa_challenge='))!
        .split(';')[0],
    )
    expect(completed.status).toBe(200)
    expect(await completed.json()).toEqual({ data: { status: 'authenticated' } })
    expect(gateway.redeemChallenge).toHaveBeenCalledWith(CHALLENGE, '123456')
    expect(sessions.issue).toHaveBeenCalledWith(42)
    const set = cookies(completed)
    expect(set.some((value) => value.includes('__Host-ezacto_session=test-session'))).toBe(
      true,
    )
    // The spent challenge goes with it, so a replay has nothing to present.
    expect(
      set.some((value) => value.startsWith('__Host-ezacto_2fa_challenge=;')),
    ).toBe(true)
  })

  it('[security] a client that keeps no cookies may name the challenge', async () => {
    // The native clients hold a token, not a cookie jar; the token is worth
    // nothing without a code, so naming it in the body costs nothing.
    const gateway = gate()
    const { app, sessions } = harness(gateway)
    const completed = await post(app, '/auth/two-factor/challenge', {
      code: '123456',
      challenge: CHALLENGE,
    })
    expect(completed.status).toBe(200)
    expect(sessions.issue).toHaveBeenCalledWith(42)
  })

  it('[security] a wrong code issues nothing', async () => {
    const { app, sessions } = harness(gate())
    const response = await post(
      app,
      '/auth/two-factor/challenge',
      { code: '000000' },
      `__Host-ezacto_2fa_challenge=${CHALLENGE}`,
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_two_factor_code' },
    })
    expect(sessions.issue).not.toHaveBeenCalled()
    // The challenge cookie survives a typo; the sign-in does not restart.
    expect(
      cookies(response).some((value) =>
        value.startsWith('__Host-ezacto_2fa_challenge=;'),
      ),
    ).toBe(false)
  })

  it('[security] the ceiling answers 429 and says nothing about how long', async () => {
    const { app, sessions } = harness(gate({ verdict: { status: 'locked' } }))
    const response = await post(
      app,
      '/auth/two-factor/challenge',
      { code: '000000' },
      `__Host-ezacto_2fa_challenge=${CHALLENGE}`,
    )
    expect(response.status).toBe(429)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('two_factor_locked')
    // A precise interval would be a free measurement of a shared budget.
    expect(body.error.message).not.toMatch(/\d/)
    expect(sessions.issue).not.toHaveBeenCalled()
  })

  it('[security] a spent or expired challenge is cleared, not retried', async () => {
    const { app, sessions } = harness(
      gate({ verdict: { status: 'unknown_challenge' } }),
    )
    const response = await post(
      app,
      '/auth/two-factor/challenge',
      { code: '123456' },
      `__Host-ezacto_2fa_challenge=${CHALLENGE}`,
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: 'two_factor_challenge_invalid' },
    })
    expect(sessions.issue).not.toHaveBeenCalled()
    expect(
      cookies(response).some((value) =>
        value.startsWith('__Host-ezacto_2fa_challenge=;'),
      ),
    ).toBe(true)
  })

  it('[api] refuses a challenge answer that carries no challenge at all', async () => {
    const { app } = harness(gate())
    const response = await post(app, '/auth/two-factor/challenge', { code: '123456' })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: 'two_factor_challenge_invalid' },
    })
  })

  it('[api] refuses unknown fields and an absent code', async () => {
    const { app } = harness(gate())
    expect(
      (await post(app, '/auth/two-factor/challenge', { totp: '123456' })).status,
    ).toBe(422)
    expect(
      (await post(app, '/auth/two-factor/challenge', { code: '' })).status,
    ).toBe(422)
  })
})

class MemoryMagicLinks implements StaffMagicLinkStorePort {
  async create() {
    return 'created' as const
  }
  async consumeByToken() {
    return { userId: principal.userId, flow: 'web' as const }
  }
  async consumeByCode() {
    return { userId: principal.userId, flow: 'web' as const }
  }
  async hasActiveLink() {
    return false
  }
}

class MemoryAppCodes implements OidcAppCodeStorePort {
  async create() {
    return 'created' as const
  }
  async consume() {
    return { userId: principal.userId, provider: 'magic-link' }
  }
}

const magicLinkHarness = (twoFactor: TwoFactorGate) => {
  const sessions = { issue: vi.fn(async () => ({ setCookie: SESSION_COOKIE })) }
  const app = createApiApp({
    installApp(app) {
      installStaffMagicLinkRoutes(app, {
        users: { findByEmail: async () => ({ userId: principal.userId }) },
        magicLinks: new MemoryMagicLinks(),
        sessions,
        appCodes: new MemoryAppCodes(),
        twoFactor,
        codeKey: new Uint8Array(32),
        linkOrigin: () => 'https://ezacto.example',
      })
    },
  })
  return { app, sessions }
}

describe('the second factor on a staff magic link', () => {
  it('[security] the emailed link lands on the code step, not on a session', async () => {
    const { app, sessions } = magicLinkHarness(gate())
    const response = await app.request(
      `/auth/magic-link/verify?token=${'T'.repeat(43)}`,
    )

    expect(response.status).toBe(303)
    // The flag says which step to open. The token itself stays in the cookie,
    // out of the referrer header, the history and any proxy log.
    expect(response.headers.get('location')).toBe('/?two_factor=1')
    expect(response.headers.get('location')).not.toContain(CHALLENGE)
    expect(sessions.issue).not.toHaveBeenCalled()
    expect(
      cookies(response).some((value) =>
        value.startsWith('__Host-ezacto_2fa_challenge='),
      ),
    ).toBe(true)
  })

  it('[security] the typed code buys a challenge, not a session', async () => {
    const { app, sessions } = magicLinkHarness(gate())
    const response = await post(app, '/auth/magic-link/exchange', {
      email: 'ada@example.test',
      code: '654321',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        status: 'two_factor_required',
        challenge: CHALLENGE,
        expires_at: '2026-09-09T12:05:00.000Z',
      },
    })
    expect(sessions.issue).not.toHaveBeenCalled()
  })

  it('[security] an unenrolled user is unaffected on both legs', async () => {
    const { app, sessions } = magicLinkHarness(gate({ enrolled: false }))
    const redirected = await app.request(
      `/auth/magic-link/verify?token=${'T'.repeat(43)}`,
    )
    expect(redirected.headers.get('location')).toBe('/')

    const exchanged = await post(app, '/auth/magic-link/exchange', {
      email: 'ada@example.test',
      code: '654321',
    })
    expect(await exchanged.json()).toEqual({ data: { ok: true } })
    expect(sessions.issue).toHaveBeenCalledTimes(2)
  })
})

const exchangeHarness = (provider: string) => {
  const sessions = { issue: vi.fn(async () => ({ setCookie: SESSION_COOKIE })) }
  const appCodes: OidcAppCodeStorePort = {
    create: async () => 'created' as const,
    consume: async () => ({ userId: principal.userId, provider }),
  }
  const app = createApiApp({
    installApp(app) {
      installOidcRoutes(app, {
        transactions: {
          create: async () => 'created' as const,
          consume: async () => null,
        },
        // Unused: this harness exercises the exchange, which reads an app code
        // rather than an assertion.
        identities: {
          resolveProvider: async () => ({
            status: 'active' as const,
            matchedBy: 'verified_email' as const,
            ...principal,
          }),
        },
        sessions,
        provider: () => null,
        clientKey: () => 'test-client',
        appCodes,
        twoFactor: gate(),
        localAppCodeProviders: ['magic-link'],
      })
    },
  })
  return { app, sessions }
}

describe('which sign-ins the second factor guards', () => {
  it('[security] gates an app code the magic link minted', async () => {
    // A magic link is a credential this instance issued and verified, so the
    // app handoff owes a code for the same reason the browser leg does.
    const { app, sessions } = exchangeHarness('magic-link')
    const response = await post(app, '/auth/oidc/exchange', { code: 'A'.repeat(43) })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: { status: 'two_factor_required' },
    })
    expect(sessions.issue).not.toHaveBeenCalled()
  })

  it('[security] exempts a federated app code, deliberately', async () => {
    // The decision recorded in docs/security.md: the identity provider owns the
    // factor policy for the account it asserts. A prompt here would add no
    // factor the IdP lacks, and this instance could not enforce one on the
    // IdP's own session anyway. Changing this test means changing that doc.
    const { app, sessions } = exchangeHarness('google')
    const response = await post(app, '/auth/oidc/exchange', { code: 'A'.repeat(43) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { ok: true } })
    expect(sessions.issue).toHaveBeenCalledWith(principal.userId)
  })
})
