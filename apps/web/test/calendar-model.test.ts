import { describe, expect, it } from 'vitest'
import {
  assignLanes,
  calendarWeek,
  clockFromMinutes,
  entrySpan,
  firstVisibleMinutes,
  minutesFromClock,
  moveSpan,
  resizeSpanEnd,
  resizeSpanStart,
  sameSpan,
  snapMinutes,
  spanAt,
  spanFromDrag,
  spanSeconds,
  spanTimes,
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
  it('[unit] lists duration entries in entry order without inventing a time of day', () => {
    // The account this was written for has 30,684 entries and not one start
    // time. Drawing the first at 09:00 because it was logged first would be a
    // claim about someone's morning that nobody made, so they are listed, in
    // the order they were entered, and nothing is placed on the clock.
    const days = calendarWeek(week, [
      entry({ id: 1, seconds: 7_200 }),
      entry({ id: 2, seconds: 1_800 }),
      entry({ id: 3, spent_date: '2026-09-08', seconds: 3_600 }),
    ])

    expect(days[0]!.blocks).toEqual([])
    expect(days[0]!.untimed.map((row) => row.id)).toEqual([1, 2])
    expect(days[0]!.totalSeconds).toBe(9_000)
    expect(days[1]!.untimed.map((row) => row.id)).toEqual([3])
  })

  it('[unit] places timed entries on the clock, in clock order, beside the untimed ones', () => {
    // Issue 943: the calendar records intervals in a duration organization too,
    // so the same day holds both shapes.
    const days = calendarWeek(week, [
      entry({ id: 2, started_time: '13:30', ended_time: '14:00', seconds: 1_800 }),
      entry({ id: 3, seconds: 5_400 }),
      entry({ id: 1, started_time: '09:00', ended_time: '11:00', seconds: 7_200 }),
    ])

    // Filed in one order, drawn in another: the axis is the clock, so the
    // afternoon is below the morning whatever order they were entered.
    expect(days[0]!.blocks.map((block) => block.entry.id)).toEqual([1, 2])
    expect(days[0]!.blocks[0]).toMatchObject({ offsetMinutes: 540, minutes: 120, lane: 0, lanes: 1 })
    expect(days[0]!.blocks[1]).toMatchObject({ offsetMinutes: 810, minutes: 30 })
    expect(days[0]!.untimed.map((row) => row.id)).toEqual([3])
    expect(days[0]!.totalSeconds).toBe(14_400)
  })

  it('[unit] draws an entry that ends before it starts to the end of its day', () => {
    // A night shift crossing midnight. A block of negative height is not a
    // drawing, and moving it to the next day would file it against a date
    // nobody chose; its own span keeps the hours past midnight.
    const days = calendarWeek(week, [
      entry({ id: 9, started_time: '23:00', ended_time: '02:00', seconds: 10_800 }),
    ])

    expect(days[0]!.blocks[0]).toMatchObject({
      offsetMinutes: 1_380,
      minutes: 60,
      start: 1_380,
      end: 1_560,
      overnight: true,
    })
  })

  it('[unit] totals a day by each entry in full, overlapping intervals included', () => {
    // Two clients in the same hour is a real day. 09:00-11:00 and 10:00-12:00
    // beside an hour logged as a duration is five hours of work over a
    // three-hour span, and the day says five.
    const days = calendarWeek(week, [
      entry({ id: 1, seconds: 3_600 }),
      entry({ id: 2, started_time: '09:00', ended_time: '11:00', seconds: 7_200 }),
      entry({ id: 3, started_time: '10:00', ended_time: '12:00', seconds: 7_200 }),
    ])
    expect(days[0]!.totalSeconds).toBe(18_000)
  })

  it('[unit] lays overlapping entries side by side and leaves touching ones full width', () => {
    const days = calendarWeek(week, [
      entry({ id: 1, started_time: '09:00', ended_time: '11:00', seconds: 7_200 }),
      entry({ id: 2, started_time: '10:00', ended_time: '12:00', seconds: 7_200 }),
      entry({ id: 3, started_time: '10:30', ended_time: '11:30', seconds: 3_600 }),
      // Starts exactly when the cluster above has ended: a new cluster.
      entry({ id: 4, started_time: '12:00', ended_time: '13:00', seconds: 3_600 }),
    ])
    const byId = new Map(days[0]!.blocks.map((block) => [block.entry.id, block]))

    expect(byId.get(1)).toMatchObject({ lane: 0, lanes: 3 })
    expect(byId.get(2)).toMatchObject({ lane: 1, lanes: 3 })
    expect(byId.get(3)).toMatchObject({ lane: 2, lanes: 3 })
    expect(byId.get(4)).toMatchObject({ lane: 0, lanes: 1 })
  })

  it('[unit] reuses a lane once the entry in it has ended', () => {
    const lanes = assignLanes([
      { key: 1, start: 540, end: 600 },
      { key: 2, start: 550, end: 720 },
      { key: 3, start: 600, end: 660 },
    ])
    // 3 starts when 1 ends, so it takes 1's lane; the cluster still needed two.
    expect(lanes.get(3)).toEqual({ lane: 0, lanes: 2 })
    expect(lanes.get(2)).toEqual({ lane: 1, lanes: 2 })
  })

  it('[unit] gives a zero-length entry a lane where it is drawn', () => {
    // Drawn a snap tall, so it is laid out as the overlap it looks like.
    const days = calendarWeek(week, [
      entry({ id: 1, started_time: '09:00', ended_time: '09:00', seconds: 0 }),
      entry({ id: 2, started_time: '09:05', ended_time: '10:00', seconds: 3_300 }),
    ])
    expect(days[0]!.blocks.map((block) => block.lanes)).toEqual([2, 2])
  })

  it('[unit] measures a running timed entry to now, and to midnight when it began on an earlier day', () => {
    const running = entry({ id: 5, started_time: '09:00', ended_time: null, is_running: true, seconds: 0 })
    expect(entrySpan(running, { date: '2026-09-07', minutes: 615 })).toEqual({ start: 540, end: 615 })
    expect(entrySpan(running, { date: '2026-09-08', minutes: 60 })).toEqual({ start: 540, end: 1_440 })
    const days = calendarWeek(week, [running], { date: '2026-09-07', minutes: 615 })
    expect(days[0]!.blocks[0]).toMatchObject({ running: true, minutes: 75 })
  })
})

describe('calendar arithmetic', () => {
  it('[unit] reads and writes canonical clock times', () => {
    expect(minutesFromClock('09:15')).toBe(555)
    expect(minutesFromClock('24:00')).toBeNull()
    expect(minutesFromClock('9:15')).toBeNull()
    expect(minutesFromClock(null)).toBeNull()
    expect(clockFromMinutes(555)).toBe('09:15')
    // The midnight that closes a day is written as the API writes it.
    expect(clockFromMinutes(1_440)).toBe('00:00')
    expect(clockFromMinutes(1_500)).toBe('01:00')
  })

  it('[unit] snaps to the nearest quarter hour', () => {
    expect(snapMinutes(547)).toBe(540)
    expect(snapMinutes(548)).toBe(555)
    expect(snapMinutes(562)).toBe(555)
    expect(snapMinutes(563)).toBe(570)
  })

  it('[unit] makes a span from a drag in either direction, at least a snap long', () => {
    expect(spanFromDrag(542, 655)).toEqual({ start: 540, end: 660 })
    expect(spanFromDrag(655, 542)).toEqual({ start: 540, end: 660 })
    // A press with no travel is still an entry, one snap long.
    expect(spanFromDrag(541, 543)).toEqual({ start: 540, end: 555 })
    // ...and never runs off the end of the day.
    expect(spanFromDrag(1_439, 1_440)).toEqual({ start: 1_425, end: 1_440 })
    expect(spanFromDrag(-40, 30)).toEqual({ start: 0, end: 30 })
  })

  it('[unit] proposes the hour from the quarter a click lands in', () => {
    expect(spanAt(551)).toEqual({ start: 540, end: 600 })
    expect(spanAt(1_430)).toEqual({ start: 1_425, end: 1_440 })
    expect(spanAt(1_390)).toEqual({ start: 1_380, end: 1_440 })
  })

  it('[unit] moves a span in quarter hours and treats a slip of the hand as no move', () => {
    const span = { start: 545, end: 605 }
    // Picked up and put back: an entry a timer started at 09:05 stays there.
    expect(moveSpan(span, 7)).toBe(span)
    expect(moveSpan(span, -7)).toBe(span)
    // Moved: its start lands on a quarter, its length is kept.
    expect(moveSpan(span, 15)).toEqual({ start: 555, end: 615 })
    expect(moveSpan(span, -600)).toEqual({ start: 0, end: 60 })
    // A span that fitted its day stops at midnight rather than crossing it.
    expect(moveSpan(span, 2_000)).toEqual({ start: 1_380, end: 1_440 })
  })

  it('[unit] lets a night shift keep its hours past midnight when it is moved', () => {
    expect(moveSpan({ start: 1_320, end: 1_560 }, -60)).toEqual({ start: 1_260, end: 1_500 })
    expect(moveSpan({ start: 1_320, end: 1_560 }, 600)).toEqual({ start: 1_425, end: 1_665 })
  })

  it('[unit] resizes either edge to a snap, keeping a snap of length and the day', () => {
    const span = { start: 540, end: 600 }
    expect(resizeSpanEnd(span, 668)).toEqual({ start: 540, end: 675 })
    expect(resizeSpanEnd(span, 500)).toEqual({ start: 540, end: 555 })
    expect(resizeSpanEnd(span, 1_500)).toEqual({ start: 540, end: 1_440 })
    expect(resizeSpanEnd(span, 604)).toBe(span)
    expect(resizeSpanStart(span, 480)).toEqual({ start: 480, end: 600 })
    expect(resizeSpanStart(span, 700)).toEqual({ start: 585, end: 600 })
    expect(resizeSpanStart(span, -30)).toEqual({ start: 0, end: 600 })
    expect(resizeSpanStart(span, 536)).toBe(span)
  })

  it('[unit] writes a span as the API stores it, the end wrapped past midnight', () => {
    expect(spanTimes({ start: 540, end: 630 })).toEqual({ startedTime: '09:00', endedTime: '10:30' })
    expect(spanTimes({ start: 1_380, end: 1_440 })).toEqual({ startedTime: '23:00', endedTime: '00:00' })
    expect(spanTimes({ start: 1_320, end: 1_560 })).toEqual({ startedTime: '22:00', endedTime: '02:00' })
    expect(spanSeconds({ start: 1_320, end: 1_560 })).toBe(14_400)
    expect(sameSpan({ start: 1, end: 2 }, { start: 1, end: 2 })).toBe(true)
  })

  it('[unit] opens the view before the earliest entry, or before eight', () => {
    expect(firstVisibleMinutes(calendarWeek(week, []))).toBe(450)
    expect(
      firstVisibleMinutes(
        calendarWeek(week, [entry({ started_time: '06:15', ended_time: '07:00', seconds: 2_700 })]),
      ),
    ).toBe(330)
  })
})
