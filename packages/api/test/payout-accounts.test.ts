import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import {
  installPayoutAccountRoutes,
  type PayoutAccount,
  type PayoutAccountService,
} from '../src/payout-accounts.js'
import { errorResponse } from '../src/errors.js'

const linkedAt = '2026-09-11T12:00:00.000Z'

const account = (overrides: Partial<PayoutAccount> = {}): PayoutAccount => ({
  id: 9,
  userId: 2,
  provider: 'deel',
  externalId: 'deel-person-1',
  linkedByUserId: 1,
  linkedAt,
  verifiedAt: null,
  ...overrides,
})

const service = (overrides: Partial<PayoutAccountService> = {}): PayoutAccountService => ({
  listForUser: vi.fn(async () => [account()]),
  link: vi.fn(async () => ({ outcome: 'linked' as const, account: account() })),
  read: vi.fn(async () => account()),
  detach: vi.fn(async () => true),
  ...overrides,
})

const app = (
  payouts: PayoutAccountService,
  principal: { userId: number; profile: string } | null = {
    userId: 1,
    profile: 'administrator',
  },
) => {
  const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
  instance.use('*', async (context, next) => {
    if (principal !== null) {
      context.set('principal', {
        ...principal,
        authentication: { kind: 'session', sessionId: 'session-1' },
      })
    }
    await next()
  })
  instance.onError((error, context) => errorResponse(error, context as never))
  installPayoutAccountRoutes(instance as never, payouts)
  return instance
}

const linkRequest = (instance: ReturnType<typeof app>, id: string, body: unknown) =>
  instance.request(`/users/${id}/payout-accounts`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('reading a person’s payout accounts', () => {
  it('[api] lists what they are currently payable through', async () => {
    const response = await app(service()).request('/users/2/payout-accounts')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: [
        {
          id: 9,
          user_id: 2,
          provider: 'deel',
          external_id: 'deel-person-1',
          linked_by_user_id: 1,
          linked_at: linkedAt,
          verified_at: null,
        },
      ],
    })
  })

  it('[security] a person may read their own', async () => {
    const response = await app(service(), { userId: 2, profile: 'member' }).request(
      '/users/2/payout-accounts',
    )
    expect(response.status).toBe(200)
  })

  it('[security] but not somebody else’s', async () => {
    const response = await app(service(), { userId: 3, profile: 'member' }).request(
      '/users/2/payout-accounts',
    )
    expect(response.status).toBe(403)
  })
})

describe('linking an account', () => {
  it('[api] stores the identifier and names who attached it', async () => {
    const payouts = service()
    const response = await linkRequest(app(payouts), '2', {
      provider: 'deel',
      external_id: 'deel-person-1',
    })
    expect(response.status).toBe(201)
    expect(payouts.link).toHaveBeenCalledWith({
      userId: 2,
      provider: 'deel',
      externalId: 'deel-person-1',
      // The signed-in person, not the person being linked: an administrator
      // acting for somebody is recorded as the one who did it.
      linkedByUserId: 1,
    })
  })

  it('[security] a person may link their own account', async () => {
    // Route 1 from the issue, and the only one that cannot mismatch.
    const payouts = service()
    const response = await linkRequest(
      app(payouts, { userId: 2, profile: 'member' }),
      '2',
      { provider: 'wise', external_id: 'wise-1' },
    )
    expect(response.status).toBe(201)
    expect(payouts.link).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 2, linkedByUserId: 2 }),
    )
  })

  it('[security] nobody else may, however senior', async () => {
    // A project manager can edit a team member. Where that person is paid is a
    // different power, and this is the one worth keeping narrow.
    for (const profile of ['member', 'project_manager', 'people_admin', 'accounting']) {
      const payouts = service()
      const response = await linkRequest(app(payouts, { userId: 3, profile }), '2', {
        provider: 'deel',
        external_id: 'deel-person-1',
      })
      expect(response.status).toBe(403)
      expect(payouts.link).not.toHaveBeenCalled()
    }
  })

  it('[api] refuses a provider that is not one we pay through', async () => {
    const payouts = service()
    const response = await linkRequest(app(payouts), '2', {
      provider: 'paypal',
      external_id: 'x',
    })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { fields: { field: string }[] } }
    expect(body.error.fields[0]?.field).toBe('provider')
    expect(payouts.link).not.toHaveBeenCalled()
  })

  it('[api] refuses an empty identifier, naming the field', async () => {
    const response = await linkRequest(app(service()), '2', {
      provider: 'deel',
      external_id: '   ',
    })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { fields: { field: string }[] } }
    expect(body.error.fields[0]?.field).toBe('external_id')
  })

  it('[api] tells the two conflicts apart, because they are fixed differently', async () => {
    // "You already have one" is detach-then-relink. "Somebody else holds that
    // id" is a different conversation entirely.
    const already = await linkRequest(
      app(service({ link: vi.fn(async () => ({ outcome: 'already_linked' as const })) })),
      '2',
      { provider: 'deel', external_id: 'deel-person-1' },
    )
    expect(already.status).toBe(409)
    expect((await already.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'already_linked' },
    })

    const taken = await linkRequest(
      app(service({ link: vi.fn(async () => ({ outcome: 'external_id_taken' as const })) })),
      '2',
      { provider: 'deel', external_id: 'deel-person-1' },
    )
    expect(taken.status).toBe(409)
    expect((await taken.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'external_id_taken' },
    })
  })

  it('[api] answers 404 for a person who does not exist', async () => {
    const response = await linkRequest(
      app(service({ link: vi.fn(async () => ({ outcome: 'unknown_user' as const })) })),
      '999',
      { provider: 'deel', external_id: 'x' },
    )
    expect(response.status).toBe(404)
  })

  it('[api] refuses an id that is not a positive integer', async () => {
    for (const id of ['abc', '0', '-1']) {
      expect(
        (await linkRequest(app(service()), id, { provider: 'deel', external_id: 'x' })).status,
      ).toBe(422)
    }
  })
})

describe('detaching an account', () => {
  it('[api] detaches and answers no content', async () => {
    const payouts = service()
    const response = await app(payouts).request('/payout-accounts/9', { method: 'DELETE' })
    expect(response.status).toBe(204)
    expect(payouts.detach).toHaveBeenCalledWith(9)
  })

  it('[security] checks whose it is rather than trusting the path', async () => {
    // The id is the only thing in the URL, so without reading the account first
    // anybody could detach somebody else's by guessing a number.
    const payouts = service({ read: vi.fn(async () => account({ userId: 2 })) })
    const response = await app(payouts, { userId: 3, profile: 'member' }).request(
      '/payout-accounts/9',
      { method: 'DELETE' },
    )
    expect(response.status).toBe(403)
    expect(payouts.detach).not.toHaveBeenCalled()
  })

  it('[security] a person may detach their own', async () => {
    const payouts = service({ read: vi.fn(async () => account({ userId: 2 })) })
    const response = await app(payouts, { userId: 2, profile: 'member' }).request(
      '/payout-accounts/9',
      { method: 'DELETE' },
    )
    expect(response.status).toBe(204)
  })

  it('[api] answers 404 for an account that is not there', async () => {
    const response = await app(service({ read: vi.fn(async () => null) })).request(
      '/payout-accounts/9',
      { method: 'DELETE' },
    )
    expect(response.status).toBe(404)
  })

  it('[api] answers 404 for one that was already detached', async () => {
    const response = await app(service({ detach: vi.fn(async () => false) })).request(
      '/payout-accounts/9',
      { method: 'DELETE' },
    )
    expect(response.status).toBe(404)
  })
})
