import { renderDataTable } from '../components/data-table.js'
import { moneyText } from '../money-display.js'
import {
  estimateIdFromSearch,
  portalConfirmText,
  portalDecisionLabel,
  portalExpiryText,
  portalFailure,
  portalFailureMessage,
  portalMoney,
  portalStateLabel,
  portalStatusLine,
  portalTotalRows,
  tokenFromFragment,
  type PortalDecision,
  type PortalEstimate,
  type PortalEstimateLine,
  type PortalEstimateSummary,
  type PortalFailure,
} from './model.js'

/**
 * The customer estimate page's script (issue 1010, slice 3).
 *
 * A contact arrives by an emailed link carrying a sign-in token in the URL
 * fragment, or with a session they already hold. The fragment is stripped from
 * the address bar before the first request, the token is spent once on
 * `/portal/verify`, and everything after that rides the session cookie the
 * server sets. Nothing is kept in storage and nothing is sent anywhere but the
 * portal routes.
 *
 * An answer takes two deliberate steps (choose, then confirm) and the buttons
 * stay disabled while a request is in flight, so a double click cannot record
 * twice -- and the server would answer the second one as a replay anyway.
 * The answer carries the version of the quote that was on screen; if staff
 * changed it meanwhile the server refuses, and the page reloads the current
 * version instead of reusing the old one.
 */

export interface PortalEstimatesEnvironment {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly location: Pick<Location, 'hash' | 'search' | 'pathname'>
  readonly history: Pick<History, 'replaceState' | 'pushState'>
}

const required = <ElementType extends Element>(selector: string): ElementType => {
  const item = document.querySelector<ElementType>(selector)
  if (item === null) throw new Error(`portal estimates element missing: ${selector}`)
  return item
}

class PortalRequestError extends Error {
  constructor(readonly failure: PortalFailure) {
    super(portalFailureMessage(failure))
  }
}

export const mountPortalEstimates = async (
  environment: PortalEstimatesEnvironment = {
    fetch: (input, init) => globalThis.fetch(input, init),
    location: window.location,
    history: window.history,
  },
): Promise<void> => {
  const heading = required<HTMLElement>('[data-portal-heading]')
  const status = required<HTMLElement>('[data-portal-status]')
  const listView = required<HTMLElement>('[data-portal-list-view]')
  const list = required<HTMLElement>('[data-portal-list]')
  const detailView = required<HTMLElement>('[data-portal-detail-view]')
  const facts = required<HTMLElement>('[data-portal-facts]')
  const lines = required<HTMLElement>('[data-portal-lines]')
  const totals = required<HTMLElement>('[data-portal-totals]')
  const notesSection = required<HTMLElement>('[data-portal-notes-section]')
  const notes = required<HTMLElement>('[data-portal-notes]')
  const answerLine = required<HTMLElement>('[data-portal-answer-line]')
  const actions = required<HTMLElement>('[data-portal-actions]')
  const accept = required<HTMLButtonElement>('[data-portal-accept]')
  const decline = required<HTMLButtonElement>('[data-portal-decline]')
  const confirm = required<HTMLElement>('[data-portal-confirm]')
  const confirmText = required<HTMLElement>('[data-portal-confirm-text]')
  const confirmYes = required<HTMLButtonElement>('[data-portal-confirm-yes]')
  const confirmNo = required<HTMLButtonElement>('[data-portal-confirm-no]')
  const back = required<HTMLAnchorElement>('[data-portal-back]')

  let open: PortalEstimate | null = null
  let pending: PortalDecision | null = null
  let sending = false

  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    let response: Response
    try {
      response = await environment.fetch(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...init,
      })
    } catch {
      throw new PortalRequestError({
        kind: 'failed',
        message: 'The connection failed. Nothing was recorded. Try again.',
      })
    }
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const detail =
        typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : undefined
      const code =
        typeof detail === 'object' && detail !== null ? Reflect.get(detail, 'code') : undefined
      throw new PortalRequestError(portalFailure(response.status, typeof code === 'string' ? code : null))
    }
    return body
  }

  const data = <Shape>(body: unknown): Shape => {
    const value = typeof body === 'object' && body !== null ? Reflect.get(body, 'data') : undefined
    return value as Shape
  }

  /** Everything drawn from the portal, removed: the page holds nothing once it is signed out. */
  const clear = (): void => {
    open = null
    pending = null
    list.replaceChildren()
    facts.replaceChildren()
    lines.replaceChildren()
    totals.replaceChildren()
    notes.textContent = ''
    answerLine.textContent = ''
    listView.hidden = true
    detailView.hidden = true
  }

  const fail = (error: unknown): void => {
    const failure =
      error instanceof PortalRequestError
        ? error.failure
        : ({ kind: 'failed', message: 'Something went wrong. Nothing was recorded.' } as const)
    if (failure.kind === 'signed-out') clear()
    status.textContent = portalFailureMessage(failure)
  }

  const showFacts = (estimate: PortalEstimate): void => {
    const rows: [string, string][] = [
      ['Number', estimate.number],
      ['Status', portalStateLabel(estimate.state)],
      ['Issued', estimate.issue_date],
      ['Currency', estimate.currency],
    ]
    if (estimate.subject !== null && estimate.subject.trim() !== '') {
      rows.splice(1, 0, ['Subject', estimate.subject])
    }
    if (estimate.purchase_order !== null && estimate.purchase_order.trim() !== '') {
      rows.push(['Purchase order', estimate.purchase_order])
    }
    const expiry = portalExpiryText(estimate)
    if (expiry !== null && estimate.state === 'sent') rows.push(['Expires', expiry])
    facts.replaceChildren(
      ...rows.map(([term, value]) => {
        const group = document.createElement('div')
        const dt = document.createElement('dt')
        dt.textContent = term
        const dd = document.createElement('dd')
        dd.textContent = value
        group.append(dt, dd)
        return group
      }),
    )
  }

  const showLines = (estimate: PortalEstimate): void => {
    lines.replaceChildren(
      renderDataTable<PortalEstimateLine>({
        caption: `Lines on estimate ${estimate.number}`,
        rows: [...estimate.line_items],
        rowKey: (line) => String(line.position),
        empty: 'This estimate quotes no lines.',
        columns: [
          { key: 'kind', label: 'Kind', fit: true, render: (line) => line.kind },
          {
            key: 'description',
            label: 'Description',
            wrap: true,
            render: (line) => line.description ?? '—',
          },
          {
            key: 'quantity',
            label: 'Quantity',
            numeric: true,
            render: (line) => String(line.quantity),
          },
          {
            key: 'unit',
            label: 'Unit price',
            numeric: true,
            render: (line) =>
              moneyText(portalMoney(line.unit_price_cents, estimate.currency)),
          },
          {
            key: 'amount',
            label: 'Amount',
            numeric: true,
            render: (line) => moneyText(portalMoney(line.amount_cents, estimate.currency)),
          },
        ],
      }),
    )
    totals.replaceChildren(
      ...portalTotalRows(estimate).map((row) => {
        const group = document.createElement('div')
        if (row.strong) group.className = 'portal-estimates-total'
        const dt = document.createElement('dt')
        dt.textContent = row.label
        const dd = document.createElement('dd')
        dd.append(moneyText(portalMoney(row.cents, estimate.currency)))
        group.append(dt, dd)
        return group
      }),
    )
  }

  const setBusy = (busy: boolean): void => {
    sending = busy
    accept.disabled = busy
    decline.disabled = busy
    confirmYes.disabled = busy
    confirmNo.disabled = busy
  }

  const closeConfirm = (): void => {
    pending = null
    confirm.hidden = true
  }

  const showDetail = (estimate: PortalEstimate): void => {
    open = estimate
    closeConfirm()
    listView.hidden = true
    detailView.hidden = false
    heading.textContent = `Estimate ${estimate.number}`
    showFacts(estimate)
    showLines(estimate)
    const hasNotes = estimate.notes !== null && estimate.notes.trim() !== ''
    notesSection.hidden = !hasNotes
    notes.textContent = hasNotes ? (estimate.notes ?? '') : ''
    answerLine.textContent = portalStatusLine(estimate)
    actions.hidden = !(estimate.state === 'sent' && estimate.answerable)
    setBusy(false)
  }

  const showList = (summaries: readonly PortalEstimateSummary[]): void => {
    open = null
    closeConfirm()
    detailView.hidden = true
    listView.hidden = false
    heading.textContent = 'Your estimates'
    list.replaceChildren(
      renderDataTable<PortalEstimateSummary>({
        caption: 'Your estimates',
        rows: [...summaries],
        rowKey: (summary) => String(summary.id),
        empty: 'There are no estimates to review.',
        columns: [
          {
            key: 'number',
            label: 'Number',
            fit: true,
            render: (summary) => {
              const link = document.createElement('a')
              link.href = `?estimate=${String(summary.id)}`
              link.dataset.portalOpen = String(summary.id)
              link.textContent = summary.number
              return link
            },
          },
          {
            key: 'subject',
            label: 'Subject',
            wrap: true,
            render: (summary) => summary.subject ?? '—',
          },
          {
            key: 'state',
            label: 'Status',
            fit: true,
            render: (summary) => portalStateLabel(summary.state),
          },
          {
            key: 'amount',
            label: 'Total',
            numeric: true,
            render: (summary) => moneyText(portalMoney(summary.amount_cents, summary.currency)),
          },
        ],
      }),
    )
    status.textContent =
      summaries.length === 0 ? 'There are no estimates to review.' : `${String(summaries.length)} to review.`
  }

  const loadDetail = async (id: number): Promise<void> => {
    status.textContent = 'Loading estimate…'
    try {
      showDetail(data<PortalEstimate>(await request(`/portal/estimates/${String(id)}`)))
      status.textContent = ''
      heading.focus()
    } catch (error) {
      fail(error)
    }
  }

  const loadList = async (): Promise<void> => {
    status.textContent = 'Loading your estimates…'
    try {
      const body = await request('/portal/estimates')
      showList(data<{ estimates: PortalEstimateSummary[] }>(body).estimates)
      heading.focus()
    } catch (error) {
      fail(error)
    }
  }

  const route = async (): Promise<void> => {
    const id = estimateIdFromSearch(environment.location.search)
    if (id === null) await loadList()
    else await loadDetail(id)
  }

  const choose = (decision: PortalDecision): void => {
    if (open === null || sending) return
    pending = decision
    confirmText.textContent = portalConfirmText(open, decision)
    confirmYes.textContent = `Confirm: ${portalDecisionLabel(decision).toLowerCase()} this estimate`
    confirm.hidden = false
    confirmText.focus()
  }

  const send = async (): Promise<void> => {
    if (open === null || pending === null || sending) return
    const estimate = open
    const decision = pending
    setBusy(true)
    status.textContent = 'Recording your answer…'
    try {
      const body = await request(`/portal/estimates/${String(estimate.id)}/response`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, version: estimate.version }),
      })
      showDetail(data<PortalEstimate>(body))
      status.textContent =
        decision === 'accept' ? 'Your acceptance was recorded.' : 'Your decline was recorded.'
    } catch (error) {
      const changed =
        error instanceof PortalRequestError && error.failure.kind === 'changed'
      if (
        changed ||
        (error instanceof PortalRequestError &&
          (error.failure.kind === 'revising' || error.failure.kind === 'expired'))
      ) {
        // The old answer is never reused: reload what is current and let the
        // contact read it and decide again.
        await loadDetail(estimate.id)
        status.textContent = portalFailureMessage((error as PortalRequestError).failure)
        return
      }
      fail(error)
      setBusy(false)
      closeConfirm()
    }
  }

  accept.addEventListener('click', () => {
    choose('accept')
  })
  decline.addEventListener('click', () => {
    choose('decline')
  })
  confirmNo.addEventListener('click', () => {
    if (sending) return
    closeConfirm()
    status.textContent = 'Nothing was recorded.'
  })
  confirmYes.addEventListener('click', () => {
    void send()
  })
  list.addEventListener('click', (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
      '[data-portal-open]',
    )
    if (anchor === null || anchor === undefined) return
    event.preventDefault()
    environment.history.pushState({}, '', anchor.getAttribute('href') ?? '?')
    void route()
  })
  back.addEventListener('click', (event) => {
    event.preventDefault()
    environment.history.pushState({}, '', environment.location.pathname)
    void route()
  })
  window.addEventListener('popstate', () => {
    void route()
  })

  const token = tokenFromFragment(environment.location.hash)
  if (token !== null) {
    // Out of the address bar before anything else, so it is in no history entry,
    // screenshot or copied link from here on.
    environment.history.replaceState(
      null,
      '',
      `${environment.location.pathname}${environment.location.search}`,
    )
    status.textContent = 'Signing you in…'
    try {
      await request(`/portal/verify?token=${encodeURIComponent(token)}`)
    } catch (error) {
      fail(error)
      return
    }
  }
  await route()
}
