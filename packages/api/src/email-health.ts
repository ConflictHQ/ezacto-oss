import type { Hono } from 'hono'
import type {
  EmailDeliveryStatus,
  EmailLogStore,
} from '@ezacto/mailer'
import { computeReputationSnapshot } from '@ezacto/mailer'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError } from './errors.js'

export interface EmailHealthReader {
  countByStatus(): Promise<Record<EmailDeliveryStatus, number>>
}

export const installEmailHealthRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  log: EmailHealthReader | EmailLogStore,
): void => {
  api.get('/email-health', async (context) => {
    const principal = requireSessionPrincipal(context)
    if (principal.profile !== 'administrator') {
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'Only administrators can view email health.',
      })
    }
    const counts = await log.countByStatus()
    const reputation = computeReputationSnapshot(counts)
    return context.json(
      {
        data: {
          reputation: {
            sent: reputation.sent,
            bounced: reputation.bounced,
            complained: reputation.complained,
            failed: reputation.failed,
            bounce_rate_ppm: reputation.bounceRatePpm,
            complaint_rate_ppm: reputation.complaintRatePpm,
          },
        },
        links: { self: '/api/v1/email-health' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })
}
