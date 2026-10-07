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
 * page already carries the scheme the person chose -- the sign-in page
 * included, which is the one most often opened cold. Every value goes through
 * its resolver, which knows a closed list and nothing else, so a hand-edited
 * cookie can change a preference and can never reach the markup as itself.
 */
export interface DisplayPreferences {
  readonly colorScheme: ColorScheme
}

export const readDisplayPreferences = (
  cookieHeader: string | null | undefined,
): DisplayPreferences => ({
  colorScheme: resolveColorScheme(readCookie(cookieHeader, COLOR_SCHEME_COOKIE)),
})
