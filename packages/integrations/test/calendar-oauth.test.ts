import { expect, it, vi } from 'vitest'
import { CalendarAuthorizationError, CalendarConnectionError } from '@ezacto/core'
import {
  createCalendarOAuthClient,
  createCalendarOAuthSourceFactory,
} from '../src/calendar/oauth.js'

const scope = 'https://www.googleapis.com/auth/calendar.readonly'
const token = (extra = {}) =>
  Response.json({
    access_token: 'owned-access',
    refresh_token: 'owned-refresh',
    expires_in: 3600,
    token_type: 'Bearer',
    scope,
    ...extra,
  })
it('requests separate least-privilege consent with state, S256 and offline access', () => {
  const google = createCalendarOAuthClient('google', { clientId: 'owned', clientSecret: 'private' })
  const url = new URL(
    google.authorizationUrl({
      state: 'state',
      challenge: 'challenge',
      redirectUri: 'https://owned.example/callback',
    }),
  )
  expect(url.origin).toBe('https://accounts.google.com')
  expect(url.searchParams.get('scope')).toBe(scope)
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  expect(url.searchParams.get('access_type')).toBe('offline')
  expect(url.href).not.toContain('private')
  const microsoft = createCalendarOAuthClient('microsoft', {
    clientId: 'owned',
    clientSecret: 'private',
  })
  const ms = new URL(
    microsoft.authorizationUrl({
      state: 'state',
      challenge: 'challenge',
      redirectUri: 'https://owned.example/callback',
    }),
  )
  expect(ms.searchParams.get('scope')).toBe(
    'https://graph.microsoft.com/Calendars.Read offline_access',
  )
  expect(ms.searchParams.get('response_mode')).toBe('query')
})
it('exchanges only at the fixed token endpoint and carries PKCE without URL credentials', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(token())
  const client = createCalendarOAuthClient('google', {
    clientId: 'owned',
    clientSecret: 'private',
    fetch,
  })
  const grant = await client.exchange({
    code: 'owned-code',
    verifier: 'owned-verifier',
    redirectUri: 'https://owned.example/callback',
  })
  expect(grant.refreshToken).toBe('owned-refresh')
  expect(fetch.mock.calls[0]![0]).toBe('https://oauth2.googleapis.com/token')
  const init = fetch.mock.calls[0]![1]!
  expect(init.redirect).toBe('error')
  expect((init.body as URLSearchParams).get('code_verifier')).toBe('owned-verifier')
  expect((init.body as URLSearchParams).get('client_secret')).toBe('private')
})
it('persists one rotated grant before returning any refreshed access token', async () => {
  const order: string[] = []
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
    order.push('refresh')
    return token({ refresh_token: 'rotated' })
  })
  const client = createCalendarOAuthClient('google', {
    clientId: 'owned',
    clientSecret: 'private',
    fetch,
  })
  let access: ((signal?: AbortSignal) => Promise<string>) | undefined
  const factory = createCalendarOAuthSourceFactory(client, (options) => {
    access = options.getAccessToken
    return {
      provider: 'google',
      listEvents: async () => ({ events: [], nextPage: null, nextCursor: null }),
    }
  })
  await factory({
    grant: { refreshToken: 'old', scopes: [scope] },
    rotateGrant: async (g) => {
      expect(g.refreshToken).toBe('rotated')
      order.push('persist')
    },
  })
  expect(await Promise.all([access!(), access!()])).toEqual(['owned-access', 'owned-access'])
  expect(order).toEqual(['refresh', 'persist'])
  expect(await access!()).toBe('owned-access')
  expect(fetch).toHaveBeenCalledOnce()
})
it('does not use a refreshed token if durable rotation is refused', async () => {
  const client = createCalendarOAuthClient('google', {
    clientId: 'owned',
    clientSecret: 'private',
    fetch: async () => token(),
  })
  let access: () => Promise<string> = async () => ''
  await createCalendarOAuthSourceFactory(client, (o) => {
    access = o.getAccessToken
    return {
      provider: 'google',
      listEvents: async () => ({ events: [], nextPage: null, nextCursor: null }),
    }
  })({
    grant: { refreshToken: 'old', scopes: [scope] },
    rotateGrant: async () => {
      throw new CalendarConnectionError('changed')
    },
  })
  await expect(access()).rejects.toMatchObject({ code: 'changed' })
})
it('refuses wider scopes, invalid grants, bad tenant paths and oversized responses safely', async () => {
  const make = (response: Response) =>
    createCalendarOAuthClient('google', {
      clientId: 'owned',
      clientSecret: 'private',
      fetch: async () => response,
    })
  const input = { code: 'owned', verifier: 'owned', redirectUri: 'https://owned.example/callback' }
  await expect(
    make(token({ scope: scope + ' https://www.googleapis.com/auth/calendar' })).exchange(input),
  ).rejects.toBeInstanceOf(CalendarAuthorizationError)
  await expect(
    make(
      Response.json(
        { error: 'invalid_grant', error_description: 'do-not-echo-private' },
        { status: 400 },
      ),
    ).exchange(input),
  ).rejects.toBeInstanceOf(CalendarAuthorizationError)
  await expect(make(new Response('x'.repeat(65537))).exchange(input)).rejects.toMatchObject({
    code: 'invalid',
  })
  expect(() =>
    createCalendarOAuthClient('microsoft', {
      clientId: 'owned',
      clientSecret: 'private',
      tenant: 'common/evil',
    }),
  ).toThrow()
})
it('revokes Google at its narrow endpoint but never widens Microsoft authority', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(''))
  const grant = { refreshToken: 'owned', scopes: [scope] }
  const google = createCalendarOAuthClient('google', {
    clientId: 'owned',
    clientSecret: 'private',
    fetch,
  })
  expect(await google.revoke(grant)).toBe('revoked')
  expect(fetch.mock.calls[0]![0]).toBe('https://oauth2.googleapis.com/revoke')
  fetch.mockClear()
  const ms = createCalendarOAuthClient('microsoft', {
    clientId: 'owned',
    clientSecret: 'private',
    fetch,
  })
  expect(await ms.revoke(grant)).toBe('manual_required')
  expect(fetch).not.toHaveBeenCalled()
})
