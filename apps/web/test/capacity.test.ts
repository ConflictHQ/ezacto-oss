/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import { createCapacityController } from '../src/capacity/browser.js'
import {
  capacityCellText,
  capacityRange,
  hoursText,
  type CapacityData,
} from '../src/capacity/model.js'
import { renderCapacityPage } from '../src/capacity/render.js'

const hours = (count: number) => count * 3_600

const report: CapacityData = {
  week_start_day: 'monday',
  weeks: ['2026-10-05', '2026-10-12'],
  people: [
    {
      user_id: 1,
      first_name: 'Maya',
      last_name: 'Member',
      weekly_capacity_seconds: hours(20),
      weeks: [
        { week_start: '2026-10-05', planned_seconds: hours(16), tracked_seconds: hours(7), over_allocated: false },
        { week_start: '2026-10-12', planned_seconds: hours(24), tracked_seconds: 0, over_allocated: true },
      ],
    },
  ],
}

describe('capacity model (issue 1007)', () => {
  it('[unit] reads hours in tenths without a trailing zero', () => {
    expect(hoursText(0)).toBe('0h')
    expect(hoursText(hours(32))).toBe('32h')
    expect(hoursText(27_000)).toBe('7.5h')
  })

  it('[unit] says over-allocated in words, not only in colour', () => {
    const [first, second] = report.people[0]!.weeks
    expect(capacityCellText(first!, hours(20))).toEqual({
      main: '16h of 20h',
      detail: '7h tracked',
      flag: null,
    })
    expect(capacityCellText(second!, hours(20)).flag).toBe('Over-allocated')
  })

  it('[unit] asks for eight-week windows either side of today', () => {
    expect(capacityRange('2026-10-18', 0)).toEqual({ from: '2026-10-18', to: '2026-12-12' })
    expect(capacityRange('2026-10-18', 1).from).toBe('2026-12-13')
    expect(capacityRange('2026-10-18', -1).to).toBe('2026-10-17')
  })
})

describe('capacity screen (issue 1007)', () => {
  const mount = (view = 'capacity'): void => {
    document.body.innerHTML = renderCapacityPage(view)
  }
  const text = (selector: string): string =>
    document.querySelector<HTMLElement>(selector)?.textContent ?? ''

  it('[browser] draws person by week, flags the over-allocated week, and offers nothing to edit', async () => {
    mount()
    const getCapacity = vi.fn(async () => ({ data: report }))
    await createCapacityController({ getCapacity }).activate(new AbortController().signal)

    const grid = text('[data-capacity-grid]')
    expect(grid).toContain('Maya Member')
    expect(grid).toContain('Week of Oct 5')
    expect(grid).toContain('16h of 20h')
    expect(grid).toContain('24h of 20h')
    expect(grid).toContain('Over-allocated')
    expect(document.querySelectorAll('[data-over-allocated="true"]')).toHaveLength(1)
    // Read-only: no input, form or dialog anywhere on the page.
    expect(document.querySelector('[data-capacity-page] input, [data-capacity-page] form, [data-capacity-page] dialog, [data-capacity-page] textarea')).toBeNull()
    expect(text('[data-capacity-status]')).toBe('')
    const firstCall = getCapacity.mock.calls[0] as unknown as [{ from: string; to: string }]
    expect(firstCall[0].to > firstCall[0].from).toBe(true)
  })

  it('[browser] moves by a window, and returns to this week', async () => {
    mount()
    const getCapacity = vi.fn(async () => ({ data: report }))
    await createCapacityController({ getCapacity }).activate(new AbortController().signal)
    const asked = () =>
      (getCapacity.mock.calls as unknown as [{ from: string }][]).map(([range]) => range.from)
    document.querySelector<HTMLButtonElement>('[data-capacity-next]')!.click()
    document.querySelector<HTMLButtonElement>('[data-capacity-next]')!.click()
    await vi.waitFor(() => expect(getCapacity).toHaveBeenCalledTimes(3))
    const [now, one, two] = asked() as [string, string, string]
    expect(one > now && two > one).toBe(true)
    document.querySelector<HTMLButtonElement>('[data-capacity-current]')!.click()
    await vi.waitFor(() => expect(getCapacity).toHaveBeenCalledTimes(4))
    expect(asked()[3]).toBe(now)
  })

  it('[browser] says so plainly when it cannot load, and offers a retry', async () => {
    mount()
    const getCapacity = vi
      .fn()
      .mockRejectedValueOnce(new Error('Capacity could not be read.'))
      .mockResolvedValue({ data: report })
    await createCapacityController({ getCapacity }).activate(new AbortController().signal)
    expect(text('[data-capacity-status]')).toBe('Capacity could not be read.')
    expect(document.querySelector<HTMLButtonElement>('[data-capacity-retry]')!.hidden).toBe(false)
    document.querySelector<HTMLButtonElement>('[data-capacity-retry]')!.click()
    await vi.waitFor(() => expect(text('[data-capacity-grid]')).toContain('Maya Member'))
    expect(document.querySelector<HTMLButtonElement>('[data-capacity-retry]')!.hidden).toBe(true)
  })

  it('[browser] stays dormant on any other page', async () => {
    mount('team-list')
    const getCapacity = vi.fn(async () => ({ data: report }))
    await createCapacityController({ getCapacity }).activate(new AbortController().signal)
    expect(getCapacity).not.toHaveBeenCalled()
  })
})
