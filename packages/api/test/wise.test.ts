import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { errorResponse } from '../src/errors.js'
import {
  installWiseRoutes,
  type WiseConnectionStatus,
  type WiseService,
} from '../src/wise.js'

/**
 * Issue 543. A contractor connects their own Wise account, and the thing these
 * routes must never allow is somebody connecting it for them.
 */

type Principal = { userId: number; profile: string } | null

const connection: WiseConnectionStatus = {
  profileId: '41000001',
  profileType: 'personal',
  environment: 'sandbox',
  grantedAt: '2026-09-13T12:00:00.000Z',
  payable: true,
}

const service = (overrides: Partial<WiseService> = {}): WiseService => ({
  clientId: vi.fn(() => 'client-id'),
  callbackUrl: vi.fn(() => 'https://time.example.test/api/v1/integrations/wise/callback'),
  settingsUrl: vi.fn(() => '/settings/payouts'),
  authorizeUrl: vi.fn(
    ({ state }: { state: string }) => `https://sandbox.wise.com/oauth/authorize?state=${state}`,
  ),
  beginAuthorization: vi.fn(async () => undefined),
  completeAuthorization: vi.fn(async () => ({ outcome: 'connected', status: connection }) as const),
  readStatus: vi.fn(async () => connection),
  disconnect: vi.fn(async () => true),
  newState: vi.fn(() => 'state-value-0123456789'),
  ...overrides,
})

const app = (
  wise: WiseService,
  principal: Principal = { userId: 2, profile: 'member' },
) => {
  const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
  instance.use('*', async (context, next) => {
    if (principal !== null) {
      context.set('principal', {
        ...principal,
        type: 'user',
        authentication: { kind: 'session', sessionId: 'session-1' },
      })
    }
    await next()
  })
  instance.onError((error, context) => errorResponse(error, context as never))
  installWiseRoutes(instance as never, wise)
  return instance
}

describe('the connect button (#543)', () => {
  it('[api] hands back an authorize URL carrying the state it just issued', async () => {
    const wise = service()
    const response = await app(wise).request('/integrations/wise/authorize', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { authorize_url: 'https://sandbox.wise.com/oauth/authorize?state=state-value-0123456789' },
    })
    // The state is recorded before the person is sent anywhere, or the callback
    // it comes back with is one nothing issued.
    expect(wise.beginAuthorization).toHaveBeenCalledWith({
      state: 'state-value-0123456789',
      userId: 2,
      redirectUri: 'https://time.example.test/api/v1/integrations/wise/callback',
    })
  })

  it('[api] starts the authorization for the caller, never for somebody else', async () => {
    // The account being authorised is the person's own bank. An administrator
    // starting it on their behalf is the exact thing OAuth is here to prevent.
    const wise = service()
    await app(wise, { userId: 7, profile: 'administrator' }).request(
      '/integrations/wise/authorize',
      { method: 'POST' },
    )
    expect(wise.beginAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7 }),
    )
  })

  it('[api] says so where the deployment has no Wise keys, rather than sending an empty client id', async () => {
    const wise = service({ clientId: vi.fn(() => null) })
    const response = await app(wise).request('/integrations/wise/authorize', { method: 'POST' })
    expect(response.status).toBe(503)
    expect(wise.beginAuthorization).not.toHaveBeenCalled()
  })
})

describe('the status (#543)', () => {
  it('[api] reads the caller’s own connection, and says whether it can be paid', async () => {
    const wise = service()
    const response = await app(wise).request('/integrations/wise')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        configured: true,
        connection: {
          profile_id: '41000001',
          profile_type: 'personal',
          environment: 'sandbox',
          granted_at: '2026-09-13T12:00:00.000Z',
          payable: true,
        },
      },
    })
    expect(wise.readStatus).toHaveBeenCalledWith(2)
  })

  it('[api] is a handled state, not a 404, where nobody has connected', async () => {
    // "A person with neither a Deel nor a Wise connection is a visible, handled
    // state rather than a silent skip" -- the issue's fourth acceptance.
    const response = await app(service({ readStatus: vi.fn(async () => null) })).request(
      '/integrations/wise',
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: { connection: null } })
  })

  it('[api] reports an unconfigured deployment without refusing the read', async () => {
    const response = await app(
      service({ clientId: vi.fn(() => null), readStatus: vi.fn(async () => null) }),
    ).request('/integrations/wise')
    expect(await response.json()).toMatchObject({ data: { configured: false } })
  })
})

describe('where Wise sends the person back (#543)', () => {
  const callback = (wise: WiseService, query: string) =>
    app(wise, null).request(`/integrations/wise/callback${query}`)

  it('[api] completes the authorization and lands them on the settings page', async () => {
    const wise = service()
    const response = await callback(wise, '?state=state-value-0123456789&code=auth-code')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/settings/payouts?wise=connected')
    expect(wise.completeAuthorization).toHaveBeenCalledWith({
      state: 'state-value-0123456789',
      code: 'auth-code',
    })
  })

  it('[api] does not require a session, because the state is the authorization', async () => {
    // A person who authorised in a browser that did not carry their cookie is
    // not an attacker, and a state nobody issued is refused either way.
    const wise = service()
    const response = await callback(wise, '?state=s&code=c')
    expect(response.status).toBe(302)
    expect(wise.completeAuthorization).toHaveBeenCalled()
  })

  it('[api] carries the refusal through to the page, so it can say which one', async () => {
    for (const outcome of [
      'state_unknown',
      'state_expired',
      'already_connected',
      'profile_taken',
      'no_profile',
    ] as const) {
      const wise = service({ completeAuthorization: vi.fn(async () => ({ outcome })) })
      const response = await callback(wise, '?state=s&code=c')
      expect(response.headers.get('location')).toBe(`/settings/payouts?wise=${outcome}`)
    }
  })

  it('[api] treats a thrown exchange as a refusal, not a 500 in the person’s browser', async () => {
    const wise = service({
      completeAuthorization: vi.fn(async () => {
        throw new Error('Wise was unreachable')
      }),
    })
    const response = await callback(wise, '?state=s&code=c')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/settings/payouts?wise=exchange_failed')
  })

  it('[api] passes Wise’s own refusal back without acting on it', async () => {
    const wise = service()
    const response = await callback(wise, '?error=access_denied')
    expect(response.headers.get('location')).toBe('/settings/payouts?wise=access_denied')
    // The person pressed Cancel. There is nothing to exchange.
    expect(wise.completeAuthorization).not.toHaveBeenCalled()
  })

  it('[api] refuses a callback missing either half of the pair', async () => {
    const wise = service()
    expect((await callback(wise, '?state=s')).headers.get('location')).toBe(
      '/settings/payouts?wise=invalid_callback',
    )
    expect((await callback(wise, '?code=c')).headers.get('location')).toBe(
      '/settings/payouts?wise=invalid_callback',
    )
    expect(wise.completeAuthorization).not.toHaveBeenCalled()
  })
})

describe('disconnecting (#543)', () => {
  it('[api] revokes the caller’s own grant', async () => {
    const wise = service()
    const response = await app(wise).request('/integrations/wise', { method: 'DELETE' })
    expect(response.status).toBe(204)
    expect(wise.disconnect).toHaveBeenCalledWith(2)
  })

  it('[api] cannot reach anybody else’s', async () => {
    // There is no route that takes a user id. An administrator disconnecting a
    // contractor's own bank is not a thing this offers.
    const wise = service()
    await app(wise, { userId: 7, profile: 'administrator' }).request('/integrations/wise', {
      method: 'DELETE',
    })
    expect(wise.disconnect).toHaveBeenCalledWith(7)
  })

  it('[api] says so where there was nothing connected', async () => {
    const response = await app(service({ disconnect: vi.fn(async () => false) })).request(
      '/integrations/wise',
      { method: 'DELETE' },
    )
    expect(response.status).toBe(404)
  })
})
