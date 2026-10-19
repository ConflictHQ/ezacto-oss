import { describe, expect, it, vi } from 'vitest'
import type { SenderBoundQueuedMailer } from '@ezacto/mailer'
import {
  createApiApp,
  createQueuedTwoFactorEmailCodeMailer,
  installOidcRoutes,
  installPasswordAuthRoutes,
  installStaffMagicLinkRoutes,
  installTwoFactorChallengeRoutes,
  type OidcAppCodeStorePort,
  type PasswordAuthService,
  type StaffMagicLinkStorePort,
  type TwoFactorEmailCodeMailer,
  type TwoFactorGate,
} from '../src/index.js'
import type { TwoFactorService } from '../src/auth.js'

/**
 * Issue 770, slice B: the emailed second factor on the wire. The store and the
 * limits are tested against real databases in packages/db; what is asserted
 * here is what the routes do with the answers -- above all that the factor
 * exists for a password sign-in and for nothing else.
 */

const SESSION_COOKIE =
  '__Host-ezacto_session=test-session; Path=/; HttpOnly; Secure; SameSite=Lax'
const CHALLENGE = 'C'.repeat(43)
const MAILED = 'M'.repeat(43)
const RESENT = 'R'.repeat(43)
const EXPIRES = '2026-10-18T12:05:00.000Z'
const principal = { userId: 42, profile: 'administrator' as const, managerGrants: [] as string[] }

type Issue = Awaited<ReturnType<NonNullable<TwoFactorGate['issueEmailCodeChallenge']>>>
type Resend = Awaited<ReturnType<NonNullable<TwoFactorGate['resendEmailCode']>>>

const issued: Issue = {
  status: 'issued',
  offer: { token: MAILED, expiresAt: EXPIRES, emailCode: '482913', emailTo: 'ada@example.test' },
}
const resent: Resend = {
  status: 'sent',
  userId: 42,
  token: RESENT,
  expiresAt: EXPIRES,
  emailCode: '771204',
  emailTo: 'ada@example.test',
}

interface GateOptions {
  totp?: boolean
  email?: boolean
  issue?: Issue
  resend?: Resend
  verdict?: Awaited<ReturnType<TwoFactorGate['redeemChallenge']>>
}

const gate = ({ totp = false, email = false, issue = issued, resend = resent, verdict }: GateOptions = {}) => ({
  isEnrolled: vi.fn(async () => totp),
  isEmailFactorEnabled: vi.fn(async () => email),
  issueChallenge: vi.fn(async () => ({ token: CHALLENGE, expiresAt: EXPIRES })),
  issueEmailCodeChallenge: vi.fn(async () => issue),
  resendEmailCode: vi.fn(async () => resend),
  redeemChallenge: vi.fn(async () =>
    verdict ?? ({ status: 'accepted', userId: principal.userId } as const),
  ),
})

const mailer = (): TwoFactorEmailCodeMailer & { enqueue: ReturnType<typeof vi.fn> } => ({
  enqueue: vi.fn(async () => undefined),
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

const harness = (twoFactor: TwoFactorGate, emailCodes?: TwoFactorEmailCodeMailer) => {
  const sessions = { issue: vi.fn(async () => ({ setCookie: SESSION_COOKIE })) }
  const app = createApiApp({
    installApp(app) {
      installPasswordAuthRoutes(app, {
        service: passwordService(),
        sessions,
        twoFactor,
        ...(emailCodes === undefined ? {} : { twoFactorEmailCodes: emailCodes }),
        clientKey: () => 'test-client',
      })
      installTwoFactorChallengeRoutes(app, {
        gate: twoFactor,
        sessions,
        ...(emailCodes === undefined ? {} : { emailCodes }),
      })
    },
  })
  return { app, sessions }
}

const post = (app: ReturnType<typeof createApiApp>, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify(body),
  })

const cookies = (response: Response): string[] =>
  response.headers.getSetCookie?.() ??
  (response.headers.get('set-cookie') === null ? [] : [response.headers.get('set-cookie')!])

const signIn = (app: ReturnType<typeof createApiApp>) =>
  post(app, '/auth/sign-in', { email: 'ada@example.test', password: 'correct horse battery staple' })

const hasSession = (response: Response) =>
  cookies(response).some((value) => value.includes('__Host-ezacto_session='))

describe('password sign-in with the emailed factor', () => {
  it('[e2e:first-run] an email-only user gets a challenge and exactly one code mail, and no session', async () => {
    const gateway = gate({ email: true })
    const codes = mailer()
    const { app, sessions } = harness(gateway, codes)
    const response = await signIn(app)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      data: { status: 'two_factor_required', challenge: MAILED, expires_at: EXPIRES, methods: ['email'] },
    })
    expect(sessions.issue).not.toHaveBeenCalled()
    expect(hasSession(response)).toBe(false)
    expect(
      cookies(response).find((value) => value.startsWith('__Host-ezacto_2fa_challenge=')),
    ).toContain(MAILED)
    expect(codes.enqueue).toHaveBeenCalledTimes(1)
    expect(codes.enqueue).toHaveBeenCalledWith({
      to: 'ada@example.test',
      code: '482913',
      expiresAt: EXPIRES,
    })
    // The code goes out in the mail and is never in the response.
    expect(JSON.stringify(body)).not.toContain('482913')
  })

  it('[security] an email-only user is refused, not admitted, when no mail can be sent', async () => {
    const { app, sessions } = harness(gate({ email: true }), undefined)
    const response = await signIn(app)
    // A 5xx body is deliberately generic; the status is the contract.
    expect(response.status).toBe(503)
    expect(sessions.issue).not.toHaveBeenCalled()
    expect(hasSession(response)).toBe(false)
  })

  it('[security] a gate that cannot issue a mailed code refuses an email-only user too', async () => {
    const gateway = gate({ email: true }) as TwoFactorGate
    delete gateway.issueEmailCodeChallenge
    const { app, sessions } = harness(gateway, mailer())
    expect((await signIn(app)).status).toBe(503)
    expect(sessions.issue).not.toHaveBeenCalled()
  })

  it('[security] the send limit answers 429 and mails nothing and admits nobody', async () => {
    const codes = mailer()
    const { app, sessions } = harness(
      gate({ email: true, issue: { status: 'rate_limited', retryAfterSeconds: 37 } }),
      codes,
    )
    const response = await signIn(app)
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ error: { code: 'rate_limit_exceeded' } })
    expect(codes.enqueue).not.toHaveBeenCalled()
    expect(sessions.issue).not.toHaveBeenCalled()
    expect(hasSession(response)).toBe(false)
  })

  it('[security] an unavailable factor refuses the sign-in rather than skipping it', async () => {
    const { app, sessions } = harness(gate({ email: true, issue: { status: 'unavailable' } }), mailer())
    expect((await signIn(app)).status).toBe(503)
    expect(sessions.issue).not.toHaveBeenCalled()
  })

  it('[security] a mailer that fails leaves no challenge cookie and no session', async () => {
    const codes = mailer()
    codes.enqueue.mockRejectedValueOnce(new Error('queue down'))
    const { app, sessions } = harness(gate({ email: true }), codes)
    const response = await signIn(app)
    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(sessions.issue).not.toHaveBeenCalled()
    expect(cookies(response).some((value) => value.includes('2fa_challenge'))).toBe(false)
  })

  it('[security] a user with both factors is challenged and mailed nothing until they ask', async () => {
    const gateway = gate({ totp: true, email: true })
    const codes = mailer()
    const { app, sessions } = harness(gateway, codes)
    const response = await signIn(app)

    expect(await response.json()).toEqual({
      data: {
        status: 'two_factor_required',
        challenge: CHALLENGE,
        expires_at: EXPIRES,
        methods: ['totp', 'email'],
      },
    })
    expect(codes.enqueue).not.toHaveBeenCalled()
    expect(gateway.issueEmailCodeChallenge).not.toHaveBeenCalled()
    // The challenge is marked as one that may be mailed a code later.
    expect(gateway.issueChallenge).toHaveBeenCalledWith(42, { emailCodeAllowed: true })
    expect(sessions.issue).not.toHaveBeenCalled()
  })

  it('[security] with both factors but no mailer, only the authenticator is offered and marked', async () => {
    const gateway = gate({ totp: true, email: true })
    const { app } = harness(gateway, undefined)
    const body = (await (await signIn(app)).json()) as { data: { methods: string[] } }
    expect(body.data.methods).toEqual(['totp'])
    expect(gateway.issueChallenge).toHaveBeenCalledWith(42, { emailCodeAllowed: false })
  })

  it('[security] an authenticator-only user is unchanged and cannot be mailed a code', async () => {
    const gateway = gate({ totp: true, email: false })
    const codes = mailer()
    const { app } = harness(gateway, codes)
    const body = (await (await signIn(app)).json()) as { data: { methods: string[] } }
    expect(body.data.methods).toEqual(['totp'])
    expect(gateway.issueChallenge).toHaveBeenCalledWith(42, { emailCodeAllowed: false })
    expect(codes.enqueue).not.toHaveBeenCalled()
  })

  it('[security] a user with neither factor signs in as before', async () => {
    const gateway = gate()
    const codes = mailer()
    const { app, sessions } = harness(gateway, codes)
    const response = await signIn(app)
    expect(response.status).toBe(200)
    expect(sessions.issue).toHaveBeenCalledWith(42, 7)
    expect(hasSession(response)).toBe(true)
    expect(codes.enqueue).not.toHaveBeenCalled()
  })

  it('[security] a gate that knows nothing of the emailed factor leaves sign-in as it was', async () => {
    const gateway = gate({ totp: true }) as TwoFactorGate
    delete gateway.isEmailFactorEnabled
    const { app } = harness(gateway, mailer())
    const body = (await (await signIn(app)).json()) as { data: { methods: string[] } }
    expect(body.data.methods).toEqual(['totp'])
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

const magicLinkHarness = (twoFactor: TwoFactorGate) => {
  const sessions = { issue: vi.fn(async () => ({ setCookie: SESSION_COOKIE })) }
  const app = createApiApp({
    installApp(app) {
      installStaffMagicLinkRoutes(app, {
        users: { findByEmail: async () => ({ userId: principal.userId }) },
        magicLinks: new MemoryMagicLinks(),
        sessions,
        appCodes: {
          create: async () => 'created' as const,
          consume: async () => null,
        },
        twoFactor,
        codeKey: new Uint8Array(32),
        linkOrigin: () => 'https://ezacto.example',
      })
    },
  })
  return { app, sessions }
}

const exchangeHarness = (provider: string, twoFactor: TwoFactorGate) => {
  const sessions = { issue: vi.fn(async () => ({ setCookie: SESSION_COOKIE })) }
  const appCodes: OidcAppCodeStorePort = {
    create: async () => 'created' as const,
    consume: async () => ({ userId: principal.userId, provider }),
  }
  const app = createApiApp({
    installApp(app) {
      installOidcRoutes(app, {
        transactions: { create: async () => 'created' as const, consume: async () => null },
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
        twoFactor,
        localAppCodeProviders: ['magic-link'],
      })
    },
  })
  return { app, sessions }
}

/** The refusal the issue asks for: asserted, not incidental. */
describe('the emailed factor does not apply to other sign-ins', () => {
  it('[security] a magic link for an email-only user signs in without a second code to the same mailbox', async () => {
    const gateway = gate({ email: true })
    const { app, sessions } = magicLinkHarness(gateway)
    const response = await app.request(`/auth/magic-link/verify?token=${'T'.repeat(43)}`)

    expect(response.headers.get('location')).toBe('/')
    expect(sessions.issue).toHaveBeenCalledTimes(1)
    expect(gateway.isEmailFactorEnabled).not.toHaveBeenCalled()
    expect(gateway.issueEmailCodeChallenge).not.toHaveBeenCalled()
    expect(gateway.issueChallenge).not.toHaveBeenCalled()
  })

  it('[security] a magic link for a user with an authenticator issues a challenge that can never be mailed a code', async () => {
    const gateway = gate({ totp: true, email: true })
    const { app, sessions } = magicLinkHarness(gateway)
    const response = await app.request(`/auth/magic-link/verify?token=${'T'.repeat(43)}`)

    expect(response.headers.get('location')).toBe('/?two_factor=1')
    expect(sessions.issue).not.toHaveBeenCalled()
    expect(gateway.issueChallenge).toHaveBeenCalledWith(42, { emailCodeAllowed: false })
    expect(gateway.isEmailFactorEnabled).not.toHaveBeenCalled()
    expect(gateway.issueEmailCodeChallenge).not.toHaveBeenCalled()
  })

  it('[security] the typed magic-link code behaves the same way', async () => {
    const gateway = gate({ email: true })
    const { app, sessions } = magicLinkHarness(gateway)
    const response = await post(app, '/auth/magic-link/exchange', {
      email: 'ada@example.test',
      code: '654321',
    })
    expect(await response.json()).toEqual({ data: { ok: true } })
    expect(sessions.issue).toHaveBeenCalledTimes(1)
    expect(gateway.issueEmailCodeChallenge).not.toHaveBeenCalled()
  })

  it('[security] the app handoff of a magic link never mails a code', async () => {
    const gateway = gate({ totp: true, email: true })
    const { app, sessions } = exchangeHarness('magic-link', gateway)
    const response = await post(app, '/auth/oidc/exchange', { code: 'A'.repeat(43) })
    expect(await response.json()).toMatchObject({ data: { status: 'two_factor_required' } })
    expect(sessions.issue).not.toHaveBeenCalled()
    expect(gateway.issueChallenge).toHaveBeenCalledWith(42, { emailCodeAllowed: false })
    expect(gateway.issueEmailCodeChallenge).not.toHaveBeenCalled()
  })

  it('[security] a federated sign-in is not challenged at all, email factor or not', async () => {
    const gateway = gate({ email: true })
    const { app, sessions } = exchangeHarness('google', gateway)
    const response = await post(app, '/auth/oidc/exchange', { code: 'A'.repeat(43) })
    expect(response.status).toBe(200)
    expect(sessions.issue).toHaveBeenCalledTimes(1)
    expect(gateway.isEmailFactorEnabled).not.toHaveBeenCalled()
    expect(gateway.issueEmailCodeChallenge).not.toHaveBeenCalled()
  })
})

describe('asking for a code against a pending sign-in', () => {
  const ask = (app: ReturnType<typeof createApiApp>, body: unknown = {}, cookie?: string) =>
    post(app, '/auth/two-factor/email-code', body, cookie)

  it('[e2e:first-run] mails a new code and hands back the new challenge in the body and the cookie', async () => {
    const gateway = gate({ totp: true, email: true })
    const codes = mailer()
    const { app, sessions } = harness(gateway, codes)
    const response = await ask(app, { challenge: CHALLENGE })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      data: {
        status: 'two_factor_required',
        challenge: RESENT,
        expires_at: EXPIRES,
        methods: ['totp', 'email'],
      },
    })
    expect(gateway.resendEmailCode).toHaveBeenCalledWith(CHALLENGE)
    expect(codes.enqueue).toHaveBeenCalledTimes(1)
    expect(codes.enqueue).toHaveBeenCalledWith({
      to: 'ada@example.test',
      code: '771204',
      expiresAt: EXPIRES,
    })
    expect(
      cookies(response).find((value) => value.startsWith('__Host-ezacto_2fa_challenge=')),
    ).toContain(RESENT)
    // Asking for a code is not signing in.
    expect(sessions.issue).not.toHaveBeenCalled()
    expect(hasSession(response)).toBe(false)
  })

  it('[api] reads the challenge from the cookie when the body names none', async () => {
    const gateway = gate({ email: true })
    const { app } = harness(gateway, mailer())
    const response = await ask(app, {}, `__Host-ezacto_2fa_challenge=${CHALLENGE}`)
    expect(response.status).toBe(200)
    expect(gateway.resendEmailCode).toHaveBeenCalledWith(CHALLENGE)
  })

  it('[security] an email-only user is not told they also have an authenticator', async () => {
    const { app } = harness(gate({ totp: false, email: true }), mailer())
    const body = (await (await ask(app, { challenge: CHALLENGE })).json()) as {
      data: { methods: string[] }
    }
    expect(body.data.methods).toEqual(['email'])
  })

  it('[security] no challenge at all is refused before anything is looked up', async () => {
    const gateway = gate({ email: true })
    const codes = mailer()
    const { app } = harness(gateway, codes)
    const response = await ask(app)
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'two_factor_challenge_invalid' } })
    expect(gateway.resendEmailCode).not.toHaveBeenCalled()
    expect(codes.enqueue).not.toHaveBeenCalled()
  })

  it('[security] an unknown, spent or expired challenge is cleared and nothing is mailed', async () => {
    const codes = mailer()
    const { app } = harness(gate({ resend: { status: 'unknown_challenge' } }), codes)
    const response = await ask(app, { challenge: CHALLENGE })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'two_factor_challenge_invalid' } })
    expect(cookies(response).some((value) => value.startsWith('__Host-ezacto_2fa_challenge=;'))).toBe(
      true,
    )
    expect(codes.enqueue).not.toHaveBeenCalled()
  })

  it('[security] a challenge that may not be mailed a code is refused plainly', async () => {
    // A magic-link challenge, or a user who never turned the factor on.
    const codes = mailer()
    const { app } = harness(gate({ resend: { status: 'refused' } }), codes)
    const response = await ask(app, { challenge: CHALLENGE })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'two_factor_email_unavailable' } })
    expect(codes.enqueue).not.toHaveBeenCalled()
  })

  it('[security] the limit answers 429 with a Retry-After and mails nothing', async () => {
    const codes = mailer()
    const { app } = harness(gate({ resend: { status: 'rate_limited', retryAfterSeconds: 41 } }), codes)
    const response = await ask(app, { challenge: CHALLENGE })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('41')
    expect(await response.json()).toMatchObject({ error: { code: 'rate_limit_exceeded' } })
    expect(codes.enqueue).not.toHaveBeenCalled()
  })

  it('[security] without a mailer the route answers 503 and never reaches the gate', async () => {
    const gateway = gate({ email: true })
    const { app } = harness(gateway, undefined)
    const response = await ask(app, { challenge: CHALLENGE })
    expect(response.status).toBe(503)
    expect(gateway.resendEmailCode).not.toHaveBeenCalled()
  })

  it('[api] refuses unknown fields and a non-string challenge', async () => {
    const { app } = harness(gate({ email: true }), mailer())
    expect((await ask(app, { challenge: CHALLENGE, email: 'x@example.test' })).status).toBe(422)
    expect((await ask(app, { challenge: 7 })).status).toBe(422)
  })

  it('[security] the code can be answered only through the existing challenge route', async () => {
    const gateway = gate({ email: true })
    const { app, sessions } = harness(gateway, mailer())
    const answered = await post(app, '/auth/two-factor/challenge', {
      challenge: RESENT,
      code: '771204',
    })
    expect(answered.status).toBe(200)
    expect(gateway.redeemChallenge).toHaveBeenCalledWith(RESENT, '771204')
    expect(sessions.issue).toHaveBeenCalledWith(42)
  })
})

describe('the mail', () => {
  const composed = async () => {
    const enqueue = vi.fn<SenderBoundQueuedMailer['enqueue']>()
    const mail = createQueuedTwoFactorEmailCodeMailer(
      { enqueue } as unknown as SenderBoundQueuedMailer,
      async () => 'Halcyon <Studio>',
    )
    await mail.enqueue({
      to: 'ada@example.test',
      code: '482913',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    })
    return enqueue.mock.calls[0]![0]
  }

  it('[security] carries a code and no link, in either part', async () => {
    const message = await composed()
    expect(message.template).toBe('two_factor_email_code:v1')
    expect(message.to).toEqual([{ email: 'ada@example.test' }])
    expect(message.text).toContain('482913')
    expect(message.html).toContain('482913')
    for (const part of [message.text, message.html ?? '', message.subject]) {
      expect(part).not.toMatch(/https?:|www\.|<a[\s>]|href|\/\//i)
    }
    expect(message.subject).not.toContain('482913')
  })

  it('[security] escapes the organisation name in the markup', async () => {
    const message = await composed()
    expect(message.html).toContain('Halcyon &lt;Studio&gt;')
    expect(message.html).not.toContain('<Studio>')
  })

  it('[api] states the life of the code', async () => {
    expect((await composed()).text).toContain('expires in 5 minutes')
  })
})

interface ServiceState {
  email: boolean
  verified: boolean
}

const settingsService = (state: ServiceState): TwoFactorService & Record<string, ReturnType<typeof vi.fn>> => {
  const service = {
    status: vi.fn(async () => ({
      enrolled: false,
      emailEnabled: state.email,
      pendingConfirmation: false,
      recoveryCodesRemaining: 0,
    })),
    beginEnrolment: vi.fn(),
    confirmEnrolment: vi.fn(),
    disable: vi.fn(),
    enableEmailFactor: vi.fn(async () => {
      if (!state.verified) return 'no_verified_email' as const
      if (state.email) return 'already_enabled' as const
      state.email = true
      return 'enabled' as const
    }),
    disableEmailFactor: vi.fn(async () => {
      const was = state.email
      state.email = false
      return was
    }),
    isEnrolled: vi.fn(async () => false),
    issueChallenge: vi.fn(async () => ({ token: CHALLENGE, expiresAt: EXPIRES })),
    redeemChallenge: vi.fn(),
  }
  return service as never
}

const sessionResolver = {
  resolve: async (request: Request) => {
    const cookie = request.headers.get('cookie')
    if (cookie === 'session=admin' || cookie === 'session=member') {
      return {
        type: 'user' as const,
        userId: cookie === 'session=admin' ? 42 : 43,
        profile: cookie === 'session=admin' ? ('administrator' as const) : ('member' as const),
        authentication: { kind: 'session' as const, sessionId: `${cookie}-id` },
      }
    }
    return null
  },
}

const bearer = 'ezacto_abcdefghijklmnop_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi1234567'
const tokens = {
  authenticate: async (token: string) =>
    token === bearer
      ? { tokenId: 1, userId: 42, profile: 'administrator' as const, scopes: ['reports:read'] }
      : null,
  issue: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
}

const settingsApp = (
  state: ServiceState,
  {
    emailCodes = true,
    activity,
  }: { emailCodes?: boolean; activity?: { capture: ReturnType<typeof vi.fn> } } = {},
) => {
  const service = settingsService(state)
  const app = createApiApp({
    authentication: {
      tokens,
      sessions: sessionResolver,
      twoFactor: service,
      twoFactorEmailCodes: emailCodes,
      ...(activity === undefined ? {} : { activity: activity as never }),
    },
  })
  return { app, service }
}

const activityRecorder = () => ({
  capture: vi.fn<(event: unknown) => Promise<void>>(async () => undefined),
})

const call = (
  app: ReturnType<typeof createApiApp>,
  method: string,
  path: string,
  cookie = 'session=admin',
) =>
  app.request(path, {
    method,
    headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' },
  })

describe('turning the emailed factor on and off', () => {
  it('[api] turns on with a verified address, and the status says so', async () => {
    const { app } = settingsApp({ email: false, verified: true })
    const response = await call(app, 'POST', '/api/v1/two-factor/email')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ data: { email_enabled: true, enrolled: false } })
  })

  it('[security] needs a verified email address', async () => {
    const { app, service } = settingsApp({ email: false, verified: false })
    const response = await call(app, 'POST', '/api/v1/two-factor/email')
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'verified_email_required' } })
    expect(service.enableEmailFactor).toHaveBeenCalledWith(42)
  })

  it('[security] is refused where no mail can be sent, before the service is asked', async () => {
    const { app, service } = settingsApp({ email: false, verified: true }, { emailCodes: false })
    const response = await call(app, 'POST', '/api/v1/two-factor/email')
    expect(response.status).toBe(503)
    expect(service.enableEmailFactor).not.toHaveBeenCalled()
  })

  it('[security] is session-only: an API token cannot change how its owner signs in', async () => {
    const { app, service } = settingsApp({ email: true, verified: true })
    for (const method of ['POST', 'DELETE']) {
      const response = await app.request('/api/v1/two-factor/email', {
        method,
        headers: { authorization: `Bearer ${bearer}`, origin: 'http://localhost' },
      })
      expect(response.status, method).toBe(403)
    }
    const admin = await app.request('/api/v1/users/42/two-factor/email', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${bearer}`, origin: 'http://localhost' },
    })
    expect(admin.status).toBe(403)
    expect(service.enableEmailFactor).not.toHaveBeenCalled()
    expect(service.disableEmailFactor).not.toHaveBeenCalled()
  })

  it('[security] needs a session at all', async () => {
    const { app, service } = settingsApp({ email: true, verified: true })
    const response = await app.request('/api/v1/two-factor/email', {
      method: 'POST',
      headers: { origin: 'http://localhost' },
    })
    expect(response.status).toBe(401)
    expect(service.enableEmailFactor).not.toHaveBeenCalled()
  })

  it('[api] turns off, and says so plainly when it was not on', async () => {
    const { app } = settingsApp({ email: true, verified: true })
    const off = await call(app, 'DELETE', '/api/v1/two-factor/email')
    expect(off.status).toBe(200)
    expect(await off.json()).toMatchObject({ data: { email_enabled: false } })
    const again = await call(app, 'DELETE', '/api/v1/two-factor/email')
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: { code: 'two_factor_email_not_enabled' } })
  })

  it('[security] records turning it on and off, once each, against the user', async () => {
    const activity = activityRecorder()
    const { app } = settingsApp({ email: false, verified: true }, { activity })
    await call(app, 'POST', '/api/v1/two-factor/email')
    // Turning on what is already on records nothing.
    await call(app, 'POST', '/api/v1/two-factor/email')
    await call(app, 'DELETE', '/api/v1/two-factor/email')
    await call(app, 'DELETE', '/api/v1/two-factor/email')
    expect(activity.capture.mock.calls.map(([event]) => (event as { eventType: string }).eventType)).toEqual([
      'two_factor.email_enabled',
      'two_factor.email_disabled',
    ])
    expect(activity.capture.mock.calls[1]![0]).toMatchObject({
      subjectId: 42,
      actor: { type: 'user', id: 42 },
      detail: { by: 'self' },
    })
  })
})

describe('an administrator turning off a user\'s emailed factor', () => {
  it('[security] works for an administrator, and the audit names whose factor and who did it', async () => {
    const activity = activityRecorder()
    const { app, service } = settingsApp({ email: true, verified: true }, { activity })
    const response = await call(app, 'DELETE', '/api/v1/users/7/two-factor/email')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { user_id: 7, email_enabled: false } })
    expect(service.disableEmailFactor).toHaveBeenCalledWith(7)
    expect(activity.capture).toHaveBeenCalledTimes(1)
    expect(activity.capture.mock.calls[0]![0]).toMatchObject({
      eventType: 'two_factor.email_disabled',
      subjectId: 7,
      actor: { type: 'user', id: 42 },
      detail: { by: 'administrator' },
    })
  })

  it('[security] is refused for anyone who is not an administrator', async () => {
    const activity = activityRecorder()
    const { app, service } = settingsApp({ email: true, verified: true }, { activity })
    const response = await call(app, 'DELETE', '/api/v1/users/7/two-factor/email', 'session=member')
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'profile_forbidden' } })
    expect(service.disableEmailFactor).not.toHaveBeenCalled()
    expect(activity.capture).not.toHaveBeenCalled()
  })

  it('[security] a user without the factor is a 404 and records nothing', async () => {
    const activity = activityRecorder()
    const { app } = settingsApp({ email: false, verified: true }, { activity })
    const response = await call(app, 'DELETE', '/api/v1/users/7/two-factor/email')
    expect(response.status).toBe(404)
    expect(activity.capture).not.toHaveBeenCalled()
  })

  it('[api] rejects an id that is not a positive integer', async () => {
    const { app, service } = settingsApp({ email: true, verified: true })
    for (const id of ['0', '-1', 'abc', '1.5', '9007199254740993']) {
      const response = await call(app, 'DELETE', `/api/v1/users/${id}/two-factor/email`)
      expect(response.status, id).toBe(404)
    }
    expect(service.disableEmailFactor).not.toHaveBeenCalled()
  })

  it('[security] does not touch the sign-in challenge gate it shares an interface with', async () => {
    const { app, service } = settingsApp({ email: true, verified: true })
    await call(app, 'DELETE', '/api/v1/users/7/two-factor/email')
    expect(service.issueChallenge).not.toHaveBeenCalled()
    expect(service.redeemChallenge).not.toHaveBeenCalled()
  })
})
