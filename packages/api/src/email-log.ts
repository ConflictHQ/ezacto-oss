import type { Hono } from 'hono'
import {
  EMAIL_LOG_KINDS,
  type EmailDeliveryStatus,
  type EmailLogFilter,
  type EmailLogPager,
  type EmailLogRecord,
} from '@ezacto/mailer'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'
import {
  dayRange,
  logOrder,
  logOrderFor,
  singleChoice,
  singleQuery,
  withTotal,
} from './log-paging.js'
import { keysetCursorPage } from './pagination.js'

/** What the email log route reads: keyset pages, and a count of what matches. */
export type EmailLogReader = EmailLogPager

export interface EmailLogRouteOptions {
  /** Signs the page cursors. */
  cursorSigningKey: Uint8Array
  /** The organization's timezone, which decides where a calendar day begins. */
  timezone(): Promise<string>
  /**
   * When the invoice emails among these were first opened from their link
   * (issue 936), by invoice message id. Absent where a deployment issues no
   * links, in which case no row has been opened.
   */
  viewReceipts?(invoiceMessageIds: readonly number[]): Promise<ReadonlyMap<number, string>>
}

const statuses = new Set<EmailDeliveryStatus>([
  'queued',
  'sent',
  'bounced',
  'complained',
  'failed',
])

const emailLogData = (record: EmailLogRecord, viewedAt: string | null) => ({
  id: record.id,
  from: record.from === null ? null : { ...record.from },
  reply_to: record.replyTo.map((recipient) => ({ ...recipient })),
  to: record.to.map((recipient) => ({ ...recipient })),
  cc: record.cc.map((recipient) => ({ ...recipient })),
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
  viewed_at: viewedAt,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
})

export const installEmailLogRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  log: EmailLogReader,
  options: EmailLogRouteOptions,
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
    const requestUrl = new URL(context.req.url)
    const status = singleChoice(requestUrl, 'status', [...statuses])
    const kind = singleChoice(requestUrl, 'kind', EMAIL_LOG_KINDS)
    const recipient = singleQuery(requestUrl, 'q')?.trim()
    if (recipient !== undefined && [...recipient].length > 200) {
      throw validationError([
        { field: 'q', code: 'invalid', message: 'q must be at most 200 characters' },
      ])
    }
    const days =
      requestUrl.searchParams.has('from') || requestUrl.searchParams.has('to')
        ? dayRange(requestUrl, await options.timezone())
        : {}
    const filter: EmailLogFilter = {
      ...(status === undefined ? {} : { status }),
      ...(kind === undefined ? {} : { kind }),
      ...days,
      ...(recipient === undefined || recipient === '' ? {} : { recipient }),
    }
    const order = logOrder(requestUrl)
    type Row = {
      id: number
      created_at: string
      record: EmailLogRecord
      viewed_at: string | null
    }
    const page = await keysetCursorPage({
      requestUrl,
      cursorSigningKey: options.cursorSigningKey,
      viewer: principal,
      serializer: (row: Readonly<Row>) => emailLogData(row.record, row.viewed_at),
      order: logOrderFor<Row>(order, ['number'], (row) => [row.created_at, row.id]),
      source: {
        snapshot: () => log.snapshot(),
        list: async (window) => {
          const records = await log.page({
            ...filter,
            order,
            after:
              window.after === null
                ? null
                : { createdAt: window.after[0], id: window.after[1] as number },
            createdThrough: window.createdThrough,
            take: window.take,
          })
          const opened =
            options.viewReceipts === undefined
              ? new Map<number, string>()
              : await options.viewReceipts(
                  records
                    .filter(
                      (record) => record.relatedType === 'invoice_message' && record.relatedId !== null,
                    )
                    .map((record) => record.relatedId!),
                )
          return records.map((record) => ({
            id: record.id,
            created_at: record.createdAt,
            record,
            viewed_at:
              record.relatedType === 'invoice_message' && record.relatedId !== null
                ? (opened.get(record.relatedId) ?? null)
                : null,
          }))
        },
      },
    })
    return context.json(withTotal(page, await log.count(filter)), 200, {
      'cache-control': 'no-store',
    })
  })
}
