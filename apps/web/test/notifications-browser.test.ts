/** @vitest-environment happy-dom */

import type { TimesheetSubmission } from '@conflict-hq/ezacto-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityRow } from '../src/activity/browser.js'
import {
  createNotificationsController,
  whenLabel,
  type NotificationsIdentity,
} from '../src/notifications/browser.js'
import { renderNotificationsPage } from '../src/notifications/render.js'

const NOW = new Date('2026-09-14T12:00:00.000Z')

const submission = (overrides: Partial<TimesheetSubmission> = {}): TimesheetSubmission => ({
  id: 1,
  user_id: 4,
  user_name: 'Robin Vale',
  period_start: '2026-09-07',
  period_end: '2026-09-13',
  status: 'approved',
  origin: 'native',
  source_status: null,
  source_observed_at: null,
  submitted_by_user_id: 4,
  submitted_at: '2026-09-13T17:00:00.000Z',
  reviewed_by_user_id: 2,
  reviewed_at: '2026-09-14T11:55:00.000Z',
  rejection_reason: null,
  version: 2,
  entry_count: 5,
  expense_count: 0,
  total_seconds: 144_000,
  billable_seconds: 144_000,
  nonbillable_seconds: 0,
  created_at: '2026-09-13T17:00:00.000Z',
  updated_at: '2026-09-14T11:55:00.000Z',
  ...overrides,
})

const event = (overrides: Partial<ActivityRow> = {}): ActivityRow => ({
  event_id: 'e-1',
  event_type: 'invoice.paid',
  aggregate: { type: 'invoice', id: 41 },
  actor: { type: 'system', id: null, name: null },
  occurred_at: '2026-09-14T08:00:00.000Z',
  recorded_at: '2026-09-14T08:00:01.000Z',
  ...overrides,
})

const whoami = (profile: NotificationsIdentity['profile']): NotificationsIdentity => ({
  user_id: 4,
  profile,
})

const mount = (): void => {
  document.body.innerHTML =
    '<nav><a class="crumbs-bell" href="/notifications" aria-label="Notifications" data-notifications-bell>' +
    '<span class="crumbs-bell-count" data-notifications-count hidden></span></a></nav>' +
    renderNotificationsPage('notifications')
}

const titles = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.notif-title')].map((el) => el.textContent ?? '')

const groups = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.notif-group-label')].map((el) => el.textContent ?? '')

const badge = (): { text: string; hidden: boolean; label: string | null } => {
  const count = document.querySelector<HTMLElement>('[data-notifications-count]')!
  return {
    text: count.textContent ?? '',
    hidden: count.hidden,
    label: document.querySelector('[data-notifications-bell]')!.getAttribute('aria-label'),
  }
}

const status = (): string =>
  document.querySelector<HTMLElement>('[data-notifications-status]')?.textContent ?? ''

const fullApi = () => ({
  listTimesheetSubmissions: vi.fn(async () => [
    submission(),
    submission({
      id: 2,
      period_start: '2026-08-31',
      period_end: '2026-09-06',
      status: 'unsubmitted',
      reviewed_at: '2026-09-13T09:00:00.000Z',
      rejection_reason: 'Friday is missing.',
    }),
    // A teammate's week in the same list (an administrator's view) is not news
    // about you.
    submission({ id: 3, user_id: 9, user_name: 'Mira Halvorsen' }),
  ]),
  listPendingTimesheetSubmissions: vi.fn(async () => ({
    submissions: [
      submission({
        id: 5,
        user_id: 7,
        user_name: 'Tomas Lindqvist',
        status: 'submitted',
        submitted_at: '2026-09-14T09:00:00.000Z',
        reviewed_at: null,
      }),
    ],
    nextCursor: null,
  })),
  listApprovedTimesheetSubmissions: vi.fn(async () => ({
    submissions: [
      // Decided by you: a receipt. Your own week in the same list is not news
      // to you here; decisionsOn already says it.
      submission({
        id: 6,
        user_id: 7,
        user_name: 'Tomas Lindqvist',
        period_start: '2026-08-31',
        period_end: '2026-09-06',
        reviewed_by_user_id: 4,
        reviewed_at: '2026-09-12T10:00:00.000Z',
      }),
      submission({ id: 1 }),
    ],
    nextCursor: null,
  })),
  listActivityLog: vi.fn(async () => ({
    data: [
      event(),
      event({
        event_id: 'e-2',
        event_type: 'api_token.created',
        aggregate: { type: 'api_token', id: 7 },
        actor: { type: 'user', id: 2, name: 'Robin Vale' },
        occurred_at: '2026-09-10T10:00:00.000Z',
      }),
    ],
  })),
})

beforeEach(() => {
  localStorage.clear()
})

describe('notifications', () => {
  it('[browser] gathers decisions on your weeks, what awaits your review, and what happened, newest first', async () => {
    mount()
    const api = fullApi()
    await createNotificationsController(api, { now: () => NOW }).activate(
      whoami('administrator'),
      new AbortController().signal,
    )

    expect(titles()).toEqual([
      'Timesheet approved',
      'Approval requested',
      'Invoice paid',
      'Timesheet returned',
      'Timesheet approved',
      'API token created',
    ])
    const texts = [...document.querySelectorAll<HTMLElement>('.notif-text')].map((el) => el.textContent)
    expect(texts[0]).toBe('Your timesheet for 7 – 13 Sep 2026 was approved.')
    expect(texts[1]).toBe('Tomas Lindqvist submitted hours for 7 – 13 Sep 2026.')
    expect(texts[2]).toBe('Invoice #41 was marked as paid.')
    expect(texts[3]).toBe('Your timesheet for 31 Aug – 6 Sep 2026 was returned: Friday is missing.')
    expect(texts[4]).toBe("You approved Tomas Lindqvist's timesheet for 31 Aug – 6 Sep 2026.")
    expect(texts[5]).toBe('Robin Vale created an API token.')
    expect([...document.querySelectorAll<HTMLElement>('.notif-time')].map((el) => el.textContent)).toEqual([
      '5m ago',
      '3h ago',
      '4h ago',
      'Yesterday',
      '2 days ago',
      '4 days ago',
    ])
    // Nothing has been marked read, so everything is new.
    expect(groups()).toEqual(['New'])
    expect(document.querySelectorAll('.notif-card[data-unread]')).toHaveLength(6)
    expect(badge()).toEqual({ text: '6', hidden: false, label: 'Notifications, 6 new' })
    expect(api.listApprovedTimesheetSubmissions).toHaveBeenCalledWith('2026-07-20', undefined, expect.anything())
    expect(document.querySelector<HTMLElement>('[data-notifications-mark-read]')!.hidden).toBe(false)
    expect(status()).toBe('')
    // The decision window is asked for as dates, not left to the server's default.
    expect(api.listTimesheetSubmissions).toHaveBeenCalledWith('2026-07-20', '2026-09-21', expect.anything())
  })

  it('[browser] asks for the review queue and the activity log only from a profile that may read them', async () => {
    // A member reaching for either is answered 403. Not asking is the honest
    // version of not showing: the page says what it has, not what it was refused.
    mount()
    const api = fullApi()
    await createNotificationsController(api, { now: () => NOW }).activate(
      whoami('member'),
      new AbortController().signal,
    )

    expect(api.listPendingTimesheetSubmissions).not.toHaveBeenCalled()
    expect(api.listApprovedTimesheetSubmissions).not.toHaveBeenCalled()
    expect(api.listActivityLog).not.toHaveBeenCalled()
    expect(titles()).toEqual(['Timesheet approved', 'Timesheet returned'])
    expect(badge().text).toBe('2')

    // A reviewer who is not an administrator sees the queue and not the log.
    mount()
    const reviewer = fullApi()
    await createNotificationsController(reviewer, { now: () => NOW }).activate(
      whoami('project_manager'),
      new AbortController().signal,
    )
    expect(reviewer.listPendingTimesheetSubmissions).toHaveBeenCalled()
    expect(reviewer.listActivityLog).not.toHaveBeenCalled()
    expect(titles()).toContain('Approval requested')
  })

  it('[browser] marks everything as read, remembers it, and keeps what arrives after as new', async () => {
    mount()
    const controller = createNotificationsController(fullApi(), { now: () => NOW })
    await controller.activate(whoami('administrator'), new AbortController().signal)
    document.querySelector<HTMLElement>('[data-notifications-mark-read]')!.click()

    expect(groups()).toEqual(['Earlier'])
    expect(document.querySelectorAll('.notif-card[data-unread]')).toHaveLength(0)
    expect(badge()).toEqual({ text: '0', hidden: true, label: 'Notifications' })
    expect(document.querySelector<HTMLElement>('[data-notifications-mark-read]')!.hidden).toBe(true)
    expect(localStorage.getItem('ezacto_notifications_seen_at')).toBe(NOW.toISOString())

    // Later, with one decision newer than the mark: that one alone is new.
    const later = new Date('2026-09-14T13:00:00.000Z')
    const api = fullApi()
    api.listTimesheetSubmissions.mockResolvedValue([
      submission(),
      submission({ id: 8, period_start: '2026-08-24', period_end: '2026-08-30', reviewed_at: '2026-09-14T12:30:00.000Z' }),
    ])
    mount()
    await createNotificationsController(api, { now: () => later }).activate(
      whoami('administrator'),
      new AbortController().signal,
    )
    expect(groups()).toEqual(['New', 'Earlier'])
    expect(
      [...document.querySelectorAll<HTMLElement>('.notif-card[data-unread] .notif-text')].map(
        (el) => el.textContent,
      ),
    ).toEqual(['Your timesheet for 24 – 30 Aug 2026 was approved.'])
    expect(badge().text).toBe('1')
  })

  it('[browser] keeps what loaded when one source fails, and says which', async () => {
    mount()
    const api = fullApi()
    api.listActivityLog.mockRejectedValue(new Error('activity log is unavailable'))
    await createNotificationsController(api, { now: () => NOW }).activate(
      whoami('administrator'),
      new AbortController().signal,
    )

    expect(titles()).toEqual([
      'Timesheet approved',
      'Approval requested',
      'Timesheet returned',
      'Timesheet approved',
    ])
    expect(status()).toBe('Some notifications could not be loaded: activity log is unavailable')
  })

  it('[browser] says so when there is nothing, rather than showing an empty frame', async () => {
    mount()
    await createNotificationsController(
      { listTimesheetSubmissions: vi.fn(async () => []) },
      { now: () => NOW },
    ).activate(whoami('member'), new AbortController().signal)

    expect(titles()).toEqual([])
    expect(status()).toContain('Nothing to show yet.')
    expect(badge().hidden).toBe(true)
  })

  it('[unit] says how long ago in the words a reader uses', () => {
    expect(whenLabel('2026-09-14T11:59:40.000Z', NOW)).toBe('Just now')
    expect(whenLabel('2026-09-14T11:55:00.000Z', NOW)).toBe('5m ago')
    expect(whenLabel('2026-09-14T09:00:00.000Z', NOW)).toBe('3h ago')
    expect(whenLabel('2026-09-13T09:00:00.000Z', NOW)).toBe('Yesterday')
    expect(whenLabel('2026-09-10T10:00:00.000Z', NOW)).toBe('4 days ago')
    expect(whenLabel('2026-09-01T10:00:00.000Z', NOW)).toBe('1 Sep')
    expect(whenLabel('2025-12-24T10:00:00.000Z', NOW)).toBe('24 Dec 2025')
    expect(whenLabel('not a time', NOW)).toBe('')
  })
})
