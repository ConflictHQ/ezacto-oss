/**
 * What the estimates screen has to say (issue 485).
 *
 * Seven API paths and nine client methods have been served since the API
 * shipped and no screen called any of them. `estimate_feature` is false on the
 * account this was written for, so nothing was stranded here -- this is parity
 * against the product, not against these books.
 *
 * An estimate answers two questions and then stops being interesting: what did
 * we quote, and what happened to it. `listEstimates` answers the first across
 * the book and `getEstimate` answers it in full for one, which is why the
 * detail exists to show the lines rather than to fetch something the list was
 * missing -- the same shape the recurring pane next door uses.
 *
 * The third question is the one the screen exists for: turn an accepted
 * estimate into an invoice. `POST /estimates/:id/convert` answers it, and it is
 * the only write here. Everything else an estimate does -- messages,
 * attachments -- is correspondence about a document, and a screen that could
 * send it without being able to raise the invoice would have the priority
 * backwards.
 */

import type { Estimate, EstimateMessage, GeneralResource } from '@conflict-hq/ezacto-client'
import { invoiceIdentityCanWrite } from '../invoices/model.js'

/**
 * What converting asks for.
 *
 * Not a one-click action, because the API will not accept one: an invoice needs
 * its own number, its own dates and its own terms, and an estimate carries none
 * of them. `expected_version` is the estimate's, so a conversion raced against
 * an edit is refused rather than raising an invoice for terms that changed
 * while the form was open.
 */
export interface EstimateConversionRequest {
  readonly expected_version: number
  readonly number: string
  readonly issue_date: string
  readonly due_date: string
  readonly payment_terms:
    | 'upon_receipt'
    | 'net_15'
    | 'net_30'
    | 'net_45'
    | 'net_60'
    | 'custom'
}

export const estimatePaymentTerms = [
  ['upon_receipt', 'On receipt'],
  ['net_15', 'Net 15'],
  ['net_30', 'Net 30'],
  ['net_45', 'Net 45'],
  ['net_60', 'Net 60'],
  ['custom', 'Custom'],
] as const

/**
 * The due date the chosen terms imply, so the form is filled in rather than
 * asking somebody to do date arithmetic. `custom` leaves whatever is there --
 * choosing custom is saying the default is wrong.
 */
export const estimateDueDate = (issueDate: string, terms: string): string => {
  const days =
    terms === 'net_15' ? 15 : terms === 'net_30' ? 30 : terms === 'net_45' ? 45 : terms === 'net_60' ? 60 : 0
  const issued = new Date(`${issueDate}T00:00:00.000Z`)
  if (Number.isNaN(issued.getTime())) return issueDate
  issued.setUTCDate(issued.getUTCDate() + days)
  return issued.toISOString().slice(0, 10)
}

export interface EstimateCursorPage<Resource> {
  readonly data: readonly Resource[]
  readonly page: { readonly next_cursor: string | null }
}

export interface EstimateWorkspaceApi {
  listEstimates(cursor?: string, signal?: AbortSignal): Promise<EstimateCursorPage<Estimate>>
  getEstimate(id: number, signal?: AbortSignal): Promise<Estimate>
  /**
   * Raises the invoice this estimate quoted. Rejects with the API error;
   * `estimateConversionOutcome` turns that into something to read.
   */
  convertEstimate?(
    id: number,
    input: EstimateConversionRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<{ invoice: { id: number } }>
  /**
   * Unfiltered, for the reason the retainer and recurring panes give: an
   * estimate outlives the archiving of the client it quoted, and a row reading
   * "Client #14" because a filter dropped the client is a worse answer than a
   * longer list.
   */
  /** The correspondence on one estimate, oldest first, for the response the customer gave. */
  listEstimateMessages?(id: number, signal?: AbortSignal): Promise<readonly EstimateMessage[]>
  listEstimateClients(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<EstimateCursorPage<GeneralResource>>
}

/**
 * The states an estimate can be in, in the order it passes through them.
 *
 * `declined` is not a failure of the screen to show something -- it is the
 * answer to "what happened to it", and an estimate that was declined is the one
 * an operator most wants to find later.
 */
export const estimateStates = ['draft', 'sent', 'accepted', 'declined'] as const
export type EstimateState = (typeof estimateStates)[number]

export const estimateStateLabel = (state: string): string =>
  state === 'draft'
    ? 'Draft'
    : state === 'sent'
      ? 'Sent'
      : state === 'accepted'
        ? 'Accepted'
        : state === 'declined'
          ? 'Declined'
          : state

/**
 * Only an accepted estimate converts.
 *
 * A draft has not been quoted to anybody, a sent one has not been agreed, and a
 * declined one was refused -- raising an invoice from any of those is raising an
 * invoice for work nobody agreed to pay for. The API decides; this is what the
 * button reads so it is not offered where it cannot work.
 */
export const estimateCanConvert = (estimate: Pick<Estimate, 'state'>): boolean =>
  estimate.state === 'accepted'

export type EstimateConversionOutcome =
  | { readonly kind: 'converted'; readonly invoiceId: number }
  | { readonly kind: 'not_accepted' }
  | { readonly kind: 'already_converted' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Keeps the answers apart.
 *
 * "Not accepted yet" and "already an invoice" are both refusals and neither is
 * a fault; collapsing them into one failure is what makes an operator think a
 * screen is broken when it is telling them something true.
 */
export const estimateConversionOutcome = (error: unknown): EstimateConversionOutcome => {
  const body = (error as { body?: { error?: { code?: unknown; message?: unknown } } } | null)?.body
  const code = typeof body?.error?.code === 'string' ? body.error.code : null
  if (code === 'estimate_not_accepted') return { kind: 'not_accepted' }
  if (code === 'invoice_number_taken') {
    return { kind: 'failed', message: 'That invoice number is already used.' }
  }
  if (code === 'estimate_already_converted') return { kind: 'already_converted' }
  const message =
    typeof body?.error?.message === 'string'
      ? body.error.message
      : error instanceof Error
        ? error.message
        : 'The estimate could not be converted.'
  return { kind: 'failed', message }
}

export const estimateConversionMessage = (outcome: EstimateConversionOutcome): string => {
  switch (outcome.kind) {
    case 'converted':
      return `Invoice ${String(outcome.invoiceId)} raised from this estimate.`
    case 'not_accepted':
      return 'Only an accepted estimate can become an invoice.'
    case 'already_converted':
      return 'This estimate has already become an invoice.'
    case 'unavailable':
      return 'This deployment cannot convert estimates.'
    default:
      return outcome.message
  }
}

export { invoiceIdentityCanWrite as estimateIdentityCanWrite }

/**
 * An amount in its own currency, falling back to USD formatting rather than
 * throwing on a code `Intl` does not know. The same shape the recurring pane
 * uses: a screen should not go blank because a currency is unusual.
 */
export const estimateMoney = (cents: number, currency: string): string => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
  } catch {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
      cents / 100,
    )
  }
}

/**
 * What the customer, or staff on their behalf, last said about an estimate
 * (issue 1010): who, when, and which version of the quote it was said about.
 */
export interface EstimateResponseSummary {
  readonly decision: 'accept' | 'decline'
  /** `customer` when a contact answered through the customer page. */
  readonly source: 'customer' | 'staff'
  readonly by: string | null
  readonly at: string
  /** The first eight characters of the content version answered; null for a staff entry. */
  readonly version: string | null
}

/**
 * The response behind the estimate's current state, or null when it has none --
 * a draft, a sent estimate, or one staff re-opened after it was answered. The
 * latest accept or decline counts only while the estimate is still in the state
 * it set, so a re-open never leaves yesterday's answer reading as today's.
 */
export const estimateResponseSummary = (
  state: string,
  messages: readonly Pick<
    EstimateMessage,
    'id' | 'event_type' | 'sent_by' | 'created_at' | 'contact_id' | 'content_hash'
  >[],
): EstimateResponseSummary | null => {
  if (state !== 'accepted' && state !== 'declined') return null
  const wanted = state === 'accepted' ? 'accept' : 'decline'
  const answers = messages
    .filter((message) => message.event_type === 'accept' || message.event_type === 'decline')
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id - right.id)
  const latest = answers[answers.length - 1]
  if (latest === undefined || latest.event_type !== wanted) return null
  const fromCustomer = latest.contact_id !== null && latest.content_hash !== null
  return {
    decision: wanted,
    source: fromCustomer ? 'customer' : 'staff',
    by: latest.sent_by,
    at: latest.created_at,
    version: fromCustomer && latest.content_hash !== null ? latest.content_hash.slice(0, 8) : null,
  }
}

export const estimateResponseText = (summary: EstimateResponseSummary | null): string => {
  if (summary === null) return 'No response recorded.'
  const when = `${summary.at.slice(0, 10)} ${summary.at.slice(11, 16)} UTC`
  const verb = summary.decision === 'accept' ? 'Accepted' : 'Declined'
  if (summary.source === 'staff') {
    return `${verb}, recorded by ${summary.by ?? 'staff'} on ${when}.`
  }
  return `${verb} by ${summary.by ?? 'a contact of the client'} on ${when}, quote version ${summary.version ?? 'unknown'}.`
}
