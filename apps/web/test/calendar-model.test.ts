import { describe, expect, it } from 'vitest'
import {
  calendarAxisLabel,
  calendarWeek,
  type CalendarEntry,
} from '../src/calendar/model.js'

const entry = (overrides: Partial<CalendarEntry> = {}): CalendarEntry => ({
  id: 1,
  spent_date: '2026-09-07',
  seconds: 3_600,
  started_time: null,
  ended_time: null,
  notes: null,
  project_id: 1,
  task_id: 1,
  ...overrides,
})

const week = ['2026-09-07', '2026-09-08']

describe('calendar placement', () => {
  it('[unit] stacks duration entries without inventing a time of day', () => {
    // The account this was written for has 30,684 entries and not one start
    // time. Drawing the first at 09:00 because it was logged first would be a
    // claim about someone's morning that nobody made.
    const days = calendarWeek(
      week,
      [
        entry({ id: 1, seconds: 7_200 }),
        entry({ id: 2, seconds: 1_800 }),
        entry({ id: 3, spent_date: '2026-09-08', seconds: 3_600 }),
      ],
      'duration',
    )

    expect(days[0]!.blocks).toEqual([
      { id: 1, offsetMinutes: 0, minutes: 120, startedTime: null, seconds: 7_200 },
      { id: 2, offsetMinutes: 120, minutes: 30, startedTime: null, seconds: 1_800 },
    ])
    expect(days[0]!.totalSeconds).toBe(9_000)
    expect(days[1]!.blocks).toHaveLength(1)
    // Nothing is unplaceable in duration mode: every entry has a length.
    expect(days[0]!.unplaced).toEqual([])
  })

  it('[unit] places start/end entries on the clock, in clock order', () => {
    const days = calendarWeek(
      week,
      [
        entry({ id: 2, started_time: '13:30', ended_time: '14:00', seconds: 1_800 }),
        entry({ id: 1, started_time: '09:00', ended_time: '11:00', seconds: 7_200 }),
      ],
      'start_end',
    )

    // Filed in one order, drawn in another: the axis is the clock, so the
    // afternoon is below the morning whatever order they were entered.
    expect(days[0]!.blocks.map((block) => block.id)).toEqual([1, 2])
    expect(days[0]!.blocks[0]).toMatchObject({ offsetMinutes: 540, minutes: 120 })
    expect(days[0]!.blocks[1]).toMatchObject({ offsetMinutes: 810, minutes: 30 })
  })

  it('[unit] lists a timeless entry beside the day rather than dropping it', () => {
    // In an organization that records clock times, an entry without one cannot
    // be placed. Dropping it would make a worked day read as unworked.
    const days = calendarWeek(week, [entry({ id: 5, seconds: 3_600 })], 'start_end')

    expect(days[0]!.blocks).toEqual([])
    expect(days[0]!.unplaced.map((row) => row.id)).toEqual([5])
    // It still counts toward the day, because the hours were worked.
    expect(days[0]!.totalSeconds).toBe(3_600)
  })

  it('[unit] clamps an entry that ends before it starts to the end of its day', () => {
    // A night shift crossing midnight. A block of negative height is not a
    // drawing, and moving it to the next day would file it against a date
    // nobody chose.
    const days = calendarWeek(
      week,
      [entry({ id: 9, started_time: '23:00', ended_time: '02:00', seconds: 10_800 })],
      'start_end',
    )

    expect(days[0]!.blocks[0]).toMatchObject({ offsetMinutes: 1_380, minutes: 60 })
    expect(days[0]!.blocks[0]!.minutes).toBeGreaterThan(0)
  })

  it('[unit] says what the axis measures, because it is not the same in both modes', () => {
    expect(calendarAxisLabel('start_end')).toBe('Time of day')
    expect(calendarAxisLabel('duration')).toBe('Hours worked')
  })
})
