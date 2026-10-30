import { expect, it } from 'vitest'
import { assertOrganizationHolidayFields, timeOffSecondsInWeek } from '../src/index.js'
const h = (value: number) => value * 3600
const day = (date: string, secondsPerDay: number | null = null) => ({
  startDate: date,
  endDate: date,
  secondsPerDay,
})
it('accepts explicit local holiday names and dates and rejects malformed fields', () => {
  expect(() =>
    assertOrganizationHolidayFields({ date: '2028-02-29', name: 'Día libre' }),
  ).not.toThrow()
  for (const fields of [
    { date: '2026-02-30', name: 'Holiday' },
    { date: '2026-10-12', name: '' },
    { date: '2026-10-12', name: ' leading' },
    { date: '2026-10-12', name: 'bad\nname' },
  ])
    expect(() => assertOrganizationHolidayFields(fields)).toThrow()
})
it('unions holidays with personal leave by local day for part-time capacity and every week boundary', () => {
  for (const start of ['2026-10-10', '2026-10-11', '2026-10-12']) {
    expect(timeOffSecondsInWeek([day('2026-10-12'), day('2026-10-12', h(2))], start, h(20))).toBe(
      h(4),
    )
    expect(timeOffSecondsInWeek([day('2026-10-12'), day('2026-10-12', h(8))], start, h(20))).toBe(
      h(8),
    )
  }
})
it('ignores weekend holidays, deduplicates overlapping days and clamps a full week to capacity', () => {
  const week = '2026-10-12'
  expect(timeOffSecondsInWeek([day('2026-10-17'), day('2026-10-18')], week, h(35))).toBe(0)
  expect(timeOffSecondsInWeek([day(week), day(week), day('2026-10-13')], week, h(35))).toBe(h(14))
  expect(
    timeOffSecondsInWeek(
      [{ startDate: week, endDate: '2026-10-16', secondsPerDay: null }, day(week, h(12))],
      week,
      h(35),
    ),
  ).toBe(h(35))
})
