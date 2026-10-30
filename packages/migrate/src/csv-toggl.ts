import type { CsvAdapter, CsvIssue, RawRecord } from './csv-contract.js'

/**
 * The Toggl Track adapter (issue 1012, slice 3): the "detailed" time entries
 * export, read onto the vendor-neutral contract in `csv-contract.ts` and nothing
 * more. It reads a file the person exported; it never calls Toggl and holds no
 * credentials.
 *
 * Columns read: Email, Client, Project, Task, Description, Billable, Start date,
 * Start time, End date, End time, Duration. Every other column (User, Tags, the
 * Amount columns, ...) is ignored and named in a warning. No money is read:
 * Amount and any rate are never carried across.
 *
 * Times are the exporting account's wall clock, exactly as written; nothing is
 * converted. An entry that starts and ends on one date, on whole minutes and with
 * a duration that agrees, goes in with its start and end times; any other entry
 * goes in as hours with its exact duration, spent on its start date.
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
  'duration',
] as const
type TogglColumn = (typeof REQUIRED)[number]

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

const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)$/
const DURATION = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/

const hhmm = (seconds: number): string =>
  `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`

export const togglAdapter: CsvAdapter = (records: readonly RawRecord[]) => {
  const header = records[0]!
  const names = header.fields.map((field) => field.trim().toLowerCase())
  const at = new Map<string, number>()
  names.forEach((name, index) => {
    if (!at.has(name)) at.set(name, index)
  })
  const fileErrors: CsvIssue[] = REQUIRED.filter((name) => !at.has(name)).map((name) => ({
    line: 1,
    code: 'toggl_missing_column',
    message: `The Toggl detailed time entries export has a ${name} column; this file does not.`,
  }))
  if (fileErrors.length > 0) return { records: [], fileErrors, invalid: [], warnings: [] }
  const warnings: CsvIssue[] = names
    .filter((name) => name !== '' && !(REQUIRED as readonly string[]).includes(name))
    .map((name) => ({
      line: 1,
      code: 'toggl_column_ignored',
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
    const raw = (name: TogglColumn): string => record.fields[at.get(name)!] ?? ''
    const get = (name: TogglColumn): string => raw(name).trim()
    const duration = DURATION.exec(get('duration'))
    const from = CLOCK.exec(get('start time'))
    const to = CLOCK.exec(get('end time'))
    if (duration === null) {
      invalid.push({ line, code: 'invalid_duration', message: 'Duration must be HH:MM:SS.' })
      continue
    }
    if (from === null || to === null) {
      invalid.push({
        line,
        code: 'invalid_time',
        message: 'Start time and End time must be HH:MM:SS.',
      })
      continue
    }
    const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
    const startSeconds = Number(from[1]) * 3600 + Number(from[2]) * 60 + Number(from[3])
    const endSeconds = Number(to[1]) * 3600 + Number(to[2]) * 60 + Number(to[3])
    const date = get('start date')
    const timed =
      startSeconds % 60 === 0 &&
      endSeconds % 60 === 0 &&
      get('end date') === date &&
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
