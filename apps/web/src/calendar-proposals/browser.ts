import {
  EzactoApiError,
  type CalendarProposal,
  type CalendarProposalAcceptInput,
  type CalendarProposalPage,
} from '@conflict-hq/ezacto-client'

export interface CalendarProposalApi {
  listCalendarProposals(
    query: {
      from: string
      to: string
      status?: CalendarProposal['status']
      cursor?: string
      per_page: number
    },
    signal?: AbortSignal,
  ): Promise<CalendarProposalPage>
  acceptCalendarProposal(
    id: number,
    input: CalendarProposalAcceptInput,
    signal?: AbortSignal,
  ): Promise<CalendarProposal>
  discardCalendarProposal(id: number, signal?: AbortSignal): Promise<CalendarProposal>
}
export interface ProposalContext {
  readonly userId: number
  readonly dates: readonly string[]
  readonly timeZone: string | null
  readonly signal: AbortSignal
  readonly onSessionFailure: (error: unknown) => boolean
}
export type ProposalDecision =
  | { readonly status: 'accepted' | 'discarded' | 'cancelled'; readonly proposal: CalendarProposal }
  | { readonly status: 'unconfirmed'; readonly message: string }
  | { readonly status: 'open' | 'stale' }

const isProposal = (item: CalendarProposal): boolean =>
  item !== null &&
  typeof item === 'object' &&
  Number.isSafeInteger(item.id) &&
  item.id > 0 &&
  typeof item.title === 'string' &&
  Number.isFinite(Date.parse(item.starts_at)) &&
  Date.parse(item.ends_at) > Date.parse(item.starts_at) &&
  ['proposed', 'accepted', 'discarded', 'cancelled'].includes(item.status) &&
  (item.time_entry_id === null ||
    (Number.isSafeInteger(item.time_entry_id) && item.time_entry_id! > 0))

export const createCalendarProposalController = (
  api: Partial<CalendarProposalApi>,
  host: {
    readonly root: HTMLElement
    readonly changed: () => void
    readonly message: (error: unknown) => string
  },
) => {
  const status = host.root.querySelector<HTMLElement>('[data-proposal-status]')!
  const retry = host.root.querySelector<HTMLButtonElement>('[data-proposal-retry]')!
  let context: ProposalContext | null = null
  let key = ''
  let controller = new AbortController()
  let detach = () => {}
  let proposals: readonly CalendarProposal[] = []
  let pending = false
  let denied = false
  let loadRevision = 0
  const uncertain = new Set<number>()
  const available = () =>
    api.listCalendarProposals !== undefined &&
    api.acceptCalendarProposal !== undefined &&
    api.discardCalendarProposal !== undefined
  const current = (signal: AbortSignal) =>
    context !== null && !context.signal.aborted && !signal.aborted && controller.signal === signal
  const clear = () => {
    loadRevision++
    controller.abort()
    detach()
    detach = () => {}
    context = null
    key = ''
    proposals = []
    pending = false
    denied = false
    uncertain.clear()
    status.textContent = ''
    retry.hidden = true
    host.root.hidden = true
  }
  const read = async (
    signal: AbortSignal,
    requestedStatus: CalendarProposal['status'],
  ): Promise<readonly CalendarProposal[]> => {
    const range = context!
    const rows: CalendarProposal[] = []
    const ids = new Set<number>(),
      cursors = new Set<string>()
    let cursor: string | undefined
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await api.listCalendarProposals!(
        {
          from: range.dates[0]!,
          to: range.dates.at(-1)!,
          per_page: 200,
          status: requestedStatus,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      )
      if (!current(signal)) return []
      if (
        !Array.isArray(page?.data) ||
        page.page === null ||
        typeof page.page !== 'object' ||
        page.page.next_cursor === undefined
      )
        throw new Error('Calendar proposals returned an incomplete page. Retry the list.')
      for (const item of page.data) {
        if (!isProposal(item) || ids.has(item.id))
          throw new Error('Calendar proposals changed while loading. Retry the list.')
        ids.add(item.id)
        rows.push(item)
      }
      const next = page.page.next_cursor
      if (next === null) return rows
      if (typeof next !== 'string' || next === '' || cursors.has(next))
        throw new Error('Calendar proposals returned an invalid cursor. Retry the list.')
      cursors.add(next)
      cursor = next
    }
    throw new Error('Too many calendar proposals to load safely. Retry a smaller date range.')
  }
  const summary = () => {
    status.textContent =
      proposals.length === 0
        ? 'No proposed calendar events for these dates.'
        : 'Proposed events are suggestions, not saved time. Review one to accept or discard it.'
  }
  const load = async () => {
    if (context === null || context.timeZone === null || !available() || pending) return
    const signal = controller.signal
    const revision = ++loadRevision
    denied = false
    status.textContent = 'Loading calendar proposals…'
    retry.hidden = true
    try {
      const rows = await read(signal, 'proposed')
      if (!current(signal) || revision !== loadRevision) return
      proposals = rows.filter((item) => item.status === 'proposed')
      summary()
      host.changed()
    } catch (error) {
      if (!current(signal) || revision !== loadRevision || context?.onSessionFailure(error)) return
      proposals = []
      denied = error instanceof EzactoApiError && (error.status === 403 || error.status === 404)
      status.textContent = host.message(error)
      retry.hidden = false
      host.changed()
    }
  }
  const reconcile = async (id: number): Promise<ProposalDecision> => {
    if (context === null) return { status: 'stale' }
    const signal = controller.signal
    try {
      let found: CalendarProposal | undefined
      // Omitting status defaults to proposed on this API. Reconcile explicitly
      // through each own-person status, including already accepted decisions.
      for (const state of ['accepted', 'discarded', 'cancelled', 'proposed'] as const) {
        const rows = await read(signal, state)
        if (!current(signal)) return { status: 'stale' }
        found = rows.find((item) => item.id === id && item.status === state)
        if (found !== undefined) break
      }
      if (found === undefined)
        return {
          status: 'unconfirmed',
          message: 'The decision is not confirmed. Check its status again before retrying.',
        }
      if (found.status === 'proposed') return { status: 'open' }
      proposals = proposals.filter((item) => item.id !== id)
      summary()
      host.changed()
      return { status: found.status, proposal: found }
    } catch (error) {
      if (!current(signal) || context?.onSessionFailure(error)) return { status: 'stale' }
      if (error instanceof EzactoApiError && (error.status === 403 || error.status === 404)) {
        denied = true
        proposals = []
        status.textContent = host.message(error)
        host.changed()
      }
      return {
        status: 'unconfirmed',
        message: `The decision is not confirmed. ${host.message(error)}`,
      }
    }
  }
  const decide = async (
    id: number,
    input: CalendarProposalAcceptInput | null,
  ): Promise<ProposalDecision> => {
    if (uncertain.has(id))
      return {
        status: 'unconfirmed',
        message: 'Check proposal status before retrying this decision.',
      }
    if (context === null || pending || !proposals.some((item) => item.id === id))
      return { status: 'stale' }
    const signal = controller.signal
    pending = true
    // A list begun before this decision must never resurrect its old rows.
    loadRevision++
    try {
      const found =
        input === null
          ? await api.discardCalendarProposal!(id, signal)
          : await api.acceptCalendarProposal!(id, input, signal)
      if (!current(signal)) return { status: 'stale' }
      if (
        !isProposal(found) ||
        found.id !== id ||
        found.status !== (input === null ? 'discarded' : 'accepted') ||
        (input !== null && found.time_entry_id === null)
      ) {
        const checked = await reconcile(id)
        return checked.status === 'open'
          ? {
              status: 'unconfirmed',
              message:
                'The server response did not confirm this decision. Check its status before retrying.',
            }
          : checked
      }
      proposals = proposals.filter((item) => item.id !== id)
      summary()
      host.changed()
      return { status: found.status as 'accepted' | 'discarded', proposal: found }
    } catch (error) {
      if (!current(signal) || context?.onSessionFailure(error)) return { status: 'stale' }
      const outcome = await reconcile(id)
      if (outcome.status !== 'open') return outcome
      if (error instanceof EzactoApiError && error.status >= 400 && error.status < 500) throw error
      return {
        status: 'unconfirmed',
        message:
          'The decision is not confirmed. Check its status before retrying; do not log a separate time entry.',
      }
    } finally {
      if (current(signal)) pending = false
    }
  }
  const mutate = async (id: number, input: CalendarProposalAcceptInput | null) => {
    const result = await decide(id, input)
    if (result.status === 'unconfirmed') uncertain.add(id)
    return result
  }
  retry.addEventListener('click', () => void load())
  return {
    proposals: () => proposals,
    canReview: () => !denied,
    pending: () => pending,
    reload: load,
    unconfirmed: (id: number) => uncertain.has(id),
    check: async (id: number) => {
      const result = await reconcile(id)
      if (
        result.status === 'open' ||
        result.status === 'accepted' ||
        result.status === 'discarded' ||
        result.status === 'cancelled'
      )
        uncertain.delete(id)
      return result
    },
    accept: (id: number, input: CalendarProposalAcceptInput) => mutate(id, input),
    discard: (id: number) => mutate(id, null),
    clear,
    sync(next: ProposalContext | null) {
      if (next === null || next.signal.aborted || !available()) {
        clear()
        return
      }
      const nextKey = JSON.stringify([next.userId, next.dates, next.timeZone])
      if (key === nextKey && context?.signal === next.signal) return
      clear()
      context = next
      key = nextKey
      controller = new AbortController()
      const abort = () => {
        clear()
        host.changed()
      }
      next.signal.addEventListener('abort', abort, { once: true })
      detach = () => next.signal.removeEventListener('abort', abort)
      host.root.hidden = false
      if (next.timeZone === null) {
        status.textContent =
          'Your calendar timezone is unavailable. Refresh the page, check your Profile timezone, or ask an administrator for help.'
        return
      }
      void load()
    },
  }
}
