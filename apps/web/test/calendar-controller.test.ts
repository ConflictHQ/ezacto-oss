/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCalendarController,
  type CalendarDisplayEntry,
  type CalendarHost,
  type CalendarPlacement,
  type CalendarView,
} from '../src/calendar/browser.js'

/**
 * Issue 943: the calendar's drag and key paths, against the real controller
 * and a fake host. The page has no layout engine, so each column is given a
 * rectangle where one pixel is one minute and the controller's own arithmetic
 * does the rest.
 */

const dates = ['2026-10-12', '2026-10-13', '2026-10-14']

const entry = (id: number, patch: Partial<CalendarDisplayEntry> = {}): CalendarDisplayEntry => ({
  id,
  spent_date: '2026-10-13',
  seconds: 3600,
  started_time: '09:00',
  ended_time: '10:00',
  project_id: 1,
  task_id: 1,
  project_label: 'Atlas',
  task_label: 'Build',
  ...patch,
})

const view = (
  entries: readonly CalendarDisplayEntry[],
  patch: Partial<CalendarView> = {},
): CalendarView => ({
  dates,
  entries,
  layout: 'week',
  selectedDate: '2026-10-13',
  now: { date: '2026-10-13', minutes: 12 * 60 },
  clock: '24h',
  formatSeconds: (seconds) => `${seconds / 3600} h`,
  ...patch,
})

const mount = () => {
  document.body.innerHTML = `
    <section data-calendar-week>
      <p data-calendar-status></p>
      <p data-calendar-live></p>
      <div data-calendar-grid></div>
    </section>`
  const host = {
    openEntry: vi.fn<CalendarHost['openEntry']>(),
    createEntry: vi.fn<CalendarHost['createEntry']>(),
    moveEntry: vi.fn<CalendarHost['moveEntry']>(() => Promise.resolve()),
    stepDay: vi.fn<CalendarHost['stepDay']>(),
    now: () => ({ date: '2026-10-13', minutes: 12 * 60 }),
  }
  const controller = createCalendarController(host)
  return { host, controller }
}

/** One pixel a minute; columns side by side, 100px wide. */
const layOut = (): void => {
  const columns = [...document.querySelectorAll<HTMLElement>('[data-calendar-day]')]
  columns.forEach((column, index) => {
    column.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 1440,
        height: 1440,
        left: index * 100,
        right: index * 100 + 100,
        width: 100,
        x: index * 100,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect
  })
}

const pointer = (
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
  pointerType = 'mouse',
): void => {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: pointerType },
  })
  target.dispatchEvent(event)
}

const column = (date: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-calendar-day="${date}"]`)!
const block = (id: number): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-calendar-block="${id}"]`)!

const key = (target: Element, name: string, init: KeyboardEventInit = {}): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...init }))
}

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.releasePointerCapture = () => {}
})
afterEach(() => {
  document.body.innerHTML = ''
})

describe('drag to create', () => {
  it('snaps a drag on empty clock to a quarter hour and opens the editor with the span', () => {
    const { host, controller } = mount()
    controller.render(view([]))
    layOut()
    const day = column('2026-10-13')
    pointer(day, 'pointerdown', 150, 8 * 60 + 3)
    pointer(day, 'pointermove', 150, 9 * 60 + 40)
    pointer(day, 'pointerup', 150, 9 * 60 + 40)
    expect(host.createEntry).toHaveBeenCalledTimes(1)
    const placement = host.createEntry.mock.calls[0]![0] as CalendarPlacement
    expect(placement).toEqual({ date: '2026-10-13', startedTime: '08:00', endedTime: '09:45' })
    // The draft is drawn selected until the editor closes.
    expect(document.querySelector('[data-calendar-draft]')).not.toBeNull()
    controller.clearDraft()
    expect(document.querySelector('[data-calendar-draft]')).toBeNull()
  })

  it('allows a drag into an occupied slot: an overlap is drawn side by side, not refused', () => {
    const { host, controller } = mount()
    controller.render(view([entry(1), entry(2, { project_label: 'Borealis' })]))
    layOut()
    const lanes = [1, 2].map((id) => block(id).style.getPropertyValue('--cal-lanes'))
    expect(lanes).toEqual(['2', '2'])
    const day = column('2026-10-13')
    // Onto the lane gutter of a day whose slot is taken: a plain drag still creates.
    pointer(day, 'pointerdown', 150, 9 * 60 + 15)
    pointer(day, 'pointermove', 150, 9 * 60 + 45)
    pointer(day, 'pointerup', 150, 9 * 60 + 45)
    expect(host.moveEntry).not.toHaveBeenCalled()
    expect(host.createEntry).toHaveBeenCalledTimes(1)
  })
})

describe('move and resize', () => {
  it('moves a block by the distance dragged, in quarter hours, across days', async () => {
    const { host, controller } = mount()
    controller.render(view([entry(1)]))
    layOut()
    const node = block(1)
    pointer(node, 'pointerdown', 150, 9 * 60 + 30)
    pointer(node, 'pointermove', 250, 10 * 60 + 40)
    pointer(node, 'pointerup', 250, 10 * 60 + 40)
    expect(host.moveEntry).toHaveBeenCalledWith(1, {
      date: '2026-10-14',
      startedTime: '10:15',
      endedTime: '11:15',
    })
  })

  it('resizes from the bottom edge and from the top edge', async () => {
    const { host, controller } = mount()
    controller.render(view([entry(1)]))
    layOut()
    const end = block(1).querySelector<HTMLElement>('[data-calendar-handle="end"]')!
    pointer(end, 'pointerdown', 150, 10 * 60)
    pointer(end, 'pointermove', 150, 11 * 60 + 20)
    pointer(end, 'pointerup', 150, 11 * 60 + 20)
    expect(host.moveEntry).toHaveBeenLastCalledWith(1, {
      date: '2026-10-13',
      startedTime: '09:00',
      endedTime: '11:15',
    })
    // An entry still saving takes no new drag; the top edge goes once it has
    // landed. This host redraws nothing, so the entry is still 09:00-10:00.
    await vi.waitFor(() => expect(block(1).hasAttribute('aria-busy')).toBe(false))
    const start = block(1).querySelector<HTMLElement>('[data-calendar-handle="start"]')!
    pointer(start, 'pointerdown', 150, 9 * 60)
    pointer(start, 'pointermove', 150, 8 * 60 + 29)
    pointer(start, 'pointerup', 150, 8 * 60 + 29)
    expect(host.moveEntry).toHaveBeenLastCalledWith(1, {
      date: '2026-10-13',
      startedTime: '08:30',
      endedTime: '10:00',
    })
  })

  it('puts the block back and says why when the save is refused', async () => {
    const { host, controller } = mount()
    host.moveEntry.mockRejectedValueOnce(new Error('That day is locked.'))
    controller.render(view([entry(1)]))
    layOut()
    const node = block(1)
    pointer(node, 'pointerdown', 150, 9 * 60 + 30)
    pointer(node, 'pointermove', 150, 11 * 60)
    pointer(node, 'pointerup', 150, 11 * 60)
    await vi.waitFor(() =>
      expect(document.querySelector('[data-calendar-status]')!.textContent).toContain(
        'That day is locked.',
      ),
    )
    expect(block(1).style.getPropertyValue('--cal-start')).toBe('540')
  })
})

/**
 * The CI flake on calendar-drag.browser.ts: the spec grabbed the bottom edge
 * while the keyboard move was still saving, and the resize began from the
 * entry as last drawn -- before the move -- so it saved the old start back.
 */
describe('an entry whose move is still saving', () => {
  /** The host's next save waits for the returned call, as a save waits for the network. */
  const holdNextSave = (host: ReturnType<typeof mount>['host']): (() => void) => {
    let land: () => void = () => {}
    host.moveEntry.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          land = resolve
        }),
    )
    return () => land()
  }

  it('takes no new drag until the save lands, and the next one starts where the move went', async () => {
    const { host, controller } = mount()
    const land = holdNextSave(host)
    controller.render(view([entry(1)]))
    layOut()
    const status = document.querySelector<HTMLElement>('[data-calendar-status]')!
    key(block(1), 'ArrowDown')
    key(block(1), 'Enter')
    expect(host.moveEntry).toHaveBeenCalledTimes(1)
    expect(block(1).getAttribute('aria-busy')).toBe('true')

    // The bottom edge, drawn at 10:15 now, dragged down half an hour.
    const end = (): HTMLElement => block(1).querySelector<HTMLElement>('[data-calendar-handle="end"]')!
    pointer(end(), 'pointerdown', 150, 10 * 60 + 14)
    pointer(end(), 'pointermove', 150, 10 * 60 + 45)
    pointer(end(), 'pointerup', 150, 10 * 60 + 45)
    expect(host.moveEntry).toHaveBeenCalledTimes(1)
    expect(status.textContent).toBe('This entry is still saving. Try again once it has saved.')
    expect(block(1).style.getPropertyValue('--cal-start')).toBe('555')
    expect(block(1).style.getPropertyValue('--cal-span')).toBe('60')

    // The shell redraws with the move in it, then the save answers.
    controller.render(view([entry(1, { started_time: '09:15', ended_time: '10:15' })]))
    land()
    await vi.waitFor(() => expect(block(1).hasAttribute('aria-busy')).toBe(false))
    layOut()
    pointer(end(), 'pointerdown', 150, 10 * 60 + 14)
    pointer(end(), 'pointermove', 150, 10 * 60 + 45)
    pointer(end(), 'pointerup', 150, 10 * 60 + 45)
    expect(host.moveEntry).toHaveBeenLastCalledWith(1, {
      date: '2026-10-13',
      startedTime: '09:15',
      endedTime: '10:45',
    })
  })

  it('refuses the keys and the editor the same way', async () => {
    const { host, controller } = mount()
    const land = holdNextSave(host)
    controller.render(view([entry(1)]))
    layOut()
    const status = document.querySelector<HTMLElement>('[data-calendar-status]')!
    key(block(1), 'ArrowDown')
    key(block(1), 'Enter')
    // A second step before the first has saved would start from 09:00 and
    // save 09:15 again, losing it.
    key(block(1), 'ArrowDown')
    key(block(1), 'Enter')
    expect(host.moveEntry).toHaveBeenCalledTimes(1)
    expect(status.textContent).toBe('This entry is still saving. Try again once it has saved.')
    // The editor would open on 09:00-10:00, and saving it would put the move back.
    block(1).click()
    expect(host.openEntry).not.toHaveBeenCalled()
    land()
    await vi.waitFor(() => expect(block(1).hasAttribute('aria-busy')).toBe(false))
    block(1).click()
    expect(host.openEntry).toHaveBeenCalledWith(1)
  })

  it('stays drawn where it is going, and busy, through a redraw from before the save', () => {
    const { host, controller } = mount()
    holdNextSave(host)
    controller.render(view([entry(1)]))
    layOut()
    key(block(1), 'ArrowDown')
    key(block(1), 'Enter')
    // A redraw from the entries as they were, as the minute tick makes.
    controller.render(view([entry(1)]))
    expect(block(1).style.getPropertyValue('--cal-start')).toBe('555')
    expect(block(1).dataset.state).toBe('saving')
    expect(block(1).getAttribute('aria-busy')).toBe('true')
  })
})

describe('locked, invoiced and running entries', () => {
  it('has no handles, does not drag, and says why', () => {
    const { host, controller } = mount()
    controller.render(
      view([entry(1, { is_locked: true, locked_reason: 'Invoiced on invoice 1042' })]),
    )
    layOut()
    const node = block(1)
    expect(node.querySelector('[data-calendar-handle]')).toBeNull()
    expect(node.textContent).toContain('Invoiced on invoice 1042')
    pointer(node, 'pointerdown', 150, 9 * 60 + 30)
    pointer(node, 'pointermove', 150, 11 * 60)
    pointer(node, 'pointerup', 150, 11 * 60)
    expect(host.moveEntry).not.toHaveBeenCalled()
    expect(document.querySelector('[data-calendar-status]')!.textContent).toContain(
      'Invoiced on invoice 1042',
    )
  })

  it('refuses the keyboard the same way', () => {
    const { host, controller } = mount()
    controller.render(view([entry(1, { is_locked: true, locked_reason: 'Approved' })]))
    layOut()
    key(block(1), 'ArrowDown')
    expect(host.moveEntry).not.toHaveBeenCalled()
    expect(document.querySelector('[data-calendar-status]')!.textContent).toContain('Approved')
  })
})

describe('keyboard path', () => {
  it('moves with the arrows, saves on Enter, puts back on Escape', () => {
    const { host, controller } = mount()
    controller.render(view([entry(1)]))
    layOut()
    key(block(1), 'ArrowDown')
    key(block(1), 'ArrowDown')
    key(block(1), 'Escape')
    expect(host.moveEntry).not.toHaveBeenCalled()
    expect(block(1).style.getPropertyValue('--cal-start')).toBe('540')
    key(block(1), 'ArrowDown')
    key(block(1), 'ArrowRight')
    key(block(1), 'Enter')
    expect(host.moveEntry).toHaveBeenCalledWith(1, {
      date: '2026-10-14',
      startedTime: '09:15',
      endedTime: '10:15',
    })
  })

  it('Shift moves the end and Alt+Shift the start', () => {
    const { host, controller } = mount()
    controller.render(view([entry(1)]))
    layOut()
    key(block(1), 'ArrowDown', { shiftKey: true })
    key(block(1), 'ArrowUp', { shiftKey: true, altKey: true })
    key(block(1), 'Enter')
    expect(host.moveEntry).toHaveBeenCalledWith(1, {
      date: '2026-10-13',
      startedTime: '08:45',
      endedTime: '10:15',
    })
  })

  it('adds an entry from the day cursor: arrows choose the time, Shift the length, Enter opens', () => {
    const { host, controller } = mount()
    controller.render(view([]))
    layOut()
    const cursor = document.querySelector<HTMLElement>('[data-calendar-cursor="2026-10-13"]')!
    key(cursor, 'ArrowDown')
    key(cursor, 'ArrowDown', { shiftKey: true })
    cursor.click()
    expect(host.createEntry).toHaveBeenCalledTimes(1)
    expect((host.createEntry.mock.calls[0]![0] as CalendarPlacement).startedTime).toBe('09:15')
    expect((host.createEntry.mock.calls[0]![0] as CalendarPlacement).endedTime).toBe('10:30')
  })
})

describe('touch', () => {
  it('does not start a move until the press has been held', () => {
    vi.useFakeTimers()
    try {
      const { host, controller } = mount()
      controller.render(view([entry(1)]))
      layOut()
      const node = block(1)
      pointer(node, 'pointerdown', 150, 9 * 60 + 30, 'touch')
      pointer(node, 'pointermove', 150, 11 * 60, 'touch')
      pointer(node, 'pointerup', 150, 11 * 60, 'touch')
      expect(host.moveEntry).not.toHaveBeenCalled()
      pointer(node, 'pointerdown', 150, 9 * 60 + 30, 'touch')
      vi.advanceTimersByTime(450)
      pointer(node, 'pointermove', 150, 10 * 60 + 30, 'touch')
      pointer(node, 'pointerup', 150, 10 * 60 + 30, 'touch')
      expect(host.moveEntry).toHaveBeenCalledWith(1, {
        date: '2026-10-13',
        startedTime: '10:00',
        endedTime: '11:00',
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('what the surface shows', () => {
  it('lists an entry with no clock time in its own band and never invents one', () => {
    const { controller } = mount()
    controller.render(view([entry(1, { started_time: null, ended_time: null, seconds: 7200 })]))
    expect(document.querySelectorAll('[data-calendar-block]')).toHaveLength(0)
    expect(document.querySelector('[data-calendar-chip="1"]')).not.toBeNull()
  })

  it('totals a day from each entry, overlapping or not', () => {
    const { controller } = mount()
    controller.render(view([entry(1), entry(2)]))
    const heads = [...document.querySelectorAll('.cal-head-total')].map((node) => node.textContent)
    expect(heads).toEqual(['0 h', '2 h', '0 h'])
  })

  it('draws one day with its date, weekday and total in the Day layout', () => {
    const { controller } = mount()
    controller.render(view([entry(1)], { layout: 'day' }))
    expect(document.querySelectorAll('[data-calendar-day]')).toHaveLength(1)
    expect(document.querySelector('.cal-dayhead-number')!.textContent).toBe('13')
    expect(document.querySelector('.cal-dayhead-total')!.textContent).toContain('1 h')
  })
})
