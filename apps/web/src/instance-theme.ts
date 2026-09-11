import type { InstancePaletteContract } from '@ezacto/core'
import { precisionContrastRequirements } from './theme-contrast.js'
import { defaultTheme, themeManifest, themeSlotNames } from './theme.js'

export { INSTANCE_THEME_STYLESHEET_PATH } from '@ezacto/core'

/**
 * What an instance is allowed to change about how it looks (#591), stated from
 * the shipped tokens rather than transcribed from them.
 *
 * This is the one place the design tokens meet the palette rule. The slots are
 * the shell's own list, the base is the built-in theme's own colours, and the
 * legibility pairs are the same ones the built-in theme is held to -- so an
 * operator's palette answers to exactly what the shipped one answers to, and a
 * retuned token or a new requirement reaches instance palettes without anyone
 * remembering to copy it across.
 *
 * The API package takes this as an argument. It cannot import it: `apps/web` is
 * the shell and nothing in `packages` depends on it, which is what keeps a page
 * render off the API's dependency graph. The entry composes both.
 */
export const instancePaletteContract: InstancePaletteContract = {
  slots: themeSlotNames,
  base: themeManifest[defaultTheme].colors,
  requirements: precisionContrastRequirements,
}
