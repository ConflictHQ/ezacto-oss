import type { WiseHosts } from '../src/wise/oauth.js'
import { describe, expect, it, vi } from 'vitest'
import {
  WiseOAuthError,
  exchangeWiseAuthorizationCode,
  fetchWiseProfiles,
  refreshWiseAccessToken,
  wiseApiBase,
  wiseAuthorizeUrl,
} from '../src/wise/oauth.js'

/**
 * Wise decommissioned the sandbox this was written against, so there is no
 * default any more and a test that wants one says where it is. Pointing these
 * at a real vendor host would make the suite depend on somebody else's uptime.
 */
const SANDBOX_HOSTS: WiseHosts = {
  api: 'https://api.wise.example.test',
  authorize: 'https://wise.example.test/oauth/authorize',
}

/**
 * Issue 543. A contractor authorises their own Wise account; payouts go to the
 * identifier Wise hands back, never to an address somebody matched on.
 *
 * Pinned to the wire shapes Wise actually publishes rather than a stub agreeing
 * with itself — the lesson from the four integration bugs that shipped because
 * the only test was a fake.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const tokenBody = {
  access_token: 'at-1',
  refresh_token: 'rt-1',
  token_type: 'bearer',
  expires_in: 43_200,
}

describe('sending somebody to Wise', () => {
  it('[security] refuses to build a URL without state', () => {
    // State is the whole authorisation: without it a third party can walk a
    // contractor through connecting their Wise account, and the payouts follow.
    expect(() =>
      wiseAuthorizeUrl({
        clientId: 'c',
        redirectUri: 'https://time.example.test/cb',
        state: '   ',
        environment: 'sandbox', hosts: SANDBOX_HOSTS,
      }),
    ).toThrow(WiseOAuthError)
  })

  it('[unit] points at the environment it was told, not a flag on a shared host', () => {
    const sandbox = wiseAuthorizeUrl({
      clientId: 'c',
      redirectUri: 'https://time.example.test/cb',
      state: 's',
      environment: 'sandbox', hosts: SANDBOX_HOSTS,
    })
    const live = wiseAuthorizeUrl({
      clientId: 'c',
      redirectUri: 'https://time.example.test/cb',
      state: 's',
      environment: 'live',
    })
    // Separate hosts, not a flag on a shared one: a live token against sandbox
    // is refused loudly where the reverse looks like a payout that went nowhere.
    expect(sandbox).toContain('wise.example.test')
    expect(sandbox).not.toContain('//wise.com')
    expect(live).toContain('wise.com')
    expect(live).not.toContain('sandbox')
    expect(new URL(sandbox).searchParams.get('state')).toBe('s')
    expect(new URL(sandbox).searchParams.get('response_type')).toBe('code')
  })

  it('[unit] knows where live is, and refuses to invent where sandbox is', () => {
    expect(wiseApiBase('live')).toBe('https://api.wise.com')
    expect(wiseApiBase('sandbox', SANDBOX_HOSTS)).toBe('https://api.wise.example.test')
    // This shipped pointing at api.sandbox.transferwise.tech, which Wise has
    // decommissioned -- it answers 410. A hard-coded host that no longer exists
    // is worse than none, because every call then fails as "Wise refused" and
    // reads like a credential problem rather than an address that is gone.
    expect(() => wiseApiBase('sandbox')).toThrow(/sandbox hosts are not configured/u)
  })
})

describe('exchanging the code', () => {
  it('[security] sends the secret as Basic auth, never in the body', async () => {
    // A secret in a form body ends up in whatever logged the request.
    const call = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => json(tokenBody),
    )
    await exchangeWiseAuthorizationCode({
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'https://time.example.test/cb',
      code: 'abc',
      environment: 'sandbox', hosts: SANDBOX_HOSTS,
      fetchImplementation: call as never,
      now: () => new Date('2026-09-13T00:00:00.000Z'),
    })
    const [, init] = call.mock.calls[0]!
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${btoa('id:secret')}`,
    )
    expect(String(init.body)).not.toContain('secret')
  })

  it('[money] returns an absolute expiry, not a duration', async () => {
    // A duration only means something beside the moment it was issued, and the
    // two get separated the first time a token is stored.
    const tokens = await exchangeWiseAuthorizationCode({
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'https://time.example.test/cb',
      code: 'abc',
      environment: 'sandbox', hosts: SANDBOX_HOSTS,
      fetchImplementation: (async () => json(tokenBody)) as never,
      now: () => new Date('2026-09-13T00:00:00.000Z'),
    })
    expect(tokens).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: '2026-09-13T12:00:00.000Z',
    })
  })

  it('[security] refuses a non-200 rather than parsing an error page', async () => {
    await expect(
      exchangeWiseAuthorizationCode({
        clientId: 'id',
        clientSecret: 'secret',
        redirectUri: 'https://time.example.test/cb',
        code: 'abc',
        environment: 'sandbox', hosts: SANDBOX_HOSTS,
        fetchImplementation: (async () => json({ error: 'invalid_grant' }, 400)) as never,
      }),
    ).rejects.toThrow(/refused the authorization code \(400\)/u)
  })

  it('[security] refuses a response missing a token rather than storing undefined', async () => {
    await expect(
      exchangeWiseAuthorizationCode({
        clientId: 'id',
        clientSecret: 'secret',
        redirectUri: 'https://time.example.test/cb',
        code: 'abc',
        environment: 'sandbox', hosts: SANDBOX_HOSTS,
        fetchImplementation: (async () => json({ access_token: 'at', expires_in: 60 })) as never,
      }),
    ).rejects.toThrow(/missing refresh_token/u)
  })
})

describe('refreshing', () => {
  it('[money] keeps the rotated refresh token, not the old one', async () => {
    // Wise rotates it. Keeping the old one works until it silently stops, which
    // is the worst moment to find out.
    const tokens = await refreshWiseAccessToken({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: 'rt-1',
      environment: 'live',
      fetchImplementation: (async () =>
        json({ ...tokenBody, access_token: 'at-2', refresh_token: 'rt-2' })) as never,
      now: () => new Date('2026-09-13T00:00:00.000Z'),
    })
    expect(tokens.refreshToken).toBe('rt-2')
    expect(tokens.accessToken).toBe('at-2')
  })
})

describe('who authorised', () => {
  it('[money] returns the identifier Wise gave, as a string', async () => {
    // The entire point: a payout resolves to the provider's own id. Wise sends
    // it as a number and it is stored as text, so it must not arrive as 1.23e8.
    const profiles = await fetchWiseProfiles({
      accessToken: 'at',
      environment: 'live',
      fetchImplementation: (async () =>
        json([
          { id: 123456789, type: 'personal', fullName: 'R. Adeyemi' },
          { id: 987654321, type: 'business', name: 'Kestrel Environmental' },
        ])) as never,
    })
    expect(profiles).toEqual([
      { id: '123456789', type: 'personal', fullName: 'R. Adeyemi' },
      { id: '987654321', type: 'business', fullName: 'Kestrel Environmental' },
    ])
  })

  it('[security] refuses a profile with no id rather than storing a blank', async () => {
    await expect(
      fetchWiseProfiles({
        accessToken: 'at',
        environment: 'live',
        fetchImplementation: (async () => json([{ type: 'personal' }])) as never,
      }),
    ).rejects.toThrow(/carried no id/u)
  })

  it('[security] refuses a non-array rather than silently finding nobody', async () => {
    await expect(
      fetchWiseProfiles({
        accessToken: 'at',
        environment: 'live',
        fetchImplementation: (async () => json({ profiles: [] })) as never,
      }),
    ).rejects.toThrow(/was not an array/u)
  })
})
