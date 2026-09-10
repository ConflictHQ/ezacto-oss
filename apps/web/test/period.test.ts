/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import {
  createPeriodControl,
  detectPeriodKind,
  formatDayRange,
  periodLabel,
  periodRange,
  stepPeriod,
  type PeriodRange,
  type WeekStartDay,
} from '../src/components/period.js'

const range = (from: string, to: string): PeriodRange => ({ from, to })

const mount = (
  options: {
    readonly today?: string
    readonly weekStartDay?: WeekStartDay
  } = {},
) => {
  document.body.replaceChildren()
  const onChange = vi.fn()
  const control = createPeriodControl({
    label: 'Period',
    today: () => options.today ?? '2026-09-10',
    ...(options.weekStartDay === undefined ? {} : { weekStartDay: options.weekStartDay }),
    onChange,
  })
  document.body.appendChild(control.element)
  const query = <ElementType extends Element>(selector: string): ElementType => {
    const found = control.element.querySelector<ElementType>(selector)
    if (found === null) throw new Error(`missing ${selector}`)
    return found
  }
  return {
    control,
    onChange,
    previous: query<HTMLButtonElement>('[data-period-previous]'),
    next: query<HTMLButtonElement>('[data-period-next]'),
    kindSelect: query<HTMLSelectElement>('[data-period-kind]'),
    summary: query<HTMLElement>('[data-period-summary]'),
    custom: query<HTMLElement>('[data-period-custom]'),
    from: query<HTMLInputElement>('[data-period-from]'),
    to: query<HTMLInputElement>('[data-period-to]'),
  }
}

describe('period arithmetic', () => {
  it('[unit] starts the week on whichever of the three days the organisation set', () => {
    // A Wednesday, so all three starts land in a different week around it.
    expect(periodRange('week', '2025-04-16', 'monday')).toEqual(
      range('2025-04-14', '2025-04-20'),
    )
    expect(periodRange('week', '2025-04-16', 'sunday')).toEqual(
      range('2025-04-13', '2025-04-19'),
    )
    expect(periodRange('week', '2025-04-16', 'saturday')).toEqual(
      range('2025-04-12', '2025-04-18'),
    )
    // The first day of a week is inside it, not the end of the one before.
    expect(periodRange('week', '2025-04-12', 'saturday')).toEqual(
      range('2025-04-12', '2025-04-18'),
    )
    expect(periodRange('week', '2025-04-16')).toEqual(range('2025-04-14', '2025-04-20'))
  })

  it('[unit] ends a month on its own last day, February and December included', () => {
    expect(periodRange('month', '2026-02-10')).toEqual(range('2026-02-01', '2026-02-28'))
    expect(periodRange('month', '2028-02-10')).toEqual(range('2028-02-01', '2028-02-29'))
    expect(periodRange('month', '2026-12-31')).toEqual(range('2026-12-01', '2026-12-31'))
    expect(periodRange('month', '2026-01-01')).toEqual(range('2026-01-01', '2026-01-31'))
  })

  it('[unit] cuts quarters and years on their real boundaries', () => {
    expect(periodRange('quarter', '2026-01-01')).toEqual(range('2026-01-01', '2026-03-31'))
    expect(periodRange('quarter', '2026-03-31')).toEqual(range('2026-01-01', '2026-03-31'))
    expect(periodRange('quarter', '2026-04-01')).toEqual(range('2026-04-01', '2026-06-30'))
    expect(periodRange('quarter', '2026-09-30')).toEqual(range('2026-07-01', '2026-09-30'))
    expect(periodRange('quarter', '2026-12-31')).toEqual(range('2026-10-01', '2026-12-31'))
    expect(periodRange('year', '2026-07-04')).toEqual(range('2026-01-01', '2026-12-31'))
    expect(periodRange('year', '2028-02-29')).toEqual(range('2028-01-01', '2028-12-31'))
  })

  it('[unit] steps a named period onto the whole of its neighbour', () => {
    expect(stepPeriod('month', range('2026-01-01', '2026-01-31'), -1)).toEqual(
      range('2025-12-01', '2025-12-31'),
    )
    expect(stepPeriod('month', range('2026-12-01', '2026-12-31'), 1)).toEqual(
      range('2027-01-01', '2027-01-31'),
    )
    // Stepping by length would land on 28 February and call it a month.
    expect(stepPeriod('month', range('2026-03-01', '2026-03-31'), -1)).toEqual(
      range('2026-02-01', '2026-02-28'),
    )
    expect(stepPeriod('quarter', range('2026-01-01', '2026-03-31'), -1)).toEqual(
      range('2025-10-01', '2025-12-31'),
    )
    expect(stepPeriod('quarter', range('2026-10-01', '2026-12-31'), 1)).toEqual(
      range('2027-01-01', '2027-03-31'),
    )
    expect(stepPeriod('year', range('2026-01-01', '2026-12-31'), 1)).toEqual(
      range('2027-01-01', '2027-12-31'),
    )
    expect(stepPeriod('year', range('2026-01-01', '2026-12-31'), -1)).toEqual(
      range('2025-01-01', '2025-12-31'),
    )
  })

  it('[unit] steps a week across a year boundary under each week start', () => {
    expect(stepPeriod('week', range('2026-12-28', '2027-01-03'), 1, 'monday')).toEqual(
      range('2027-01-04', '2027-01-10'),
    )
    expect(stepPeriod('week', range('2027-01-04', '2027-01-10'), -1, 'monday')).toEqual(
      range('2026-12-28', '2027-01-03'),
    )
    expect(stepPeriod('week', range('2026-12-27', '2027-01-02'), 1, 'sunday')).toEqual(
      range('2027-01-03', '2027-01-09'),
    )
    expect(stepPeriod('week', range('2026-12-26', '2027-01-01'), 1, 'saturday')).toEqual(
      range('2027-01-02', '2027-01-08'),
    )
  })

  it('[unit] steps a custom range by its own length in both directions', () => {
    expect(stepPeriod('custom', range('2026-08-01', '2026-08-10'), -1)).toEqual(
      range('2026-07-22', '2026-07-31'),
    )
    expect(stepPeriod('custom', range('2026-08-01', '2026-08-10'), 1)).toEqual(
      range('2026-08-11', '2026-08-20'),
    )
    // A single day is a one-day period, not a zero-day one that never moves.
    expect(stepPeriod('custom', range('2026-08-01', '2026-08-01'), 1)).toEqual(
      range('2026-08-02', '2026-08-02'),
    )
  })

  it('[unit] names a range only when it is exactly that period', () => {
    expect(detectPeriodKind(range('2025-04-14', '2025-04-20'), 'monday')).toBe('week')
    expect(detectPeriodKind(range('2025-04-14', '2025-04-20'), 'sunday')).toBe('custom')
    expect(detectPeriodKind(range('2025-04-13', '2025-04-19'), 'sunday')).toBe('week')
    expect(detectPeriodKind(range('2025-04-12', '2025-04-18'), 'saturday')).toBe('week')
    expect(detectPeriodKind(range('2026-02-01', '2026-02-28'))).toBe('month')
    expect(detectPeriodKind(range('2026-01-01', '2026-03-31'))).toBe('quarter')
    expect(detectPeriodKind(range('2026-01-01', '2026-12-31'))).toBe('year')
    // Month-to-date, which is what the reports screen opens on.
    expect(detectPeriodKind(range('2026-09-01', '2026-09-10'))).toBe('custom')
    // A month one day short is not a month.
    expect(detectPeriodKind(range('2026-02-01', '2026-02-27'))).toBe('custom')
  })

  it('[unit] refuses to name a range it cannot read, rather than throwing', () => {
    expect(detectPeriodKind(range('', ''))).toBe('custom')
    expect(detectPeriodKind(range('2026-02-30', '2026-03-01'))).toBe('custom')
    expect(detectPeriodKind(range('2026-09-10', '2026-09-01'))).toBe('custom')
  })

  it('[unit] writes a range once, dropping the parts both ends share', () => {
    expect(formatDayRange(range('2025-04-14', '2025-04-20'))).toBe('14 – 20 Apr 2025')
    expect(formatDayRange(range('2025-04-28', '2025-05-04'))).toBe('28 Apr – 4 May 2025')
    expect(formatDayRange(range('2025-12-28', '2026-01-03'))).toBe(
      '28 Dec 2025 – 3 Jan 2026',
    )
    expect(formatDayRange(range('2025-04-14', '2025-04-14'))).toBe('14 Apr 2025')
  })

  it('[unit] says "This week" only while today is inside the period', () => {
    expect(periodLabel('week', range('2025-04-14', '2025-04-20'), '2025-04-16')).toBe(
      'This week: 14 – 20 Apr 2025',
    )
    expect(periodLabel('week', range('2025-04-14', '2025-04-20'), '2025-05-01')).toBe(
      '14 – 20 Apr 2025',
    )
    // The edges are inside the period.
    expect(periodLabel('week', range('2025-04-14', '2025-04-20'), '2025-04-14')).toBe(
      'This week: 14 – 20 Apr 2025',
    )
    expect(periodLabel('week', range('2025-04-14', '2025-04-20'), '2025-04-21')).toBe(
      '14 – 20 Apr 2025',
    )
  })

  it('[unit] names a month, a quarter and a year rather than spelling out their days', () => {
    expect(periodLabel('month', range('2026-02-01', '2026-02-28'), '2026-02-10')).toBe(
      'This month: February 2026',
    )
    expect(periodLabel('month', range('2026-02-01', '2026-02-28'), '2026-09-10')).toBe(
      'February 2026',
    )
    expect(periodLabel('quarter', range('2026-04-01', '2026-06-30'), '2026-05-05')).toBe(
      'This quarter: Q2 2026',
    )
    expect(periodLabel('quarter', range('2026-10-01', '2026-12-31'), '2026-05-05')).toBe(
      'Q4 2026',
    )
    expect(periodLabel('year', range('2026-01-01', '2026-12-31'), '2026-09-10')).toBe(
      'This year: 2026',
    )
    // A custom range is never "this" anything: it has no period to be inside of.
    expect(periodLabel('custom', range('2026-09-01', '2026-09-10'), '2026-09-05')).toBe(
      '1 – 10 Sep 2026',
    )
    expect(periodLabel('custom', range('', ''), '2026-09-05')).toBe('Choose a range')
  })
})

describe('period control', () => {
  it('[browser] reads the kind off the range it is handed', () => {
    const ui = mount({ today: '2026-09-10' })
    ui.control.setRange(range('2026-09-01', '2026-09-30'))
    expect(ui.control.kind()).toBe('month')
    expect(ui.kindSelect.value).toBe('month')
    expect(ui.summary.textContent).toBe('This month: September 2026')
    expect(ui.custom.hidden).toBe(true)
    expect(ui.from.value).toBe('2026-09-01')
    expect(ui.to.value).toBe('2026-09-30')

    ui.control.setRange(range('2026-09-01', '2026-09-10'))
    expect(ui.control.kind()).toBe('custom')
    expect(ui.custom.hidden).toBe(false)
    expect(ui.summary.textContent).toBe('1 – 10 Sep 2026')
    expect(ui.onChange).not.toHaveBeenCalled()
  })

  it('[browser] steps the period on an arrow and reports the range it moved to', () => {
    const ui = mount({ today: '2026-09-10' })
    ui.control.setRange(range('2026-09-01', '2026-09-30'))
    ui.previous.click()
    expect(ui.control.range()).toEqual(range('2026-08-01', '2026-08-31'))
    expect(ui.summary.textContent).toBe('August 2026')
    expect(ui.onChange).toHaveBeenLastCalledWith(range('2026-08-01', '2026-08-31'), 'month')
    ui.next.click()
    ui.next.click()
    expect(ui.control.range()).toEqual(range('2026-10-01', '2026-10-31'))
    expect(ui.onChange).toHaveBeenCalledTimes(3)
  })

  it('[browser] steps a week by the organisation week once the setting arrives', () => {
    const ui = mount({ today: '2025-04-16' })
    // Saturday to Friday reads as an arbitrary seven days under the default.
    ui.control.setRange(range('2025-04-12', '2025-04-18'))
    expect(ui.control.kind()).toBe('custom')
    ui.control.setWeekStartDay('saturday')
    expect(ui.control.kind()).toBe('week')
    expect(ui.summary.textContent).toBe('This week: 12 – 18 Apr 2025')
    ui.previous.click()
    expect(ui.control.range()).toEqual(range('2025-04-05', '2025-04-11'))
    expect(ui.summary.textContent).toBe('5 – 11 Apr 2025')
  })

  it('[browser] jumps to the current period when a named kind is chosen', () => {
    const ui = mount({ today: '2026-09-10' })
    ui.control.setRange(range('2024-01-01', '2024-01-31'))
    ui.kindSelect.value = 'quarter'
    ui.kindSelect.dispatchEvent(new Event('change'))
    expect(ui.control.range()).toEqual(range('2026-07-01', '2026-09-30'))
    expect(ui.summary.textContent).toBe('This quarter: Q3 2026')
    expect(ui.custom.hidden).toBe(true)
    expect(ui.onChange).toHaveBeenLastCalledWith(range('2026-07-01', '2026-09-30'), 'quarter')
  })

  it('[browser] opens the dates for a custom range without moving or reloading it', () => {
    const ui = mount({ today: '2026-09-10' })
    ui.control.setRange(range('2026-09-01', '2026-09-30'))
    ui.kindSelect.value = 'custom'
    ui.kindSelect.dispatchEvent(new Event('change'))
    expect(ui.custom.hidden).toBe(false)
    expect(ui.control.range()).toEqual(range('2026-09-01', '2026-09-30'))
    expect(ui.summary.textContent).toBe('1 – 30 Sep 2026')
    expect(ui.onChange).not.toHaveBeenCalled()

    // Typing re-labels; asking the server is the screen's own decision.
    ui.to.value = '2026-09-15'
    ui.to.dispatchEvent(new Event('change'))
    expect(ui.summary.textContent).toBe('1 – 15 Sep 2026')
    expect(ui.onChange).not.toHaveBeenCalled()
    expect(ui.control.range()).toEqual(range('2026-09-01', '2026-09-15'))
  })

  it('[browser] declines to step a range it cannot read', () => {
    const ui = mount({ today: '2026-09-10' })
    ui.control.setRange(range('2026-09-10', '2026-09-01'))
    ui.previous.click()
    ui.next.click()
    expect(ui.onChange).not.toHaveBeenCalled()
    expect(ui.control.range()).toEqual(range('2026-09-10', '2026-09-01'))
  })

  it('[browser] disables every control while the screen behind it is busy', () => {
    const ui = mount()
    ui.control.setRange(range('2026-09-01', '2026-09-30'))
    ui.control.setDisabled(true)
    for (const element of [ui.previous, ui.next, ui.kindSelect, ui.from, ui.to])
      expect(element.disabled).toBe(true)
    ui.control.setDisabled(false)
    for (const element of [ui.previous, ui.next, ui.kindSelect, ui.from, ui.to])
      expect(element.disabled).toBe(false)
  })

  it('[browser] gives each control its own label target', () => {
    const first = mount()
    const firstId = first.kindSelect.id
    const second = mount()
    expect(second.kindSelect.id).not.toBe(firstId)
    expect(
      second.control.element.querySelector<HTMLLabelElement>('.period-field-label')?.htmlFor,
    ).toBe(second.kindSelect.id)
  })
})
