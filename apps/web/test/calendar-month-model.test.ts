import { describe, expect, it } from 'vitest'
import {
  calendarMonth,
  calendarMonthRange,
  monthEnd,
  monthLabel,
  monthStart,
  weekdayHeadings,
  type CalendarEntry,
} from '../src/calendar/month-model.js'

const entry = (overrides: Partial<CalendarEntry> = {}): CalendarEntry => ({
  id: 1,
  spent_date: '2026-09-15',
  seconds: 3_600,
  project_id: 1,
  task_id: 1,
  ...overrides,
})

describe('calendar month', () => {
  it('[unit] names the month and finds its ends from any day in it', () => {
    expect(monthStart('2026-09-15')).toBe('2026-09-01')
    expect(monthEnd('2026-09-15')).toBe('2026-09-30')
    expect(monthEnd('2028-02-10')).toBe('2028-02-29')
    expect(monthLabel('2026-09-15')).toBe('September 2026')
    expect(() => monthStart('2026-02-30')).toThrow('invalid calendar date')
  })

  it('[unit] draws the month in whole weeks, on the organization\'s week start', () => {
    // September 2026 starts on a Tuesday and ends on a Wednesday: a Monday
    // week runs from 31 Aug to 4 Oct, a Sunday week from 30 Aug to 3 Oct.
    expect(calendarMonthRange('2026-09-15', 'monday')).toEqual({
      from: '2026-08-31',
      to: '2026-10-04',
    })
    expect(calendarMonthRange('2026-09-15', 'sunday')).toEqual({
      from: '2026-08-30',
      to: '2026-10-03',
    })
    expect(weekdayHeadings('monday')).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    expect(weekdayHeadings('sunday')[0]).toBe('Sun')
    expect(weekdayHeadings('saturday')[0]).toBe('Sat')
  })

  it('[unit] files each entry under its day and totals the month by its own days only', () => {
    const month = calendarMonth('2026-09-15', 'monday', [
      entry({ id: 1, spent_date: '2026-09-15', seconds: 7_200 }),
      entry({ id: 2, spent_date: '2026-09-15', seconds: 1_800 }),
      entry({ id: 3, spent_date: '2026-09-01', seconds: 600 }),
      // On the grid, but August's: shown in its greyed cell, not in the total.
      entry({ id: 4, spent_date: '2026-08-31', seconds: 36_000 }),
      // Off the grid altogether: a generous fetch is allowed, and ignored.
      entry({ id: 5, spent_date: '2026-10-20', seconds: 36_000 }),
    ])
    expect(month.monthStart).toBe('2026-09-01')
    expect(month.weeks).toHaveLength(5)
    expect(month.weeks[0]![0]).toMatchObject({ date: '2026-08-31', inMonth: false, totalSeconds: 36_000 })
    expect(month.weeks[0]![1]).toMatchObject({ date: '2026-09-01', inMonth: true, totalSeconds: 600 })
    const fifteenth = month.weeks.flat().find((cell) => cell.date === '2026-09-15')!
    expect(fifteenth.entries.map((item) => item.id)).toEqual([1, 2])
    expect(fifteenth.totalSeconds).toBe(9_000)
    expect(month.weeks.at(-1)!.at(-1)!).toMatchObject({ date: '2026-10-04', inMonth: false })
    expect(month.totalSeconds).toBe(9_600)
  })
})
