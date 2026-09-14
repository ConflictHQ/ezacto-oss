import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { errorResponse } from '../src/errors.js'
import {
  installWiseRoutes,
  type WiseRecipientView,
  type WiseService,
} from '../src/wise.js'

/**
 * Issue 543, on the app token.
 *
 * Where a contractor gets paid is the organisation's money leaving the
 * organisation's account, chosen against a list only the organisation's token
 * can see. So the rule these routes enforce is the opposite of the one the
 * abandoned OAuth flow needed: this is administrators and accounting, not
 * whoever is signed in.
 */

type Principal = { userId: number; profile: string } | null

const recipient: WiseRecipientView = {
  id: '701234567',
  holderName: 'R. Adeyemi',
  currency: 'USD',
  type: 'Aba',
  maskedSummary: 'ABA routing number ending in 9012',
  email: 'contractor@example.test',
}

const service = (overrides: Partial<WiseService> = {}): WiseService => ({
  configured: vi.fn(() => true),
  readStatus: vi.fn(async () => ({
    profileId: '22239672',
    profileName: 'Example Firm LLC',
    payableRecipients: 3,
    webhooksVerifiable: true,
  })),
  listRecipients: vi.fn(async () => [recipient]),
  linkRecipient: vi.fn(async () => ({ outcome: 'linked' as const, recipient })),
  onboardRecipient: vi.fn(async () => ({ outcome: 'linked' as const, recipient })),
  unlink: vi.fn(async () => true),
  ...overrides,
})

const app = (
  wise: WiseService,
  principal: Principal = { userId: 1, profile: 'administrator' },
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

const link = (wise: WiseService, body: unknown, principal?: Principal) =>
  app(wise, principal).request('/integrations/wise/recipients/link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('the connection (#543)', () => {
  it('[api] reports which profile pays and whether deliveries can be believed', async () => {
    const response = await app(service()).request('/integrations/wise')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        configured: true,
        connection: {
          profile_id: '22239672',
          profile_name: 'Example Firm LLC',
          payable_recipients: 3,
          // False here is a connection that can send money and cannot be told
          // what became of it.
          webhooks_verifiable: true,
        },
      },
    })
  })

  it('[api] says unconfigured without calling Wise at all', async () => {
    const wise = service({ configured: vi.fn(() => false) })
    const response = await app(wise).request('/integrations/wise')
    expect(await response.json()).toMatchObject({ data: { configured: false, connection: null } })
    expect(wise.readStatus).not.toHaveBeenCalled()
  })

  it('[api] is administrators and accounting, not everyone with a session', async () => {
    for (const profile of ['member', 'manager']) {
      const response = await app(service(), { userId: 2, profile }).request('/integrations/wise')
      expect(response.status, profile).toBe(403)
    }
    for (const profile of ['administrator', 'accounting', 'executive_manager']) {
      const response = await app(service(), { userId: 2, profile }).request('/integrations/wise')
      expect(response.status, profile).toBe(200)
    }
  })
})

describe('the recipients (#543)', () => {
  it('[security] never puts an account number on the wire', async () => {
    // Wise hands one over in a field called `accountSummary`. The masked form
    // is what a person needs to recognise an account they already know.
    const response = await app(service()).request('/integrations/wise/recipients')
    const body = await response.text()
    expect(body).toContain('ending in 9012')
    expect(body).not.toContain('accountSummary')
    expect(JSON.parse(body)).toEqual({
      data: [
        {
          id: '701234567',
          holder_name: 'R. Adeyemi',
          currency: 'USD',
          type: 'Aba',
          masked_summary: 'ABA routing number ending in 9012',
          email: 'contractor@example.test',
        },
      ],
    })
  })

  it('[api] refuses to list where the deployment has no token', async () => {
    const wise = service({ configured: vi.fn(() => false) })
    expect((await app(wise).request('/integrations/wise/recipients')).status).toBe(503)
    expect(wise.listRecipients).not.toHaveBeenCalled()
  })
})

describe('linking a person to a destination (#543)', () => {
  it('[money] records who did the linking, not just who is paid', async () => {
    const wise = service()
    const response = await link(wise, { user_id: 7, recipient_id: '701234567' })
    expect(response.status).toBe(201)
    expect(wise.linkRecipient).toHaveBeenCalledWith({
      userId: 7,
      recipientId: '701234567',
      // A payment destination that appeared with no author is one nobody can be
      // asked about.
      linkedByUserId: 1,
    })
  })

  it('[money] tells each refusal apart, because each is a different thing to do', async () => {
    const cases: [string, number][] = [
      ['unknown_recipient', 404],
      ['recipient_is_ours', 422],
      ['recipient_inactive', 422],
      ['already_linked', 409],
      ['recipient_taken', 409],
      ['unknown_user', 404],
    ]
    for (const [outcome, status] of cases) {
      const wise = service({ linkRecipient: vi.fn(async () => ({ outcome }) as never) })
      const response = await link(wise, { user_id: 7, recipient_id: 'r' })
      expect(response.status, outcome).toBe(status)
      // A 422 names the field at fault; the others carry the outcome as the
      // code. Either way a screen can say which of these six happened.
      const body = (await response.json()) as {
        error: { code: string; fields?: { code: string }[] }
      }
      expect(status === 422 ? body.error.fields?.[0]?.code : body.error.code, outcome).toBe(outcome)
    }
  })

  it('[api] names the field at fault rather than refusing flatly', async () => {
    const wise = service()
    expect((await link(wise, { recipient_id: 'r' })).status).toBe(422)
    expect((await link(wise, { user_id: 0, recipient_id: 'r' })).status).toBe(422)
    expect((await link(wise, { user_id: 7 })).status).toBe(422)
    expect((await link(wise, { user_id: 7, recipient_id: '   ' })).status).toBe(422)
    expect(wise.linkRecipient).not.toHaveBeenCalled()
  })

  it('[money] is not something a member can do for themselves', async () => {
    const wise = service()
    const response = await link(wise, { user_id: 2, recipient_id: 'r' }, { userId: 2, profile: 'member' })
    expect(response.status).toBe(403)
    expect(wise.linkRecipient).not.toHaveBeenCalled()
  })
})

describe('unlinking (#543)', () => {
  it('[api] detaches by account id, and says so when there was nothing there', async () => {
    const wise = service()
    expect(
      (await app(wise).request('/integrations/wise/recipients/5', { method: 'DELETE' })).status,
    ).toBe(204)
    expect(wise.unlink).toHaveBeenCalledWith(5)

    const missing = service({ unlink: vi.fn(async () => false) })
    expect(
      (await app(missing).request('/integrations/wise/recipients/5', { method: 'DELETE' })).status,
    ).toBe(404)
  })
})

describe('onboarding somebody we have never paid (#543)', () => {
  const onboard = (wise: WiseService, body: unknown, principal?: Principal) =>
    app(wise, principal).request('/integrations/wise/recipients', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const good = {
    user_id: 7,
    email: 'contractor@example.test',
    legal_name: 'R. Adeyemi',
    currency: 'USD',
  }

  it('[api] asks for an email address and hands back the destination Wise made', async () => {
    const wise = service()
    const response = await onboard(wise, good)
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      data: {
        user_id: 7,
        recipient: {
          id: '701234567',
          holder_name: 'R. Adeyemi',
          currency: 'USD',
          type: 'Aba',
          masked_summary: 'ABA routing number ending in 9012',
          email: 'contractor@example.test',
        },
      },
    })
    expect(wise.onboardRecipient).toHaveBeenCalledWith({
      userId: 7,
      email: 'contractor@example.test',
      legalName: 'R. Adeyemi',
      currency: 'USD',
      linkedByUserId: 1,
    })
  })

  it('[security] has nowhere to put an account number, which is the whole design', async () => {
    // Wise collects the bank details from the contractor directly. An account
    // number sent here is ignored rather than stored, because nothing reads it.
    const wise = service()
    await onboard(wise, { ...good, account_number: '123456789012' })
    const [call] = (wise.onboardRecipient as ReturnType<typeof vi.fn>).mock.calls
    expect(JSON.stringify(call)).not.toContain('123456789012')
  })

  it('[api] names every field that is wrong at once, and calls Wise for none of them', async () => {
    const wise = service()
    const response = await onboard(wise, {
      user_id: 0,
      email: 'not-an-address',
      legal_name: '  ',
      currency: 'dollars',
    })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { fields: { field: string }[] } }
    expect(body.error.fields.map((problem) => problem.field).sort()).toEqual([
      'currency',
      'email',
      'legal_name',
      'user_id',
    ])
    // Nothing reached Wise. A recipient created for a request we were going to
    // refuse anyway is a destination that outlives the mistake.
    expect(wise.onboardRecipient).not.toHaveBeenCalled()
  })

  it('[api] refuses a second destination for somebody who already has one', async () => {
    const wise = service({ onboardRecipient: vi.fn(async () => ({ outcome: 'already_linked' as const })) })
    const response = await onboard(wise, good)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'already_linked' } })
  })

  it('[money] names the recipient when Wise made one and the link did not take', async () => {
    // It exists at Wise by then and cannot be deleted from here. An operator
    // who is not told its id has a destination nobody knows about.
    const wise = service({
      onboardRecipient: vi.fn(async () => ({
        outcome: 'created_not_linked' as const,
        recipient,
        refusal: 'recipient_taken' as const,
      })),
    })
    const response = await onboard(wise, good)
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('created_not_linked')
    expect(body.error.message).toContain('701234567')
    expect(body.error.message).toContain('recipient_taken')
  })

  it('[api] is administrators and accounting, and refuses before it asks Wise anything', async () => {
    const wise = service()
    expect((await onboard(wise, good, { userId: 2, profile: 'member' })).status).toBe(403)
    const unconfigured = service({ configured: vi.fn(() => false) })
    expect((await onboard(unconfigured, good)).status).toBe(503)
    expect(wise.onboardRecipient).not.toHaveBeenCalled()
    expect(unconfigured.onboardRecipient).not.toHaveBeenCalled()
  })
})
