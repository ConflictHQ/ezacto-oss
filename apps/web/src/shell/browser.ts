import {
  EzactoApiError,
  type GeneralResource,
  type Invoice,
  type InvoiceGenerationInput,
  type TimeEntryInput,
  type TimeEntryPatch,
  type TimesheetLockPolicy,
  type TimesheetLockWindow,
  type TimesheetSubmission,
  type TimesheetSubmissionDetail,
  type Whoami,
} from '@ezacto/client'
import { browserDensityStore, createDensityRuntime, type Density } from '../density.js'
import {
  browserMoneyDisplayStore,
  createMoneyDisplayRuntime,
  moneyText,
  type MoneyDisplay,
} from '../money-display.js'
import {
  contextLabel,
  formatTimeForClock,
  modeForEntryDraft,
  parseTimeForClock,
  type EntryEditorContext,
  type TimeEntryMode,
} from '../components/time-entry-editor.js'
import { createPeriodControl, isCalendarDay } from '../components/period.js'
import { createClientDirectoryController } from '../clients/browser.js'
import { createProjectDirectoryController } from '../projects/browser.js'
import { createActivityController } from '../activity/browser.js'
import { createCalendarController } from '../calendar/browser.js'
import { createDashboardController } from '../dashboard/browser.js'
import { createReportsController } from '../reports/browser.js'
import { canReadFinancialReports } from '../reports/model.js'
import { createExpenseWorkflowController } from '../expenses/browser.js'
import { createTaskAdminController } from '../tasks/browser.js'
import { createTeamDirectoryController } from '../team/browser.js'
import { teamCapabilities } from '../team/model.js'
import { createExpenseCategoryDirectoryController } from '../expense-categories/browser.js'
import { createEmailConfigurationController } from '../email-config/browser.js'
import { createRecurringWorkspaceController } from '../recurring/browser.js'
import { createRetainerWorkspaceController } from '../retainers/browser.js'
import { createModuleSettingsController } from '../module-settings/browser.js'
import {
  createInvoicePaymentController,
  invoiceMatchesSearch,
  renderInvoiceListItems,
  setInvoiceClientNames,
} from '../invoices/browser.js'
import { invoiceIdentityCanRead, invoiceStatesFor } from '../invoices/model.js'
import {
  buildWeekGrid,
  formatCellHours,
  formatDuration,
  parseCellSeconds,
  saveWeekCellWithRetry,
  seedsFromEntries,
  weekDates,
  type WeekCellSaveResult,
  type WeekGrid,
  type WeekGridCell,
  type WeekRowSeed,
} from '../week-grid/model.js'
import {
  canBrowseDirectories,
  createSameOriginShellApi,
  hydratePendingTimesheetDetails,
  loadShellSnapshot,
  localDate,
  navigationDestination,
  isSelfWithdrawn,
  palettePlan,
  type PaletteEntity,
  type PaletteResult,
  prepareQuickAdd,
  runningElapsedSeconds,
  timeEntryNoteLength,
  weekRange,
  type DisplayTimeEntry,
  type PaletteDestination,
  type ApprovalQueueFilters,
  type ShellApi,
  type ShellSnapshot,
  TimeEntryNoteValidationError,
} from './model.js'

type GridView = 'desktop' | 'phone'

interface CellSaveState {
  readonly state: 'dirty' | 'saving' | 'saved' | 'retry'
  readonly rawValue: string
  readonly message?: string
  readonly notes?: string | null
  readonly minimumNoteLength?: number
  readonly retry?: () => Promise<WeekCellSaveResult>
}

interface FocusTarget {
  readonly key: string
  readonly view: GridView
}

interface AuthOperation {
  readonly generation: number
  readonly signal: AbortSignal
  readonly userId: number | null
}

interface GridHandlers {
  readonly cellStates: Map<string, CellSaveState>
  readonly organizationMode: TimeEntryMode
  readonly organizationTimeFormat: 'decimal' | 'hours_minutes'
  commit(
    input: HTMLInputElement,
    cell: WeekGridCell,
    view: GridView,
    focus?: FocusTarget,
  ): Promise<boolean>
  retry(cell: WeekGridCell, view: GridView): Promise<void>
  openEntry(cell: WeekGridCell, view: GridView): void
  // Absent when the build has no restart endpoint; the row then shows no Start.
  restart?(entryId: number): Promise<void>
}

interface ActiveEntryEditor {
  readonly context: EntryEditorContext
  readonly cell?: WeekGridCell
  readonly view?: GridView
  readonly entry: DisplayTimeEntry | null
  readonly projectId: number
  readonly taskId: number
  readonly spentDate: string
  readonly seconds: number
  readonly notes: string | null
  readonly mode: TimeEntryMode
  readonly timer: boolean
  readonly minimumNoteLength: number
  readonly initialDurationValue?: string
  readonly durationWasEditedBeforeOpen?: boolean
}

const IDENTITY_CACHE_KEY = 'ezacto.identity'

/**
 * Last known identity, so a document rendered without one still paints
 * immediately. This is a rendering hint only: it grants nothing, because every
 * protected request is still authorized by the worker against the real cookie.
 */
const readCachedIdentity = (): Whoami | undefined => {
  try {
    const raw = sessionStorage.getItem(IDENTITY_CACHE_KEY)
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { user_id?: unknown }).user_id === 'number'
    ) {
      return parsed as Whoami
    }
  } catch {
    // Private mode, disabled storage, or a stale shape. Ignore it.
  }
  return undefined
}

const rememberIdentity = (identity: Whoami): void => {
  try {
    sessionStorage.setItem(IDENTITY_CACHE_KEY, JSON.stringify(identity))
  } catch {
    // Caching is an optimization; never let it break sign-in.
  }
}

const forgetIdentity = (): void => {
  try {
    sessionStorage.removeItem(IDENTITY_CACHE_KEY)
  } catch {
    // As above.
  }
}

const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`shell element missing: ${selector}`)
  return element
}

/**
 * The organisation's chosen time format, published once the shell has a
 * snapshot. Totals are rendered from several places that have no snapshot in
 * scope, and a decimal account showing `2.25` in a cell beside `2:15` in that
 * cell's own row total is worse than either format alone.
 */
let activeTimeFormat: 'decimal' | 'hours_minutes' = 'hours_minutes'

const setActiveTimeFormat = (format: 'decimal' | 'hours_minutes'): void => {
  activeTimeFormat = format
}

/**
 * Every total on this screen — row, tfoot, week, day strip, timer chip — reads
 * beside a cell rendered from the same seconds, so it renders through the same
 * function the cell does rather than a second one that rounded differently.
 * Unlike `formatCellHours` a total of zero still prints: an empty cell means
 * "nothing logged", but a day that totals zero is a fact worth showing.
 */
const formatSeconds = (seconds: number): string =>
  formatDuration(seconds, activeTimeFormat)

const formatMoney = (cents: number, currency: string): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)

const parseDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`)

const shiftDate = (value: string, days: number): string => {
  const date = parseDate(value)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const dayLabel = (value: string, compact = false): string =>
  new Intl.DateTimeFormat('en-US', {
    weekday: compact ? 'short' : 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parseDate(value))

/**
 * A column header is scanned down a row of seven, not read as a sentence.
 * "Tue, Apr 1" makes the weekday and the date compete on one line; stacking
 * them lets the eye run across the weekdays and drop to the date only when it
 * needs to know which week it is looking at.
 */
const dayHeadingParts = (value: string): readonly [string, string] => {
  const date = parseDate(value)
  const weekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(date)
  const day = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  }).format(date)
  return [weekday, day]
}

const messageFor = (error: unknown): string => {
  if (error instanceof EzactoApiError && error.status === 401) return 'Sign in is required.'
  if (error instanceof EzactoApiError && typeof error.body === 'object' && error.body !== null) {
    const detail = Reflect.get(error.body, 'error')
    if (typeof detail === 'object' && detail !== null) {
      const fields = Reflect.get(detail, 'fields')
      if (Array.isArray(fields)) {
        const field = fields.find(
          (candidate) =>
            typeof candidate === 'object' &&
            candidate !== null &&
            typeof Reflect.get(candidate, 'message') === 'string',
        )
        if (field !== undefined) return String(Reflect.get(field, 'message'))
      }
      const message = Reflect.get(detail, 'message')
      if (typeof message === 'string' && message.trim() !== '') return message
    }
  }
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

const apiErrorCode = (error: EzactoApiError): string | null => {
  if (typeof error.body !== 'object' || error.body === null) return null
  const detail = Reflect.get(error.body, 'error')
  if (typeof detail !== 'object' || detail === null) return null
  const code = Reflect.get(detail, 'code')
  return typeof code === 'string' ? code : null
}

const minimumNoteLengthFromError = (error: unknown): number | null => {
  if (!(error instanceof EzactoApiError) || error.status !== 422) return null
  if (typeof error.body !== 'object' || error.body === null) return null
  const detail = Reflect.get(error.body, 'error')
  if (typeof detail !== 'object' || detail === null) return null
  const fields = Reflect.get(detail, 'fields')
  if (!Array.isArray(fields)) return null
  for (const field of fields) {
    if (typeof field !== 'object' || field === null) continue
    if (
      Reflect.get(field, 'field') !== 'notes' ||
      Reflect.get(field, 'code') !== 'minimum_length'
    )
      continue
    const minimum = Reflect.get(field, 'minimum_length')
    if (Number.isSafeInteger(minimum) && Number(minimum) > 0) {
      return Number(minimum)
    }
  }
  return null
}

const requiredMinimumFromError = (error: unknown): number | null =>
  error instanceof TimeEntryNoteValidationError
    ? error.minimumLength
    : minimumNoteLengthFromError(error)

const noteRequirementMessage = (minimumLength: number): string =>
  `A note of at least ${minimumLength} ${minimumLength === 1 ? 'character is' : 'characters are'} required for this project and task.`

const noteHint = (minimumLength: number): string =>
  minimumLength === 0
    ? 'Optional. Up to 10,000 characters.'
    : `Required. Enter at least ${minimumLength} ${minimumLength === 1 ? 'character' : 'characters'}; leading and trailing spaces do not count.`

const effectiveMinimumNoteLength = (
  cell: WeekGridCell,
  state: CellSaveState | undefined,
): number => Math.max(cell.minimumNoteLength, state?.minimumNoteLength ?? 0)

const notesForCell = (
  cell: WeekGridCell,
  state: CellSaveState | undefined,
): string | null => (state?.notes === undefined ? cell.notes : state.notes)

const signInMessage = (error: unknown): string => {
  if (!(error instanceof EzactoApiError)) {
    return 'Sign-in is unavailable right now. Try again.'
  }
  const code = apiErrorCode(error)
  if (code === 'invalid_credentials') return 'Email or password is incorrect.'
  if (code === 'email_verification_required') {
    return 'Verify your email before signing in.'
  }
  if (code === 'rate_limit_exceeded' || error.status === 429) {
    return 'Too many sign-in attempts. Wait a moment and try again.'
  }
  return 'Sign-in could not be completed. Try again.'
}

const profileLabel = (profile: Whoami['profile']): string =>
  profile.replaceAll('_', ' ')

const open = (dialog: HTMLDialogElement): void => {
  if (!dialog.open) dialog.showModal()
}

const cellInput = (
  cell: WeekGridCell,
  view: GridView,
  state: CellSaveState | undefined,
  organizationMode: TimeEntryMode,
  organizationTimeFormat: 'decimal' | 'hours_minutes',
): HTMLInputElement => {
  const input = document.createElement('input')
  input.type = 'text'
  input.inputMode = 'decimal'
  input.autocomplete = 'off'
  input.dataset.cellKey = cell.key
  input.dataset.savedValue = formatCellHours(cell.totalSeconds, organizationTimeFormat)
  input.dataset.view = view
  input.value = state?.rawValue ?? input.dataset.savedValue
  input.ariaLabel = `${dayLabel(cell.date)} hours`
  input.placeholder = '0'
  const mode = modeForEntryDraft(cell.entries[0] ?? null, organizationMode)
  input.disabled = cell.isConflict || cell.isLocked || cell.isRunning || mode === 'start_end'
  if (cell.isConflict)
    input.title = 'Multiple entries share this cell. Open Day view to edit them separately.'
  if (cell.isLocked) input.title = cell.lockedReason ?? 'This entry is locked.'
  if (cell.isRunning) input.title = 'Stop the running timer before editing this cell.'
  if (mode === 'start_end') input.title = 'Open entry details to edit start and end times.'
  return input
}

const renderCellControl = (
  cell: WeekGridCell,
  view: GridView,
  handlers: GridHandlers,
  next: FocusTarget | undefined,
  noteContext: string,
): HTMLElement => {
  const state = handlers.cellStates.get(cell.key)
  const minimumNoteLength = effectiveMinimumNoteLength(cell, state)
  const currentNotes = notesForCell(cell, state)
  const wrapper = document.createElement('div')
  wrapper.className = 'week-cell'
  wrapper.dataset.cellKey = cell.key
  wrapper.dataset.minimumNoteLength = String(minimumNoteLength)
  wrapper.dataset.cellState = cell.isConflict
    ? 'conflict'
    : cell.isLocked
      ? 'locked'
      : cell.isRunning
        ? 'running'
        : (state?.state ?? 'idle')
  if (cell.isRunning) wrapper.dataset.running = 'true'

  const status = document.createElement('span')
  status.className = 'cell-status'
  status.setAttribute('role', 'status')

  const input = cellInput(
    cell,
    view,
    state,
    handlers.organizationMode,
    handlers.organizationTimeFormat,
  )
  input.addEventListener('input', () => {
    const current = handlers.cellStates.get(cell.key)
    const dirty: CellSaveState = {
      state: 'dirty',
      rawValue: input.value,
      ...(current?.notes === undefined ? {} : { notes: current.notes }),
      ...(current?.minimumNoteLength === undefined
        ? {}
        : { minimumNoteLength: current.minimumNoteLength }),
    }
    handlers.cellStates.set(cell.key, dirty)
    wrapper.dataset.cellState = 'dirty'
    status.textContent = 'Unsaved'
  })
  input.addEventListener('blur', () => {
    if (input.value === input.dataset.savedValue) return
    void handlers.commit(input, cell, view)
  })
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void handlers.commit(input, cell, view, next)
  })
  wrapper.append(input)

  const note = document.createElement('button')
  note.type = 'button'
  note.className = 'cell-note'
  note.dataset.noteCell = cell.key
  note.ariaLabel = `${cell.entries.length === 0 ? 'Add time' : currentNotes === null ? 'Add note' : 'Edit note'} for ${noteContext} on ${dayLabel(cell.date)}${minimumNoteLength > 0 ? `; at least ${minimumNoteLength} characters required` : ''}`
  note.title = currentNotes ?? (minimumNoteLength > 0 ? noteHint(minimumNoteLength) : cell.entries.length === 0 ? 'Add time' : 'Add note')
  note.textContent = currentNotes === null ? '+' : '•'
  // Every cell already has a tab stop: its input. Putting the note and retry
  // affordances in the sequence made a week row fourteen stops to cross when
  // seven is the whole point of a grid. Both stay reachable by click and by
  // the row's own focus, and neither is the way anyone enters time.
  note.tabIndex = -1
  note.disabled =
    cell.entries.length > 1 ||
    cell.isConflict ||
    cell.isLocked ||
    state?.state === 'saving'
  note.addEventListener('click', () => handlers.openEntry(cell, view))
  wrapper.append(note)

  status.textContent = cell.isConflict
    ? 'Split'
    : cell.isLocked
      ? 'Locked'
      : cell.isRunning
        ? 'Running'
        : state?.state === 'retry'
          ? (state.message ?? 'Retry')
          : state?.state === 'saving'
            ? 'Saving…'
            : state?.state === 'saved'
              ? 'Saved'
              : state?.state === 'dirty'
                ? 'Unsaved'
              : cell.entries.length === 1 &&
                    timeEntryNoteLength(currentNotes) < minimumNoteLength
                  ? 'Note required'
                  : ''
  wrapper.append(status)

  if (cell.isLocked) {
    const reason = document.createElement('span')
    reason.className = 'cell-lock-reason'
    reason.dataset.lockedReason = cell.key
    reason.textContent = cell.lockedReason ?? 'Approved timesheet'
    reason.title = reason.textContent
    wrapper.append(reason)
  }

  if (state?.state === 'retry') {
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'cell-retry'
    retry.tabIndex = -1
    retry.textContent = 'Retry'
    retry.addEventListener('click', () => void handlers.retry(cell, view))
    wrapper.append(retry)
  }
  return wrapper
}

const renderDesktopGrid = (grid: WeekGrid, handlers: GridHandlers): void => {
  const head = required<HTMLTableSectionElement>('[data-week-grid-head]')
  const heading = document.createElement('tr')
  const projectHeading = document.createElement('th')
  projectHeading.scope = 'col'
  projectHeading.textContent = 'Project / task'
  heading.append(projectHeading)
  // Which column is today is the first thing you look for in a week grid, and
  // nothing said. The cells carry it too, so the marker runs the column's
  // height rather than sitting only in its header.
  const today = localDate()
  for (const date of grid.dates) {
    const th = document.createElement('th')
    th.scope = 'col'
    const [weekday, day] = dayHeadingParts(date)
    const weekdayLine = document.createElement('span')
    weekdayLine.dataset.weekday = ''
    weekdayLine.textContent = weekday
    const dayLine = document.createElement('span')
    dayLine.dataset.date = ''
    dayLine.textContent = day
    th.append(weekdayLine, dayLine)
    if (date === today) th.dataset.today = ''
    heading.append(th)
  }
  const totalHeading = document.createElement('th')
  totalHeading.scope = 'col'
  totalHeading.textContent = 'Total'
  heading.append(totalHeading)
  head.replaceChildren(heading)

  const body = required<HTMLTableSectionElement>('[data-week-grid-rows]')
  if (grid.rows.length === 0) {
    const row = document.createElement('tr')
    const empty = document.createElement('td')
    empty.colSpan = 9
    empty.className = 'grid-empty'
    empty.textContent = 'No rows yet. Add a project/task row or copy last week.'
    row.append(empty)
    body.replaceChildren(row)
  } else {
    body.replaceChildren(
      ...grid.rows.map((row, rowIndex) => {
        const tr = document.createElement('tr')
        if (row.isRunning) tr.dataset.running = 'true'
        const label = document.createElement('th')
        label.scope = 'row'
        const project = document.createElement('strong')
        project.textContent = row.projectLabel
        const task = document.createElement('span')
        task.textContent = row.taskLabel
        label.append(project, task)
        // The day list has had this since the timesheet work; the week grid
        // never did, so on a desktop the only way to start a timer was to
        // retype the project and task into the top bar as exact strings. Start
        // from the most recent entry on the row, which is the one whose notes
        // and rate the new timer should inherit.
        const restartable = [...row.cells]
          .reverse()
          .find((cell) => cell.entries.length > 0 && !cell.isLocked)
        const restartId = restartable?.entries[0]?.id
        if (handlers.restart !== undefined && restartId !== undefined && !row.isRunning) {
          const start = document.createElement('button')
          start.type = 'button'
          start.className = 'grid-row-start'
          start.dataset.startEntry = String(restartId)
          start.textContent = 'Start'
          // setAttribute rather than the ariaLabel property: the property is an
          // ARIA reflection jsdom does not mirror to the content attribute, so
          // the label would be real in a browser and untestable here.
          start.setAttribute(
            'aria-label',
            `Start a timer on ${row.projectLabel} / ${row.taskLabel}`,
          )
          start.addEventListener('click', () => {
            start.disabled = true
            void handlers.restart?.(restartId).finally(() => {
              start.disabled = false
            })
          })
          label.append(start)
        }
        tr.append(label)
        row.cells.forEach((cell, dayIndex) => {
          const td = document.createElement('td')
          if (cell.date === today) td.dataset.today = ''
          const nextRow = grid.rows[rowIndex + 1] ?? grid.rows[0]
          const nextDay = rowIndex + 1 < grid.rows.length ? dayIndex : (dayIndex + 1) % 7
          const nextCell = nextRow?.cells[nextDay]
          td.append(
            renderCellControl(
              cell,
              'desktop',
              handlers,
              nextCell === undefined ? undefined : { key: nextCell.key, view: 'desktop' },
              `${row.projectLabel} / ${row.taskLabel}`,
            ),
          )
          tr.append(td)
        })
        const total = document.createElement('td')
        total.className = 'row-total'
        total.textContent = formatSeconds(row.totalSeconds)
        tr.append(total)
        return tr
      }),
    )
  }

  const totals = required<HTMLTableSectionElement>('[data-week-grid-totals]')
  const totalRow = document.createElement('tr')
  const totalLabel = document.createElement('th')
  totalLabel.scope = 'row'
  totalLabel.textContent = 'Total'
  totalRow.append(totalLabel)
  for (const seconds of grid.dayTotals) {
    const td = document.createElement('td')
    td.textContent = formatSeconds(seconds)
    totalRow.append(td)
  }
  const grandTotal = document.createElement('td')
  grandTotal.textContent = formatSeconds(grid.totalSeconds)
  totalRow.append(grandTotal)
  totals.replaceChildren(totalRow)
}

/**
 * The seven-day strip, above the grid and shared by both views. §6 of the
 * old-UI analysis calls it "the single best 'did I finish my week?' affordance
 * in either version": the week's shape in one line, before you read a single
 * row. Day view had no totals at all.
 */
const renderDayTotals = (
  grid: WeekGrid,
  selectedDay: number,
  selectDay: (index: number) => void,
): void => {
  const strip = required<HTMLElement>('[data-day-totals]')
  const today = localDate()
  strip.replaceChildren(
    ...grid.dates.map((date, index) => {
      const item = document.createElement('li')
      item.dataset.dayTotal = date
      if (date === today) item.dataset.today = ''
      if (index === selectedDay) item.dataset.selected = ''
      // The strip already answers "which day am I short on"; making it the way
      // to go there closes the loop, rather than reading the answer here and
      // then hunting for it in a separate pair of arrows.
      const control = document.createElement('button')
      control.type = 'button'
      control.dataset.daySelect = String(index)
      control.setAttribute('aria-pressed', index === selectedDay ? 'true' : 'false')
      const label = document.createElement('span')
      label.textContent = dayLabel(date, true)
      const hours = document.createElement('strong')
      const seconds = grid.dayTotals[index] ?? 0
      hours.textContent = formatSeconds(seconds)
      // A day with nothing on it should read as empty at a glance rather than
      // as a number you have to compare against the others.
      if (seconds === 0) hours.dataset.empty = ''
      control.append(label, hours)
      control.addEventListener('click', () => selectDay(index))
      item.append(control)
      return item
    }),
  )
}

const renderPhoneDay = (grid: WeekGrid, selectedDay: number, handlers: GridHandlers): void => {
  const date = grid.dates[selectedDay]!
  required<HTMLElement>('[data-day-label]').textContent = dayLabel(date)
  const rows = required<HTMLElement>('[data-day-rows]')
  if (grid.rows.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'day-empty'
    empty.textContent = 'No rows yet. Tap Add row to start.'
    rows.replaceChildren(empty)
    return
  }
  const dayItems = grid.rows.flatMap((row) => {
    const cell = row.cells[selectedDay]!
    if (cell.entries.length < 2) return [{ row, cell, suffix: '' }]
    return cell.entries.map((entry, index) => ({
      row,
      suffix: ` · entry ${index + 1}`,
      cell: {
        ...cell,
        key: `${cell.key}:entry:${entry.id}`,
        entries: [entry],
        totalSeconds: entry.seconds,
        notes: entry.notes ?? null,
        minimumNoteLength: Math.max(
          cell.minimumNoteLength,
          entry.minimum_note_length,
        ),
        isConflict: false,
        isLocked: entry.is_locked,
        lockedReason: entry.locked_reason ?? null,
        isRunning: entry.is_running,
      },
    }))
  })
  rows.replaceChildren(
    ...dayItems.map(({ row, cell, suffix }, itemIndex) => {
      const item = document.createElement('article')
      item.className = 'day-row'
      if (cell.isRunning) item.dataset.running = 'true'
      const label = document.createElement('div')
      label.className = 'day-row-label'
      const project = document.createElement('strong')
      project.textContent = row.projectLabel
      const task = document.createElement('span')
      task.textContent = `${row.taskLabel}${suffix}`
      label.append(project, task)
      const note = document.createElement('p')
      note.className = 'day-entry-note'
      note.dataset.entryNote = String(cell.entries[0]?.id ?? '')
      note.textContent = cell.notes ?? 'No note'
      if (cell.notes === null) note.dataset.empty = 'true'
      label.append(note)
      // Restarting yesterday's entry is how the old UI started today's work:
      // one press on the row you already have, rather than retyping the project
      // and task as exact strings into the command line. The endpoint has been
      // shipped and unused.
      const entryId = cell.entries[0]?.id
      if (handlers.restart !== undefined && entryId !== undefined && !cell.isRunning) {
        const start = document.createElement('button')
        start.type = 'button'
        start.className = 'day-row-start'
        start.dataset.startEntry = String(entryId)
        start.textContent = 'Start'
        start.ariaLabel = `Start a timer on ${row.projectLabel} / ${row.taskLabel}`
        start.disabled = cell.isLocked
        start.addEventListener('click', () => {
          start.disabled = true
          void handlers.restart?.(entryId).finally(() => {
            start.disabled = cell.isLocked
          })
        })
        label.append(start)
      }
      const nextCell = dayItems[(itemIndex + 1) % dayItems.length]?.cell
      item.append(
        label,
        renderCellControl(
          cell,
          'phone',
          handlers,
          nextCell === undefined ? undefined : { key: nextCell.key, view: 'phone' },
          `${row.projectLabel} / ${row.taskLabel}${suffix}`,
        ),
      )
      return item
    }),
  )
}

let timerInterval: ReturnType<typeof globalThis.setInterval> | undefined

const renderTimer = (running: DisplayTimeEntry | null): void => {
  const chip = required<HTMLButtonElement>('[data-timer-chip]')
  const label = required<HTMLElement>('[data-timer-label]')
  const elapsed = required<HTMLElement>('[data-timer-elapsed]')
  if (timerInterval !== undefined) globalThis.clearInterval(timerInterval)
  if (running === null) {
    chip.dataset.state = 'stopped'
    label.textContent = 'Start timer'
    // The idle placeholder sits in the same column of numbers as the totals, so
    // it follows the setting too: a hardcoded 0:00 beside a 2.25 row total is
    // the same mismatch, just at zero.
    elapsed.textContent = formatSeconds(0)
    return
  }
  chip.dataset.state = 'running'
  label.textContent = `${running.project_label} / ${running.task_label}`
  const update = (): void => {
    elapsed.textContent = formatSeconds(runningElapsedSeconds(running))
  }
  update()
  timerInterval = globalThis.setInterval(update, 1_000)
}

type WeekStartDay = 'saturday' | 'sunday' | 'monday'

const storageKey = (userId: number, within: string, weekStartDay: WeekStartDay): string =>
  `ezacto:user:${userId}:week-rows:${weekDates(within, weekStartDay)[0]}`

const loadSupplementalRows = (
  userId: number,
  within: string,
  weekStartDay: WeekStartDay,
): WeekRowSeed[] => {
  try {
    const value: unknown = JSON.parse(
      globalThis.localStorage.getItem(storageKey(userId, within, weekStartDay)) ?? '[]',
    )
    if (!Array.isArray(value)) return []
    return value.flatMap((item): WeekRowSeed[] => {
      if (typeof item !== 'object' || item === null) return []
      const projectId = Reflect.get(item, 'projectId')
      const taskId = Reflect.get(item, 'taskId')
      return Number.isSafeInteger(projectId) && Number.isSafeInteger(taskId)
        ? [{ projectId: Number(projectId), taskId: Number(taskId) }]
        : []
    })
  } catch {
    return []
  }
}

const saveSupplementalRows = (
  userId: number,
  within: string,
  rows: readonly WeekRowSeed[],
  weekStartDay: WeekStartDay,
): void => {
  try {
    globalThis.localStorage.setItem(
      storageKey(userId, within, weekStartDay),
      JSON.stringify(rows),
    )
  } catch {
    // Empty-row layout is a convenience only; canonical time remains server-backed.
  }
}

const initialWithin = (): string => {
  const requested = new URL(globalThis.location.href).searchParams.get('week')
  if (requested !== null) {
    try {
      weekDates(requested)
      return requested
    } catch {
      // Invalid navigation state falls back to the user's current local date.
    }
  }
  return localDate()
}

const setWeekUrl = (within: string, weekStartDay: WeekStartDay): void => {
  const url = new URL(globalThis.location.href)
  if (weekDates(within, weekStartDay)[0] === weekDates(localDate(), weekStartDay)[0])
    url.searchParams.delete('week')
  else url.searchParams.set('week', weekDates(within, weekStartDay)[0]!)
  globalThis.history.replaceState(null, '', url)
}

const focusedCell = (): FocusTarget | undefined => {
  const active = document.activeElement
  if (!(active instanceof HTMLInputElement)) return undefined
  const key = active.dataset.cellKey
  const view = active.dataset.view
  return key === undefined || (view !== 'desktop' && view !== 'phone') ? undefined : { key, view }
}

const focusCell = (target: FocusTarget | undefined): boolean => {
  if (target === undefined) return false
  const matches = [...document.querySelectorAll<HTMLInputElement>('input[data-cell-key]')].filter(
    (input) =>
      input.dataset.view === target.view &&
      (input.dataset.cellKey === target.key ||
        input.dataset.cellKey?.startsWith(`${target.key}:entry:`) === true),
  )
  const editable = matches.find((input) => !input.disabled)
  if (editable !== undefined) {
    editable.focus()
    editable.select()
    return true
  }
  const wrapper = matches[0]?.closest<HTMLElement>('.week-cell')
  if (wrapper === undefined || wrapper === null) return false
  wrapper.tabIndex = -1
  wrapper.focus()
  return true
}

const visibleGridView = (): GridView =>
  document.documentElement.dataset.timeView === 'day' ||
  globalThis.matchMedia('(max-width: 720px)').matches
    ? 'phone'
    : 'desktop'

const option = (value: number, label: string): HTMLOptionElement => {
  const result = document.createElement('option')
  result.value = String(value)
  result.textContent = label
  return result
}

const resourceLabel = (resource: Record<string, unknown>): string => {
  for (const field of ['name', 'code']) {
    const value = resource[field]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return `#${String(resource.id)}`
}

const collectResources = async (
  load: (
    cursor?: string,
    signal?: AbortSignal,
  ) => Promise<{
    readonly data: readonly GeneralResource[]
    readonly page: { readonly next_cursor: string | null }
  }>,
  signal: AbortSignal,
): Promise<GeneralResource[]> => {
  const resources: GeneralResource[] = []
  let cursor: string | undefined
  do {
    signal.throwIfAborted()
    const page = await load(cursor, signal)
    resources.push(...page.data)
    cursor = page.page.next_cursor ?? undefined
  } while (cursor !== undefined)
  return resources
}

export const mountShell = async (api: ShellApi = createSameOriginShellApi()): Promise<void> => {
  const authGateway = required<HTMLElement>('[data-auth-gateway]')
  const authChecking = required<HTMLElement>('[data-auth-checking]')
  const sessionCheckOverlay = required<HTMLElement>('[data-session-check-overlay]')
  const authenticatedShell = required<HTMLElement>('[data-authenticated-shell]')
  const invoiceGenerationPage =
    document.documentElement.dataset.appView === 'invoice-generation'
  const invoiceListPage = document.documentElement.dataset.appView === 'invoice-list'
  const invoiceDetailPage = document.documentElement.dataset.appView === 'invoice-detail'
  const invoiceRecurringPage =
    document.documentElement.dataset.appView === 'invoice-recurring'
  const invoiceRetainersPage =
    document.documentElement.dataset.appView === 'invoice-retainers'
  const invoiceConfigurePage =
    document.documentElement.dataset.appView === 'invoice-configure'
  const clientListPage = document.documentElement.dataset.appView === 'client-list'
  const clientDetailPage = document.documentElement.dataset.appView === 'client-detail'
  const projectListPage = document.documentElement.dataset.appView === 'project-list'
  const projectDetailPage = document.documentElement.dataset.appView === 'project-detail'
  const taskListPage = document.documentElement.dataset.appView === 'task-list'
  const teamListPage = document.documentElement.dataset.appView === 'team-list'
  const teamPersonPage = document.documentElement.dataset.appView === 'team-person'
  const dashboardPage = document.documentElement.dataset.appView === 'dashboard'
  const reportsPage = document.documentElement.dataset.appView === 'reports'
  const expenseListPage = document.documentElement.dataset.appView === 'expense-list'
  const expenseDetailPage = document.documentElement.dataset.appView === 'expense-detail'
  const expenseCategoriesPage =
    document.documentElement.dataset.appView === 'expense-categories'
  const moduleSettingsPage =
    document.documentElement.dataset.appView === 'settings-company'
  const settingsUserPage = document.documentElement.dataset.appView === 'settings-user'
  const timesheetApprovalsPage =
    document.documentElement.dataset.appView === 'timesheet-approvals'
  const brandName = document.documentElement.dataset.brand ?? 'ezacto'
  const signedOutDocumentTitle = document.title
  const authenticatedDocumentTitle = signedOutDocumentTitle.replace(
    / — Sign in$/u,
    invoiceGenerationPage
      ? ' — Generate invoice'
      : invoiceListPage
        ? ' — Invoices'
        : invoiceDetailPage
          ? ' — Invoice detail'
          : invoiceRecurringPage
            ? ' — Recurring invoices'
            : invoiceRetainersPage
              ? ' — Retainers'
              : invoiceConfigurePage
                ? ' — Invoice configuration'
          : clientListPage
            ? ' — Clients'
            : clientDetailPage
              ? ' — Client detail'
              : projectListPage
                ? ' — Projects'
                : projectDetailPage
                  ? ' — Project detail'
                  : taskListPage
                  ? ' — Tasks'
                  : teamListPage
                    ? ' — Team'
                    : teamPersonPage
                      ? ' — Person'
                  : reportsPage
                    ? ' — Reports'
                    : expenseListPage
                      ? ' — Expenses'
                      : expenseDetailPage
                        ? ' — Expense detail'
                        : expenseCategoriesPage
                          ? ' — Expense categories'
                          : moduleSettingsPage
                            ? ' — Company settings'
                            : settingsUserPage
                            ? ' — Your settings'
                            : timesheetApprovalsPage
                            ? ' — Approvals'
                            : ' — Time',
  )
  const status = required<HTMLElement>('[data-session-status]')
  const statusMessage = required<HTMLElement>('[data-session-message]')
  const retryWeek = required<HTMLButtonElement>('[data-retry-week]')
  const authShell = required<HTMLElement>('[data-auth-shell]')
  const signInForm = required<HTMLFormElement>('[data-sign-in-form]')
  const signInEmail = required<HTMLInputElement>('[name="email"]')
  const signInPassword = required<HTMLInputElement>('[name="password"]')
  const signInSubmit = required<HTMLButtonElement>('[data-sign-in-submit]')
  const signInResult = required<HTMLElement>('[data-sign-in-result]')
  const currentIdentityPanel = required<HTMLElement>('[data-current-identity]')
  const logout = required<HTMLButtonElement>('[data-logout]')
  const logoutResult = required<HTMLElement>('[data-logout-result]')
  const commandDialog = required<HTMLDialogElement>('[data-command-dialog]')
  const entryDialog = required<HTMLDialogElement>('[data-entry-dialog]')
  const entryContext = required<HTMLElement>('[data-entry-context]')
  const entryTitle = required<HTMLElement>('[data-entry-title]')
  const menuDialog = required<HTMLDialogElement>('[data-menu-dialog]')
  const rowDialog = required<HTMLDialogElement>('[data-row-dialog]')
  const rejectionDialog = required<HTMLDialogElement>('[data-rejection-dialog]')
  const withdrawalDialog = required<HTMLDialogElement>('[data-withdrawal-dialog]')
  const commandForm = required<HTMLFormElement>('[data-command-form]')
  const commandInput = required<HTMLInputElement>('[name="command"]')
  const commandResults = required<HTMLElement>('[data-command-results]')
  const entryForm = required<HTMLFormElement>('[data-entry-form]')
  const rowForm = required<HTMLFormElement>('[data-row-form]')
  const rejectionForm = required<HTMLFormElement>('[data-rejection-form]')
  const withdrawalForm = required<HTMLFormElement>('[data-withdrawal-form]')
  const entryProject = required<HTMLInputElement>('[data-entry-project]')
  const entryTask = required<HTMLInputElement>('[data-entry-task]')
  const entryDate = required<HTMLInputElement>('[data-entry-date]')
  const entryDuration = required<HTMLElement>('[data-entry-duration]')
  const entryDurationInput = required<HTMLInputElement>('[data-entry-duration-input]')
  const entryTimes = required<HTMLElement>('[data-entry-times]')
  const entryStart = required<HTMLInputElement>('[data-entry-start]')
  const entryEnd = required<HTMLInputElement>('[data-entry-end]')
  const entryRunning = required<HTMLElement>('[data-entry-running]')
  const entryNoteInput = required<HTMLTextAreaElement>('[data-entry-note-input]')
  const entryNoteHint = required<HTMLElement>('[data-entry-note-hint]')
  const entryResult = required<HTMLElement>('[data-entry-result]')
  const entrySubmit = required<HTMLButtonElement>('[data-entry-submit]')
  const stopTimer = required<HTMLButtonElement>('[data-stop-timer]')
  const invoiceForm = required<HTMLFormElement>('[data-invoice-generation-form]')
  /**
   * The From/To pair the generation fieldset used to carry, as the shared
   * control. Nothing runs on an arrow here: the wizard has no results to
   * refresh, only a submit that turns the choice into a draft invoice, so a
   * step is still just a choice. "Last month", one arrow from the month it
   * opens on, is the whole point -- billing a period is exactly the question
   * this control was drawn for.
   */
  const invoicePeriod = createPeriodControl({
    label: 'Period',
    today: localDate,
    onChange: () => {},
  })
  required<HTMLElement>('[data-invoice-period]').appendChild(invoicePeriod.element)
  const invoiceClient = required<HTMLSelectElement>('[data-invoice-client]')
  const invoiceProjects = required<HTMLElement>('[data-invoice-projects]')
  const invoiceResult = required<HTMLElement>('[data-invoice-generation-result]')
  const invoiceSubmit = required<HTMLButtonElement>('[data-invoice-generation-submit]')
  const invoiceRetry = required<HTMLButtonElement>('[data-retry-invoice-catalog]')
  const invoiceSuccess = required<HTMLElement>('[data-invoice-generation-success]')
  const generatedInvoiceLink = required<HTMLAnchorElement>('[data-generated-invoice-link]')
  const clientDirectory = createClientDirectoryController(api)
  const projectDirectory = createProjectDirectoryController(api)
  const taskAdmin = createTaskAdminController(api)
  const teamDirectory = createTeamDirectoryController(api)
  const calendar = createCalendarController()
  const dashboard = createDashboardController(api)
  // Reads only when the api offers the endpoint; an install without it still
  // serves the page and simply says it cannot load.
  const activity = createActivityController({
    listActivityLog: async (query, signal) =>
      api.listActivityLog === undefined
        ? { data: [] }
        : api.listActivityLog(query, signal),
  })
  const reports = createReportsController(api)
  const expenseWorkflow = createExpenseWorkflowController(api)
  const expenseCategories = createExpenseCategoryDirectoryController(api)
  const emailConfiguration = createEmailConfigurationController(api)
  const recurringWorkspace = createRecurringWorkspaceController(api)
  const retainerWorkspace = createRetainerWorkspaceController(api)
  const moduleSettings = createModuleSettingsController(api)
  const invoicePayments = createInvoicePaymentController(api)
  const invoiceList = required<HTMLElement>('[data-invoice-list]')
  const invoiceListStatus = required<HTMLElement>('[data-invoice-list-status]')
  const invoiceLoadMore = required<HTMLButtonElement>('[data-invoice-load-more]')
  const invoiceSearch = required<HTMLInputElement>('[data-invoice-search]')
  const invoiceDetailStatus = required<HTMLElement>('[data-invoice-detail-status]')
  const invoiceDocument = required<HTMLElement>('[data-invoice-document]')
  const timesheetStatus = required<HTMLElement>('[data-timesheet-status]')
  const timesheetStatusLabel = required<HTMLElement>('[data-timesheet-status-label]')
  const timesheetRejectionReason = required<HTMLElement>('[data-timesheet-rejection-reason]')
  const timesheetResult = required<HTMLElement>('[data-timesheet-result]')
  const submitTimesheet = required<HTMLButtonElement>('[data-submit-timesheet]')
  const withdrawTimesheet = required<HTMLButtonElement>('[data-withdraw-timesheet]')
  const unsubmitTimesheet = required<HTMLButtonElement>('[data-unsubmit-timesheet]')
  const approvalsPageElement = required<HTMLElement>('[data-timesheet-approvals-page]')
  const approvalReviewPanel = required<HTMLElement>('[data-approval-review-panel]')
  const approvalQueue = required<HTMLElement>('[data-approval-queue]')
  const approvalHistory = required<HTMLElement>('[data-approval-history]')
  const approvalQueueResult = required<HTMLElement>('[data-approval-queue-result]')
  const approvalFiltersForm = required<HTMLFormElement>('[data-approval-filters]')
  const approvalFilterUser = required<HTMLSelectElement>('[data-approval-filter-user]')
  const approvalFilterClient = required<HTMLSelectElement>('[data-approval-filter-client]')
  const approvalFilterProject = required<HTMLSelectElement>('[data-approval-filter-project]')
  const approvalLoadMore = required<HTMLButtonElement>('[data-approval-load-more]')
  const approvalHistoryLoadMore = required<HTMLButtonElement>('[data-approval-history-load-more]')
  const rejectionReason = required<HTMLTextAreaElement>('[data-rejection-reason]')
  const rejectionResult = required<HTMLElement>('[data-rejection-result]')
  const rejectionSubmit = required<HTMLButtonElement>('[data-rejection-submit]')
  const withdrawalReason = required<HTMLTextAreaElement>('[data-withdrawal-reason]')
  const withdrawalResult = required<HTMLElement>('[data-withdrawal-result]')
  const withdrawalSubmit = required<HTMLButtonElement>('[data-withdrawal-submit]')
  const lockPolicyPanel = required<HTMLElement>('[data-lock-policy-panel]')
  const lockPolicyForm = required<HTMLFormElement>('[data-lock-policy-form]')
  const lockPolicyAuto = required<HTMLInputElement>('[data-lock-policy-auto]')
  const lockPolicyDay = required<HTMLSelectElement>('[data-lock-policy-day]')
  const lockPolicyTime = required<HTMLInputElement>('[data-lock-policy-time]')
  const lockPolicyTimezone = required<HTMLInputElement>('[data-lock-policy-timezone]')
  const lockPolicySubmit = required<HTMLButtonElement>('[data-lock-policy-submit]')
  const manualLockForm = required<HTMLFormElement>('[data-manual-lock-form]')
  const manualLockThrough = required<HTMLInputElement>('[data-manual-lock-through]')
  const manualLockReason = required<HTMLTextAreaElement>('[data-manual-lock-reason]')
  const manualLockSubmit = required<HTMLButtonElement>('[data-manual-lock-submit]')
  const lockPolicyResult = required<HTMLElement>('[data-lock-policy-result]')
  const timesheetLockList = required<HTMLElement>('[data-timesheet-lock-list]')
  const requestedView = new URL(globalThis.location.href).searchParams.get('view')
  document.documentElement.dataset.timeView =
    requestedView === 'day' || requestedView === 'calendar' ? requestedView : 'week'
  // Scoped to Time's own strip: this derives the current tab from the ?view=
  // parameter, which no other section navigates by. Left on '.tabstrip a' it
  // would strip aria-current off every tab in every other strip on load.
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-time-views] a')) {
    const linkView = new URL(link.href).searchParams.get('view') ?? 'week'
    if (linkView === document.documentElement.dataset.timeView)
      link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  const cellStates = new Map<string, CellSaveState>()
  let within = initialWithin()
  let weekStartDay: WeekStartDay = 'monday'
  /**
   * The week stepper the toolbar used to hand-roll: two chevrons, a static
   * "Monday–Sunday" eyebrow and a "Week of …" label built by a private
   * `weekLabel`. It is the shared control now, restricted to `week` because the
   * grid underneath draws seven day columns and cannot draw a month.
   *
   * `week_start_day` therefore has one implementation on this screen too: the
   * control's `week` arithmetic is `weekRange`, the same function
   * `loadShellSnapshot` and the approval windows already use.
   *
   * An arrow loads, because stepping the timesheet has always loaded -- this is
   * the one screen where the period was already navigation rather than a filter
   * waiting on a button.
   */
  const weekPeriod = createPeriodControl({
    label: 'Week',
    kinds: ['week'],
    today: localDate,
    onChange: (range) => {
      moveWeekTo(range.from)
    },
  })
  required<HTMLElement>('[data-week-period]').appendChild(weekPeriod.element)
  let supplementalRows: WeekRowSeed[] = []
  let selectedDay = Math.max(0, weekDates(within, weekStartDay).indexOf(localDate()))
  let snapshot: ShellSnapshot | null = null
  let grid: WeekGrid | null = null
  let activeEntry: ActiveEntryEditor | null = null
  let currentIdentity: Whoami | null = null
  let signingIn = false
  let signingOut = false
  let authGeneration = 0
  let authController = new AbortController()
  let invoiceCatalog: {
    readonly clients: readonly GeneralResource[]
    readonly projects: readonly GeneralResource[]
  } | null = null
  let invoiceGenerationPending = false
  let invoiceCommandId: string | null = null
  let invoiceNextCursor: string | null = null
  let invoiceListRows: readonly Invoice[] = []
  /** Which states the list is asking the server for. Outstanding is the open question. */
  let invoiceFilter: 'outstanding' | 'paid' | 'closed' | 'all' = 'outstanding'
  let invoiceClientNamesLoaded = false
  let invoiceListCount = 0
  let approvalModuleAvailable = false
  let lockPolicyAvailable = false
  let currentSubmission: TimesheetSubmission | null = null
  let pendingSubmissions: readonly TimesheetSubmissionDetail[] = []
  let approvedSubmissions: readonly TimesheetSubmission[] = []
  let pendingNextCursor: string | null = null
  let approvedNextCursor: string | null = null
  let approvalQueueFilters: ApprovalQueueFilters = {}
  // Ids only. The versions come from the rendered cards at the moment the
  // approver confirms, so a queue that reloaded under them sends what they can
  // actually see rather than what they saw a page ago.
  let selectedSubmissionIds: ReadonlySet<number> = new Set()
  let bulkApprovalCommandId: string | null = null
  let lockPolicy: TimesheetLockPolicy | null = null
  let activeTimesheetLocks: readonly TimesheetLockWindow[] = []
  let timesheetTransitionPending = false
  let lockPolicyTransitionPending = false
  let manualLockCommandId: string | null = null
  let rejectionSubmissionId: number | null = null
  let withdrawalSubmissionId: number | null = null

  const setInvoiceFormPending = (pending: boolean): void => {
    invoiceGenerationPending = pending
    for (const fieldset of invoiceForm.querySelectorAll<HTMLFieldSetElement>('fieldset')) {
      fieldset.disabled = pending
    }
    invoiceSubmit.disabled = pending
    invoiceRetry.disabled = pending
  }

  const configureNoteInput = (
    input: HTMLTextAreaElement,
    hint: HTMLElement,
    minimumLength: number,
  ): void => {
    input.required = minimumLength > 0
    input.minLength = minimumLength
    hint.textContent = noteHint(minimumLength)
  }

  const beginAuthGeneration = (userId: number | null): AuthOperation => {
    authController.abort()
    authController = new AbortController()
    authGeneration += 1
    return {
      generation: authGeneration,
      signal: authController.signal,
      userId,
    }
  }

  const currentAuthOperation = (userId: number | null): AuthOperation => ({
    generation: authGeneration,
    signal: authController.signal,
    userId,
  })

  const isGenerationCurrent = (operation: AuthOperation): boolean =>
    operation.generation === authGeneration && !operation.signal.aborted

  const isSessionCurrent = (operation: AuthOperation): boolean =>
    isGenerationCurrent(operation) &&
    operation.userId !== null &&
    currentIdentity?.user_id === operation.userId

  const sessionOperation = (): AuthOperation | null =>
    currentIdentity === null
      ? null
      : currentAuthOperation(currentIdentity.user_id)

  const setSessionStatus = (
    message: string,
    state: 'ready' | 'signed-out' | 'loading' | 'error',
    retry = false,
  ): void => {
    statusMessage.textContent = message
    status.dataset.state = state
    retryWeek.hidden = !retry
    retryWeek.disabled = false
  }

  const setApplicationAvailability = (available: boolean): void => {
    for (const control of document.querySelectorAll<HTMLButtonElement>('[data-auth-action]')) {
      control.disabled = !available
    }
    // Not reachable by the `[data-auth-action]` sweep above: the control builds
    // its own arrows in the browser, so there is no served markup to mark. The
    // arrows the sweep used to disable were the ones it replaced.
    weekPeriod.setDisabled(!available)
  }

  const showSignedOutScreen = (): void => {
    sessionCheckOverlay.hidden = true
    authenticatedShell.hidden = true
    authenticatedShell.inert = true
    authenticatedShell.setAttribute('aria-busy', 'false')
    authGateway.hidden = false
    authGateway.dataset.state = 'signed-out'
    authGateway.setAttribute('aria-busy', 'false')
    authChecking.hidden = true
    signInForm.hidden = false
    document.documentElement.dataset.authState = 'signed-out'
    document.title = signedOutDocumentTitle
  }

  const showAuthenticatedShell = (): void => {
    sessionCheckOverlay.hidden = true
    authGateway.hidden = true
    authGateway.dataset.state = 'authenticated'
    authGateway.setAttribute('aria-busy', 'false')
    authChecking.hidden = true
    signInForm.hidden = true
    authenticatedShell.hidden = false
    authenticatedShell.inert = false
    authenticatedShell.setAttribute('aria-busy', 'false')
    document.documentElement.dataset.authState = 'authenticated'
    document.title = authenticatedDocumentTitle
  }

  const setSignInPending = (pending: boolean): void => {
    signInSubmit.disabled = pending
    signInSubmit.textContent = pending ? 'Signing in…' : 'Sign in'
    signInForm.setAttribute('aria-busy', String(pending))
    if (!authGateway.hidden) authGateway.dataset.state = pending ? 'signing-in' : 'signed-out'
  }

  const clearFormState = (): void => {
    signInForm.reset()
    commandForm.reset()
    entryForm.reset()
    rowForm.reset()
    rejectionForm.reset()
    withdrawalForm.reset()
    lockPolicyForm.reset()
    manualLockForm.reset()
    invoiceForm.reset()
    configureNoteInput(entryNoteInput, entryNoteHint, 0)
    required<HTMLSelectElement>('[data-row-project]').replaceChildren()
    required<HTMLSelectElement>('[data-row-task]').replaceChildren()
    required<HTMLElement>('[data-command-result]').textContent = ''
    entryResult.textContent = ''
    required<HTMLElement>('[data-row-result]').textContent = ''
    entryTitle.textContent = 'Log time'
    required<HTMLElement>('[data-current-user-id]').textContent = '—'
    required<HTMLElement>('[data-current-profile]').textContent = '—'
    required<HTMLElement>('[data-timer-label]').textContent = 'Timer'
    required<HTMLElement>('[data-timer-elapsed]').textContent = '—'
    required<HTMLElement>('[data-week-total]').textContent = '—'
    required<HTMLElement>('[data-week-grid-rows]').replaceChildren()
    required<HTMLElement>('[data-week-grid-totals]').replaceChildren()
    required<HTMLElement>('[data-day-rows]').replaceChildren()
    invoiceClient.replaceChildren()
    invoiceProjects.replaceChildren()
    invoiceResult.textContent = ''
    invoiceSuccess.hidden = true
    generatedInvoiceLink.hidden = true
    generatedInvoiceLink.href = '/invoices'
    invoiceRetry.hidden = true
    invoiceCatalog = null
    setInvoiceFormPending(false)
    invoiceCommandId = null
    invoiceList.replaceChildren()
    invoiceListStatus.textContent = 'Loading invoices…'
    invoiceLoadMore.hidden = true
    invoiceLoadMore.disabled = false
    invoiceNextCursor = null
    invoiceListRows = []
    invoiceClientNamesLoaded = false
    invoiceListCount = 0
    invoiceFilter = 'outstanding'
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-invoice-filter]')) {
      button.setAttribute('aria-pressed', String(button.dataset.invoiceFilter === 'outstanding'))
    }
    invoiceSearch.value = ''
    invoiceDetailStatus.textContent = 'Loading invoice…'
    invoiceDocument.hidden = true
    timesheetStatus.hidden = true
    timesheetStatusLabel.textContent = 'Not submitted'
    timesheetRejectionReason.hidden = true
    timesheetRejectionReason.textContent = ''
    timesheetResult.textContent = ''
    approvalsPageElement.hidden = !timesheetApprovalsPage
    approvalQueue.replaceChildren()
    approvalHistory.replaceChildren()
    approvalQueueResult.textContent = ''
    rejectionResult.textContent = ''
    withdrawalResult.textContent = ''
    lockPolicyResult.textContent = ''
    lockPolicyPanel.hidden = true
    timesheetLockList.replaceChildren()
    withdrawTimesheet.hidden = true
    unsubmitTimesheet.hidden = true
    approvalModuleAvailable = false
    lockPolicyAvailable = false
    currentSubmission = null
    pendingSubmissions = []
    approvedSubmissions = []
    selectedSubmissionIds = new Set()
    bulkApprovalCommandId = null
    pendingNextCursor = null
    approvedNextCursor = null
    lockPolicy = null
    activeTimesheetLocks = []
    timesheetTransitionPending = false
    lockPolicyTransitionPending = false
    manualLockCommandId = null
    rejectionSubmissionId = null
    withdrawalSubmissionId = null
    activeEntry = null
    supplementalRows = []
    snapshot = null
    grid = null
    cellStates.clear()
    for (const dialog of [
      commandDialog,
      entryDialog,
      menuDialog,
      rowDialog,
      rejectionDialog,
      withdrawalDialog,
    ]) {
      if (dialog.open) dialog.close()
    }
    if (timerInterval !== undefined) {
      globalThis.clearInterval(timerInterval)
      timerInterval = undefined
    }
  }

  const renderSignedOutWeek = (): void => {
    snapshot = null
    grid = null
    cellStates.clear()
    if (timerInterval !== undefined) globalThis.clearInterval(timerInterval)
    required<HTMLButtonElement>('[data-timer-chip]').dataset.state = 'signed-out'
    required<HTMLElement>('[data-timer-label]').textContent = 'Sign in required'
    required<HTMLElement>('[data-timer-elapsed]').textContent = '—'
    weekPeriod.setRange(weekRange(within, weekStartDay))
    required<HTMLElement>('[data-week-total]').textContent = '—'
    const unavailable = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 9
    cell.className = 'grid-empty'
    cell.textContent = 'Sign in to load and edit your week.'
    unavailable.append(cell)
    required<HTMLElement>('[data-week-grid-rows]').replaceChildren(unavailable)
    required<HTMLElement>('[data-week-grid-totals]').replaceChildren()
    const phoneUnavailable = document.createElement('p')
    phoneUnavailable.className = 'day-empty'
    phoneUnavailable.textContent = 'Sign in to load and edit your day.'
    required<HTMLElement>('[data-day-rows]').replaceChildren(phoneUnavailable)
  }

  const renderWeekLoadFailure = (): void => {
    snapshot = null
    grid = null
    cellStates.clear()
    weekPeriod.setRange(weekRange(within, weekStartDay))
    required<HTMLElement>('[data-week-total]').textContent = '—'
    const unavailable = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 9
    cell.className = 'grid-empty'
    cell.textContent = 'Your week could not load. Retry when the connection is available.'
    unavailable.append(cell)
    required<HTMLElement>('[data-week-grid-rows]').replaceChildren(unavailable)
    required<HTMLElement>('[data-week-grid-totals]').replaceChildren()
    const phoneUnavailable = document.createElement('p')
    phoneUnavailable.className = 'day-empty'
    phoneUnavailable.textContent = 'Your day could not load. Retry when the connection is available.'
    required<HTMLElement>('[data-day-rows]').replaceChildren(phoneUnavailable)
  }

  const transitionSignedOut = (
    message = 'Sign in to load and edit your week.',
  ): void => {
    beginAuthGeneration(null)
    // Signing out, or a session that ended, invalidates the cached identity.
    // Account switching through an OAuth provider is cheap, so a survivor here
    // would show the previous user on the next navigation.
    forgetIdentity()
    currentIdentity = null
    signingIn = false
    signingOut = false
    setSignInPending(false)
    logout.disabled = false
    clearFormState()
    authShell.dataset.state = 'signed-out'
    currentIdentityPanel.hidden = true
    required<HTMLElement>('[data-current-user-id]').textContent = '—'
    required<HTMLElement>('[data-current-profile]').textContent = '—'
    signInResult.textContent = message === 'Sign in to load and edit your week.' ? '' : message
    logoutResult.textContent = ''
    setSessionStatus(message, 'signed-out')
    setApplicationAvailability(false)
    showSignedOutScreen()
    renderSignedOutWeek()
    signInEmail.focus()
  }

  const showAuthenticated = (identity: Whoami): AuthOperation => {
    const operation = beginAuthGeneration(identity.user_id)
    clearFormState()
    currentIdentity = identity
    signingIn = false
    signingOut = false
    setSignInPending(false)
    logout.disabled = false
    supplementalRows = loadSupplementalRows(identity.user_id, within, weekStartDay)
    authShell.dataset.state = 'ready'
    signInForm.hidden = true
    currentIdentityPanel.hidden = false
    required<HTMLElement>('[data-current-user-id]').textContent = String(identity.user_id)
    required<HTMLElement>('[data-current-profile]').textContent = profileLabel(identity.profile)
    for (const link of document.querySelectorAll<HTMLElement>('[data-team-nav]')) {
      link.hidden = true
    }
    // Settled on every page, not only the two that show the strip: the company
    // tab is the standing answer to "may this person open company settings",
    // and ⌘K asks it from wherever it is opened.
    revealCompanySettings(identity)
    revealMoneySections(identity)
    revealDirectorySections(identity)
    signInResult.textContent = ''
    logoutResult.textContent = ''
    setApplicationAvailability(true)
    showAuthenticatedShell()
    return operation
  }

  /**
   * The company half is not everyone's, so the tab that leads there only appears
   * for a profile that can open it. A tab you can see and cannot use is worse
   * than one that is not there: it promises a destination and answers 403.
   */
  const revealCompanySettings = (identity: Readonly<Whoami>): void => {
    const visible = identity.profile === 'administrator'
    for (const tab of document.querySelectorAll<HTMLElement>(
      '[data-settings-company-tab], [data-settings-activity-tab]',
    )) {
      tab.hidden = !visible
    }
  }

  /**
   * Invoices and the money on them belong to the three profiles the API grants
   * invoices:read and reports:read -- the same three, and the same three the
   * uninvoiced report's serializer will answer with amounts. A member reaching
   * /invoices is answered 403, so the link is absent rather than present and
   * broken, and the palette and the home screen read this element instead of
   * keeping a second copy of the rule.
   */
  const revealMoneySections = (identity: Readonly<Whoami>): void => {
    const visible = canReadFinancialReports(identity.profile)
    for (const link of document.querySelectorAll<HTMLElement>('[data-money-nav]')) {
      link.hidden = !visible
    }
  }

  /**
   * Projects, Tasks and Clients browse the firm rather than the reader, so a
   * member's nav is the four sections that are their own work: Home, Time,
   * Expenses and Reports. Settled here beside the money gate, on every page
   * rather than on the three it hides, because the palette reads these nav
   * items as its own gate and ⌘K is opened from anywhere.
   *
   * Unlike Invoices, the links it hides do not lead to a 403: the API narrows
   * these collections to the member's assigned work instead of refusing them,
   * which is what keeps their Expenses screen and week grid whole. The nav is
   * saying whose screens these are, not what the server will answer.
   */
  const revealDirectorySections = (identity: Readonly<Whoami>): void => {
    const visible = canBrowseDirectories(identity.profile)
    for (const link of document.querySelectorAll<HTMLElement>('[data-directory-nav]')) {
      link.hidden = !visible
    }
  }

  const renderUserSettings = (identity: Readonly<Whoami>): void => {
    revealCompanySettings(identity)
    const facts = document.querySelector<HTMLElement>('[data-settings-user-facts]')
    const settingsStatus = document.querySelector<HTMLElement>('[data-settings-user-status]')
    if (facts === null || settingsStatus === null) return
    const rows: readonly (readonly [string, string])[] = [
      ['Signed in as', `User #${identity.user_id}`],
      ['Permission profile', profileLabel(identity.profile)],
      [
        'Sign-in method',
        identity.authentication.kind === 'session' ? 'Session' : 'API token',
      ],
    ]
    facts.replaceChildren(
      ...rows.flatMap(([label, value]) => {
        const term = document.createElement('dt')
        term.textContent = label
        const detail = document.createElement('dd')
        detail.textContent = value
        return [term, detail]
      }),
    )
    facts.hidden = false
    settingsStatus.textContent = ''
  }

  const handleSessionFailure = (
    error: unknown,
    operation: AuthOperation,
  ): boolean => {
    if (!isSessionCurrent(operation)) return true
    if (error instanceof EzactoApiError && error.status === 401) {
      transitionSignedOut('Your session ended. Sign in again to continue.')
      signInEmail.focus()
      return true
    }
    return false
  }

  const loadTeamNavigation = async (
    identity: Whoami,
    operation: AuthOperation,
  ): Promise<void> => {
    if (!teamCapabilities(identity).canRead || api.getTeamStatus === undefined) return
    try {
      const status = await api.getTeamStatus(operation.signal)
      if (!isSessionCurrent(operation)) return
      for (const link of document.querySelectorAll<HTMLElement>('[data-team-nav]')) {
        link.hidden = !status.enabled
      }
    } catch (error) {
      handleSessionFailure(error, operation)
    }
  }

  const updateRowTaskOptions = (projectId: number): void => {
    if (snapshot === null) return
    const taskIds = new Set(
      snapshot.catalog.timeEntryOptions
        .filter((option) => option.project_id === projectId)
        .map((option) => option.task_id),
    )
    required<HTMLSelectElement>('[data-row-task]').replaceChildren(
      ...snapshot.catalog.tasks
        .filter((resource) => taskIds.has(resource.id))
        .map((resource) => option(resource.id, resourceLabel(resource))),
    )
  }

  /**
   * The Add-row form offers real selects; the timer and entry dialog took free
   * text, so starting work meant typing the project and task as exact strings.
   * A datalist keeps the free typing the validation depends on and offers the
   * list underneath it.
   */
  const suggestion = (label: string): HTMLOptionElement => {
    const element = document.createElement('option')
    element.value = label
    return element
  }

  const updateEntrySuggestions = (): void => {
    if (snapshot === null) return
    const projectIds = new Set(
      snapshot.catalog.timeEntryOptions.map((entry) => entry.project_id),
    )
    const projects = snapshot.catalog.projects.filter((resource) =>
      projectIds.has(resource.id),
    )
    required<HTMLElement>('[data-entry-project-options]').replaceChildren(
      ...projects.map((resource) => suggestion(resourceLabel(resource))),
    )
    // Tasks narrow to the typed project when it resolves, and otherwise offer
    // every task that is assigned somewhere — better than nothing while the
    // project box is still empty.
    const typed = entryProject.value.trim()
    const matched = projects.find(
      (resource) => resourceLabel(resource).toLowerCase() === typed.toLowerCase(),
    )
    const taskIds = new Set(
      snapshot.catalog.timeEntryOptions
        .filter((entry) => matched === undefined || entry.project_id === matched.id)
        .map((entry) => entry.task_id),
    )
    const available = snapshot.catalog.tasks.filter((resource) => taskIds.has(resource.id))
    required<HTMLElement>('[data-entry-task-options]').replaceChildren(
      ...available.map((resource) => suggestion(resourceLabel(resource))),
    )
    // Narrowing the list underneath is not enough. These are text inputs with a
    // datalist, not selects, so the task box keeps whatever was typed for the
    // previous project: switch project and the old activity is still sitting
    // there, no longer offered and no longer valid. The pair check then refuses
    // the entry with "That project/task combination is not available", which
    // reads as "I picked a different activity and it would not take".
    //
    // Only once the project resolves. While it is still being typed every task
    // looks wrong, and clearing on each keystroke would take the box away from
    // someone who filled it in first. The Add-row form needs none of this: it
    // uses real selects and repopulates them on `change`.
    if (matched !== undefined && entryTask.value.trim() !== '') {
      const held = entryTask.value.trim().toLowerCase()
      if (!available.some((resource) => resourceLabel(resource).toLowerCase() === held)) {
        entryTask.value = ''
      }
    }
  }

  entryProject.addEventListener('input', () => updateEntrySuggestions())

  const updateRowOptions = (): void => {
    if (snapshot === null) return
    const projectIds = new Set(
      snapshot.catalog.timeEntryOptions.map((option) => option.project_id),
    )
    const projects = snapshot.catalog.projects.filter((resource) => projectIds.has(resource.id))
    required<HTMLSelectElement>('[data-row-project]').replaceChildren(
      ...projects.map((resource) => option(resource.id, resourceLabel(resource))),
    )
    updateRowTaskOptions(projects[0]?.id ?? 0)
    updateEntrySuggestions()
  }

  const canReviewTimesheets = (): boolean =>
    currentIdentity?.profile === 'administrator' ||
    currentIdentity?.profile === 'executive_manager' ||
    currentIdentity?.profile === 'project_manager'

  const canManageTimesheetLocks = (): boolean =>
    currentIdentity?.profile === 'administrator' ||
    currentIdentity?.profile === 'executive_manager'

  const renderApprovalNavigation = (): void => {
    const visible =
      (approvalModuleAvailable && canReviewTimesheets()) ||
      (lockPolicyAvailable && canManageTimesheetLocks())
    for (const link of document.querySelectorAll<HTMLElement>('[data-approvals-nav]')) {
      link.hidden = !visible
    }
    approvalsPageElement.hidden = !(timesheetApprovalsPage && visible)
  }

  const renderTimesheetStatus = (): void => {
    timesheetStatus.hidden = !approvalModuleAvailable
    if (!approvalModuleAvailable) return
    const status = currentSubmission?.status ?? 'unsubmitted'
    timesheetStatus.dataset.status = status
    // A week the person took back themselves carries the same three columns a
    // rejection does, so without this it would read as "Changes requested" for
    // a correction nobody asked them to make.
    const selfWithdrawn = isSelfWithdrawn(currentSubmission)
    timesheetStatusLabel.textContent =
      status === 'approved'
        ? 'Approved'
        : status === 'submitted'
          ? 'Submitted for approval'
          : selfWithdrawn ||
              currentSubmission?.rejection_reason === null ||
              currentSubmission?.rejection_reason === undefined
            ? 'Not submitted'
            : 'Changes requested'
    const reason = selfWithdrawn
      ? ''
      : currentSubmission?.rejection_reason?.trim() ?? ''
    timesheetRejectionReason.hidden = reason === ''
    timesheetRejectionReason.textContent = reason === '' ? '' : `Needs changes: ${reason}`
    submitTimesheet.textContent =
      status === 'approved'
        ? 'Approved'
        : status === 'submitted'
          ? 'Awaiting approval'
          : selfWithdrawn ||
              currentSubmission?.rejection_reason === null ||
              currentSubmission?.rejection_reason === undefined
            ? 'Submit week'
            : 'Resubmit week'
    submitTimesheet.disabled =
      timesheetTransitionPending ||
      status !== 'unsubmitted' ||
      snapshot === null ||
      (snapshot.entries.length === 0 && snapshot.expenses.length === 0) ||
      snapshot.entries.some((entry) => entry.is_running)
    withdrawTimesheet.hidden = status !== 'approved' || !canManageTimesheetLocks()
    withdrawTimesheet.disabled = timesheetTransitionPending || withdrawTimesheet.hidden
    // Only while it is still waiting, and only your own -- the week grid shows
    // one person's week, so a submission on screen is the viewer's. An approved
    // week is someone else's decision to undo and keeps the Reopen path.
    unsubmitTimesheet.hidden =
      status !== 'submitted' || api.unsubmitTimesheetSubmission === undefined
    unsubmitTimesheet.disabled = timesheetTransitionPending || unsubmitTimesheet.hidden
  }

  const renderLockPolicy = (): void => {
    const visible =
      timesheetApprovalsPage && lockPolicyAvailable && canManageTimesheetLocks()
    lockPolicyPanel.hidden = !visible
    approvalReviewPanel.hidden = !approvalModuleAvailable
    if (!visible || lockPolicy === null) {
      timesheetLockList.replaceChildren()
      return
    }
    lockPolicyAuto.checked = lockPolicy.auto_lock
    lockPolicyDay.value = lockPolicy.timesheet_deadline?.day ?? 'monday'
    lockPolicyTime.value = lockPolicy.timesheet_deadline?.time ?? '17:00'
    lockPolicyTimezone.value = lockPolicy.timezone
    lockPolicySubmit.disabled = lockPolicyTransitionPending
    manualLockSubmit.disabled = lockPolicyTransitionPending
    if (manualLockThrough.value === '') manualLockThrough.value = localDate()
    if (activeTimesheetLocks.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'approval-empty'
      empty.textContent = 'No active manual or deadline locks.'
      timesheetLockList.replaceChildren(empty)
      return
    }
    timesheetLockList.replaceChildren(
      ...activeTimesheetLocks.map((lock) => {
        const card = document.createElement('article')
        card.className = 'timesheet-lock-card'
        card.dataset.lockId = String(lock.id)
        const summary = document.createElement('div')
        const title = document.createElement('strong')
        title.textContent = lock.kind === 'manual' ? 'Manual cutoff' : 'Weekly deadline'
        const period = document.createElement('p')
        period.textContent =
          lock.period_start === null
            ? `All tracked work through ${dayLabel(lock.period_end, true)}`
            : `${dayLabel(lock.period_start, true)} – ${dayLabel(lock.period_end, true)}`
        const detail = document.createElement('p')
        detail.textContent = lock.reason
        summary.append(title, period, detail)
        const label = document.createElement('label')
        label.textContent = 'Unlock reason'
        const reason = document.createElement('input')
        reason.type = 'text'
        reason.maxLength = 10_000
        reason.required = true
        reason.dataset.lockUnlockReason = String(lock.id)
        label.append(reason)
        const unlock = document.createElement('button')
        unlock.type = 'button'
        unlock.textContent = 'Unlock'
        unlock.disabled = lockPolicyTransitionPending
        unlock.addEventListener('click', () => void unlockTimesheetWindow(lock.id, reason))
        card.append(summary, label, unlock)
        return card
      }),
    )
  }

  /**
   * The count is the whole point of this bar: bulk approval is all-or-none and
   * irreversible without an administrator, so the approver confirms a number
   * they can check against the rows they ticked before anything is sent.
   */
  const renderBulkApprovalBar = (): HTMLElement => {
    const bar = document.createElement('div')
    bar.className = 'approval-bulk'
    bar.dataset.approvalBulk = 'true'
    const count = document.createElement('p')
    count.className = 'approval-bulk-count'
    count.dataset.approvalBulkCount = String(selectedSubmissionIds.size)
    count.textContent =
      selectedSubmissionIds.size === 0
        ? 'No timesheets selected.'
        : `${selectedSubmissionIds.size} ${selectedSubmissionIds.size === 1 ? 'timesheet' : 'timesheets'} selected.`
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'primary-action'
    confirm.dataset.approvalBulkApprove = 'true'
    confirm.textContent = `Approve ${selectedSubmissionIds.size} selected`
    confirm.disabled = selectedSubmissionIds.size === 0 || timesheetTransitionPending
    confirm.addEventListener('click', () => void bulkApproveSelection())
    bar.append(count, confirm)
    return bar
  }

  // Ticking a box only changes the bar. Re-rendering the whole queue would
  // rebuild the checkbox that fired the event and take the focus with it,
  // which makes the list unusable from the keyboard.
  const refreshBulkApprovalBar = (): void => {
    approvalQueue.querySelector('[data-approval-bulk]')?.replaceWith(renderBulkApprovalBar())
  }

  const renderApprovalQueue = (): void => {
    renderApprovalNavigation()
    if (!timesheetApprovalsPage || !approvalModuleAvailable || !canReviewTimesheets()) {
      approvalQueue.replaceChildren()
      approvalHistory.replaceChildren()
      return
    }
    // A selection only ever means rows the approver can see on this filtered
    // page. Anything the queue no longer shows was approved, rejected, or
    // filtered away, and confirming it would approve work nobody looked at.
    selectedSubmissionIds = new Set(
      pendingSubmissions
        .filter((submission) => selectedSubmissionIds.has(submission.id))
        .map((submission) => submission.id),
    )
    if (pendingSubmissions.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'approval-empty'
      empty.textContent = 'No timesheets are waiting for review.'
      approvalQueue.replaceChildren(empty)
    } else {
      approvalQueue.replaceChildren(
        renderBulkApprovalBar(),
        ...pendingSubmissions.map((submission) => {
        const card = document.createElement('article')
        card.className = 'approval-card'
        card.dataset.submissionId = String(submission.id)
        const summary = document.createElement('div')
        const title = document.createElement('h2')
        title.textContent = submission.user_name
        const period = document.createElement('p')
        period.textContent = `${dayLabel(submission.period_start, true)} – ${dayLabel(submission.period_end, true)}`
        const totals = document.createElement('p')
        totals.className = 'approval-totals'
        const totalParts = [
          ...(submission.entry_count === 0
            ? []
            : [`${formatSeconds(submission.total_seconds)} · ${submission.entry_count} ${submission.entry_count === 1 ? 'time entry' : 'time entries'}`]),
          ...(submission.expense_count === 0
            ? []
            : [`${submission.expense_count} ${submission.expense_count === 1 ? 'expense' : 'expenses'}`]),
        ]
        totals.textContent = totalParts.join(' · ')
        const entries = document.createElement('ul')
        entries.className = 'approval-entry-list'
        entries.replaceChildren(
          ...submission.entries.map((entry) => {
            const item = document.createElement('li')
            const entryHeader = document.createElement('div')
            entryHeader.className = 'approval-entry-header'
            const identity = document.createElement('strong')
            identity.textContent = `${entry.project_name} / ${entry.task_name}`
            const duration = document.createElement('span')
            duration.textContent = `${dayLabel(entry.spent_date, true)} · ${formatSeconds(entry.seconds)}`
            entryHeader.append(identity, duration)
            const note = document.createElement('p')
            note.className = 'approval-entry-note'
            note.textContent = entry.notes?.trim() || 'No note'
            if (entry.notes === null || entry.notes.trim() === '') note.dataset.empty = 'true'
            item.append(entryHeader, note)
            return item
          }),
        )
        const expenses = document.createElement('ul')
        expenses.className = 'approval-entry-list approval-expense-list'
        expenses.replaceChildren(
          ...submission.expenses.map((expense) => {
            const item = document.createElement('li')
            const expenseHeader = document.createElement('div')
            expenseHeader.className = 'approval-entry-header'
            const identity = document.createElement('strong')
            identity.textContent = `${expense.project_name} / ${expense.expense_category_name}`
            const amount = document.createElement('span')
            // The date and the figure share a line, so only the figure carries
            // the marker: masking the whole span would take the day with it.
            amount.append(
              `${dayLabel(expense.spent_date, true)} · `,
              moneyText(formatMoney(expense.total_cost_cents, expense.currency)),
            )
            expenseHeader.append(identity, amount)
            const note = document.createElement('p')
            note.className = 'approval-entry-note'
            note.textContent = expense.notes?.trim() || 'No note'
            if (expense.notes === null || expense.notes.trim() === '') note.dataset.empty = 'true'
            item.append(expenseHeader, note)
            return item
          }),
        )
        const select = document.createElement('input')
        select.type = 'checkbox'
        select.className = 'approval-select'
        select.dataset.approvalSelect = String(submission.id)
        select.checked = selectedSubmissionIds.has(submission.id)
        select.disabled = timesheetTransitionPending
        select.setAttribute(
          'aria-label',
          `Select ${submission.user_name} for bulk approval`,
        )
        select.addEventListener('change', () => {
          const next = new Set(selectedSubmissionIds)
          if (select.checked) next.add(submission.id)
          else next.delete(submission.id)
          selectedSubmissionIds = next
          refreshBulkApprovalBar()
        })
        summary.append(title, period, totals, entries, expenses)
        const actions = document.createElement('div')
        actions.className = 'approval-actions'
        actions.append(select)
        const approve = document.createElement('button')
        approve.type = 'button'
        approve.className = 'primary-action'
        approve.textContent = 'Approve'
        approve.disabled = timesheetTransitionPending
        approve.addEventListener('click', () => void reviewTimesheet(submission.id))
        const reject = document.createElement('button')
        reject.type = 'button'
        reject.textContent = 'Reject'
        reject.disabled = timesheetTransitionPending
        reject.addEventListener('click', () => openRejection(submission.id))
        actions.append(approve, reject)
        card.append(summary, actions)
        return card
        }),
      )
    }
    if (!canManageTimesheetLocks()) {
      approvalHistory.replaceChildren()
      return
    }
    const heading = document.createElement('h2')
    heading.textContent = 'Recently approved'
    if (approvedSubmissions.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'approval-empty'
      empty.textContent = 'No approved timesheets are available to reopen.'
      approvalHistory.replaceChildren(heading, empty)
      return
    }
    approvalHistory.replaceChildren(
      heading,
      ...approvedSubmissions.map((submission) => {
        const card = document.createElement('article')
        card.className = 'approval-card'
        card.dataset.approvedSubmissionId = String(submission.id)
        const summary = document.createElement('div')
        const title = document.createElement('h3')
        title.textContent = submission.user_name
        const period = document.createElement('p')
        period.textContent = `${dayLabel(submission.period_start, true)} – ${dayLabel(submission.period_end, true)}`
        const totals = document.createElement('p')
        totals.className = 'approval-totals'
        totals.textContent = `${formatSeconds(submission.total_seconds)} · ${submission.entry_count} time ${submission.expense_count > 0 ? ` · ${submission.expense_count} expenses` : ''}`
        summary.append(title, period, totals)
        const reopen = document.createElement('button')
        reopen.type = 'button'
        reopen.textContent = 'Reopen'
        reopen.disabled = timesheetTransitionPending
        reopen.addEventListener('click', () => openWithdrawal(submission.id))
        card.append(summary, reopen)
        return card
      }),
    )
    approvalLoadMore.hidden = pendingNextCursor === null
    approvalHistoryLoadMore.hidden = approvedNextCursor === null
  }

  const render = (): void => {
    if (snapshot === null) return
    const availableRows = new Set(
      snapshot.catalog.timeEntryOptions.map(
        (candidate) => `${candidate.project_id}:${candidate.task_id}`,
      ),
    )
    supplementalRows = supplementalRows.filter((row) =>
      availableRows.has(`${row.projectId}:${row.taskId}`),
    )
    grid = buildWeekGrid(snapshot, within, supplementalRows)
    // Off the grid's own dates rather than recomputed: a label that disagreed
    // with the columns beneath it is the failure this control exists to end.
    weekPeriod.setRange({ from: grid.dates[0]!, to: grid.dates.at(-1)! })
    required<HTMLElement>('[data-week-total]').textContent = formatSeconds(grid.totalSeconds)
    const handlers: GridHandlers = {
      cellStates,
      organizationMode: snapshot.timeEntrySettings.time_entry_mode,
      organizationTimeFormat: snapshot.timeEntrySettings.time_format,
      commit: commitCell,
      retry: retryCell,
      openEntry,
      ...(api.restartTimeEntry === undefined ? {} : { restart: restartEntry }),
    }
    // The same data the grid draws, laid out on whichever axis the
    // organization's tracking mode makes true.
    calendar.render(grid.dates, snapshot.entries, snapshot.timeEntrySettings.time_entry_mode)
    renderDayTotals(grid, selectedDay, selectDay)
    renderDesktopGrid(grid, handlers)
    renderPhoneDay(grid, selectedDay, handlers)
    renderTimer(snapshot.running)
    updateRowOptions()
    renderApprovalNavigation()
    renderTimesheetStatus()
    renderApprovalQueue()
    renderLockPolicy()
  }

  const loadApprovalData = async (
    operation: AuthOperation,
    requestedWithin: string,
    requestedWeekStartDay: WeekStartDay,
  ): Promise<{
    available: boolean
    current: TimesheetSubmission | null
    pending: readonly TimesheetSubmissionDetail[]
    approved: readonly TimesheetSubmission[]
    pendingCursor: string | null
    approvedCursor: string | null
  }> => {
    if (api.listTimesheetSubmissions === undefined) {
      return { available: false, current: null, pending: [], approved: [], pendingCursor: null, approvedCursor: null }
    }
    const range = weekRange(requestedWithin, requestedWeekStartDay)
    try {
      const own = await api.listTimesheetSubmissions(range.from, range.to, operation.signal)
      const pendingPage =
        timesheetApprovalsPage &&
        canReviewTimesheets() &&
        api.listPendingTimesheetSubmissions !== undefined
          ? await api.listPendingTimesheetSubmissions(approvalQueueFilters, operation.signal)
          : null
      const pendingSummaries = pendingPage?.submissions ?? []
      const getSubmission = api.getTimesheetSubmission
      const approvedPage =
        timesheetApprovalsPage &&
        canManageTimesheetLocks() &&
        api.listApprovedTimesheetSubmissions !== undefined
          ? await api.listApprovedTimesheetSubmissions(
              shiftDate(localDate(), -90),
              approvalQueueFilters,
              operation.signal,
            )
          : null
      const pending =
        getSubmission === undefined
          ? []
          : await hydratePendingTimesheetDetails(
              pendingSummaries,
              getSubmission,
              operation.signal,
            )
      return {
        available: true,
        current:
          own.find(
            (submission) =>
              submission.period_start === range.from && submission.period_end === range.to,
          ) ?? null,
        pending,
        approved: approvedPage?.submissions ?? [],
        pendingCursor: pendingPage?.nextCursor ?? null,
        approvedCursor: approvedPage?.nextCursor ?? null,
      }
    } catch (error) {
      if (error instanceof EzactoApiError && error.status === 404) {
        return { available: false, current: null, pending: [], approved: [], pendingCursor: null, approvedCursor: null }
      }
      throw error
    }
  }

  const loadLockPolicyData = async (
    operation: AuthOperation,
  ): Promise<{
    available: boolean
    policy: TimesheetLockPolicy | null
    locks: readonly TimesheetLockWindow[]
  }> => {
    if (!canManageTimesheetLocks() || api.getTimesheetLockPolicy === undefined) {
      return { available: false, policy: null, locks: [] }
    }
    try {
      const [policy, locks] = await Promise.all([
        api.getTimesheetLockPolicy(operation.signal),
        timesheetApprovalsPage && api.listTimesheetLocks !== undefined
          ? api.listTimesheetLocks(operation.signal)
          : Promise.resolve([]),
      ])
      return { available: true, policy, locks }
    } catch (error) {
      if (
        error instanceof EzactoApiError &&
        (error.status === 403 || error.status === 404)
      ) {
        return { available: false, policy: null, locks: [] }
      }
      throw error
    }
  }

  const restartEntry = async (entryId: number): Promise<void> => {
    const operation = sessionOperation()
    const restart = api.restartTimeEntry
    if (operation === null || restart === undefined) return
    try {
      await restart(entryId, operation.signal)
      if (!isSessionCurrent(operation)) return
      await refresh(operation)
    } catch (error: unknown) {
      if (handleSessionFailure(error, operation)) return
      status.textContent = messageFor(error)
    }
  }

  const refresh = async (
    operation: AuthOperation,
    focus: FocusTarget | undefined = focusedCell(),
  ): Promise<boolean> => {
    const requestedWithin = within
    const selectedDate =
      grid?.dates[selectedDay] ?? weekDates(requestedWithin, weekStartDay)[selectedDay]
    const loaded = await loadShellSnapshot(
      api,
      new Date(`${requestedWithin}T12:00:00`),
      operation.signal,
    )
    const loadedWeekStartDay = loaded.timeEntrySettings.week_start_day
    const [approval, policy] = await Promise.all([
      loadApprovalData(operation, requestedWithin, loadedWeekStartDay),
      loadLockPolicyData(operation),
    ])
    if (!isSessionCurrent(operation) || within !== requestedWithin) return false
    weekStartDay = loadedWeekStartDay
    weekPeriod.setWeekStartDay(loadedWeekStartDay)
    // The generation wizard offers Week too, and was computing Monday-Sunday
    // regardless of the setting -- so on a Saturday-start organisation a draft
    // claimed work across two of its weeks, and the wizard's own label
    // disagreed with what the timesheet called the same week.
    invoicePeriod.setWeekStartDay(loadedWeekStartDay)
    snapshot = loaded
    // Publish before anything renders: the week total, approval cards and the
    // running-timer elapsed all format seconds, and all of them run ahead of
    // the grid render where this used to be set.
    setActiveTimeFormat(loaded.timeEntrySettings.time_format)
    supplementalRows = loadSupplementalRows(operation.userId!, within, weekStartDay)
    const loadedDates = weekDates(within, weekStartDay)
    const preservedIndex = selectedDate === undefined ? -1 : loadedDates.indexOf(selectedDate)
    selectedDay = preservedIndex >= 0 ? preservedIndex : Math.max(0, loadedDates.indexOf(localDate()))
    approvalModuleAvailable = approval.available
    currentSubmission = approval.current
    pendingSubmissions = approval.pending
    approvedSubmissions = approval.approved
    pendingNextCursor = approval.pendingCursor
    approvedNextCursor = approval.approvedCursor
    lockPolicyAvailable = policy.available
    lockPolicy = policy.policy
    activeTimesheetLocks = policy.locks
    render()
    focusCell(focus)
    return true
  }

  const loadWeek = async (operation: AuthOperation): Promise<void> => {
    if (!isSessionCurrent(operation)) return
    setSessionStatus('Loading your week…', 'loading')
    try {
      if (!(await refresh(operation))) return
      setSessionStatus(`Connected. Changes save directly to ${brandName}.`, 'ready')
    } catch (error) {
      if (handleSessionFailure(error, operation)) return
      renderWeekLoadFailure()
      setSessionStatus(
        'Signed in, but your week could not load. Check the connection and retry.',
        'error',
        true,
      )
    }
  }

  const renderInvoiceProjects = (): void => {
    if (invoiceCatalog === null) return
    const clientId = Number(invoiceClient.value)
    const projects = invoiceCatalog.projects.filter((project) => {
      const value = project['client_id'] ?? project['clientId']
      return typeof value === 'number' && value === clientId
    })
    if (projects.length === 0) {
      const empty = document.createElement('p')
      empty.textContent = 'This client has no active projects.'
      invoiceProjects.replaceChildren(empty)
      return
    }
    invoiceProjects.replaceChildren(
      ...projects.map((project) => {
        const label = document.createElement('label')
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.name = 'project'
        input.value = String(project.id)
        input.checked = true
        label.append(input, document.createTextNode(resourceLabel(project)))
        return label
      }),
    )
  }

  const publishInvoiceClientNames = (
    clients: readonly Record<string, unknown>[],
  ): void => {
    setInvoiceClientNames(
      clients.flatMap((client) =>
        typeof client.id === 'number' ? [[client.id, resourceLabel(client)] as const] : [],
      ),
    )
    invoiceClientNamesLoaded = true
  }

  // The invoice list and the invoice page both show a client, and either can be
  // the first thing a session opens. Load the names once, for whichever gets
  // there first.
  const ensureInvoiceClientNames = async (operation: AuthOperation): Promise<void> => {
    // listClients is filtered to is_active; an invoice outlives its client, and
    // the historical ones the list mostly shows are exactly those whose client
    // has since been archived. Those fell back to "Client #12" — the bug this
    // was meant to fix. listDirectoryClients is the unfiltered one.
    const listClients = api.listDirectoryClients ?? api.listClients
    if (invoiceClientNamesLoaded || listClients === undefined) return
    try {
      const clients = await collectResources(listClients, operation.signal)
      if (!isSessionCurrent(operation)) return
      publishInvoiceClientNames(clients)
    } catch {
      // A name is a nicety; the list still reads without it.
    }
  }

  const loadInvoiceGeneration = async (operation: AuthOperation): Promise<void> => {
    if (!isSessionCurrent(operation)) return
    if (api.listClients === undefined || api.generateInvoice === undefined) {
      invoiceResult.textContent = 'Invoice generation is unavailable in this build.'
      invoiceSubmit.disabled = true
      return
    }
    setInvoiceFormPending(true)
    invoiceRetry.hidden = true
    invoiceResult.textContent = 'Loading clients and projects…'
    try {
      const [clients, projects] = await Promise.all([
        collectResources(api.listClients, operation.signal),
        collectResources(api.listProjects, operation.signal),
      ])
      if (!isSessionCurrent(operation)) return
      invoiceCatalog = { clients, projects }
      publishInvoiceClientNames(clients)
      invoiceClient.replaceChildren(
        ...clients.map((client) => option(client.id, resourceLabel(client))),
      )
      // Month-to-date, unchanged: the wizard has always opened on the 1st
      // through today, and the control simply presents that as the custom range
      // it is. Opening on the whole month instead would silently widen every
      // draft invoice generated from the default.
      const today = localDate()
      invoicePeriod.setRange({ from: `${today.slice(0, 8)}01`, to: today })
      renderInvoiceProjects()
      if (clients.length === 0) {
        invoiceResult.textContent = 'Create an active client before generating an invoice.'
        setInvoiceFormPending(false)
        invoiceSubmit.disabled = true
        return
      }
      invoiceResult.textContent = 'Review the selection, then generate a draft.'
      setInvoiceFormPending(false)
    } catch (error) {
      if (handleSessionFailure(error, operation)) return
      invoiceResult.textContent = messageFor(error)
      setInvoiceFormPending(false)
      invoiceSubmit.disabled = true
      invoiceRetry.hidden = false
    }
  }

  /**
   * The rows, then what the search leaves of them. The count in the status line
   * is the number on screen and says which of the two it is: an invoice that has
   * not been loaded yet is not absent from the account, and "load more" is what
   * the reader can do about it.
   */
  const renderInvoiceList = (): void => {
    const searching = invoiceSearch.value.trim() !== ''
    const matching = invoiceListRows.filter((invoice) =>
      invoiceMatchesSearch(invoice, invoiceSearch.value),
    )
    invoiceListCount = renderInvoiceListItems(
      matching,
      searching ? 'No loaded invoices match that search.' : undefined,
    )
    const complete = invoiceNextCursor === null
    invoiceListStatus.textContent = searching
      ? `${invoiceListCount} of ${invoiceListRows.length} loaded ${invoiceListRows.length === 1 ? 'invoice matches' : 'invoices match'}${complete ? '.' : '; load more to search the rest.'}`
      : invoiceListCount === 0
        ? 'No invoices found.'
        : `${invoiceListCount} ${invoiceListCount === 1 ? 'invoice' : 'invoices'} loaded${complete ? '.' : '; more are available.'}`
  }

  const loadInvoiceList = async (
    operation: AuthOperation,
    cursor?: string,
  ): Promise<void> => {
    if (!isSessionCurrent(operation) || !invoiceListPage) return
    if (currentIdentity === null || !invoiceIdentityCanRead(currentIdentity)) {
      invoiceListStatus.textContent =
        currentIdentity?.authentication.kind === 'token'
          ? 'This API token does not grant invoice read access.'
          : 'Your profile does not have access to invoices.'
      invoiceList.replaceChildren()
      invoiceLoadMore.hidden = true
      return
    }
    const listInvoices = api.listInvoices
    if (listInvoices === undefined) {
      invoiceListStatus.textContent = 'Invoice browsing is unavailable in this build.'
      invoiceLoadMore.hidden = true
      return
    }
    const append = cursor !== undefined
    invoiceList.setAttribute('aria-busy', 'true')
    invoiceLoadMore.disabled = true
    invoiceListStatus.textContent = append ? 'Loading more invoices…' : 'Loading invoices…'
    try {
      const [page] = await Promise.all([
        listInvoices(cursor, operation.signal, undefined, invoiceStatesFor(invoiceFilter)),
        ensureInvoiceClientNames(operation),
      ])
      if (!isSessionCurrent(operation)) return
      invoiceListRows = append ? [...invoiceListRows, ...page.data] : [...page.data]
      invoiceNextCursor = page.page.next_cursor
      invoiceLoadMore.hidden = invoiceNextCursor === null
      renderInvoiceList()
    } catch (error) {
      if (handleSessionFailure(error, operation)) return
      invoiceListStatus.textContent = messageFor(error)
      invoiceLoadMore.hidden = invoiceNextCursor === null
    } finally {
      if (isSessionCurrent(operation)) {
        invoiceList.removeAttribute('aria-busy')
        invoiceLoadMore.disabled = false
      }
    }
  }

  const loadAuthenticatedShell = async (
    operation: AuthOperation,
  ): Promise<void> => {
    // Paint from the last known identity when there is one, and confirm it
    // against the server without blocking; otherwise whoami is the gate, as
    // before (issue 263).
    const cached = readCachedIdentity()
    const identity = cached ?? (await api.whoami(operation.signal))
    if (!isGenerationCurrent(operation)) return
    rememberIdentity(identity)
    const authenticated = showAuthenticated(identity)
    if (cached !== undefined) {
      // Nothing is granted on the cache's say-so: every protected load below is
      // authorized by the worker against the real cookie regardless of what was
      // painted, so a stale cache can only be briefly wrong on screen.
      void api
        .whoami(authenticated.signal)
        .then((fresh) => {
          if (!isGenerationCurrent(operation)) return
          rememberIdentity(fresh)
          if (
            fresh.user_id !== identity.user_id ||
            fresh.profile !== identity.profile
          ) {
            // A different or re-scoped user. Everything already painted belongs
            // to the wrong identity, so take the server's rendering of the page
            // rather than trying to mutate this one into shape.
            location.reload()
          }
        })
        .catch((error: unknown) => {
          handleSessionFailure(error, authenticated)
        })
    }
    void loadTeamNavigation(identity, authenticated)
    if (invoiceGenerationPage) {
      await Promise.all([loadInvoiceGeneration(authenticated), loadWeek(authenticated)])
    } else if (invoiceListPage) {
      await Promise.all([loadInvoiceList(authenticated), loadWeek(authenticated)])
    } else if (invoiceDetailPage) {
      await Promise.all([
        ensureInvoiceClientNames(authenticated),
        invoicePayments.activate(
          identity,
          authenticated.signal,
          (error) => handleSessionFailure(error, authenticated),
        ),
        loadWeek(authenticated),
      ])
    } else if (clientListPage || clientDetailPage) {
      await Promise.all([
        clientDirectory.activate(
          identity,
          authenticated.signal,
          (error) => handleSessionFailure(error, authenticated),
        ),
        loadWeek(authenticated),
      ])
    } else if (projectListPage || projectDetailPage) {
      await Promise.all([
        projectDirectory.activate(
          identity,
          authenticated.signal,
          (error) => handleSessionFailure(error, authenticated),
        ),
        loadWeek(authenticated),
      ])
    } else if (taskListPage) {
      await Promise.all([
        taskAdmin.activate(
          identity,
          authenticated.signal,
          (error) => handleSessionFailure(error, authenticated),
        ),
        loadWeek(authenticated),
      ])
    } else if (teamListPage || teamPersonPage) {
      await Promise.all([
        teamDirectory.activate(
          identity,
          authenticated.signal,
          (error) => handleSessionFailure(error, authenticated),
        ),
        loadWeek(authenticated),
      ])
    } else if (dashboardPage) {
      await Promise.all([
        dashboard.activate(
          identity,
          authenticated.signal,
          (error) => handleSessionFailure(error, authenticated),
        ),
        loadWeek(authenticated),
      ])
    } else if (document.querySelector('[data-activity-log-page]:not([hidden])') !== null) {
      await Promise.all([activity.activate(authenticated.signal), loadWeek(authenticated)])
    } else if (reportsPage) {
      await Promise.all([
        reports.activate(
          identity,
          authenticated.signal,
          (error) => handleSessionFailure(error, authenticated),
        ),
        loadWeek(authenticated),
      ])
    } else if (expenseListPage || expenseDetailPage) {
      await Promise.all([
        expenseWorkflow.activate(
          identity,
          authenticated.signal,
          (error) => handleSessionFailure(error, authenticated),
        ),
        loadWeek(authenticated),
      ])
    } else if (expenseCategoriesPage) {
      await Promise.all([
        expenseCategories.activate(
          identity,
          authenticated.signal,
          (error) => handleSessionFailure(error, authenticated),
        ),
        loadWeek(authenticated),
      ])
    } else if (invoiceConfigurePage) {
      await Promise.all([
        emailConfiguration.activate(
          identity,
          authenticated.signal,
          (error) => handleSessionFailure(error, authenticated),
        ),
        loadWeek(authenticated),
      ])
    } else if (invoiceRecurringPage) {
      await Promise.all([
        recurringWorkspace.activate(
          identity,
          authenticated.signal,
          (error) => handleSessionFailure(error, authenticated),
        ),
        loadWeek(authenticated),
      ])
    } else if (invoiceRetainersPage) {
      await Promise.all([
        retainerWorkspace.activate(
          identity,
          authenticated.signal,
          (error) => handleSessionFailure(error, authenticated),
        ),
        loadWeek(authenticated),
      ])
    } else if (moduleSettingsPage) {
      revealCompanySettings(identity)
      await Promise.all([
        moduleSettings.activate(
          identity,
          authenticated.signal,
          (error) => handleSessionFailure(error, authenticated),
        ),
        loadWeek(authenticated),
      ])
    } else if (settingsUserPage) {
      renderUserSettings(identity)
      await loadWeek(authenticated)
    } else {
      await loadWeek(authenticated)
    }
  }

  async function reviewTimesheet(submissionId: number): Promise<void> {
    const operation = sessionOperation()
    if (
      operation === null ||
      timesheetTransitionPending ||
      api.approveTimesheetSubmission === undefined
    ) {
      return
    }
    timesheetTransitionPending = true
    approvalQueueResult.textContent = 'Approving timesheet…'
    renderApprovalQueue()
    try {
      await api.approveTimesheetSubmission(submissionId, operation.signal)
      if (!(await refresh(operation))) return
      approvalQueueResult.textContent = 'Timesheet approved and its entries are now locked.'
    } catch (error) {
      if (handleSessionFailure(error, operation)) return
      approvalQueueResult.textContent = messageFor(error)
    } finally {
      if (isSessionCurrent(operation)) {
        timesheetTransitionPending = false
        renderApprovalQueue()
      }
    }
  }

  /**
   * Reads the selections the server refused out of its field errors, so a
   * failed batch leaves exactly those rows ticked. Dropping them would make the
   * approver rebuild a selection whose good half was never in doubt.
   */
  const refusedSelections = (
    error: unknown,
    selections: readonly { id: number }[],
  ): number[] => {
    if (!(error instanceof EzactoApiError)) return []
    if (typeof error.body !== 'object' || error.body === null) return []
    const detail = Reflect.get(error.body, 'error')
    if (typeof detail !== 'object' || detail === null) return []
    const fields = Reflect.get(detail, 'fields')
    if (!Array.isArray(fields)) return []
    return fields.flatMap((field): number[] => {
      if (typeof field !== 'object' || field === null) return []
      const path = Reflect.get(field, 'field')
      const matched = typeof path === 'string' ? /^submissions\[(\d+)\]\.id$/u.exec(path) : null
      const selection = matched === null ? undefined : selections[Number(matched[1])]
      return selection === undefined ? [] : [selection.id]
    })
  }

  async function bulkApproveSelection(): Promise<void> {
    const operation = sessionOperation()
    const selections = pendingSubmissions
      .filter((submission) => selectedSubmissionIds.has(submission.id))
      .map((submission) => ({ id: submission.id, expected_version: submission.version }))
    if (
      operation === null ||
      timesheetTransitionPending ||
      selections.length === 0 ||
      api.bulkApproveTimesheetSubmissions === undefined
    ) {
      return
    }
    timesheetTransitionPending = true
    bulkApprovalCommandId ??= `web.timesheet.bulk-approve:${crypto.randomUUID()}`
    const commandId = bulkApprovalCommandId
    approvalQueueResult.textContent = `Approving ${selections.length} timesheets…`
    renderApprovalQueue()
    try {
      await api.bulkApproveTimesheetSubmissions(commandId, { submissions: selections }, operation.signal)
      bulkApprovalCommandId = null
      selectedSubmissionIds = new Set()
      if (!(await refresh(operation))) return
      approvalQueueResult.textContent = `${selections.length} ${selections.length === 1 ? 'timesheet is' : 'timesheets are'} approved and their entries are now locked.`
    } catch (error) {
      if (handleSessionFailure(error, operation)) return
      const refused = refusedSelections(error, selections)
      if (refused.length > 0) selectedSubmissionIds = new Set(refused)
      approvalQueueResult.textContent =
        refused.length === 0
          ? messageFor(error)
          : `${messageFor(error)} Nothing was approved; ${refused.length} ${refused.length === 1 ? 'selection stays' : 'selections stay'} ticked for another try.`
    } finally {
      if (isSessionCurrent(operation)) {
        timesheetTransitionPending = false
        renderApprovalQueue()
      }
    }
  }

  function openRejection(submissionId: number): void {
    if (timesheetTransitionPending) return
    rejectionSubmissionId = submissionId
    rejectionForm.reset()
    rejectionResult.textContent = ''
    open(rejectionDialog)
    rejectionReason.focus()
  }

  async function unlockTimesheetWindow(
    lockId: number,
    reasonInput: HTMLInputElement,
  ): Promise<void> {
    const operation = sessionOperation()
    const reason = reasonInput.value.trim()
    if (reason === '') {
      lockPolicyResult.textContent = 'Enter a reason before unlocking this period.'
      reasonInput.focus()
      return
    }
    if (
      operation === null ||
      lockPolicyTransitionPending ||
      api.unlockTimesheetLock === undefined
    ) {
      return
    }
    lockPolicyTransitionPending = true
    lockPolicyResult.textContent = 'Unlocking tracked work…'
    renderLockPolicy()
    try {
      await api.unlockTimesheetLock(lockId, { reason }, operation.signal)
      if (!(await refresh(operation))) return
      lockPolicyResult.textContent = 'Tracked work unlocked. The reason was added to the audit trail.'
    } catch (error) {
      if (handleSessionFailure(error, operation)) return
      lockPolicyResult.textContent = messageFor(error)
    } finally {
      if (isSessionCurrent(operation)) {
        lockPolicyTransitionPending = false
        renderLockPolicy()
      }
    }
  }

  async function commitCell(
    input: HTMLInputElement,
    cell: WeekGridCell,
    view: GridView,
    focus?: FocusTarget,
  ): Promise<boolean> {
    const operation = sessionOperation()
    if (operation === null) return false
    const current = cellStates.get(cell.key)
    if (current?.state === 'saving') return false
    const rawValue = input.value
    if (rawValue === input.dataset.savedValue && current?.notes === undefined) {
      focusCell(focus)
      return true
    }
    const minimumNoteLength = effectiveMinimumNoteLength(cell, current)
    const pendingNotes = notesForCell(cell, current)
    try {
      if (
        parseCellSeconds(rawValue) > 0 &&
        timeEntryNoteLength(pendingNotes) < minimumNoteLength
      ) {
        cellStates.set(cell.key, {
          state: 'dirty',
          rawValue,
          notes: pendingNotes,
          minimumNoteLength,
        })
        render()
        openEntry(cell, view, noteRequirementMessage(minimumNoteLength))
        return false
      }
    } catch {
      // Duration syntax errors use the normal retry result and retain the input.
    }
    cellStates.set(cell.key, {
      state: 'saving',
      rawValue,
      ...(current?.notes === undefined ? {} : { notes: current.notes }),
      ...(minimumNoteLength === cell.minimumNoteLength
        ? {}
        : { minimumNoteLength }),
    })
    render()
    const result = await saveWeekCellWithRetry(
      api,
      cell,
      rawValue,
      current?.notes,
      operation.signal,
    )
    if (!isSessionCurrent(operation)) return false
    if (result.state === 'retry') {
      if (handleSessionFailure(result.error, operation)) return false
      const changedMinimum = minimumNoteLengthFromError(result.error)
      if (changedMinimum !== null) {
        const currentMinimum = Math.max(minimumNoteLength, changedMinimum)
        cellStates.set(cell.key, {
          state: 'dirty',
          rawValue: result.rawValue,
          notes: pendingNotes,
          minimumNoteLength: currentMinimum,
        })
        render()
        openEntry(
          cell,
          view,
          `The note policy changed. ${noteRequirementMessage(currentMinimum)}`,
        )
        return false
      }
      cellStates.set(cell.key, {
        state: 'retry',
        rawValue: result.rawValue,
        message: result.message,
        retry: result.retry,
        ...(current?.notes === undefined ? {} : { notes: current.notes }),
        ...(minimumNoteLength === cell.minimumNoteLength
          ? {}
          : { minimumNoteLength }),
      })
      render()
      focusCell({ key: cell.key, view })
      return false
    }
    cellStates.set(cell.key, { state: 'saved', rawValue })
    try {
      await refresh(operation, focus)
    } catch (error) {
      handleSessionFailure(error, operation)
      return false
    }
    return true
  }

  async function retryCell(cell: WeekGridCell, view: GridView): Promise<void> {
    const operation = sessionOperation()
    if (operation === null) return
    const failed = cellStates.get(cell.key)
    if (failed?.state !== 'retry' || failed.retry === undefined) return
    cellStates.set(cell.key, { ...failed, state: 'saving' })
    render()
    const result = await failed.retry()
    if (!isSessionCurrent(operation)) return
    if (result.state === 'retry') {
      if (handleSessionFailure(result.error, operation)) return
      const changedMinimum = minimumNoteLengthFromError(result.error)
      if (changedMinimum !== null) {
        const currentMinimum = Math.max(
          effectiveMinimumNoteLength(cell, failed),
          changedMinimum,
        )
        cellStates.set(cell.key, {
          state: 'dirty',
          rawValue: failed.rawValue,
          notes: notesForCell(cell, failed),
          minimumNoteLength: currentMinimum,
        })
        render()
        openEntry(
          cell,
          view,
          `The note policy changed. ${noteRequirementMessage(currentMinimum)}`,
        )
        return
      }
      cellStates.set(cell.key, {
        ...failed,
        state: 'retry',
        message: result.message,
        retry: result.retry,
      })
      render()
      focusCell({ key: cell.key, view })
      return
    }
    cellStates.set(cell.key, { state: 'saved', rawValue: failed.rawValue })
    try {
      await refresh(operation, { key: cell.key, view })
    } catch (error) {
      handleSessionFailure(error, operation)
    }
  }

  const editorResourceId = (
    kind: 'project' | 'task',
    value: string,
    fallback: number,
  ): number | null => {
    if (snapshot === null) return null
    const resources = kind === 'project' ? snapshot.catalog.projects : snapshot.catalog.tasks
    const wanted = value.trim().toLocaleLowerCase('en-US')
    const candidates = (resource: GeneralResource): string[] => [
      String(resource.id),
      ...['name', 'code'].flatMap((field) => {
        const candidate = resource[field]
        return typeof candidate === 'string' && candidate.trim() !== ''
          ? [candidate.trim()]
          : []
      }),
    ]
    const matches = resources.filter((resource) =>
      candidates(resource).some(
        (candidate) => candidate.toLocaleLowerCase('en-US') === wanted,
      ),
    )
    if (matches.length === 1) return matches[0]!.id
    const fallbackResource = resources.find((resource) => resource.id === fallback)
    return fallbackResource !== undefined && candidates(fallbackResource).includes(value.trim())
      ? fallback
      : null
  }

  const configureEntryEditor = (
    next: ActiveEntryEditor,
    message = '',
    durationValue?: string,
  ): void => {
    if (snapshot === null) return
    const initialDurationValue =
      durationValue ?? formatCellHours(next.seconds, snapshot.timeEntrySettings.time_format)
    activeEntry = { ...next, initialDurationValue }
    entryDialog.dataset.entryContext = next.context
    entryContext.textContent =
      next.context === 'timer' ? 'Global timer' : 'Time entry'
    entryTitle.textContent = contextLabel(
      next.context,
      next.entry !== null,
    )
    const project = snapshot.catalog.projects.find((resource) => resource.id === next.projectId)
    const task = snapshot.catalog.tasks.find((resource) => resource.id === next.taskId)
    entryProject.value = project === undefined ? String(next.projectId) : resourceLabel(project)
    entryTask.value = task === undefined ? String(next.taskId) : resourceLabel(task)
    entryDate.value = next.spentDate
    entryDurationInput.value = initialDurationValue
    entryStart.value =
      next.entry?.started_time === null || next.entry?.started_time === undefined
        ? ''
        : formatTimeForClock(next.entry.started_time, snapshot.timeEntrySettings.clock)
    entryEnd.value =
      next.entry?.ended_time === null || next.entry?.ended_time === undefined
        ? ''
        : formatTimeForClock(next.entry.ended_time, snapshot.timeEntrySettings.clock)
    entryStart.placeholder = snapshot.timeEntrySettings.clock === '12h' ? '9:00 AM' : '09:00'
    entryEnd.placeholder = snapshot.timeEntrySettings.clock === '12h' ? '5:00 PM' : '17:00'
    entryNoteInput.value = next.notes ?? ''
    configureNoteInput(entryNoteInput, entryNoteHint, next.minimumNoteLength)
    const running = next.entry?.is_running === true
    entryDuration.hidden = next.mode !== 'duration' || next.timer || running
    entryTimes.hidden = next.mode !== 'start_end' || next.timer || running
    entryRunning.hidden = !running
    const immutable = running || next.entry?.is_locked === true
    for (const field of [
      entryProject,
      entryTask,
      entryDate,
      entryDurationInput,
      entryStart,
      entryEnd,
    ]) field.disabled = immutable
    entryNoteInput.disabled = next.entry?.is_locked === true
    entrySubmit.hidden = next.entry?.is_locked === true
    entrySubmit.textContent = running
      ? 'Save note'
      : next.timer
        ? 'Start timer'
        : next.entry === null
          ? 'Log time'
          : 'Save entry'
    stopTimer.hidden = !running
    entryResult.textContent = message
    open(entryDialog)
    ;(running ||
    (next.minimumNoteLength > 0 && timeEntryNoteLength(next.notes) < next.minimumNoteLength)
      ? entryNoteInput
      : next.mode === 'start_end' && !next.timer
        ? entryStart
        : next.mode === 'duration' && !next.timer
          ? entryDurationInput
          : entryProject
    ).focus()
  }

  function openEntry(
    cell: WeekGridCell,
    view: GridView,
    message = '',
  ): void {
    const state = cellStates.get(cell.key)
    if (
      currentIdentity === null ||
      state?.state === 'saving' ||
      cell.entries.length > 1 ||
      cell.isConflict ||
      cell.isLocked ||
      snapshot === null
    )
      return
    const minimumNoteLength = effectiveMinimumNoteLength(cell, state)
    const entry = cell.entries[0] ?? null
    configureEntryEditor(
      {
        context: view === 'phone' ? 'day' : entry === null ? 'week-cell' : 'edit',
        cell,
        view,
        entry,
        projectId: cell.projectId,
        taskId: cell.taskId,
        spentDate: cell.date,
        seconds: cell.totalSeconds,
        notes: notesForCell(cell, state),
        mode: modeForEntryDraft(entry, snapshot.timeEntrySettings.time_entry_mode),
        timer: false,
        minimumNoteLength,
        durationWasEditedBeforeOpen:
          state?.rawValue !== undefined &&
          state.rawValue !==
            formatCellHours(cell.totalSeconds, snapshot.timeEntrySettings.time_format),
      },
      message,
      state?.rawValue,
    )
  }

  for (const trigger of document.querySelectorAll<HTMLElement>('[data-command-trigger]')) {
    trigger.addEventListener('click', () => {
      if (currentIdentity !== null) openCommandPalette()
    })
  }
  required<HTMLButtonElement>('[data-timer-chip]').addEventListener('click', () => {
    if (currentIdentity === null || snapshot === null) return
    if (snapshot.running !== null) {
      const running = snapshot.running
      configureEntryEditor({
        context: 'timer',
        entry: running,
        projectId: running.project_id,
        taskId: running.task_id,
        spentDate: running.spent_date,
        seconds: running.seconds,
        notes: running.notes ?? null,
        mode: modeForEntryDraft(running, snapshot.timeEntrySettings.time_entry_mode),
        timer: false,
        minimumNoteLength: running.minimum_note_length,
      })
      return
    }
    configureEntryEditor({
      context: 'timer',
      entry: null,
      projectId: snapshot.catalog.timeEntryOptions[0]?.project_id ?? 0,
      taskId: snapshot.catalog.timeEntryOptions[0]?.task_id ?? 0,
      spentDate: localDate(),
      seconds: 0,
      notes: null,
      mode: snapshot.timeEntrySettings.time_entry_mode,
      timer: true,
      minimumNoteLength: snapshot.catalog.timeEntryOptions[0]?.minimum_note_length ?? 0,
    })
  })
  required<HTMLButtonElement>('[data-menu-trigger]').addEventListener('click', () =>
    open(menuDialog),
  )
  required<HTMLButtonElement>('[data-add-row-trigger]').addEventListener('click', () => {
    if (currentIdentity !== null) open(rowDialog)
  })
  for (const close of document.querySelectorAll<HTMLButtonElement>('[data-dialog-close]')) {
    close.addEventListener('click', () => close.closest('dialog')?.close())
  }

  /**
   * Hiding amounts from your own screen. A display preference like density, and
   * emphatically not a permission -- `canViewMoneyField` decided whether these
   * figures were ever sent, and this decides only whether the screen draws the
   * ones it has. Applied before the session resolves so a shell restored with
   * the preference on never paints the amounts first.
   */
  const moneyToggle = required<HTMLButtonElement>('[data-money-toggle]')
  const moneyDisplay = createMoneyDisplayRuntime({
    store: browserMoneyDisplayStore(globalThis.localStorage),
    target: document.documentElement,
  })
  const syncMoneyToggle = (display: MoneyDisplay): void => {
    const hidden = display === 'hidden'
    moneyToggle.setAttribute('aria-pressed', String(hidden))
    // The label says what pressing it does next, not what state it is in: the
    // pressed state is already carried by aria-pressed, and a reader told
    // "Amounts hidden" has been given the state twice and the action never.
    const label = `${hidden ? 'Show' : 'Hide'} money amounts ($)`
    moneyToggle.setAttribute('aria-label', label)
    moneyToggle.title = label
  }
  syncMoneyToggle(moneyDisplay.start())
  moneyToggle.addEventListener('click', () => {
    syncMoneyToggle(moneyDisplay.toggle())
  })

  /**
   * A grid is a keyboard surface. Anything bound here has to survive the fact
   * that the thing under the cursor is usually an input: a bare key would be
   * typed into a cell rather than acted on, so the unmodified bindings check
   * what has focus first, and none of them fire while a dialog is open.
   */
  const typingInAField = (): boolean => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return false
    if (active.isContentEditable) return true
    return (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement
    )
  }

  document.addEventListener('keydown', (event) => {
    if (currentIdentity === null) return
    const modified = event.metaKey || event.ctrlKey
    if (modified && event.key.toLocaleLowerCase('en-US') === 'k') {
      event.preventDefault()
      openCommandPalette()
      return
    }
    // Adding a row is the one action you take mid-typing, so it keeps a
    // modifier and works from inside a cell.
    if (modified && event.key === 'Enter') {
      event.preventDefault()
      open(rowDialog)
      return
    }
    if (event.altKey || modified || typingInAField()) return
    // Bound above the dialog guard, unlike the week keys. The reason to mask is
    // someone walking up, which does not care what is on screen -- and an open
    // invoice dialog is full of the figures this exists to put away. Shift is
    // already in the chord on a US keyboard; `event.key` is the character the
    // layout produced, so a layout that puts `$` elsewhere still works.
    if (event.key === '$') {
      event.preventDefault()
      syncMoneyToggle(moneyDisplay.toggle())
      return
    }
    if (document.querySelector('dialog[open]') !== null) return
    if (event.key === '[') {
      event.preventDefault()
      moveWeek(-7)
      return
    }
    if (event.key === ']') {
      event.preventDefault()
      moveWeek(7)
    }
  })

  /**
   * A destination is offered only when the element the nav already gates it
   * behind is present and showing. Reading that element rather than the profile
   * keeps one rule in one place: the moment module state or a permission hides
   * the Approvals link, the palette stops offering Approvals with it.
   */
  const paletteOffers = (destination: PaletteDestination): boolean => {
    if (destination.gate === undefined) return true
    const gate = document.querySelector<HTMLElement>(destination.gate)
    return gate !== null && !gate.hidden
  }

  let paletteOptions: readonly PaletteResult[] = []
  let paletteIndex = -1
  let paletteEntities: readonly PaletteEntity[] = []
  // The query the current `paletteEntities` answer. A reply that arrives after
  // the person has typed on is for a question they are no longer asking, and
  // showing it would put the wrong rows under the right word.
  let paletteEntityQuery = ''
  let paletteSearch: AbortController | null = null

  const paletteOptionId = (index: number): string => `ez-command-option-${index}`

  /**
   * Record hits come from the server, one small page per resource. Runs behind
   * the render rather than in front of it: the commands are local and must not
   * wait on a network round trip to appear.
   */
  const refreshPaletteEntities = (query: string): void => {
    const wanted = query.trim()
    if (api.searchEntities === undefined || wanted.length < 2) {
      // One character matches too much to be worth a request, and clearing here
      // is what stops a stale set outliving the query that fetched it.
      paletteSearch?.abort()
      paletteSearch = null
      if (paletteEntities.length > 0) {
        paletteEntities = []
        paletteEntityQuery = ''
        renderPalette()
      }
      return
    }
    if (wanted === paletteEntityQuery) return
    paletteSearch?.abort()
    const controller = new AbortController()
    paletteSearch = controller
    void api
      .searchEntities(wanted, controller.signal)
      .then((found) => {
        if (controller.signal.aborted) return
        paletteEntities = found
        paletteEntityQuery = wanted
        renderPalette()
      })
      .catch(() => {
        // A palette that cannot reach the server still navigates. Failing loud
        // here would replace a working command list with an error.
      })
  }

  const renderPalette = (): void => {
    const query = commandInput.value
    const sections = palettePlan(
      query,
      paletteOffers,
      // Only the hits for this exact query. Anything else is an older answer.
      query.trim() === paletteEntityQuery ? paletteEntities : [],
    )
    paletteOptions = sections.flatMap((section) => section.destinations)
    // Nothing is highlighted until the query says something. Enter on an
    // unhighlighted palette belongs to the form, which is what leaves
    // `log 2h project task` -- a query that matches no destination -- reaching
    // the quick-add parser exactly as it did before.
    paletteIndex =
      query.trim() === '' || paletteOptions.length === 0
        ? -1
        : Math.min(Math.max(paletteIndex, 0), paletteOptions.length - 1)
    let index = 0
    const groups = sections.map((section) => {
      const group = document.createElement('div')
      group.className = 'command-group'
      group.setAttribute('role', 'group')
      group.setAttribute('aria-label', section.group)
      const heading = document.createElement('p')
      heading.className = 'eyebrow'
      heading.textContent = section.group
      group.append(heading)
      for (const destination of section.destinations) {
        const option = document.createElement('a')
        option.id = paletteOptionId(index)
        option.className = 'command-option'
        option.href = destination.href
        option.textContent = destination.label
        option.setAttribute('role', 'option')
        option.setAttribute('aria-selected', String(index === paletteIndex))
        option.dataset.commandOption = destination.href
        group.append(option)
        index += 1
      }
      return group
    })
    if (paletteOptions.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'command-empty'
      empty.dataset.commandEmpty = 'true'
      empty.textContent = 'No destination matches that.'
      commandResults.replaceChildren(empty)
    } else {
      commandResults.replaceChildren(...groups)
    }
    if (paletteIndex === -1) {
      commandInput.removeAttribute('aria-activedescendant')
    } else {
      commandInput.setAttribute('aria-activedescendant', paletteOptionId(paletteIndex))
    }
  }

  const openCommandPalette = (): void => {
    open(commandDialog)
    renderPalette()
  }

  const movePaletteHighlight = (step: number): void => {
    if (paletteOptions.length === 0) return
    paletteIndex =
      paletteIndex === -1
        ? step > 0
          ? 0
          : paletteOptions.length - 1
        : (paletteIndex + step + paletteOptions.length) % paletteOptions.length
    renderPalette()
  }

  commandInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      movePaletteHighlight(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key !== 'Enter') return
    // Shift+Enter logs time against what was typed instead of going anywhere.
    // The default is deliberately the unsurprising one: this control gets used
    // blind, and a key that navigates sometimes and starts an entry other times
    // -- depending on what the highlighted row happens to be -- is the kind of
    // ambiguity you cannot recover from without looking. So the faster daily
    // action is a modifier away rather than a guess.
    if (event.shiftKey) {
      event.preventDefault()
      const typed = new FormData(commandForm).get('command')
      if (typeof typed === 'string' && typed.trim() !== '') quickAddFromCommand(typed)
      return
    }
    const highlighted = paletteOptions[paletteIndex]
    if (highlighted === undefined) return
    event.preventDefault()
    globalThis.location.assign(highlighted.href)
  })

  /**
   * Turn what was typed into a draft time entry. Reached two ways: submitting
   * the command form when the text is not a destination, and Shift+Enter, which
   * asks for this outright rather than letting the text decide.
   */
  const quickAddFromCommand = (command: string): void => {
    const operation = sessionOperation()
    if (operation === null) return
    const result = required<HTMLElement>('[data-command-result]')
    result.textContent = 'Preparing entry…'
    void prepareQuickAdd(api, command, new Date(), operation.signal)
      .then((draft) => {
        if (!isSessionCurrent(operation) || snapshot === null) return
        commandDialog.close()
        configureEntryEditor({
          context: 'quick-add',
          entry: null,
          projectId: draft.input.project_id,
          taskId: draft.input.task_id,
          spentDate: draft.input.spent_date ?? localDate(),
          seconds: draft.input.seconds ?? 0,
          notes: draft.input.notes ?? null,
          mode: snapshot.timeEntrySettings.time_entry_mode,
          timer: false,
          minimumNoteLength: draft.minimumNoteLength,
        })
        result.textContent = ''
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        const minimumNoteLength = requiredMinimumFromError(error)
        result.textContent =
          minimumNoteLength === null
            ? messageFor(error)
            : `${noteRequirementMessage(minimumNoteLength)} Add it after the task name.`
      })
  }

  commandForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const command = new FormData(commandForm).get('command')
    if (typeof command !== 'string') return
    // Submitting still lets the text decide: a destination navigates, anything
    // else becomes an entry. Shift+Enter is the way to say "an entry" about
    // text that happens to name a screen.
    const destination = navigationDestination(command, paletteOffers)
    if (destination !== null) {
      globalThis.location.assign(destination)
      return
    }
    quickAddFromCommand(command)
  })

  commandInput.addEventListener('input', () => {
    required<HTMLElement>('[data-command-result]').textContent = ''
    // A new query starts on its first match, so Enter after typing goes where
    // the list says it will rather than to whatever was highlighted before.
    paletteIndex = 0
    renderPalette()
    refreshPaletteEntities(commandInput.value)
  })

  entryForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const operation = sessionOperation()
    if (operation === null || activeEntry === null || snapshot === null) return
    const editor = activeEntry
    const projectValue = entryProject.value
    const taskValue = entryTask.value
    const notes = entryNoteInput.value
    const projectId = editorResourceId('project', projectValue, editor.projectId)
    const taskId = editorResourceId('task', taskValue, editor.taskId)
    const selectedOption = snapshot.catalog.timeEntryOptions.find(
      (option) => option.project_id === projectId && option.task_id === taskId,
    )
    const sameExistingAssignment =
      editor.entry !== null &&
      projectId === editor.entry.project_id &&
      taskId === editor.entry.task_id
    if (
      projectId === null ||
      taskId === null ||
      (selectedOption === undefined && !sameExistingAssignment)
    ) {
      entryResult.textContent = 'That project/task combination is not available.'
      return
    }
    const minimumNoteLength = Math.max(
      editor.minimumNoteLength,
      selectedOption?.minimum_note_length ?? 0,
    )
    if (timeEntryNoteLength(notes) < minimumNoteLength) {
      activeEntry = { ...editor, minimumNoteLength }
      configureNoteInput(entryNoteInput, entryNoteHint, minimumNoteLength)
      entryResult.textContent = noteRequirementMessage(minimumNoteLength)
      entryNoteInput.focus()
      return
    }
    const running = editor.entry?.is_running === true
    let timing: Pick<TimeEntryInput, 'seconds' | 'started_time' | 'ended_time'>
    try {
      if (editor.timer || running) timing = {}
      else if (editor.mode === 'duration') {
        const durationChanged =
          editor.durationWasEditedBeforeOpen === true ||
          entryDurationInput.value !== editor.initialDurationValue
        if (editor.entry !== null && !durationChanged) {
          timing = {}
        } else {
          const seconds = parseCellSeconds(entryDurationInput.value)
          if (seconds < 1) throw new Error('duration must be greater than zero')
          timing = { seconds }
        }
      } else {
        timing = {
          started_time: parseTimeForClock(
            entryStart.value,
            snapshot.timeEntrySettings.clock,
          ),
          ended_time: parseTimeForClock(
            entryEnd.value,
            snapshot.timeEntrySettings.clock,
          ),
        }
      }
    } catch (error) {
      entryResult.textContent = messageFor(error)
      ;(editor.mode === 'start_end' ? entryStart : entryDurationInput).focus()
      return
    }
    const common = {
      project_id: projectId,
      task_id: taskId,
      notes: notes.trim() === '' ? null : notes,
    }
    const request = editor.entry === null
      ? api.createTimeEntry(
          editor.timer
            ? common
            : { ...common, spent_date: entryDate.value, ...timing },
          operation.signal,
        )
      : api.updateTimeEntry(
          editor.entry.id,
          running
            ? { notes: common.notes }
            : {
                ...common,
                spent_date: entryDate.value,
                ...timing,
              } satisfies TimeEntryPatch,
          operation.signal,
        )
    entryResult.textContent = editor.timer ? 'Starting timer…' : 'Saving entry…'
    entrySubmit.disabled = true
    void request
      .then(async (entry) => {
        if (!isSessionCurrent(operation)) return
        if (!(await refresh(operation))) return
        if (editor.cell !== undefined) cellStates.delete(editor.cell.key)
        if (editor.timer) entryResult.textContent = 'Timer started.'
        entryDialog.close()
        activeEntry = null
        if (editor.entry === null) {
          document.dispatchEvent(new CustomEvent('ezacto:time-entry-created', { detail: entry }))
        }
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        const minimumNoteLength = requiredMinimumFromError(error)
        if (minimumNoteLength === null) {
          entryResult.textContent = messageFor(error)
          return
        }
        activeEntry = { ...editor, minimumNoteLength }
        configureNoteInput(entryNoteInput, entryNoteHint, minimumNoteLength)
        entryResult.textContent = `The note policy changed. ${noteRequirementMessage(minimumNoteLength)}`
        entryNoteInput.focus()
      })
      .finally(() => {
        if (isSessionCurrent(operation) && entryDialog.open) entrySubmit.disabled = false
      })
  })

  for (const input of entryForm.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input, textarea',
  )) {
    input.addEventListener('input', () => {
      entryResult.textContent = ''
      if (
        activeEntry !== null &&
        snapshot !== null &&
        (input === entryProject || input === entryTask)
      ) {
        const projectId = editorResourceId(
          'project',
          entryProject.value,
          activeEntry.projectId,
        )
        const taskId = editorResourceId('task', entryTask.value, activeEntry.taskId)
        const option = snapshot.catalog.timeEntryOptions.find(
          (candidate) =>
            candidate.project_id === projectId && candidate.task_id === taskId,
        )
        if (option !== undefined) {
          activeEntry = {
            ...activeEntry,
            projectId: option.project_id,
            taskId: option.task_id,
            minimumNoteLength: option.minimum_note_length,
          }
          configureNoteInput(
            entryNoteInput,
            entryNoteHint,
            option.minimum_note_length,
          )
        }
      }
    })
  }

  stopTimer.addEventListener('click', () => {
    const operation = sessionOperation()
    if (operation === null) return
    const running = activeEntry?.entry
    if (running?.is_running !== true) {
      entryResult.textContent = 'No timer is running.'
      return
    }
    entryResult.textContent = 'Stopping timer…'
    stopTimer.disabled = true
    void api
      .stopTimeEntry(running.id, operation.signal)
      .then(async () => {
        if (!isSessionCurrent(operation)) return
        if (!(await refresh(operation))) return
        entryDialog.close()
        activeEntry = null
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        entryResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (isSessionCurrent(operation)) stopTimer.disabled = false
      })
  })

  rowForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const operation = sessionOperation()
    if (operation === null || operation.userId === null) return
    const data = new FormData(rowForm)
    const projectId = Number(data.get('project'))
    const taskId = Number(data.get('task'))
    const result = required<HTMLElement>('[data-row-result]')
    const optionExists =
      snapshot?.catalog.timeEntryOptions.some(
        (option) => option.project_id === projectId && option.task_id === taskId,
      ) ?? false
    if (
      !Number.isSafeInteger(projectId) ||
      projectId < 1 ||
      !Number.isSafeInteger(taskId) ||
      taskId < 1 ||
      !optionExists
    ) {
      result.textContent = 'Choose an available project and task.'
      return
    }
    const key = `${projectId}:${taskId}`
    const alreadyExists = grid?.rows.some((row) => row.key === key) ?? false
    supplementalRows = [
      ...new Map(
        [...supplementalRows, { projectId, taskId }].map((row) => [
          `${row.projectId}:${row.taskId}`,
          row,
        ]),
      ).values(),
    ]
    saveSupplementalRows(operation.userId, within, supplementalRows, weekStartDay)
    render()
    rowDialog.close()
    result.textContent = ''
    const firstDate = grid?.dates[selectedDay]
    if (firstDate !== undefined) {
      const focused = focusCell({ key: `${key}:${firstDate}`, view: visibleGridView() })
      setSessionStatus(
        alreadyExists
          ? focused
            ? 'That project/task row already exists; it is focused now.'
            : 'That project/task row already exists.'
          : focused
            ? 'Project/task row added. Enter time to save it.'
            : 'Project/task row added.',
        'ready',
      )
    }
  })
  required<HTMLSelectElement>('[data-row-project]').addEventListener('change', (event) => {
    updateRowTaskOptions(Number((event.currentTarget as HTMLSelectElement).value))
  })

  submitTimesheet.addEventListener('click', () => {
    const operation = sessionOperation()
    if (operation === null || timesheetTransitionPending || api.submitTimesheet === undefined) {
      return
    }
    const range = weekRange(within, snapshot?.timeEntrySettings.week_start_day ?? weekStartDay)
    timesheetTransitionPending = true
    timesheetResult.textContent = 'Submitting this week for approval…'
    renderTimesheetStatus()
    void api
      .submitTimesheet({ period_start: range.from, period_end: range.to }, operation.signal)
      .then(async () => {
        if (!(await refresh(operation))) return
        timesheetResult.textContent = 'Week submitted. You can still edit it until approval.'
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        timesheetResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (!isSessionCurrent(operation)) return
        timesheetTransitionPending = false
        renderTimesheetStatus()
      })
  })

  const openWithdrawal = (submissionId: number): void => {
    if (timesheetTransitionPending || !canManageTimesheetLocks()) return
    withdrawalSubmissionId = submissionId
    withdrawalForm.reset()
    withdrawalResult.textContent = ''
    open(withdrawalDialog)
    withdrawalReason.focus()
  }

  unsubmitTimesheet.addEventListener('click', () => {
    const operation = sessionOperation()
    const submission = currentSubmission
    if (
      operation === null ||
      submission?.status !== 'submitted' ||
      timesheetTransitionPending ||
      api.unsubmitTimesheetSubmission === undefined
    ) {
      return
    }
    // No reason is asked for. Nobody has reviewed this yet, so there is no
    // decision to explain -- asking would make correcting your own typo feel
    // like answering for it.
    timesheetTransitionPending = true
    renderTimesheetStatus()
    timesheetResult.textContent = 'Unsubmitting week…'
    void api
      .unsubmitTimesheetSubmission(submission.id, operation.signal)
      .then(async () => {
        if (!(await refresh(operation))) return
        timesheetResult.textContent =
          'Week unsubmitted. Edit it and submit again when you are ready.'
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        timesheetResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (!isSessionCurrent(operation)) return
        timesheetTransitionPending = false
        renderTimesheetStatus()
      })
  })

  withdrawTimesheet.addEventListener('click', () => {
    if (currentSubmission?.status !== 'approved') return
    openWithdrawal(currentSubmission.id)
  })

  withdrawalForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const operation = sessionOperation()
    const reason = withdrawalReason.value.trim()
    if (reason === '') {
      withdrawalResult.textContent = 'Enter a reason before reopening this timesheet.'
      withdrawalReason.focus()
      return
    }
    if (
      operation === null ||
      withdrawalSubmissionId === null ||
      timesheetTransitionPending ||
      api.withdrawTimesheetSubmission === undefined
    ) {
      return
    }
    const submissionId = withdrawalSubmissionId
    timesheetTransitionPending = true
    withdrawalSubmit.disabled = true
    withdrawalResult.textContent = 'Reopening approved time and expenses…'
    void api
      .withdrawTimesheetSubmission(submissionId, { reason }, operation.signal)
      .then(async () => {
        if (!(await refresh(operation))) return
        withdrawalSubmissionId = null
        withdrawalDialog.close()
        timesheetResult.textContent =
          'Approval withdrawn. Time and expenses are editable unless another lock applies.'
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        withdrawalResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (!isSessionCurrent(operation)) return
        timesheetTransitionPending = false
        withdrawalSubmit.disabled = false
        renderTimesheetStatus()
      })
  })

  withdrawalReason.addEventListener('input', () => {
    withdrawalResult.textContent = ''
  })

  lockPolicyForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const operation = sessionOperation()
    if (
      operation === null ||
      lockPolicyTransitionPending ||
      api.updateTimesheetLockPolicy === undefined
    ) {
      return
    }
    const autoLock = lockPolicyAuto.checked
    const day = lockPolicyDay.value
    const time = lockPolicyTime.value
    const timezone = lockPolicyTimezone.value.trim()
    if (timezone === '' || time === '') {
      lockPolicyResult.textContent = 'Enter a deadline time and organization timezone.'
      return
    }
    if (
      day !== 'sunday' &&
      day !== 'monday' &&
      day !== 'tuesday' &&
      day !== 'wednesday' &&
      day !== 'thursday' &&
      day !== 'friday' &&
      day !== 'saturday'
    ) {
      lockPolicyResult.textContent = 'Choose a valid deadline day.'
      return
    }
    lockPolicyTransitionPending = true
    lockPolicyResult.textContent = 'Saving lock policy…'
    renderLockPolicy()
    void api
      .updateTimesheetLockPolicy(
        {
          auto_lock: autoLock,
          timesheet_deadline: { day, time },
          timezone,
        },
        operation.signal,
      )
      .then(async () => {
        if (!(await refresh(operation))) return
        lockPolicyResult.textContent = autoLock
          ? 'Deadline saved. Due weeks are locked in the organization timezone.'
          : 'Automatic locking disabled. Existing lock records remain in effect.'
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        lockPolicyResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (!isSessionCurrent(operation)) return
        lockPolicyTransitionPending = false
        renderLockPolicy()
      })
  })

  manualLockForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const operation = sessionOperation()
    const lockedThrough = manualLockThrough.value
    const reason = manualLockReason.value.trim()
    if (lockedThrough === '' || reason === '') {
      lockPolicyResult.textContent = 'Choose a cutoff date and enter a lock reason.'
      return
    }
    if (
      operation === null ||
      lockPolicyTransitionPending ||
      api.createTimesheetManualLock === undefined
    ) {
      return
    }
    lockPolicyTransitionPending = true
    manualLockCommandId ??= crypto.randomUUID()
    const commandId = manualLockCommandId
    lockPolicyResult.textContent = 'Locking tracked work…'
    renderLockPolicy()
    void api
      .createTimesheetManualLock(
        commandId,
        { locked_through: lockedThrough, reason },
        operation.signal,
      )
      .then(async () => {
        if (!(await refresh(operation))) return
        manualLockCommandId = null
        manualLockReason.value = ''
        lockPolicyResult.textContent = `Tracked work through ${dayLabel(lockedThrough, true)} is locked.`
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        lockPolicyResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (!isSessionCurrent(operation)) return
        lockPolicyTransitionPending = false
        renderLockPolicy()
      })
  })

  manualLockForm.addEventListener('input', () => {
    if (!lockPolicyTransitionPending) manualLockCommandId = null
  })

  rejectionForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const operation = sessionOperation()
    const reason = rejectionReason.value.trim()
    if (reason === '') {
      rejectionResult.textContent = 'Enter a reason before rejecting this timesheet.'
      rejectionReason.focus()
      return
    }
    if (
      operation === null ||
      rejectionSubmissionId === null ||
      timesheetTransitionPending ||
      api.rejectTimesheetSubmission === undefined
    ) {
      return
    }
    const submissionId = rejectionSubmissionId
    timesheetTransitionPending = true
    rejectionSubmit.disabled = true
    rejectionResult.textContent = 'Rejecting timesheet…'
    void api
      .rejectTimesheetSubmission(submissionId, { reason }, operation.signal)
      .then(async () => {
        if (!(await refresh(operation))) return
        rejectionDialog.close()
        rejectionSubmissionId = null
        approvalQueueResult.textContent = 'Timesheet returned for changes.'
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        rejectionResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (!isSessionCurrent(operation)) return
        timesheetTransitionPending = false
        rejectionSubmit.disabled = false
        renderApprovalQueue()
      })
  })

  rejectionReason.addEventListener('input', () => {
    rejectionResult.textContent = ''
  })

  approvalFiltersForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const operation = sessionOperation()
    if (operation === null) return
    const userVal = approvalFilterUser.value
    const clientVal = approvalFilterClient.value
    const projectVal = approvalFilterProject.value
    approvalQueueFilters = {
      ...(userVal ? { userId: Number(userVal) } : {}),
      ...(clientVal ? { clientId: Number(clientVal) } : {}),
      ...(projectVal ? { projectId: Number(projectVal) } : {}),
    }
    void refresh(operation)
  })

  approvalLoadMore.addEventListener('click', () => {
    approvalLoadMore.hidden = true
  })

  approvalHistoryLoadMore.addEventListener('click', () => {
    approvalHistoryLoadMore.hidden = true
  })

  function moveWeekTo(nextWithin: string): void {
    const operation = sessionOperation()
    if (operation === null || operation.userId === null) return
    within = nextWithin
    supplementalRows = loadSupplementalRows(operation.userId, within, weekStartDay)
    selectedDay = 0
    cellStates.clear()
    setWeekUrl(within, weekStartDay)
    setSessionStatus('Loading week…', 'loading')
    void refresh(operation)
      .then((loaded) => {
        if (!loaded || !isSessionCurrent(operation)) return
        setSessionStatus(`Connected. Changes save directly to ${brandName}.`, 'ready')
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        renderWeekLoadFailure()
        setSessionStatus(
          'Signed in, but your week could not load. Check the connection and retry.',
          'error',
          true,
        )
      })
  }
  /**
   * Kept for the callers that still think in days rather than in periods: the
   * `[`/`]` shortcuts and the day switcher walking off either end of the week.
   */
  const moveWeek = (days: number): void => moveWeekTo(shiftDate(within, days))
  required<HTMLButtonElement>('[data-week-current]').addEventListener('click', () => {
    const operation = sessionOperation()
    if (operation === null || operation.userId === null) return
    within = localDate()
    supplementalRows = loadSupplementalRows(operation.userId, within, weekStartDay)
    selectedDay = Math.max(0, weekDates(within, weekStartDay).indexOf(localDate()))
    cellStates.clear()
    setWeekUrl(within, weekStartDay)
    void loadWeek(operation)
  })
  const selectDay = (index: number): void => {
    if (currentIdentity === null || index < 0 || index > 6 || index === selectedDay) return
    selectedDay = index
    render()
  }
  const moveDay = (offset: number): void => {
    if (currentIdentity === null) return
    // Walk the calendar. Wrapping modulo 7 made Sunday's "next" jump backwards
    // to Monday of the same week, so a day-by-day review could never leave it.
    const next = selectedDay + offset
    if (next < 0 || next > 6) {
      const landing = next < 0 ? 6 : 0
      moveWeek(offset * 7)
      selectedDay = landing
      return
    }
    selectedDay = next
    render()
  }
  required<HTMLButtonElement>('[data-day-previous]').addEventListener('click', () => moveDay(-1))
  required<HTMLButtonElement>('[data-day-next]').addEventListener('click', () => moveDay(1))
  required<HTMLButtonElement>('[data-copy-last-week]').addEventListener('click', () => {
    const operation = sessionOperation()
    if (operation === null || operation.userId === null || grid === null) return
    setSessionStatus('Copying project/task rows from last week…', 'loading')
    const previousMonday = shiftDate(grid.dates[0]!, -7)
    void api
      .listTimeEntries(weekRange(previousMonday, weekStartDay), operation.signal)
      .then((entries) => {
        if (!isSessionCurrent(operation)) return
        const copied = seedsFromEntries(entries)
        supplementalRows = [
          ...new Map(
            [...supplementalRows, ...copied].map((row) => [`${row.projectId}:${row.taskId}`, row]),
          ).values(),
        ]
        saveSupplementalRows(operation.userId!, within, supplementalRows, weekStartDay)
        render()
        setSessionStatus(
          copied.length === 0
            ? 'Last week has no project/task rows to copy.'
            : `Copied ${copied.length} project/task ${copied.length === 1 ? 'row' : 'rows'} without copying hours.`,
          'ready',
        )
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        setSessionStatus(messageFor(error), 'error')
      })
  })

  invoiceClient.addEventListener('change', renderInvoiceProjects)
  invoiceRetry.addEventListener('click', () => {
    const operation = sessionOperation()
    if (operation === null) return
    void loadInvoiceGeneration(operation)
  })
  invoiceForm.addEventListener('change', () => {
    invoiceCommandId = null
    invoiceSuccess.hidden = true
    generatedInvoiceLink.hidden = true
    if (!invoiceGenerationPending) invoiceResult.textContent = ''
  })
  invoiceLoadMore.addEventListener('click', () => {
    const operation = sessionOperation()
    if (operation === null || invoiceNextCursor === null) return
    void loadInvoiceList(operation, invoiceNextCursor)
  })
  invoiceSearch.addEventListener('input', () => {
    if (invoiceListPage) renderInvoiceList()
  })
  for (const control of document.querySelectorAll<HTMLButtonElement>('[data-invoice-filter]')) {
    control.addEventListener('click', () => {
      const operation = sessionOperation()
      const next = control.dataset.invoiceFilter
      if (
        operation === null ||
        (next !== 'outstanding' && next !== 'paid' && next !== 'closed' && next !== 'all') ||
        next === invoiceFilter
      )
        return
      invoiceFilter = next
      for (const button of document.querySelectorAll<HTMLButtonElement>('[data-invoice-filter]')) {
        button.setAttribute('aria-pressed', String(button.dataset.invoiceFilter === invoiceFilter))
      }
      // A different question, so a different traversal: the rows already loaded
      // answered the old one, and the cursor that would fetch more of them is
      // scoped to the query string that produced it.
      invoiceNextCursor = null
      invoiceListRows = []
      invoiceLoadMore.hidden = true
      void loadInvoiceList(operation)
    })
  }
  invoiceForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const operation = sessionOperation()
    if (
      operation === null ||
      invoiceGenerationPending ||
      api.generateInvoice === undefined
    ) {
      return
    }
    const data = new FormData(invoiceForm)
    const clientId = Number(data.get('client'))
    // Off the control rather than the FormData: its date inputs carry no
    // `name`, because the range is the control's state and a second copy in the
    // form would be a second answer to the same question.
    const { from, to } = invoicePeriod.range()
    const projectIds = data
      .getAll('project')
      .map(Number)
      .filter((projectId) => Number.isSafeInteger(projectId) && projectId > 0)
    const rawTimeSummary = data.get('timeSummary')
    const rawExpenseSummary = data.get('expenseSummary')
    const timeSummaries = new Set(['project', 'task', 'people', 'detailed'])
    const expenseSummaries = new Set(['project', 'category', 'people', 'detailed'])
    if (
      !Number.isSafeInteger(clientId) ||
      clientId < 1 ||
      // Both ends read as real days, in order. The fields this replaced were
      // `required` on a `type="date"` input, so an empty range never reached
      // here -- the browser refused the submit. The control's inputs are not
      // required, because a half-typed custom range is a normal state to be in
      // while choosing one, so the check that used to be the browser's is ours.
      !isCalendarDay(from) ||
      !isCalendarDay(to) ||
      from > to ||
      projectIds.length === 0 ||
      typeof rawTimeSummary !== 'string' ||
      typeof rawExpenseSummary !== 'string' ||
      (rawTimeSummary !== '' && !timeSummaries.has(rawTimeSummary)) ||
      (rawExpenseSummary !== '' && !expenseSummaries.has(rawExpenseSummary))
    ) {
      invoiceResult.textContent = 'Choose a client, date range, and at least one project.'
      return
    }
    if (rawTimeSummary === '' && rawExpenseSummary === '') {
      invoiceResult.textContent = 'Include time, expenses, or both.'
      return
    }
    const input: InvoiceGenerationInput = {
      client_id: clientId,
      from,
      to,
      project_ids: projectIds,
      time_summary_type: (rawTimeSummary === '' ? null : rawTimeSummary) as
        | 'project'
        | 'task'
        | 'people'
        | 'detailed'
        | null,
      expense_summary_type: (rawExpenseSummary === '' ? null : rawExpenseSummary) as
        | 'project'
        | 'category'
        | 'people'
        | 'detailed'
        | null,
    }
    invoiceCommandId ??= `web.invoice.create:${globalThis.crypto.randomUUID()}`
    const commandId = invoiceCommandId
    setInvoiceFormPending(true)
    invoiceSubmit.textContent = 'Generating…'
    invoiceResult.textContent = 'Atomically claiming tracked work and creating the draft…'
    invoiceSuccess.hidden = true
    void api
      .generateInvoice(commandId, input, operation.signal)
      .then((invoice) => {
        if (!isSessionCurrent(operation)) return
        required<HTMLElement>('[data-generated-invoice-number]').textContent = invoice.number
        // The total and the line count share a line, so only the figure carries
        // the marker -- masking the whole node would take the count with it.
        // This panel stays on screen until the next generation or a navigation,
        // so it is a standing headline amount rather than transient prose.
        const generatedTotal = required<HTMLElement>('[data-generated-invoice-total]')
        generatedTotal.replaceChildren(
          moneyText(formatMoney(invoice.amount_cents, invoice.currency)),
          ` · ${invoice.line_items.length} ${invoice.line_items.length === 1 ? 'line' : 'lines'}`,
        )
        generatedInvoiceLink.href = `/invoices/${invoice.id}`
        generatedInvoiceLink.hidden = false
        invoiceResult.textContent = 'Draft invoice generated successfully.'
        invoiceSuccess.hidden = false
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        invoiceResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (!isSessionCurrent(operation)) return
        setInvoiceFormPending(false)
        invoiceSubmit.textContent = 'Generate draft invoice'
      })
  })

  retryWeek.addEventListener('click', () => {
    const operation = sessionOperation()
    if (operation === null) return
    retryWeek.disabled = true
    void loadWeek(operation)
  })

  // Only a demo deployment renders these, and only into its own sign-in form.
  // The values are read from the buttons the server wrote; nothing here knows
  // a password, and on any other deployment the query matches nothing.
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-demo-fill]')) {
    button.addEventListener('click', () => {
      signInEmail.value = button.dataset.demoEmail ?? ''
      signInPassword.value = button.dataset.demoPassword ?? ''
      signInResult.textContent = ''
      signInSubmit.focus()
    })
  }

  signInForm.addEventListener('submit', (event) => {
    event.preventDefault()
    if (signingIn) {
      signInPassword.value = ''
      return
    }
    const email = signInEmail.value.trim()
    const password = signInPassword.value
    if (email === '' || password === '') {
      signInResult.textContent = 'Enter your email and password.'
      return
    }
    const operation = beginAuthGeneration(null)
    signingIn = true
    setSignInPending(true)
    signInResult.textContent = 'Signing in…'
    let request: Promise<unknown>
    try {
      request = api.signIn({ email, password }, operation.signal)
    } catch (error) {
      signInResult.textContent = signInMessage(error)
      signingIn = false
      setSignInPending(false)
      return
    } finally {
      signInPassword.value = ''
    }
    void request
      .then(async () => {
        if (!isGenerationCurrent(operation)) return
        await loadAuthenticatedShell(operation)
      })
      .catch((error: unknown) => {
        if (!isGenerationCurrent(operation)) return
        signInResult.textContent = signInMessage(error)
      })
      .finally(() => {
        if (!isGenerationCurrent(operation)) return
        signingIn = false
        setSignInPending(false)
      })
  })

  logout.addEventListener('click', () => {
    if (currentIdentity === null || signingOut) return
    const operation = beginAuthGeneration(null)
    signingOut = true
    currentIdentity = null
    setApplicationAvailability(false)
    logout.disabled = true
    clearFormState()
    authShell.dataset.state = 'loading'
    signInForm.hidden = true
    currentIdentityPanel.hidden = true
    setSessionStatus('Signing out and revoking this session…', 'loading')
    void api
      .logoutCurrentSession(operation.signal)
      .then(() => {
        if (!isGenerationCurrent(operation)) return
        transitionSignedOut('Signed out. Sign in to load and edit your week.')
        signInEmail.focus()
      })
      .catch((error: unknown) => {
        if (!isGenerationCurrent(operation)) return
        if (error instanceof EzactoApiError && error.status === 401) {
          transitionSignedOut('Your session ended. Sign in again to continue.')
          signInEmail.focus()
          return
        }
        transitionSignedOut(
          'Sign-out could not be confirmed. Sign in again or retry when connected.',
        )
      })
      .finally(() => {
        if (!isGenerationCurrent(operation)) return
        signingOut = false
        logout.disabled = false
      })
  })

  // Row density. The stylesheet has carried `[data-density='compact']` since the
  // shell was built and nothing ever set the attribute, so §6's Comfortable /
  // Compact toggle existed as CSS that matched no document. Applied before the
  // session resolves, because it is a display preference and has nothing to
  // wait for.
  const density = createDensityRuntime({
    store: browserDensityStore(globalThis.localStorage),
    target: document.documentElement,
  })
  const syncDensityChoice = (current: Density): void => {
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      '[data-density-choice]',
    )) {
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.densityChoice === current),
      )
    }
  }
  syncDensityChoice(density.start())
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-density-choice]')) {
    button.addEventListener('click', () => {
      const chosen = button.dataset.densityChoice
      if (chosen !== 'comfortable' && chosen !== 'compact') return
      syncDensityChoice(density.set(chosen))
    })
  }

  const initialOperation = currentAuthOperation(null)
  try {
    await loadAuthenticatedShell(initialOperation)
  } catch (error) {
    if (!isGenerationCurrent(initialOperation)) return
    if (error instanceof EzactoApiError && error.status === 401) transitionSignedOut()
    else transitionSignedOut('Ezacto could not check your session. You can try signing in.')
  }
}
