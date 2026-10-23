import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { errorResponse } from '../src/errors.js'
import {
  installPayoutAccountRoutes,
  type PayoutAccount,
  type PayoutAccountService,
  type PayoutProviderEnablement,
} from '../src/payout-accounts.js'

const account = (overrides: Partial<PayoutAccount> = {}): PayoutAccount => ({
  id: 9,
  userId: 2,
  provider: 'deel',
  externalId: 'ana.personal@example.test',
  linkedByUserId: 1,
  linkedAt: '2026-10-22T12:00:00.000Z',
  verifiedAt: null,
  ...overrides,
})

const payouts = (overrides: Partial<PayoutAccountService> = {}): PayoutAccountService => ({
  listForUser: vi.fn(async () => []),
  link: vi.fn(async () => ({ outcome: 'linked' as const, account: account() })),
  read: vi.fn(async () => account()),
  detach: vi.fn(async () => true),
  ...overrides,
})

const enablement = (
  settings: Record<string, boolean> = { deel: true, wise: true },
): PayoutProviderEnablement & { setEnabled: ReturnType<typeof vi.fn> } => {
  const current = { ...settings }
  return {
    list: vi.fn(async () => Object.entries(current).map(([provider, enabled]) => ({ provider, enabled }))),
    setEnabled: vi.fn(async (provider: string, enabled: boolean) => {
      if (!(provider in current)) return false
      current[provider] = enabled
      return true
    }),
  }
}

const app = (
  service: PayoutAccountService,
  options: { enablement?: PayoutProviderEnablement },
  principal = { userId: 1, profile: 'administrator' },
) => {
  const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
  instance.use('*', async (context, next) => {
    context.set('principal', { type: 'user', ...principal, authentication: { kind: 'session', sessionId: 't' } } as never)
    context.set('requestId', 'r')
    await next()
  })
  instance.onError((error, context) => errorResponse(error, context))
  installPayoutAccountRoutes(instance as never, service, options)
  return instance
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const patch = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('payout providers: which are available', () => {
  it('[api] lists every provider and whether an administrator has enabled it', async () => {
    const response = await app(payouts(), { enablement: enablement({ deel: true, wise: false }) }).request('/payout-providers')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: [
        { provider: 'deel', enabled: true },
        { provider: 'wise', enabled: false },
      ],
    })
  })

  it('[api] lets only an administrator enable or disable a provider', async () => {
    const store = enablement()
    const member = app(payouts(), { enablement: store }, { userId: 3, profile: 'member' })
    expect((await member.request('/payout-providers/wise', patch({ enabled: false }))).status).toBe(403)
    expect(store.setEnabled).not.toHaveBeenCalled()

    const admin = app(payouts(), { enablement: store })
    expect((await admin.request('/payout-providers/wise', patch({ enabled: false }))).status).toBe(204)
    expect(store.setEnabled).toHaveBeenCalledWith('wise', false, 1, expect.any(String))
  })

  it('[api] refuses an unknown provider and a non-boolean switch', async () => {
    const store = enablement()
    const admin = app(payouts(), { enablement: store })
    expect((await admin.request('/payout-providers/bank', patch({ enabled: true }))).status).toBe(404)
    expect((await admin.request('/payout-providers/deel', patch({ enabled: 'yes' }))).status).toBe(422)
    expect(store.setEnabled).not.toHaveBeenCalled()
  })
})

describe('payout providers: linking', () => {
  it('[api] refuses to link a provider an administrator has disabled, and stores nothing', async () => {
    const service = payouts()
    const response = await app(service, { enablement: enablement({ deel: true, wise: false }) }).request(
      '/users/2/payout-accounts',
      post({ provider: 'wise', external_id: 'ana-wisetag' }),
    )
    expect(response.status).toBe(422)
    expect(service.link).not.toHaveBeenCalled()
  })

  it('[api] stores a Deel identifier as the lowercased email the person uses in Deel', async () => {
    const service = payouts()
    const response = await app(service, { enablement: enablement() }).request(
      '/users/2/payout-accounts',
      post({ provider: 'deel', external_id: '  Ana.Personal@Example.Test ' }),
    )
    expect(response.status).toBe(201)
    expect(service.link).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'deel', externalId: 'ana.personal@example.test' }),
    )
  })

  it('[api] refuses a Deel identifier that is not an email address', async () => {
    const service = payouts()
    const response = await app(service, { enablement: enablement() }).request(
      '/users/2/payout-accounts',
      post({ provider: 'deel', external_id: 'deel-person-1' }),
    )
    expect(response.status).toBe(422)
    expect(service.link).not.toHaveBeenCalled()
  })

  it('[api] keeps linking a second provider for a person who already has one', async () => {
    const service = payouts({ link: vi.fn(async () => ({ outcome: 'linked' as const, account: account({ provider: 'wise' }) })) })
    const response = await app(service, { enablement: enablement() }).request(
      '/users/2/payout-accounts',
      post({ provider: 'wise', external_id: 'ana-wisetag' }),
    )
    expect(response.status).toBe(201)
  })
})
