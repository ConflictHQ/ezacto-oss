/**
 * Laying a week of time entries out on a clock, and the arithmetic a drag on
 * that clock needs.
 *
 * The axis is the clock in both tracking modes now (issue 943). An organization
 * in `start_end` records when work happened; one in `duration` records how long
 * it took -- and since the calendar became the place time gets entered, every
 * entry drawn there carries its start and end in either mode. So the two kinds
 * of entry sit side by side: the timed ones on the clock, and the ones that only
 * ever had a length in a band of their own above it.
 *
 * What is still never done is inventing a clock time for an entry that has
 * none. The account this was written against has 30,684 entries and not one
 * start time; drawing a 2h entry at 09:00 because it was logged first is a
 * claim about someone's morning that nobody made. Those entries are listed,
 * stacked in the order they were entered, each with its hours.
 *
 * Totals sum every entry's own seconds. Two clients in the same hour is a real
 * day, so overlapping entries are drawn side by side and never netted.
 */

export const MINUTES_IN_DAY = 1_440
/** Every edge a drag or a key leaves behind lands on a quarter hour. */
export const SNAP_MINUTES = 15
/** The shortest entry the calendar draws or makes: one snap. */
export const MINIMUM_SPAN_MINUTES = SNAP_MINUTES
/** What a click on an empty slot proposes before anyone drags it longer. */
export const DEFAULT_SPAN_MINUTES = 60

export interface CalendarEntry {
  readonly id: number
  readonly spent_date: string
  readonly seconds: number
  // Optional as well as nullable: the shell's entry type leaves these off
  // entirely in duration mode rather than carrying nulls, and a calendar that
  // only accepted null would not compile against the data it is given.
  readonly started_time?: string | null
  readonly ended_time?: string | null
  readonly notes?: string | null
  readonly project_id: number
  readonly task_id: number
  readonly is_running?: boolean
  readonly is_locked?: boolean
  readonly locked_reason?: string | null
}

/** A stretch of one day's clock, in minutes from its midnight. */
export interface CalendarSpan {
  readonly start: number
  /** Past `MINUTES_IN_DAY` when the entry runs on past midnight. */
  readonly end: number
}

export interface CalendarBlock<Entry extends CalendarEntry = CalendarEntry> extends CalendarSpan {
  readonly entry: Entry
  /** Where the column draws it: the start, to the end or to midnight, whichever is first. */
  readonly offsetMinutes: number
  readonly minutes: number
  /** Ends after the midnight closing its own day; drawn to the bottom of the column. */
  readonly overnight: boolean
  readonly running: boolean
  /** Its place among the entries it overlaps, counted from the left. */
  readonly lane: number
  /** How many entries share the widest moment of its overlap, so the width each gets. */
  readonly lanes: number
}

export interface CalendarDay<Entry extends CalendarEntry = CalendarEntry> {
  readonly date: string
  readonly blocks: readonly CalendarBlock<Entry>[]
  /**
   * Entries with no clock time, in the order they were entered. They are
   * listed rather than dropped: an entry missing from a timesheet reads as
   * unworked.
   */
  readonly untimed: readonly Entry[]
  readonly totalSeconds: number
}

/** The local moment the running entries are measured to, and today's line is drawn at. */
export interface CalendarNow {
  readonly date: string
  readonly minutes: number
}

export const minutesFromClock = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined) return null
  const match = /^([0-2][0-9]):([0-5][0-9])$/u.exec(value)
  if (match === null) return null
  const hours = Number(match[1])
  if (hours > 23) return null
  return hours * 60 + Number(match[2])
}

/** Canonical `HH:MM` for a minute of the day; midnight closing the day is `00:00`. */
export const clockFromMinutes = (minutes: number): string => {
  const wrapped = ((Math.round(minutes) % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}

const clamp = (value: number, lowest: number, highest: number): number =>
  Math.min(highest, Math.max(lowest, value))

export const snapMinutes = (minutes: number, step = SNAP_MINUTES): number =>
  Math.round(minutes / step) * step

/**
 * Where an entry sits on its day's clock, or null when it has no clock time.
 *
 * An end before the start crossed midnight: the API stores 22:00-02:00 as four
 * hours, and so does this. An end equal to the start is an entry of no length,
 * not a whole day. A running entry has no end yet and is measured to now when
 * it started today, and to midnight when it started on an earlier day.
 */
export const entrySpan = (entry: CalendarEntry, now?: CalendarNow): CalendarSpan | null => {
  const start = minutesFromClock(entry.started_time)
  if (start === null) return null
  const ended = minutesFromClock(entry.ended_time)
  if (ended === null) {
    if (now !== undefined && entry.spent_date === now.date) {
      return { start, end: Math.max(start, now.minutes) }
    }
    if (now !== undefined && entry.spent_date < now.date) return { start, end: MINUTES_IN_DAY }
    return { start, end: start + Math.max(0, Math.round(entry.seconds / 60)) }
  }
  return { start, end: ended < start ? ended + MINUTES_IN_DAY : ended }
}

interface Laid {
  readonly key: number
  readonly start: number
  readonly end: number
}

/**
 * Side by side, not on top of each other: every run of entries that overlap is
 * one cluster, each entry takes the leftmost lane free when it starts, and the
 * whole cluster divides the column by the lanes it needed. Ends meeting starts
 * do not overlap -- 09:00-10:00 and 10:00-11:00 each keep the full width.
 */
export const assignLanes = (
  spans: readonly Laid[],
): ReadonlyMap<number, { readonly lane: number; readonly lanes: number }> => {
  const ordered = [...spans].sort(
    (left, right) => left.start - right.start || right.end - left.end || left.key - right.key,
  )
  const placed = new Map<number, { lane: number; lanes: number }>()
  let cluster: number[] = []
  let laneEnds: number[] = []
  let clusterEnd = Number.NEGATIVE_INFINITY
  const close = (): void => {
    for (const key of cluster) placed.get(key)!.lanes = laneEnds.length
    cluster = []
    laneEnds = []
  }
  for (const span of ordered) {
    if (span.start >= clusterEnd) {
      close()
      clusterEnd = Number.NEGATIVE_INFINITY
    }
    let lane = laneEnds.findIndex((end) => end <= span.start)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(span.end)
    } else {
      laneEnds[lane] = span.end
    }
    clusterEnd = Math.max(clusterEnd, span.end)
    cluster.push(span.key)
    placed.set(span.key, { lane, lanes: 1 })
  }
  close()
  return placed
}

/**
 * The days of a week, each with its entries placed.
 *
 * `dates` is supplied rather than derived so the caller owns the week's start
 * day, which is an organization setting and not this module's to guess.
 */
export const calendarWeek = <Entry extends CalendarEntry>(
  dates: readonly string[],
  entries: readonly Entry[],
  now?: CalendarNow,
): readonly CalendarDay<Entry>[] =>
  dates.map((date) => {
    const onThisDay = entries.filter((entry) => entry.spent_date === date)
    const totalSeconds = onThisDay.reduce((total, entry) => total + entry.seconds, 0)
    const untimed: Entry[] = []
    const timed: { entry: Entry; span: CalendarSpan }[] = []
    for (const entry of onThisDay) {
      const span = entrySpan(entry, now)
      if (span === null) untimed.push(entry)
      else timed.push({ entry, span })
    }
    // Lanes are worked out on what is drawn: clamped to the day, and never
    // shorter than a snap, so two entries that look overlapping are laid out
    // as overlapping even when one of them has almost no length.
    const drawn = timed.map(({ entry, span }) => {
      const offsetMinutes = clamp(span.start, 0, MINUTES_IN_DAY)
      const minutes = Math.max(0, Math.min(span.end, MINUTES_IN_DAY) - offsetMinutes)
      return { entry, span, offsetMinutes, minutes }
    })
    const lanes = assignLanes(
      drawn.map(({ entry, offsetMinutes, minutes }) => ({
        key: entry.id,
        start: offsetMinutes,
        end: offsetMinutes + Math.max(minutes, MINIMUM_SPAN_MINUTES),
      })),
    )
    const blocks = drawn
      .map(
        ({ entry, span, offsetMinutes, minutes }): CalendarBlock<Entry> => ({
          entry,
          start: span.start,
          end: span.end,
          offsetMinutes,
          minutes,
          overnight: span.end > MINUTES_IN_DAY,
          running: entry.is_running === true,
          lane: lanes.get(entry.id)?.lane ?? 0,
          lanes: lanes.get(entry.id)?.lanes ?? 1,
        }),
      )
      .sort((left, right) => left.start - right.start || left.entry.id - right.entry.id)
    return { date, blocks, untimed, totalSeconds }
  })

/**
 * A press and a drag on empty clock: from the snap nearest where it began to
 * the snap nearest where it is now, in whichever order, never shorter than a
 * snap and never past the day.
 */
export const spanFromDrag = (anchorMinutes: number, pointerMinutes: number): CalendarSpan => {
  const anchor = clamp(snapMinutes(anchorMinutes), 0, MINUTES_IN_DAY)
  const pointer = clamp(snapMinutes(pointerMinutes), 0, MINUTES_IN_DAY)
  let start = Math.min(anchor, pointer)
  let end = Math.max(anchor, pointer)
  if (end - start < MINIMUM_SPAN_MINUTES) {
    end = start + MINIMUM_SPAN_MINUTES
    if (end > MINUTES_IN_DAY) {
      end = MINUTES_IN_DAY
      start = MINUTES_IN_DAY - MINIMUM_SPAN_MINUTES
    }
  }
  return { start, end }
}

/**
 * A click on empty clock with no drag: the hour starting at the quarter the
 * pointer is in, cut short at midnight.
 */
export const spanAt = (minutes: number, length = DEFAULT_SPAN_MINUTES): CalendarSpan => {
  const start = clamp(
    Math.floor(clamp(minutes, 0, MINUTES_IN_DAY - 1) / SNAP_MINUTES) * SNAP_MINUTES,
    0,
    MINUTES_IN_DAY - MINIMUM_SPAN_MINUTES,
  )
  return { start, end: Math.min(MINUTES_IN_DAY, start + Math.max(MINIMUM_SPAN_MINUTES, length)) }
}

/**
 * The same length, somewhere else on the day, its start on a quarter hour.
 *
 * Less than half a snap of movement is no movement: an entry a timer started at
 * 09:05 stays at 09:05 when it is picked up and put back, rather than being
 * saved at 09:00 by a drag that went nowhere. An entry that fitted in its day
 * keeps fitting, so a drag to the bottom stops at midnight rather than quietly
 * turning into a night shift; one that already ran past midnight keeps its
 * length and runs past it from wherever it lands.
 */
export const moveSpan = (span: CalendarSpan, deltaMinutes: number): CalendarSpan => {
  if (Math.abs(deltaMinutes) < SNAP_MINUTES / 2) return span
  const length = span.end - span.start
  const overnight = span.end > MINUTES_IN_DAY
  const latestStart = overnight
    ? MINUTES_IN_DAY - MINIMUM_SPAN_MINUTES
    : MINUTES_IN_DAY - Math.max(length, MINIMUM_SPAN_MINUTES)
  const start = clamp(snapMinutes(span.start + deltaMinutes), 0, Math.max(0, latestStart))
  return { start, end: start + length }
}

/**
 * The end edge to a new snap, never closer than a snap to the start and never
 * past midnight. Like a move, less than half a snap from where it was is no
 * change at all.
 */
export const resizeSpanEnd = (span: CalendarSpan, endMinutes: number): CalendarSpan => {
  if (Math.abs(endMinutes - span.end) < SNAP_MINUTES / 2) return span
  const start = Math.min(span.start, MINUTES_IN_DAY - MINIMUM_SPAN_MINUTES)
  return {
    start,
    end: clamp(snapMinutes(endMinutes), start + MINIMUM_SPAN_MINUTES, MINUTES_IN_DAY),
  }
}

/** The start edge to a new snap, never later than a snap before the end. */
export const resizeSpanStart = (span: CalendarSpan, startMinutes: number): CalendarSpan => {
  if (Math.abs(startMinutes - span.start) < SNAP_MINUTES / 2) return span
  const latest = Math.min(span.end, MINUTES_IN_DAY) - MINIMUM_SPAN_MINUTES
  return { start: clamp(snapMinutes(startMinutes), 0, Math.max(0, latest)), end: span.end }
}

/** Whether two spans are the same stretch of the clock. */
export const sameSpan = (left: CalendarSpan, right: CalendarSpan): boolean =>
  left.start === right.start && left.end === right.end

export const spanSeconds = (span: CalendarSpan): number => (span.end - span.start) * 60

/** The span as the API writes it: start and end as clock times, the end wrapped past midnight. */
export const spanTimes = (
  span: CalendarSpan,
): { readonly startedTime: string; readonly endedTime: string } => ({
  startedTime: clockFromMinutes(span.start),
  endedTime: clockFromMinutes(span.end),
})

/**
 * Where the view opens: half an hour before the earliest thing in it, or
 * before eight in the morning when nothing earlier is there.
 */
export const firstVisibleMinutes = (days: readonly CalendarDay[]): number => {
  const earliest = days
    .flatMap((day) => day.blocks.map((block) => block.offsetMinutes))
    .reduce((lowest, minutes) => Math.min(lowest, minutes), 8 * 60)
  return Math.max(0, Math.floor((earliest - 30) / 30) * 30)
}
