import { EzactoApiError, type Whoami } from '@ezacto/client'
import {
  buildWeekGrid,
  formatCellHours,
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
  loadShellSnapshot,
  localDate,
  navigationDestination,
  quickAdd,
  runningElapsedSeconds,
  startTimer,
  weekRange,
  type DisplayTimeEntry,
  type ShellApi,
  type ShellSnapshot,
} from './model.js'

type GridView = 'desktop' | 'phone'

interface CellSaveState {
  readonly state: 'dirty' | 'saving' | 'saved' | 'retry'
  readonly rawValue: string
  readonly message?: string
  readonly notes?: string | null
  readonly retry?: () => Promise<WeekCellSaveResult>
}

interface FocusTarget {
  readonly key: string
  readonly view: GridView
}

interface GridHandlers {
  readonly cellStates: Map<string, CellSaveState>
  commit(
    input: HTMLInputElement,
    cell: WeekGridCell,
    view: GridView,
    focus?: FocusTarget,
  ): Promise<boolean>
  retry(cell: WeekGridCell, view: GridView): Promise<void>
  openNote(cell: WeekGridCell, view: GridView): void
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
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

const apiErrorCode = (error: EzactoApiError): string | null => {
  if (typeof error.body !== 'object' || error.body === null) return null
  const detail = Reflect.get(error.body, 'error')
  if (typeof detail !== 'object' || detail === null) return null
  const code = Reflect.get(detail, 'code')
  return typeof code === 'string' ? code : null
}

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
): HTMLInputElement => {
  const input = document.createElement('input')
  input.type = 'text'
  input.inputMode = 'decimal'
  input.autocomplete = 'off'
  input.dataset.cellKey = cell.key
  input.dataset.savedValue = formatCellHours(cell.totalSeconds)
  input.dataset.view = view
  input.value = state?.rawValue ?? input.dataset.savedValue
  input.ariaLabel = `${dayLabel(cell.date)} hours`
  input.placeholder = '0'
  input.disabled = cell.isConflict || cell.isLocked || cell.isRunning
  if (cell.isConflict)
    input.title = 'Multiple entries share this cell. Open Day view to edit them separately.'
  if (cell.isLocked) input.title = 'This entry is locked.'
  if (cell.isRunning) input.title = 'Stop the running timer before editing this cell.'
  return input
}

const renderCellControl = (
  cell: WeekGridCell,
  view: GridView,
  handlers: GridHandlers,
  next: FocusTarget | undefined,
): HTMLElement => {
  const state = handlers.cellStates.get(cell.key)
  const wrapper = document.createElement('div')
  wrapper.className = 'week-cell'
  wrapper.dataset.cellKey = cell.key
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

  const input = cellInput(cell, view, state)
  input.addEventListener('input', () => {
    const dirty: CellSaveState = { state: 'dirty', rawValue: input.value }
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
  note.ariaLabel = `${cell.notes === null ? 'Add' : 'Edit'} note for ${dayLabel(cell.date)}`
  note.title = cell.notes ?? 'Add note'
  note.textContent = cell.notes === null ? '+' : '•'
  note.disabled = cell.entries.length !== 1 || cell.isConflict || cell.isLocked || cell.isRunning
  note.addEventListener('click', () => handlers.openNote(cell, view))
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
                : ''
  wrapper.append(status)

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
        isConflict: false,
        isLocked: entry.is_locked,
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
      const nextCell = dayItems[(itemIndex + 1) % dayItems.length]?.cell
      item.append(
        label,
        renderCellControl(
          cell,
          'phone',
          handlers,
          nextCell === undefined ? undefined : { key: nextCell.key, view: 'phone' },
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

const storageKey = (within: string): string => `ezacto:week-rows:${weekDates(within)[0]}`

const loadSupplementalRows = (within: string): WeekRowSeed[] => {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage.getItem(storageKey(within)) ?? '[]')
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

const saveSupplementalRows = (within: string, rows: readonly WeekRowSeed[]): void => {
  try {
    globalThis.localStorage.setItem(storageKey(within), JSON.stringify(rows))
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

const setWeekUrl = (within: string): void => {
  const url = new URL(globalThis.location.href)
  if (weekDates(within)[0] === weekDates(localDate())[0]) url.searchParams.delete('week')
  else url.searchParams.set('week', weekDates(within)[0]!)
  globalThis.history.replaceState(null, '', url)
}

const focusedCell = (): FocusTarget | undefined => {
  const active = document.activeElement
  if (!(active instanceof HTMLInputElement)) return undefined
  const key = active.dataset.cellKey
  const view = active.dataset.view
  return key === undefined || (view !== 'desktop' && view !== 'phone') ? undefined : { key, view }
}

const focusCell = (target: FocusTarget | undefined): void => {
  if (target === undefined) return
  const match = [...document.querySelectorAll<HTMLInputElement>('input[data-cell-key]')].find(
    (input) => input.dataset.cellKey === target.key && input.dataset.view === target.view,
  )
  match?.focus()
  match?.select()
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

export const mountShell = async (api: ShellApi = createSameOriginShellApi()): Promise<void> => {
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
  const timerDialog = required<HTMLDialogElement>('[data-timer-dialog]')
  const menuDialog = required<HTMLDialogElement>('[data-menu-dialog]')
  const rowDialog = required<HTMLDialogElement>('[data-row-dialog]')
  const noteDialog = required<HTMLDialogElement>('[data-note-dialog]')
  const commandForm = required<HTMLFormElement>('[data-command-form]')
  const timerForm = required<HTMLFormElement>('[data-timer-form]')
  const rowForm = required<HTMLFormElement>('[data-row-form]')
  const noteForm = required<HTMLFormElement>('[data-note-form]')
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
  let supplementalRows = loadSupplementalRows(within)
  let selectedDay = Math.max(0, weekDates(within).indexOf(localDate()))
  let snapshot: ShellSnapshot | null = null
  let grid: WeekGrid | null = null
  let activeNote: { cell: WeekGridCell; view: GridView } | null = null
  let currentIdentity: Whoami | null = null
  let signingIn = false
  let signingOut = false

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

  const renderSignedOutWeek = (): void => {
    snapshot = null
    grid = null
    cellStates.clear()
    if (timerInterval !== undefined) globalThis.clearInterval(timerInterval)
    required<HTMLButtonElement>('[data-timer-chip]').dataset.state = 'signed-out'
    required<HTMLElement>('[data-timer-label]').textContent = 'Sign in required'
    required<HTMLElement>('[data-timer-elapsed]').textContent = '—'
    required<HTMLElement>('[data-week-label]').textContent = weekLabel(weekDates(within))
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
    required<HTMLElement>('[data-week-label]').textContent = weekLabel(weekDates(within))
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

  const showSignedOut = (message = 'Sign in to load and edit your week.'): void => {
    currentIdentity = null
    authShell.dataset.state = 'signed-out'
    signInForm.hidden = false
    currentIdentityPanel.hidden = true
    required<HTMLElement>('[data-current-user-id]').textContent = '—'
    required<HTMLElement>('[data-current-profile]').textContent = '—'
    signInResult.textContent = ''
    logoutResult.textContent = ''
    setSessionStatus(message, 'signed-out')
    setApplicationAvailability(false)
    for (const dialog of [commandDialog, timerDialog, rowDialog, noteDialog]) {
      if (dialog.open) dialog.close()
    }
    renderSignedOutWeek()
  }

  const showAuthenticated = (identity: Whoami): void => {
    currentIdentity = identity
    authShell.dataset.state = 'ready'
    signInForm.hidden = true
    currentIdentityPanel.hidden = false
    required<HTMLElement>('[data-current-user-id]').textContent = String(identity.user_id)
    required<HTMLElement>('[data-current-profile]').textContent = profileLabel(identity.profile)
    signInResult.textContent = ''
    logoutResult.textContent = ''
    setApplicationAvailability(true)
  }

  const updateRowOptions = (): void => {
    if (snapshot === null) return
    required<HTMLSelectElement>('[data-row-project]').replaceChildren(
      ...snapshot.catalog.projects.map((resource) => option(resource.id, resourceLabel(resource))),
    )
    required<HTMLSelectElement>('[data-row-task]').replaceChildren(
      ...snapshot.catalog.tasks.map((resource) => option(resource.id, resourceLabel(resource))),
    )
  }

  const render = (): void => {
    if (snapshot === null) return
    grid = buildWeekGrid(snapshot, within, supplementalRows)
    required<HTMLElement>('[data-week-label]').textContent = weekLabel(grid.dates)
    required<HTMLElement>('[data-week-total]').textContent = formatSeconds(grid.totalSeconds)
    const handlers: GridHandlers = {
      cellStates,
      commit: commitCell,
      retry: retryCell,
      openNote,
    }
    renderDesktopGrid(grid, handlers)
    renderPhoneDay(grid, selectedDay, handlers)
    renderTimer(snapshot.running)
    updateRowOptions()
  }

  const refresh = async (focus: FocusTarget | undefined = focusedCell()): Promise<void> => {
    snapshot = await loadShellSnapshot(api, new Date(`${within}T12:00:00`))
    render()
    focusCell(focus)
  }

  const loadWeek = async (): Promise<void> => {
    setSessionStatus('Loading your week…', 'loading')
    try {
      await refresh()
      setSessionStatus('Connected. Changes save directly to ezacto.', 'ready')
    } catch (error) {
      if (error instanceof EzactoApiError && error.status === 401) {
        showSignedOut('Your session ended. Sign in again to continue.')
        return
      }
      renderWeekLoadFailure()
      setSessionStatus(
        'Signed in, but your week could not load. Check the connection and retry.',
        'error',
        true,
      )
    }
  }

  const loadAuthenticatedShell = async (): Promise<void> => {
    const identity = await api.whoami()
    showAuthenticated(identity)
    await loadWeek()
  }

  async function commitCell(
    input: HTMLInputElement,
    cell: WeekGridCell,
    view: GridView,
    focus?: FocusTarget,
  ): Promise<boolean> {
    const current = cellStates.get(cell.key)
    if (current?.state === 'saving') return false
    const rawValue = input.value
    if (rawValue === input.dataset.savedValue && current?.notes === undefined) {
      focusCell(focus)
      return true
    }
    cellStates.set(cell.key, {
      state: 'saving',
      rawValue,
      ...(current?.notes === undefined ? {} : { notes: current.notes }),
    })
    render()
    const result = await saveWeekCellWithRetry(api, cell, rawValue, current?.notes)
    if (result.state === 'retry') {
      cellStates.set(cell.key, {
        state: 'retry',
        rawValue: result.rawValue,
        message: result.message,
        retry: result.retry,
        ...(current?.notes === undefined ? {} : { notes: current.notes }),
      })
      render()
      focusCell({ key: cell.key, view })
      return false
    }
    cellStates.set(cell.key, { state: 'saved', rawValue })
    await refresh(focus)
    return true
  }

  async function retryCell(cell: WeekGridCell, view: GridView): Promise<void> {
    const failed = cellStates.get(cell.key)
    if (failed?.state !== 'retry' || failed.retry === undefined) return
    cellStates.set(cell.key, { ...failed, state: 'saving' })
    render()
    const result = await failed.retry()
    if (result.state === 'retry') {
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
    await refresh({ key: cell.key, view })
  }

  function openNote(cell: WeekGridCell, view: GridView): void {
    if (cell.entries.length !== 1 || cell.isConflict || cell.isLocked) return
    activeNote = { cell, view }
    required<HTMLElement>('[data-note-title]').textContent =
      `${dayLabel(cell.date)} · ${cell.entries[0]!.project_label}`
    required<HTMLTextAreaElement>('[data-note-input]').value = cell.notes ?? ''
    required<HTMLElement>('[data-note-result]').textContent = ''
    open(noteDialog)
    required<HTMLTextAreaElement>('[data-note-input]').focus()
  }

  for (const trigger of document.querySelectorAll<HTMLElement>('[data-command-trigger]')) {
    trigger.addEventListener('click', () => {
      if (currentIdentity !== null) open(commandDialog)
    })
  }
  required<HTMLButtonElement>('[data-timer-chip]').addEventListener('click', () => {
    if (currentIdentity !== null) open(timerDialog)
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
    if (currentIdentity === null) return
    const result = required<HTMLElement>('[data-command-result]')
    const command = new FormData(commandForm).get('command')
    if (typeof command !== 'string') return
    const destination = navigationDestination(command)
    if (destination !== null) {
      globalThis.location.assign(destination)
      return
    }
    result.textContent = 'Logging time…'
    void quickAdd(api, command)
      .then(async (entry) => {
        await refresh()
        result.textContent = `Logged ${formatSeconds(entry.seconds)}.`
        document.dispatchEvent(new CustomEvent('ezacto:time-entry-created', { detail: entry }))
      })
      .catch((error: unknown) => {
        result.textContent = messageFor(error)
      })
  })

  timerForm.addEventListener('submit', (event) => {
    event.preventDefault()
    if (currentIdentity === null) return
    const result = required<HTMLElement>('[data-timer-result]')
    const form = new FormData(timerForm)
    const project = form.get('project')
    const task = form.get('task')
    if (typeof project !== 'string' || typeof task !== 'string') return
    result.textContent = 'Starting timer…'
    void startTimer(api, project, task)
      .then(async (entry) => {
        await refresh()
        result.textContent = 'Timer started.'
        document.dispatchEvent(new CustomEvent('ezacto:time-entry-created', { detail: entry }))
      })
      .catch((error: unknown) => {
        result.textContent = messageFor(error)
      })
  })

  required<HTMLButtonElement>('[data-stop-timer]').addEventListener('click', () => {
    if (currentIdentity === null) return
    const result = required<HTMLElement>('[data-timer-result]')
    if (snapshot?.running === null || snapshot === null) {
      result.textContent = 'No timer is running.'
      return
    }
    result.textContent = 'Stopping timer…'
    void api
      .stopTimeEntry(snapshot.running.id)
      .then(async () => {
        await refresh()
        result.textContent = 'Timer stopped.'
      })
      .catch((error: unknown) => {
        result.textContent = messageFor(error)
      })
  })

  rowForm.addEventListener('submit', (event) => {
    event.preventDefault()
    if (currentIdentity === null) return
    const data = new FormData(rowForm)
    const projectId = Number(data.get('project'))
    const taskId = Number(data.get('task'))
    if (!Number.isSafeInteger(projectId) || !Number.isSafeInteger(taskId)) return
    const key = `${projectId}:${taskId}`
    supplementalRows = [
      ...new Map(
        [...supplementalRows, { projectId, taskId }].map((row) => [
          `${row.projectId}:${row.taskId}`,
          row,
        ]),
      ).values(),
    ]
    saveSupplementalRows(within, supplementalRows)
    render()
    rowDialog.close()
    required<HTMLElement>('[data-row-result]').textContent = ''
    const firstDate = grid?.dates[selectedDay]
    if (firstDate !== undefined) focusCell({ key: `${key}:${firstDate}`, view: visibleGridView() })
  })

  noteForm.addEventListener('submit', (event) => {
    event.preventDefault()
    if (currentIdentity === null || activeNote === null) return
    const notes = new FormData(noteForm).get('notes')
    if (typeof notes !== 'string') return
    const input = [...document.querySelectorAll<HTMLInputElement>('input[data-cell-key]')].find(
      (candidate) =>
        candidate.dataset.cellKey === activeNote?.cell.key &&
        candidate.dataset.view === activeNote?.view,
    )
    if (input === undefined) return
    cellStates.set(activeNote.cell.key, {
      state: 'dirty',
      rawValue: input.value,
      notes: notes.trim() === '' ? null : notes,
    })
    const result = required<HTMLElement>('[data-note-result]')
    result.textContent = 'Saving note…'
    void commitCell(input, activeNote.cell, activeNote.view, {
      key: activeNote.cell.key,
      view: activeNote.view,
    }).then((saved) => {
      if (saved) {
        result.textContent = 'Saved.'
        noteDialog.close()
        activeNote = null
      } else result.textContent = 'The note was not saved. Use Retry in the cell.'
    })
  })

  const moveWeek = (days: number): void => {
    if (currentIdentity === null) return
    within = shiftDate(within, days)
    supplementalRows = loadSupplementalRows(within)
    selectedDay = 0
    cellStates.clear()
    setWeekUrl(within)
    setSessionStatus('Loading week…', 'loading')
    void refresh()
      .then(() => {
        setSessionStatus('Connected. Changes save directly to ezacto.', 'ready')
      })
      .catch((error: unknown) => {
        if (error instanceof EzactoApiError && error.status === 401) {
          showSignedOut('Your session ended. Sign in again to continue.')
          return
        }
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
    if (currentIdentity === null) return
    within = localDate()
    supplementalRows = loadSupplementalRows(within)
    selectedDay = Math.max(0, weekDates(within).indexOf(localDate()))
    cellStates.clear()
    setWeekUrl(within)
    void refresh()
  })
  const moveDay = (offset: number): void => {
    selectedDay = (selectedDay + offset + 7) % 7
    render()
  }
  required<HTMLButtonElement>('[data-day-previous]').addEventListener('click', () => moveDay(-1))
  required<HTMLButtonElement>('[data-day-next]').addEventListener('click', () => moveDay(1))
  required<HTMLButtonElement>('[data-copy-last-week]').addEventListener('click', () => {
    if (currentIdentity === null || grid === null) return
    setSessionStatus('Copying project/task rows from last week…', 'loading')
    const previousMonday = shiftDate(grid.dates[0]!, -7)
    void api
      .listTimeEntries(weekRange(previousMonday))
      .then((entries) => {
        const copied = seedsFromEntries(entries)
        supplementalRows = [
          ...new Map(
            [...supplementalRows, ...copied].map((row) => [`${row.projectId}:${row.taskId}`, row]),
          ).values(),
        ]
        saveSupplementalRows(within, supplementalRows)
        render()
        setSessionStatus(
          copied.length === 0
            ? 'Last week has no project/task rows to copy.'
            : `Copied ${copied.length} project/task ${copied.length === 1 ? 'row' : 'rows'} without copying hours.`,
          'ready',
        )
      })
      .catch((error: unknown) => {
        setSessionStatus(messageFor(error), 'error')
      })
  })

  retryWeek.addEventListener('click', () => {
    if (currentIdentity === null) return
    retryWeek.disabled = true
    void loadWeek()
  })

  signInForm.addEventListener('submit', (event) => {
    event.preventDefault()
    if (signingIn) return
    const email = signInEmail.value.trim()
    const password = signInPassword.value
    if (email === '' || password === '') {
      signInResult.textContent = 'Enter your email and password.'
      return
    }
    signingIn = true
    signInSubmit.disabled = true
    signInResult.textContent = 'Signing in…'
    void api
      .signIn({ email, password })
      .then(async () => {
        await loadAuthenticatedShell()
      })
      .catch((error: unknown) => {
        signInResult.textContent = signInMessage(error)
      })
      .finally(() => {
        signInPassword.value = ''
        signingIn = false
        signInSubmit.disabled = false
      })
  })

  logout.addEventListener('click', () => {
    if (currentIdentity === null || signingOut) return
    signingOut = true
    logout.disabled = true
    logoutResult.textContent = 'Signing out…'
    void api
      .logoutCurrentSession()
      .then(() => {
        showSignedOut('Signed out. Sign in to load and edit your week.')
        signInEmail.focus()
      })
      .catch((error: unknown) => {
        if (error instanceof EzactoApiError && error.status === 401) {
          showSignedOut('Your session ended. Sign in again to continue.')
          signInEmail.focus()
          return
        }
        logoutResult.textContent = 'Sign-out could not be completed. Try again.'
      })
      .finally(() => {
        signingOut = false
        logout.disabled = false
      })
  })

  try {
    await loadAuthenticatedShell()
  } catch (error) {
    if (error instanceof EzactoApiError && error.status === 401) showSignedOut()
    else showSignedOut('Ezacto could not check your session. You can try signing in.')
  }
}
