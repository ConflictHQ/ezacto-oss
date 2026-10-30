/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EzactoApiError, type ResourceCalendar } from '@conflict-hq/ezacto-client'
import { createAllocationGestures } from '../src/capacity/allocation-gestures-browser.js'
import { allocationReviewPage, allocationReviewWeeks, gestureDates, previewAllocationWeeks } from '../src/capacity/allocation-gesture-model.js'
import type { PlanningApi } from '../src/capacity/model.js'

const source = { id: 6, version: 3, user_id: 7, project_id: 8, project_name: 'Owned project', start_date: '2026-10-24', end_date: '2026-10-25', planned_seconds_per_week: 4442 }
const context = { today: '2026-10-25', current_week_start: '2026-10-19', time_zone: 'America/New_York', week_start_day: 'monday' } as const
const report = (weeks: readonly string[], revision = 'stable'): ResourceCalendar => ({
  context, revision, view: 'team', has_other_scope: true, unassigned: [], unassigned_truncated: false, week_starts: [...weeks],
  people: [{ person_id: 7, name: 'Owned person', weeks: weeks.map(week => ({ week_start: week, planned_seconds: 4442, tracked_seconds: 999, available_seconds: 5000, person_planned_seconds: week === '2026-10-19' ? 9000 : 6000, person_other_scope_planned_seconds: 4558, other_scope_planned_seconds: 0, other_scope_tracked_seconds: 0, projects: [], over_allocated: true })) }],
})
const setup = async () => {
  const host = document.createElement('section'), item = document.createElement('article'), track = document.createElement('div'), bar = document.createElement('span')
  track.append(bar); item.append(track); document.body.append(item, host)
  const getAllocation = vi.fn(async () => source), updateAllocation = vi.fn(async () => ({})), saved = vi.fn(), refused = vi.fn(), session = new AbortController()
  const read = vi.fn(async () => ({ data: report(['2026-10-19', '2026-10-26']), page: { next_cursor: null } }))
  const calendar = { context: vi.fn(async () => ({ data: context })), read, projects: vi.fn(), allocations: vi.fn() }
  const planning = { getAllocation, updateAllocation } as unknown as PlanningApi
  const controller = createAllocationGestures(host, calendar, planning, saved, refused)
  controller.attach(item, track, bar, source, { view: 'team', from: '2026-10-19', to: '2026-12-13' }, session.signal)
  const trigger = item.querySelector<HTMLButtonElement>('button')!
  trigger.click()
  await vi.waitFor(() => expect(host.textContent).toContain('Preview the changed dates'))
  const start = host.querySelector<HTMLInputElement>('input')!, end = host.querySelectorAll<HTMLInputElement>('input')[1]!
  const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === name)!
  const change = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) }
  const preview = async () => { change(start, '2026-10-26'); change(end, '2026-10-27'); button('Preview dates').click(); await vi.waitFor(() => expect(host.textContent).toContain('All affected weeks reviewed')) }
  return { host, item, track, bar, read, trigger, start, end, button, change, preview, getAllocation, updateAllocation, saved, refused, session, controller }
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

describe('allocation date review', () => {
  it('moves floating dates across DST and resizes only the selected edge', () => {
    expect(gestureDates(source, 'move', 8)).toEqual({ start_date: '2026-11-01', end_date: '2026-11-02' })
    expect(gestureDates(source, 'start', -2)).toEqual({ start_date: '2026-10-22', end_date: '2026-10-25' })
    expect(gestureDates(source, 'end', 2)).toEqual({ start_date: '2026-10-24', end_date: '2026-10-27' })
  })
  it('previews freed and newly touched weeks, preserving full exact weekly amounts and whole-person other-scope work', () => {
    const next = gestureDates(source, 'move', 2), weeks = allocationReviewWeeks(source, next, 'monday')
    expect(weeks).toEqual(['2026-10-19', '2026-10-26'])
    expect(previewAllocationWeeks(source, next, weeks, report(weeks))).toEqual([
      { week: '2026-10-19', allocationSeconds: 0, personSeconds: 4558, availableSeconds: 5000, overAllocated: false },
      { week: '2026-10-26', allocationSeconds: 4442, personSeconds: 10442, availableSeconds: 5000, overAllocated: true },
    ])
    expect(allocationReviewWeeks(source, next, 'sunday')).toEqual(['2026-10-18', '2026-10-25'])
    expect(() => previewAllocationWeeks(source, next, weeks, report([]))).toThrow('incomplete')
  })
  it('pages long allocations and gaps without exceeding native 53-week reads or dropping affected weeks', () => {
    const weeks = allocationReviewWeeks(source, { start_date: '2030-01-01', end_date: '2032-02-01' }, 'monday'), collected: string[] = []
    while (collected.length < weeks.length) {
      const page = allocationReviewPage(weeks, collected.length)
      expect(page.length).toBeLessThanOrEqual(53); expect(Date.parse(page.at(-1)!) - Date.parse(page[0]!)).toBeLessThanOrEqual(364 * 86400000); collected.push(...page)
    }
    expect(collected).toEqual(weeks)
  })
  it('does not write for review, editing or Escape and restores keyboard focus', async () => {
    const f = await setup(); await f.preview()
    expect(f.host.textContent).toContain('4442 seconds'); expect(f.host.textContent).toContain('10442s'); expect(f.host.textContent).toContain('warning only')
    expect(f.read).toHaveBeenCalledWith({ view: 'team', person_id: 7, from: '2026-10-19', to: '2026-11-01' }, undefined, expect.any(AbortSignal))
    f.start.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(f.host.childElementCount).toBe(0); expect(document.activeElement).toBe(f.trigger); expect(f.updateAllocation).not.toHaveBeenCalled()
  })
  it('uses the fresh revision and a single exact date-only command; double activation cannot duplicate it', async () => {
    const f = await setup(); await f.preview()
    f.button('Save date change').click(); f.button('Save date change').click()
    await vi.waitFor(() => expect(f.saved).toHaveBeenCalledTimes(1))
    expect(f.updateAllocation).toHaveBeenCalledExactlyOnceWith(6, { start_date: '2026-10-26', end_date: '2026-10-27', version: 3 }, expect.any(AbortSignal), expect.stringMatching(/^[a-f0-9-]{36}$/))
  })
  it('retries an uncertain reply with the same immutable payload and UUID', async () => {
    const f = await setup(); f.updateAllocation.mockRejectedValueOnce(new TypeError('Connection lost')); await f.preview()
    f.button('Save date change').click()
    await vi.waitFor(() => expect(f.button('Retry same date change').disabled).toBe(false))
    expect(f.start.disabled).toBe(true); f.button('Retry same date change').click()
    await vi.waitFor(() => expect(f.saved).toHaveBeenCalledTimes(1))
    expect(f.updateAllocation.mock.calls[1]).toEqual(f.updateAllocation.mock.calls[0])
  })
  it('keeps unsaved date fields on conflict and disables stale retries', async () => {
    const f = await setup(); await f.preview(); f.updateAllocation.mockRejectedValueOnce(new EzactoApiError(409, { error: { code: 'allocation_changed', message: 'Changed' } }, null))
    f.button('Save date change').click()
    await vi.waitFor(() => expect(f.host.textContent).toContain('Your dates are kept'))
    expect(f.start.value).toBe('2026-10-26'); expect(f.end.value).toBe('2026-10-27'); expect(f.button('Save date change').disabled).toBe(true); expect(f.saved).not.toHaveBeenCalled()
  })
  it('clears private review state and cannot save after sign-out', async () => {
    const f = await setup(); await f.preview(); const button = f.button('Save date change'); f.session.abort(); button.click()
    expect(f.host.childElementCount).toBe(0); expect(f.updateAllocation).not.toHaveBeenCalled()
  })
  it('ignores a late availability reply after date edits', async () => {
    const f = await setup(); let resolve!: (value: Awaited<ReturnType<typeof f.read>>) => void
    f.read.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    f.change(f.start, '2026-10-26'); f.change(f.end, '2026-10-27'); f.button('Preview dates').click()
    f.change(f.end, '2026-10-28'); resolve({ data: report(['2026-10-19', '2026-10-26']), page: { next_cursor: null } })
    await vi.waitFor(() => expect(f.button('Preview dates').disabled).toBe(false))
    expect(f.button('Save date change').disabled).toBe(true); expect(f.host.querySelector('table')).toBeNull(); expect(f.updateAllocation).not.toHaveBeenCalled()
  })
  it('removes private state on a live authority refusal', async () => {
    const f = await setup(); f.read.mockRejectedValueOnce(new EzactoApiError(403, { error: { code: 'forbidden', message: 'Revoked' } }, null))
    f.change(f.start, '2026-10-26'); f.change(f.end, '2026-10-27'); f.button('Preview dates').click()
    await vi.waitFor(() => expect(f.refused).toHaveBeenCalledTimes(1)); expect(f.host.childElementCount).toBe(0); expect(f.updateAllocation).not.toHaveBeenCalled()
  })
})
