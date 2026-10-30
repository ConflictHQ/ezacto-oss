import { startOfDayInTimeZone } from '@ezacto/core'
import { validationError } from './errors.js'
import type { CursorPageEnvelope, KeysetOrder } from './pagination.js'
import { isCanonicalDate } from './resources/support.js'

/**
 * What the three operator logs have in common (issue 929): the email log, the
 * event deliveries and the backup runs are all read newest first, a page at a
 * time, narrowed by filters that arrive in the address.
 */

export type LogOrder = 'newest' | 'oldest'

/** One value for a query parameter, or none. A repeated one is a mistake, not a set. */
export const singleQuery = (requestUrl: URL, name: string): string | undefined => {
  const values = requestUrl.searchParams.getAll(name)
  if (values.length > 1) {
    throw validationError([{ field: name, code: 'duplicate', message: `${name} may appear once` }])
  }
  return values[0]
}

/** One of the values a parameter allows, or undefined when it is absent. */
export const singleChoice = <Choice extends string>(
  requestUrl: URL,
  name: string,
  choices: readonly Choice[],
): Choice | undefined => {
  const value = singleQuery(requestUrl, name)
  if (value === undefined) return undefined
  if (!(choices as readonly string[]).includes(value)) {
    throw validationError([
      { field: name, code: 'unsupported', message: `${name} must be one of ${choices.join(', ')}` },
    ])
  }
  return value as Choice
}

export const logOrder = (requestUrl: URL): LogOrder =>
  singleChoice(requestUrl, 'order', ['newest', 'oldest'] as const) ?? 'newest'

const nextDay = (date: string): string => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

/**
 * `from` and `to` as the calendar days they name in the organization's
 * timezone, turned into the instants that bound them: `from` is the first
 * instant of its day and `to` takes in the whole of its own day.
 */
export const dayRange = (
  requestUrl: URL,
  timeZone: string,
): { createdFrom?: string; createdBefore?: string } => {
  const read = (name: 'from' | 'to'): string | undefined => {
    const value = singleQuery(requestUrl, name)
    if (value === undefined) return undefined
    if (!isCanonicalDate(value)) {
      throw validationError([
        { field: name, code: 'invalid', message: `${name} must be a calendar date (YYYY-MM-DD)` },
      ])
    }
    return value
  }
  const from = read('from')
  const to = read('to')
  if (from !== undefined && to !== undefined && from > to) {
    throw validationError([{ field: 'to', code: 'invalid', message: 'to must not be before from' }])
  }
  return {
    ...(from === undefined ? {} : { createdFrom: startOfDayInTimeZone(from, timeZone) }),
    ...(to === undefined ? {} : { createdBefore: startOfDayInTimeZone(nextDay(to), timeZone) }),
  }
}

/** Where a row sits in a log: when it was created, then its tie-breaking key. */
export type LogPosition = readonly [createdAt: string, ...key: (string | number)[]]

const canonicalInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

/**
 * The cursor order of a log. `keyKinds` says what each tie-breaking part is --
 * a number for a row id, a string for a composite key -- so a position read
 * back from a cursor is checked part by part rather than trusted.
 */
export const logOrderFor = <Row>(
  order: LogOrder,
  keyKinds: readonly ('number' | 'string')[],
  positionOf: (row: Readonly<Row>) => LogPosition,
): KeysetOrder<Row, LogPosition> => ({
  positionOf,
  compare: (left, right) => {
    for (let index = 0; index < left.length; index += 1) {
      const x = left[index]!
      const y = right[index]!
      if (x === y) continue
      const ascending = x < y ? -1 : 1
      return order === 'newest' ? -ascending : ascending
    }
    return 0
  },
  encode: (position) => [...position],
  decode: (value) => {
    if (!Array.isArray(value) || value.length !== keyKinds.length + 1) return null
    const [createdAt, ...key] = value as unknown[]
    if (typeof createdAt !== 'string' || !canonicalInstant.test(createdAt)) return null
    for (let index = 0; index < keyKinds.length; index += 1) {
      const part = key[index]
      if (keyKinds[index] === 'number') {
        if (typeof part !== 'number' || !Number.isSafeInteger(part) || part < 1) return null
      } else if (typeof part !== 'string' || part.length === 0) {
        return null
      }
    }
    return [createdAt, ...(key as (string | number)[])]
  },
})

/** A page envelope that also says how many rows the filters match. */
export const withTotal = <Output>(
  envelope: CursorPageEnvelope<Output>,
  total: number,
): CursorPageEnvelope<Output> & { page: { total: number } } => ({
  ...envelope,
  page: { ...envelope.page, total },
})
