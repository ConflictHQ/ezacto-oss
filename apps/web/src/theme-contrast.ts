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
  // `live` is used in two roles, so it answers to two bars and both are listed.
  // As the timer/now marker it is only ever a border, a dot or an inset rule on
  // `ground`, which AA scores as non-text at 3:1. As the auth splash eyebrow it
  // is prose, and it is prose on the `ink` splash rather than on a light
  // surface, so there it owes the 4.5:1 body-text bar and clears it. Carrying
  // only the lenient row would certify a usage the gate never measured.
  { name: 'live/ground indicator', foreground: 'live', background: 'ground', minimum: 3 },
  { name: 'live/ink text', foreground: 'live', background: 'ink', minimum: 4.5 },
  // `.danger-action` fills a button with the live family and writes its label
  // over the fill, so that label is body text and owes 4.5:1 — the indicator
  // row above does not cover it. `live` gave white only 3.58:1, which is why
  // the button now fills with `live_text` instead. Listing the pair means the
  // gate would catch a return to the brighter fill rather than reasoning about
  // it after the fact.
  {
    name: 'ground/live-text button label',
    foreground: 'ground',
    background: 'live_text',
    minimum: 4.5,
  },
  // `live_text` exists for the two places the live colour has to be read as
  // words on a light surface: the rejected timesheet's reason on `status_bg`,
  // and the week-grid cell status on `ground`. It is not a new brand colour —
  // it is `live` at its own hue and saturation with the value stepped down
  // until the darker of those two surfaces clears 4.5:1, which 85% of `live`
  // still misses at 4.19:1 and 80% makes at 4.63:1.
  {
    name: 'live-text/ground text',
    foreground: 'live_text',
    background: 'ground',
    minimum: 4.5,
  },
  {
    name: 'live-text/status-bg text',
    foreground: 'live_text',
    background: 'status_bg',
    minimum: 4.5,
  },
  // The invoice header's destructive verbs -- cancel and write off -- are red
  // text on the document ground and on the surface the menu row hovers to.
  // They are words, not an indicator, so both owe the 4.5:1 body-text bar. The
  // pairs are listed rather than reasoned about so a darker ground or a
  // brighter red is caught here instead of in review.
  { name: 'red/ground text', foreground: 'red', background: 'ground', minimum: 4.5 },
  { name: 'red/surface text', foreground: 'red', background: 'surface', minimum: 4.5 },
  // An icon is a non-text graphic and AA asks 3:1 of it — but only while
  // something else names the control. The overflow mark in a table row and the
  // magnifier on the command trigger are the whole label of the control they
  // sit in, and a label owes what text owes however it is drawn. These two are
  // the surfaces those marks inherit their `currentColor` from.
  { name: 'data/ground row action', foreground: 'data', background: 'ground', minimum: 4.5 },
  { name: 'ink/surface control label', foreground: 'ink', background: 'surface', minimum: 4.5 },
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
