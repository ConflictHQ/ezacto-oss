import { renderDataTable } from '../components/data-table.js'

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
}

export interface DeliveriesApi {
  listEmailLog(
    query: { readonly status?: EmailLogStatus },
    signal?: AbortSignal,
  ): Promise<{ readonly data: readonly EmailLogRow[] }>
  listOutboxDeliveries(
    query: { readonly status?: OutboxStatus },
    signal?: AbortSignal,
  ): Promise<{ readonly data: readonly OutboxRow[] }>
  retryOutboxDelivery(
    subscriberId: string,
    eventId: string,
    signal?: AbortSignal,
  ): Promise<unknown>
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
  if (code === null && reason === null) return ''
  if (code === null) return reason ?? ''
  return reason === null ? code : `${code}: ${reason}`
}

export const createDeliveriesController = (api: DeliveriesApi): DeliveriesController => {
  const page = document.querySelector<HTMLElement>('[data-deliveries-page]')
  if (page === null) return { activate: async () => {} }
  const emailList = required<HTMLElement>('[data-email-log-list]')
  const emailStatus = required<HTMLElement>('[data-email-log-status]')
  const outboxList = required<HTMLElement>('[data-outbox-list]')
  const outboxStatus = required<HTMLElement>('[data-outbox-status]')
  // Narrowed at the use site rather than through the generic: the worker's
  // tsconfig uses workers-types, where HTMLSelectElement does not satisfy the
  // DOM `Element` the generic is constrained to.
  const emailFilter = required('[data-email-log-status-filter]') as unknown as HTMLInputElement
  const outboxFilter = required('[data-outbox-status-filter]') as unknown as HTMLInputElement

  let active: AbortSignal | null = null

  const renderEmail = (rows: readonly EmailLogRow[]): void => {
    emailList.replaceChildren(
      renderDataTable<EmailLogRow>({
        caption: 'Email',
        rows: [...rows],
        rowKey: (row) => String(row.id),
        empty: 'No email matches this filter.',
        columns: [
          { key: 'when', label: 'When', render: (row) => row.created_at },
          {
            key: 'to',
            label: 'To',
            // Every addressee. Showing the first alone would make a message
            // that went to two people look like it went to one.
            render: (row) => row.to.map((recipient) => recipient.email).join(', '),
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
    )
  }

  const retry = async (row: OutboxRow): Promise<void> => {
    const signal = active
    if (signal === null) return
    outboxStatus.textContent = `Retrying ${deliveryLabel(row.event_type)}…`
    try {
      await api.retryOutboxDelivery(row.subscriber_id, row.event_id, signal)
      if (signal.aborted) return
      await loadOutbox()
    } catch (error) {
      if (signal.aborted) return
      outboxStatus.textContent =
        error instanceof Error ? error.message : 'The delivery could not be retried.'
    }
  }

  const renderOutbox = (rows: readonly OutboxRow[]): void => {
    outboxList.replaceChildren(
      renderDataTable<OutboxRow>({
        caption: 'Event deliveries',
        rows: [...rows],
        rowKey: (row) => `${row.subscriber_id}:${row.event_id}`,
        empty: 'No delivery matches this filter.',
        columns: [
          { key: 'when', label: 'When', render: (row) => row.occurred_at },
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
    )
  }

  const loadEmail = async (): Promise<void> => {
    const signal = active
    if (signal === null) return
    emailStatus.textContent = 'Loading email…'
    try {
      // An empty filter is omitted rather than sent blank: "" is not a status,
      // and sending it turns an untouched control into a 422.
      const listed = await api.listEmailLog(
        emailFilter.value === '' ? {} : { status: emailFilter.value as EmailLogStatus },
        signal,
      )
      if (signal.aborted) return
      renderEmail(listed.data)
      emailStatus.textContent =
        listed.data.length === 0
          ? ''
          : `${String(listed.data.length)} ${listed.data.length === 1 ? 'message' : 'messages'}.`
    } catch (error) {
      if (signal.aborted) return
      // This screen is what somebody reads when something has gone wrong, so a
      // failure to read it says so rather than rendering an empty table that
      // looks like nothing was ever sent.
      emailList.replaceChildren()
      emailStatus.textContent =
        error instanceof Error ? error.message : 'Email could not be loaded.'
    }
  }

  const loadOutbox = async (): Promise<void> => {
    const signal = active
    if (signal === null) return
    outboxStatus.textContent = 'Loading deliveries…'
    try {
      const listed = await api.listOutboxDeliveries(
        outboxFilter.value === '' ? {} : { status: outboxFilter.value as OutboxStatus },
        signal,
      )
      if (signal.aborted) return
      renderOutbox(listed.data)
      const failed = listed.data.filter((row) => row.status === 'failed').length
      outboxStatus.textContent =
        listed.data.length === 0
          ? ''
          : failed === 0
            ? `${String(listed.data.length)} ${listed.data.length === 1 ? 'delivery' : 'deliveries'}.`
            : // The count that needs somebody is said rather than left to be
              // counted off the table.
              `${String(listed.data.length)} deliveries, ${String(failed)} failed.`
    } catch (error) {
      if (signal.aborted) return
      outboxList.replaceChildren()
      outboxStatus.textContent =
        error instanceof Error ? error.message : 'Deliveries could not be loaded.'
    }
  }

  emailFilter.addEventListener('change', () => void loadEmail())
  outboxFilter.addEventListener('change', () => void loadOutbox())

  return {
    async activate(signal) {
      active = signal
      if (page.hidden) return
      await Promise.all([loadEmail(), loadOutbox()])
    },
  }
}
