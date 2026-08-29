import type { Hono } from 'hono'
import type {
  EmailDeliveryStatus,
  EmailLogRecord,
  EmailLogStore,
} from '@ezacto/mailer'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'

export interface EmailLogReader {
  list(input?: {
    status?: EmailDeliveryStatus
    limit?: number
  }): Promise<EmailLogRecord[]>
}

const statuses = new Set<EmailDeliveryStatus>([
  'queued',
  'sent',
  'bounced',
  'complained',
  'failed',
])

const emailLogData = (record: EmailLogRecord) => ({
  id: record.id,
  to: record.to.map((recipient) => ({ ...recipient })),
  template: record.template,
  subject: record.subject,
  provider: record.provider,
  provider_message_id: record.providerMessageId,
  provider_request_id: record.providerRequestId,
  provider_latency_ms: record.providerLatencyMs,
  status: record.status,
  related_type: record.relatedType,
  related_id: record.relatedId,
  attempt_count: record.attemptCount,
  failure_code: record.failureCode,
  failure_reason: record.failureReason,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
})

export const installEmailLogRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  log: EmailLogReader | EmailLogStore,
): void => {
  api.get('/email-log', async (context) => {
    const principal = requireSessionPrincipal(context)
    if (principal.profile !== 'administrator') {
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'Only administrators can view outbound email delivery logs.',
      })
    }
    const presentedStatus = context.req.query('status')
    if (
      presentedStatus !== undefined &&
      !statuses.has(presentedStatus as EmailDeliveryStatus)
    ) {
      throw validationError([
        {
          field: 'status',
          code: 'unsupported',
          message: 'status is not a supported email delivery status',
        },
      ])
    }
    const presentedLimit = context.req.query('per_page')
    const limit = presentedLimit === undefined ? 100 : Number(presentedLimit)
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      (presentedLimit !== undefined && !/^[1-9][0-9]*$/.test(presentedLimit))
    ) {
      throw validationError([
        {
          field: 'per_page',
          code: 'invalid',
          message: 'per_page must be an integer between 1 and 200',
        },
      ])
    }
    const status = presentedStatus as EmailDeliveryStatus | undefined
    return context.json(
      {
        data: (
          await log.list({ ...(status === undefined ? {} : { status }), limit })
        ).map(emailLogData),
        links: { self: '/api/v1/email-log' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })
}
