import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { errorResponse } from '../src/errors.js'
import { installWiseRoutes, type WiseService } from '../src/wise.js'

/** Issue 1237: a read-only connection serves reads and refuses every write. */

const recipient = {
  id: '701234567',
  holderName: 'R. Adeyemi',
  currency: 'USD',
  type: 'Aba',
  maskedSummary: 'ABA routing number ending in 9012',
  email: 'contractor@example.test',
}

const service = (writable: boolean): WiseService => ({
  configured: vi.fn(() => true),
  writable: vi.fn(() => writable),
  readStatus: vi.fn(async () => ({
    profileId: '22239672',
    profileName: 'Example Firm LLC',
    payableRecipients: 1,
    webhooksVerifiable: false,
  })),
  listRecipients: vi.fn(async () => [recipient]),
  linkRecipient: vi.fn(async () => ({ outcome: 'linked' as const, recipient })),
  onboardRecipient: vi.fn(async () => ({ outcome: 'linked' as const, recipient })),
  shareWiseProfile: vi.fn(async () => ({
    outcome: 'linked' as const,
    contact: { id: '00000000-0000-4000-8000-000000000001', name: 'R. Adeyemi' },
  })),
  proposeDestinations: vi.fn(async () => []),
  readDestination: vi.fn(async () => null),
  detachFor: vi.fn(async () => true),
  unlink: vi.fn(async () => true),
})

const app = (wise: WiseService) => {
  const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
  instance.use('*', async (context, next) => {
    context.set('principal', {
      userId: 1,
      profile: 'administrator',
      type: 'user',
      authentication: { kind: 'session', sessionId: 'session-1' },
    })
    await next()
  })
  instance.onError((error, context) => errorResponse(error, context as never))
  installWiseRoutes(instance as never, wise)
  return instance
}

const send = (wise: WiseService, method: string, path: string, body?: unknown) =>
  app(wise).request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

describe('read-only Wise connection (issue 1237)', () => {
  it('[api] still serves status, recipients and proposals', async () => {
    const wise = service(false)
    for (const path of ['/integrations/wise', '/integrations/wise/recipients', '/integrations/wise/proposals']) {
      expect((await send(wise, 'GET', path)).status).toBe(200)
    }
  })

  it('[money] refuses each destination write with capability_disabled and never calls the service', async () => {
    const wise = service(false)
    const attempts = [
      send(wise, 'POST', '/integrations/wise/recipients/link', { user_id: 8, recipient_id: '701234567' }),
      send(wise, 'POST', '/integrations/wise/recipients', {
        user_id: 8,
        email: 'a@example.test',
        legal_name: 'A Person',
        currency: 'USD',
      }),
      send(wise, 'POST', '/integrations/wise/contacts', { user_id: 8, identifier: '@person', currency: 'USD' }),
      send(wise, 'DELETE', '/integrations/wise/destinations/8'),
      send(wise, 'DELETE', '/integrations/wise/recipients/5'),
    ]
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(403)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('capability_disabled')
    }
    expect(wise.linkRecipient).not.toHaveBeenCalled()
    expect(wise.onboardRecipient).not.toHaveBeenCalled()
    expect(wise.shareWiseProfile).not.toHaveBeenCalled()
    expect(wise.detachFor).not.toHaveBeenCalled()
    expect(wise.unlink).not.toHaveBeenCalled()
  })

  it('[api] a writable connection is unchanged', async () => {
    const wise = service(true)
    const response = await send(wise, 'DELETE', '/integrations/wise/recipients/5')
    expect(response.status).toBe(204)
  })
})
