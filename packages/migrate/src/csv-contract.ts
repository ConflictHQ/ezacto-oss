import { createHash } from 'node:crypto'

/**
 * The vendor-neutral CSV time contract (issue 1012, slice 1). One file, one row
 * per time entry, UTF-8, comma separated, a header row of snake_case names.
 *
 * Required columns: date, person_email, client, project, task, and a duration
 * as either `hours` or both `start_time` and `end_time`.
 * Optional columns: notes, billable, rate, currency.
 *
 * No vendor's export is understood here; an adapter (a later slice) maps a
 * vendor's columns onto this and nothing more. `rate` and `currency` are read
 * and validated but never written: the importer creates time, not money, and
 * an entry's rate comes from this instance's own assignments.
 *
 * Dates and times are the person's own wall clock, exactly as written. Nothing
 * is converted between time zones, so nothing can drift across a daylight-saving
 * change: `2026-03-08` is the entry's spent date and `09:30` its start time.
 * A time that carries an offset or a `Z` is refused rather than guessed at.
 */

export const MAX_CSV_BYTES = 5 * 1024 * 1024
export const MAX_CSV_ROWS = 50_000
export const MAX_CSV_COLUMNS = 40
export const MAX_FIELD_LENGTH = 10_000
export const MAX_NAME_LENGTH = 255
export const MAX_HOURS_PER_ENTRY = 24

export const REQUIRED_COLUMNS = ['date', 'person_email', 'client', 'project', 'task'] as const
export const OPTIONAL_COLUMNS = [
  'hours',
  'start_time',
  'end_time',
  'notes',
  'billable',
  'rate',
  'currency',
] as const
const KNOWN_COLUMNS: ReadonlySet<string> = new Set([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS])

export interface CsvIssue {
  /** 1-based physical line of the record in the file; 1 is the header. */
  line: number
  code: string
  message: string
}

export interface CsvRow {
  line: number
  date: string
  personEmail: string
  client: string
  project: string
  task: string
  seconds: number
  startedTime: string | null
  endedTime: string | null
  notes: string | null
  billable: boolean | null
  rate: string | null
  currency: string | null
}

export interface ParsedCsv {
  /** The file stopped here: nothing below was read. */
  fileErrors: CsvIssue[]
  rows: CsvRow[]
  /** Rows that break the contract, with the line each came from. */
  invalid: CsvIssue[]
  warnings: CsvIssue[]
  /** Data rows seen, valid or not. */
  dataRows: number
  sha256: string
  bytes: number
}

const emptyResult = (bytes: Uint8Array, fileErrors: CsvIssue[]): ParsedCsv => ({
  fileErrors,
  rows: [],
  invalid: [],
  warnings: [],
  dataRows: 0,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.byteLength,
})

export interface RawRecord {
  line: number
  fields: string[]
}

/**
 * A vendor adapter: turns the records of a vendor's export (header first) into
 * records of this contract, header first, keeping each record's physical line so
 * every report still points at the vendor's own file. A record it cannot turn
 * into a row is dropped and listed in `invalid`; a file it cannot read at all is
 * a file error.
 */
export type CsvAdapter = (records: readonly RawRecord[]) => {
  records: RawRecord[]
  fileErrors: CsvIssue[]
  invalid: CsvIssue[]
  warnings: CsvIssue[]
}

/**
 * RFC 4180 records, with the line each starts on. A quote opens a field only at
 * its start and closes it only before a comma or a line break; anything else is
 * reported, never repaired, because a guess here becomes somebody's timesheet.
 */
const readRecords = (text: string, sourceLimits = false): { records: RawRecord[]; error: CsvIssue | null } => {
  const records: RawRecord[] = []
  let fields: string[] = []
  let field = ''
  let line = 1
  let recordLine = 1
  let inQuotes = false
  let fieldQuoted = false
  let afterQuote = false
  let started = false
  const endField = () => {
    fields.push(field)
    field = ''
    fieldQuoted = false
    afterQuote = false
  }
  const endRecord = () => {
    endField()
    // A line with nothing on it is a blank line, not a record of one empty field.
    if (!(fields.length === 1 && fields[0] === '' && !started)) {
      records.push({ line: recordLine, fields })
    }
    fields = []
    started = false
  }
  const sourceViolation = (): CsvIssue | null => {
    if (field.length > MAX_FIELD_LENGTH) return {
      line: recordLine, code: 'field_too_long', message: `A source field exceeds ${MAX_FIELD_LENGTH} characters.`,
    }
    if (fields.length >= MAX_CSV_COLUMNS) return {
      line: recordLine, code: 'too_many_columns', message: `A source record exceeds ${MAX_CSV_COLUMNS} columns.`,
    }
    if (records.length > MAX_CSV_ROWS + 1) return {
      line: 1, code: 'too_many_rows', message: `At most ${MAX_CSV_ROWS} data rows.`,
    }
    return null
  }
  for (let index = 0; index < text.length; index += 1) {
    if (sourceLimits) {
      const violation = sourceViolation()
      if (violation !== null) return { records, error: violation }
    }
    const char = text[index]!
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
          afterQuote = true
        }
      } else {
        if (char === '\n') line += 1
        field += char
      }
      continue
    }
    if (char === '"') {
      if (field !== '' || fieldQuoted || afterQuote) {
        return {
          records,
          error: {
            line,
            code: 'malformed_quote',
            message: 'A quote appears inside an unquoted field.',
          },
        }
      }
      inQuotes = true
      fieldQuoted = true
      started = true
      continue
    }
    if (afterQuote && char !== ',' && char !== '\n' && char !== '\r') {
      return {
        records,
        error: {
          line,
          code: 'malformed_quote',
          message: 'Text follows the closing quote of a field.',
        },
      }
    }
    if (char === ',') {
      started = true
      endField()
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      endRecord()
      line += 1
      recordLine = line
    } else {
      started = true
      field += char
    }
  }
  if (sourceLimits) {
    const violation = sourceViolation()
    if (violation !== null) return { records, error: violation }
  }
  if (inQuotes) {
    return {
      records,
      error: {
        line: recordLine,
        code: 'unterminated_quote',
        message: 'A quoted field is never closed.',
      },
    }
  }
  if (started || field !== '' || fields.length > 0) endRecord()
  if (sourceLimits && records.length > MAX_CSV_ROWS + 1) return {
    records, error: { line: 1, code: 'too_many_rows', message: `At most ${MAX_CSV_ROWS} data rows.` },
  }
  return { records, error: null }
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
const DECIMAL_HOURS = /^\d{1,3}(?:\.\d{1,4})?$/
const CLOCK_HOURS = /^(\d{1,3}):([0-5]\d)$/
const EMAIL = /^[^\s@,;<>()[\]"]+@[^\s@,;<>()[\]"]+\.[^\s@,;<>()[\]"]+$/
const RATE = /^\d{1,9}(?:\.\d{1,4})?$/

const validDate = (value: string): boolean => {
  const match = DATE.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    year >= 1970 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

let currencies: ReadonlySet<string> | undefined
/** ISO 4217 codes the runtime knows; a currency outside it is unsupported. */
export const isKnownCurrency = (code: string): boolean => {
  currencies ??= new Set(Intl.supportedValuesOf('currency'))
  return currencies.has(code)
}

/** Cells a spreadsheet would run as a formula if the text were opened in one. */
const FORMULA_START = /^[=+\-@\t\r]/

/** One closed rule for retained text and browser source cells; never evaluate formulas. */
export const isFormulaLikeCsvCell = (raw: string): boolean =>
  raw.trim() !== '' && (FORMULA_START.test(raw) || FORMULA_START.test(raw.trim()))

const TEXT_FIELDS = ['person_email', 'client', 'project', 'task', 'notes'] as const

const truthy = new Set(['true', 'yes', 'y', '1'])
const falsy = new Set(['false', 'no', 'n', '0'])

const parseRow = (
  record: RawRecord,
  columns: ReadonlyMap<string, number>,
): { row: CsvRow | null; issues: CsvIssue[]; warnings: CsvIssue[] } => {
  const issues: CsvIssue[] = []
  const warnings: CsvIssue[] = []
  const { line } = record
  const bad = (code: string, message: string) => issues.push({ line, code, message })
  const raw = (name: string): string => {
    const index = columns.get(name)
    return index === undefined ? '' : (record.fields[index] ?? '')
  }
  const get = (name: string): string => raw(name).trim()

  for (const name of TEXT_FIELDS) {
    const value = get(name)
    if (value.length > (name === 'notes' ? MAX_FIELD_LENGTH : MAX_NAME_LENGTH)) {
      bad('field_too_long', `${name} is longer than the contract allows.`)
    }
    if (isFormulaLikeCsvCell(raw(name))) {
      bad(
        'formula_injection',
        `${name} starts with a character a spreadsheet would run as a formula.`,
      )
    }
  }
  for (const name of ['person_email', 'client', 'project', 'task'] as const) {
    if (get(name) === '') bad('missing_value', `${name} is required.`)
  }
  const personEmail = get('person_email').toLowerCase()
  if (personEmail !== '' && !EMAIL.test(personEmail)) {
    bad('invalid_email', 'person_email is not an email address.')
  }

  const date = get('date')
  if (date === '') bad('missing_value', 'date is required.')
  else if (!validDate(date)) bad('invalid_date', 'date must be a real calendar date as YYYY-MM-DD.')

  const hours = columns.has('hours') ? get('hours') : ''
  const start = columns.has('start_time') ? get('start_time') : ''
  const end = columns.has('end_time') ? get('end_time') : ''
  let seconds = 0
  let startedTime: string | null = null
  let endedTime: string | null = null
  if (hours !== '' && (start !== '' || end !== '')) {
    bad('duration_ambiguous', 'Give hours or start_time and end_time, not both.')
  } else if (hours !== '') {
    const decimal = DECIMAL_HOURS.test(hours)
    const clock = CLOCK_HOURS.exec(hours)
    if (!decimal && !clock) {
      bad(
        'invalid_hours',
        'hours must be decimal hours with a dot (1.5) or H:MM (1:30); a comma is not a decimal point.',
      )
    } else {
      seconds = decimal
        ? Math.round(Number(hours) * 3600)
        : Number(clock![1]) * 3600 + Number(clock![2]) * 60
      if (seconds <= 0 || seconds > MAX_HOURS_PER_ENTRY * 3600) {
        bad('invalid_hours', `hours must be above 0 and at most ${MAX_HOURS_PER_ENTRY}.`)
      }
    }
  } else if (start !== '' || end !== '') {
    const from = TIME.exec(start)
    const to = TIME.exec(end)
    if (!from || !to) {
      bad(
        'invalid_time',
        'start_time and end_time must both be 24-hour HH:MM wall-clock times, without an offset or Z.',
      )
    } else {
      const length =
        (Number(to[1]) * 60 + Number(to[2]) - Number(from[1]) * 60 - Number(from[2])) * 60
      if (length <= 0)
        bad('end_not_after_start', 'end_time must be after start_time on the same date.')
      else {
        seconds = length
        startedTime = start
        endedTime = end
      }
    }
  } else {
    bad('missing_duration', 'Give hours, or start_time and end_time.')
  }

  const billableText = get('billable').toLowerCase()
  let billable: boolean | null = null
  if (billableText !== '') {
    if (truthy.has(billableText)) billable = true
    else if (falsy.has(billableText)) billable = false
    else bad('invalid_billable', 'billable must be true, false, yes, no, 1 or 0.')
  }

  const rate = get('rate')
  if (rate !== '') {
    if (!RATE.test(rate)) bad('invalid_rate', 'rate must be a non-negative decimal number.')
    else
      warnings.push({
        line,
        code: 'rate_not_applied',
        message: 'rate is read but never written; the entry is priced by this instance.',
      })
  }
  const currencyText = get('currency')
  let currency: string | null = null
  if (currencyText !== '') {
    currency = currencyText.toUpperCase()
    if (!/^[A-Z]{3}$/.test(currency) || !isKnownCurrency(currency)) {
      bad('unknown_currency', `currency ${JSON.stringify(currencyText)} is not an ISO 4217 code.`)
    }
  }

  if (issues.length > 0) return { row: null, issues, warnings: [] }
  const notes = get('notes')
  return {
    row: {
      line,
      date,
      personEmail,
      client: get('client'),
      project: get('project'),
      task: get('task'),
      seconds,
      startedTime,
      endedTime,
      notes: notes === '' ? null : notes,
      billable,
      rate: rate === '' ? null : rate,
      currency,
    },
    issues,
    warnings,
  }
}

/**
 * Read and validate a file against the contract. Nothing here throws on bad
 * input: a file that cannot be read says why in `fileErrors`, and a row that
 * breaks the contract is listed in `invalid` with its line while the rest are
 * still read.
 */
export const parseCsv = (bytes: Uint8Array, adapter?: CsvAdapter): ParsedCsv => {
  if (bytes.byteLength > MAX_CSV_BYTES) {
    // Refused before it is decoded or hashed: the size is the whole answer.
    return {
      fileErrors: [
        {
          line: 0,
          code: 'file_too_large',
          message: `The file is ${bytes.byteLength} bytes; the limit is ${MAX_CSV_BYTES}.`,
        },
      ],
      rows: [],
      invalid: [],
      warnings: [],
      dataRows: 0,
      sha256: '',
      bytes: bytes.byteLength,
    }
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return emptyResult(bytes, [
      { line: 0, code: 'not_utf8', message: 'The file is not valid UTF-8.' },
    ])
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (text.includes('\u0000')) {
    return emptyResult(bytes, [
      { line: 0, code: 'binary_content', message: 'The file contains NUL bytes; it is not a CSV.' },
    ])
  }
  // Vendor projection must not discard oversized cells/columns or spend work on excess rows.
  const { records: read, error } = readRecords(text, adapter !== undefined)
  if (error !== null) return emptyResult(bytes, [error])
  if (read.length === 0) {
    return emptyResult(bytes, [
      { line: 1, code: 'empty_file', message: 'The file has no header row.' },
    ])
  }

  if (adapter !== undefined && read[0]!.fields.length > MAX_CSV_COLUMNS) {
    // The source header is bounded before a vendor adapter projects it down.
    return emptyResult(bytes, [
      {
        line: 1,
        code: 'too_many_columns',
        message: `The file has ${read[0]!.fields.length} columns; at most ${MAX_CSV_COLUMNS}.`,
      },
    ])
  }
  const dataRows = read.length - 1
  const fileErrors: CsvIssue[] = []
  const invalid: CsvIssue[] = []
  const warnings: CsvIssue[] = []
  let records: readonly RawRecord[] = read
  if (adapter !== undefined) {
    const adapted = adapter(read)
    if (adapted.fileErrors.length > 0) return emptyResult(bytes, adapted.fileErrors)
    records = adapted.records
    invalid.push(...adapted.invalid)
    warnings.push(...adapted.warnings)
  }
  const header = records[0]!
  const columns = new Map<string, number>()
  if (header.fields.length > MAX_CSV_COLUMNS) {
    fileErrors.push({
      line: 1,
      code: 'too_many_columns',
      message: `At most ${MAX_CSV_COLUMNS} columns.`,
    })
  }
  header.fields.forEach((raw, index) => {
    const name = raw.trim().toLowerCase()
    if (columns.has(name)) {
      fileErrors.push({
        line: 1,
        code: 'duplicate_column',
        message: `Column ${name} appears twice.`,
      })
    } else if (name !== '') {
      columns.set(name, index)
      if (!KNOWN_COLUMNS.has(name)) {
        warnings.push({
          line: 1,
          code: 'unknown_column',
          message: `Column ${name} is not in the contract and is ignored.`,
        })
      }
    }
  })
  for (const name of REQUIRED_COLUMNS) {
    if (!columns.has(name)) {
      fileErrors.push({
        line: 1,
        code: 'missing_column',
        message: `Required column ${name} is missing.`,
      })
    }
  }
  if (!columns.has('hours') && !(columns.has('start_time') && columns.has('end_time'))) {
    fileErrors.push({
      line: 1,
      code: 'missing_duration_column',
      message: 'Give an hours column, or both start_time and end_time columns.',
    })
  }
  if (dataRows > MAX_CSV_ROWS) {
    fileErrors.push({
      line: 1,
      code: 'too_many_rows',
      message: `At most ${MAX_CSV_ROWS} data rows.`,
    })
  }
  if (fileErrors.length > 0) return emptyResult(bytes, fileErrors)

  const rows: CsvRow[] = []
  for (const record of records.slice(1)) {
    if (record.fields.length !== header.fields.length) {
      invalid.push({
        line: record.line,
        code: 'column_count',
        message: `The row has ${record.fields.length} fields; the header has ${header.fields.length}.`,
      })
      continue
    }
    const parsed = parseRow(record, columns)
    invalid.push(...parsed.issues)
    warnings.push(...parsed.warnings)
    if (parsed.row !== null) rows.push(parsed.row)
  }
  return {
    fileErrors,
    rows,
    invalid,
    warnings,
    dataRows,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
  }
}

/**
 * The identity of a row in its source: the sha-256 of what the row says about
 * time (not its line, so reordering a file changes nothing, and not rate or
 * currency, which are never written) plus the count of identical rows before it
 * in the file. Two genuinely identical entries therefore stay two, and the same
 * export read again yields the same keys.
 */
export const sourceKeys = (rows: readonly CsvRow[]): string[] => {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          row.date,
          row.personEmail,
          row.client,
          row.project,
          row.task,
          row.seconds,
          row.startedTime,
          row.endedTime,
          row.notes,
          row.billable,
        ]),
      )
      .digest('hex')
    const occurrence = seen.get(digest) ?? 0
    seen.set(digest, occurrence + 1)
    return `${digest}#${occurrence}`
  })
}

/** Names compare without case, surrounding space or runs of inner space. */
export const nameKey = (value: string): string =>
  value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
