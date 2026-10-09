import { renderAppleDisconnect } from '../../../apps/web/src/shell/render.js'
import { describe, expect, it, vi } from 'vitest'
import { createApiApp } from '../src/app.js'
import { APPLE_WEB_STATE_COOKIE, installAppleWebRoutes } from '../src/apple-web.js'
import type { AppleAssertion, AppleIdentityResolver } from '../src/apple.js'
import type { OidcTransactionStorePort, OidcTransaction } from '../src/oidc.js'

const initialTime = Date.parse('2026-10-09T03:00:00.000Z')
const setup = (options: { demo?: boolean; origin?: string; configured?: boolean; lifecycle?: boolean; live?: boolean; rendered?: boolean } = {}) => {
  const origin = options.origin ?? 'https://app.example.com'
  const servicesId = 'com.ezacto.web'
  let time = initialTime
  const pending = new Map<string, OidcTransaction>()
  const transactions: OidcTransactionStorePort = {
    create: vi.fn(async (input) => {
      pending.set(input.stateHash, { ...input, id: 1, consumedAt: null })
      return 'created' as const
    }),
    consume: vi.fn(async (provider, stateHash) => {
      const value = pending.get(stateHash)
      if (value === undefined || value.provider !== provider) return null
      pending.delete(stateHash)
      return value
    }),
  }
  const assertion: AppleAssertion = { subject: 'apple-subject', email: 'member@example.test', emailVerified: true }
  const verify = vi.fn(async (token: string) => token === 'valid-token' ? assertion : null)
  const identities = { resolveProvider: vi.fn<AppleIdentityResolver['resolveProvider']>(async () => ({ status: 'active', matchedBy: 'subject', userId: 7, profile: 'member', managerGrants: [] })) }
  const sessions = { issue: vi.fn(async () => ({ setCookie: 'session=example; Path=/; Secure; HttpOnly; SameSite=Lax' })) }
  const connection = { setCookie: '__Host-ezacto_apple_connection=opaque; Path=/; Secure; HttpOnly; SameSite=Lax' }
  const grant = { subject: assertion.subject, bindUser: vi.fn<(userId: number) => Promise<typeof connection>>(async () => connection), bindBrowser: vi.fn(async () => connection) }
  const connected = vi.fn(async () => true)
  const recovery = vi.fn(async () => ({ requestId: null as string | null, required: false }))
  const disconnect = vi.fn(async () => ({ setCookie: '__Host-ezacto_apple_connection=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0' }))
  const challenge = vi.fn(async () => ({ challengeId: 'c'.repeat(43), nonce: 'n'.repeat(43), expiresAt: new Date(time + 5 * 60 * 1000).toISOString() }))
  const exchange = vi.fn(async () => grant)
  const app = createApiApp({ installApp(app) {
    installAppleWebRoutes(app, {
      transactions, identities, sessions,
      provider: () => options.configured === false ? null : { servicesId, redirectOrigin: origin },
      lifecycle: () => options.lifecycle === false ? null : { challenge, exchange, connected, recovery, disconnect },
      renderDisconnect: options.rendered ? renderAppleDisconnect : (input) => JSON.stringify(input),
      clientKey: () => '198.51.100.1', demoAccount: () => options.demo ? 9006 : null,
      policy: { isLive: async () => options.live !== false }, verifier: { verify }, now: () => new Date(time),
    })
  } })
  const start = async (intent?: 'disconnect') => {
    const response = await app.request(`${origin}/auth/apple/start${intent === undefined ? '' : '?intent=disconnect'}`)
    const authorization = new URL(response.headers.get('location')!)
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!
    return { response, authorization, state: authorization.searchParams.get('state')!, cookie }
  }
  const callback = (state: string, cookie: string, fields: Record<string, string> = {}) =>
    app.request(`${origin}/auth/apple/callback`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://appleid.apple.com', cookie },
      body: new URLSearchParams({ state, code: 'authorization-code', id_token: 'valid-token', ...fields }),
    })
  return { app, origin, servicesId, start, callback, transactions, identities, sessions, challenge, exchange, grant, verify, assertion, connected, recovery, disconnect,
    advance: (milliseconds: number) => { time += milliseconds } }
}

describe('Apple web authorization', () => {
  it.each(['https://ezacto.io', 'https://app.example.com'])('uses exact callback and browser-bound POST state on %s', async (origin) => {
    const h = setup({ origin })
    const { response, authorization, state } = await h.start()
    expect(response.status).toBe(302)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(authorization.origin).toBe('https://appleid.apple.com')
    expect(authorization.searchParams.get('redirect_uri')).toBe(`${origin}/auth/apple/callback`)
    expect(authorization.searchParams.get('client_id')).toBe(h.servicesId)
    expect(authorization.searchParams.get('response_mode')).toBe('form_post')
    expect(authorization.searchParams.get('response_type')).toBe('code id_token')
    expect(authorization.searchParams.get('nonce')).toBe('n'.repeat(43))
    expect(response.headers.get('set-cookie')).toBe(`${APPLE_WEB_STATE_COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=300`)
  })

  it.each(['created', 'verified_email'] as const)('records first-link web provenance only for a new Apple identity: %s', async matchedBy => {
    const h = setup()
    h.identities.resolveProvider.mockResolvedValue({ status: 'active', matchedBy, userId: 7, profile: 'member', managerGrants: [] })
    const { state, cookie } = await h.start()
    expect((await h.callback(state, cookie)).status).toBe(303)
    expect(h.grant.bindUser).toHaveBeenCalledWith(7, { knownFromFirstLink: true })
  })

  it('binds durable web custody before issuing the team session', async () => {
    const h = setup()
    const { state, cookie, authorization } = await h.start()
    const response = await h.callback(state, cookie, { user: JSON.stringify({ name: { firstName: 'Test', lastName: 'Member' }, email: 'untrusted@example.test' }) })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/')
    expect(h.verify).toHaveBeenCalledWith('valid-token', { nonce: authorization.searchParams.get('nonce') })
    expect(h.exchange).toHaveBeenCalledWith(expect.objectContaining({ servicesId: h.servicesId, redirectUri: `${h.origin}/auth/apple/callback`, nonce: authorization.searchParams.get('nonce') }))
    expect(h.identities.resolveProvider).toHaveBeenCalledWith(expect.objectContaining({ email: 'member@example.test', firstName: 'Test', lastName: 'Member' }))
    expect(h.grant.bindUser).toHaveBeenCalledWith(7, { knownFromFirstLink: false })
    expect(h.grant.bindUser.mock.invocationCallOrder[0]).toBeLessThan(h.sessions.issue.mock.invocationCallOrder[0]!)
    expect(h.disconnect).not.toHaveBeenCalled()
  })

  it('keeps recoverable demo custody before using the published member without resolving a real identity', async () => {
    const h = setup({ demo: true, origin: 'https://ezacto.io' })
    const { state, cookie } = await h.start()
    const response = await h.callback(state, cookie, { user: '{"name":{"firstName":"Private visitor"}}' })
    expect(response.headers.get('location')).toBe('/')
    expect(h.identities.resolveProvider).not.toHaveBeenCalled()
    expect(h.grant.bindUser).not.toHaveBeenCalled()
    expect(h.grant.bindBrowser).toHaveBeenCalledOnce()
    expect(h.disconnect).not.toHaveBeenCalled()
    expect(h.sessions.issue).toHaveBeenCalledWith(9006)
    expect(h.grant.bindBrowser.mock.invocationCallOrder[0]).toBeLessThan(h.sessions.issue.mock.invocationCallOrder[0]!)
  })

  it.each([{ configured: false }, { lifecycle: false }, { live: false }])('fails closed before creating a transaction when unavailable: %j', async (options) => {
    const h = setup(options)
    const response = await h.app.request(`${h.origin}/auth/apple/start`)
    expect(response.headers.get('location')).toBe('/?apple_sign_in=unavailable')
    expect(h.transactions.create).not.toHaveBeenCalled()
  })

  it.each(['missing', 'different', 'duplicate'])('rejects %s browser state before consuming the transaction', async (kind) => {
    const h = setup()
    const { state, cookie } = await h.start()
    const supplied = kind === 'missing' ? '' : kind === 'duplicate' ? `${cookie}; ${cookie}` : `${APPLE_WEB_STATE_COOKIE}=${'x'.repeat(43)}`
    const response = await h.callback(state, supplied)
    expect(response.headers.get('location')).toBe('/?apple_sign_in=invalid')
    expect(h.transactions.consume).not.toHaveBeenCalled()
    expect(h.exchange).not.toHaveBeenCalled()
  })

  it('rejects replay and expired transactions', async () => {
    const h = setup()
    const first = await h.start()
    await h.callback(first.state, first.cookie)
    expect((await h.callback(first.state, first.cookie)).headers.get('location')).toBe('/?apple_sign_in=invalid')
    const expired = await h.start()
    h.advance(5 * 60 * 1000)
    expect((await h.callback(expired.state, expired.cookie)).headers.get('location')).toBe('/?apple_sign_in=invalid')
    expect(h.exchange).toHaveBeenCalledOnce()
  })

  it('returns cancellation to the sign-in page after consuming valid state', async () => {
    const h = setup()
    const { state, cookie } = await h.start()
    const response = await h.app.request(`${h.origin}/auth/apple/callback`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ state, error: 'access_denied' }) })
    expect(response.headers.get('location')).toBe('/?apple_sign_in=cancelled')
    expect(h.transactions.consume).toHaveBeenCalledOnce()
    expect(h.exchange).not.toHaveBeenCalled()
  })

  it.each(['token', 'exchange', 'bind', 'browser custody', 'subject'])('issues no session after %s failure', async (failure) => {
    const h = setup({ demo: failure === 'browser custody' })
    if (failure === 'token') h.verify.mockResolvedValue(null)
    if (failure === 'exchange') h.exchange.mockRejectedValue(new Error('provider failed'))
    if (failure === 'bind') h.grant.bindUser.mockRejectedValue(new Error('custody failed'))
    if (failure === 'browser custody') h.grant.bindBrowser.mockRejectedValue(new Error('custody failed'))
    if (failure === 'subject') h.grant.subject = 'different-subject'
    const { state, cookie } = await h.start()
    const response = await h.callback(state, cookie)
    expect(response.headers.get('location')).toMatch(/^\/\?apple_sign_in=/)
    expect(h.sessions.issue).not.toHaveBeenCalled()
    if (failure === 'token' || failure === 'exchange' || failure === 'subject' || failure === 'browser custody') expect(h.identities.resolveProvider).not.toHaveBeenCalled()
  })

  it('rejects duplicate callback values and non-Apple cross-origin POSTs', async () => {
    const h = setup()
    const { state, cookie } = await h.start()
    for (const [origin, body] of [['https://attacker.example', `state=${state}&code=c&id_token=valid-token`], ['https://appleid.apple.com', `state=${state}&state=${state}&code=c&id_token=valid-token`]] as const) {
      const response = await h.app.request(`${h.origin}/auth/apple/callback`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: origin! }, body })
      expect(response.headers.get('location')).toBe('/?apple_sign_in=invalid')
    }
    expect(h.exchange).not.toHaveBeenCalled()
  })
  it('recovers a disconnect capability through a purpose-bound transaction without signing in', async () => {
    const h = setup({ demo: true, live: false })
    const { state, cookie } = await h.start('disconnect')
    const response = await h.callback(state, cookie)
    expect(response.headers.get('location')).toBe('/auth/apple/disconnect')
    expect(h.exchange).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'disconnect', demo: true }))
    expect(h.grant.bindBrowser).toHaveBeenCalledOnce()
    expect(h.grant.bindUser).not.toHaveBeenCalled()
    expect(h.identities.resolveProvider).not.toHaveBeenCalled()
    expect(h.sessions.issue).not.toHaveBeenCalled()
    expect(h.disconnect).not.toHaveBeenCalled()
  })

  it('keeps explicit disconnect available when sign-in is disabled', async () => {
    const h = setup({ live: false })
    const page = await h.app.request(`${h.origin}/auth/apple/disconnect`)
    expect(await page.json()).toEqual({ connected: true, unavailable: false })
    const response = await h.app.request(`${h.origin}/auth/apple/disconnect`, {
      method: 'POST', headers: { origin: h.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'confirm=disconnect',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ connected: false, unavailable: false, disconnected: true })
    expect(h.disconnect).toHaveBeenCalledOnce()
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(h.sessions.issue).not.toHaveBeenCalled()
  })

  it('renders request-bound recovery after stale custody fails despite a saved browser handle', async () => {
    const h = setup({ rendered: true })
    h.recovery.mockResolvedValue({ requestId: 'original_request', required: false })
    h.disconnect.mockRejectedValue(new Error('invalid_capability'))
    const failed = await h.app.request(`${h.origin}/auth/apple/disconnect`, { method: 'POST', headers: { origin: h.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=disconnect' })
    const page = await h.app.request(h.origin + failed.headers.get('location'))
    const html = await page.text()
    expect(html).toContain('href="/auth/apple/start?intent=disconnect&amp;cleanup_request=original_request"')
    expect(html).toContain('name="cleanup_request" value="original_request"')
    expect(html).toContain('The saved Apple connection could not complete disconnection.')
    expect(html).not.toContain('Your Apple authorization has been disconnected.')
    const recoveryUrl = html.match(/href="(\/auth\/apple\/start[^"]+)"/)![1]!.replaceAll('&amp;', '&')
    expect((await h.app.request(h.origin + recoveryUrl)).status).toBe(302)
    expect(h.challenge).toHaveBeenLastCalledWith(expect.objectContaining({ purpose: 'disconnect', requestId: 'original_request' }))
    h.recovery.mockResolvedValue({ requestId: 'original_request', required: true })
    expect(await (await h.app.request(`${h.origin}/auth/apple/disconnect`)).text()).toContain('cleanup_request=original_request')
  })

  it.each([
    { origin: 'https://attacker.example', body: 'confirm=disconnect' },
    { origin: '', body: 'confirm=disconnect' },
    { origin: 'https://app.example.com', body: '' },
    { origin: 'https://app.example.com', body: 'confirm=disconnect&confirm=disconnect' },
    { origin: 'https://app.example.com', body: 'confirm=disconnect&extra=value' },
  ])('rejects disconnect without exact origin and explicit acknowledgement: %j', async ({ origin, body }) => {
    const h = setup()
    const response = await h.app.request(`${h.origin}/auth/apple/disconnect`, {
      method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body,
    })
    expect(response.headers.get('location')).toBe('/auth/apple/disconnect?failed=1')
    expect(h.disconnect).not.toHaveBeenCalled()
  })

  it('requires capability recovery rather than accepting the shared demo session', async () => {
    const h = setup({ demo: true })
    h.connected.mockResolvedValue(false)
    const response = await h.app.request(`${h.origin}/auth/apple/disconnect`, {
      method: 'POST', headers: { origin: h.origin, 'content-type': 'application/x-www-form-urlencoded', cookie: 'session=shared-demo' },
      body: 'confirm=disconnect',
    })
    expect(response.headers.get('location')).toBe('/auth/apple/disconnect')
    expect(h.disconnect).not.toHaveBeenCalled()
  })

  it('does not report disconnection when revocation fails or is merely queued', async () => {
    const h = setup()
    h.disconnect.mockRejectedValue(new Error('queued'))
    const response = await h.app.request(`${h.origin}/auth/apple/disconnect`, {
      method: 'POST', headers: { origin: h.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=disconnect',
    })
    expect(response.headers.get('location')).toBe('/auth/apple/disconnect?failed=1')
    expect(response.headers.get('set-cookie')).toBeNull()
  })

})
