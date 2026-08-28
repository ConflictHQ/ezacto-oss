import { cssCustomProperty, type ThemeSlot } from '../theme.js'

/** Typed component access to the semantic slot contract. */
export const slot = (name: ThemeSlot): `var(--ez-${string})` =>
  `var(${cssCustomProperty(name)})`
