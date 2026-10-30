import { describe, expect, it } from 'vitest'
import {
  billsAsText,
  projectTimeRounding,
  roundingWithSource,
  secondsBetweenTimes,
} from '../src/components/time-entry-editor.js'
import { recalculationSummary, roundedHours } from '../src/module-settings/time-rounding.js'

describe('what an entry bills as (issue 949)', () => {
  it('[unit] says the rounded hours, the rule and whose it is', () => {
    expect(
      billsAsText(3_900, { mode: 'up', minutes: 15, source: 'project' }),
    ).toBe('Bills as 1.25 h · rounded up to 15 min (project setting)')
    expect(
      billsAsText(3_540, { mode: 'nearest', minutes: 6, source: 'organization' }),
    ).toBe('Bills as 1.00 h · rounded to the nearest 6 min (organization setting)')
    expect(billsAsText(3_540, { mode: 'down', minutes: 60, source: 'organization' })).toBe(
      'Bills as 0.00 h · rounded down to 1 hour (organization setting)',
    )
    expect(billsAsText(3_540, { mode: 'exact', minutes: 15, source: 'organization' })).toBe(
      'Bills as 0.98 h · not rounded (organization setting)',
    )
  })

  it('[unit] reads an end before the start as past midnight', () => {
    expect(secondsBetweenTimes('09:00', '10:30')).toBe(5_400)
    expect(secondsBetweenTimes('23:00', '01:00')).toBe(7_200)
    expect(secondsBetweenTimes('09:00', '09:00')).toBe(0)
    expect(() => secondsBetweenTimes('9:00', '10:00')).toThrow(/canonical/)
  })

  it('[unit] takes the project rule when it has one and the organization rule when it has none', () => {
    const organization = { mode: 'up', minutes: 15 } as const
    expect(
      projectTimeRounding({ time_rounding_mode: 'down', time_rounding_minutes: 30 }, organization),
    ).toEqual({ mode: 'down', minutes: 30, source: 'project' })
    expect(
      projectTimeRounding({ time_rounding_mode: null, time_rounding_minutes: null }, organization),
    ).toEqual({ mode: 'up', minutes: 15, source: 'organization' })
    // A record read without commercial authority carries no rule to speak of.
    expect(projectTimeRounding({ name: 'Alpha' }, organization)).toBeUndefined()
    expect(roundingWithSource({ mode: 'up', minutes: 15, source: 'project' })).toBe(
      'rounded up to 15 min (project setting)',
    )
  })
})

describe('the recalculation preview in words (issue 949)', () => {
  const preview = {
    scope: { project_id: null, from: null, to: null },
    open_entries: 6,
    changed_entries: 3,
    rounded_seconds_before: 10_800,
    rounded_seconds_after: 12_600,
    earliest_spent_date: '2026-09-02',
    latest_spent_date: '2026-09-02',
    projects: [
      {
        project_id: 2,
        project_name: 'Beta',
        time_rounding: { mode: 'up' as const, minutes: 30 as const, source: 'project' as const },
        changed_entries: 3,
        rounded_seconds_before: 10_800,
        rounded_seconds_after: 12_600,
      },
    ],
    kept: { invoiced: 0, approved: 2, locked: 0, other: 1 },
    fingerprint: 'b'.repeat(64),
  }

  it('[unit] leads with the count and the change in hours, then the span, projects and what is kept', () => {
    expect(recalculationSummary(preview)).toEqual([
      '3 entries of 6 open would change, from 3.00 h to 3.50 h (+0.50 h).',
      'Dated 2026-09-02.',
      'Beta: 3 entries, 3.00 h to 3.50 h, rounded up to 30 min (project setting).',
      'Left exactly as they are: 2 approved, 1 running, archived or imported corrections.',
    ])
  })

  it('[unit] says so when there is nothing open and when nothing differs', () => {
    expect(
      recalculationSummary({
        ...preview,
        open_entries: 0,
        changed_entries: 0,
        projects: [],
        kept: { invoiced: 0, approved: 0, locked: 0, other: 0 },
      }),
    ).toEqual(['There are no open entries in this range.'])
    expect(
      recalculationSummary({
        ...preview,
        open_entries: 1,
        changed_entries: 0,
        projects: [],
        kept: { invoiced: 0, approved: 0, locked: 0, other: 0 },
      }),
    ).toEqual(["Nothing to recalculate: the open entries already hold the hours today's rules give."])
  })

  it('[unit] formats hours to two places', () => {
    expect(roundedHours(5_400)).toBe('1.50')
    expect(roundedHours(0)).toBe('0.00')
  })
})
