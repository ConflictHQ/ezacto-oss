import {
  calendarAxisLabel,
  calendarWeek,
  type CalendarEntry,
  type TimeEntryMode,
} from './model.js'

export interface CalendarController {
  render(
    dates: readonly string[],
    entries: readonly CalendarEntry[],
    mode: TimeEntryMode,
  ): void
}

const formatHours = (seconds: number): string => {
  const hours = seconds / 3_600
  return `${Number.isInteger(hours) ? hours : hours.toFixed(2)} h`
}

export const createCalendarController = (): CalendarController => {
  const panel = document.querySelector<HTMLElement>('[data-calendar-week]')
  if (panel === null) return { render: () => {} }
  const grid = panel.querySelector<HTMLElement>('[data-calendar-grid]')!
  const status = panel.querySelector<HTMLElement>('[data-calendar-status]')!

  return {
    render(dates, entries, mode) {
      const days = calendarWeek(dates, entries, mode)
      const table = document.createElement('table')
      table.className = 'calendar-table'
      const caption = document.createElement('caption')
      // The axis is not the same thing in both modes, so it is labelled rather
      // than left for the reader to assume.
      caption.textContent = `${calendarAxisLabel(mode)} — ${dates[0] ?? ''} to ${dates.at(-1) ?? ''}`
      table.append(caption)

      const head = document.createElement('thead')
      const headRow = document.createElement('tr')
      for (const day of days) {
        const cell = document.createElement('th')
        cell.scope = 'col'
        cell.textContent = day.date
        headRow.append(cell)
      }
      head.append(headRow)
      table.append(head)

      const body = document.createElement('tbody')
      const bodyRow = document.createElement('tr')
      for (const day of days) {
        const cell = document.createElement('td')
        cell.dataset.calendarDay = day.date
        const column = document.createElement('div')
        column.className = 'calendar-column'
        for (const block of day.blocks) {
          const element = document.createElement('div')
          element.className = 'calendar-block'
          element.dataset.calendarBlock = String(block.id)
          // Minutes drive the height directly, so a two-hour block is twice a
          // one-hour block in either mode. Only the origin differs.
          element.style.setProperty('--calendar-offset', String(block.offsetMinutes))
          element.style.setProperty('--calendar-minutes', String(block.minutes))
          element.textContent =
            block.startedTime === null
              ? formatHours(block.seconds)
              : `${block.startedTime} · ${formatHours(block.seconds)}`
          column.append(element)
        }
        cell.append(column)
        if (day.unplaced.length > 0) {
          // Named rather than silently folded in: these are hours worked that
          // the clock axis cannot show, and a day that hides them reads short.
          const untimed = document.createElement('p')
          untimed.className = 'calendar-untimed'
          untimed.dataset.calendarUntimed = day.date
          untimed.textContent = `${day.unplaced.length} untimed`
          cell.append(untimed)
        }
        const total = document.createElement('p')
        total.className = 'calendar-total'
        total.textContent = formatHours(day.totalSeconds)
        cell.append(total)
        bodyRow.append(cell)
      }
      body.append(bodyRow)
      table.append(body)
      grid.replaceChildren(table)
      status.textContent = ''
    },
  }
}
