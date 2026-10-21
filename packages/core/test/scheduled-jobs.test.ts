import { describe, expect, it } from 'vitest'
import { dueMonthEndOccurrence, scheduledJobConfig } from '../src/scheduled-jobs.js'

describe('monthly scheduled job policy (#63)', () => {
  it('[unit] normalizes explicit client scope and requires a concrete name and authenticated confirmation', () => {
    expect(
      scheduledJobConfig({
        name: ' Month end ',
        scope: { client_ids: [3, 1, 3] },
        cadence: ' 0  9 1 * * ',
      }),
    ).toEqual({
      action: 'month_end_pack',
      name: 'Month end',
      scope: { client_ids: [1, 3] },
      cadence: '0 9 1 * *',
      confirmation: 'required',
      confirm_within_minutes: 1440,
      is_active: true,
    })
    expect(() => scheduledJobConfig({ name: 'Monthly', confirmation: 'none' })).toThrow(
      /authenticated confirmation/,
    )
    expect(() => scheduledJobConfig({ name: 'Monthly', scope: { client_ids: [0] } })).toThrow(
      /positive integers/,
    )
    expect(() => scheduledJobConfig({ name: 'Monthly', created_by: 123 })).toThrow(/Unknown/)
    expect(() => scheduledJobConfig({ name: ' ' })).toThrow(/name/)
    expect(() => scheduledJobConfig({ name: 'Monthly', cadence: '0 9 * * *' })).toThrow(
      /monthly cadence/,
    )
  })
  it.each([
    ['2026-10-01T08:59:00.000Z', 'UTC', '0 9 1 * *', null],
    ['2026-10-01T09:00:00.000Z', 'UTC', '0 9 1 * *', '2026-09'],
    ['2026-10-15T12:00:00.000Z', 'UTC', '0 9 1 * *', '2026-09'],
    ['2026-10-01T01:00:00.000Z', 'America/Costa_Rica', '0 9 1 * *', '2026-08'],
    ['2026-10-01T15:00:00.000Z', 'America/Costa_Rica', '0 9 1 * *', '2026-09'],
    ['2026-02-28T23:00:00.000Z', 'UTC', '0 0 31 * *', null],
    ['2028-02-29T00:00:00.000Z', 'UTC', '0 0 29 * *', '2028-01'],
    ['2026-03-08T06:59:00.000Z', 'America/New_York', '30 2 8 * *', null],
    ['2026-03-08T07:00:00.000Z', 'America/New_York', '30 2 8 * *', '2026-02'],
    ['2026-11-01T05:30:00.000Z', 'America/New_York', '30 1 1 * *', '2026-10'],
    ['2026-11-01T06:30:00.000Z', 'America/New_York', '30 1 1 * *', '2026-10'],
  ])('[unit] %s on %s with %s yields %s', (now, zone, cadence, expected) => {
    expect(dueMonthEndOccurrence(now, zone, cadence)).toBe(expected)
  })
})
