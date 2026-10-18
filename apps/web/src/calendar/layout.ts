import type { ThemePreferenceStore } from '../theme-preference.js'
import { createRootPreference, type NavLayoutTarget, type PreferenceRuntime } from '../nav-layout.js'

/**
 * How the calendar lays a week out (issue 943): all seven days side by side,
 * which stays the default, or one day across the full width -- the tracker
 * design's Day layout.
 *
 * It is the person's choice and remembered the way the colour scheme and the
 * navigation are: a cookie the server reads onto the root, so the calendar is
 * drawn once, in the layout they picked, with no jump after the first paint.
 * The profile has nowhere to keep it without a migration, which the issue said
 * to raise before adding; this needs none.
 */
export const calendarLayouts = ['week', 'day'] as const
export type CalendarLayout = (typeof calendarLayouts)[number]

export const DEFAULT_CALENDAR_LAYOUT: CalendarLayout = 'week'
export const CALENDAR_LAYOUT_COOKIE = 'ezacto_time_layout'

/** Anything unrecognised is the default rather than an error: it is a display preference. */
export const resolveCalendarLayout = (stored: string | null | undefined): CalendarLayout =>
  stored === 'day' ? 'day' : DEFAULT_CALENDAR_LAYOUT

export const isCalendarLayout = (candidate: string | undefined): candidate is CalendarLayout =>
  candidate !== undefined && (calendarLayouts as readonly string[]).includes(candidate)

export const createCalendarLayoutRuntime = (options: {
  readonly store: ThemePreferenceStore
  readonly target: NavLayoutTarget
}): PreferenceRuntime<CalendarLayout> =>
  createRootPreference({
    attribute: 'data-ez-time-layout',
    resolve: resolveCalendarLayout,
    fallback: DEFAULT_CALENDAR_LAYOUT,
    ...options,
  })
