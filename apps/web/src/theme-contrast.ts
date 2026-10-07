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
  // `muted` is the secondary text: hints, captions, eyebrows and column
  // headers, on the page and on the cards that sit on it. It is the most used
  // text colour after `ink`, and the one a lighter grey most tempts.
  { name: 'muted/ground text', foreground: 'muted', background: 'ground', minimum: 4.5 },
  { name: 'muted/surface text', foreground: 'muted', background: 'surface', minimum: 4.5 },
  {
    name: 'action/action-fg text',
    foreground: 'action',
    background: 'action_fg',
    minimum: 4.5,
  },
  // `live` is the running timer and nothing else: the dot and border on the
  // timer chip, and the inset rule beside a running row or cell. Every one of
  // those is a non-text indicator on `ground`, which AA scores at 3:1. Where
  // the running state is said in words it takes `live_text`, held below.
  { name: 'live/ground indicator', foreground: 'live', background: 'ground', minimum: 3 },
  // `blue_light` is the reading colour on an `ink` ground: the eyebrow on the
  // sign-in splash and the hint on the brand control's dark preview tile. Both
  // are words, so the pair owes the body-text bar.
  { name: 'blue-light/ink text', foreground: 'blue_light', background: 'ink', minimum: 4.5 },
  // `.danger-action` fills a button with `red` and writes its label in
  // `ground` over the fill, so that label is body text and owes 4.5:1. Red is
  // the destructive colour everywhere else it appears, and the fill is that
  // same red rather than a louder one.
  { name: 'ground/red button label', foreground: 'ground', background: 'red', minimum: 4.5 },
  // `live_text` is the running state said in words -- the week-grid cell
  // status on `ground` -- and the paid invoice pill, which writes it on the
  // pill's `status_bg`. Green is the design's settled colour for both.
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
  // Every status pill and band writes its word in `status_fg` on `status_bg`
  // unless a tone overrides it -- a draft invoice, a project's state, the
  // timesheet band's label.
  {
    name: 'status-fg/status-bg text',
    foreground: 'status_fg',
    background: 'status_bg',
    minimum: 4.5,
  },
  // The `$` toggle's label while money is hidden. Pressed is a selected state,
  // so it takes the selected colour, `data`, on the button's own `surface`, and
  // the label is read rather than noticed -- so it owes the text ratio.
  { name: 'data/surface text', foreground: 'data', background: 'surface', minimum: 4.5 },
  // The invoice header's destructive verbs -- cancel and write off -- are red
  // text on the document ground and on the surface the menu row hovers to.
  // They are words, not an indicator, so both owe the 4.5:1 body-text bar. The
  // pairs are listed rather than reasoned about so a darker ground or a
  // brighter red is caught here instead of in review.
  { name: 'red/ground text', foreground: 'red', background: 'ground', minimum: 4.5 },
  { name: 'red/surface text', foreground: 'red', background: 'surface', minimum: 4.5 },
  // The reason an approver gave for rejecting a timesheet, written on the
  // status band. It is prose about a refusal, so it is red and owes 4.5:1.
  { name: 'red/status-bg text', foreground: 'red', background: 'status_bg', minimum: 4.5 },
  // A template save that lost to someone else's newer version says so in
  // amber, the warning that is not yet an error. The amber this replaced gave
  // that sentence under 2:1, and nothing here measured it.
  { name: 'amber/ground text', foreground: 'amber', background: 'ground', minimum: 4.5 },
  // An icon is a non-text graphic and AA asks 3:1 of it — but only while
  // something else names the control. The overflow mark in a table row and the
  // magnifier on the command trigger are the whole label of the control they
  // sit in, and a label owes what text owes however it is drawn. These two are
  // the surfaces those marks inherit their `currentColor` from.
  { name: 'data/ground row action', foreground: 'data', background: 'ground', minimum: 4.5 },
  { name: 'ink/surface control label', foreground: 'ink', background: 'surface', minimum: 4.5 },
  // `surface_2` is the nested surface: a toolbar inside a workspace, a summary
  // band inside a list. It is not a new colour but the next rung of the grey
  // ramp `surface` already stands on -- #FFFFFF, #F9FAFB, #F3F4F6, about six
  // steps apart -- so a panel inside a card reads as one more rung of one ramp.
  // Text in it is `ink`, exactly as on every other surface, and owes 4.5:1.
  { name: 'ink/surface-2 text', foreground: 'ink', background: 'surface_2', minimum: 4.5 },
  // A pressed toggle and the chosen segment of a view switch are filled with
  // `orange_tint`. The slot keeps its name, because stored instance palettes
  // are keyed by it; its job is now the selected tint, and the label on it is
  // `ink`.
  {
    name: 'ink/orange-tint pressed label',
    foreground: 'ink',
    background: 'orange_tint',
    minimum: 4.5,
  },
  // Hovering a table row repaints the row, so the tint has to answer for every
  // colour the row was already carrying, not just its cell text. Two do: `ink`
  // on the cells, and `data` on the row actions the hover reveals -- the same
  // pair the `data/ground row action` row above measures against the unhovered
  // ground. One row each, so a later change to the tint is caught in both.
  //
  // The tint is #EFF3FF, the tracker design's pale blue (its running-timer
  // band uses it): a high-lightness tint of the brand blue that `data` and the
  // billable bar are drawn in. It is reached by pointer or by keyboard focus
  // and by nothing else -- `data-row` goes on every body row unconditionally,
  // and the only rules selecting on it are `:hover` and `:focus-within`. That
  // is worth keeping true rather than incidental, because
  // `print-color-adjust` is set nowhere in this stylesheet: a background fill
  // is not guaranteed to reach paper, so a row tint that meant "overdue" or
  // "selected" would print as nothing and the state would be lost. This one
  // means "the pointer is here", which paper has no use for.
  { name: 'ink/row-hover text', foreground: 'ink', background: 'row_hover', minimum: 4.5 },
  {
    name: 'data/row-hover row action',
    foreground: 'data',
    background: 'row_hover',
    minimum: 4.5,
  },
  // The money band on an invoice, and the two inks that sit on it. Unlike the
  // row tint above, this fill does carry meaning -- it is what makes the totals
  // read as money rather than as one more list -- but the figures and their
  // labels are text either way, so they are held to the text ratio and stay
  // legible if the fill never reaches paper.
  //
  // `ink_2` rather than `muted` for the labels is the whole distinction between
  // those two tokens: `muted` is tuned against the page ground, and this ground
  // is tinted. Checking it here is what keeps that from being a claim.
  { name: 'ink/money totals figure', foreground: 'ink', background: 'money', minimum: 4.5 },
  { name: 'ink-2/money totals label', foreground: 'ink_2', background: 'money', minimum: 4.5 },
]

/*
 * This module carries its own WCAG arithmetic, and `@ezacto/core` carries a
 * second copy for the instance-palette rule (issue 591). That duplication is
 * deliberate and it is held together by a test rather than by an import.
 *
 * `scripts/check-theme-contrast.mjs` is the CI gate for the shipped theme, and
 * it imports this file directly so that Node's type stripping runs it with no
 * build step -- the point being that editing a token and learning the answer
 * are one step. Importing the shared package would put `@ezacto/core`'s
 * compiled output between those two, and a clean checkout would fail the gate
 * with a missing module rather than a contrast figure.
 *
 * The risk duplication actually carries is the two disagreeing about whether a
 * palette is readable, and `test/theme-contrast.test.ts` holds them to each
 * other across the range instead.
 */
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
