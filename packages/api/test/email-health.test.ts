import { describe, expect, it } from 'vitest'
import type { EmailDeliveryStatus } from '@ezacto/mailer'
import { createApiApp, installEmailHealthRoutes } from '../src/index.js'

const counts = (
  overrides: Partial<Record<EmailDeliveryStatus, number>>,
): Record<EmailDeliveryStatus, number> => ({
  queued: 0,
  sent: 0,
  bounced: 0,
  complained: 0,
  failed: 0,
  ...overrides,
})

const harness = (profile: 'administrator' | 'member') =>
  createApiApp({
    authentication: {
      sessions: {
        resolve: async () => ({
          type: 'user' as const,
          userId: 1,
          profile,
          managerGrants: [],
          authentication: { kind: 'session' as const, sessionId: 'session-1' },
        }),
      },
    },
    installApi(api) {
      installEmailHealthRoutes(api, {
        countByStatus: async () => counts({ sent: 90, bounced: 10 }),
        countByStatusPerSender: async () => [
          { sender: 'billing@example.test', counts: counts({ sent: 40, bounced: 10 }) },
          { sender: 'support@example.test', counts: counts({ sent: 50 }) },
        ],
      })
    },
  })

describe('email health API', () => {
  it('[api] keeps the aggregate and adds rates per sender identity', async () => {
    const response = await harness('administrator').request('/api/v1/email-health')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Record<string, unknown> }
    expect(body.data.reputation).toEqual({
      sent: 100,
      bounced: 10,
      complained: 0,
      failed: 0,
      bounce_rate_ppm: 100_000,
      complaint_rate_ppm: 0,
    })
    expect(body.data.identities).toEqual([
      {
        sender: 'billing@example.test',
        sent: 50,
        bounced: 10,
        complained: 0,
        failed: 0,
        bounce_rate_ppm: 200_000,
        complaint_rate_ppm: 0,
      },
      {
        sender: 'support@example.test',
        sent: 50,
        bounced: 0,
        complained: 0,
        failed: 0,
        bounce_rate_ppm: 0,
        complaint_rate_ppm: 0,
      },
    ])
  })

  it('[api] stays administrator only', async () => {
    const response = await harness('member').request('/api/v1/email-health')
    expect(response.status).toBe(403)
  })
})
