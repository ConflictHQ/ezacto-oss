/**
 * What a contact of a client sees of an estimate, and how the page talks about
 * it (issue 1010, slice 3).
 *
 * The shapes are the portal routes' JSON as `packages/db` builds it
 * (`CustomerEstimate`); they are not in the generated client because the portal
 * routes are browser-facing and sit outside the OpenAPI document on purpose.
 *
 * Nothing on this page charges anyone or raises an invoice. An answer is a
 * recorded response against the exact version the contact was shown, and the
 * page says so before it is given.
 */

export interface PortalEstimateSummary {
  readonly id: number
  readonly number: string
  readonly subject: string | null
  readonly currency: string
  readonly state: 'sent' | 'accepted' | 'declined'
  readonly issue_date: string
  readonly amount_cents: number
  readonly sent_at: string | null
  readonly accepted_at: string | null
  readonly declined_at: string | null
}

export interface PortalEstimateLine {
  readonly position: number
  readonly kind: string
  readonly description: string | null
  readonly quantity: number
  readonly unit_price_cents: number
  readonly amount_cents: number
  readonly taxed: boolean
  readonly taxed2: boolean
}

export interface PortalEstimateResponse {
  readonly decision: 'accept' | 'decline'
  readonly at: string
  readonly by: string | null
  readonly version: string | null
  readonly current: boolean
}

export interface PortalEstimate extends PortalEstimateSummary {
  readonly purchase_order: string | null
  readonly notes: string | null
  readonly tax_rate_ppm: number | null
  readonly tax2_rate_ppm: number | null
  readonly discount_rate_ppm: number | null
  readonly tax_amount_cents: number
  readonly tax2_amount_cents: number
  readonly discount_amount_cents: number
  readonly line_items: readonly PortalEstimateLine[]
  readonly version: string
  /** The last day the estimate can be answered, or null when it does not expire. */
  readonly expires_on: string | null
  /** True once that day has passed while the estimate was still unanswered. */
  readonly expired: boolean
  readonly answerable: boolean
  readonly response: PortalEstimateResponse | null
}

export type PortalDecision = 'accept' | 'decline'

/**
 * The sign-in token from the link a contact followed.
 *
 * It travels in the URL fragment, which a browser never sends to a server, a
 * referrer or a page-view beacon; the page strips it from the address bar before
 * it does anything else. A token in a query string would be in every access log
 * between the mail client and here.
 */
export const tokenFromFragment = (fragment: string): string | null => {
  const params = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment)
  const token = params.get('token')
  return token === null || token.trim() === '' ? null : token.trim()
}

/** The estimate named by `?estimate=`, or null. */
export const estimateIdFromSearch = (search: string): number | null => {
  const raw = new URLSearchParams(search).get('estimate')
  if (raw === null || !/^[1-9][0-9]{0,15}$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) ? id : null
}

export const portalMoney = (cents: number, currency: string): string => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`
  }
}

/** A rate held in parts per million, as a percentage a person reads: 82500 is 8.25%. */
export const portalRate = (ppm: number | null): string | null => {
  if (ppm === null) return null
  const percent = ppm / 10_000
  return `${Number.isInteger(percent) ? String(percent) : String(Number(percent.toFixed(4)))}%`
}

export const portalStateLabel = (state: string): string =>
  state === 'sent'
    ? 'Awaiting your answer'
    : state === 'accepted'
      ? 'Accepted'
      : state === 'declined'
        ? 'Declined'
        : state

export interface PortalTotalRow {
  readonly label: string
  readonly cents: number
  readonly strong: boolean
}

/**
 * The amounts under the lines, as stored: discount, each tax, then the total.
 * A row appears only when the quote has it, so a plain quote reads as lines and
 * a total, and the figures are never recomputed here -- the total is the one
 * the version hash covers.
 */
export const portalTotalRows = (estimate: PortalEstimate): readonly PortalTotalRow[] => {
  const rows: PortalTotalRow[] = []
  const rate = portalRate(estimate.discount_rate_ppm)
  if (estimate.discount_amount_cents !== 0 || rate !== null) {
    rows.push({
      label: rate === null ? 'Discount' : `Discount (${rate})`,
      cents: -Math.abs(estimate.discount_amount_cents),
      strong: false,
    })
  }
  const tax = portalRate(estimate.tax_rate_ppm)
  if (estimate.tax_amount_cents !== 0 || tax !== null) {
    rows.push({
      label: tax === null ? 'Tax' : `Tax (${tax})`,
      cents: estimate.tax_amount_cents,
      strong: false,
    })
  }
  const tax2 = portalRate(estimate.tax2_rate_ppm)
  if (estimate.tax2_amount_cents !== 0 || tax2 !== null) {
    rows.push({
      label: tax2 === null ? 'Second tax' : `Second tax (${tax2})`,
      cents: estimate.tax2_amount_cents,
      strong: false,
    })
  }
  rows.push({ label: 'Total', cents: estimate.amount_cents, strong: true })
  return rows
}

/** The expiry as a fact row: the day is the last one the estimate can be answered on. */
export const portalExpiryText = (estimate: PortalEstimate): string | null =>
  estimate.expires_on === null
    ? null
    : estimate.expired
      ? `${estimate.expires_on} (expired)`
      : `${estimate.expires_on} (open until the end of that day)`

/** `2026-10-18T14:03:00.000Z` as `2026-10-18 14:03 UTC`. */
export const portalTimestamp = (value: string): string =>
  `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`

/**
 * What to say about an estimate that cannot be answered, or has been.
 *
 * Three different reasons, kept apart because the next step differs: an answered
 * estimate needs nothing, an estimate being revised needs the sender, and one
 * that changed under an open page needs a reload.
 */
export const portalStatusLine = (estimate: PortalEstimate): string => {
  const response = estimate.response
  if (estimate.state !== 'sent') {
    const verb = estimate.state === 'accepted' ? 'accepted' : 'declined'
    if (response === null) return `This estimate was ${verb}.`
    const who = response.by === null ? 'Your organization' : response.by
    const stale = response.current
      ? ''
      : ' It has been edited since; ask the sender to send it again if the new version needs an answer.'
    return `${who} ${verb} this estimate on ${portalTimestamp(response.at)}.${stale}`
  }
  if (estimate.expired) {
    return `This estimate expired on ${estimate.expires_on ?? 'its expiry day'} and can no longer be answered. Ask the sender for a new one.`
  }
  if (!estimate.answerable) {
    return 'This estimate is being revised and cannot be answered yet. You will be able to respond once it is sent again.'
  }
  return 'Review the quote below. Accepting or declining records your answer; nothing is charged and no invoice is raised.'
}

export type PortalFailure =
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'changed' }
  | { readonly kind: 'revising' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'answered' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly message: string }

/** Keeps the refusals apart: each one has a different next step. */
export const portalFailure = (status: number, code: string | null): PortalFailure => {
  if (status === 401) return { kind: 'signed-out' }
  if (status === 404) return { kind: 'not-found' }
  if (status === 503) return { kind: 'unavailable' }
  if (status === 409 && code === 'estimate_content_changed') return { kind: 'changed' }
  if (status === 409 && code === 'estimate_needs_resend') return { kind: 'revising' }
  if (status === 410 && code === 'estimate_expired') return { kind: 'expired' }
  if (status === 409) return { kind: 'answered' }
  return { kind: 'failed', message: 'Something went wrong. Nothing was recorded. Try again.' }
}

export const portalFailureMessage = (failure: PortalFailure): string => {
  switch (failure.kind) {
    case 'signed-out':
      return 'This link has expired or was already used. Ask the sender for a new link.'
    case 'changed':
      return 'This quote changed after you opened it, so your answer was not recorded. The current version is shown below; review it and answer again.'
    case 'revising':
      return 'This estimate is being revised and cannot be answered until it is sent again. Your answer was not recorded.'
    case 'expired':
      return 'This estimate has expired and can no longer be answered. Your answer was not recorded. Ask the sender for a new one.'
    case 'answered':
      return 'This estimate has already been answered. Your answer was not recorded.'
    case 'not-found':
      return 'That estimate could not be found.'
    case 'unavailable':
      return 'Estimate review is temporarily unavailable. Try again later.'
    default:
      return failure.message
  }
}

export const portalDecisionLabel = (decision: PortalDecision): string =>
  decision === 'accept' ? 'Accept' : 'Decline'

/** The sentence the confirm step asks, so an answer is never one click. */
export const portalConfirmText = (estimate: PortalEstimate, decision: PortalDecision): string =>
  `${decision === 'accept' ? 'Accept' : 'Decline'} estimate ${estimate.number} for ${portalMoney(estimate.amount_cents, estimate.currency)}? ` +
  'This records your answer. Nothing is charged and no invoice is raised.'
