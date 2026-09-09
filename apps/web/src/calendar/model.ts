/**
 * Laying a week of time entries out as a calendar, in either tracking mode.
 *
 * The two modes are not a display preference, they are different data. An
 * organization in `start_end` records when work happened; one in `duration`
 * records only how long it took. A calendar that assumes the first renders an
 * empty grid for the second -- and the account this was written against has
 * 30,684 entries, none of which carries a start time.
 *
 * So the vertical axis means something different in each, and the surface says
 * which. In `start_end` it is the clock. In `duration` it is hours worked, and
 * blocks stack in the order they were entered. What is never done is inventing
 * a clock time for an entry that has none: a 2h entry drawn at 09:00 because it
 * happened to be logged first is a claim about someone's morning that nobody
 * made.
 */

export type TimeEntryMode = 'duration' | 'start_end'

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
}

export interface CalendarBlock {
  readonly id: number
  /** Minutes from the top of the column. */
  readonly offsetMinutes: number
  readonly minutes: number
  /** Only set in start_end mode, where the axis is a clock. */
  readonly startedTime: string | null
  readonly seconds: number
}

export interface CalendarDay {
  readonly date: string
  readonly blocks: readonly CalendarBlock[]
  readonly totalSeconds: number
  /**
   * Entries the mode cannot place on the axis: in start_end, the ones with no
   * recorded time. They are listed rather than dropped -- an entry missing from
   * a timesheet reads as unworked.
   */
  readonly unplaced: readonly CalendarEntry[]
}

const MINUTES_IN_DAY = 24 * 60

const minutesFromClock = (value: string): number | null => {
  const match = /^([0-2][0-9]):([0-5][0-9])$/u.exec(value)
  if (match === null) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23) return null
  return hours * 60 + minutes
}

/**
 * The days of a week, each with its entries placed.
 *
 * `dates` is supplied rather than derived so the caller owns the week's start
 * day, which is an organization setting and not this module's to guess.
 */
export const calendarWeek = (
  dates: readonly string[],
  entries: readonly CalendarEntry[],
  mode: TimeEntryMode,
): readonly CalendarDay[] =>
  dates.map((date) => {
    const onThisDay = entries.filter((entry) => entry.spent_date === date)
    const totalSeconds = onThisDay.reduce((total, entry) => total + entry.seconds, 0)
    if (mode === 'duration') {
      // Stacked in entry order, each block as tall as its own duration. The
      // axis is cumulative hours, so nothing here asserts a time of day.
      let offsetMinutes = 0
      const blocks = onThisDay.map((entry) => {
        const minutes = Math.round(entry.seconds / 60)
        const block: CalendarBlock = {
          id: entry.id,
          offsetMinutes,
          minutes,
          startedTime: null,
          seconds: entry.seconds,
        }
        offsetMinutes += minutes
        return block
      })
      return { date, blocks, totalSeconds, unplaced: [] }
    }
    const blocks: CalendarBlock[] = []
    const unplaced: CalendarEntry[] = []
    for (const entry of onThisDay) {
      const started =
        entry.started_time === null || entry.started_time === undefined
          ? null
          : minutesFromClock(entry.started_time)
      if (started === null) {
        // Recorded without a clock time in an organization that records clock
        // times. Listing it beside the day rather than dropping it: an entry
        // missing from a timesheet reads as unworked.
        unplaced.push(entry)
        continue
      }
      const ended =
        entry.ended_time === null || entry.ended_time === undefined
          ? null
          : minutesFromClock(entry.ended_time)
      // An entry that ends before it starts crossed midnight. Clamping to the
      // end of the day keeps it visible and on the day it was filed against,
      // rather than drawing a block of negative height.
      const spanMinutes =
        ended === null || ended <= started
          ? Math.min(Math.round(entry.seconds / 60), MINUTES_IN_DAY - started)
          : ended - started
      blocks.push({
        id: entry.id,
        offsetMinutes: started,
        minutes: spanMinutes,
        startedTime: entry.started_time ?? null,
        seconds: entry.seconds,
      })
    }
    return {
      date,
      blocks: blocks.sort((left, right) => left.offsetMinutes - right.offsetMinutes),
      totalSeconds,
      unplaced,
    }
  })

/** What the vertical axis measures, which differs by mode and must be labelled. */
export const calendarAxisLabel = (mode: TimeEntryMode): string =>
  mode === 'start_end' ? 'Time of day' : 'Hours worked'
