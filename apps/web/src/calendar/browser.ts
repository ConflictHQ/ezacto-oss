import { proposalSourceLabel, type ProposalBlock } from '../calendar-proposals/model.js'
import { icon } from '../components/icons.js'
import { formatTimeForClock, type OrganizationClock } from '../components/time-entry-editor.js'
import type { CalendarLayout } from './layout.js'
import {
  calendarWeek,
  assignLanes,
  clockFromMinutes,
  firstVisibleMinutes,
  MINUTES_IN_DAY,
  moveSpan,
  resizeSpanEnd,
  resizeSpanStart,
  sameSpan,
  SNAP_MINUTES,
  spanAt,
  spanFromDrag,
  spanTimes,
  type CalendarBlock,
  type CalendarDay,
  type CalendarEntry,
  type CalendarNow,
  type CalendarSpan,
} from './model.js'

/**
 * The calendar on the Time screen (issue 943): where time is drawn rather than
 * typed.
 *
 * Drag on empty clock to add an entry, drag an entry to move it, drag its top
 * or bottom edge to change when it starts or ends -- all in quarter hours, all
 * through Pointer Events so a mouse, a pen and a finger take one path. A finger
 * presses and holds first, because the same gesture without the hold is how a
 * phone scrolls. Every drag has a key path for anyone not using a pointer, and
 * the controls say what they are and what just happened.
 *
 * Nothing here talks to the API. The shell owns the session, the editor and the
 * refresh; this draws what it is given and asks the shell to create, open or
 * move an entry.
 */

export interface CalendarDisplayEntry extends CalendarEntry {
  readonly project_label?: string
  readonly task_label?: string
}

export interface CalendarView {
  readonly proposals?: readonly ProposalBlock[]
  readonly proposalTimeZone?: string

  /** The week, in the organization's order. */
  readonly dates: readonly string[]
  readonly entries: readonly CalendarDisplayEntry[]
  readonly layout: CalendarLayout
  /** The day the Day layout shows: one of `dates`. */
  readonly selectedDate: string
  readonly now: CalendarNow
  readonly clock: OrganizationClock
  /** The organization's hours format, the one every other total on the screen uses. */
  readonly formatSeconds: (seconds: number) => string
}

/** Where an entry goes: its day, and its start and end as the API writes them. */
export interface CalendarPlacement {
  readonly date: string
  readonly startedTime: string
  readonly endedTime: string
}

export interface CalendarHost {
  reviewProposal?(id: number, anchor: HTMLElement): void

  /** Open the editor on an entry: a click, a tap, Enter. */
  openEntry(entryId: number): void
  /** A drag, a click or Enter on empty clock: the editor for a new entry there. */
  createEntry(placement: CalendarPlacement, anchor: HTMLElement): void
  /** Save a moved or resized entry; rejects with the reason to give when it cannot. */
  moveEntry(entryId: number, placement: CalendarPlacement): Promise<void>
  /** The Day layout's arrows: a day earlier or later, across weeks. */
  stepDay(offset: -1 | 1): void
  /** The local moment now, for running entries and today's line. */
  now(): CalendarNow
}

export interface CalendarController {
  render(view: CalendarView): void
  /** The new entry's editor has closed, saved or not: drop its draft. */
  clearDraft(): void
  /** Focus an entry's block once it is drawn, as after it was created. */
  focusEntry(entryId: number): void
  /**
   * Forget everything drawn. Signing out must leave no entry, project or note
   * from the account that was here in the page for the next one to read.
   */
  clear(): void
}

type DragKind = 'create' | 'move' | 'start' | 'end'

interface Placed {
  readonly date: string
  readonly span: CalendarSpan
}

interface DragState {
  readonly kind: DragKind
  readonly pointerId: number
  readonly touch: boolean
  readonly originX: number
  readonly originY: number
  readonly originMinutes: number
  readonly date: string
  readonly entryId: number | null
  readonly original: Placed | null
  readonly element: HTMLElement | null
  /** Why this entry cannot be dragged, said when somebody tries. */
  readonly refusal: string | null
  lastX: number
  lastY: number
  active: boolean
  pressTimer: ReturnType<typeof setTimeout> | undefined
  current: Placed
}

interface PendingKeyMove {
  readonly entryId: number
  readonly original: Placed
  current: Placed
}

type FocusMark =
  | { readonly kind: 'proposal'; readonly proposalId: number; readonly date: string }
  | { readonly kind: 'block' | 'chip'; readonly entryId: number }
  | { readonly kind: 'cursor'; readonly date: string }
  | { readonly kind: 'step'; readonly offset: string }

const LONG_PRESS_MS = 400
const MOUSE_THRESHOLD_PX = 4
const TOUCH_SLOP_PX = 8
const EDGE_SCROLL_PX = 36

const element = <Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[Tag] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const utcDate = (date: string): Date => new Date(`${date}T00:00:00.000Z`)

const longDay = (date: string): string =>
  new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(utcDate(date))

const weekdayOf = (date: string, style: 'short' | 'long'): string =>
  new Intl.DateTimeFormat('en-US', { weekday: style, timeZone: 'UTC' }).format(utcDate(date))

const monthOf = (date: string): string =>
  new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    utcDate(date),
  )

const dayNumber = (date: string): string => String(Number(date.slice(8, 10)))

/** The ruler's label for an hour: `9 AM` on a 12-hour clock, `09:00` on a 24-hour one. */
const hourLabel = (hour: number, clock: OrganizationClock): string =>
  clock === '24h'
    ? `${String(hour).padStart(2, '0')}:00`
    : `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`

const movable = (entry: CalendarEntry): boolean =>
  entry.is_locked !== true && entry.is_running !== true

const refusalFor = (entry: CalendarEntry): string =>
  entry.is_running === true
    ? 'This entry is running. Stop it before moving it.'
    : `This entry cannot be moved: ${entry.locked_reason ?? 'it is locked'}.`

const STILL_SAVING = 'This entry is still saving. Try again once it has saved.'

const setSpanStyle = (node: HTMLElement, span: CalendarSpan, lane = 0, lanes = 1): void => {
  const offset = Math.min(Math.max(span.start, 0), MINUTES_IN_DAY)
  const drawn = Math.max(0, Math.min(span.end, MINUTES_IN_DAY) - offset)
  node.style.setProperty('--cal-start', String(offset))
  node.style.setProperty('--cal-span', String(drawn))
  node.style.setProperty('--cal-lane', String(lane))
  node.style.setProperty('--cal-lanes', String(lanes))
}

export const createCalendarController = (host: CalendarHost): CalendarController => {
  const panel = document.querySelector<HTMLElement>('[data-calendar-week]')
  if (panel === null) {
    return { render: () => {}, clearDraft: () => {}, focusEntry: () => {}, clear: () => {} }
  }
  const surface = panel.querySelector<HTMLElement>('[data-calendar-grid]')!
  const status = panel.querySelector<HTMLElement>('[data-calendar-status]')!
  const live = panel.querySelector<HTMLElement>('[data-calendar-live]')

  let view: CalendarView | null = null
  let days: readonly CalendarDay<CalendarDisplayEntry>[] = []
  let deferred: CalendarView | null = null
  let drag: DragState | null = null
  let pending: PendingKeyMove | null = null
  /** The new entry being drawn, and then edited, before it exists. */
  let draft: Placed | null = null
  /**
   * Moves sent to the host and not answered yet, by entry: where each is going.
   * Until the answer, and the redraw the shell makes before giving it, `days`
   * still has the entry where it was -- so a drag, a key move or the editor
   * started now would begin from the old span and save it back over the move
   * just made. The block is drawn where it is going, through any redraw, and
   * takes nothing new until the save lands.
   */
  const saving = new Map<number, Placed>()
  /**
   * A press that became a drag, or a click that became a new entry, still ends
   * in a click on whatever was under it. It is swallowed rather than opening
   * the editor a second time -- for a moment only, so a click that never came
   * cannot eat the next real one.
   */
  let suppressClickUntil = 0
  let ticker: ReturnType<typeof setInterval> | undefined
  let scrolledFor: string | null = null
  let edgeScroll: number | undefined
  let guide: HTMLElement | null = null
  /** Where the keyboard's slot sits, carried from day to day. */
  let cursorSpan: CalendarSpan = { start: 9 * 60, end: 10 * 60 }
  const columns = new Map<string, HTMLElement>()
  const blockElements = new Map<number, HTMLElement>()

  const announce = (message: string): void => {
    if (live === null) return
    // Cleared first so the same sentence twice is still read twice.
    live.textContent = ''
    globalThis.setTimeout(() => {
      live.textContent = message
    }, 30)
  }

  /** A sentence that stays until the person does something else here. */
  const tell = (message: string): void => {
    status.textContent = message
    status.dataset.calendarStatus = 'message'
    announce(message)
  }

  const suppressNextClick = (): void => {
    suppressClickUntil = globalThis.performance.now() + 500
  }

  const timeLabel = (minutes: number): string =>
    formatTimeForClock(clockFromMinutes(minutes), view?.clock ?? '12h')

  const rangeLabel = (span: CalendarSpan): string =>
    `${timeLabel(span.start)} – ${timeLabel(span.end)}`

  const spokenRange = (span: CalendarSpan): string =>
    `${timeLabel(span.start)} to ${timeLabel(span.end)}${span.end > MINUTES_IN_DAY ? ', past midnight' : ''}`

  const findBlock = (entryId: number): CalendarBlock<CalendarDisplayEntry> | undefined => {
    for (const day of days) {
      const block = day.blocks.find((candidate) => candidate.entry.id === entryId)
      if (block !== undefined) return block
    }
    return undefined
  }

  /** Why an entry cannot be moved just now, or null when it can. */
  const refusalNow = (entry: CalendarEntry): string | null =>
    saving.has(entry.id) ? STILL_SAVING : movable(entry) ? null : refusalFor(entry)

  const scroller = (): HTMLElement | null =>
    surface.querySelector<HTMLElement>('[data-calendar-scroll]')

  /** Minutes from midnight under a pointer, from the column's drawn height so zoom never matters. */
  const minutesAt = (column: HTMLElement, clientY: number): number => {
    const rect = column.getBoundingClientRect()
    if (rect.height === 0) return 0
    return ((clientY - rect.top) / rect.height) * MINUTES_IN_DAY
  }

  const columnAt = (clientX: number): HTMLElement | null => {
    let nearest: HTMLElement | null = null
    let distance = Number.POSITIVE_INFINITY
    for (const column of columns.values()) {
      const rect = column.getBoundingClientRect()
      if (clientX >= rect.left && clientX < rect.right) return column
      const away = Math.min(Math.abs(clientX - rect.left), Math.abs(clientX - rect.right))
      if (away < distance) {
        distance = away
        nearest = column
      }
    }
    return nearest
  }

  // -- Drawing ---------------------------------------------------------------

  const blockLabel = (block: CalendarBlock<CalendarDisplayEntry>): string => {
    const entry = block.entry
    const parts = [
      entry.project_label ?? `Project ${entry.project_id}`,
      entry.task_label ?? `Task ${entry.task_id}`,
      block.running
        ? `from ${timeLabel(block.start)}, running`
        : spokenRange({ start: block.start, end: block.end }),
      view?.formatSeconds(entry.seconds) ?? '',
    ]
    if (entry.is_locked === true) parts.push(`locked: ${entry.locked_reason ?? 'locked'}`)
    return parts.filter((part) => part !== '').join(', ')
  }

  const drawBlockTime = (node: HTMLElement, span: CalendarSpan, running: boolean): void => {
    const time = node.querySelector<HTMLElement>('[data-calendar-block-time]')
    if (time === null) return
    time.textContent = running ? `${timeLabel(span.start)} – now` : rangeLabel(span)
  }

  const drawProposal = (block: ProposalBlock, lane: number, lanes: number): HTMLElement => {
    const node = element('button', 'cal-block cal-proposal')
    node.type = 'button'
    node.dataset.calendarProposal = String(block.proposal.id)
    node.dataset.proposalDate = block.date
    const source = proposalSourceLabel(block.proposal, view!.proposalTimeZone!)
    node.setAttribute(
      'aria-label',
      `Review proposed event: ${block.proposal.title}. ${source}. Not saved time.`,
    )
    node.append(
      element('span', 'cal-block-title', block.proposal.title),
      element('span', 'cal-block-task', 'Proposed · not saved'),
      element('span', 'cal-block-time', source),
    )
    setSpanStyle(node, block, lane, lanes)
    node.addEventListener('pointerdown', (event) => event.stopPropagation())
    node.addEventListener('click', (event) => {
      event.stopPropagation()
      host.reviewProposal?.(block.proposal.id, node)
    })
    return node
  }

  const drawBlock = (block: CalendarBlock<CalendarDisplayEntry>): HTMLElement => {
    const entry = block.entry
    const node = element('button', 'cal-block')
    node.type = 'button'
    node.dataset.calendarBlock = String(entry.id)
    node.dataset.calendarEntry = String(entry.id)
    if (block.running) node.dataset.state = 'running'
    else if (entry.is_locked === true) node.dataset.state = 'locked'
    if (block.overnight) node.dataset.overnight = 'true'
    node.setAttribute('aria-label', blockLabel(block))
    node.setAttribute('aria-describedby', 'calendar-keys')
    setSpanStyle(node, block, block.lane, block.lanes)
    const canMove = movable(entry)
    if (canMove) {
      const start = element('span', 'cal-handle')
      start.dataset.calendarHandle = 'start'
      start.setAttribute('aria-hidden', 'true')
      node.append(start)
    }
    const title = element('span', 'cal-block-title', entry.project_label ?? `Project ${entry.project_id}`)
    const task = element('span', 'cal-block-task', entry.task_label ?? `Task ${entry.task_id}`)
    const time = element('span', 'cal-block-time')
    time.dataset.calendarBlockTime = ''
    const hours = element('span', 'cal-block-hours', view?.formatSeconds(entry.seconds) ?? '')
    node.append(title, task, time, hours)
    drawBlockTime(node, block, block.running)
    if (entry.is_locked === true) {
      // Said on the block, not only when someone tries: a locked entry that
      // looks like every other one invites the drag it will refuse.
      const lock = element('span', 'cal-block-lock')
      lock.append(icon('padlock'), document.createTextNode(entry.locked_reason ?? 'Locked'))
      node.append(lock)
    }
    if (canMove) {
      const end = element('span', 'cal-handle')
      end.dataset.calendarHandle = 'end'
      end.setAttribute('aria-hidden', 'true')
      node.append(end)
    }
    blockElements.set(entry.id, node)
    return node
  }

  const drawChip = (entry: CalendarDisplayEntry): HTMLElement => {
    const item = element('li')
    const chip = element('button', 'cal-chip')
    chip.type = 'button'
    chip.dataset.calendarEntry = String(entry.id)
    chip.dataset.calendarChip = String(entry.id)
    if (entry.is_running === true) chip.dataset.state = 'running'
    else if (entry.is_locked === true) chip.dataset.state = 'locked'
    const project = entry.project_label ?? `Project ${entry.project_id}`
    const hours = view?.formatSeconds(entry.seconds) ?? ''
    chip.setAttribute(
      'aria-label',
      [
        project,
        entry.task_label ?? `Task ${entry.task_id}`,
        entry.is_running === true ? 'running' : hours,
        'no clock time',
        ...(entry.is_locked === true ? [`locked: ${entry.locked_reason ?? 'locked'}`] : []),
      ].join(', '),
    )
    if (entry.is_locked === true) chip.append(icon('padlock'))
    chip.append(
      element('span', 'cal-chip-name', project),
      element('span', 'cal-chip-hours', entry.is_running === true ? 'Running' : hours),
    )
    item.append(chip)
    return item
  }

  const drawCursor = (date: string): HTMLElement => {
    const cursor = element('button', 'cal-cursor')
    cursor.type = 'button'
    cursor.dataset.calendarCursor = date
    cursor.setAttribute('aria-describedby', 'calendar-keys')
    const label = element('span', 'cal-cursor-label')
    cursor.append(label)
    placeCursor(cursor, date)
    return cursor
  }

  function placeCursor(cursor: HTMLElement, date: string): void {
    setSpanStyle(cursor, cursorSpan)
    const label = cursor.querySelector<HTMLElement>('.cal-cursor-label')
    if (label !== null) label.textContent = rangeLabel(cursorSpan)
    cursor.setAttribute('aria-label', `Add time on ${longDay(date)}, ${spokenRange(cursorSpan)}`)
  }

  const drawDayHeader = (day: CalendarDay<CalendarDisplayEntry>, today: string): HTMLElement => {
    const header = element('header', 'cal-dayhead')
    const previous = element('button', 'cal-step')
    previous.type = 'button'
    previous.dataset.calendarStep = '-1'
    previous.setAttribute('aria-label', 'Previous day')
    previous.append(icon('chevron', { direction: 'left' }))
    const next = element('button', 'cal-step')
    next.type = 'button'
    next.dataset.calendarStep = '1'
    next.setAttribute('aria-label', 'Next day')
    next.append(icon('chevron'))
    const heading = element('h3', 'cal-dayhead-date')
    if (day.date === today) heading.dataset.today = 'true'
    const number = element('span', 'cal-dayhead-number', dayNumber(day.date))
    number.setAttribute('aria-hidden', 'true')
    const words = element('span', 'cal-dayhead-words')
    const weekday = element('span', 'cal-dayhead-weekday', weekdayOf(day.date, 'long'))
    weekday.setAttribute('aria-hidden', 'true')
    const month = element('span', 'cal-dayhead-month', monthOf(day.date))
    month.setAttribute('aria-hidden', 'true')
    const spoken = element('span', 'visually-hidden', `${longDay(day.date)}${day.date === today ? ', today' : ''}`)
    words.append(weekday, month, spoken)
    heading.append(number, words)
    const total = element('p', 'cal-dayhead-total')
    total.append(
      element('strong', undefined, view?.formatSeconds(day.totalSeconds) ?? ''),
      document.createTextNode(' total'),
    )
    header.append(previous, heading, total, next)
    return header
  }

  const drawNow = (): HTMLElement => {
    const line = element('div', 'cal-now')
    line.dataset.calendarNow = ''
    line.setAttribute('aria-hidden', 'true')
    line.style.setProperty('--cal-start', String(view?.now.minutes ?? 0))
    return line
  }

  const describeFocus = (): FocusMark | null => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !surface.contains(active)) return null
    if (active.dataset.calendarProposal !== undefined)
      return { kind: 'proposal', proposalId: Number(active.dataset.calendarProposal), date: active.dataset.proposalDate! }
    if (active.dataset.calendarBlock !== undefined)
      return { kind: 'block', entryId: Number(active.dataset.calendarBlock) }
    if (active.dataset.calendarChip !== undefined)
      return { kind: 'chip', entryId: Number(active.dataset.calendarChip) }
    if (active.dataset.calendarCursor !== undefined)
      return { kind: 'cursor', date: active.dataset.calendarCursor }
    if (active.dataset.calendarStep !== undefined)
      return { kind: 'step', offset: active.dataset.calendarStep }
    return null
  }

  const focusTarget = (mark: FocusMark): HTMLElement | null => {
    switch (mark.kind) {
      case 'proposal':
        return surface.querySelector<HTMLElement>(`[data-calendar-proposal="${mark.proposalId}"][data-proposal-date="${mark.date}"]`)
      case 'block':
        return surface.querySelector<HTMLElement>(`[data-calendar-block="${mark.entryId}"]`)
      case 'chip':
        return surface.querySelector<HTMLElement>(`[data-calendar-chip="${mark.entryId}"]`)
      case 'cursor':
        // The Day layout's arrows change the day under the cursor, so the one
        // it was on may be gone; the slot on the day now shown takes focus.
        return (
          surface.querySelector<HTMLElement>(`[data-calendar-cursor="${mark.date}"]`) ??
          surface.querySelector<HTMLElement>('[data-calendar-cursor]')
        )
      case 'step':
        return surface.querySelector<HTMLElement>(`[data-calendar-step="${mark.offset}"]`)
    }
  }

  const restoreFocus = (mark: FocusMark | null): void => {
    if (mark === null) return
    focusTarget(mark)?.focus({ preventScroll: true })
  }

  const draw = (next: CalendarView): void => {
    const focus = describeFocus()
    const previousScroll = scroller()?.scrollTop ?? null
    view = next
    const shown = next.layout === 'day' ? [next.selectedDate] : [...next.dates]
    days = calendarWeek(shown, next.entries, next.now)
    columns.clear()
    blockElements.clear()
    guide = null

    const root = element('div', 'cal')
    root.dataset.layout = next.layout
    root.style.setProperty('--cal-days', String(shown.length))
    if (next.layout === 'day' && days[0] !== undefined) {
      root.append(drawDayHeader(days[0], next.now.date))
    }
    const scroll = element('div', 'cal-scroll')
    scroll.dataset.calendarScroll = ''
    const grid = element('div', 'cal-grid')

    if (next.layout === 'week') {
      const corner = element('div', 'cal-corner')
      corner.setAttribute('aria-hidden', 'true')
      grid.append(corner)
      for (const day of days) {
        const head = element('div', 'cal-head')
        if (day.date === next.now.date) {
          head.dataset.today = 'true'
          head.setAttribute('aria-current', 'date')
        }
        const name = element('span', 'cal-head-day')
        name.append(
          element('span', 'cal-head-weekday', weekdayOf(day.date, 'short')),
          element('span', 'cal-head-number', dayNumber(day.date)),
        )
        const total = element('span', 'cal-head-total', next.formatSeconds(day.totalSeconds))
        head.append(name, total)
        grid.append(head)
      }
    }

    if (days.some((day) => day.untimed.length > 0)) {
      const label = element('div', 'cal-band-label', 'No clock time')
      label.id = 'calendar-untimed-label'
      grid.append(label)
      for (const day of days) {
        const cell = element('ul', 'cal-band')
        cell.dataset.calendarUntimed = day.date
        cell.setAttribute('aria-label', `${longDay(day.date)}, no clock time`)
        cell.append(...day.untimed.map((entry) => drawChip(entry)))
        grid.append(cell)
      }
      root.dataset.band = 'true'
    }

    const ruler = element('div', 'cal-ruler')
    ruler.setAttribute('aria-hidden', 'true')
    for (let hour = 0; hour < 24; hour += 1) {
      const mark = element('span', 'cal-ruler-hour', hourLabel(hour, next.clock))
      mark.style.setProperty('--cal-start', String(hour * 60))
      ruler.append(mark)
    }
    grid.append(ruler)

    for (const day of days) {
      const column = element('div', 'cal-col')
      column.dataset.calendarDay = day.date
      if (day.date === next.now.date) column.dataset.today = 'true'
      column.append(drawCursor(day.date))
      const proposed = (next.proposals ?? []).filter((block) => block.date === day.date)
      const lanes = assignLanes([
        ...day.blocks.map((block) => ({ key: block.entry.id, start: block.start, end: block.end })),
        ...proposed.map((block) => ({ key: -block.proposal.id, start: block.start, end: Math.max(block.end, block.start + 60) })),
      ])
      for (const block of day.blocks) column.append(drawBlock({ ...block, ...lanes.get(block.entry.id)! }))
      for (const block of proposed) {
        const lane = lanes.get(-block.proposal.id)!
        column.append(drawProposal(block, lane.lane, lane.lanes))
      }
      if (day.date === next.now.date) column.append(drawNow())
      columns.set(day.date, column)
      grid.append(column)
    }

    scroll.append(grid)
    root.append(scroll)
    surface.replaceChildren(root)
    if (status.dataset.calendarStatus !== 'message') status.textContent = ''

    // A keyboard move still being decided survives a redraw underneath it, as
    // long as the entry is still the one it started from.
    if (pending !== null) {
      const block = findBlock(pending.entryId)
      if (
        block === undefined ||
        block.entry.spent_date !== pending.original.date ||
        !sameSpan(block, pending.original.span)
      ) {
        pending = null
      } else {
        showPlacement(pending.entryId, pending.current)
      }
    }
    // So does a move being saved: until it lands, `next` can still have the
    // entry where it was.
    for (const entryId of saving.keys()) showSaving(entryId)
    if (draft !== null) drawDraft(draft)

    const scrollKey = `${next.layout}|${shown[0] ?? ''}`
    if (scrollKey !== scrolledFor || previousScroll === null) {
      scrolledFor = scrollKey
      const earliestProposal = (next.proposals ?? []).filter((block) => shown.includes(block.date)).reduce((earliest, block) => Math.min(earliest, Math.max(0, block.start - 30)), 8 * 60)
      scroll.scrollTop = (Math.min(firstVisibleMinutes(days), earliestProposal) / MINUTES_IN_DAY) * scroll.scrollHeight
    } else {
      scroll.scrollTop = previousScroll
    }
    restoreFocus(focus)
  }

  // -- Placement while something is being moved ----------------------------

  /** Draw a block where a drag or the keys have it, before anything is saved. */
  function showPlacement(entryId: number, placed: Placed): void {
    const node = blockElements.get(entryId)
    const block = findBlock(entryId)
    if (node === undefined || block === undefined) return
    const column = columns.get(placed.date)
    if (column !== undefined && node.parentElement !== column) column.append(node)
    setSpanStyle(node, placed.span)
    node.dataset.state = 'moving'
    drawBlockTime(node, placed.span, false)
  }

  /** Draw a block whose move is being saved where it is going, and say it is busy. */
  function showSaving(entryId: number): void {
    const placed = saving.get(entryId)
    const node = blockElements.get(entryId)
    if (placed === undefined || node === undefined) return
    showPlacement(entryId, placed)
    node.dataset.state = 'saving'
    node.setAttribute('aria-busy', 'true')
  }

  /** Put a block back where its entry says it is. */
  const restoreBlock = (entryId: number): void => {
    const node = blockElements.get(entryId)
    const block = findBlock(entryId)
    if (node === undefined || block === undefined) return
    const column = columns.get(block.entry.spent_date)
    if (column !== undefined && node.parentElement !== column) column.append(node)
    setSpanStyle(node, block, block.lane, block.lanes)
    delete node.dataset.state
    if (block.entry.is_locked === true) node.dataset.state = 'locked'
    drawBlockTime(node, block, block.running)
  }

  const draftNode = (): HTMLElement | null =>
    surface.querySelector<HTMLElement>('[data-calendar-draft]')

  /** The new entry, drawn selected where it will go while its editor is open. */
  function drawDraft(placed: Placed): HTMLElement | null {
    const column = columns.get(placed.date)
    if (column === undefined) return null
    let node = draftNode()
    if (node === null) {
      node = element('div', 'cal-block')
      node.dataset.state = 'draft'
      node.dataset.calendarDraft = ''
      node.setAttribute('aria-hidden', 'true')
      const title = element('span', 'cal-block-title', 'New entry')
      const time = element('span', 'cal-block-time')
      time.dataset.calendarBlockTime = ''
      node.append(title, time)
    }
    if (node.parentElement !== column) column.append(node)
    setSpanStyle(node, placed.span)
    drawBlockTime(node, placed.span, false)
    return node
  }

  const removeDraft = (): void => {
    draftNode()?.remove()
    draft = null
  }

  // -- Committing ------------------------------------------------------------

  const placementOf = (placed: Placed): CalendarPlacement => ({
    date: placed.date,
    ...spanTimes(placed.span),
  })

  const commitMove = (entryId: number, original: Placed, placed: Placed): void => {
    if (placed.date === original.date && sameSpan(placed.span, original.span)) {
      restoreBlock(entryId)
      return
    }
    saving.set(entryId, placed)
    showSaving(entryId)
    const where = `${longDay(placed.date)}, ${spokenRange(placed.span)}`
    delete status.dataset.calendarStatus
    status.textContent = 'Saving…'
    host
      .moveEntry(entryId, placementOf(placed))
      .then(() => {
        saving.delete(entryId)
        // The shell has refreshed and redrawn with the move in it, unless a
        // drag on something else held that redraw back; then the block stays
        // where it went until the drag ends and the redraw is drawn.
        if (deferred === null) {
          restoreBlock(entryId)
          blockElements.get(entryId)?.removeAttribute('aria-busy')
        }
        announce(`Saved: ${where}.`)
        if (status.textContent === 'Saving…') status.textContent = ''
      })
      .catch((error: unknown) => {
        saving.delete(entryId)
        restoreBlock(entryId)
        blockElements.get(entryId)?.removeAttribute('aria-busy')
        const reason = error instanceof Error ? error.message : 'It could not be saved.'
        tell(`The entry was not moved. ${reason}`)
      })
  }

  const beginCreate = (placed: Placed): void => {
    const node = drawDraft(placed)
    if (node === null) return
    draft = placed
    host.createEntry(placementOf(placed), node)
  }

  // -- Pointer ---------------------------------------------------------------

  const stopEdgeScroll = (): void => {
    if (edgeScroll !== undefined) globalThis.cancelAnimationFrame(edgeScroll)
    edgeScroll = undefined
  }

  const updateDrag = (state: DragState): void => {
    if (view === null) return
    const origin = columns.get(state.date)
    if (origin === undefined) return
    const minutes = minutesAt(origin, state.lastY)
    if (state.kind === 'create') {
      state.current = { date: state.date, span: spanFromDrag(state.originMinutes, minutes) }
      draft = state.current
      drawDraft(state.current)
      return
    }
    if (state.original === null || state.entryId === null) return
    if (state.kind === 'move') {
      const target = view.layout === 'week' ? columnAt(state.lastX) : origin
      state.current = {
        date: target?.dataset.calendarDay ?? state.date,
        span: moveSpan(state.original.span, minutes - state.originMinutes),
      }
    } else if (state.kind === 'start') {
      state.current = { date: state.original.date, span: resizeSpanStart(state.original.span, minutes) }
    } else {
      state.current = { date: state.original.date, span: resizeSpanEnd(state.original.span, minutes) }
    }
    showPlacement(state.entryId, state.current)
  }

  const edgeScrollStep = (): void => {
    const state = drag
    const scroll = scroller()
    if (state === null || !state.active || scroll === null) {
      edgeScroll = undefined
      return
    }
    const rect = scroll.getBoundingClientRect()
    let delta = 0
    if (state.lastY < rect.top + EDGE_SCROLL_PX) delta = -Math.ceil((rect.top + EDGE_SCROLL_PX - state.lastY) / 4)
    else if (state.lastY > rect.bottom - EDGE_SCROLL_PX)
      delta = Math.ceil((state.lastY - (rect.bottom - EDGE_SCROLL_PX)) / 4)
    if (delta !== 0) {
      const before = scroll.scrollTop
      scroll.scrollTop = before + delta
      if (scroll.scrollTop !== before) updateDrag(state)
    }
    edgeScroll = globalThis.requestAnimationFrame(edgeScrollStep)
  }

  const activate = (state: DragState): void => {
    state.active = true
    if (state.pressTimer !== undefined) globalThis.clearTimeout(state.pressTimer)
    state.pressTimer = undefined
    try {
      surface.setPointerCapture(state.pointerId)
    } catch {
      // The pointer may already have left; the drag still ends on pointerup.
    }
    surface.dataset.dragging = state.kind
    guide?.remove()
    guide = null
    if (state.kind === 'create') {
      draft = state.current
      drawDraft(state.current)
    } else if (state.entryId !== null) {
      showPlacement(state.entryId, state.current)
    }
    if (edgeScroll === undefined) edgeScroll = globalThis.requestAnimationFrame(edgeScrollStep)
  }

  const endDrag = (): void => {
    const state = drag
    drag = null
    stopEdgeScroll()
    delete surface.dataset.dragging
    if (state?.pressTimer !== undefined) globalThis.clearTimeout(state.pressTimer)
    if (state !== null) {
      try {
        if (surface.hasPointerCapture(state.pointerId)) surface.releasePointerCapture(state.pointerId)
      } catch {
        // Nothing to release.
      }
    }
    if (deferred !== null) {
      const next = deferred
      deferred = null
      draw(next)
    }
  }

  const cancelDrag = (): void => {
    const state = drag
    if (state === null) return
    if (state.active) {
      if (state.kind === 'create') removeDraft()
      else if (state.entryId !== null) restoreBlock(state.entryId)
      suppressNextClick()
    }
    endDrag()
  }

  surface.addEventListener('pointerdown', (event) => {
    if (view === null || drag !== null || pending !== null) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    delete status.dataset.calendarStatus
    const target = event.target instanceof Element ? event.target : null
    const column = target?.closest<HTMLElement>('[data-calendar-day]') ?? null
    if (target === null || column === null) return
    const date = column.dataset.calendarDay!
    const touch = event.pointerType === 'touch'
    const minutes = minutesAt(column, event.clientY)
    const blockNode = target.closest<HTMLElement>('[data-calendar-block]')
    const handle = target.closest<HTMLElement>('[data-calendar-handle]')?.dataset.calendarHandle
    let state: DragState
    if (blockNode !== null) {
      const entryId = Number(blockNode.dataset.calendarBlock)
      const block = findBlock(entryId)
      if (block === undefined) return
      const original: Placed = { date: block.entry.spent_date, span: { start: block.start, end: block.end } }
      state = {
        kind: handle === 'start' ? 'start' : handle === 'end' ? 'end' : 'move',
        pointerId: event.pointerId,
        touch,
        originX: event.clientX,
        originY: event.clientY,
        originMinutes: minutes,
        date,
        entryId,
        original,
        element: blockNode,
        refusal: refusalNow(block.entry),
        lastX: event.clientX,
        lastY: event.clientY,
        active: false,
        pressTimer: undefined,
        current: original,
      }
    } else if (target.closest('[data-calendar-draft]') !== null) {
      return
    } else {
      state = {
        kind: 'create',
        pointerId: event.pointerId,
        touch,
        originX: event.clientX,
        originY: event.clientY,
        originMinutes: minutes,
        date,
        entryId: null,
        original: null,
        element: null,
        refusal: null,
        lastX: event.clientX,
        lastY: event.clientY,
        active: false,
        pressTimer: undefined,
        current: { date, span: spanFromDrag(minutes, minutes) },
      }
    }
    drag = state
    if (state.refusal !== null) return
    if (touch && handle !== undefined) {
      // An edge is a handle and nothing else: it moves at once, and
      // `touch-action: none` on it keeps the page from scrolling instead.
      activate(state)
    } else if (touch) {
      state.pressTimer = globalThis.setTimeout(() => {
        if (drag === state && !state.active) {
          activate(state)
          updateDrag(state)
        }
      }, LONG_PRESS_MS)
    }
  })

  surface.addEventListener('pointermove', (event) => {
    const state = drag
    if (state === null) {
      moveGuide(event)
      return
    }
    if (event.pointerId !== state.pointerId) return
    state.lastX = event.clientX
    state.lastY = event.clientY
    if (!state.active) {
      const travelled = Math.hypot(event.clientX - state.originX, event.clientY - state.originY)
      if (state.touch) {
        // Moving before the hold completes is a scroll, which is the browser's.
        if (travelled > TOUCH_SLOP_PX) {
          if (state.pressTimer !== undefined) globalThis.clearTimeout(state.pressTimer)
          drag = null
        }
        return
      }
      if (travelled < MOUSE_THRESHOLD_PX) return
      if (state.refusal !== null) {
        tell(state.refusal)
        suppressNextClick()
        drag = null
        return
      }
      activate(state)
    }
    updateDrag(state)
  })

  surface.addEventListener('pointerup', (event) => {
    const state = drag
    if (state === null || event.pointerId !== state.pointerId) return
    if (!state.active) {
      endDrag()
      // A click or a tap on empty clock proposes the hour it landed in; one on
      // an entry falls through to the click, which opens it.
      if (state.kind === 'create' && state.refusal === null) {
        suppressNextClick()
        beginCreate({ date: state.date, span: spanAt(state.originMinutes) })
      }
      return
    }
    updateDrag(state)
    const finished = state.current
    endDrag()
    suppressNextClick()
    if (state.kind === 'create') {
      beginCreate(finished)
      return
    }
    if (state.entryId !== null && state.original !== null) {
      commitMove(state.entryId, state.original, finished)
    }
  })

  surface.addEventListener('pointercancel', (event) => {
    if (drag !== null && event.pointerId === drag.pointerId) cancelDrag()
  })

  // Once a finger's hold has started a drag, the page must not scroll under
  // it. A move that is not a drag is left alone, so a swipe still scrolls.
  surface.addEventListener(
    'touchmove',
    (event) => {
      if (drag?.active === true) event.preventDefault()
    },
    { passive: false },
  )
  // A long press would otherwise open the system's own menu over the drag.
  surface.addEventListener('contextmenu', (event) => {
    if (drag !== null) event.preventDefault()
  })

  surface.addEventListener(
    'click',
    (event) => {
      if (globalThis.performance.now() > suppressClickUntil) return
      suppressClickUntil = 0
      event.preventDefault()
      event.stopPropagation()
    },
    true,
  )

  surface.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (target === null) return
    const step = target.closest<HTMLElement>('[data-calendar-step]')
    if (step !== null) {
      host.stepDay(step.dataset.calendarStep === '-1' ? -1 : 1)
      return
    }
    const cursor = target.closest<HTMLElement>('[data-calendar-cursor]')
    if (cursor !== null) {
      beginCreate({ date: cursor.dataset.calendarCursor!, span: cursorSpan })
      return
    }
    const entry = target.closest<HTMLElement>('[data-calendar-entry]')
    if (entry !== null) {
      if (pending !== null) return
      const entryId = Number(entry.dataset.calendarEntry)
      // The editor would open on the entry as it was before the move, and
      // saving it there would put the move back.
      if (saving.has(entryId)) {
        tell(STILL_SAVING)
        return
      }
      host.openEntry(entryId)
    }
  })

  // -- The hover guide: where a click or a drag would start ------------------

  function moveGuide(event: PointerEvent): void {
    if (event.pointerType !== 'mouse' || view === null) return
    const target = event.target instanceof Element ? event.target : null
    const column = target?.closest<HTMLElement>('[data-calendar-day]') ?? null
    if (column === null || target?.closest('[data-calendar-block], [data-calendar-draft]') != null) {
      guide?.remove()
      guide = null
      return
    }
    const minutes = Math.floor(minutesAt(column, event.clientY) / SNAP_MINUTES) * SNAP_MINUTES
    if (guide === null) {
      guide = element('div', 'cal-guide')
      guide.setAttribute('aria-hidden', 'true')
    }
    if (guide.parentElement !== column) column.append(guide)
    guide.style.setProperty('--cal-start', String(Math.max(0, Math.min(minutes, MINUTES_IN_DAY - SNAP_MINUTES))))
    guide.dataset.time = timeLabel(minutes)
  }

  surface.addEventListener('pointerleave', () => {
    guide?.remove()
    guide = null
  })

  // -- Keys ------------------------------------------------------------------

  const moveCursor = (cursor: HTMLElement, next: CalendarSpan): void => {
    cursorSpan = next
    const date = cursor.dataset.calendarCursor!
    for (const each of surface.querySelectorAll<HTMLElement>('[data-calendar-cursor]')) {
      placeCursor(each, each.dataset.calendarCursor!)
    }
    cursor.scrollIntoView({ block: 'nearest' })
    announce(`${longDay(date)}, ${spokenRange(next)}`)
  }

  const cursorKeys = (event: KeyboardEvent, cursor: HTMLElement): void => {
    const date = cursor.dataset.calendarCursor!
    const step = event.key === 'ArrowUp' ? -SNAP_MINUTES : event.key === 'ArrowDown' ? SNAP_MINUTES : 0
    if (step !== 0 && event.shiftKey) {
      event.preventDefault()
      moveCursor(cursor, resizeSpanEnd(cursorSpan, cursorSpan.end + step))
    } else if (step !== 0) {
      event.preventDefault()
      moveCursor(cursor, moveSpan(cursorSpan, step))
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault()
      moveCursor(cursor, moveSpan(cursorSpan, event.key === 'PageUp' ? -60 : 60))
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const offset = event.key === 'ArrowLeft' ? -1 : 1
      if (view?.layout === 'day') {
        host.stepDay(offset)
        return
      }
      const dates = [...columns.keys()]
      const next = dates[dates.indexOf(date) + offset]
      if (next === undefined) {
        announce(offset < 0 ? 'First day of the week.' : 'Last day of the week.')
        return
      }
      const target = surface.querySelector<HTMLElement>(`[data-calendar-cursor="${next}"]`)
      target?.focus()
      announce(`${longDay(next)}, ${spokenRange(cursorSpan)}`)
    }
  }

  const blockKeys = (event: KeyboardEvent, node: HTMLElement): void => {
    const entryId = Number(node.dataset.calendarBlock)
    const block = findBlock(entryId)
    if (block === undefined || view === null) return
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown'
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
    if (event.key === 'Escape' && pending?.entryId === entryId) {
      event.preventDefault()
      event.stopPropagation()
      pending = null
      restoreBlock(entryId)
      announce('Move cancelled.')
      return
    }
    if (event.key === 'Enter' && pending?.entryId === entryId) {
      event.preventDefault()
      const { original, current } = pending
      pending = null
      commitMove(entryId, original, current)
      return
    }
    if (!vertical && !horizontal) return
    event.preventDefault()
    const refusal = refusalNow(block.entry)
    if (refusal !== null) {
      tell(refusal)
      return
    }
    const original: Placed = { date: block.entry.spent_date, span: { start: block.start, end: block.end } }
    if (pending === null || pending.entryId !== entryId) pending = { entryId, original, current: original }
    const now = pending.current
    let next: Placed
    if (vertical) {
      const step = event.key === 'ArrowUp' ? -SNAP_MINUTES : SNAP_MINUTES
      if (event.shiftKey && event.altKey) next = { date: now.date, span: resizeSpanStart(now.span, now.span.start + step) }
      else if (event.shiftKey) next = { date: now.date, span: resizeSpanEnd(now.span, now.span.end + step) }
      else next = { date: now.date, span: moveSpan(now.span, step) }
    } else {
      if (view.layout === 'day') {
        announce('Switch to the Week layout to move an entry to another day.')
        return
      }
      const dates = [...columns.keys()]
      const date = dates[dates.indexOf(now.date) + (event.key === 'ArrowLeft' ? -1 : 1)]
      if (date === undefined) {
        announce(event.key === 'ArrowLeft' ? 'First day of the week.' : 'Last day of the week.')
        return
      }
      next = { date, span: now.span }
    }
    pending.current = next
    showPlacement(entryId, next)
    node.focus({ preventScroll: true })
    node.scrollIntoView({ block: 'nearest' })
    announce(`${longDay(next.date)}, ${spokenRange(next.span)}. Enter saves, Escape puts it back.`)
  }

  // Escape abandons a pointer drag wherever focus happens to be.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || drag === null) return
    event.preventDefault()
    event.stopPropagation()
    cancelDrag()
  })

  surface.addEventListener('keydown', (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target === null) return
    if (event.key !== 'Enter' && event.key !== 'Escape') delete status.dataset.calendarStatus
    if (target.dataset.calendarCursor !== undefined) cursorKeys(event, target)
    else if (target.dataset.calendarBlock !== undefined) blockKeys(event, target)
  })

  // Leaving an entry with a move still undecided puts it back: only Enter saves.
  // Moving a block to another day's column takes focus off it for a moment,
  // so this asks after the move has put it back rather than at the blur.
  surface.addEventListener('focusout', (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    if (pending === null || target?.dataset.calendarBlock !== String(pending.entryId)) return
    const entryId = pending.entryId
    globalThis.setTimeout(() => {
      if (pending?.entryId !== entryId) return
      const active = document.activeElement
      if (active instanceof HTMLElement && active.dataset.calendarBlock === String(entryId)) return
      pending = null
      restoreBlock(entryId)
      announce('Move cancelled.')
    }, 0)
  })

  // Running entries grow and today's line moves; once a minute is enough.
  const tick = (): void => {
    if (view === null || drag !== null || pending !== null || draft !== null) return
    if (panel.offsetParent === null) return
    draw({ ...view, now: host.now() })
  }

  return {
    render(next) {
      ticker ??= globalThis.setInterval(tick, 60_000)
      if (drag !== null) {
        deferred = next
        return
      }
      draw(next)
    },
    clearDraft() {
      removeDraft()
    },
    clear() {
      if (ticker !== undefined) globalThis.clearInterval(ticker)
      ticker = undefined
      drag = null
      pending = null
      deferred = null
      saving.clear()
      view = null
      days = []
      guide = null
      scrolledFor = null
      removeDraft()
      columns.clear()
      blockElements.clear()
      surface.replaceChildren()
      status.textContent = ''
      delete status.dataset.calendarStatus
      if (live !== null) live.textContent = ''
    },
    focusEntry(entryId) {
      const node = surface.querySelector<HTMLElement>(`[data-calendar-entry="${entryId}"]`)
      if (node === null) return
      node.focus({ preventScroll: true })
      node.scrollIntoView({ block: 'nearest' })
    },
  }
}
