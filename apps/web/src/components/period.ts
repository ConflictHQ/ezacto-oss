/**
 * The one period control.
 *
 * Old Harvest put the same control on every screen that shows dated rows: this
 * week, this month, this quarter, this year, custom range, with arrows either
 * side of the label so a period is somewhere you step rather than a dropdown
 * you reset. `08a-team-members.png` catches it on the roster, reading
 * `This week: 14 – 20 Apr 2025`. ezacto had none of it — reports took two bare
 * date inputs, the timesheet took a week it inherited from the shell, and
 * expenses and invoices took nothing at all.
 *
 * This is that control, once, so a screen adopts a period rather than growing
 * its fourth private idea of what "this quarter" means. Four screens each
 * inventing their own is exactly how the eight hand-rolled card lists that
 * `data-table.ts` replaced happened.
 *
 * Three things shaped it:
 *
 * - **The range is the state; the kind is derived.** The control keeps no
 *   canonical period of its own. It reads `from` and `to` off its own date
 *   inputs and asks `detectPeriodKind` what they are, which is what lets a
 *   screen keep the address it already had: `/reports?from=2026-08-01&to=
 *   2026-08-31` renders as "August 2026" with no new query parameter, and
 *   back/forward keeps working because the URL never learned a second way to
 *   say the same thing. Carrying an explicit `period=month` beside the dates
 *   was the alternative, and it is two sources of truth that disagree the
 *   moment somebody hand-edits one of them.
 * - **All arithmetic is UTC and pure.** Every date here is a calendar date and
 *   never an instant, so `2026-03-29` is one day whichever side of a daylight
 *   saving change the reader is on. `weekRange` is the shell's, imported rather
 *   than copied: the week-start setting gets one implementation, and a third
 *   copy of `(day - startIndex + 7) % 7` is how "this week" starts meaning
 *   different things on different screens.
 * - **Stepping runs; typing does not.** An arrow, or a named kind, is a
 *   deliberate move to another period, so it fires `onChange` and the screen
 *   reloads. Editing a custom date is mid-thought — a range is not a range
 *   until both ends are set — so the custom inputs only re-label, and the
 *   screen's own Run control decides when to ask the server. Firing on every
 *   `change` of a `type="date"` field means a request per fumbled year.
 *
 * See screens/HRVST10/OLD-UI-ANALYSIS.md §6, which budgets at most three bands
 * between the tab strip and the first data row: this control is meant to take
 * the place of a screen's date fields inside the filter band it already has,
 * not to arrive as a band of its own.
 */

import { weekRange } from '../shell/model.js'
import { icon } from './icons.js'

export type WeekStartDay = 'saturday' | 'sunday' | 'monday'

export type PeriodKind = 'week' | 'month' | 'quarter' | 'year' | 'custom'

/** The four periods that can be computed from a date. `custom` cannot. */
export type NamedPeriodKind = Exclude<PeriodKind, 'custom'>

export interface PeriodRange {
  readonly from: string
  readonly to: string
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

const PERIOD_NAMES: Readonly<Record<NamedPeriodKind, string>> = {
  week: 'This week',
  month: 'This month',
  quarter: 'This quarter',
  year: 'This year',
}

export const isCalendarDay = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

const day = (value: string): Date => {
  if (!isCalendarDay(value)) throw new RangeError(`invalid calendar date: ${value}`)
  return new Date(`${value}T00:00:00.000Z`)
}

const iso = (date: Date): string => date.toISOString().slice(0, 10)

/**
 * `Date.UTC` reads a two-digit year as nineteen-hundred-and-something, so
 * `Date.UTC(99, 0, 1)` is 1999 and the year 0099 loses its January.
 * `setUTCFullYear` carries no such rule, and it normalises an out-of-range
 * month or day for free: month 12 rolls into the next January, and day 0 is the
 * last day of the month before — which is how every month, quarter and year end
 * below is found without a leap-year table.
 */
const utcDay = (year: number, month: number, dayOfMonth: number): Date => {
  const date = new Date(0)
  date.setUTCFullYear(year, month, dayOfMonth)
  return date
}

const shift = (value: string, days: number): string => {
  const date = day(value)
  date.setUTCDate(date.getUTCDate() + days)
  return iso(date)
}

const daysBetween = (from: string, to: string): number =>
  Math.round((day(to).valueOf() - day(from).valueOf()) / 86_400_000)

/** The period of `kind` that contains `within`. */
export const periodRange = (
  kind: NamedPeriodKind,
  within: string,
  weekStartDay: WeekStartDay = 'monday',
): PeriodRange => {
  if (kind === 'week') return weekRange(within, weekStartDay)
  const date = day(within)
  const year = date.getUTCFullYear()
  if (kind === 'year') return { from: iso(utcDay(year, 0, 1)), to: iso(utcDay(year, 11, 31)) }
  const month = date.getUTCMonth()
  const start = kind === 'quarter' ? Math.floor(month / 3) * 3 : month
  const span = kind === 'quarter' ? 3 : 1
  return { from: iso(utcDay(year, start, 1)), to: iso(utcDay(year, start + span, 0)) }
}

/**
 * Which named period this range *is*, or `custom` when it is none of them. No
 * two named periods can share a range — the shortest month is twenty-eight days
 * and a week is seven — so the order they are tried in cannot change an answer.
 *
 * Total on purpose. A half-typed date in a `type="date"` input reads as the
 * empty string, and a control that threw while somebody was still typing would
 * take the screen down with it.
 */
export const detectPeriodKind = (
  range: PeriodRange,
  weekStartDay: WeekStartDay = 'monday',
): PeriodKind => {
  if (!isCalendarDay(range.from) || !isCalendarDay(range.to)) return 'custom'
  if (range.from > range.to) return 'custom'
  for (const candidate of ['week', 'month', 'quarter', 'year'] as const) {
    const named = periodRange(candidate, range.from, weekStartDay)
    if (named.from === range.from && named.to === range.to) return candidate
  }
  return 'custom'
}

/**
 * One period back or forward. A named period steps to the whole of its
 * neighbour: the month before December 2026 is all of November, not thirty-one
 * days counted back from the 31st, which is what stepping by length would give
 * and why length is only how `custom` moves.
 */
export const stepPeriod = (
  kind: PeriodKind,
  range: PeriodRange,
  direction: -1 | 1,
  weekStartDay: WeekStartDay = 'monday',
): PeriodRange => {
  if (kind === 'custom') {
    const length = daysBetween(range.from, range.to) + 1
    return {
      from: shift(range.from, length * direction),
      to: shift(range.to, length * direction),
    }
  }
  if (kind === 'week') return periodRange('week', shift(range.from, 7 * direction), weekStartDay)
  const start = day(range.from)
  const months = kind === 'quarter' ? 3 : kind === 'year' ? 12 : 1
  return periodRange(
    kind,
    iso(utcDay(start.getUTCFullYear(), start.getUTCMonth() + months * direction, 1)),
    weekStartDay,
  )
}

/**
 * `14 – 20 Apr 2025`, dropping whatever the two ends already share. The legacy
 * capture writes the month once; a range repeating "Apr 2025" twice inside a
 * control this narrow is what makes the label need an ellipsis.
 */
export const formatDayRange = (range: PeriodRange): string => {
  const from = day(range.from)
  const to = day(range.to)
  const month = (date: Date): string => MONTH_NAMES[date.getUTCMonth()]!.slice(0, 3)
  const full = (date: Date): string =>
    `${date.getUTCDate()} ${month(date)} ${date.getUTCFullYear()}`
  if (range.from === range.to) return full(from)
  if (from.getUTCFullYear() !== to.getUTCFullYear()) return `${full(from)} – ${full(to)}`
  if (from.getUTCMonth() !== to.getUTCMonth())
    return `${from.getUTCDate()} ${month(from)} – ${full(to)}`
  return `${from.getUTCDate()} – ${full(to)}`
}

const namedDetail = (kind: Exclude<NamedPeriodKind, 'week'>, from: string): string => {
  const start = day(from)
  if (kind === 'month') return `${MONTH_NAMES[start.getUTCMonth()]!} ${start.getUTCFullYear()}`
  if (kind === 'quarter')
    return `Q${Math.floor(start.getUTCMonth() / 3) + 1} ${start.getUTCFullYear()}`
  return String(start.getUTCFullYear())
}

/**
 * `This week: 14 – 20 Apr 2025` while you are standing in it, and the period's
 * own name once you have stepped away. "This month" over a range that ended in
 * March is the label people read past and then file a report against the wrong
 * period.
 */
export const periodLabel = (
  kind: PeriodKind,
  range: PeriodRange,
  today: string,
): string => {
  if (!isCalendarDay(range.from) || !isCalendarDay(range.to)) return 'Choose a range'
  if (kind === 'custom') return formatDayRange(range)
  // A week names itself by its days, so it reads off the range on screen rather
  // than a recomputed one: re-deriving it would need the week-start setting
  // here, and a label disagreeing with the dates it labels is worse than a
  // label that simply repeats them.
  const detail = kind === 'week' ? formatDayRange(range) : namedDetail(kind, range.from)
  const current = today >= range.from && today <= range.to
  return current ? `${PERIOD_NAMES[kind]}: ${detail}` : detail
}

const KIND_OPTIONS: readonly { readonly kind: PeriodKind; readonly label: string }[] = [
  { kind: 'week', label: 'Week' },
  { kind: 'month', label: 'Month' },
  { kind: 'quarter', label: 'Quarter' },
  { kind: 'year', label: 'Year' },
  { kind: 'custom', label: 'Custom range' },
]

export interface PeriodControlOptions {
  /** The field label above the control. */
  readonly label: string
  /**
   * Read rather than passed, because a tab left open overnight is a real thing
   * and "this week" has to mean the week it is when the arrow is pressed.
   */
  readonly today: () => string
  readonly weekStartDay?: WeekStartDay
  /**
   * A deliberate move to another period: an arrow, or a named kind. Editing a
   * custom date does not reach here — see the module comment.
   */
  readonly onChange: (range: PeriodRange, kind: PeriodKind) => void
}

export interface PeriodControl {
  readonly element: HTMLElement
  range(): PeriodRange
  kind(): PeriodKind
  /**
   * The range a screen already has, from its URL or from a reload. The kind is
   * re-derived from it, so a screen never has to say which period it meant.
   */
  setRange(range: PeriodRange): void
  setWeekStartDay(weekStartDay: WeekStartDay): void
  setDisabled(disabled: boolean): void
}

/** Two controls in one document need two ids for their two labels to point at. */
let controlSequence = 0

export const createPeriodControl = (options: PeriodControlOptions): PeriodControl => {
  let weekStartDay = options.weekStartDay ?? 'monday'
  let kind: PeriodKind = 'custom'
  controlSequence += 1

  const element = document.createElement('div')
  element.className = 'period-control'

  const kindSelect = document.createElement('select')
  kindSelect.className = 'period-kind'
  kindSelect.id = `ez-period-kind-${controlSequence}`
  kindSelect.dataset.periodKind = ''
  for (const entry of KIND_OPTIONS) {
    const option = document.createElement('option')
    option.value = entry.kind
    option.textContent = entry.label
    kindSelect.appendChild(option)
  }

  const fieldLabel = document.createElement('label')
  fieldLabel.className = 'period-field-label'
  fieldLabel.htmlFor = kindSelect.id
  fieldLabel.textContent = options.label

  const stepButton = (direction: -1 | 1): HTMLButtonElement => {
    const button = document.createElement('button')
    // Not a submit: the control usually sits inside the screen's filter form,
    // and a bare <button> there reloads the page on every step.
    button.type = 'button'
    button.className = 'period-step'
    button.dataset[direction === -1 ? 'periodPrevious' : 'periodNext'] = ''
    // The arrow is the whole message, so the button carries the name and the
    // mark inside it stays hidden; naming both makes a reader say it twice.
    button.setAttribute('aria-label', direction === -1 ? 'Previous period' : 'Next period')
    button.appendChild(icon('chevron', { direction: direction === -1 ? 'left' : 'right' }))
    return button
  }
  const previous = stepButton(-1)
  const next = stepButton(1)

  const summary = document.createElement('output')
  summary.className = 'period-summary'
  summary.dataset.periodSummary = ''

  const row = document.createElement('div')
  row.className = 'period-row'
  row.appendChild(previous)
  row.appendChild(kindSelect)
  row.appendChild(summary)
  row.appendChild(next)

  const dateInput = (marker: 'periodFrom' | 'periodTo', label: string): HTMLInputElement => {
    const input = document.createElement('input')
    input.type = 'date'
    input.className = 'period-date'
    input.dataset[marker] = ''
    input.setAttribute('aria-label', label)
    return input
  }
  const fromInput = dateInput('periodFrom', 'From')
  const toInput = dateInput('periodTo', 'To')

  const custom = document.createElement('div')
  custom.className = 'period-custom'
  custom.dataset.periodCustom = ''
  custom.appendChild(fromInput)
  custom.appendChild(toInput)

  element.appendChild(fieldLabel)
  element.appendChild(row)
  element.appendChild(custom)

  const readRange = (): PeriodRange => ({ from: fromInput.value, to: toInput.value })

  const steppable = (range: PeriodRange): boolean =>
    isCalendarDay(range.from) && isCalendarDay(range.to) && range.from <= range.to

  const refresh = (): void => {
    kindSelect.value = kind
    // Hidden rather than removed: the inputs are where the range lives, and the
    // screen reads them back whichever period happens to be showing.
    custom.hidden = kind !== 'custom'
    summary.textContent = periodLabel(kind, readRange(), options.today())
  }

  const apply = (range: PeriodRange): void => {
    fromInput.value = range.from
    toInput.value = range.to
    refresh()
    options.onChange(range, kind)
  }

  const stepOnClick = (direction: -1 | 1) => (): void => {
    const range = readRange()
    // Nothing to step from. A half-filled custom range has no length, and
    // inventing one would move the screen somewhere nobody asked to go.
    if (!steppable(range)) return
    apply(stepPeriod(kind, range, direction, weekStartDay))
  }
  previous.addEventListener('click', stepOnClick(-1))
  next.addEventListener('click', stepOnClick(1))

  kindSelect.addEventListener('change', () => {
    const chosen = KIND_OPTIONS.find((entry) => entry.kind === kindSelect.value)?.kind ?? 'custom'
    kind = chosen
    // Custom keeps the range it was handed. Choosing it is a request to edit
    // the dates on screen, not a request for a different set of them.
    if (chosen === 'custom') {
      refresh()
      return
    }
    apply(periodRange(chosen, options.today(), weekStartDay))
  })

  for (const input of [fromInput, toInput]) {
    input.addEventListener('change', () => {
      // Re-derived, exactly as `setRange` does it. A range is a month because of
      // the dates it holds, not because of which control put them there, and
      // without this the same 1st-to-30th reads as "September 2026" when it is
      // chosen and as a custom range when it is typed -- one range, two labels,
      // depending on a history the reader cannot see.
      kind = detectPeriodKind(readRange(), weekStartDay)
      refresh()
    })
  }

  return {
    element,
    range: readRange,
    kind: () => kind,
    setRange(range) {
      fromInput.value = range.from
      toInput.value = range.to
      kind = detectPeriodKind(range, weekStartDay)
      refresh()
    },
    setWeekStartDay(startDay) {
      weekStartDay = startDay
      // The setting usually lands after the first range does, and a week read
      // as `custom` under the default start is a week again once the
      // organisation's own start is known.
      kind = detectPeriodKind(readRange(), weekStartDay)
      refresh()
    },
    setDisabled(disabled) {
      previous.disabled = disabled
      next.disabled = disabled
      kindSelect.disabled = disabled
      fromInput.disabled = disabled
      toInput.disabled = disabled
    },
  }
}
