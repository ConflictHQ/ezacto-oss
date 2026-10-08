import type { ThemeDefinition } from './theme.js'

export interface ThemePolicy<ThemeId extends string> {
  readonly orgDefaultTheme: ThemeId
  readonly orgDocumentTheme: ThemeId
}

export interface ResolvedThemes<ThemeId extends string> {
  readonly application: ThemeId
  readonly document: ThemeId
}

export interface ThemeAttributeTarget {
  setAttribute(name: 'data-ez-theme', value: string): void
}

export interface ThemePreferenceStore {
  read(): string | null
  write(theme: string | null): void
}

export interface ThemeRuntime<ThemeId extends string> {
  current(): ResolvedThemes<ThemeId>
  start(): ResolvedThemes<ThemeId>
  switchUserTheme(theme: ThemeId | null): ResolvedThemes<ThemeId>
}

export interface ThemeRuntimeOptions<ThemeId extends string> {
  readonly registry: Readonly<Record<ThemeId, ThemeDefinition>>
  readonly policy: ThemePolicy<ThemeId>
  readonly preference: ThemePreferenceStore
  readonly applicationRoot: ThemeAttributeTarget
  readonly documentRoots: readonly ThemeAttributeTarget[]
}

const owns = <ThemeId extends string>(
  registry: Readonly<Record<ThemeId, ThemeDefinition>>,
  candidate: string | null,
): candidate is ThemeId => candidate !== null && Object.hasOwn(registry, candidate)

const requireAvailable = <ThemeId extends string>(
  registry: Readonly<Record<ThemeId, ThemeDefinition>>,
  theme: ThemeId,
  source: string,
): ThemeId => {
  if (!owns(registry, theme)) throw new Error(`${source} theme is not available: ${theme}`)
  return theme
}

export const resolveThemes = <ThemeId extends string>(
  registry: Readonly<Record<ThemeId, ThemeDefinition>>,
  policy: ThemePolicy<ThemeId>,
  storedUserTheme: string | null,
): ResolvedThemes<ThemeId> => {
  const application = owns(registry, storedUserTheme)
    ? storedUserTheme
    : requireAvailable(registry, policy.orgDefaultTheme, 'organization default')

  return {
    application,
    document: requireAvailable(registry, policy.orgDocumentTheme, 'organization document'),
  }
}

const apply = <ThemeId extends string>(
  themes: ResolvedThemes<ThemeId>,
  applicationRoot: ThemeAttributeTarget,
  documentRoots: readonly ThemeAttributeTarget[],
): void => {
  applicationRoot.setAttribute('data-ez-theme', themes.application)
  for (const documentRoot of documentRoots) {
    documentRoot.setAttribute('data-ez-theme', themes.document)
  }
}

export const THEME_STORAGE_KEY = 'ezacto.theme'

/**
 * The stored user choice, if the browser will keep one.
 *
 * Mirrors `browserDensityStore`: storage throws in a private window and in a
 * browser set to block site data, and a lost display preference must never be
 * the reason a shell fails to render.
 */
export const browserThemeStore = (storage: Storage): ThemePreferenceStore => ({
  read: () => {
    try {
      return storage.getItem(THEME_STORAGE_KEY)
    } catch {
      return null
    }
  },
  write: (theme) => {
    try {
      if (theme === null) storage.removeItem(THEME_STORAGE_KEY)
      else storage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // Preference lost on this machine; the shell still renders.
    }
  },
})

/**
 * Keeps interactive preference and document branding separate. Deployments may
 * inject additional themes into the registry; the OSS bundle itself still ships
 * only Precision.
 */
export const createThemeRuntime = <ThemeId extends string>(
  options: ThemeRuntimeOptions<ThemeId>,
): ThemeRuntime<ThemeId> => {
  let resolved = resolveThemes(options.registry, options.policy, options.preference.read())

  const applyCurrent = (): ResolvedThemes<ThemeId> => {
    apply(resolved, options.applicationRoot, options.documentRoots)
    return resolved
  }

  return {
    current: () => resolved,
    start: applyCurrent,
    switchUserTheme: (theme) => {
      if (theme !== null) requireAvailable(options.registry, theme, 'user preference')
      options.preference.write(theme)
      resolved = resolveThemes(options.registry, options.policy, theme)
      return applyCurrent()
    },
  }
}

/**
 * Light or dark, and who decides (the 2026-10 reskin).
 *
 * The theme above is the family -- Precision -- and it carries three schemes:
 * light, a dim slate and dark. Which one the application wears is a separate,
 * per-person choice: `system` hands it to the operating system, which only
 * ever asks for light or dark; `light`, `dim` and `dark` override it.
 * Documents are not part of this. An invoice is paper, and stays on the light
 * scheme whatever the person reading it chose.
 *
 * The choice is written to `<html>` as `data-ez-scheme`, and the generated
 * stylesheet does the rest: `system` is a `prefers-color-scheme` media query,
 * so it needs no script at all. What must not wait for a script is an explicit
 * choice, or a dark page would flash white on every load -- so it is stored in
 * a cookie, which the server reads and renders onto the root before the first
 * byte paints. The profile has nowhere to keep a display preference, and a
 * cookie is the one store both the server and this module can read.
 */
export const colorSchemes = ['system', 'light', 'dim', 'dark'] as const
export type ColorScheme = (typeof colorSchemes)[number]

export const DEFAULT_COLOR_SCHEME: ColorScheme = 'system'
export const COLOR_SCHEME_COOKIE = 'ezacto_scheme'

/** Anything unrecognised is the default rather than an error: it is a display preference. */
export const resolveColorScheme = (stored: string | null | undefined): ColorScheme =>
  stored === 'light' || stored === 'dim' || stored === 'dark' ? stored : DEFAULT_COLOR_SCHEME

/**
 * What the browser should paint before the stylesheet has said anything: the
 * canvas behind the page, and its own controls. `system` offers both, so the
 * operating system picks; an explicit choice offers only itself, so a page
 * someone set to light does not open on a dark canvas because their OS is.
 * An instance with a palette of its own keeps it under `system`, so that case
 * is light too. Dim is a dark scheme to the browser's own controls.
 */
export const colorSchemeMeta = (scheme: ColorScheme, instancePalette: boolean): string =>
  scheme === 'system'
    ? instancePalette
      ? 'light'
      : 'light dark'
    : scheme === 'dim'
      ? 'dark'
      : scheme

export interface ColorSchemeTarget {
  setAttribute(name: 'data-ez-scheme', value: string): void
  hasAttribute(name: 'data-ez-palette'): boolean
}

export interface ColorSchemeMeta {
  setAttribute(name: 'content', value: string): void
}

export interface ColorSchemeRuntime {
  current(): ColorScheme
  start(): ColorScheme
  set(scheme: ColorScheme): ColorScheme
}

export const createColorSchemeRuntime = (options: {
  readonly store: ThemePreferenceStore
  readonly target: ColorSchemeTarget
  readonly meta?: ColorSchemeMeta | null
}): ColorSchemeRuntime => {
  let scheme = resolveColorScheme(options.store.read())
  const apply = (): ColorScheme => {
    options.target.setAttribute('data-ez-scheme', scheme)
    options.meta?.setAttribute(
      'content',
      colorSchemeMeta(scheme, options.target.hasAttribute('data-ez-palette')),
    )
    return scheme
  }
  return {
    current: () => scheme,
    start: apply,
    set: (next) => {
      scheme = next
      // The default is the absence of a choice, so it clears the cookie rather
      // than storing the word: an OS that changes its mind is then followed.
      options.store.write(next === DEFAULT_COLOR_SCHEME ? null : next)
      return apply()
    },
  }
}

/** One cookie out of a `Cookie` header, or `null`. Server and browser both read through this. */
export const readCookie = (header: string | null | undefined, name: string): string | null => {
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return null
}

/**
 * A display preference kept in a first-party cookie, so the server can render
 * it into the page. Not HttpOnly, because this module writes it; nothing in it
 * is a secret, and the server validates the value against a closed list before
 * a byte of it reaches markup. A year, because it is a preference and not a
 * session. Like the storage-backed stores, a failure to read or write means the
 * default, quietly: a sandboxed frame throws on `document.cookie`.
 */
export const browserCookieStore = (
  jar: { cookie: string },
  name: string,
  secure: boolean,
): ThemePreferenceStore => ({
  read: () => {
    try {
      return readCookie(jar.cookie, name)
    } catch {
      return null
    }
  },
  write: (value) => {
    const attributes = `; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`
    try {
      jar.cookie =
        value === null
          ? `${name}=${attributes}; Max-Age=0`
          : `${name}=${value}${attributes}; Max-Age=31536000`
    } catch {
      // Preference lost in this browser; the shell still renders.
    }
  },
})
