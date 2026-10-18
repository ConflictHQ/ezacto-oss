import { dateInTimeZone, timeInTimeZone } from '@ezacto/core'
import { renderDataTable } from '../components/data-table.js'
import { focusSortHeader } from '../components/table-sort.js'
import {
  createPagedLog,
  type LogAddress,
  type LogPageResult,
  type PagedLog,
} from '../components/paged-log.js'
import { DEMO_MAIL_REFUSAL, DEMO_RECIPIENT_NOT_ALLOWED } from '../demo.js'

/**
 * What was sent, and what became of it (issue 485).
 *
 * Both endpoints shipped without a screen, which left "did that invoice reach
 * the client" answerable only with an API token and a terminal, and a failed
 * delivery invisible and unretryable from the product at all.
 *
 * Two tables, because they answer different questions and fail differently.
 * The email log is what the provider was asked to send and what it said back --
 * nothing here retries it, because a resend is a new message with new
 * consequences for whoever receives it, not a button on a log. The outbox is
 * our own delivery of an event to a subscriber, which is exactly the thing that
 * is safe to try again: the subscriber is ours, and the delivery ledger is what
 * stops a retry doing the work twice.
 */

/**
 * The statuses each side actually has, taken from the generated client rather
 * than guessed. The first draft of the filter offered three of the five email
 * ones, so a bounced message was unreachable through a control that looked
 * complete.
 */
export type EmailLogStatus = 'queued' | 'sent' | 'failed' | 'bounced' | 'complained'
export type EmailLogKind =
  | 'invoice'
  | 'invoice_preview'
  | 'reminder'
  | 'thank_you'
  | 'sign_in'
  | 'account'
export type OutboxStatus = 'pending' | 'processing' | 'delivered' | 'failed'

/** Matches the generated client rather than the field names in the document. */
export interface EmailRecipientRef {
  readonly email: string
  readonly name?: string
}

export interface EmailLogRow {
  readonly id: number
  /** A list, not a string: a message can be addressed to more than one person. */
  readonly to: readonly EmailRecipientRef[]
  /** Everyone copied: an invoice's Cc is part of who it reached. */
  readonly cc: readonly EmailRecipientRef[]
  readonly subject: string
  readonly template: string
  readonly status: EmailLogStatus
  readonly attempt_count: number
  readonly failure_code: string | null
  readonly failure_reason: string | null
  readonly created_at: string
}

export interface OutboxRow {
  readonly subscriber_id: string
  readonly event_id: string
  readonly event_type: string
  readonly status: OutboxStatus
  readonly attempt_count: number
  readonly last_error_code: string | null
  readonly occurred_at: string
  /** When the delivery was created, which is what the list is ordered and filtered by. */
  readonly created_at: string
}

/** What the screen asks of a log: a page, in an order, narrowed by filters. */
interface LogQuery {
  readonly per_page: number
  readonly order: 'newest' | 'oldest'
  readonly cursor?: string
  readonly from?: string
  readonly to?: string
}

export interface EmailLogQuery extends LogQuery {
  readonly status?: EmailLogStatus
  readonly kind?: EmailLogKind
  readonly q?: string
}

export interface OutboxQuery extends LogQuery {
  readonly status?: OutboxStatus
  readonly event_type?: string
}

export interface DeliveriesApi {
  listEmailLog(
    query: EmailLogQuery,
    signal?: AbortSignal,
  ): Promise<LogPageResult<EmailLogRow>>
  listOutboxDeliveries(
    query: OutboxQuery,
    signal?: AbortSignal,
  ): Promise<LogPageResult<OutboxRow>>
  retryOutboxDelivery(
    subscriberId: string,
    eventId: string,
    signal?: AbortSignal,
  ): Promise<unknown>
  /**
   * The organization's timezone, which is how a time in these logs is said and
   * where a calendar day in a filter begins. Null reads as UTC.
   */
  organizationTimezone?(signal?: AbortSignal): Promise<string | null>
}

export interface DeliveriesController {
  activate(signal: AbortSignal): Promise<void>
}

const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`deliveries element missing: ${selector}`)
  return element
}

/** Sentence case, without a lookup table to drift out of date. */
export const deliveryLabel = (value: string): string =>
  value.charAt(0).toLocaleUpperCase('en-US') + value.slice(1).replace(/[._]/gu, ' ')

/**
 * Why it failed, in the row rather than behind a click.
 *
 * The reason is the only part of a failure anybody can act on, and a table
 * showing the status alone makes every failure look the same.
 */
export const failureText = (code: string | null, reason: string | null): string => {
  // The demo's own refusal (issue 931). "provider_rejected" would blame a
  // provider nobody asked, and the sentence names no domain on purpose.
  if (reason === DEMO_RECIPIENT_NOT_ALLOWED) return DEMO_MAIL_REFUSAL
  if (code === null && reason === null) return ''
  if (code === null) return reason ?? ''
  return reason === null ? code : `${code}: ${reason}`
}

/** A calendar day in the filter: the address is typed by hand, and an odd value is not sent. */
const dayPattern = /^\d{4}-\d{2}-\d{2}$/u
const day = (value: string | undefined): string | undefined =>
  value !== undefined && dayPattern.test(value) ? value : undefined

const emailKinds: readonly EmailLogKind[] = [
  'invoice',
  'invoice_preview',
  'reminder',
  'thank_you',
  'sign_in',
  'account',
]
const emailStatuses: readonly EmailLogStatus[] = ['queued', 'sent', 'failed', 'bounced', 'complained']
const outboxStatuses: readonly OutboxStatus[] = ['pending', 'processing', 'delivered', 'failed']

/**
 * One of the values a select offers, or nothing. A hand-edited address can say
 * anything; the API would answer 422, and a screen that opens on an error for a
 * mistyped link is worse than one that ignores the part it does not know.
 */
const oneOf = <Choice extends string>(
  value: string | undefined,
  choices: readonly Choice[],
): Choice | undefined => choices.find((choice) => choice === value)

export const emailQuery = (address: LogAddress): EmailLogQuery => {
  const { status, kind, from, to, q } = address.filters
  const chosenStatus = oneOf(status, emailStatuses)
  const chosenKind = oneOf(kind, emailKinds)
  const chosenFrom = day(from)
  const chosenTo = day(to)
  return {
    per_page: address.perPage,
    order: address.order,
    ...(address.cursor === null ? {} : { cursor: address.cursor }),
    ...(chosenStatus === undefined ? {} : { status: chosenStatus }),
    ...(chosenKind === undefined ? {} : { kind: chosenKind }),
    ...(chosenFrom === undefined ? {} : { from: chosenFrom }),
    ...(chosenTo === undefined ? {} : { to: chosenTo }),
    ...(q === undefined ? {} : { q }),
  }
}

export const outboxQuery = (address: LogAddress): OutboxQuery => {
  const { status, type, from, to } = address.filters
  const chosenStatus = oneOf(status, outboxStatuses)
  const chosenFrom = day(from)
  const chosenTo = day(to)
  return {
    per_page: address.perPage,
    order: address.order,
    ...(address.cursor === null ? {} : { cursor: address.cursor }),
    ...(chosenStatus === undefined ? {} : { status: chosenStatus }),
    ...(type === undefined ? {} : { event_type: type }),
    ...(chosenFrom === undefined ? {} : { from: chosenFrom }),
    ...(chosenTo === undefined ? {} : { to: chosenTo }),
  }
}

export const createDeliveriesController = (api: DeliveriesApi): DeliveriesController => {
  const page = document.querySelector<HTMLElement>('[data-deliveries-page]')
  if (page === null) return { activate: async () => {} }
  const emailList = required<HTMLElement>('[data-email-log-list]')
  const emailStatus = required<HTMLElement>('[data-email-log-status]')
  const emailControls = required<HTMLElement>('[data-email-log-controls]')
  const outboxList = required<HTMLElement>('[data-outbox-list]')
  const outboxStatus = required<HTMLElement>('[data-outbox-status]')
  const outboxControls = required<HTMLElement>('[data-outbox-controls]')

  let active: AbortSignal | null = null
  // The organization's timezone, read once per visit. Until it is known, or
  // when it cannot be read, times are said in UTC and labelled so.
  let timeZone = 'UTC'

  /** `2026-09-13 03:00` as the organization sees it, not as the log stores it. */
  const when = (instant: string): string =>
    Number.isNaN(Date.parse(instant))
      ? instant
      : `${dateInTimeZone(instant, timeZone)} ${timeInTimeZone(instant, timeZone)}`
  const whenLabel = (): string => `When (${timeZone})`

  const retry = async (row: OutboxRow): Promise<void> => {
    const signal = active
    if (signal === null) return
    outboxStatus.textContent = `Retrying ${deliveryLabel(row.event_type)}…`
    try {
      await api.retryOutboxDelivery(row.subscriber_id, row.event_id, signal)
      if (signal.aborted) return
      await outbox.reload()
    } catch (error) {
      if (signal.aborted) return
      outboxStatus.textContent =
        error instanceof Error ? error.message : 'The delivery could not be retried.'
    }
  }

  /**
   * The When column's sort: the one order a log has, flipped. The server holds
   * the order, so the table asks for it again; no other column sorts, because
   * a page of a longer log sorted in the browser would claim an order the rest
   * of the log does not have.
   */
  const whenSort = (log: () => PagedLog, list: HTMLElement, address: LogAddress) => ({
    serverSort: true as const,
    sort: {
      column: 'when',
      direction: address.order === 'newest' ? ('descending' as const) : ('ascending' as const),
    },
    onSort: (next: { direction: 'ascending' | 'descending' }) => {
      // The rows are drawn again once the server has answered, which drops
      // the header the keyboard was on; put it back.
      void log()
        .go({
          ...address,
          order: next.direction === 'descending' ? 'newest' : 'oldest',
          cursor: null,
          offset: 0,
        })
        .then(() => {
          focusSortHeader(list, 'when')
        })
    },
  })

  const email: PagedLog = createPagedLog<EmailLogRow>({
    prefix: 'email',
    filterKeys: ['status', 'kind', 'from', 'to', 'q'],
    controls: emailControls,
    list: emailList,
    status: emailStatus,
    noun: 'messages',
    failure: 'Email could not be loaded.',
    read: (address, signal) => api.listEmailLog(emailQuery(address), signal),
    empty: (filtered) =>
      filtered ? 'No email matches these filters.' : 'No email has been sent yet.',
    draw: (rows, address) =>
      renderDataTable<EmailLogRow>({
        caption: 'Email',
        rows: [...rows],
        rowKey: (row) => String(row.id),
        empty: 'No email matches these filters.',
        ...whenSort(() => email, emailList, address),
        columns: [
          {
            key: 'when',
            label: whenLabel(),
            render: (row) => when(row.created_at),
            sortValue: (row) => row.created_at,
          },
          {
            key: 'to',
            label: 'To',
            // Every addressee. Showing the first alone would make a message
            // that went to two people look like it went to one.
            render: (row) => row.to.map((recipient) => recipient.email).join(', '),
          },
          {
            key: 'cc',
            label: 'Cc',
            // The log carries the copies too. Showing To alone made an invoice
            // copied to a client's accounts payable look like it never reached them.
            render: (row) => row.cc.map((recipient) => recipient.email).join(', '),
          },
          {
            key: 'what',
            label: 'What',
            render: (row) =>
              row.subject === '' ? deliveryLabel(row.template) : row.subject,
          },
          { key: 'status', label: 'Status', render: (row) => deliveryLabel(row.status) },
          { key: 'attempts', label: 'Attempts', render: (row) => String(row.attempt_count) },
          {
            key: 'why',
            label: 'Why',
            render: (row) => failureText(row.failure_code, row.failure_reason),
          },
        ],
      }),
  })

  const outbox: PagedLog = createPagedLog<OutboxRow>({
    prefix: 'outbox',
    filterKeys: ['status', 'type', 'from', 'to'],
    controls: outboxControls,
    list: outboxList,
    status: outboxStatus,
    noun: 'deliveries',
    failure: 'Deliveries could not be loaded.',
    read: (address, signal) => api.listOutboxDeliveries(outboxQuery(address), signal),
    empty: (filtered) =>
      filtered ? 'No delivery matches these filters.' : 'No event has been delivered yet.',
    // The count that needs somebody is said rather than left to be counted off
    // the table.
    summary: (rows) => {
      const failed = rows.filter((row) => row.status === 'failed').length
      return failed === 0 ? '' : `${String(failed)} failed on this page.`
    },
    draw: (rows, address) =>
      renderDataTable<OutboxRow>({
        caption: 'Event deliveries',
        rows: [...rows],
        rowKey: (row) => `${row.subscriber_id}:${row.event_id}`,
        empty: 'No delivery matches these filters.',
        ...whenSort(() => outbox, outboxList, address),
        columns: [
          {
            key: 'when',
            label: whenLabel(),
            render: (row) => when(row.created_at),
            sortValue: (row) => row.created_at,
          },
          { key: 'event', label: 'Event', render: (row) => deliveryLabel(row.event_type) },
          { key: 'subscriber', label: 'Subscriber', render: (row) => row.subscriber_id },
          { key: 'status', label: 'Status', render: (row) => deliveryLabel(row.status) },
          { key: 'attempts', label: 'Attempts', render: (row) => String(row.attempt_count) },
          { key: 'why', label: 'Why', render: (row) => failureText(row.last_error_code, null) },
        ],
        // Only where there is something to retry. A Retry beside a delivered
        // row invites doing the work twice for no reason.
        actions: (row) =>
          row.status === 'failed'
            ? [{ label: 'Retry', primary: true, onSelect: () => void retry(row) }]
            : [],
      }),
  })

  return {
    async activate(signal) {
      active = signal
      if (page.hidden) return
      if (api.organizationTimezone !== undefined) {
        try {
          timeZone = (await api.organizationTimezone(signal)) ?? 'UTC'
        } catch {
          // The times are then said in UTC, and the column says so.
          timeZone = 'UTC'
        }
        if (signal.aborted) return
      }
      await Promise.all([email.load(signal), outbox.load(signal)])
    },
  }
}
