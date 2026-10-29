import { formatDuration } from '../week-grid/model.js'
import {
  calendarMonth,
  monthLabel,
  weekdayHeadings,
  type CalendarEntry,
  type WeekStartDay,
} from './model.js'

/**
 * The month as the ezacto-ui calendar draws it: a band naming the month with
 * its total at the right, and under it a grid of weeks, a cell a day with the
 * day's number and a chip an entry ("Project · 4:20"), today's number on a
 * blue disc, the neighbouring months' days greyed. A chip opens its entry; a
 * chip too narrow to read says the whole of it in a tip on hover or focus.
 */

export interface CalendarEntryDisplay extends CalendarEntry {
  readonly project_label: string
  readonly task_label: string
}

export interface CalendarRenderOptions<E extends CalendarEntryDisplay> {
  readonly timeFormat: 'decimal' | 'hours_minutes'
  readonly weekStartDay: WeekStartDay
  readonly today: string
  /** A chip was chosen: open its entry. */
  readonly open?: (entry: E) => void
}

export interface CalendarController {
  /** The month that holds `within`, drawn from the entries given. */
  render<E extends CalendarEntryDisplay>(
    within: string,
    entries: readonly E[],
    options: CalendarRenderOptions<E>,
  ): void
  /** Between months: the band keeps its place and says the grid is on its way. */
  loading(within: string): void
  failed(message: string): void
}

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const dayNumber = (date: string): string => String(Number(date.slice(8, 10)))

export const createCalendarController = (): CalendarController => {
  const panel = document.querySelector<HTMLElement>('[data-calendar-week]')
  if (panel === null) return { render: () => {}, loading: () => {}, failed: () => {} }
  const grid = panel.querySelector<HTMLElement>('[data-calendar-grid]')!
  const status = panel.querySelector<HTMLElement>('[data-calendar-status]')!

  const band = (within: string, total: string | null): HTMLElement => {
    const row = element('div', 'cal-band')
    row.dataset.calendarBand = ''
    row.append(element('p', 'cal-band-title', `${monthLabel(within)} · logged time`))
    const sum = element('div', 'cal-band-total')
    sum.append(element('span', 'cal-band-total-label', 'Month total'))
    const figure = element('strong', 'cal-band-total-figure', total ?? '—')
    figure.dataset.calendarMonthTotal = ''
    sum.append(figure)
    row.append(sum)
    return row
  }

  return {
    loading(within) {
      grid.replaceChildren(band(within, null))
      status.textContent = 'Loading calendar…'
    },
    failed(message) {
      status.textContent = message
    },
    render(within, entries, options) {
      const month = calendarMonth(within, options.weekStartDay, entries)
      const surface = element('div', 'cal-month')
      surface.dataset.calendarMonth = month.monthStart
      surface.setAttribute('role', 'grid')
      surface.setAttribute('aria-label', monthLabel(within))

      // One tip for the whole grid, moved to whichever chip is under the
      // pointer or has focus: above it, inside the grid's edges.
      const tip = element('div', 'cal-tip')
      tip.setAttribute('role', 'tooltip')
      tip.dataset.calendarTip = ''
      tip.hidden = true
      const showTip = (chip: HTMLElement, text: string): void => {
        tip.textContent = text
        tip.hidden = false
        const box = surface.getBoundingClientRect()
        const chipBox = chip.getBoundingClientRect()
        const width = tip.offsetWidth
        const left = Math.max(
          0,
          Math.min(box.width - width, chipBox.left - box.left + (chipBox.width - width) / 2),
        )
        const above = chipBox.top - box.top - tip.offsetHeight - 6
        tip.style.left = `${Math.round(left)}px`
        tip.style.top = `${Math.round(above < 0 ? chipBox.bottom - box.top + 6 : above)}px`
      }
      const hideTip = (): void => {
        tip.hidden = true
      }

      const head = element('div', 'cal-month-head')
      head.setAttribute('role', 'row')
      for (const heading of weekdayHeadings(options.weekStartDay)) {
        const cell = element('div', 'cal-month-heading', heading)
        cell.setAttribute('role', 'columnheader')
        head.append(cell)
      }
      surface.append(head)

      for (const week of month.weeks) {
        const row = element('div', 'cal-month-week')
        row.setAttribute('role', 'row')
        for (const day of week) {
          const cell = element('div', 'cal-cell')
          cell.setAttribute('role', 'gridcell')
          cell.dataset.calendarDay = day.date
          if (!day.inMonth) cell.dataset.outside = ''
          if (day.date === options.today) cell.dataset.today = ''
          cell.setAttribute('aria-label', day.date)
          cell.append(element('span', 'cal-day-num', dayNumber(day.date)))
          for (const entry of day.entries) {
            const duration = formatDuration(entry.seconds, options.timeFormat)
            const chip = element('button', 'cal-entry')
            chip.type = 'button'
            chip.dataset.calendarEntry = String(entry.id)
            if (entry.is_running === true) chip.dataset.running = ''
            chip.append(document.createTextNode(`${entry.project_label} · `))
            chip.append(element('span', 'cal-entry-time', duration))
            chip.setAttribute(
              'aria-label',
              `${entry.project_label} / ${entry.task_label}, ${duration} on ${day.date}`,
            )
            const description = `${entry.project_label} / ${entry.task_label}\n${duration}`
            const show = (): void => showTip(chip, description)
            chip.addEventListener('pointerenter', show)
            chip.addEventListener('focus', show)
            chip.addEventListener('pointerleave', hideTip)
            chip.addEventListener('blur', hideTip)
            chip.addEventListener('click', () => options.open?.(entry))
            cell.append(chip)
          }
          row.append(cell)
        }
        surface.append(row)
      }
      surface.append(tip)

      grid.replaceChildren(
        band(within, formatDuration(month.totalSeconds, options.timeFormat)),
        surface,
      )
      status.textContent = ''
    },
  }
}
