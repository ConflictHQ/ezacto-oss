import type { TimesheetSubmission, Whoami } from '@conflict-hq/ezacto-client'
import type { ActivityRow } from '../activity/browser.js'
import { icon, type IconName } from '../components/icons.js'
import { formatDayRange } from '../components/period.js'

/**
 * Notifications, assembled from what the instance already records.
 *
 * ezacto keeps no notification rows of its own. What it does keep is three
 * things that are notifications in all but name: the decisions taken on your
 * timesheet periods, the periods waiting for your review, and the activity
 * log of what happened to money. This module reads whichever of those the
 * signed-in person may read, puts them in one list, newest first, and paints
 * the bell's count and the Notifications page from it.
 *
 * "Unread" is the one thing none of those sources carry, so it is kept in the
 * browser: the moment you last marked everything as read. That is a
 * convenience of this browser, not a record the instance holds, and the page
 * must read correctly when it is missing (a private window, a cleared site).
 */

export type NotificationTone = 'blue' | 'green' | 'amber' | 'neutral'

export interface Notification {
  readonly id: string
  readonly tone: NotificationTone
  readonly icon: IconName
  readonly title: string
  readonly text: string
  /** When it happened, as the API said it: an ISO timestamp. */
  readonly at: string
}

export interface NotificationsApi {
  listTimesheetSubmissions?(
    periodStart: string,
    periodEnd: string,
    signal?: AbortSignal,
  ): Promise<readonly TimesheetSubmission[]>
  listPendingTimesheetSubmissions?(
    filters?: { readonly userId?: number; readonly clientId?: number; readonly projectId?: number },
    signal?: AbortSignal,
  ): Promise<{ readonly submissions: readonly TimesheetSubmission[] }>
  listApprovedTimesheetSubmissions?(
    periodStart: string,
    filters?: { readonly userId?: number; readonly clientId?: number; readonly projectId?: number },
    signal?: AbortSignal,
  ): Promise<{ readonly submissions: readonly TimesheetSubmission[] }>
  listActivityLog?(
    query: { readonly from?: string; readonly to?: string; readonly event_type?: string },
    signal?: AbortSignal,
  ): Promise<{ readonly data: readonly ActivityRow[] }>
}

export type NotificationsIdentity = Pick<Whoami, 'user_id' | 'profile'>

export interface NotificationsController {
  /**
   * Loads every source the person may read, then paints the bell's count
   * wherever the bell is and the list when the page is on screen. Never
   * throws: a source that fails is named on the page, and the rest still show.
   */
  activate(identity: NotificationsIdentity, signal: AbortSignal): Promise<void>
}

export interface NotificationsOptions {
  /** The clock, so a test can say what "5m ago" is relative to. */
  readonly now?: () => Date
}

const SEEN_KEY = 'ezacto_notifications_seen_at'

/** How far back a decision on your own week still counts as news. */
const DECISION_WINDOW_DAYS = 56

/** The reviewers, as the Approvals page draws them: the three profiles that may approve. */
const reviewerProfiles: ReadonlySet<Whoami['profile']> = new Set([
  'administrator',
  'executive_manager',
  'project_manager',
])

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/**
 * How long ago, in the words someone glancing at a list is thinking. The exact
 * timestamp stays on the element for anyone who needs it.
 */
export const whenLabel = (at: string, now: Date): string => {
  const then = Date.parse(at)
  if (!Number.isFinite(then)) return ''
  const minutes = Math.floor((now.getTime() - then) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  const date = new Date(then)
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ''}`
  return date.getUTCFullYear() === now.getUTCFullYear() ? day : `${day} ${date.getUTCFullYear()}`
}

const calendarDay = (date: Date): string => date.toISOString().slice(0, 10)

const shifted = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 24 * 60 * 60 * 1000)

const periodOf = (submission: TimesheetSubmission): string =>
  formatDayRange({ from: submission.period_start, to: submission.period_end })

/** What was decided about your own weeks: approved, or returned with a reason. */
export const decisionsOn = (
  identity: NotificationsIdentity,
  submissions: readonly TimesheetSubmission[],
): Notification[] =>
  submissions.flatMap((submission): Notification[] => {
    const at = submission.reviewed_at
    if (submission.user_id !== identity.user_id || at === null) return []
    const period = periodOf(submission)
    if (submission.status === 'approved') {
      return [
        {
          id: `submission-${submission.id}-approved`,
          tone: 'green',
          icon: 'check',
          title: 'Timesheet approved',
          text: `Your timesheet for ${period} was approved.`,
          at,
        },
      ]
    }
    if (submission.rejection_reason !== null) {
      return [
        {
          id: `submission-${submission.id}-returned`,
          tone: 'amber',
          icon: 'clock',
          title: 'Timesheet returned',
          text: `Your timesheet for ${period} was returned: ${submission.rejection_reason}`,
          at,
        },
      ]
    }
    return [
      {
        id: `submission-${submission.id}-reopened`,
        tone: 'neutral',
        icon: 'padlock',
        title: 'Timesheet reopened',
        text: `Your timesheet for ${period} was reopened.`,
        at,
      },
    ]
  })

/** What is waiting for a reviewer: everyone else's submitted weeks. */
export const awaitingReview = (
  identity: NotificationsIdentity,
  submissions: readonly TimesheetSubmission[],
): Notification[] =>
  submissions
    .filter((submission) => submission.user_id !== identity.user_id)
    .map((submission) => ({
      id: `pending-${submission.id}`,
      tone: 'amber',
      icon: 'clock',
      title: 'Approval requested',
      text: `${submission.user_name} submitted hours for ${periodOf(submission)}.`,
      at: submission.submitted_at ?? submission.updated_at,
    }))

/**
 * What was decided on the team's weeks, for a reviewer: a decision of yours
 * is a receipt, another reviewer's is news. Your own weeks are decisionsOn's.
 */
export const decidedForTeam = (
  identity: NotificationsIdentity,
  submissions: readonly TimesheetSubmission[],
): Notification[] =>
  submissions.flatMap((submission): Notification[] => {
    const at = submission.reviewed_at
    if (submission.user_id === identity.user_id || at === null) return []
    const period = periodOf(submission)
    const yours = submission.reviewed_by_user_id === identity.user_id
    return [
      {
        id: `approved-${submission.id}`,
        tone: 'green',
        icon: 'check',
        title: 'Timesheet approved',
        text: yours
          ? `You approved ${submission.user_name}'s timesheet for ${period}.`
          : `${submission.user_name}'s timesheet for ${period} was approved.`,
        at,
      },
    ]
  })

const spoken = (eventType: string): string => {
  const words = eventType.replace(/[._]/gu, ' ')
  return words.charAt(0).toLocaleUpperCase('en-US') + words.slice(1)
}

const actorName = (row: ActivityRow): string => {
  if (row.actor?.type === 'system') return 'System'
  return row.actor?.name ?? 'Someone'
}

/** One activity-log event, said the way a notification says it. */
export const fromActivity = (row: ActivityRow): Notification => {
  const who = actorName(row)
  const dot = row.event_type.indexOf('.')
  const kind = dot === -1 ? row.event_type : row.event_type.slice(0, dot)
  const action = dot === -1 ? '' : row.event_type.slice(dot + 1)
  const said = action.replace(/_/gu, ' ')
  const base = { id: `activity-${row.event_id}`, at: row.occurred_at }
  if (kind === 'invoice') {
    const invoice = `Invoice #${row.aggregate.id}`
    switch (action) {
      case 'sent':
        return { ...base, tone: 'blue', icon: 'document', title: 'Invoice sent', text: `${who} sent ${invoice.toLocaleLowerCase('en-US')}.` }
      case 'viewed':
        return { ...base, tone: 'blue', icon: 'eye', title: 'Invoice viewed', text: `${invoice} was opened by its recipient.` }
      case 'paid':
        return { ...base, tone: 'green', icon: 'banknote', title: 'Invoice paid', text: `${invoice} was marked as paid.` }
      case 'partially_paid':
        return { ...base, tone: 'green', icon: 'banknote', title: 'Invoice partly paid', text: `${invoice} was partly paid.` }
      case 'unpaid':
        return { ...base, tone: 'amber', icon: 'banknote', title: 'Invoice unpaid', text: `${invoice} is unpaid again.` }
      case 'created':
        return { ...base, tone: 'blue', icon: 'document', title: 'Invoice created', text: `${who} created ${invoice.toLocaleLowerCase('en-US')}.` }
      default:
        return { ...base, tone: 'blue', icon: 'document', title: `Invoice ${said}`, text: `${invoice} was ${said} by ${who}.` }
    }
  }
  if (kind === 'payment') {
    return {
      ...base,
      tone: 'green',
      icon: 'banknote',
      title: `Payment ${said}`,
      text: `${who} ${said} a payment on invoice #${row.aggregate.id}.`,
    }
  }
  if (kind === 'time_entry') {
    return {
      ...base,
      tone: 'amber',
      icon: 'clock',
      title: 'Time edited for a teammate',
      text: `${who} ${action.replace(/_on_behalf$/u, '').replace(/_/gu, ' ')} a time entry on a teammate's timesheet.`,
    }
  }
  if (kind === 'account') {
    return {
      ...base,
      tone: 'neutral',
      icon: 'person',
      title: 'Account deletion requested',
      text: `${who} asked for their account to be deleted.`,
    }
  }
  if (kind === 'api_token') {
    return {
      ...base,
      tone: 'neutral',
      icon: 'padlock',
      title: `API token ${said}`,
      text: `${who} ${said} an API token.`,
    }
  }
  return {
    ...base,
    tone: 'neutral',
    icon: 'list',
    title: spoken(row.event_type),
    text: `${who} · ${row.aggregate.type.replace(/_/gu, ' ')} #${row.aggregate.id}`,
  }
}

const readSeen = (): number => {
  try {
    const value = localStorage.getItem(SEEN_KEY)
    const parsed = value === null ? Number.NaN : Date.parse(value)
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
  } catch {
    return Number.NEGATIVE_INFINITY
  }
}

const writeSeen = (at: Date): void => {
  try {
    localStorage.setItem(SEEN_KEY, at.toISOString())
  } catch {
    // A private window or blocked site data: the page still paints, and every
    // item simply stays new until the browser lets the mark be kept.
  }
}

const card = (item: Notification, unread: boolean, now: Date): HTMLElement => {
  const article = document.createElement('article')
  article.className = 'notif-card'
  article.dataset.notification = item.id
  if (unread) article.dataset.unread = ''
  const mark = document.createElement('span')
  mark.className = 'notif-icon'
  mark.dataset.tone = item.tone
  mark.append(icon(item.icon))
  const body = document.createElement('div')
  body.className = 'notif-body'
  const title = document.createElement('p')
  title.className = 'notif-title'
  title.textContent = item.title
  const text = document.createElement('p')
  text.className = 'notif-text'
  text.textContent = item.text
  body.append(title, text)
  const time = document.createElement('time')
  time.className = 'notif-time'
  time.dateTime = item.at
  time.title = item.at
  time.textContent = whenLabel(item.at, now)
  article.append(mark, body, time)
  if (unread) {
    const dot = document.createElement('span')
    dot.className = 'notif-unread-dot'
    dot.setAttribute('role', 'img')
    dot.setAttribute('aria-label', 'Unread')
    article.append(dot)
  }
  return article
}

const groupLabel = (text: string): HTMLElement => {
  const label = document.createElement('h2')
  label.className = 'notif-group-label'
  label.textContent = text
  return label
}

export const createNotificationsController = (
  api: NotificationsApi,
  options: NotificationsOptions = {},
): NotificationsController => {
  const clock = options.now ?? (() => new Date())
  let items: readonly Notification[] = []
  let failures: readonly string[] = []

  const paint = (): void => {
    const now = clock()
    const seen = readSeen()
    const unread = items.filter((item) => Date.parse(item.at) > seen)
    const read = items.filter((item) => !(Date.parse(item.at) > seen))

    const bell = document.querySelector<HTMLElement>('[data-notifications-bell]')
    const count = document.querySelector<HTMLElement>('[data-notifications-count]')
    if (bell !== null && count !== null) {
      count.textContent = unread.length > 9 ? '9+' : String(unread.length)
      count.hidden = unread.length === 0
      bell.setAttribute(
        'aria-label',
        unread.length === 0 ? 'Notifications' : `Notifications, ${unread.length} new`,
      )
    }

    const page = document.querySelector<HTMLElement>('[data-notifications-page]')
    if (page === null) return
    const list = page.querySelector<HTMLElement>('[data-notifications-list]')
    const status = page.querySelector<HTMLElement>('[data-notifications-status]')
    const markRead = page.querySelector<HTMLElement>('[data-notifications-mark-read]')
    if (list === null || status === null || markRead === null) return
    const groups: HTMLElement[] = []
    if (unread.length > 0) groups.push(groupLabel('New'), ...unread.map((item) => card(item, true, now)))
    if (read.length > 0) groups.push(groupLabel('Earlier'), ...read.map((item) => card(item, false, now)))
    list.replaceChildren(...groups)
    markRead.hidden = unread.length === 0
    if (failures.length > 0) {
      status.textContent = `Some notifications could not be loaded: ${failures.join('; ')}`
    } else if (items.length === 0) {
      status.textContent =
        'Nothing to show yet. Decisions on your timesheets, and what is waiting for your review, land here.'
    } else {
      status.textContent = ''
    }
  }

  const wireMarkRead = (): void => {
    const markRead = document.querySelector<HTMLElement>('[data-notifications-mark-read]')
    if (markRead === null || markRead.dataset.wired !== undefined) return
    markRead.dataset.wired = ''
    markRead.addEventListener('click', () => {
      writeSeen(clock())
      paint()
    })
  }

  const message = (reason: unknown): string =>
    reason instanceof Error ? reason.message : 'the request failed'

  return {
    async activate(identity, signal) {
      wireMarkRead()
      const now = clock()
      const sources: Promise<readonly Notification[]>[] = []
      if (api.listTimesheetSubmissions !== undefined) {
        sources.push(
          api
            .listTimesheetSubmissions(
              calendarDay(shifted(now, -DECISION_WINDOW_DAYS)),
              calendarDay(shifted(now, 7)),
              signal,
            )
            .then((submissions) => decisionsOn(identity, submissions)),
        )
      }
      if (reviewerProfiles.has(identity.profile)) {
        if (api.listPendingTimesheetSubmissions !== undefined) {
          sources.push(
            api
              .listPendingTimesheetSubmissions(undefined, signal)
              .then((page) => awaitingReview(identity, page.submissions)),
          )
        }
        if (api.listApprovedTimesheetSubmissions !== undefined) {
          sources.push(
            api
              .listApprovedTimesheetSubmissions(
                calendarDay(shifted(now, -DECISION_WINDOW_DAYS)),
                undefined,
                signal,
              )
              .then((page) => decidedForTeam(identity, page.submissions)),
          )
        }
      }
      if (identity.profile === 'administrator' && api.listActivityLog !== undefined) {
        sources.push(api.listActivityLog({}, signal).then((page) => page.data.map(fromActivity)))
      }
      const settled = await Promise.allSettled(sources)
      if (signal.aborted) return
      items = settled
        .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
        .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
        .slice(0, 50)
      failures = settled.flatMap((result) =>
        result.status === 'rejected' ? [message(result.reason)] : [],
      )
      paint()
    },
  }
}
