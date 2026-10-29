/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCalendarController,
  type CalendarEntryDisplay,
} from '../src/calendar/browser.js'

const entry = (overrides: Partial<CalendarEntryDisplay> = {}): CalendarEntryDisplay => ({
  id: 1,
  spent_date: '2026-09-15',
  seconds: 15_600,
  project_id: 1,
  task_id: 1,
  project_label: 'LIMS Integration',
  task_label: 'Dev / Data pipeline',
  ...overrides,
})

const mount = (): void => {
  document.body.innerHTML =
    '<section data-calendar-week><p data-calendar-status>Loading calendar…</p><div data-calendar-grid></div></section>'
}

describe('calendar surface', () => {
  beforeEach(mount)

  it('[browser] draws the month as weeks of cells, a chip an entry, and names its total', () => {
    const open = vi.fn()
    createCalendarController().render(
      '2026-09-10',
      [entry(), entry({ id: 2, spent_date: '2026-09-17', seconds: 1_800, is_running: true })],
      { timeFormat: 'hours_minutes', weekStartDay: 'monday', today: '2026-09-17', open },
    )
    expect(document.querySelector('[data-calendar-band] .cal-band-title')?.textContent).toBe(
      'September 2026 · logged time',
    )
    expect(document.querySelector('[data-calendar-month-total]')?.textContent).toBe('4:50')
    const headings = [...document.querySelectorAll('.cal-month-heading')].map((h) => h.textContent)
    expect(headings).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    expect(document.querySelectorAll('.cal-month-week')).toHaveLength(5)
    expect(document.querySelectorAll('.cal-cell')).toHaveLength(35)
    // August's days fill the first week greyed; today wears its number alone.
    const first = document.querySelector<HTMLElement>('[data-calendar-day="2026-08-31"]')!
    expect(first.hasAttribute('data-outside')).toBe(true)
    expect(first.querySelector('.cal-day-num')?.textContent).toBe('31')
    const today = document.querySelector<HTMLElement>('[data-calendar-day="2026-09-17"]')!
    expect(today.hasAttribute('data-today')).toBe(true)
    expect(today.querySelector('.cal-day-num')?.textContent).toBe('17')

    const chip = document.querySelector<HTMLButtonElement>('[data-calendar-entry="1"]')!
    expect(chip.closest('[data-calendar-day]')?.getAttribute('data-calendar-day')).toBe('2026-09-15')
    expect(chip.textContent).toBe('LIMS Integration · 4:20')
    expect(chip.querySelector('.cal-entry-time')?.textContent).toBe('4:20')
    const running = document.querySelector<HTMLElement>('[data-calendar-entry="2"]')!
    expect(running.hasAttribute('data-running')).toBe(true)
    chip.click()
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }))
    expect(document.querySelector('[data-calendar-status]')?.textContent).toBe('')
  })

  it('[browser] says the whole entry in a tip over a chip under the pointer or the keyboard', () => {
    createCalendarController().render('2026-09-10', [entry()], {
      timeFormat: 'decimal',
      weekStartDay: 'monday',
      today: '2026-09-17',
    })
    const chip = document.querySelector<HTMLButtonElement>('[data-calendar-entry="1"]')!
    const tip = document.querySelector<HTMLElement>('[data-calendar-tip]')!
    expect(tip.hidden).toBe(true)
    chip.dispatchEvent(new Event('pointerenter'))
    expect(tip.hidden).toBe(false)
    expect(tip.textContent).toBe('LIMS Integration / Dev / Data pipeline\n4.3333')
    chip.dispatchEvent(new Event('pointerleave'))
    expect(tip.hidden).toBe(true)
    chip.dispatchEvent(new Event('focus'))
    expect(tip.hidden).toBe(false)
    chip.dispatchEvent(new Event('blur'))
    expect(tip.hidden).toBe(true)
  })

  it('[browser] keeps the band while the next month loads, and says when it could not', () => {
    const controller = createCalendarController()
    controller.loading('2026-10-01')
    expect(document.querySelector('.cal-band-title')?.textContent).toBe('October 2026 · logged time')
    expect(document.querySelector('[data-calendar-month-total]')?.textContent).toBe('—')
    expect(document.querySelector('.cal-month')).toBeNull()
    expect(document.querySelector('[data-calendar-status]')?.textContent).toBe('Loading calendar…')
    controller.failed('The calendar could not load.')
    expect(document.querySelector('[data-calendar-status]')?.textContent).toBe(
      'The calendar could not load.',
    )
  })
})
