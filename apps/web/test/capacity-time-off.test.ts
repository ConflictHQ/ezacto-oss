/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import { createCapacityController } from '../src/capacity/browser.js'
import { capacityCellText, type CapacityData } from '../src/capacity/model.js'
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
        {
          week_start: '2026-10-05',
          planned_seconds: hours(16),
          time_off_seconds: 0,
          available_capacity_seconds: hours(20),
          tracked_seconds: 0,
          over_allocated: false,
        },
        {
          week_start: '2026-10-12',
          planned_seconds: hours(16),
          time_off_seconds: hours(12),
          available_capacity_seconds: hours(8),
          tracked_seconds: 0,
          over_allocated: true,
        },
      ],
    },
  ],
}

describe('capacity less time off (issue 1007, slice 3)', () => {
  it('[unit] holds the plan against the capacity left and names the time off', () => {
    const [clear, away] = report.people[0]!.weeks
    expect(capacityCellText(clear!)).toMatchObject({ main: '16h of 20h', timeOff: null })
    expect(capacityCellText(away!)).toMatchObject({
      main: '16h of 8h',
      timeOff: '12h time off',
      flag: 'Over-allocated',
    })
  })

  it('[browser] draws the reduced capacity and the time off beside it, still read-only', async () => {
    document.body.innerHTML = renderCapacityPage('capacity')
    const getCapacity = vi.fn(async () => ({ data: report }))
    await createCapacityController({ getCapacity }).activate(new AbortController().signal)
    const grid = document.querySelector<HTMLElement>('[data-capacity-grid]')!.textContent ?? ''
    expect(grid).toContain('16h of 20h')
    expect(grid).toContain('16h of 8h')
    expect(grid).toContain('12h time off')
    expect(grid).toContain('Over-allocated')
    expect(document.querySelectorAll('[data-over-allocated="true"]')).toHaveLength(1)
    expect(
      document.querySelector(
        '[data-capacity-page] input, [data-capacity-page] form, [data-capacity-page] textarea',
      ),
    ).toBeNull()
  })
})
