import type { ThemeDefinition, ThemeSlot } from './theme.js'

export interface ThemeContrastRequirement {
  name: string
  foreground: ThemeSlot
  background: ThemeSlot
  minimum: number
}

export interface ThemeContrastResult extends ThemeContrastRequirement {
  ratio: number
  passes: boolean
}

export const precisionContrastRequirements: readonly ThemeContrastRequirement[] = [
  { name: 'ink/ground text', foreground: 'ink', background: 'ground', minimum: 4.5 },
  {
    name: 'action/action-fg text',
    foreground: 'action',
    background: 'action_fg',
    minimum: 4.5,
  },
  // `live` is the timer/now UI indicator, so WCAG AA non-text contrast is 3:1.
  { name: 'live/ground indicator', foreground: 'live', background: 'ground', minimum: 3 },
]

const channel = (value: number): number => {
  const normalized = value / 255
  return normalized <= 0.04045
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4)
}

const luminance = (color: string): number => {
  if (!/^#[0-9A-Fa-f]{6}$/u.test(color)) throw new Error(`invalid RGB color: ${color}`)
  const red = Number.parseInt(color.slice(1, 3), 16)
  const green = Number.parseInt(color.slice(3, 5), 16)
  const blue = Number.parseInt(color.slice(5, 7), 16)
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
}

export const contrastRatio = (first: string, second: string): number => {
  const lighter = Math.max(luminance(first), luminance(second))
  const darker = Math.min(luminance(first), luminance(second))
  return (lighter + 0.05) / (darker + 0.05)
}

export const checkThemeContrast = (
  theme: ThemeDefinition,
  requirements: readonly ThemeContrastRequirement[] = precisionContrastRequirements,
): readonly ThemeContrastResult[] =>
  requirements.map((requirement) => {
    const ratio = contrastRatio(
      theme.colors[requirement.foreground],
      theme.colors[requirement.background],
    )
    return { ...requirement, ratio, passes: ratio >= requirement.minimum }
  })

export const assertThemeContrast = (
  theme: ThemeDefinition,
  requirements: readonly ThemeContrastRequirement[] = precisionContrastRequirements,
): void => {
  const failures = checkThemeContrast(theme, requirements).filter((result) => !result.passes)
  if (failures.length === 0) return

  throw new Error(
    failures
      .map((failure) => `${failure.name}: ${failure.ratio.toFixed(2)} < ${failure.minimum.toFixed(1)}`)
      .join('; '),
  )
}
