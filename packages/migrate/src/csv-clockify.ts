import type { CsvAdapter, CsvIssue, RawRecord } from './csv-contract.js'

/**
 * The Clockify adapter (issue 1012): the "detailed" time report CSV export, read
 * onto the vendor-neutral contract in `csv-contract.ts` and nothing more. It
 * reads a file the person exported; it never calls Clockify and holds no
 * credentials.
 *
 * Columns read: Email, Client, Project, Task, Description, Billable, Start Date,
 * Start Time, End Date, End Time, Duration (h). Every other column (User, Group,
 * Tags, Duration (decimal), the Billable Rate and Amount columns, ...) is ignored
 * and named in a warning. No money is read: rates and amounts are never carried
 * across.
 *
 * Dates are read as YYYY-MM-DD or as Clockify's default MM/DD/YYYY; a file whose
 * dates are DD/MM/YYYY is refused whole rather than read the wrong way round.
 * Times are 24-hour or 12-hour with AM/PM. Times are the exporting account's wall
 * clock, exactly as written; nothing is converted. An entry that starts and ends
 * on one date, on whole minutes and with a duration that agrees, goes in with its
 * start and end times; any other entry goes in as hours with its exact duration,
 * spent on its start date.
 *
 * Two readers share this file. `clockifyAdapter` is the CLI's, unchanged: it
 * accepts ISO or month-first dates and takes the first of any repeated header.
 * `createClockifyBrowserAdapter` is the narrow browser contract (docs/import-
 * tools-plan.md): ISO dates only, a repeated header is a file error, the
 * exporter's zone is stated up front, and every loss of detail is a warning with
 * its line. Each reader has a frozen identity in `CLOCKIFY_ADAPTERS`; a run
 * records one and a later change of reading is a new identity, never a silent
 * reinterpretation of a prior run.
 */

/** Frozen per-run identities. Change a reading by adding a version, not editing one. */
export const CLOCKIFY_ADAPTERS = {
  cli: 'clockify-detailed-cli@1',
  browser: 'clockify-detailed-browser@1',
} as const

export interface ClockifyBrowserOptions {
  /** IANA zone the export's wall-clock times are written in; stated, never converted. */
  exporterZone: string
}

const REQUIRED = [
  'email',
  'client',
  'project',
  'task',
  'description',
  'billable',
  'start date',
  'start time',
  'end date',
  'end time',
  'duration (h)',
] as const
type ClockifyColumn = (typeof REQUIRED)[number]

const CONTRACT_HEADER = [
  'date',
  'person_email',
  'client',
  'project',
  'task',
  'hours',
  'start_time',
  'end_time',
  'notes',
  'billable',
]

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
const CLOCK = /^(\d{1,2}):([0-5]\d):([0-5]\d)(?:\s*([AaPp][Mm]))?$/
const DURATION = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/

const hhmm = (seconds: number): string =>
  `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`

/** Seconds past midnight, or null when the text is not a clock time. */
const clock = (text: string): number | null => {
  const match = CLOCK.exec(text)
  if (match === null) return null
  let hours = Number(match[1])
  const meridiem = match[4]?.toLowerCase()
  if (meridiem === undefined) {
    if (hours > 23) return null
  } else {
    if (hours < 1 || hours > 12) return null
    hours = (hours % 12) + (meridiem === 'pm' ? 12 : 0)
  }
  return hours * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/** YYYY-MM-DD as a real calendar date, or null. */
const isoOnly = (text: string): string | null => {
  if (!ISO_DATE.test(text)) return null
  const [year, month, day] = text.split('-').map(Number)
  const real = new Date(Date.UTC(year!, month! - 1, day!))
  return real.getUTCFullYear() === year &&
    real.getUTCMonth() === month! - 1 &&
    real.getUTCDate() === day
    ? text
    : null
}

/** YYYY-MM-DD, or null when the text is neither accepted form. */
const isoDate = (text: string): string | null => {
  if (ISO_DATE.test(text)) return text
  const match = SLASH_DATE.exec(text)
  if (match === null || Number(match[1]) < 1 || Number(match[1]) > 12) return null
  return `${match[3]}-${match[1]!.padStart(2, '0')}-${match[2]!.padStart(2, '0')}`
}

/** Wall-clock instants in `zone`: 0 is a daylight-saving gap, 2 a repeated hour. */
const wallClockInstants = (date: string, seconds: number, zone: string): number => {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })
  const offsetAt = (instant: number): number => {
    const part = Object.fromEntries(
      format.formatToParts(new Date(instant)).map((item) => [item.type, Number(item.value)]),
    ) as Record<string, number>
    const shown = Date.UTC(
      part.year!,
      part.month! - 1,
      part.day!,
      part.hour!,
      part.minute!,
      part.second!,
    )
    return shown - Math.floor(instant / 1000) * 1000
  }
  const [year, month, day] = date.split('-').map(Number)
  const naive = Date.UTC(year!, month! - 1, day!) + seconds * 1000
  const valid = new Set<number>()
  for (const offset of new Set([offsetAt(naive - 86_400_000), offsetAt(naive + 86_400_000)])) {
    const instant = naive - offset
    if (offsetAt(instant) === offset) valid.add(instant)
  }
  return valid.size
}

const MONEY_COLUMN = /rate|amount|cost|price|currency|invoice/
const ATTACHMENT_COLUMN = /attach|receipt|file/

const readClockify = (
  records: readonly RawRecord[],
  browser: ClockifyBrowserOptions | null,
): ReturnType<CsvAdapter> => {
  const header = records[0]!
  const names = header.fields.map((field) => field.trim().toLowerCase())
  const at = new Map<string, number>()
  names.forEach((name, index) => {
    if (!at.has(name)) at.set(name, index)
  })
  if (browser !== null) {
    const repeated = names.filter((name, index) => name !== '' && names.indexOf(name) !== index)
    if (repeated.length > 0) {
      return {
        records: [],
        fileErrors: [...new Set(repeated)].map((name) => ({
          line: 1,
          code: 'clockify_duplicate_column',
          message: `Column ${name} appears more than once; remove the repeat and export again.`,
        })),
        invalid: [],
        warnings: [],
      }
    }
  }
  const fileErrors: CsvIssue[] = REQUIRED.filter((name) => !at.has(name)).map((name) => ({
    line: 1,
    code: 'clockify_missing_column',
    message: `The Clockify detailed time report has a ${name} column; this file does not.`,
  }))
  if (fileErrors.length > 0) return { records: [], fileErrors, invalid: [], warnings: [] }
  const startDateAt = at.get('start date')!
  const endDateAt = at.get('end date')!
  if (browser !== null) {
    const slashed = records
      .slice(1)
      .find((record) =>
        [startDateAt, endDateAt].some((column) =>
          SLASH_DATE.test((record.fields[column] ?? '').trim()),
        ),
      )
    if (slashed !== undefined) {
      return {
        records: [],
        fileErrors: [
          {
            line: slashed.line,
            code: 'clockify_date_format',
            message:
              'Slash dates cannot be read safely (03/04/2026 is two different days). Export again with the Clockify date format set to YYYY-MM-DD.',
          },
        ],
        invalid: [],
        warnings: [],
      }
    }
  }
  const dayFirst = records.slice(1).find((record) => {
    const match = SLASH_DATE.exec((record.fields[startDateAt] ?? '').trim())
    return match !== null && Number(match[1]) > 12
  })
  if (dayFirst !== undefined) {
    return {
      records: [],
      fileErrors: [
        {
          line: dayFirst.line,
          code: 'clockify_date_format',
          message:
            'Dates look like DD/MM/YYYY. Export again with the Clockify date format set to MM/DD/YYYY or YYYY-MM-DD.',
        },
      ],
      invalid: [],
      warnings: [],
    }
  }
  const warnings: CsvIssue[] = names
    .filter((name) => name !== '' && !(REQUIRED as readonly string[]).includes(name))
    .map((name) => {
      if (browser === null) {
        return { line: 1, code: 'clockify_column_ignored', message: `Column ${name} is not read.` }
      }
      const index = names.indexOf(name)
      const carrying = records
        .slice(1)
        .filter((record) => (record.fields[index] ?? '').trim() !== '').length
      const code = MONEY_COLUMN.test(name)
        ? 'clockify_money_ignored'
        : ATTACHMENT_COLUMN.test(name)
          ? 'clockify_attachment_ignored'
          : 'clockify_column_ignored'
      return {
        line: 1,
        code,
        message: `Column ${name} is not read; ${carrying} of ${records.length - 1} rows carry a value.`,
      }
    })

  const invalid: CsvIssue[] = []
  const out: RawRecord[] = [{ line: 1, fields: CONTRACT_HEADER }]
  for (const record of records.slice(1)) {
    const { line } = record
    if (record.fields.length !== header.fields.length) {
      invalid.push({
        line,
        code: 'column_count',
        message: `The row has ${record.fields.length} fields; the header has ${header.fields.length}.`,
      })
      continue
    }
    const raw = (name: ClockifyColumn): string => record.fields[at.get(name)!] ?? ''
    const get = (name: ClockifyColumn): string => raw(name).trim()
    const duration = DURATION.exec(get('duration (h)'))
    const startSeconds = clock(get('start time'))
    const endSeconds = clock(get('end time'))
    const date = browser === null ? isoDate(get('start date')) : isoOnly(get('start date'))
    const endDate = browser === null ? isoDate(get('end date')) : isoOnly(get('end date'))
    if (duration === null) {
      invalid.push({ line, code: 'invalid_duration', message: 'Duration (h) must be HH:MM:SS.' })
      continue
    }
    if (startSeconds === null || endSeconds === null) {
      invalid.push({
        line,
        code: 'invalid_time',
        message: 'Start Time and End Time must be HH:MM:SS, with AM or PM on a 12-hour clock.',
      })
      continue
    }
    if (date === null || endDate === null) {
      invalid.push({
        line,
        code: 'invalid_date',
        message:
          browser === null
            ? 'Start Date and End Date must be YYYY-MM-DD or MM/DD/YYYY.'
            : 'Start Date and End Date must be YYYY-MM-DD.',
      })
      continue
    }
    const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
    const timed =
      startSeconds % 60 === 0 &&
      endSeconds % 60 === 0 &&
      endDate === date &&
      endSeconds - startSeconds === seconds
    if (browser !== null) {
      const gap = (['start', 'end'] as const).find(
        (side) =>
          wallClockInstants(
            side === 'start' ? date : endDate,
            side === 'start' ? startSeconds : endSeconds,
            browser.exporterZone,
          ) === 0,
      )
      if (gap !== undefined) {
        invalid.push({
          line,
          code: 'clockify_dst_gap',
          message: `The ${gap} time does not exist on that date in ${browser.exporterZone} (a daylight-saving gap); check the exporter zone.`,
        })
        continue
      }
      const repeated = [
        wallClockInstants(date, startSeconds, browser.exporterZone),
        wallClockInstants(endDate, endSeconds, browser.exporterZone),
      ].some((count) => count === 2)
      if (repeated) {
        warnings.push({
          line,
          code: 'clockify_dst_repeated_hour',
          message: `A time falls in an hour that happens twice in ${browser.exporterZone}; it is kept as written and no offset is chosen.`,
        })
      }
      if (!timed) {
        const reasons: string[] = []
        if (endDate !== date) reasons.push('it spans midnight')
        else if (endSeconds - startSeconds !== seconds) {
          warnings.push({
            line,
            code: 'clockify_duration_differs_from_clock',
            message: `Duration (h) is ${seconds} s but the clock says ${endSeconds - startSeconds} s (rounded export or a daylight-saving change); the duration is kept.`,
          })
          reasons.push('Duration (h) differs from the clock')
        }
        if (startSeconds % 60 !== 0 || endSeconds % 60 !== 0) reasons.push('times carry seconds')
        warnings.push({
          line,
          code: 'clockify_timing_dropped',
          message: `Entered as ${seconds} s on ${date} without start and end times: ${reasons.join(', ')}.`,
        })
      }
    }
    out.push({
      line,
      fields: [
        date,
        get('email'),
        get('client'),
        get('project'),
        get('task'),
        // Four decimals of an hour round-trip to the exact second.
        timed ? '' : (seconds / 3600).toFixed(4),
        timed ? hhmm(startSeconds) : '',
        timed ? hhmm(endSeconds) : '',
        raw('description'),
        get('billable').toLowerCase(),
      ],
    })
  }
  return { records: out, fileErrors: [], invalid, warnings }
}

export const clockifyAdapter: CsvAdapter = (records) => readClockify(records, null)

/** The browser pilot's reader. Throws on an exporter zone the runtime does not know. */
export const createClockifyBrowserAdapter = (options: ClockifyBrowserOptions): CsvAdapter => {
  new Intl.DateTimeFormat('en-US', { timeZone: options.exporterZone })
  return (records) => readClockify(records, options)
}
