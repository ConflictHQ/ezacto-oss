import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { StaffPaymentError } from '@ezacto/core'
import type { ApiContext } from '../src/context.js'
import { errorResponse } from '../src/errors.js'
import {
  installPayoutAccountRoutes,
  type PayoutAccount,
  type PayoutAccountService,
  type PayoutPreferenceService,
} from '../src/payout-accounts.js'

const account = (provider: 'deel' | 'wise' = 'deel'): PayoutAccount => ({
  id: 9,
  userId: 2,
  provider,
  externalId: 'ana@example.test',
  linkedByUserId: 1,
  linkedAt: '2026-10-22T12:00:00.000Z',
  verifiedAt: null,
})

const payouts = (accounts: PayoutAccount[] = [account()]): PayoutAccountService => ({
  listForUser: vi.fn(async () => accounts),
  link: vi.fn(async () => ({ outcome: 'linked' as const, account: account() })),
  read: vi.fn(async () => account()),
  detach: vi.fn(async () => true),
})

const preferences = (
  overrides: Partial<PayoutPreferenceService> & { current?: { provider: 'deel' | 'wise' | null; version: number } } = {},
): PayoutPreferenceService & { set: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> } => {
  const current = overrides.current ?? { provider: null, version: 0 }
  return {
    read: vi.fn(async (userId: number) => ({ userId, provider: current.provider, version: current.version, source: current.version === 0 ? null : 'person' as const })),
    orgDefault: vi.fn(async () => 'wise' as const),
    set: vi.fn(async () => {}),
    roster: vi.fn(async () => [{ userId: 2, name: 'Ana Personal', provider: 'deel' as const, version: 1, source: 'person' as const, linked: ['deel' as const] }]),
    ...overrides,
  } as never
}

const app = (
  service: PayoutAccountService,
  options: { preferences?: PayoutPreferenceService; enablement?: { list: () => Promise<{ provider: string; enabled: boolean }[]>; setEnabled: () => Promise<boolean> } },
  principal = { userId: 2, profile: 'member' },
) => {
  const instance = new Hono<ApiContext<object>>()
  instance.use('*', async (context, next) => {
    context.set('principal', { type: 'user', ...principal, authentication: { kind: 'session', sessionId: 't' } } as never)
    context.set('requestId', 'req-1')
    await next()
  })
  instance.onError((error, context) => errorResponse(error, context))
  installPayoutAccountRoutes(instance, service, { clock: () => '2026-10-22T09:00:00.000Z', ...options })
  return instance
}

const enabledAll = { list: async () => [{ provider: 'deel', enabled: true }, { provider: 'wise', enabled: true }], setEnabled: async () => true }
const patch = (body: unknown) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('payout defaults per person (issue 1152)', () => {
  it('[api] a person reads their own default, and the organization default applies until they choose', async () => {
    const response = await app(payouts(), { preferences: preferences(), enablement: enabledAll }).request('/users/2/payout-preference')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        user_id: 2,
        provider: null,
        effective_provider: 'wise',
        organization_default: 'wise',
        version: 0,
        set_by: null,
        linked_providers: ['deel'],
      },
    })
  })

  it('[api] another member cannot read or change someone else\'s default', async () => {
    const prefs = preferences()
    const member = app(payouts(), { preferences: prefs, enablement: enabledAll }, { userId: 3, profile: 'member' })
    expect((await member.request('/users/2/payout-preference')).status).toBe(403)
    expect((await member.request('/users/2/payout-preference', patch({ provider: 'deel', expected_version: 0 }))).status).toBe(403)
    expect(prefs.set).not.toHaveBeenCalled()
  })

  it('[api] a person chooses a provider they hold, recorded as their own choice', async () => {
    const prefs = preferences()
    const response = await app(payouts(), { preferences: prefs, enablement: enabledAll }).request('/users/2/payout-preference', patch({ provider: 'deel', expected_version: 0 }))
    expect(response.status).toBe(204)
    expect(prefs.set).toHaveBeenCalledWith(expect.objectContaining({ userId: 2, provider: 'deel', expectedVersion: 0, note: 'Chosen by the person.', actorId: 2, requestId: 'req-1' }))
  })

  it('[api] a person cannot choose a provider they do not hold', async () => {
    const prefs = preferences()
    const response = await app(payouts([account('deel')]), { preferences: prefs, enablement: enabledAll }).request('/users/2/payout-preference', patch({ provider: 'wise', expected_version: 0 }))
    expect(response.status).toBe(422)
    expect(prefs.set).not.toHaveBeenCalled()
  })

  it('[api] a provider the instance has turned off cannot be chosen', async () => {
    const prefs = preferences()
    const off = { list: async () => [{ provider: 'deel', enabled: false }, { provider: 'wise', enabled: true }], setEnabled: async () => true }
    const response = await app(payouts(), { preferences: prefs, enablement: off }).request('/users/2/payout-preference', patch({ provider: 'deel', expected_version: 0 }))
    expect(response.status).toBe(422)
    expect(prefs.set).not.toHaveBeenCalled()
  })

  it('[api] returning to the organization default is always allowed', async () => {
    const prefs = preferences({ current: { provider: 'deel', version: 1 } })
    const response = await app(payouts(), { preferences: prefs, enablement: enabledAll }).request('/users/2/payout-preference', patch({ provider: null, expected_version: 1 }))
    expect(response.status).toBe(204)
    expect(prefs.set).toHaveBeenCalledWith(expect.objectContaining({ provider: null, expectedVersion: 1 }))
  })

  it('[api] a stale version is a conflict, not a silent overwrite', async () => {
    const prefs = preferences({ set: vi.fn(async () => { throw new StaffPaymentError('conflict', 'changed') }) } as never)
    const response = await app(payouts(), { preferences: prefs, enablement: enabledAll }).request('/users/2/payout-preference', patch({ provider: 'deel', expected_version: 0 }))
    expect(response.status).toBe(409)
  })

  it('[api] an administrator may set it for someone, recorded as the administrator\'s', async () => {
    const prefs = preferences()
    const admin = app(payouts(), { preferences: prefs, enablement: enabledAll }, { userId: 1, profile: 'administrator' })
    const response = await admin.request('/users/2/payout-preference', patch({ provider: 'deel', expected_version: 0 }))
    expect(response.status).toBe(204)
    expect(prefs.set).toHaveBeenCalledWith(expect.objectContaining({ note: 'Set by an administrator.', actorId: 1 }))
  })

  it('[api] linking the first account sets the default to it, and a chosen default is left alone', async () => {
    const first = preferences({ current: { provider: null, version: 0 } })
    await app(payouts(), { preferences: first, enablement: enabledAll }).request('/users/2/payout-accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'deel', external_id: 'ana@example.test' }),
    })
    expect(first.set).toHaveBeenCalledWith(expect.objectContaining({ provider: 'deel', expectedVersion: 0, note: 'Set automatically when the first account was linked.' }))

    const chosen = preferences({ current: { provider: 'wise', version: 1 } })
    await app(payouts(), { preferences: chosen, enablement: enabledAll }).request('/users/2/payout-accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'deel', external_id: 'ana@example.test' }),
    })
    expect(chosen.set).not.toHaveBeenCalled()
  })

  it('[api] the roster is for administrators only, and carries the organization default', async () => {
    const prefs = preferences()
    expect((await app(payouts(), { preferences: prefs }).request('/payout-preferences')).status).toBe(403)
    const admin = app(payouts(), { preferences: prefs }, { userId: 1, profile: 'administrator' })
    const response = await admin.request('/payout-preferences')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        organization_default: 'wise',
        people: [{ user_id: 2, name: 'Ana Personal', provider: 'deel', version: 1, set_by: 'person', linked_providers: ['deel'] }],
      },
    })
  })
})
