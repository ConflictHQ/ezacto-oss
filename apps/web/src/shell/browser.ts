import {
  EzactoApiError,
  type GeneralResource,
  type InvoiceGenerationInput,
  type TimeEntryInput,
  type TimeEntryPatch,
  type TimesheetSubmission,
  type TimesheetSubmissionDetail,
  type Whoami,
} from '@ezacto/client'
import {
  contextLabel,
  formatTimeForClock,
  modeForEntryDraft,
  parseTimeForClock,
  type EntryEditorContext,
  type TimeEntryMode,
} from '../components/time-entry-editor.js'
import {
  buildWeekGrid,
  formatCellHours,
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
  createSameOriginShellApi,
  hydratePendingTimesheetDetails,
  loadShellSnapshot,
  localDate,
  navigationDestination,
  prepareQuickAdd,
  runningElapsedSeconds,
  timeEntryNoteLength,
  weekRange,
  type DisplayTimeEntry,
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

const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`shell element missing: ${selector}`)
  return element
}

const formatSeconds = (seconds: number): string => {
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  return `${hours}:${String(minutes).padStart(2, '0')}`
}

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

const weekLabel = (dates: readonly string[]): string => {
  const first = dayLabel(dates[0]!, true)
  const last = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parseDate(dates.at(-1)!))
  return `${first} – ${last}`
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
  for (const date of grid.dates) {
    const th = document.createElement('th')
    th.scope = 'col'
    th.textContent = dayLabel(date, true)
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
        tr.append(label)
        row.cells.forEach((cell, dayIndex) => {
          const td = document.createElement('td')
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
    elapsed.textContent = '0:00'
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
  const timesheetApprovalsPage =
    document.documentElement.dataset.appView === 'timesheet-approvals'
  const signedOutDocumentTitle = document.title
  const authenticatedDocumentTitle = signedOutDocumentTitle.replace(
    / — Sign in$/u,
    invoiceGenerationPage
      ? ' — Generate invoice'
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
  const commandForm = required<HTMLFormElement>('[data-command-form]')
  const entryForm = required<HTMLFormElement>('[data-entry-form]')
  const rowForm = required<HTMLFormElement>('[data-row-form]')
  const rejectionForm = required<HTMLFormElement>('[data-rejection-form]')
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
  const invoiceClient = required<HTMLSelectElement>('[data-invoice-client]')
  const invoiceProjects = required<HTMLElement>('[data-invoice-projects]')
  const invoiceResult = required<HTMLElement>('[data-invoice-generation-result]')
  const invoiceSubmit = required<HTMLButtonElement>('[data-invoice-generation-submit]')
  const invoiceRetry = required<HTMLButtonElement>('[data-retry-invoice-catalog]')
  const invoiceSuccess = required<HTMLElement>('[data-invoice-generation-success]')
  const timesheetStatus = required<HTMLElement>('[data-timesheet-status]')
  const timesheetStatusLabel = required<HTMLElement>('[data-timesheet-status-label]')
  const timesheetRejectionReason = required<HTMLElement>('[data-timesheet-rejection-reason]')
  const timesheetResult = required<HTMLElement>('[data-timesheet-result]')
  const submitTimesheet = required<HTMLButtonElement>('[data-submit-timesheet]')
  const approvalsPageElement = required<HTMLElement>('[data-timesheet-approvals-page]')
  const approvalQueue = required<HTMLElement>('[data-approval-queue]')
  const approvalQueueResult = required<HTMLElement>('[data-approval-queue-result]')
  const rejectionReason = required<HTMLTextAreaElement>('[data-rejection-reason]')
  const rejectionResult = required<HTMLElement>('[data-rejection-result]')
  const rejectionSubmit = required<HTMLButtonElement>('[data-rejection-submit]')
  const requestedView = new URL(globalThis.location.href).searchParams.get('view')
  document.documentElement.dataset.timeView = requestedView === 'day' ? 'day' : 'week'
  for (const link of document.querySelectorAll<HTMLAnchorElement>('.tabstrip a')) {
    const linkView = new URL(link.href).searchParams.get('view') ?? 'week'
    if (linkView === document.documentElement.dataset.timeView)
      link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  const cellStates = new Map<string, CellSaveState>()
  let within = initialWithin()
  let weekStartDay: WeekStartDay = 'monday'
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
  let approvalModuleAvailable = false
  let currentSubmission: TimesheetSubmission | null = null
  let pendingSubmissions: readonly TimesheetSubmissionDetail[] = []
  let timesheetTransitionPending = false
  let rejectionSubmissionId: number | null = null

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
    invoiceRetry.hidden = true
    invoiceCatalog = null
    setInvoiceFormPending(false)
    invoiceCommandId = null
    timesheetStatus.hidden = true
    timesheetStatusLabel.textContent = 'Not submitted'
    timesheetRejectionReason.hidden = true
    timesheetRejectionReason.textContent = ''
    timesheetResult.textContent = ''
    approvalsPageElement.hidden = !timesheetApprovalsPage
    approvalQueue.replaceChildren()
    approvalQueueResult.textContent = ''
    rejectionResult.textContent = ''
    approvalModuleAvailable = false
    currentSubmission = null
    pendingSubmissions = []
    timesheetTransitionPending = false
    rejectionSubmissionId = null
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
    required<HTMLElement>('[data-week-label]').textContent = weekLabel(
      weekDates(within, weekStartDay),
    )
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
    required<HTMLElement>('[data-week-label]').textContent = weekLabel(
      weekDates(within, weekStartDay),
    )
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
    signInResult.textContent = ''
    logoutResult.textContent = ''
    setApplicationAvailability(true)
    showAuthenticatedShell()
    return operation
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
  }

  const canReviewTimesheets = (): boolean =>
    currentIdentity?.profile === 'administrator' ||
    currentIdentity?.profile === 'executive_manager' ||
    currentIdentity?.profile === 'project_manager'

  const renderApprovalNavigation = (): void => {
    const visible = approvalModuleAvailable && canReviewTimesheets()
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
    timesheetStatusLabel.textContent =
      status === 'approved'
        ? 'Approved'
        : status === 'submitted'
          ? 'Submitted for approval'
          : currentSubmission?.rejection_reason === null ||
              currentSubmission?.rejection_reason === undefined
            ? 'Not submitted'
            : 'Changes requested'
    const reason = currentSubmission?.rejection_reason?.trim() ?? ''
    timesheetRejectionReason.hidden = reason === ''
    timesheetRejectionReason.textContent = reason === '' ? '' : `Needs changes: ${reason}`
    submitTimesheet.textContent =
      status === 'approved'
        ? 'Approved'
        : status === 'submitted'
          ? 'Awaiting approval'
          : currentSubmission?.rejection_reason === null ||
              currentSubmission?.rejection_reason === undefined
            ? 'Submit week'
            : 'Resubmit week'
    submitTimesheet.disabled =
      timesheetTransitionPending ||
      status !== 'unsubmitted' ||
      snapshot === null ||
      (snapshot.entries.length === 0 && snapshot.expenses.length === 0) ||
      snapshot.entries.some((entry) => entry.is_running)
  }

  const renderApprovalQueue = (): void => {
    renderApprovalNavigation()
    if (!timesheetApprovalsPage || !approvalModuleAvailable || !canReviewTimesheets()) {
      approvalQueue.replaceChildren()
      return
    }
    if (pendingSubmissions.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'approval-empty'
      empty.textContent = 'No timesheets are waiting for review.'
      approvalQueue.replaceChildren(empty)
      return
    }
    approvalQueue.replaceChildren(
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
            amount.textContent = `${dayLabel(expense.spent_date, true)} · ${formatMoney(expense.total_cost_cents, expense.currency)}`
            expenseHeader.append(identity, amount)
            const note = document.createElement('p')
            note.className = 'approval-entry-note'
            note.textContent = expense.notes?.trim() || 'No note'
            if (expense.notes === null || expense.notes.trim() === '') note.dataset.empty = 'true'
            item.append(expenseHeader, note)
            return item
          }),
        )
        summary.append(title, period, totals, entries, expenses)
        const actions = document.createElement('div')
        actions.className = 'approval-actions'
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
    required<HTMLElement>('[data-week-label]').textContent = weekLabel(grid.dates)
    required<HTMLElement>('[data-week-total]').textContent = formatSeconds(grid.totalSeconds)
    const handlers: GridHandlers = {
      cellStates,
      organizationMode: snapshot.timeEntrySettings.time_entry_mode,
      organizationTimeFormat: snapshot.timeEntrySettings.time_format,
      commit: commitCell,
      retry: retryCell,
      openEntry,
    }
    renderDesktopGrid(grid, handlers)
    renderPhoneDay(grid, selectedDay, handlers)
    renderTimer(snapshot.running)
    updateRowOptions()
    renderApprovalNavigation()
    renderTimesheetStatus()
    renderApprovalQueue()
  }

  const loadApprovalData = async (
    operation: AuthOperation,
    requestedWithin: string,
    requestedWeekStartDay: WeekStartDay,
  ): Promise<{
    available: boolean
    current: TimesheetSubmission | null
    pending: readonly TimesheetSubmissionDetail[]
  }> => {
    if (api.listTimesheetSubmissions === undefined) {
      return { available: false, current: null, pending: [] }
    }
    const range = weekRange(requestedWithin, requestedWeekStartDay)
    try {
      const own = await api.listTimesheetSubmissions(range.from, range.to, operation.signal)
      const pendingSummaries =
        timesheetApprovalsPage &&
        canReviewTimesheets() &&
        api.listPendingTimesheetSubmissions !== undefined
          ? await api.listPendingTimesheetSubmissions(operation.signal)
          : []
      const getSubmission = api.getTimesheetSubmission
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
      }
    } catch (error) {
      if (error instanceof EzactoApiError && error.status === 404) {
        return { available: false, current: null, pending: [] }
      }
      throw error
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
    const approval = await loadApprovalData(operation, requestedWithin, loadedWeekStartDay)
    if (!isSessionCurrent(operation) || within !== requestedWithin) return false
    weekStartDay = loadedWeekStartDay
    snapshot = loaded
    supplementalRows = loadSupplementalRows(operation.userId!, within, weekStartDay)
    const loadedDates = weekDates(within, weekStartDay)
    const preservedIndex = selectedDate === undefined ? -1 : loadedDates.indexOf(selectedDate)
    selectedDay = preservedIndex >= 0 ? preservedIndex : Math.max(0, loadedDates.indexOf(localDate()))
    approvalModuleAvailable = approval.available
    currentSubmission = approval.current
    pendingSubmissions = approval.pending
    render()
    focusCell(focus)
    return true
  }

  const loadWeek = async (operation: AuthOperation): Promise<void> => {
    if (!isSessionCurrent(operation)) return
    setSessionStatus('Loading your week…', 'loading')
    try {
      if (!(await refresh(operation))) return
      setSessionStatus('Connected. Changes save directly to ezacto.', 'ready')
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
      invoiceClient.replaceChildren(
        ...clients.map((client) => option(client.id, resourceLabel(client))),
      )
      const today = localDate()
      const from = required<HTMLInputElement>('[name="from"]')
      const to = required<HTMLInputElement>('[name="to"]')
      from.value = `${today.slice(0, 8)}01`
      to.value = today
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

  const loadAuthenticatedShell = async (
    operation: AuthOperation,
  ): Promise<void> => {
    const identity = await api.whoami(operation.signal)
    if (!isGenerationCurrent(operation)) return
    const authenticated = showAuthenticated(identity)
    if (invoiceGenerationPage) {
      await Promise.all([loadInvoiceGeneration(authenticated), loadWeek(authenticated)])
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

  function openRejection(submissionId: number): void {
    if (timesheetTransitionPending) return
    rejectionSubmissionId = submissionId
    rejectionForm.reset()
    rejectionResult.textContent = ''
    open(rejectionDialog)
    rejectionReason.focus()
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
      if (currentIdentity !== null) open(commandDialog)
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
  document.addEventListener('keydown', (event) => {
    if (
      currentIdentity !== null &&
      (event.metaKey || event.ctrlKey) &&
      event.key.toLocaleLowerCase('en-US') === 'k'
    ) {
      event.preventDefault()
      open(commandDialog)
    }
  })

  commandForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const operation = sessionOperation()
    if (operation === null) return
    const result = required<HTMLElement>('[data-command-result]')
    const command = new FormData(commandForm).get('command')
    if (typeof command !== 'string') return
    const destination = navigationDestination(command)
    if (destination !== null) {
      globalThis.location.assign(destination)
      return
    }
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
  })

  required<HTMLInputElement>('[name="command"]').addEventListener('input', () => {
    required<HTMLElement>('[data-command-result]').textContent = ''
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

  const moveWeek = (days: number): void => {
    const operation = sessionOperation()
    if (operation === null || operation.userId === null) return
    within = shiftDate(within, days)
    supplementalRows = loadSupplementalRows(operation.userId, within, weekStartDay)
    selectedDay = 0
    cellStates.clear()
    setWeekUrl(within, weekStartDay)
    setSessionStatus('Loading week…', 'loading')
    void refresh(operation)
      .then((loaded) => {
        if (!loaded || !isSessionCurrent(operation)) return
        setSessionStatus('Connected. Changes save directly to ezacto.', 'ready')
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
  required<HTMLButtonElement>('[data-week-previous]').addEventListener('click', () => moveWeek(-7))
  required<HTMLButtonElement>('[data-week-next]').addEventListener('click', () => moveWeek(7))
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
  const moveDay = (offset: number): void => {
    if (currentIdentity === null) return
    selectedDay = (selectedDay + offset + 7) % 7
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
    if (!invoiceGenerationPending) invoiceResult.textContent = ''
  })
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
    const from = data.get('from')
    const to = data.get('to')
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
      typeof from !== 'string' ||
      typeof to !== 'string' ||
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
        required<HTMLElement>('[data-generated-invoice-total]').textContent =
          `${new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: invoice.currency,
          }).format(invoice.amount_cents / 100)} · ${invoice.line_items.length} ${invoice.line_items.length === 1 ? 'line' : 'lines'}`
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

  const initialOperation = currentAuthOperation(null)
  try {
    await loadAuthenticatedShell(initialOperation)
  } catch (error) {
    if (!isGenerationCurrent(initialOperation)) return
    if (error instanceof EzactoApiError && error.status === 401) transitionSignedOut()
    else transitionSignedOut('Ezacto could not check your session. You can try signing in.')
  }
}
