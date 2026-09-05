import { describe, expect, it, vi } from 'vitest'
import {
  createApiApp,
  installGitHubRoutes,
  GITHUB_PROVIDER_KEY,
  type GitHubProviderConfig,
  type GitHubTransaction,
  type GitHubTransactionStorePort,
} from '../src/index.js'

const fixedNow = '2026-08-28T12:00:00.000Z'

const sha256Hex = async (value: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

class MemoryTransactions implements GitHubTransactionStorePort {
  private readonly rows = new Map<string, GitHubTransaction>()
  readonly created: Array<{ stateHash: string; provider: string }> = []
  consumeCalls = 0

  async create(input: {
    provider: string
    issuer: string
    clientId: string
    clientKeyHash: string
    stateHash: string
    codeVerifier: string
    nonce: string
    redirectUri: string
    expiresAt: string
    createdAt: string
    rateWindowStart: string
    cleanupBefore: string
  }): Promise<'created' | 'collision' | 'rate_limited'> {
    if (this.rows.has(input.stateHash)) return 'collision'
    this.created.push({ stateHash: input.stateHash, provider: input.provider })
    this.rows.set(input.stateHash, {
      id: this.rows.size + 1,
      provider: input.provider,
      issuer: input.issuer,
      clientId: input.clientId,
      codeVerifier: input.codeVerifier,
      nonce: input.nonce,
      redirectUri: input.redirectUri,
      expiresAt: input.expiresAt,
      consumedAt: null,
      createdAt: input.createdAt,
    })
    return 'created'
  }

  async consume(
    provider: string,
    stateHash: string,
    now: string,
  ): Promise<GitHubTransaction | null> {
    this.consumeCalls += 1
    const row = this.rows.get(stateHash)
    if (
      row === undefined ||
      row.provider !== provider ||
      row.consumedAt !== null ||
      Date.parse(row.expiresAt) <= Date.parse(now)
    ) {
      return null
    }
    const consumed = { ...row, consumedAt: now }
    this.rows.set(stateHash, consumed)
    return consumed
  }
}

interface FakeGitHub {
  config: GitHubProviderConfig
  calls: string[]
  tokenBodies: URLSearchParams[]
  setUser(user: { id: number; name: string | null; login: string }): void
  setEmails(emails: Array<{ email: string; verified: boolean; primary: boolean }>): void
  rejectToken(): void
}

const fakeGitHub = (): FakeGitHub => {
  const calls: string[] = []
  const tokenBodies: URLSearchParams[] = []
  let rejectTokenExchange = false
  let user: { id: number; name: string | null; login: string } = { id: 42, name: 'Avery Ng', login: 'averyng' }
  let emails = [
    { email: 'owner@example.test', verified: true, primary: true },
  ]

  const transport = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push(url)
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = new URLSearchParams(String(init.body))
      tokenBodies.push(body)
      if (rejectTokenExchange) {
        return Response.json({ error: 'bad_verification_code' })
      }
      return Response.json({
        access_token: 'ghu_test-github-access-token',
        token_type: 'bearer',
        scope: 'read:user,user:email',
      })
    }
    if (url === 'https://api.github.com/user') {
      const headers = new Headers(init.headers)
      if (!headers.get('authorization')?.startsWith('Bearer ')) {
        return Response.json({ message: 'unauthorized' }, { status: 401 })
      }
      return Response.json(user)
    }
    if (url === 'https://api.github.com/user/emails') {
      const headers = new Headers(init.headers)
      if (!headers.get('authorization')?.startsWith('Bearer ')) {
        return Response.json({ message: 'unauthorized' }, { status: 401 })
      }
      return Response.json(emails)
    }
    return new Response('not found', { status: 404 })
  }

  return {
    config: {
      clientId: 'gh-test-client',
      clientSecret: 'gh-test-secret',
      redirectOrigin: 'https://ezacto.io',
      fetch: transport,
    },
    calls,
    tokenBodies,
    setUser: (u) => { user = u },
    setEmails: (e) => { emails = e },
    rejectToken: () => { rejectTokenExchange = true },
  }
}

const harness = (github: FakeGitHub) => {
  const transactions = new MemoryTransactions()
  const identities = {
    resolveProvider: vi.fn(async () => ({
      status: 'active' as const,
      matchedBy: 'verified_email' as const,
      userId: 7,
      profile: 'administrator' as const,
      managerGrants: [] as string[],
    })),
  }
  const sessions = {
    issue: vi.fn(async () => ({
      setCookie:
        '__Host-ezacto_session=test-session; Path=/; HttpOnly; Secure; SameSite=Lax',
    })),
  }
  const app = createApiApp({
    installApp(app) {
      installGitHubRoutes(app, {
        transactions,
        identities,
        sessions,
        provider: () => github.config,
        clientKey: () => '198.51.100.8',
        now: () => fixedNow,
      })
    },
  })
  return { app, transactions, identities, sessions }
}

const start = async (
  app: ReturnType<typeof harness>['app'],
) => {
  const response = await app.request('https://ezacto.io/auth/github')
  expect(response.status).toBe(302)
  const authorization = new URL(response.headers.get('location')!)
  return {
    authorization,
    state: authorization.searchParams.get('state')!,
    cookie: response.headers.get('set-cookie')!.split(';', 1)[0]!,
  }
}

const GITHUB_STATE_COOKIE_NAME = '__Host-ezacto_github_state'

describe('GitHub OAuth2 browser authentication', () => {
  it('[api] completes PKCE, state, token exchange, user info, email verification, and session issuance', async () => {
    const github = fakeGitHub()
    const { app, transactions, identities, sessions } = harness(github)
    const pending = await start(app)

    expect(pending.authorization.origin).toBe('https://github.com')
    expect(pending.authorization.pathname).toBe('/login/oauth/authorize')
    expect(pending.authorization.searchParams.get('client_id')).toBe('gh-test-client')
    expect(pending.authorization.searchParams.get('redirect_uri')).toBe(
      'https://ezacto.io/auth/github/callback',
    )
    expect(pending.authorization.searchParams.get('scope')).toBe('read:user user:email')
    expect(pending.authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(pending.authorization.searchParams.get('code_challenge')).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    )
    expect(transactions.created[0]?.provider).toBe(GITHUB_PROVIDER_KEY)
    expect(transactions.created[0]?.stateHash).toBe(await sha256Hex(pending.state))

    const callback = await app.request(
      `https://ezacto.io/auth/github/callback?code=test-github-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(callback.status).toBe(303)
    expect(callback.headers.get('location')).toBe('/')
    expect(callback.headers.get('cache-control')).toBe('no-store')
    expect(callback.headers.get('referrer-policy')).toBe('no-referrer')
    expect(callback.headers.get('set-cookie')).toContain(`${GITHUB_STATE_COOKIE_NAME}=;`)
    expect(callback.headers.get('set-cookie')).toContain('__Host-ezacto_session=test-session')
    expect(github.calls).toContain('https://github.com/login/oauth/access_token')
    expect(github.calls).toContain('https://api.github.com/user')
    expect(github.calls).toContain('https://api.github.com/user/emails')
    expect(github.tokenBodies[0]?.get('client_id')).toBe('gh-test-client')
    expect(github.tokenBodies[0]?.get('client_secret')).toBe('gh-test-secret')
    expect(github.tokenBodies[0]?.get('redirect_uri')).toBe(
      'https://ezacto.io/auth/github/callback',
    )
    expect(github.tokenBodies[0]?.get('code_verifier')).toMatch(/^[A-Za-z0-9._~-]{43,128}$/)
    expect(identities.resolveProvider).toHaveBeenCalledWith({
      provider: 'github',
      subject: '42',
      email: 'owner@example.test',
      emailVerified: true,
      firstName: 'Avery',
      lastName: 'Ng',
    })
    expect(sessions.issue).toHaveBeenCalledWith(7)

    // Replay is rejected (transaction already consumed)
    const replay = await app.request(
      `https://ezacto.io/auth/github/callback?code=test-github-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(replay.status).toBe(401)
    expect(github.tokenBodies).toHaveLength(1)
  })

  it('[api] unverified GitHub email cannot link (fixture)', async () => {
    const github = fakeGitHub()
    github.setEmails([
      { email: 'unverified@example.test', verified: false, primary: true },
    ])
    const { app, identities, sessions } = harness(github)
    const pending = await start(app)
    const callback = await app.request(
      `https://ezacto.io/auth/github/callback?code=test-github-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(callback.status).toBe(401)
    expect(await callback.json()).toMatchObject({
      error: { code: 'github_email_not_verified' },
    })
    expect(identities.resolveProvider).not.toHaveBeenCalled()
    expect(sessions.issue).not.toHaveBeenCalled()
  })

  it('[api] subject key = GitHub id, stable across email changes', async () => {
    const github = fakeGitHub()
    github.setUser({ id: 99999, name: 'Pat Kim', login: 'patkim' })
    github.setEmails([
      { email: 'old@example.test', verified: true, primary: false },
      { email: 'new@example.test', verified: true, primary: true },
    ])
    const { app, identities } = harness(github)
    const pending = await start(app)
    const callback = await app.request(
      `https://ezacto.io/auth/github/callback?code=test-github-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(callback.status).toBe(303)
    expect(identities.resolveProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        subject: '99999',
        email: 'new@example.test',
        emailVerified: true,
      }),
    )
  })

  it('[api] selects the primary verified email when multiple emails exist', async () => {
    const github = fakeGitHub()
    github.setEmails([
      { email: 'secondary@example.test', verified: true, primary: false },
      { email: 'primary@example.test', verified: true, primary: true },
      { email: 'noreply@users.github.com', verified: true, primary: false },
    ])
    const { app, identities } = harness(github)
    const pending = await start(app)
    await app.request(
      `https://ezacto.io/auth/github/callback?code=test-github-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(identities.resolveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'primary@example.test' }),
    )
  })

  it('[api] falls back to first verified email when no primary is verified', async () => {
    const github = fakeGitHub()
    github.setEmails([
      { email: 'unverified@example.test', verified: false, primary: true },
      { email: 'verified@example.test', verified: true, primary: false },
    ])
    const { app, identities } = harness(github)
    const pending = await start(app)
    await app.request(
      `https://ezacto.io/auth/github/callback?code=test-github-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(identities.resolveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'verified@example.test', emailVerified: true }),
    )
  })

  it('[api] rejects when GitHub has no emails at all', async () => {
    const github = fakeGitHub()
    github.setEmails([])
    const { app, identities } = harness(github)
    const pending = await start(app)
    const callback = await app.request(
      `https://ezacto.io/auth/github/callback?code=test-github-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(callback.status).toBe(401)
    expect(await callback.json()).toMatchObject({
      error: { code: 'github_email_not_verified' },
    })
    expect(identities.resolveProvider).not.toHaveBeenCalled()
  })

  it('[api] splits a single-word GitHub name as firstName only', async () => {
    const github = fakeGitHub()
    github.setUser({ id: 42, name: 'Mononymous', login: 'mono' })
    const { app, identities } = harness(github)
    const pending = await start(app)
    await app.request(
      `https://ezacto.io/auth/github/callback?code=test-github-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(identities.resolveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Mononymous' }),
    )
    const call = (identities.resolveProvider.mock.calls as unknown[][])[0]![0]
    expect(call).not.toHaveProperty('lastName')
  })

  it('[api] handles a null GitHub name gracefully', async () => {
    const github = fakeGitHub()
    github.setUser({ id: 42, name: null, login: 'anon' })
    const { app, identities } = harness(github)
    const pending = await start(app)
    await app.request(
      `https://ezacto.io/auth/github/callback?code=test-github-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    const call = (identities.resolveProvider.mock.calls as unknown[][])[0]![0]
    expect(call).not.toHaveProperty('firstName')
    expect(call).not.toHaveProperty('lastName')
  })

  it('[security] rejects absent, duplicate, and mismatched browser state before token exchange', async () => {
    const github = fakeGitHub()
    const { app, transactions } = harness(github)
    const pending = await start(app)

    const noCookie = await app.request(
      `https://ezacto.io/auth/github/callback?code=test-github-code&state=${encodeURIComponent(pending.state)}`,
    )
    expect(noCookie.status).toBe(401)

    const mismatch = await app.request(
      'https://ezacto.io/auth/github/callback?code=test-github-code&state=attacker-state',
      { headers: { cookie: pending.cookie } },
    )
    expect(mismatch.status).toBe(401)

    const duplicate = await app.request(
      `https://ezacto.io/auth/github/callback?code=test-github-code&state=${encodeURIComponent(pending.state)}&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(duplicate.status).toBe(401)

    expect(transactions.consumeCalls).toBe(0)
    expect(github.tokenBodies).toHaveLength(0)
  })

  it('[security] rejects when token exchange fails', async () => {
    const github = fakeGitHub()
    github.rejectToken()
    const { app, identities, sessions } = harness(github)
    const pending = await start(app)
    const callback = await app.request(
      `https://ezacto.io/auth/github/callback?code=bad-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(callback.status).toBe(401)
    expect(identities.resolveProvider).not.toHaveBeenCalled()
    expect(sessions.issue).not.toHaveBeenCalled()
  })

  it('[security] surfaces the rate limit from the transaction store', async () => {
    const github = fakeGitHub()
    const { app, transactions } = harness(github)
    transactions.create = vi.fn(async (): Promise<'rate_limited'> => 'rate_limited')
    const response = await app.request('https://ezacto.io/auth/github')
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({
      error: { code: 'github_start_rate_limited' },
    })
    expect(github.calls).toHaveLength(0)
  })

  it('[api] returns 404 when no GitHub provider is configured', async () => {
    const transactions = new MemoryTransactions()
    const identities = { resolveProvider: vi.fn() }
    const sessions = { issue: vi.fn() }
    const app = createApiApp({
      installApp(app) {
        installGitHubRoutes(app, {
          transactions,
          identities,
          sessions,
          provider: () => null,
          clientKey: () => '198.51.100.8',
          now: () => fixedNow,
        })
      },
    })
    const response = await app.request('https://ezacto.io/auth/github')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: 'github_provider_not_found' },
    })
  })
})
