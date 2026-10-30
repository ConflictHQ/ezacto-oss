import {
  CALENDAR_LAYOUT_COOKIE,
  type CalendarLayout,
  resolveCalendarLayout,
} from './calendar/layout.js'
import {
  NAV_LAYOUT_COOKIE,
  type NavLayout,
  resolveNavLayout,
  resolveSidebarState,
  SIDEBAR_COOKIE,
  type SidebarState,
} from './nav-layout.js'
import {
  COLOR_SCHEME_COOKIE,
  type ColorScheme,
  readCookie,
  resolveColorScheme,
} from './theme-preference.js'

/**
 * The display preferences a page has to be rendered with, rather than switched
 * into once a script runs, read from the request's cookies.
 *
 * The server spreads this into the shell's options, so the first byte of the
 * page already carries the scheme and the layout the person chose -- the
 * sign-in page included, which is the one most often opened cold. Every value
 * goes through its resolver, which knows a closed list and nothing else, so a
 * hand-edited cookie can change a preference and can never reach the markup as
 * itself.
 */
export interface DisplayPreferences {
  readonly colorScheme: ColorScheme
  readonly navLayout: NavLayout
  readonly sidebar: SidebarState
  /** The calendar's Week or Day layout (issue 943). */
  readonly timeLayout: CalendarLayout
}

export const readDisplayPreferences = (
  cookieHeader: string | null | undefined,
): DisplayPreferences => ({
  colorScheme: resolveColorScheme(readCookie(cookieHeader, COLOR_SCHEME_COOKIE)),
  navLayout: resolveNavLayout(readCookie(cookieHeader, NAV_LAYOUT_COOKIE)),
  sidebar: resolveSidebarState(readCookie(cookieHeader, SIDEBAR_COOKIE)),
  timeLayout: resolveCalendarLayout(readCookie(cookieHeader, CALENDAR_LAYOUT_COOKIE)),
})
