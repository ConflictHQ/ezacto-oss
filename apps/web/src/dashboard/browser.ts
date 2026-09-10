import {
  EzactoApiError,
  type Invoice,
  type TimesheetSubmission,
  type Whoami,
} from '@ezacto/client'
import { formatReportHours, formatReportMoney } from '../reports/model.js'
import { markMoney, moneyText } from '../money-display.js'
import { localDate, weekRange } from '../shell/model.js'
import {
  dashboardCards,
  dashboardCount,
  invoiceObligations,
  queueCount,
  trackedSeconds,
  uninvoicedReportHref,
  uninvoicedTotals,
  uninvoicedWindow,
  uninvoicedWindowDays,
  weekStanding,
  type CurrencyMoney,
  type DashboardApi,
  type DashboardCard,
  type DashboardCardKey,
} from './model.js'

const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`dashboard element missing: ${selector}`)
  return element
}

interface ActiveSession {
  readonly identity: Whoami
  readonly signal: AbortSignal
  onSessionFailure(error: unknown): boolean
}

export interface DashboardController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

/**
 * How much of the invoice book the owed card will read before it stops. The
 * list endpoint has no state filter and no aggregate, so "what is owed" is a
 * walk, and a walk without a ceiling is an unbounded fan-out on the screen a
 * person lands on. The walk asks for the largest page the API serves, so ten
 * requests cover two thousand invoices rather than five hundred.
 */
const invoicePageSize = 200
const invoicePageLimit = 10

/** A 404 means the module is not installed, which is not a failure to report. */
const absent = (error: unknown): boolean =>
  error instanceof EzactoApiError && error.status === 404

export const createDashboardController = (api: DashboardApi): DashboardController => {
  const dashboardPage = document.documentElement.dataset.appView === 'dashboard'
  const page = required<HTMLElement>('[data-dashboard-page]')
  const container = required<HTMLElement>('[data-dashboard-cards]')
  const status = required<HTMLElement>('[data-dashboard-status]')
  const retry = required<HTMLButtonElement>('[data-dashboard-retry]')
  const navigation = document.querySelector<HTMLElement>('.primary-nav')
  const cards = new Map<DashboardCardKey, HTMLElement>(
    dashboardCards.map((card) => [
      card.key,
      required<HTMLElement>(`[data-dashboard-card="${card.key}"]`),
    ]),
  )
  page.hidden = !dashboardPage

  let session: ActiveSession | null = null
  let gated: readonly DashboardCard[] = []
  let loading = false
  let queued = false
  let signature = ''
  /** Cards this session has already sent for, so a late gate costs only its own. */
  const read = new Set<DashboardCardKey>()
  const failed = new Set<DashboardCardKey>()
  /** Cards the data contradicted. They stay off the page until the next session. */
  const withdrawn = new Set<DashboardCardKey>()
  /** Whether capacity was on offer the last time the week card read it. */
  let capacityRead = false

  const currentSession = (): ActiveSession | null =>
    session === null || session.signal.aborted ? null : session

  /**
   * The same read the command palette makes: a destination is offered only when
   * the element the nav already gates it behind is present and showing. Asking
   * the DOM rather than the profile keeps one rule in one place -- the moment
   * module state or a permission hides the Approvals link, this card goes with
   * it, and no figure outlives the surface it links to.
   */
  const offers = (card: Readonly<DashboardCard>): boolean => {
    if (withdrawn.has(card.key)) return false
    if (card.gate === undefined) return true
    const gate = document.querySelector<HTMLElement>(card.gate)
    return gate !== null && !gate.hidden
  }

  const part = <ElementType extends Element>(
    key: DashboardCardKey,
    selector: string,
  ): ElementType => {
    const element = cards.get(key)!.querySelector<ElementType>(selector)
    if (element === null) throw new Error(`dashboard card part missing: ${key} ${selector}`)
    return element
  }

  /**
   * `isMoney` is the whole distinction the $ toggle turns on. Two of these four
   * figures are amounts and two are not -- a week of hours and a queue depth
   * stay on screen when the amounts go, because masking a timesheet would be a
   * different feature. It is a parameter rather than a property of the card so
   * that the dash and the failure sentence, which are neither, drop the marker
   * on their way in.
   */
  const setFigure = (key: DashboardCardKey, value: string, isMoney = false): void => {
    const figure = part<HTMLElement>(key, '[data-dashboard-figure]')
    figure.textContent = value
    markMoney(figure, isMoney)
  }

  const setDetail = (key: DashboardCardKey, value: string): void => {
    part(key, '[data-dashboard-detail]').textContent = value
  }

  const setNote = (key: DashboardCardKey, value: string | null, needsAction = false): void => {
    const note = part<HTMLElement>(key, '[data-dashboard-note]')
    note.hidden = value === null
    note.textContent = value ?? ''
    note.dataset.tone = needsAction ? 'action' : 'calm'
  }

  /** Every currency stays separate, the way the reports it links to keep them. */
  const setCurrencies = (key: DashboardCardKey, rest: readonly CurrencyMoney[]): void => {
    const list = part<HTMLElement>(key, '[data-dashboard-currencies]')
    list.hidden = rest.length === 0
    list.replaceChildren(
      ...rest.map((money) => {
        const item = document.createElement('li')
        item.append(moneyText(formatReportMoney(money.cents, money.currency)))
        return item
      }),
    )
  }

  const clearCard = (key: DashboardCardKey): void => {
    setFigure(key, '—')
    setDetail(key, '')
    setCurrencies(key, [])
    setNote(key, null)
  }

  /**
   * A card the gate admitted and the data then contradicted. It leaves the page
   * rather than sitting there empty, for the same reason a shut gate never puts
   * it there in the first place.
   */
  const withdraw = (key: DashboardCardKey): void => {
    withdrawn.add(key)
    failed.delete(key)
    const element = cards.get(key)!
    element.hidden = true
    element.remove()
  }

  const failCard = (key: DashboardCardKey, error: unknown): void => {
    failed.add(key)
    clearCard(key)
    setDetail(
      key,
      error instanceof EzactoApiError && error.status === 403
        ? 'Your profile does not have access to this figure.'
        : 'This could not be loaded.',
    )
  }

  /**
   * Each card fails alone. One dead endpoint on a landing screen should cost the
   * reader that one figure, not the three beside it that answered.
   */
  const guard = async (
    key: DashboardCardKey,
    active: ActiveSession,
    load: () => Promise<void>,
  ): Promise<void> => {
    try {
      await load()
      failed.delete(key)
    } catch (error) {
      if (currentSession() !== active) return
      if (active.onSessionFailure(error) || active.signal.aborted) return
      failCard(key, error)
    }
  }

  const loadWeekCard = async (active: ActiveSession): Promise<void> => {
    const settings = await api.getTimeEntrySettings(active.signal)
    const range = weekRange(localDate(), settings.week_start_day)
    const entries = await api.listTimeEntries(range, active.signal)
    if (currentSession() !== active) return
    const seconds = trackedSeconds(entries)
    let submission: TimesheetSubmission | null = null
    if (api.listTimesheetSubmissions !== undefined) {
      const submissions = await api.listTimesheetSubmissions(
        range.from,
        range.to,
        active.signal,
      ).catch((error: unknown) => {
        if (absent(error)) return []
        throw error
      })
      if (currentSession() !== active) return
      submission =
        submissions.find(
          (value) => value.period_start === range.from && value.period_end === range.to,
        ) ?? null
    }
    const capacity = await weeklyCapacity(active)
    if (currentSession() !== active) return
    setFigure('week', formatReportHours(seconds))
    setDetail(
      'week',
      capacity === null
        ? `Tracked ${range.from} to ${range.to}.`
        : `Tracked ${range.from} to ${range.to}, against ${formatReportHours(capacity)} of capacity.`,
    )
    const standing = weekStanding(submission, seconds)
    setNote('week', standing.message, standing.needsAction)
  }

  /**
   * Capacity lives on the person record, which only the Team module serves and
   * only a profile that may read people can open -- so it is read behind that
   * section's own nav item, and a week without it is a week card with one fewer
   * clause rather than a blank where a number should be.
   */
  const capacityOffered = (): boolean => {
    const teamNav = document.querySelector<HTMLElement>('.primary-nav [data-team-nav]')
    return teamNav !== null && !teamNav.hidden && api.getTeamPerson !== undefined
  }

  const weeklyCapacity = async (active: ActiveSession): Promise<number | null> => {
    capacityRead = capacityOffered()
    if (!capacityRead || api.getTeamPerson === undefined) return null
    try {
      const person = await api.getTeamPerson(active.identity.user_id, active.signal)
      return person.weekly_capacity
    } catch {
      return null
    }
  }

  const loadApprovalsCard = async (active: ActiveSession): Promise<void> => {
    if (api.listPendingTimesheetSubmissions === undefined) {
      withdraw('approvals')
      return
    }
    const queue = await api.listPendingTimesheetSubmissions(undefined, active.signal)
    if (currentSession() !== active) return
    setFigure('approvals', queueCount(queue))
    setDetail(
      'approvals',
      queue.submissions.length === 0
        ? 'No timesheet is waiting for your approval.'
        : 'Submitted timesheets waiting for your approval.',
    )
    setNote(
      'approvals',
      queue.submissions.length === 0 ? null : 'Someone is waiting on this.',
      true,
    )
  }

  const loadUninvoicedCard = async (active: ActiveSession): Promise<void> => {
    if (api.getUninvoicedReport === undefined) {
      withdraw('uninvoiced')
      return
    }
    const range = uninvoicedWindow(localDate())
    const report = await api.getUninvoicedReport(range, active.signal)
    if (currentSession() !== active) return
    const totals = uninvoicedTotals(report)
    // The gate said this profile may see company money and the server withheld
    // it anyway. The server is the authority, so the card leaves rather than
    // standing there with a dash where an amount belongs.
    if (totals.length === 0 && report.totals.length > 0) {
      withdraw('uninvoiced')
      return
    }
    part<HTMLAnchorElement>('uninvoiced', '[data-dashboard-link]').href =
      uninvoicedReportHref(range)
    const [largest, ...rest] = totals
    setFigure(
      'uninvoiced',
      largest === undefined ? 'None' : formatReportMoney(largest.cents, largest.currency),
      largest !== undefined,
    )
    setDetail(
      'uninvoiced',
      largest === undefined
        ? `Nothing is waiting to be invoiced in the last ${uninvoicedWindowDays} days.`
        : `Billable work not yet on an invoice, last ${uninvoicedWindowDays} days.`,
    )
    setCurrencies('uninvoiced', rest)
    setNote('uninvoiced', null)
  }

  const loadOwedCard = async (active: ActiveSession): Promise<void> => {
    if (api.listInvoices === undefined) {
      withdraw('owed')
      return
    }
    const invoices: Invoice[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await api.listInvoices(cursor, active.signal, invoicePageSize)
      if (currentSession() !== active) return
      invoices.push(...page.data)
      cursor = page.page.next_cursor ?? undefined
      pages += 1
    } while (cursor !== undefined && pages < invoicePageLimit)
    // The endpoint pages ascending by id, and offers no other order, so a walk
    // that stops short has read the OLDEST invoices -- the settled end of the
    // book. That slice is not a receivables figure and no caption can make it
    // one: an account past the ceiling would be told nothing is owed while its
    // whole book is outstanding. So the card gives no number and says why.
    if (cursor !== undefined) {
      clearCard('owed')
      setDetail(
        'owed',
        'More invoices than this screen can total. Open invoices to see what is owed.',
      )
      return
    }
    const obligations = invoiceObligations(invoices, localDate())
    const open = obligations.reduce((total, value) => total + value.openCount, 0)
    const [largest, ...rest] = obligations
    setFigure(
      'owed',
      largest === undefined ? 'None' : formatReportMoney(largest.dueCents, largest.currency),
      largest !== undefined,
    )
    setDetail(
      'owed',
      open === 0
        ? 'No open invoice is unpaid.'
        : `Unpaid on ${dashboardCount(open, 'open invoice')}.`,
    )
    setCurrencies(
      'owed',
      rest.map((value) => ({ currency: value.currency, cents: value.dueCents })),
    )
    const overdue = obligations.reduce((total, value) => total + value.overdueCount, 0)
    setNote('owed', overdue === 0 ? null : `${dashboardCount(overdue, 'invoice')} past due.`, true)
  }

  const loaderFor = (
    key: DashboardCardKey,
  ): ((active: ActiveSession) => Promise<void>) =>
    key === 'week'
      ? loadWeekCard
      : key === 'approvals'
        ? loadApprovalsCard
        : key === 'uninvoiced'
          ? loadUninvoicedCard
          : loadOwedCard

  /**
   * The cards a profile cannot see are never put on the page. They are re-hung
   * rather than destroyed so a second session in the same document gets the set
   * its own profile earns.
   */
  /**
   * Everything the DOM currently permits, as one value to compare against. The
   * card set alone would miss the Team module answering after the first pass,
   * which is the difference between a week card that names your capacity and
   * one that quietly never does.
   */
  const gateSignature = (): string =>
    `${dashboardCards.filter(offers).map((card) => card.key).join(',')}|${capacityOffered()}`

  /**
   * Re-hangs the set the gates currently permit, and answers with the cards
   * that still owe a read: the ones this session has not sent for, plus the
   * week card when the capacity gate moved under it. A gate that opens late
   * costs the figure it admits, not the three already on the page beside it.
   */
  const layOutCards = (): readonly DashboardCard[] => {
    signature = gateSignature()
    gated = dashboardCards.filter(offers)
    for (const card of dashboardCards) {
      const element = cards.get(card.key)!
      element.hidden = !gated.includes(card)
      // A card that leaves the gated set takes its failure with it. Without
      // this the status went on counting a card the page no longer shows, and
      // Retry could never clear it: layOutCards will not return an ungated
      // card, so nothing re-ran and nothing removed the key. Dropping its read
      // mark too means a gate that reopens loads fresh rather than restoring a
      // card that was cleared while it was away.
      if (element.hidden) {
        failed.delete(card.key)
        read.delete(card.key)
      }
    }
    container.replaceChildren(...gated.map((card) => cards.get(card.key)!))
    return gated.filter(
      (card) =>
        !read.has(card.key) || (card.key === 'week' && capacityRead !== capacityOffered()),
    )
  }

  const load = async (): Promise<void> => {
    const active = currentSession()
    if (active === null) return
    // A gate that opens while the first pass is in flight is the normal case,
    // not the exception: the nav settles on its module probes, which answer
    // after this screen starts. Dropping that pass would leave the card the
    // gate just admitted permanently empty, so it is queued instead.
    if (loading) {
      queued = true
      return
    }
    loading = true
    try {
      do {
        queued = false
        retry.hidden = true
        const loadable = layOutCards()
        if (loadable.length === 0) continue
        for (const card of loadable) {
          read.add(card.key)
          clearCard(card.key)
        }
        status.textContent = 'Loading where things stand…'
        await Promise.all(
          loadable.map((card) => guard(card.key, active, () => loaderFor(card.key)(active))),
        )
        if (currentSession() !== active) return
      } while (queued)
    } finally {
      loading = false
    }
    status.textContent =
      failed.size === 0
        ? ''
        : `${dashboardCount(failed.size, 'card')} could not be loaded.`
    retry.hidden = failed.size === 0
  }

  /**
   * The nav's gates settle after their module and permission probes answer,
   * which is after this controller starts. Watching the nav rather than racing
   * it is what keeps the read one rule: when Approvals appears, its card
   * appears with it, and neither is decided here.
   */
  const watchGates = (signal: AbortSignal): void => {
    if (navigation === null) return
    const observer = new MutationObserver(() => {
      if (currentSession() === null || gateSignature() === signature) return
      void load()
    })
    observer.observe(navigation, {
      attributes: true,
      attributeFilter: ['hidden'],
      subtree: true,
    })
    signal.addEventListener('abort', () => observer.disconnect(), { once: true })
  }

  retry.addEventListener('click', () => {
    // Retry is for the cards that failed. The ones that answered keep their
    // figures and cost nothing to keep.
    for (const key of failed) read.delete(key)
    void load()
  })

  return {
    async activate(identity, signal, onSessionFailure) {
      if (!dashboardPage) return
      session = { identity, signal, onSessionFailure }
      loading = false
      queued = false
      capacityRead = false
      read.clear()
      failed.clear()
      withdrawn.clear()
      signal.addEventListener(
        'abort',
        () => {
          if (session?.signal !== signal) return
          session = null
          gated = []
          retry.hidden = true
          for (const card of dashboardCards) clearCard(card.key)
          status.textContent = 'Sign in to see where things stand.'
        },
        { once: true },
      )
      watchGates(signal)
      await load()
    },
  }
}
