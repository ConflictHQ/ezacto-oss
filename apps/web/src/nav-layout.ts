import type { ThemePreferenceStore } from './theme-preference.js'

/**
 * Where the navigation sits, and how much room it takes (the 2026-10 reskin).
 *
 * One header, two layouts. The links, the timer chip, search and the account
 * are the same elements whichever layout someone picks; the stylesheet lays
 * them out down the left (`sidebar`, the default) or across the top
 * (`topbar`), so there is one set of destinations, one current-page mark and
 * one set of handlers rather than a second copy that drifts. Below 900px both
 * fold into the same Menu drawer, because neither fits.
 *
 * Both choices are the person's and this browser's, kept in cookies for the
 * same reason the colour scheme is: the server renders them onto the root, so
 * the page is laid out once, in the layout chosen, and never jumps from one to
 * the other after the first paint. The profile has nowhere to keep them.
 */
export const navLayouts = ['sidebar', 'topbar'] as const
export type NavLayout = (typeof navLayouts)[number]

export const DEFAULT_NAV_LAYOUT: NavLayout = 'sidebar'
export const NAV_LAYOUT_COOKIE = 'ezacto_nav'

/** Anything unrecognised is the default rather than an error: it is a display preference. */
export const resolveNavLayout = (stored: string | null | undefined): NavLayout =>
  stored === 'topbar' ? 'topbar' : DEFAULT_NAV_LAYOUT

/**
 * The sidebar at full width, or narrowed to its icons. Remembered per browser,
 * like the layout: it is about the screen in front of someone, not about them.
 */
export const sidebarStates = ['expanded', 'collapsed'] as const
export type SidebarState = (typeof sidebarStates)[number]

export const DEFAULT_SIDEBAR_STATE: SidebarState = 'expanded'
export const SIDEBAR_COOKIE = 'ezacto_sidebar'

export const resolveSidebarState = (stored: string | null | undefined): SidebarState =>
  stored === 'collapsed' ? 'collapsed' : DEFAULT_SIDEBAR_STATE

export interface NavLayoutTarget {
  setAttribute(name: 'data-ez-nav' | 'data-ez-sidebar', value: string): void
}

export interface PreferenceRuntime<Value extends string> {
  current(): Value
  start(): Value
  set(value: Value): Value
}

/**
 * The shape density and text size already have, for an attribute on the root.
 * The default is stored as no cookie at all, so a default that changes later
 * reaches everyone who never chose.
 */
const createRootPreference = <Value extends string>(options: {
  readonly attribute: 'data-ez-nav' | 'data-ez-sidebar'
  readonly resolve: (stored: string | null) => Value
  readonly fallback: Value
  readonly store: ThemePreferenceStore
  readonly target: NavLayoutTarget
}): PreferenceRuntime<Value> => {
  let value = options.resolve(options.store.read())
  const apply = (): Value => {
    options.target.setAttribute(options.attribute, value)
    return value
  }
  return {
    current: () => value,
    start: apply,
    set: (next) => {
      value = next
      options.store.write(next === options.fallback ? null : next)
      return apply()
    },
  }
}

export const createNavLayoutRuntime = (options: {
  readonly store: ThemePreferenceStore
  readonly target: NavLayoutTarget
}): PreferenceRuntime<NavLayout> =>
  createRootPreference({
    attribute: 'data-ez-nav',
    resolve: resolveNavLayout,
    fallback: DEFAULT_NAV_LAYOUT,
    ...options,
  })

export const createSidebarRuntime = (options: {
  readonly store: ThemePreferenceStore
  readonly target: NavLayoutTarget
}): PreferenceRuntime<SidebarState> =>
  createRootPreference({
    attribute: 'data-ez-sidebar',
    resolve: resolveSidebarState,
    fallback: DEFAULT_SIDEBAR_STATE,
    ...options,
  })
