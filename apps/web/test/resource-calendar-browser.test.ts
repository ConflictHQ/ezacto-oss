/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResourceCalendar } from '@conflict-hq/ezacto-client'
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { createCapacityController } from '../src/capacity/browser.js'
import { renderCapacityPage } from '../src/capacity/render.js'
import { calendarPages, calendarWindow, timelinePosition, type ResourceCalendarApi } from '../src/capacity/resource-calendar-model.js'
import type { CapacityApi, PlanningApi } from '../src/capacity/model.js'
import type { PlaceholderPlanningApi } from '../src/capacity/placeholder-model.js'

const context = { time_zone: 'America/Los_Angeles', week_start_day: 'monday', today: '2026-10-04', current_week_start: '2026-09-28' } as const
const projection = (id = 3): ResourceCalendar => ({
  context, revision: 'owned-projection', view: 'team', week_starts: ['2026-09-28'], has_other_scope: true, unassigned_truncated: false,
  people: [{ person_id: id, name: `Owned Person ${id}`, weeks: [{ week_start: '2026-09-28', planned_seconds: 36000, available_seconds: 18000, tracked_seconds: 4442, person_planned_seconds: 72000, person_other_scope_planned_seconds: 36000, over_allocated: true, projects: [{ project_id: 7, planned_seconds: 36000 }], other_scope_planned_seconds: 36000, other_scope_tracked_seconds: 0 }] }],
  unassigned: [{ week_start: '2026-09-28', placeholder_id: 8, name: 'Unassigned design', project_id: 7, planned_seconds: 7200 }],
})
const fixture = () => ({
  context: vi.fn(async () => ({ data: context })),
  read: vi.fn(async () => ({ data: projection(), page: { next_cursor: null as string | null } })),
  projects: vi.fn(async () => ({ data: [{ id: 7, name: 'Owned project', is_active: true }], page: { next_cursor: null } })),
  allocations: vi.fn(async () => ({ data: [{ id: 6, version: 2, user_id: 3, project_id: 7, project_name: 'Owned project', start_date: '2026-10-01', end_date: '2026-10-02', planned_seconds_per_week: 36000 }], page: { next_cursor: null } })),
})
const mount = (api: ResourceCalendarApi, legacy: Pick<CapacityApi, 'planning' | 'placeholders'> = {}) => {
  document.body.innerHTML = renderCapacityPage('capacity')
  const old = vi.fn(async () => { throw new Error('Legacy capacity must not be read') })
  return { controller: createCapacityController({ ...legacy, calendar: api, getCapacity: old }), old }
}
const input = (label: string) => [...document.querySelectorAll('label')].find(node => node.firstChild?.textContent === label)!.querySelector('select')!
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('native calendar browser view', () => {
  it('does not construct or read the lazy calendar after activation is aborted during module loading', async () => {
    const api = fixture(), { controller } = mount(api), session = new AbortController()
    const pending = controller.activate(session.signal)
    session.abort(); await pending
    expect(api.context).not.toHaveBeenCalled()
    expect(document.querySelector('.resource-calendar-controls')).toBeNull()
  })
  it('uses organization date context and separates plan, availability, rounded actuals and unassigned demand', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2035-01-01T23:59:00.000Z'))
    const api = fixture(), { controller, old } = mount(api)
    await controller.activate(new AbortController().signal, { scheduleManager: true })
    expect(old).not.toHaveBeenCalled()
    expect(api.read).toHaveBeenCalledWith({ view: 'team', from: '2026-09-28', to: '2026-11-22' }, undefined, expect.any(AbortSignal))
    expect(document.body.textContent).toContain('10h planned')
    expect(document.body.textContent).toContain('5h available')
    expect(document.body.textContent).toContain('1.2h tracked (rounded)')
    expect(document.body.textContent).toContain('20h planned across all work')
    expect(document.body.textContent).toContain('Read-only calendar.')
    expect(document.body.textContent).toContain('Unassigned design')
    expect(document.querySelector('[data-capacity-planning]')!.childElementCount).toBe(0)
  })

  it('renders real dated allocations without manufacturing a bar from weekly totals', async () => {
    const { controller } = mount(fixture())
    await controller.activate(new AbortController().signal)
    input('Display').value = 'timeline'; input('Display').dispatchEvent(new Event('change'))
    const timeline = document.querySelector<HTMLElement>('.resource-calendar-timeline')!
    expect(timeline.hidden).toBe(false)
    expect(timeline.textContent).toContain('Oct 1 to Oct 2')
    expect(timeline.querySelectorAll('.resource-calendar-track > span')).toHaveLength(1)
    expect(timeline.querySelector<HTMLElement>('.resource-calendar-track > span')!.style.width).toBe(`${2 / 56 * 100}%`)
  })

  it('reads project scope through exact scoped IDs and never broad project catalog calls', async () => {
    const api = fixture(), { controller } = mount(api)
    await controller.activate(new AbortController().signal)
    input('Scope').value = 'project'; input('Scope').dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(api.read).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'project', project_id: 7 }), undefined, expect.any(AbortSignal)))
  })

  it('clears private rows, dated allocations and project options on abort and ignores a late reply', async () => {
    const api = fixture(), { controller } = mount(api), session = new AbortController()
    await controller.activate(session.signal)
    session.abort()
    expect(document.body.textContent).not.toContain('Owned Person')
    expect(document.body.textContent).not.toContain('Owned project')
    expect(input('Project').options).toHaveLength(0)
    let resolve!: (value: { data: typeof context }) => void
    api.context.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const second = new AbortController(), pending = controller.activate(second.signal)
    await vi.waitFor(() => expect(api.context).toHaveBeenCalledTimes(2))
    second.abort(); resolve({ data: context }); await pending
    expect(document.body.textContent).not.toContain('Owned Person')
    expect(input('Project').options).toHaveLength(0)
  })

  it('keeps an actionable retry after failure without falling back to legacy data', async () => {
    const api = fixture(); api.read.mockRejectedValueOnce(new Error('Owned read unavailable'))
    const { controller, old } = mount(api)
    await controller.activate(new AbortController().signal)
    const retry = document.querySelector<HTMLButtonElement>('[data-capacity-retry]')!
    expect(retry.hidden).toBe(false)
    expect(document.querySelector('[data-capacity-status]')!.textContent).toBe('Owned read unavailable')
    retry.click()
    await vi.waitFor(() => expect(document.querySelector('[data-capacity-grid]')!.textContent).toContain('Owned Person'))
    expect(old).not.toHaveBeenCalled()
  })

  it('filters summary and true dated ranges by the selected authorized person', async () => {
    const api = fixture(), { controller } = mount(api)
    await controller.activate(new AbortController().signal)
    input('Person').value = '3'; input('Person').dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(api.read).toHaveBeenLastCalledWith(expect.objectContaining({ person_id: 3 }), undefined, expect.any(AbortSignal)))
    expect(api.allocations).toHaveBeenLastCalledWith(expect.objectContaining({ person_id: 3 }), undefined, expect.any(AbortSignal))
  })

  it('offers authorized summary people to narrow an oversized global allocation traversal', async () => {
    const api = fixture()
    let pages = 0
    const allocations: ResourceCalendarApi['allocations'] = async query => ({ data: [], page: { next_cursor: query.person_id ? null : `opaque-${++pages}` } })
    const { controller } = mount({ ...api, allocations })
    await controller.activate(new AbortController().signal)
    expect(document.querySelector('[data-capacity-status]')!.textContent).toContain('too large')
    expect(input('Person').querySelector('option[value="3"]')?.textContent).toBe('Owned Person 3')
    input('Person').value = '3'; input('Person').dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(document.querySelector('[data-capacity-status]')!.textContent).toBe(''))
    expect(api.read).toHaveBeenLastCalledWith(expect.objectContaining({ person_id: 3 }), undefined, expect.any(AbortSignal))
  })

  it.each([401, 403])('wipes project/person options and private rows on an authority refusal %s', async status => {
    const api = fixture(), { controller } = mount(api)
    await controller.activate(new AbortController().signal)
    api.read.mockRejectedValueOnce(new EzactoApiError(status, { error: { code: 'forbidden', message: 'Scope withdrawn' } }, null))
    document.querySelector<HTMLButtonElement>('[data-capacity-next]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-capacity-status]')!.textContent).toBe('Calendar access is unavailable. Sign in again or retry.'))
    expect(document.body.textContent).not.toContain('Owned Person')
    expect(document.body.textContent).not.toContain('Owned project')
    expect(input('Project').options).toHaveLength(0)
    expect([...input('Person').options].map(option => option.textContent)).toEqual(['All people'])
    expect(document.querySelector<HTMLButtonElement>('[data-capacity-retry]')!.hidden).toBe(false)
  })

  it('rejects an old admin read after a read-only activation reuses the same session signal', async () => {
    const api = fixture(), { controller } = mount(api), session = new AbortController()
    let resolve!: (value: { data: ResourceCalendar; page: { next_cursor: string | null } }) => void
    api.read.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const old = controller.activate(session.signal, { administrator: true })
    await vi.waitFor(() => expect(api.read).toHaveBeenCalledTimes(1))
    api.read.mockResolvedValueOnce({ data: projection(4), page: { next_cursor: null } })
    await controller.activate(session.signal, { administrator: false })
    resolve({ data: projection(3), page: { next_cursor: null } }); await old
    expect(document.body.textContent).toContain('Owned Person 4')
    expect(document.body.textContent).not.toContain('Owned Person 3')
    expect(document.body.textContent).toContain('Read-only calendar.')
  })

  it('loads opaque people pages only on request and blocks repeated cursors', async () => {
    const api = fixture(); api.read.mockResolvedValueOnce({ data: projection(), page: { next_cursor: 'opaque-page' } })
    const { controller } = mount(api)
    await controller.activate(new AbortController().signal)
    expect(api.read).toHaveBeenCalledTimes(1)
    api.read.mockResolvedValueOnce({ data: { ...projection(4), unassigned: [] }, page: { next_cursor: 'opaque-page' } })
    const more = document.querySelector<HTMLButtonElement>('[data-calendar-more]')!; more.click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('Owned Person 4'))
    more.click()
    await vi.waitFor(() => expect(document.querySelector('[data-capacity-status]')!.textContent).toContain('repeated page'))
    expect(api.read).toHaveBeenCalledTimes(2)
  })
})

describe('calendar bounds', () => {
  it('anchors windows on the server week and clips only actual date spans', () => {
    expect(calendarWindow(context, -1)).toEqual({ from: '2026-08-03', to: '2026-09-27' })
    expect(timelinePosition('2026-10-01', '2026-10-10', '2026-09-20', '2026-10-02')).toEqual({ start: 0, width: 20 })
    expect(timelinePosition('2026-10-01', '2026-10-10', '2026-11-01', '2026-11-02')).toBeNull()
  })
  it('refuses repeated signed cursors rather than endlessly collecting private rows', async () => {
    const read = vi.fn(async () => ({ data: [1], page: { next_cursor: 'same-opaque-cursor' } }))
    await expect(calendarPages(read, new AbortController().signal)).rejects.toThrow('repeated page')
    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe('calendar scope in reused administrator editors', () => {
  const editorFixture = () => {
    const api = fixture()
    api.projects.mockResolvedValue({ data: [{ id: 1, name: 'Other project', is_active: true }, { id: 7, name: 'Selected project', is_active: true }], page: { next_cursor: null } })
    const updateAllocation = vi.fn(async () => ({}))
    const planning: PlanningApi = {
      listProjects: async () => [], listAllocations: async () => [], listTimeOff: async () => [],
      createAllocation: async () => ({}), updateAllocation, deleteAllocation: async () => ({}),
      createTimeOff: async () => ({}), updateTimeOff: async () => ({}), deleteTimeOff: async () => ({}),
    }
    const list = vi.fn(async () => [
      { id: 21, placeholder_id: 8, name: 'Selected demand', project_id: 7, project_name: 'Selected project', start_date: '2026-09-28', end_date: '2026-10-02', planned_seconds_per_week: 7200, state: 'open' as const, version: 0, assigned_allocation_id: null },
      { id: 22, placeholder_id: 8, name: 'Other demand', project_id: 1, project_name: 'Other project', start_date: '2026-09-28', end_date: '2026-10-02', planned_seconds_per_week: 36000, state: 'open' as const, version: 0, assigned_allocation_id: null },
    ])
    const placeholders: PlaceholderPlanningApi = {
      list, listDefinitions: async () => [{ id: 8, name: 'Shared role', is_active: true, version: 0 }],
      createDefinition: async () => ({}), updateDefinition: async () => ({}), archiveDefinition: async () => ({}),
      create: async () => ({}), update: async () => ({}), archive: async () => ({}), assign: async () => { throw new Error('Unused') },
    }
    const mounted = mount(api, { planning, placeholders })
    const session = new AbortController()
    const ready = async () => vi.waitFor(() => expect(document.querySelector('[data-capacity-status]')!.textContent).toBe(''))
    const projectScope = async () => {
      input('Scope').value = 'project'; input('Scope').dispatchEvent(new Event('change')); await ready()
      input('Project').value = '7'; input('Project').dispatchEvent(new Event('change')); await ready()
    }
    return { ...mounted, api, session, projectScope, ready, list, updateAllocation }
  }
  it('defaults a new allocation to the selected project and resets the default on a new scope', async () => {
    const fixture = editorFixture(); await fixture.controller.activate(fixture.session.signal, { administrator: true })
    expect([...document.querySelector<HTMLSelectElement>('[data-planning-allocation-form] [name="project_id"]')!.options].map(option => option.value)).toEqual(['1', '7'])
    await fixture.projectScope()
    const picker = () => document.querySelector<HTMLSelectElement>('[data-planning-allocation-form] [name="project_id"]')!
    expect(picker().value).toBe('7')
    expect([...picker().options].map(option => option.value)).toEqual(['7'])
    input('Project').value = '1'; input('Project').dispatchEvent(new Event('change')); await fixture.ready()
    expect(picker().value).toBe('1')
  })
  it('keeps off-project demand out of the reused list, totals and project editor choices', async () => {
    const fixture = editorFixture(); await fixture.controller.activate(fixture.session.signal, { administrator: true }); await fixture.projectScope()
    const host = document.querySelector<HTMLElement>('[data-capacity-placeholders]')!
    expect(host.textContent).toContain('Selected demand')
    expect(host.textContent).not.toContain('Other demand')
    expect(fixture.list).toHaveBeenLastCalledWith(expect.objectContaining({ project_id: 7 }), expect.any(AbortSignal))
    expect(host.querySelectorAll('[data-placeholder-rows] tbody tr')).toHaveLength(1)
    expect([...host.querySelector<HTMLSelectElement>('[data-placeholder-plan-form] [name="project_id"]')!.options].map(option => option.value)).toEqual(['', '7'])
  })
  it('withdraws all unassigned rows under a person filter without another unassigned data read', async () => {
    const fixture = editorFixture(); await fixture.controller.activate(fixture.session.signal, { administrator: true }); await fixture.projectScope()
    const reads = fixture.list.mock.calls.length
    input('Person').value = '3'; input('Person').dispatchEvent(new Event('change')); await fixture.ready()
    const host = document.querySelector<HTMLElement>('[data-capacity-placeholders]')!
    expect(host.hidden).toBe(true)
    expect(host.textContent).not.toContain('Selected demand')
    expect(host.textContent).not.toContain('Other demand')
    expect(fixture.list).toHaveBeenCalledTimes(reads)
    expect(document.querySelector('[aria-label="Unassigned demand"]')!.textContent).toContain('Select All people')
    expect(document.querySelector('[aria-label="Unassigned demand"]')!.textContent).not.toContain('Unassigned design')
  })
  it('preserves the edit project and conflict draft during authoritative refresh', async () => {
    const fixture = editorFixture(); await fixture.controller.activate(fixture.session.signal, { administrator: true }); await fixture.projectScope()
    document.querySelector<HTMLButtonElement>('[data-planning-allocations] button[aria-label^="Edit allocation"]')!.click()
    const form = document.querySelector<HTMLFormElement>('[data-planning-allocation-form]')!
    const hours = form.elements.namedItem('hours') as HTMLInputElement; hours.value = '7.25'
    fixture.updateAllocation.mockRejectedValueOnce(new EzactoApiError(409, { error: { code: 'allocation_changed', current: { id: 6, version: 3, user_id: 3, project_id: 7, start_date: '2026-10-01', end_date: '2026-10-02', planned_seconds_per_week: 36000 } } }, null))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(fixture.updateAllocation).toHaveBeenCalledTimes(1)); await fixture.ready()
    expect((form.elements.namedItem('id') as HTMLInputElement).value).toBe('6')
    expect((form.elements.namedItem('project_id') as HTMLSelectElement).value).toBe('7')
    expect(hours.value).toBe('7.25')
    expect(document.querySelector('[data-planning-allocation-status]')!.textContent).toContain('Your edits are kept')
  })
})
