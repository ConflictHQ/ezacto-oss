import { expect, it } from 'vitest'
import {
  previewTimesheetLockedDates,
  type TimesheetLockPolicySettings,
} from '../src/timesheet-lock-policy.js'

const settings: TimesheetLockPolicySettings = {
  autoLock: true,
  timesheetDeadline: { day: 'monday', time: '00:00' },
  weekStartDay: 'monday',
  timezone: 'America/New_York',
  updatedAt: '2026-01-01T00:00:00.000Z',
}
it('[#1180] evaluates the real local deadline without creating a weekly lock', () => {
  expect(
    previewTimesheetLockedDates(settings, [], ['2026-10-05'], '2026-10-12T03:59:59.000Z').get(
      '2026-10-05',
    ),
  ).toBe(false)
  expect(
    previewTimesheetLockedDates(settings, [], ['2026-10-05'], '2026-10-12T04:00:00.000Z').get(
      '2026-10-05',
    ),
  ).toBe(true)
})
it('[#1180] respects an explicitly unlocked weekly period after its deadline', () => {
  expect(
    previewTimesheetLockedDates(
      settings,
      [
        {
          kind: 'weekly_deadline',
          period_start: '2026-10-05',
          period_end: '2026-10-11',
          unlocked_at: '2026-10-13T00:00:00.000Z',
        },
      ],
      ['2026-10-05'],
      '2026-10-20T04:00:00.000Z',
    ).get('2026-10-05'),
  ).toBe(false)
})
it('[#1180] retains explicit manual locks when automatic locking is disabled', () => {
  expect([
    ...previewTimesheetLockedDates(
      { ...settings, autoLock: false },
      [{ kind: 'manual_cutoff', period_start: null, period_end: '2026-10-06', unlocked_at: null }],
      ['2026-10-05', '2026-10-07'],
      '2026-10-20T04:00:00.000Z',
    ),
  ]).toEqual([
    ['2026-10-05', true],
    ['2026-10-07', false],
  ])
})
