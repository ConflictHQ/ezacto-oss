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
 */

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

/** YYYY-MM-DD, or null when the text is neither accepted form. */
const isoDate = (text: string): string | null => {
  if (ISO_DATE.test(text)) return text
  const match = SLASH_DATE.exec(text)
  if (match === null || Number(match[1]) < 1 || Number(match[1]) > 12) return null
  return `${match[3]}-${match[1]!.padStart(2, '0')}-${match[2]!.padStart(2, '0')}`
}

export const clockifyAdapter: CsvAdapter = (records: readonly RawRecord[]) => {
  const header = records[0]!
  const names = header.fields.map((field) => field.trim().toLowerCase())
  const at = new Map<string, number>()
  names.forEach((name, index) => {
    if (!at.has(name)) at.set(name, index)
  })
  const fileErrors: CsvIssue[] = REQUIRED.filter((name) => !at.has(name)).map((name) => ({
    line: 1,
    code: 'clockify_missing_column',
    message: `The Clockify detailed time report has a ${name} column; this file does not.`,
  }))
  if (fileErrors.length > 0) return { records: [], fileErrors, invalid: [], warnings: [] }
  const startDateAt = at.get('start date')!
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
    .map((name) => ({
      line: 1,
      code: 'clockify_column_ignored',
      message: `Column ${name} is not read.`,
    }))

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
    const date = isoDate(get('start date'))
    const endDate = isoDate(get('end date'))
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
        message: 'Start Date and End Date must be YYYY-MM-DD or MM/DD/YYYY.',
      })
      continue
    }
    const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
    const timed =
      startSeconds % 60 === 0 &&
      endSeconds % 60 === 0 &&
      endDate === date &&
      endSeconds - startSeconds === seconds
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
