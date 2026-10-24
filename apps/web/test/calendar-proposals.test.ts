/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import {
  EzactoApiError,
  type CalendarProposal,
  type CalendarProposalPage,
} from '@conflict-hq/ezacto-client'
import {
  createCalendarProposalController,
  type CalendarProposalApi,
} from '../src/calendar-proposals/browser.js'
import {
  proposalBlocks,
  proposalTimeZone,
  proposalReviewFields,
} from '../src/calendar-proposals/model.js'

const proposal = (id = 1, patch: Partial<CalendarProposal> = {}): CalendarProposal => ({
  id,
  provider: 'google',
  calendar_id: 'owned-calendar',
  event_id: `owned-${id}`,
  occurrence: '',
  title: 'Private planning',
  starts_at: '2026-08-27T15:00:00.000Z',
  ends_at: '2026-08-27T16:00:00.000Z',
  status: 'proposed',
  time_entry_id: null,
  decided_at: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  ...patch,
})
const page = (rows: CalendarProposal[], cursor: string | null = null) =>
  ({ data: rows, links: {}, page: { next_cursor: cursor } }) as CalendarProposalPage
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const setup = (patch: Partial<CalendarProposalApi> = {}) => {
  document.body.innerHTML =
    '<aside data-calendar-proposals hidden><p data-proposal-status></p><button data-proposal-retry hidden>Retry</button></aside>'
  const root = document.querySelector<HTMLElement>('aside')!
  const api = {
    listCalendarProposals: vi.fn(
      async (query: Parameters<CalendarProposalApi['listCalendarProposals']>[0]) =>
        page(query.status === undefined || query.status === 'proposed' ? [proposal()] : []),
    ),
    acceptCalendarProposal: vi.fn(async () =>
      proposal(1, { status: 'accepted', time_entry_id: 41 }),
    ),
    discardCalendarProposal: vi.fn(async () => proposal(1, { status: 'discarded' })),
    ...patch,
  }
  const changed = vi.fn(),
    auth = new AbortController()
  const controller = createCalendarProposalController(api, {
    root,
    changed,
    message: (error) => String((error as Error).message),
  })
  const context = {
    userId: 1,
    dates: ['2026-08-27', '2026-08-28'],
    timeZone: 'America/Costa_Rica',
    signal: auth.signal,
    onSessionFailure: vi.fn(() => false),
  }
  return { api, root, controller, changed, auth, context }
}
const loaded = async (controller: ReturnType<typeof createCalendarProposalController>, count = 1) =>
  vi.waitFor(() => expect(controller.proposals()).toHaveLength(count))
const choice = { project_id: 2, task_id: 2, notes: 'Reviewed meeting' }
afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

it('requires an authoritative zone without guessing an unset legacy profile', () => {
  expect(proposalTimeZone({ timezone: 'UTC' })).toBeNull()
  expect(proposalTimeZone({ timezone: 'invalid' })).toBeNull()
  expect(proposalTimeZone({ timezone: 'UTC', effective_timezone: 'UTC' })).toBe('UTC')
  expect(proposalTimeZone({ timezone: 'UTC', effective_timezone: 'America/Costa_Rica' })).toBe(
    'America/Costa_Rica',
  )
  expect(proposalTimeZone({ timezone: 'Europe/Madrid' })).toBe('Europe/Madrid')
})
it('projects source instants in the owner zone without changing acceptance duration or dates', () => {
  const item = proposal(1, {
    starts_at: '2026-08-28T05:30:00.000Z',
    ends_at: '2026-08-28T07:00:00.000Z',
  })
  expect(proposalReviewFields(item, 'America/Costa_Rica')).toEqual({
    date: '2026-08-27',
    seconds: 5400,
    times: { started: '23:30', ended: '01:00' },
  })
  const blocks = proposalBlocks([item], ['2026-08-27', '2026-08-28'], 'America/Costa_Rica')
  expect(blocks.map(({ date, start, end }) => ({ date, start, end }))).toEqual([
    { date: '2026-08-27', start: 1410, end: 1440 },
    { date: '2026-08-28', start: 0, end: 60 },
  ])
})
it('does not load while inactive or when the older backend cannot resolve a zone', async () => {
  const f = setup()
  f.controller.sync(null)
  f.controller.sync({ ...f.context, timeZone: null })
  expect(f.api.listCalendarProposals).not.toHaveBeenCalled()
  expect(f.root.textContent).toContain('effective timezone')
})
it('loads every page for the own date range and never sends a target user', async () => {
  const list = vi
    .fn()
    .mockResolvedValueOnce(page([proposal(1)], 'next'))
    .mockResolvedValueOnce(page([proposal(2)]))
  const f = setup({ listCalendarProposals: list })
  f.controller.sync(f.context)
  await loaded(f.controller, 2)
  expect(list).toHaveBeenNthCalledWith(
    1,
    { from: '2026-08-27', to: '2026-08-28', status: 'proposed', per_page: 200 },
    expect.any(AbortSignal),
  )
  expect(list.mock.calls[1]![0]).toMatchObject({ cursor: 'next' })
  expect(list.mock.calls[0]![0]).not.toHaveProperty('user_id')
})
it('rejects repeated cursors as a whole-list error and retries without retaining partial private rows', async () => {
  const list = vi
    .fn()
    .mockResolvedValueOnce(page([proposal(1)], 'repeat'))
    .mockResolvedValueOnce(page([proposal(2)], 'repeat'))
    .mockResolvedValueOnce(page([proposal(3)]))
  const f = setup({ listCalendarProposals: list })
  f.controller.sync(f.context)
  await vi.waitFor(() => expect(f.root.textContent).toContain('invalid cursor'))
  expect(f.controller.proposals()).toEqual([])
  f.root.querySelector<HTMLButtonElement>('button')!.click()
  await loaded(f.controller)
  expect(f.controller.proposals()[0]!.id).toBe(3)
})
it('ignores old-owner and old-range replies and clears immediately when the session aborts', async () => {
  const old = deferred<CalendarProposalPage>()
  const list = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(page([proposal(2)]))
  const f = setup({ listCalendarProposals: list })
  f.controller.sync(f.context)
  f.controller.sync({ ...f.context, userId: 2, dates: ['2026-09-01'] })
  await loaded(f.controller)
  old.resolve(page([proposal(1)]))
  await Promise.resolve()
  expect(f.controller.proposals()[0]!.id).toBe(2)
  f.auth.abort()
  expect(f.controller.proposals()).toEqual([])
  expect(f.root.hidden).toBe(true)
  expect(f.root.textContent).not.toContain('Private planning')
})
it('ignores an older same-range reload after an atomic decision', async () => {
  const old = deferred<CalendarProposalPage>()
  const list = vi
    .fn()
    .mockResolvedValueOnce(page([proposal()]))
    .mockReturnValueOnce(old.promise)
  const f = setup({ listCalendarProposals: list })
  f.controller.sync(f.context)
  await loaded(f.controller)
  const reload = f.controller.reload()
  expect(await f.controller.accept(1, choice)).toMatchObject({ status: 'accepted' })
  old.resolve(page([proposal()]))
  await reload
  expect(f.controller.proposals()).toEqual([])
})
it('dispatches one atomic acceptance while pending and removes only the confirmed proposal', async () => {
  const accepted = deferred<CalendarProposal>()
  const accept = vi.fn(() => accepted.promise)
  const f = setup({ acceptCalendarProposal: accept })
  f.controller.sync(f.context)
  await loaded(f.controller)
  const pending = f.controller.accept(1, choice)
  expect(await f.controller.accept(1, choice)).toEqual({ status: 'stale' })
  expect(await f.controller.discard(1)).toEqual({ status: 'stale' })
  accepted.resolve(proposal(1, { status: 'accepted', time_entry_id: 41 }))
  expect(await pending).toMatchObject({ status: 'accepted', proposal: { time_entry_id: 41 } })
  expect(accept).toHaveBeenCalledTimes(1)
  expect(accept).toHaveBeenCalledWith(1, choice, expect.any(AbortSignal))
  expect(f.controller.proposals()).toEqual([])
})
it('reconciles a malformed successful reply through an own read without accepting twice', async () => {
  const list = vi
    .fn()
    .mockResolvedValueOnce(page([proposal()]))
    .mockResolvedValueOnce(page([proposal(1, { status: 'accepted', time_entry_id: 41 })]))
  const accept = vi.fn(async () => undefined as unknown as CalendarProposal)
  const f = setup({ listCalendarProposals: list, acceptCalendarProposal: accept })
  f.controller.sync(f.context)
  await loaded(f.controller)
  expect(await f.controller.accept(1, choice)).toMatchObject({
    status: 'accepted',
    proposal: { time_entry_id: 41 },
  })
  expect(list.mock.calls[1]![0]).toHaveProperty('status', 'accepted')
  expect(accept).toHaveBeenCalledTimes(1)
})
it('requires an explicit status check after an uncertain outcome before retrying the atomic endpoint', async () => {
  const accept = vi
    .fn()
    .mockRejectedValueOnce(new Error('Connection lost'))
    .mockResolvedValueOnce(proposal(1, { status: 'accepted', time_entry_id: 41 }))
  const f = setup({ acceptCalendarProposal: accept })
  f.controller.sync(f.context)
  await loaded(f.controller)
  expect(await f.controller.accept(1, choice)).toMatchObject({ status: 'unconfirmed' })
  expect(await f.controller.accept(1, choice)).toMatchObject({ status: 'unconfirmed' })
  expect(accept).toHaveBeenCalledTimes(1)
  expect(await f.controller.check(1)).toEqual({ status: 'open' })
  expect(await f.controller.accept(1, choice)).toMatchObject({ status: 'accepted' })
  expect(accept).toHaveBeenCalledTimes(2)
})
it('discards through its own endpoint and never calls accept', async () => {
  const f = setup()
  f.controller.sync(f.context)
  await loaded(f.controller)
  expect(await f.controller.discard(1)).toMatchObject({ status: 'discarded' })
  expect(f.api.discardCalendarProposal).toHaveBeenCalledTimes(1)
  expect(f.api.acceptCalendarProposal).not.toHaveBeenCalled()
})
it('leaves lock and note-policy errors actionable after confirming the proposal is still open', async () => {
  const error = new EzactoApiError(
    422,
    { error: { code: 'time_entry_locked', message: 'This period is locked.', fields: [] } },
    null,
  )
  const f = setup({
    acceptCalendarProposal: vi.fn(async () => {
      throw error
    }),
  })
  f.controller.sync(f.context)
  await loaded(f.controller)
  await expect(f.controller.accept(1, choice)).rejects.toBe(error)
  expect(f.controller.proposals()).toHaveLength(1)
  expect(f.controller.pending()).toBe(false)
})
it('clears proposal rows and disables review when availability is withdrawn', async () => {
  const list = vi
    .fn()
    .mockResolvedValueOnce(page([proposal()]))
    .mockRejectedValueOnce(
      new EzactoApiError(
        403,
        { error: { code: 'module_unavailable', message: 'Not available', fields: [] } },
        null,
      ),
    )
  const f = setup({ listCalendarProposals: list })
  f.controller.sync(f.context)
  await loaded(f.controller)
  await f.controller.reload()
  expect(f.controller.proposals()).toEqual([])
  expect(f.controller.canReview()).toBe(false)
})

it('renders provisional clock buttons without saved totals, entry drag identities or resize writes', async () => {
  const { createCalendarController } = await import('../src/calendar/browser.js')
  document.body.innerHTML =
    '<section data-calendar-week><p data-calendar-status></p><p data-calendar-live></p><div data-calendar-grid></div></section>'
  const review = vi.fn(),
    create = vi.fn(),
    move = vi.fn(async () => {})
  const calendar = createCalendarController({
    openEntry: vi.fn(),
    createEntry: create,
    moveEntry: move,
    stepDay: vi.fn(),
    now: () => ({ date: '2026-08-27', minutes: 600 }),
    reviewProposal: review,
  })
  try {
    calendar.render({
      dates: ['2026-08-27'],
      selectedDate: '2026-08-27',
      entries: [],
      layout: 'week',
      now: { date: '2026-08-27', minutes: 600 },
      clock: '24h',
      formatSeconds: (seconds) => `${seconds} saved seconds`,
      proposals: proposalBlocks([proposal()], ['2026-08-27'], 'America/Costa_Rica'),
      proposalTimeZone: 'America/Costa_Rica',
    })
    const block = document.querySelector<HTMLButtonElement>('[data-calendar-proposal]')!
    expect(block.getAttribute('aria-label')).toContain('Not saved time')
    expect(block.style.getPropertyValue('--cal-start')).toBe('540')
    expect(block.hasAttribute('data-calendar-entry')).toBe(false)
    expect(block.querySelector('[data-calendar-handle]')).toBeNull()
    expect(document.querySelector('.cal-head-total')!.textContent).toBe('0 saved seconds')
    block.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    block.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    block.click()
    expect(review).toHaveBeenCalledWith(1, block)
    expect(create).not.toHaveBeenCalled()
    expect(move).not.toHaveBeenCalled()
  } finally {
    calendar.clear()
  }
})

it('reuses the shared editor but accepts only through the atomic proposal endpoint', async () => {
  const { browserApi, mountShell, renderBrowserShell, timeEntry } =
    await import('./support/shell-harness.js')
  const api = browserApi(30)
  let current = proposal()
  api.getProfile = vi.fn(async () => ({
    user_id: 1,
    timezone: 'UTC',
    effective_timezone: 'America/Costa_Rica',
  }))
  api.listCalendarProposals = vi.fn(async (query) =>
    page(query.status === 'proposed' && current.status !== 'proposed' ? [] : [current]),
  )
  api.acceptCalendarProposal = vi.fn(async () => {
    current = proposal(1, { status: 'accepted', time_entry_id: 41 })
    api.entries.push(
      timeEntry(41, { project_id: 1, task_id: 1, spent_date: '2026-08-27', seconds: 3600 }),
    )
    return current
  })
  api.discardCalendarProposal = vi.fn(async () => proposal(1, { status: 'discarded' }))
  renderBrowserShell()
  history.replaceState(null, '', '/?view=calendar&week=2026-08-27')
  document.documentElement.dataset.timeView = 'calendar'
  await mountShell(api)
  await vi.waitFor(() =>
    expect(document.querySelector('[data-calendar-proposal="1"]')).not.toBeNull(),
  )
  document.querySelector<HTMLButtonElement>('[data-calendar-proposal="1"]')!.click()
  const project = document.querySelector<HTMLSelectElement>('[data-entry-project]')!
  const task = document.querySelector<HTMLSelectElement>('[data-entry-task]')!
  expect(project.value).toBe('')
  expect(task.value).toBe('')
  expect(document.querySelector<HTMLInputElement>('[data-entry-date]')!.readOnly).toBe(true)
  expect(document.querySelector<HTMLInputElement>('[data-entry-duration-input]')!.readOnly).toBe(
    true,
  )
  project.value = 'Northpeak'
  project.dispatchEvent(new Event('change'))
  task.value = 'Development'
  task.dispatchEvent(new Event('change'))
  document
    .querySelector<HTMLFormElement>('[data-entry-form]')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  expect(api.acceptCalendarProposal).not.toHaveBeenCalled()
  expect(document.querySelector('[data-entry-result]')!.textContent).toContain('30')
  document.querySelector<HTMLTextAreaElement>('[data-entry-note-input]')!.value =
    'Reviewed calendar proposal with full meeting detail'
  document
    .querySelector<HTMLFormElement>('[data-entry-form]')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(api.acceptCalendarProposal).toHaveBeenCalledTimes(1))
  expect(api.acceptCalendarProposal).toHaveBeenCalledWith(
    1,
    { project_id: 1, task_id: 1, notes: 'Reviewed calendar proposal with full meeting detail' },
    expect.any(AbortSignal),
  )
  expect(api.createTimeEntry).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(document.querySelector('[data-calendar-proposal="1"]')).toBeNull())
  expect(api.entries.filter((entry) => entry.id === 41)).toHaveLength(1)
})
it('adds no proposal reads to the normal week even when the API supports them', async () => {
  const { browserApi, mountShell, renderBrowserShell } = await import('./support/shell-harness.js')
  const api = browserApi()
  api.listCalendarProposals = vi.fn(async () => page([proposal()]))
  api.acceptCalendarProposal = vi.fn(async () => proposal())
  api.discardCalendarProposal = vi.fn(async () => proposal())
  renderBrowserShell()
  document.documentElement.dataset.timeView = 'week'
  await mountShell(api)
  expect(api.listCalendarProposals).not.toHaveBeenCalled()
  expect(document.querySelector<HTMLElement>('[data-calendar-proposals]')!.hidden).toBe(true)
})

it('can reconcile around older accepted proposals whose linked entry was deleted', async () => {
  const list = vi
    .fn()
    .mockResolvedValueOnce(page([proposal()]))
    .mockResolvedValueOnce(
      page([
        proposal(2, { status: 'accepted', time_entry_id: null }),
        proposal(1, { status: 'accepted', time_entry_id: 41 }),
      ]),
    )
  const accept = vi.fn(async () => undefined as unknown as CalendarProposal)
  const f = setup({ listCalendarProposals: list, acceptCalendarProposal: accept })
  f.controller.sync(f.context)
  await loaded(f.controller)
  expect(await f.controller.accept(1, choice)).toMatchObject({
    status: 'accepted',
    proposal: { time_entry_id: 41 },
  })
  expect(accept).toHaveBeenCalledTimes(1)
})
it('does not recreate an already accepted proposal after its linked entry was removed', async () => {
  const list = vi
    .fn()
    .mockResolvedValueOnce(page([proposal()]))
    .mockResolvedValueOnce(page([proposal(1, { status: 'accepted', time_entry_id: null })]))
  const accept = vi.fn(async () => undefined as unknown as CalendarProposal)
  const f = setup({ listCalendarProposals: list, acceptCalendarProposal: accept })
  f.controller.sync(f.context)
  await loaded(f.controller)
  expect(await f.controller.accept(1, choice)).toMatchObject({
    status: 'accepted',
    proposal: { time_entry_id: null },
  })
  expect(f.controller.proposals()).toEqual([])
  expect(await f.controller.accept(1, choice)).toEqual({ status: 'stale' })
  expect(accept).toHaveBeenCalledTimes(1)
})
