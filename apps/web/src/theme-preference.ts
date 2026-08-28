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
