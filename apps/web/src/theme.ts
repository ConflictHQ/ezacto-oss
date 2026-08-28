import { generatedDefaultTheme, generatedThemes } from './generated/theme-manifest.js'

export const themeSlotNames = [
  'ground',
  'surface',
  'border',
  'ink',
  'muted',
  'action',
  'action_fg',
  'live',
  'data',
  'money',
  'status_bg',
  'status_fg',
] as const

export const themeFontNames = ['display', 'body', 'mono'] as const

export type ThemeSlot = (typeof themeSlotNames)[number]
export type ThemeFont = (typeof themeFontNames)[number]
export type ThemeName = keyof typeof generatedThemes

export interface ThemeDefinition {
  label: string
  colors: Readonly<Record<ThemeSlot, string>>
  fonts: Readonly<Record<ThemeFont, string>>
  radius: number
  fontStylesheet: string
}

export const themeManifest: Readonly<Record<ThemeName, ThemeDefinition>> = generatedThemes
export const defaultTheme: ThemeName = generatedDefaultTheme

export const cssCustomProperty = (slot: ThemeSlot): `--ez-${string}` =>
  `--ez-${slot.replaceAll('_', '-')}`

/**
 * The browser calls this with its stylesheet-link installer. Supplying only the
 * selected theme's URL makes the no-inactive-font-download rule testable without
 * hiding network behavior behind a framework.
 */
export const loadActiveThemeFonts = async (
  theme: ThemeName,
  loadStylesheet: (href: string) => Promise<void>,
): Promise<void> => loadStylesheet(themeManifest[theme].fontStylesheet)
