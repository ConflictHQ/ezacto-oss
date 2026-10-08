import { createStaffPaymentsController } from '../staff-payments/browser.js'
import {
  EzactoApiError,
  type GeneralResource,
  type Invoice,
  type InvoiceGenerationInput,
  type TimeEntryInput,
  type TimeEntryOption,
  type TimeEntryPatch,
  type TimesheetLockPolicy,
  type TimesheetLockWindow,
  type TimesheetSubmission,
  type TimesheetSubmissionDetail,
  type Whoami,
  type ApiToken,
  type CreateApiTokenInput,
  type TwoFactorStatus,
  type UninvoicedCurrencyTotal,
} from '@conflict-hq/ezacto-client'
import { browserDensityStore, createDensityRuntime, type Density } from '../density.js'
import {
  createNavLayoutRuntime,
  createSidebarRuntime,
  NAV_LAYOUT_COOKIE,
  type NavLayout,
  navLayouts,
  SIDEBAR_COOKIE,
  type SidebarState,
} from '../nav-layout.js'
import {
  DEFAULT_COMPANY_SETTINGS_SECTION,
  applySettingsSection,
  resolveSettingsSection,
} from '../settings-sections.js'
import { browserTextSizeStore, createTextSizeRuntime, type TextSize, textSizes } from '../text-size.js'
import {
  browserCookieStore,
  browserThemeStore,
  COLOR_SCHEME_COOKIE,
  type ColorScheme,
  colorSchemes,
  createColorSchemeRuntime,
  createThemeRuntime,
} from '../theme-preference.js'
import { renderDataTable } from '../components/data-table.js'
import { defaultTheme, themeManifest } from '../theme.js'
import {
  payoutFailure,
  payoutSummary,
  type PayoutDestinationState,
} from '../payout.js'
import {
  browserMoneyDisplayStore,
  createMoneyDisplayRuntime,
  markMoney,
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
import { createDeliveriesController } from '../deliveries/browser.js'
import { createCalendarController } from '../calendar/browser.js'
import { createDashboardController } from '../dashboard/browser.js'
import { createReportsController } from '../reports/browser.js'
import { canReadFinancialReports } from '../reports/model.js'
import { createExpenseWorkflowController } from '../expenses/browser.js'
import { createRoleAdminController } from '../roles/browser.js'
import { createTaskAdminController } from '../tasks/browser.js'
import { createTeamDirectoryController } from '../team/browser.js'
import { teamCapabilities } from '../team/model.js'
import { createExpenseCategoryDirectoryController } from '../expense-categories/browser.js'
import { createEmailConfigurationController } from '../email-config/browser.js'
import {
  createRecurringEditorController,
  createRecurringWorkspaceController,
} from '../recurring/browser.js'
import { createEstimateWorkspaceController } from '../estimates/browser.js'
import { createRetainerWorkspaceController } from '../retainers/browser.js'
import { createModuleSettingsController } from '../module-settings/browser.js'
import { demoUnavailable, isDemoDeployment } from '../demo.js'
import {
  createInvoicePaymentController,
  invoiceMatchesSearch,
  renderInvoiceListItems,
  setInvoiceClientNames,
} from '../invoices/browser.js'
import { createInvoiceEditorController } from '../invoices/editor.js'
import {
  invoiceBandCeilingSeconds,
  invoiceBandPreview,
  invoiceBandTerms,
  invoiceFeeLineAmountCents,
  invoiceIdentityCanRead,
  invoiceLineUnitPriceCents,
  invoicePagePath,
  invoiceStatesFor,
  type InvoiceBandTerms,
  type InvoiceBandValues,
  type InvoiceFeeLineValues,
} from '../invoices/model.js'
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
import { canManageTeammateTime, canProfileUseApiScope, isApiScope } from '@ezacto/core'
import {
  canBrowseDirectories,
  commandShortcutModifier,
  createSameOriginShellApi,
  hydratePendingTimesheetDetails,
  loadShellSnapshot,
  filingDate,
  localDate,
  navigationDestination,
  quickAddPreview,
  isSelfWithdrawn,
  palettePlan,
  type PaletteEntity,
  type PaletteResult,
  prepareQuickAdd,
  runningElapsedSeconds,
  timeEntryNoteLength,
  timePersonChoices,
  weekRange,
  type DisplayTimeEntry,
  type PaletteDestination,
  type PlatformHints,
  type ApprovalQueueFilters,
  type InvoiceJournalChoice,
  type ShellApi,
  type ShellSnapshot,
  TimeEntryNoteValidationError,
} from './model.js'

type GridView = 'desktop' | 'phone'

interface CellSaveState {
  // `removed` is `saved` for a commit that deleted the entry (issue 753). Typing
  // zero removes an entry outright, note and all, and said nothing afterwards
  // -- a destructive action indistinguishable from saving a number. It stays
  // possible, because it is how people correct a week quickly, and it now
  // reports what it did.
  readonly state: 'dirty' | 'saving' | 'saved' | 'retry' | 'removed' | 'invalid'
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
  /**
   * Issue 904: a week cell holding several entries cannot take one value, so
   * it opens the day that lists them apart, on that date.
   */
  openDay(cell: WeekGridCell): void
  // Absent when the build has no restart endpoint; the row then shows no Start.
  restart?(entryId: number): Promise<void>
  removeRow(seed: WeekRowSeed): void
  stop(entryId: number): Promise<void>
  // The other half of a row's Start: today holds nothing on this row yet, so
  // there is no entry to restart and a new timer is what it means.
  startToday(seed: WeekRowSeed, notes: string | null): Promise<void>
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
  /**
   * Whose time the editor writes when it is not the signed-in person's (issue 917):
   * the teammate an administrator has open on Time, or the owner of a report
   * row. Their project/task pairs are the ones offered, and a new entry is
   * created as theirs. Absent for your own time.
   */
  readonly owner?: {
    readonly userId: number
    readonly options: readonly TimeEntryOption[]
  }
  /** Runs after a save, stop or delete -- how a report that opened it reloads. */
  readonly onChanged?: () => void
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
  // The example has to be one the field would actually accept. It was the
  // literal "1:30" in the served HTML, which on a decimal account is a value
  // the parser rejects -- the placeholder was teaching the wrong format to
  // every operator whose organization tracks in decimal (issue 539).
  const duration = document.querySelector<HTMLInputElement>('[data-entry-duration-input]')
  if (duration !== null) duration.placeholder = format === 'decimal' ? '1.5' : '1:30'
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

/**
 * Issue 731. The sign-in response is one of two shapes, and only one of them
 * comes with a session. Reading the status is what keeps a challenged sign-in
 * from being mistaken for a successful one.
 */
const isTwoFactorRequired = (
  result: unknown,
): result is { status: 'two_factor_required'; challenge: string } =>
  typeof result === 'object' &&
  result !== null &&
  (result as { status?: unknown }).status === 'two_factor_required' &&
  typeof (result as { challenge?: unknown }).challenge === 'string'

/** `expired` means the challenge itself is gone, so the password step returns. */
const twoFactorMessage = (
  error: unknown,
): { text: string; expired: boolean } => {
  if (!(error instanceof EzactoApiError)) {
    return { text: 'Verification is unavailable right now. Try again.', expired: false }
  }
  const code = apiErrorCode(error)
  if (code === 'two_factor_challenge_invalid') {
    return { text: 'That sign-in expired. Enter your password again.', expired: true }
  }
  if (code === 'two_factor_locked' || error.status === 429) {
    return {
      text: 'Too many incorrect codes. Wait a few minutes and try again.',
      expired: false,
    }
  }
  if (code === 'invalid_two_factor_code') {
    return { text: 'That code is incorrect. Try again.', expired: false }
  }
  return { text: 'Verification could not be completed. Try again.', expired: false }
}

const profileLabel = (profile: Whoami['profile']): string =>
  profile.replaceAll('_', ' ')

/**
 * The first thing a 422 says about a field, or nothing. The route's own
 * sentence ("expires_at must be a real canonical UTC timestamp") names the
 * problem; the generic "could not be issued" sends a person to retry the same
 * form (issue 855).
 */
const apiFieldMessage = (error: unknown): string | null => {
  if (!(error instanceof EzactoApiError) || error.status !== 422) return null
  const fields = (error.body as { error?: { fields?: readonly { message?: unknown }[] } })
    ?.error?.fields
  const message = fields?.[0]?.message
  return typeof message === 'string' && message !== '' ? message : null
}

const open = (dialog: HTMLDialogElement): void => {
  if (!dialog.open) dialog.showModal()
}

/**
 * Issue 757 offered the IANA list so that setting a zone did not mean knowing
 * the spelling by heart. It offered it through a `<datalist>`, which does not
 * work here (issue 798): the popup filters by what the box already holds, and
 * both timezone boxes are filled with a complete zone before anyone clicks
 * them, so the list collapses to the value already chosen and the menu's box
 * goes active and drops nothing. The entry editor hit the same wall with
 * project and task (issues 497 and 506) and the answer is the same -- a real
 * select, whose options are its own markup. That also puts them inside the
 * modal dialog the menu's control lives in, rather than out in the document
 * `showModal()` makes inert around it.
 */
const timezoneOption = (zone: string): HTMLOptionElement => {
  const option = document.createElement('option')
  option.value = zone
  option.textContent = zone
  return option
}

const timezoneNames = (): readonly string[] => {
  const supported = (
    Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf
  const zones = supported === undefined ? [] : supported('timeZone')
  // Every engine this bundle targets enumerates zones. One that does not gets a
  // control it can still use rather than an empty list.
  if (zones.length === 0) return [Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC']
  // V8 leaves `UTC` (and `Etc/UTC`) out of the list; Firefox and Safari do not.
  // It is the organization default and the profile column's "unset", and it
  // has to stay a choice once another zone is on file: a select offers only
  // what it holds, so without this an organization could never move back to
  // UTC and a person could never return to filing on the organization zone.
  return zones.includes('UTC') ? zones : [...zones, 'UTC']
}

/**
 * A select can only hold a value it offers, and a stored zone need not be one
 * the engine enumerates: IANA links such as `US/Pacific` never are, and what a
 * given browser leaves out of `Intl.supportedValuesOf` varies. Assigned blind,
 * the control drops it and reads as nothing chosen, so an account with a zone
 * on file is shown as having none. The entry editor's `withHeldValue` holds
 * the same line for project and task.
 */
const showTimezone = (control: HTMLSelectElement, zone: string): void => {
  const offered = [...control.options].some((option) => option.value === zone)
  if (zone !== '' && !offered) {
    control.insertBefore(timezoneOption(zone), control.options[1] ?? null)
  }
  control.value = zone
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
  if (state?.state === 'invalid') input.setAttribute('aria-invalid', 'true')
  const mode = modeForEntryDraft(cell.entries[0] ?? null, organizationMode)
  input.disabled = cell.isLocked || cell.isRunning || mode === 'start_end'
  // Read-only rather than disabled (issue 904): a cell holding several entries
  // cannot take one value, but it is not broken either. It stays focusable and
  // clickable, and both open the day that lists the entries apart.
  input.readOnly = cell.isConflict
  if (cell.isConflict)
    input.title = `${cell.entries.length} entries share this cell. Open Day view to edit them separately.`
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
    if (input.value === input.dataset.savedValue && current?.notes === undefined) {
      handlers.cellStates.delete(cell.key)
      wrapper.dataset.cellState = 'idle'
      input.removeAttribute('aria-invalid')
      status.textContent = ''
      return
    }
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
    input.removeAttribute('aria-invalid')
    status.textContent = 'Unsaved'
  })
  input.addEventListener('blur', () => {
    if (!input.isConnected || input.value === input.dataset.savedValue) return
    const current = handlers.cellStates.get(cell.key)
    if ((current?.state === 'invalid' || current?.state === 'retry') && current.rawValue === input.value) return
    void handlers.commit(input, cell, view)
  })
  if (cell.isConflict) input.addEventListener('click', () => handlers.openDay(cell))
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (cell.isConflict) {
      handlers.openDay(cell)
      return
    }
    // Alt+Enter opens the cell rather than saving it (issue 753). The editor is
    // where a note is written and an entry removed, and until now nothing
    // reached it from the keyboard at all: the control that opens it is
    // deliberately outside the tab sequence, so a week row is seven stops
    // rather than fourteen. A modifier on the stop the cell already has keeps
    // that property and still lets somebody who never touches a mouse edit a
    // note or delete an entry.
    if (event.altKey) {
      handlers.openEntry(cell, view)
      return
    }
    void handlers.commit(input, cell, view, next)
  })
  wrapper.append(input)

  const note = document.createElement('button')
  note.type = 'button'
  note.className = 'cell-note'
  note.dataset.noteCell = cell.key
  // A locked cell opens to be read, not written, and the label says so: naming
  // it `Edit note` offered an edit the dialog then refuses in six disabled
  // fields.
  const noteAction = cell.isLocked
    ? 'Show why this is locked'
    : cell.entries.length === 0
      ? 'Add time'
      : currentNotes === null
        ? 'Add note'
        : 'Edit note'
  note.ariaLabel = cell.isConflict
    ? `Open Day view to edit the ${cell.entries.length} entries for ${noteContext} on ${dayLabel(cell.date)}`
    : `${noteAction} for ${noteContext} on ${dayLabel(cell.date)}${minimumNoteLength > 0 && !cell.isLocked ? `; at least ${minimumNoteLength} characters required` : ''}`
  note.title = cell.isConflict
    ? `${cell.entries.length} entries share this cell. Open Day view to edit them separately.`
    : cell.isLocked
      ? (cell.lockedReason ?? noteAction)
      : (currentNotes ?? (minimumNoteLength > 0 ? noteHint(minimumNoteLength) : cell.entries.length === 0 ? 'Add time' : 'Add note'))
  // A pencil rather than a bare glyph (issue 753). `+` and `•` beside a number read
  // as punctuation, and the account owner concluded from this screen that the
  // product could not edit a note or remove an entry -- when both have always
  // been one click away here. The mark says "there is something to open"; the
  // label and title say what.
  note.textContent = cell.isLocked ? 'ℹ' : '✎'
  note.dataset.hasNote = currentNotes === null ? 'false' : 'true'
  // Every cell already has a tab stop: its input. Putting the note and retry
  // affordances in the sequence made a week row fourteen stops to cross when
  // seven is the whole point of a grid. Both stay reachable by click and by
  // the row's own focus, and neither is the way anyone enters time.
  note.tabIndex = -1
  // A locked cell still opens, read-only, so long as there is exactly one entry
  // to explain. Refusing to open it left the reason -- invoiced, approved, an
  // archived project -- written nowhere a person could read it: the cell said
  // `Locked` and the only control that could say more was disabled. Locked with
  // nothing in it stays shut, because there is no entry to describe and the
  // route would refuse a new one anyway (issue 496).
  // A cell holding several entries opens the day that lists them apart (issue
  // 904), locked or not: it used to be disabled here, which left the cell with
  // no way forward at all.
  note.disabled =
    !cell.isConflict &&
    ((cell.isLocked && cell.entries.length !== 1) || state?.state === 'saving')
  note.addEventListener('click', () =>
    cell.isConflict ? handlers.openDay(cell) : handlers.openEntry(cell, view),
  )
  wrapper.append(note)

  // What the cell holds, in words on the cell itself. "Split" said nothing a
  // person could act on, and the explanation lived only in a tooltip.
  status.textContent = cell.isConflict
    ? `${cell.entries.length} entries`
    : cell.isLocked
      ? 'Locked'
      : cell.isRunning
        ? 'Running'
        : state?.state === 'invalid'
          ? state.message ?? 'Use decimal hours or H:MM.'
        : state?.state === 'retry'
          ? (state.message ?? 'Retry')
          : state?.state === 'saving'
            ? 'Saving…'
            : state?.state === 'saved'
              ? 'Saved'
              : state?.state === 'dirty'
                ? 'Unsaved'
              : state?.state === 'removed'
                ? (state.message ?? 'Entry removed')
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

const emptyRowRemoval = (row: WeekGrid['rows'][number], handlers: GridHandlers): HTMLButtonElement | null => {
  if (row.cells.some((cell) => cell.entries.length > 0)) return null
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'grid-row-start'
  button.dataset.removeRow = row.key
  button.textContent = 'Remove row'
  button.setAttribute('aria-label', `Remove empty row for ${row.projectLabel} / ${row.taskLabel}`)
  button.addEventListener('click', () => handlers.removeRow({ projectId: row.projectId, taskId: row.taskId }))
  return button
}

const rowStopButton = (entryId: number, label: string, className: string, handlers: GridHandlers): HTMLButtonElement => {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.dataset.stopEntry = String(entryId)
  button.textContent = 'Stop'
  button.setAttribute('aria-label', `Stop the timer on ${label}`)
  button.addEventListener('click', () => {
    button.disabled = true
    void handlers.stop(entryId).finally(() => { button.disabled = false })
  })
  return button
}

/**
 * `today` is the day the server files a timer on -- the operator's zone, then
 * the organization's -- not the browser's clock. The column marked today and
 * the cell a row's Start aims at are the same date, so they take it from the
 * same place: marked from one clock and started from another, the highlighted
 * column would stay empty while the timer landed a day over.
 */
const renderDesktopGrid = (grid: WeekGrid, handlers: GridHandlers, today: string): void => {
  const head = required<HTMLTableSectionElement>('[data-week-grid-head]')
  const heading = document.createElement('tr')
  const projectHeading = document.createElement('th')
  projectHeading.scope = 'col'
  projectHeading.textContent = 'Project / task'
  heading.append(projectHeading)
  // Which column is today is the first thing you look for in a week grid, and
  // nothing said. The cells carry it too, so the marker runs the column's
  // height rather than sitting only in its header.
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
        const remove = emptyRowRemoval(row, handlers)
        if (remove !== null) label.append(remove)
        // The day list has had this since the timesheet work; the week grid
        // never did, so on a desktop the only way to start a timer was to
        // retype the project and task into the top bar as exact strings.
        //
        // A timer measures now, so the row starts on *today's* cell. It used to
        // restart the row's last day holding a value, and a restart keeps that
        // entry's own spent_date: on a Wednesday, a row whose only entry was
        // Monday's put the running timer in the Monday cell (issue 797).
        // Today's own entry is continued where there is one, rather than joined
        // by a second -- two entries in a cell is the conflict state the grid
        // then refuses to edit.
        const latest = [...row.cells]
          .reverse()
          .find((cell) => cell.entries.length > 0 && !cell.isLocked)
        const todayCell = row.cells.find((cell) => cell.date === today)
        // Off today's week there is no today column, and the snapshot only
        // holds the week on screen, so nothing here can tell whether today
        // already carries this row. The row still starts a new timer rather
        // than restarting its latest entry: a restart keeps that entry's
        // spent_date, so from last week's grid it ran the timer on last week's
        // date -- the reported wrong day, one navigation away -- and in
        // start/end mode moved that entry's logged time to today outright.
        // The worst a new timer can do is join an entry it could not see,
        // which the day view then sorts out. Locked today is no start at all:
        // nothing can be logged to it.
        const offered =
          latest !== undefined && !row.isRunning && todayCell?.isLocked !== true
        // The row's Start needs both halves to work, so a build without the
        // restart endpoint still shows none.
        if (handlers.restart !== undefined && offered) {
          const restartId = todayCell?.entries[0]?.id
          // The rate and note of the work last done, which is what a restart
          // carried and what a note-required project needs to start at all.
          const inheritedNotes = latest?.entries[0]?.notes ?? null
          const start = document.createElement('button')
          start.type = 'button'
          start.className = 'grid-row-start'
          if (restartId !== undefined) start.dataset.startEntry = String(restartId)
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
            const started =
              restartId === undefined
                ? handlers.startToday(
                    { projectId: row.projectId, taskId: row.taskId },
                    inheritedNotes,
                  )
                : handlers.restart?.(restartId)
            void started?.finally(() => {
              start.disabled = false
            })
          })
          label.append(start)
        }
        const running = row.cells.flatMap((cell) => cell.entries).find((entry) => entry.is_running)
        if (running !== undefined) {
          label.append(rowStopButton(running.id, `${row.projectLabel} / ${row.taskLabel}`, 'grid-row-start', handlers))
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
  today: string,
): void => {
  const strip = required<HTMLElement>('[data-day-totals]')
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
      const remove = emptyRowRemoval(row, handlers)
      if (remove !== null) label.append(remove)
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
      if (entryId !== undefined && cell.isRunning) {
        label.append(rowStopButton(entryId, `${row.projectLabel} / ${row.taskLabel}`, 'day-row-start', handlers))
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

/**
 * The Time strip's current tab, from the view on screen. Scoped to Time's own
 * strip: this derives the current tab from the ?view= parameter, which no other
 * section navigates by. Left on '.tabstrip a' it would strip aria-current off
 * every tab in every other strip on load.
 */
const markTimeViewTab = (): void => {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-time-views] a')) {
    const linkView = new URL(link.href).searchParams.get('view') ?? 'week'
    if (linkView === document.documentElement.dataset.timeView)
      link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
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
  // The week grid also mounts behind the invoice wizard and normalizes its own
  // `week` parameter while catalogs load. Keep the report handoff before that
  // concurrent navigation can replace the address we arrived on.
  const invoiceGenerationPrefill = new URL(globalThis.location.href).searchParams
  // /invoices/new is the list with the new-invoice dialog open over it.
  const invoiceListPage =
    document.documentElement.dataset.appView === 'invoice-list' || invoiceGenerationPage
  const invoiceDetailPage = document.documentElement.dataset.appView === 'invoice-detail'
  const invoiceEditPage = document.documentElement.dataset.appView === 'invoice-edit'
  const invoiceRecurringPage =
    document.documentElement.dataset.appView === 'invoice-recurring'
  const invoiceRecurringEditorPage =
    document.documentElement.dataset.appView === 'invoice-recurring-editor'
  const invoiceRetainersPage =
    document.documentElement.dataset.appView === 'invoice-retainers'
  const invoiceEstimatesPage =
    document.documentElement.dataset.appView === 'invoice-estimates'
  const invoiceConfigurePage =
    document.documentElement.dataset.appView === 'settings-templates'
  const clientListPage = document.documentElement.dataset.appView === 'client-list'
  const clientDetailPage = document.documentElement.dataset.appView === 'client-detail'
  const projectListPage = document.documentElement.dataset.appView === 'project-list'
  const projectDetailPage = document.documentElement.dataset.appView === 'project-detail'
  const taskListPage = document.documentElement.dataset.appView === 'task-list'
  const roleListPage = document.documentElement.dataset.appView === 'settings-roles'
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
      ? ' — New invoice'
      : invoiceListPage
        ? ' — Invoices'
        : invoiceDetailPage
          ? ' — Invoice detail'
          : invoiceEditPage
          ? ' — Edit invoice'
          : invoiceRecurringPage
            ? ' — Recurring invoices'
            : invoiceRecurringEditorPage
            ? ' — Recurring invoice'
            : invoiceRetainersPage
              ? ' — Retainers'
              : invoiceEstimatesPage
                ? ' — Estimates'
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
  const twoFactorForm = required<HTMLFormElement>('[data-two-factor-form]')
  const twoFactorCode = required<HTMLInputElement>('#ez-two-factor-code')
  const twoFactorSubmit = required<HTMLButtonElement>('[data-two-factor-submit]')
  const twoFactorCancel = required<HTMLButtonElement>('[data-two-factor-cancel]')
  const twoFactorResult = required<HTMLElement>('[data-two-factor-result]')
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
  const entryProject = required<HTMLSelectElement>('[data-entry-project]')
  const entryTask = required<HTMLSelectElement>('[data-entry-task]')
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
  const deleteEntry = required<HTMLButtonElement>('[data-entry-delete]')
  const weekRemoved = required<HTMLElement>('[data-week-removed]')
  const timePersonField = required<HTMLElement>('[data-time-person-field]')
  const timePerson = required<HTMLSelectElement>('[data-time-person]')
  const timePersonBanner = required<HTMLElement>('[data-time-person-banner]')
  const timePersonBannerText = required<HTMLElement>('[data-time-person-banner-text]')
  const timePage = document.documentElement.dataset.appView === 'time'
  let removalTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Say what a removal took (issue 753).
   *
   * Clearing a cell deletes the entry and its note, and said nothing at all --
   * indistinguishable from having saved a number, and the note only missed
   * later. It clears itself because it describes an event rather than a state,
   * and a notice that outlives its event becomes furniture people stop reading.
   */
  const announceRemoval = (message: string): void => {
    weekRemoved.textContent = message
    weekRemoved.hidden = false
    if (removalTimer !== undefined) clearTimeout(removalTimer)
    removalTimer = setTimeout(() => {
      weekRemoved.textContent = ''
      weekRemoved.hidden = true
    }, 8_000)
  }
  const invoiceForm = required<HTMLFormElement>('[data-invoice-generation-form]')
  const invoiceNewDialog = required<HTMLDialogElement>('[data-invoice-new-dialog]')
  const invoiceTracked = required<HTMLElement>('[data-invoice-tracked]')
  const invoiceTrackedOnly = required<HTMLElement>('[data-invoice-tracked-only]')
  const invoiceBand = required<HTMLElement>('[data-invoice-band]')
  const invoiceFeeLines = required<HTMLElement>('[data-invoice-fee-lines]')
  const invoiceFeeLineTemplate = required<HTMLTemplateElement>('[data-invoice-fee-line-template]')
  const invoiceFeeTotal = required<HTMLElement>('[data-invoice-fee-total]')
  const invoiceCeiling = required<HTMLElement>('[data-invoice-ceiling]')
  const invoiceCeilingUnit = required<HTMLSelectElement>('[data-invoice-ceiling-unit]')
  const invoiceCeilingAmount = required<HTMLInputElement>('[data-invoice-ceiling-amount]')
  const invoiceCeilingHint = required<HTMLElement>('[data-invoice-ceiling-hint]')
  const invoiceOverageSummary = required<HTMLSelectElement>('[data-invoice-overage-summary]')
  const invoiceBandPreviewText = required<HTMLElement>('[data-invoice-band-preview]')
  const invoicePeriodMount = required<HTMLElement>('[data-invoice-period]')
  const invoiceAttachJournal = required<HTMLInputElement>('[data-invoice-attach-journal]')
  const invoiceJournalLevel = required<HTMLSelectElement>('[data-invoice-journal-level]')
  const invoiceJournalFormats = required<HTMLFieldSetElement>('[data-invoice-journal-formats]')
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
  invoicePeriodMount.appendChild(invoicePeriod.element)
  const invoiceClient = required<HTMLSelectElement>('[data-invoice-client]')
  const invoiceProjects = required<HTMLElement>('[data-invoice-projects]')
  const invoiceExpenseSummary = required<HTMLSelectElement>('[data-invoice-expense-summary]')
  const invoiceExpenseHint = required<HTMLElement>('[data-invoice-expense-hint]')
  const invoiceResult = required<HTMLElement>('[data-invoice-generation-result]')
  const invoiceSubmit = required<HTMLButtonElement>('[data-invoice-generation-submit]')
  const invoiceRetry = required<HTMLButtonElement>('[data-retry-invoice-catalog]')
  const clientDirectory = createClientDirectoryController(api)
  const projectDirectory = createProjectDirectoryController(api)
  const taskAdmin = createTaskAdminController(api)
  const roleAdmin = createRoleAdminController(api)
  const teamDirectory = createTeamDirectoryController(api)
  const calendar = createCalendarController()
  const staffPayments = createStaffPaymentsController(api)
  const dashboard = createDashboardController(api)
  // Reads only when the api offers the endpoint; an install without it still
  // serves the page and simply says it cannot load.
  const activity = createActivityController({
    listActivityLog: async (query, signal) =>
      api.listActivityLog === undefined
        ? { data: [] }
        : api.listActivityLog(query, signal),
  })
  // Same shape as the activity controller above: an install whose api does not
  // offer these still serves the page and says it cannot load, rather than the
  // shell failing to construct.
  const deliveries = createDeliveriesController({
    listEmailLog: async (query, signal) =>
      api.listEmailLog === undefined ? { data: [] } : api.listEmailLog(query, signal),
    listOutboxDeliveries: async (query, signal) =>
      api.listOutboxDeliveries === undefined
        ? { data: [] }
        : api.listOutboxDeliveries(query, signal),
    retryOutboxDelivery: async (subscriberId, eventId, signal) =>
      api.retryOutboxDelivery === undefined
        ? undefined
        : api.retryOutboxDelivery(subscriberId, eventId, signal),
  })
  const reports = createReportsController(api, {
    editTimeEntry: (entryId, onChanged) => editReportedEntry(entryId, onChanged),
  })
  const expenseWorkflow = createExpenseWorkflowController(api)
  const expenseCategories = createExpenseCategoryDirectoryController(api)
  const emailConfiguration = createEmailConfigurationController(api)
  const recurringWorkspace = createRecurringWorkspaceController(api)
  const recurringEditor = createRecurringEditorController(api)
  const estimateWorkspace = createEstimateWorkspaceController(api)
  const retainerWorkspace = createRetainerWorkspaceController(api)
  const moduleSettings = createModuleSettingsController(api)
  const invoicePayments = createInvoicePaymentController(api)
  const invoiceEditor = createInvoiceEditorController(api)
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
  const orgTimezone = required<HTMLSelectElement>('[data-org-timezone]')
  const orgTimezoneForm = required<HTMLFormElement>('[data-org-timezone-form]')
  const orgTimezoneSubmit = required<HTMLButtonElement>('[data-org-timezone-submit]')
  const orgTimezoneResult = required<HTMLElement>('[data-org-timezone-result]')
  const profileTimezone = required<HTMLSelectElement>('[data-profile-timezone]')
  const profileTimezoneForm = required<HTMLFormElement>('[data-profile-timezone-form]')
  const profileTimezoneSubmit = required<HTMLButtonElement>('[data-profile-timezone-submit]')
  const profileTimezoneResult = required<HTMLElement>('[data-profile-timezone-result]')
  const profileTimezoneHint = required<HTMLElement>('[data-profile-timezone-hint]')
  const lockPolicySubmit = required<HTMLButtonElement>('[data-lock-policy-submit]')
  const manualLockForm = required<HTMLFormElement>('[data-manual-lock-form]')
  const manualLockThrough = required<HTMLInputElement>('[data-manual-lock-through]')
  const manualLockReason = required<HTMLTextAreaElement>('[data-manual-lock-reason]')
  const manualLockSubmit = required<HTMLButtonElement>('[data-manual-lock-submit]')
  const lockPolicyResult = required<HTMLElement>('[data-lock-policy-result]')
  const timesheetLockList = required<HTMLElement>('[data-timesheet-lock-list]')
  // Filled here, before anything can render a policy or a profile into either
  // control: `showTimezone` needs the list in place to know whether the zone it
  // is given is one the engine enumerates.
  const timezones = timezoneNames()
  for (const control of [orgTimezone, profileTimezone]) {
    control.append(...timezones.map((zone) => timezoneOption(zone)))
  }
  const requestedView = new URL(globalThis.location.href).searchParams.get('view')
  document.documentElement.dataset.timeView =
    requestedView === 'day' || requestedView === 'calendar' ? requestedView : 'week'
  markTimeViewTab()
  const cellStates = new Map<string, CellSaveState>()
  let within = initialWithin()
  /**
   * Whose week Time shows when it is not the signed-in person's (issue 917): the
   * teammate an administrator picked. The grid, its editor, Add row and Copy
   * last week then read and write that person's time; the header timer stays
   * yours. Null is your own week, and every sign-in starts there.
   */
  let viewedPerson: { readonly id: number; readonly name: string } | null = null
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
  /**
   * Issue 731. Set once a sign-in comes back asking for a second factor. The
   * string is the challenge token for clients that keep no cookies; the empty
   * string means the token is in the HttpOnly cookie the server set, which is
   * how the magic-link redirect lands here. Null means no challenge is open.
   */
  let pendingChallenge: string | null = null
  let verifyingSecondFactor = false
  let authGeneration = 0
  let authController = new AbortController()
  let invoiceCatalog: {
    readonly clients: readonly GeneralResource[]
    readonly projects: readonly GeneralResource[]
  } | null = null
  let invoiceGenerationPending = false
  let invoiceExpenseCheck = 0
  /** What the last uninvoiced report said each project has waiting; null when unread. */
  let invoiceUninvoiced: ReadonlyMap<number, readonly UninvoicedCurrencyTotal[]> | null = null
  // What the organization attaches by default; the dialog writes an invoice's
  // own choice only when it differs, so following the default stays following.
  let invoiceJournalDefault: InvoiceJournalChoice = { level: false, formats: ['pdf'] }
  let invoiceExpenseChoice = invoiceExpenseSummary.value
  let invoiceCommandId: string | null = null
  let invoiceNextCursor: string | null = null
  let invoiceListRows: readonly Invoice[] = []
  /** Which states the list is asking the server for. Outstanding is the open question. */
  let invoiceFilter: 'outstanding' | 'overdue' | 'paid' | 'closed' | 'all' = 'outstanding'
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
  // The signed-in person's own timezone, or null for the 'UTC' the profile
  // column holds for anyone who never set one -- which is "unset", not a zone.
  let profileZone: string | null = null
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

  /**
   * Most months have no expenses, so the Expenses choice is greyed out unless
   * the selection has some to bill. Enabled is the fallback: a check that
   * cannot run (no report scope, an older server) leaves the choice to the
   * reader, as it always was, rather than silently dropping expenses.
   */
  const setInvoiceExpensesAvailable = (available: boolean): void => {
    if (available === !invoiceExpenseSummary.disabled) return
    if (available) {
      invoiceExpenseSummary.value = invoiceExpenseChoice
    } else {
      invoiceExpenseChoice = invoiceExpenseSummary.value
      invoiceExpenseSummary.value = ''
    }
    invoiceExpenseSummary.disabled = !available
    invoiceExpenseHint.hidden = available
    invoiceExpenseHint.textContent = available ? '' : 'No uninvoiced expenses for this selection.'
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

  /**
   * Whose rows the local empty-row layout belongs to: the week on screen, so a
   * teammate's week never picks up the rows you added to your own (issue 917).
   */
  const weekPersonId = (operation: AuthOperation): number =>
    viewedPerson?.id ?? operation.userId!

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
    // Whichever step is showing, exactly one of the two is: a password form
    // beside a code form is an invitation to answer the wrong one.
    signInForm.hidden = pendingChallenge !== null
    twoFactorForm.hidden = pendingChallenge === null
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
    twoFactorForm.hidden = true
    authenticatedShell.hidden = false
    authenticatedShell.inert = false
    authenticatedShell.setAttribute('aria-busy', 'false')
    document.documentElement.dataset.authState = 'authenticated'
    document.title = authenticatedDocumentTitle
  }

  const setTwoFactorPending = (pending: boolean): void => {
    twoFactorSubmit.disabled = pending
    twoFactorSubmit.textContent = pending ? 'Verifying…' : 'Verify'
    twoFactorForm.setAttribute('aria-busy', String(pending))
  }

  /**
   * `challenge` is the token for a client that keeps no cookies, or the empty
   * string when the server already set the HttpOnly one -- which is the case
   * for every browser, including the magic-link redirect that lands here with
   * no sign-in response to read at all.
   */
  const openTwoFactorStep = (challenge: string): void => {
    pendingChallenge = challenge
    signInResult.textContent = ''
    twoFactorResult.textContent = ''
    twoFactorCode.value = ''
    verifyingSecondFactor = false
    setTwoFactorPending(false)
    showSignedOutScreen()
    twoFactorCode.focus()
  }

  const closeTwoFactorStep = (message: string): void => {
    pendingChallenge = null
    verifyingSecondFactor = false
    setTwoFactorPending(false)
    twoFactorForm.reset()
    twoFactorResult.textContent = ''
    transitionSignedOut(message)
  }

  const setSignInPending = (pending: boolean): void => {
    signInSubmit.disabled = pending
    signInSubmit.textContent = pending ? 'Signing in…' : 'Sign in'
    signInForm.setAttribute('aria-busy', String(pending))
    if (!authGateway.hidden) authGateway.dataset.state = pending ? 'signing-in' : 'signed-out'
  }

  const clearFormState = (): void => {
    signInForm.reset()
    twoFactorForm.reset()
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
    invoiceRetry.hidden = true
    invoiceNewDialog.close()
    invoiceCatalog = null
    invoiceExpenseCheck += 1
    invoiceUninvoiced = null
    // The form reset emptied the fee; one line is where a new one starts.
    for (const row of invoiceFeeRows().slice(1)) row.remove()
    renumberInvoiceFeeLines()
    setInvoiceExpensesAvailable(true)
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
    profileZone = null
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
    // Every sign-in starts on your own week, with the picker filled again only
    // for an administrator (issue 917).
    viewedPerson = null
    timePerson.disabled = true
    timePersonField.hidden = true
    renderTimePerson()
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
    // The assignment controls hold the previous account's project and task
    // names. They were a datalist rebuilt from the snapshot; as selects they
    // keep their options until something replaces them, and "until something
    // replaces them" spans a sign-out.
    entryProject.replaceChildren()
    entryTask.replaceChildren()
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

  // The identity card leads with the person's name (it read "User #1"). The
  // profile carries it; until it answers, or where a server sends none, the
  // role stands in, and the address shows on hover.
  const showIdentityName = (
    profile: { first_name?: string; last_name?: string; email?: string | null } | null,
  ): void => {
    const nameElement = required<HTMLElement>('[data-current-name]')
    const fullName = [profile?.first_name, profile?.last_name]
      .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
      .join(' ')
    const name = fullName !== '' ? fullName : (profile?.email ?? '')
    nameElement.textContent = name
    nameElement.hidden = name === ''
    const card = nameElement.closest<HTMLElement>('[data-current-identity]')
    if (card !== null) {
      if (typeof profile?.email === 'string' && profile.email !== '') card.title = profile.email
      else card.removeAttribute('title')
    }
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
    showIdentityName(null)
    // After this returns, so the loader below is defined; the card shows the
    // role until the profile answers.
    queueMicrotask(() => loadIdentityName(operation))
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
      '[data-staff-payments-nav], [data-settings-company-tab], [data-settings-activity-tab], [data-settings-templates-tab], [data-settings-roles-tab], [data-settings-deliveries-tab]',
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

  /**
   * Your own payout destination, on the one page that is yours (issues 421 and 543).
   *
   * The person page carries the same panel for accounting, but a member cannot
   * read the team directory at all -- so without this, the person who actually
   * has the Wisetag had nowhere to enter it and somebody else had to do it for
   * them. Which is the opposite of asking them to share it.
   */
  const wireUserPayout = (identity: Readonly<Whoami>): void => {
    const section = document.querySelector<HTMLElement>('[data-settings-payout]')
    const read = api.getWisePayoutDestination
    if (section === null || read === undefined) return
    const status = required<HTMLElement>('[data-settings-payout-status]')
    const unconfigured = required<HTMLElement>('[data-settings-payout-unconfigured]')
    const current = required<HTMLElement>('[data-settings-payout-current]')
    const summary = required<HTMLElement>('[data-settings-payout-summary]')
    const unverified = required<HTMLElement>('[data-settings-payout-unverified]')
    const remove = required<HTMLButtonElement>('[data-settings-payout-remove]')
    const form = required<HTMLFormElement>('[data-settings-payout-form]')
    const result = required<HTMLElement>('[data-settings-payout-result]')
    const submit = required<HTMLButtonElement>('[data-settings-payout-submit]')
    section.hidden = false
    // The public demo pays nobody (issue 931). It has no Wise to ask, so the
    // read could only fail; it says why instead, and offers no form.
    if (isDemoDeployment()) {
      form.hidden = true
      status.textContent = demoUnavailable('Setting where you are paid')
      return
    }

    const paint = (state: PayoutDestinationState): void => {
      unconfigured.hidden = state.configured
      const destination = state.destination
      current.hidden = destination === null
      form.hidden = destination !== null || !state.configured
      if (destination === null) {
        status.textContent = state.configured
          ? 'Nobody has been told where to pay you yet.'
          : ''
        return
      }
      status.textContent = ''
      summary.textContent = payoutSummary(destination)
      // Unverified means Wise never confirmed the identifier resolves, and
      // paying against that is the failure the store exists to prevent.
      unverified.hidden = destination.verifiedAt !== null
    }

    const reload = async (): Promise<void> => {
      try {
        paint(await read(identity.user_id))
      } catch {
        // Its own line, in its own section. A payout destination that will not
        // load is not a reason to take the rest of the settings page down.
        status.textContent = 'Your payout destination could not be loaded.'
      }
    }

    const share = api.shareWiseProfile
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (share === undefined) return
      const data = new FormData(form)
      const identifier = String(data.get('identifier') ?? '').trim()
      const currency = String(data.get('currency') ?? '').trim().toUpperCase()
      if (identifier === '' || !/^[A-Za-z]{3}$/u.test(currency)) {
        result.textContent = 'Enter your Wisetag, email or phone, and a three-letter currency.'
        return
      }
      submit.disabled = true
      result.textContent = 'Asking Wise…'
      void (async () => {
        try {
          const shared = await share({ userId: identity.user_id, identifier, currency })
          // Wise's own answer for whose profile that is. Shown back because a
          // mistyped tag that resolves resolves to somebody else.
          result.textContent =
            shared.name === null
              ? 'Payout destination saved.'
              : `Payout destination saved: Wise says that is ${shared.name}.`
          form.reset()
          await reload()
        } catch (error) {
          result.textContent = payoutFailure(error)
        } finally {
          submit.disabled = false
        }
      })()
    })

    const detach = api.removeWisePayoutDestination
    remove.addEventListener('click', () => {
      if (detach === undefined) return
      remove.disabled = true
      result.textContent = 'Removing…'
      void (async () => {
        try {
          await detach(identity.user_id)
          result.textContent = 'Payout destination removed.'
          await reload()
        } catch (error) {
          result.textContent = payoutFailure(error)
        } finally {
          remove.disabled = false
        }
      })()
    })

    void reload()
  }

  /**
   * The tokens you have issued (issue 485).
   *
   * Issuing one has been a terminal job: the endpoints shipped and no control
   * reached them. They are scoped to the acting user by the routes themselves,
   * so this belongs on the page that is yours rather than on the company one.
   */
  const wireApiTokens = (identity: Whoami): void => {
    const section = document.querySelector<HTMLElement>('[data-settings-tokens]')
    const read = api.listApiTokens
    if (section === null || read === undefined) return
    // The form offered every scope to everyone and the server refused the
    // ones a profile cannot grant with a flat 403, so a member ticking
    // "Write projects" was told their profile could not grant "one or more"
    // and left to guess which. The rule the server applies is in core; the
    // boxes follow it, so what can be ticked is what can be issued.
    for (const box of section.querySelectorAll<HTMLInputElement>('input[name="scopes"]')) {
      const grantable =
        isApiScope(box.value) && canProfileUseApiScope(identity.profile, box.value)
      box.disabled = !grantable
      box.checked = box.checked && grantable
      const label = box.closest('label')
      if (label !== null) {
        label.classList.toggle('team-check--unavailable', !grantable)
        label.title = grantable ? '' : `Your ${profileLabel(identity.profile)} profile cannot grant this scope.`
      }
    }
    const status = required<HTMLElement>('[data-settings-tokens-status]')
    const table = required<HTMLElement>('[data-settings-tokens-table]')
    const form = required<HTMLFormElement>('[data-settings-token-form]')
    const result = required<HTMLElement>('[data-settings-token-result]')
    const submit = required<HTMLButtonElement>('[data-settings-token-submit]')
    const issued = required<HTMLDialogElement>('[data-settings-token-issued]')
    const issuedValue = required<HTMLElement>('[data-settings-token-value]')
    const toggle = required<HTMLButtonElement>('[data-settings-token-toggle]')
    const copy = required<HTMLButtonElement>('[data-settings-token-copy]')
    const copied = required<HTMLElement>('[data-settings-token-copied]')
    section.hidden = false

    // The value is shown once and then never again, so it has to land where
    // the person is looking. It used to be printed under the form: the table
    // above repainted a moment later, everything below it moved down, and the
    // one thing worth reading left the screen (issue 855). A modal does not
    // move when the page behind it does. The value is masked behind an eye so
    // a shared screen does not print it, and Copy takes the real value either
    // way. Closing the dialog drops the value: there is no second look.
    let issuedToken = ''
    const showIssued = (revealed: boolean): void => {
      issuedValue.textContent = revealed ? issuedToken : '•'.repeat(24)
      toggle.setAttribute('aria-pressed', String(revealed))
      toggle.setAttribute('aria-label', revealed ? 'Hide token' : 'Show token')
    }
    toggle.addEventListener('click', () => {
      showIssued(toggle.getAttribute('aria-pressed') !== 'true')
    })
    copy.addEventListener('click', () => {
      void navigator.clipboard
        .writeText(issuedToken)
        .then(() => {
          copied.textContent = 'Copied.'
        })
        .catch(() => {
          // Clipboard needs a secure context and permission; failing that,
          // reveal it so it can still be selected by hand.
          showIssued(true)
          copied.textContent = 'Could not copy. Select the token and copy it yourself.'
        })
    })
    issued.addEventListener('close', () => {
      issuedToken = ''
      issuedValue.textContent = ''
      copied.textContent = ''
    })

    const paint = (tokens: readonly ApiToken[]): void => {
      const live = tokens.filter((token) => token.revoked_at === null)
      status.textContent = live.length === 0 ? 'You have no API tokens.' : ''
      table.hidden = live.length === 0
      if (live.length === 0) {
        table.replaceChildren()
        return
      }
      table.replaceChildren(
        renderDataTable<ApiToken>({
          caption: 'API tokens',
          rows: [...live],
          rowKey: (token) => String(token.id),
          columns: [
            { key: 'name', label: 'Name', render: (token) => token.name },
            // The hint, never the token: the value is stored hashed and shown
            // once, and a screen that could print it again would mean it was
            // recoverable.
            { key: 'hint', label: 'Token', render: (token) => token.token_hint },
            {
              key: 'scopes',
              label: 'Scopes',
              render: (token) => token.scopes.join(', '),
            },
            {
              key: 'used',
              label: 'Last used',
              // A token nobody has ever used is the one worth revoking, and
              // "never" says that where an empty cell reads as a loading bug.
              render: (token) => token.last_used_at ?? 'Never',
            },
            {
              key: 'expires',
              label: 'Expires',
              render: (token) => token.expires_at ?? 'Never',
            },
          ],
          actions: (token) => [
            {
              label: 'Revoke',
              primary: true,
              disabled: api.revokeApiToken === undefined,
              onSelect: () => {
                const revoke = api.revokeApiToken
                if (revoke === undefined) return
                result.textContent = 'Revoking…'
                void revoke(token.id)
                  .then(async () => {
                    result.textContent = `Revoked ${token.name}.`
                    paint(await read())
                  })
                  .catch(() => {
                    result.textContent = 'The token could not be revoked.'
                  })
              },
            },
          ],
        }),
      )
    }

    const reload = async (): Promise<void> => {
      try {
        paint(await read())
      } catch {
        table.hidden = true
        status.textContent = 'Your API tokens could not be loaded.'
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const create = api.createApiToken
      if (create === undefined) return
      const data = new FormData(form)
      const name = String(data.get('name') ?? '').trim()
      const scopes = data.getAll('scopes').map(String)
      const expires = String(data.get('expires_at') ?? '').trim()
      if (name === '' || scopes.length === 0) {
        result.textContent = 'Name the token and tick at least one scope.'
        return
      }
      // Said here, by name, before the request: the boxes are disabled above,
      // but a stale page or a hand-built form can still send one.
      const refused = scopes.filter(
        (scope) => !isApiScope(scope) || !canProfileUseApiScope(identity.profile, scope),
      )
      if (refused.length > 0) {
        result.textContent = `Your ${profileLabel(identity.profile)} profile cannot grant ${refused.join(', ')}.`
        return
      }
      submit.disabled = true
      result.textContent = 'Issuing…'
      void (async () => {
        try {
          const token = await create({
            name,
            scopes: scopes as CreateApiTokenInput['scopes'],
            // The date control yields a day; the route wants a canonical
            // timestamp. The token stays good through the day that was picked,
            // which is what a person choosing a date means by it.
            ...(expires === '' ? {} : { expires_at: `${expires}T23:59:59Z` }),
          })
          // Once. The value is stored hashed, so this is the only moment it
          // exists anywhere a person can read it.
          issuedToken = token.token
          showIssued(false)
          result.textContent = `Issued ${token.name}.`
          form.reset()
          open(issued)
          await reload()
        } catch (error) {
          result.textContent =
            error instanceof EzactoApiError && error.status === 403
              ? `Your ${profileLabel(identity.profile)} profile cannot grant one or more of those scopes.`
              : (apiFieldMessage(error) ?? 'The token could not be issued.')
        } finally {
          submit.disabled = false
        }
      })()
    })

    void reload()
  }

  /** A definition list, written the way `renderUserSettings` writes its own. */
  const writeFacts = (
    target: HTMLElement,
    rows: readonly (readonly [string, string])[],
  ): void => {
    target.replaceChildren(
      ...rows.flatMap(([label, value]) => {
        const term = document.createElement('dt')
        term.textContent = label
        const detail = document.createElement('dd')
        detail.textContent = value
        return [term, detail]
      }),
    )
    target.hidden = false
  }

  /**
   * Two-step sign-in (issue 485).
   *
   * An instance can require a second factor and nothing in the app could set
   * one up, so enrolment was a terminal job for the people least likely to have
   * one open. Nothing about signing in changes until a code from the
   * authenticator is accepted, which is why the confirm step is the whole shape
   * of this rather than a formality after it.
   */
  const wireTwoFactor = (): void => {
    const section = document.querySelector<HTMLElement>('[data-settings-2fa]')
    const read = api.getTwoFactorStatus
    if (section === null || read === undefined) return
    const status = required<HTMLElement>('[data-settings-2fa-status]')
    const factsList = required<HTMLElement>('[data-settings-2fa-facts]')
    const begin = required<HTMLButtonElement>('[data-settings-2fa-begin]')
    const enrolment = required<HTMLElement>('[data-settings-2fa-enrolment]')
    const secret = required<HTMLElement>('[data-settings-2fa-secret]')
    const uri = required<HTMLElement>('[data-settings-2fa-uri]')
    const recovery = required<HTMLElement>('[data-settings-2fa-recovery]')
    const confirmForm = required<HTMLFormElement>('[data-settings-2fa-confirm-form]')
    const confirmResult = required<HTMLElement>('[data-settings-2fa-confirm-result]')
    const disableForm = required<HTMLFormElement>('[data-settings-2fa-disable-form]')
    const disableResult = required<HTMLElement>('[data-settings-2fa-disable-result]')
    section.hidden = false
    // Everyone on the public demo signs in as the same people (issue 931): a
    // second factor one visitor sets up is the next one locked out, and one
    // removed is a published account left open. The state is shown; neither
    // control is offered.
    const demo = isDemoDeployment()

    const paint = (state: TwoFactorStatus): void => {
      writeFacts(factsList, [
        [
          'Status',
          state.enrolled
            ? 'On'
            : state.pending_confirmation
              ? 'Started, not finished'
              : 'Off',
        ],
        [
          'Recovery codes left',
          state.enrolled ? String(state.recovery_codes_remaining) : '—',
        ],
      ])
      begin.hidden = demo || state.enrolled
      begin.textContent = state.pending_confirmation
        ? 'Start again'
        : 'Set up two-step sign-in'
      disableForm.hidden = demo || !state.enrolled
      // An unfinished enrolment cannot be resumed: the secret was shown once
      // and is not readable back, so the only honest offer is to start again.
      status.textContent = state.pending_confirmation
        ? 'An earlier setup was never finished. Starting again replaces it.'
        : ''
      // Running low is worth saying before the last one is used, because the
      // moment they matter is the moment the authenticator is gone.
      if (state.enrolled && state.recovery_codes_remaining <= 2) {
        status.textContent =
          'Few recovery codes left. Turn two-step sign-in off and on again to get a fresh set.'
      }
      if (demo) status.textContent = demoUnavailable('Changing two-step sign-in')
    }

    const reload = async (): Promise<void> => {
      try {
        paint(await read())
      } catch {
        factsList.hidden = true
        status.textContent = 'Two-step sign-in could not be loaded.'
      }
    }

    begin.addEventListener('click', () => {
      const start = api.beginTwoFactorEnrolment
      if (start === undefined) return
      begin.disabled = true
      void (async () => {
        try {
          const started = await start()
          secret.textContent = started.secret
          uri.textContent = started.otpauth_uri
          // Shown once, here. Each works one time, and they are the only way
          // back in once the authenticator is gone.
          recovery.replaceChildren(
            ...started.recovery_codes.map((code) => {
              const item = document.createElement('li')
              item.textContent = code
              return item
            }),
          )
          enrolment.hidden = false
          begin.hidden = true
          confirmResult.textContent = ''
        } catch {
          status.textContent = 'Two-step sign-in could not be started.'
        } finally {
          begin.disabled = false
        }
      })()
    })

    confirmForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const confirm = api.confirmTwoFactorEnrolment
      if (confirm === undefined) return
      const code = String(new FormData(confirmForm).get('code') ?? '').trim()
      if (code === '') {
        confirmResult.textContent = 'Enter the code your authenticator is showing.'
        return
      }
      confirmResult.textContent = 'Checking…'
      void (async () => {
        try {
          paint(await confirm(code))
          // Gone from the screen the moment it takes effect: the codes were a
          // one-time reveal, and leaving them up invites them being left up.
          enrolment.hidden = true
          recovery.replaceChildren()
          secret.textContent = ''
          uri.textContent = ''
          confirmForm.reset()
          confirmResult.textContent = ''
        } catch {
          confirmResult.textContent =
            'That code was not accepted. Two-step sign-in is not on yet.'
        }
      })()
    })

    disableForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const disable = api.disableTwoFactor
      if (disable === undefined) return
      const code = String(new FormData(disableForm).get('code') ?? '').trim()
      if (code === '') {
        disableResult.textContent = 'Enter a current code to turn it off.'
        return
      }
      disableResult.textContent = 'Checking…'
      void (async () => {
        try {
          paint(await disable(code))
          disableForm.reset()
          disableResult.textContent = 'Two-step sign-in is off.'
        } catch {
          disableResult.textContent =
            'That code was not accepted. Two-step sign-in is still on.'
        }
      })()
    })

    void reload()
  }

  const renderUserSettings = (identity: Readonly<Whoami>): void => {
    revealCompanySettings(identity)
    const facts = document.querySelector<HTMLElement>('[data-settings-user-facts]')
    const settingsStatus = document.querySelector<HTMLElement>('[data-settings-user-status]')
    if (facts === null || settingsStatus === null) return
    const rows: readonly (readonly [string, string])[] = [
      // The name the identity card already resolved, or the id where none came.
      [
        'Signed in as',
        document.querySelector<HTMLElement>('[data-current-name]')?.textContent?.trim() ||
          `User #${identity.user_id}`,
      ],
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
    wireUserPayout(identity)
    wireApiTokens(identity)
    wireTwoFactor()
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

  /**
   * Says whose week is on screen (issue 917): the band naming the teammate, with the
   * way back. The header's Log time logs your own time, so it is not offered
   * while somebody else's week is open -- typing into their grid is how their
   * time is logged.
   */
  const renderTimePerson = (): void => {
    timePersonBanner.hidden = viewedPerson === null
    timePersonBannerText.textContent =
      viewedPerson === null ? '' : `Editing ${viewedPerson.name}'s timesheet`
    for (const trigger of document.querySelectorAll<HTMLElement>('[data-time-log-time]')) {
      trigger.hidden = viewedPerson !== null
    }
  }

  /**
   * The picker an administrator opens a teammate's week with (issue 917), filled
   * with everyone active but themselves. Nobody else is shown it, and a build
   * that cannot list people shows it to nobody.
   */
  const loadTimePeople = async (identity: Whoami, operation: AuthOperation): Promise<void> => {
    const listUsers = api.listDirectoryUsers
    if (!timePage || !canManageTeammateTime(identity.profile) || listUsers === undefined) return
    try {
      const people: GeneralResource[] = []
      let cursor: string | undefined
      do {
        const page = await listUsers(cursor, operation.signal)
        people.push(...page.data)
        cursor = page.page.next_cursor ?? undefined
      } while (cursor !== undefined)
      if (!isSessionCurrent(operation)) return
      const yours = document.createElement('option')
      yours.value = ''
      yours.textContent = 'Yours'
      timePerson.replaceChildren(
        yours,
        ...timePersonChoices(people, identity.user_id).map((person) =>
          option(person.id, person.name),
        ),
      )
      timePerson.value = viewedPerson === null ? '' : String(viewedPerson.id)
      timePerson.disabled = false
      timePersonField.hidden = false
    } catch (error) {
      handleSessionFailure(error, operation)
    }
  }

  /** Opens somebody's week, or yours with null, in the same grid and editor. */
  const showTimePerson = (person: { readonly id: number; readonly name: string } | null): void => {
    const operation = sessionOperation()
    if (operation === null || operation.userId === null) return
    viewedPerson = person
    timePerson.value = person === null ? '' : String(person.id)
    if (entryDialog.open) entryDialog.close()
    activeEntry = null
    cellStates.clear()
    supplementalRows = loadSupplementalRows(weekPersonId(operation), within, weekStartDay)
    renderTimePerson()
    void loadWeek(operation)
  }

  timePerson.addEventListener('change', () => {
    const chosen = timePerson.options[timePerson.selectedIndex]
    showTimePerson(
      timePerson.value === '' || chosen === undefined
        ? null
        : { id: Number(timePerson.value), name: chosen.textContent ?? '' },
    )
  })
  required<HTMLButtonElement>('[data-time-person-reset]').addEventListener('click', () =>
    showTimePerson(null),
  )

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
   * Real selects, as the Add-row form in this same file has always used.
   *
   * These were text inputs with a datalist, and the popup was unusable for the
   * reason a datalist always is once the box holds a complete value: the
   * browser filters the list by what is typed, so a field pre-filled with the
   * exact label offers the one option already chosen and reads as empty. Both
   * reports say so -- the project list "not displaying when clicked" and the
   * task dropdown showing "no options" while a value sits in the box (issues
   * 497 and 506). No DOM test can see it; the popup is chrome, not markup.
   *
   * The option value stays the label rather than the id, so everything reading
   * `entryProject.value` downstream is untouched -- the control changed, the
   * contract did not.
   */
  const suggestion = (label: string): HTMLOptionElement => {
    const element = document.createElement('option')
    element.value = label
    element.textContent = label
    return element
  }

  /**
   * A select can only hold a value it offers. An entry on an archived
   * assignment would otherwise silently reset to the first project in the list,
   * which is a wrong entry rather than a refused one.
   */
  const withHeldValue = (
    options: readonly HTMLOptionElement[],
    held: string,
  ): HTMLOptionElement[] => {
    if (held === '' || options.some((option) => option.value === held)) return [...options]
    const kept = suggestion(held)
    kept.dataset.entryUnavailable = 'true'
    return [kept, ...options]
  }

  /**
   * The project/task pairs the open editor offers: its owner's when it writes
   * somebody else's time (issue 917), otherwise the week's.
   */
  const editorOptions = (): readonly TimeEntryOption[] =>
    activeEntry?.owner?.options ?? snapshot?.catalog.timeEntryOptions ?? []

  /**
   * `wanted` is the assignment an entry already has, as opposed to whatever the
   * two controls happen to be showing.
   *
   * The editor is one instance reused for every entry, so when it opens on a
   * second entry the task list is still narrowed to the *previous* entry's
   * project. Assigning `entryTask.value` first and reading it back here -- which
   * is what this did -- loses the assignment silently, because a select drops a
   * value it does not offer. The entry then opened with an empty activity, and
   * on a project whose list is one task long it read as the control refusing to
   * take a selection (issue 494).
   *
   * Passing it in also separates the two reasons this runs. Opening an entry
   * shows what that entry *is*, archived assignment and all -- `withHeldValue`
   * keeps it and marks it unavailable. Changing the project is a person saying
   * they want something else, and there the old task must go.
   */
  const updateEntrySuggestions = (wanted?: {
    readonly project: string
    readonly task: string
  }): void => {
    if (snapshot === null) return
    const offered = editorOptions()
    const projectIds = new Set(offered.map((entry) => entry.project_id))
    const projects = snapshot.catalog.projects.filter((resource) =>
      projectIds.has(resource.id),
    )
    const heldProject = wanted?.project ?? entryProject.value
    entryProject.replaceChildren(
      ...withHeldValue(
        projects.map((resource) => suggestion(resourceLabel(resource))),
        heldProject,
      ),
    )
    entryProject.value = heldProject
    // Tasks narrow to the typed project when it resolves, and otherwise offer
    // every task that is assigned somewhere — better than nothing while the
    // project box is still empty.
    const typed = entryProject.value.trim()
    const matched = projects.find(
      (resource) => resourceLabel(resource).toLowerCase() === typed.toLowerCase(),
    )
    const taskIds = new Set(
      offered
        .filter((entry) => matched === undefined || entry.project_id === matched.id)
        .map((entry) => entry.task_id),
    )
    const available = snapshot.catalog.tasks.filter((resource) => taskIds.has(resource.id))
    // Decided before the options are built, not after. A task the chosen
    // project does not offer must not survive as an option -- keeping it is how
    // an entry gets submitted against a project that never had that task.
    const currentTask = wanted?.task ?? entryTask.value
    const heldTask =
      wanted === undefined &&
      matched !== undefined &&
      currentTask.trim() !== '' &&
      !available.some(
        (resource) => resourceLabel(resource).toLowerCase() === currentTask.trim().toLowerCase(),
      )
        ? ''
        : currentTask
    entryTask.replaceChildren(
      ...withHeldValue(
        available.map((resource) => suggestion(resourceLabel(resource))),
        heldTask,
      ),
    )
    entryTask.value = heldTask
  }

  entryProject.addEventListener('change', () => updateEntrySuggestions())

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
    // Submitting, reopening or withdrawing a week is its owner's to do, and the
    // submission loaded beside it is the signed-in person's: on a teammate's
    // week (issue 917) none of it applies.
    timesheetStatus.hidden = !approvalModuleAvailable || viewedPerson !== null
    if (timesheetStatus.hidden) return
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
    if (document.activeElement !== orgTimezone) showTimezone(orgTimezone, lockPolicy.timezone)
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

  const removeEmptyRow = (seed: WeekRowSeed): void => {
    const operation = sessionOperation()
    if (operation === null || operation.userId === null) return
    const key = `${seed.projectId}:${seed.taskId}`
    const row = grid?.rows.find((candidate) => candidate.key === key)
    if (row === undefined || row.cells.some((cell) => cell.entries.length > 0)) return
    const unfinished = row.cells.some((cell) => {
      const state = cellStates.get(cell.key)
      return state !== undefined && state.state !== 'saved' && state.state !== 'removed'
    })
    if (unfinished) {
      setSessionStatus('Save or clear this row’s unfinished edits before removing it.', 'ready')
      return
    }
    supplementalRows = supplementalRows.filter((candidate) =>
      candidate.projectId !== seed.projectId || candidate.taskId !== seed.taskId,
    )
    for (const cell of row.cells) cellStates.delete(cell.key)
    saveSupplementalRows(weekPersonId(operation), within, supplementalRows, weekStartDay)
    render()
    setSessionStatus('Empty project/task row removed.', 'ready')
    required<HTMLButtonElement>('[data-add-row-trigger]').focus()
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
      openDay,
      startToday: startRowToday,
      removeRow: removeEmptyRow,
      stop: stopRowTimer,
      // A timer is its owner's to start (issue 917): a teammate's rows offer Stop on
      // a running timer and never Start, which a row only draws with restart.
      ...(api.restartTimeEntry === undefined || viewedPerson !== null
        ? {}
        : { restart: restartEntry }),
    }
    // The same data the grid draws, laid out on whichever axis the
    // organization's tracking mode makes true.
    calendar.render(grid.dates, snapshot.entries, snapshot.timeEntrySettings.time_entry_mode)
    // The server's today, as near as the shell can get: the person's own zone,
    // then the organization's where the session can read it (the lock policy
    // is an administrator's), then the browser's clock. The browser's clock
    // alone marked a column the server would not file on whenever the two
    // disagreed on the date, and a timer started on that column's word landed
    // beside the entry the previous day already held.
    const today = filingDate([
      ...(profileZone === null ? [] : [profileZone]),
      ...(lockPolicy === null ? [] : [lockPolicy.timezone]),
    ])
    renderDayTotals(grid, selectedDay, selectDay, today)
    renderDesktopGrid(grid, handlers, today)
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

  // The zone a timer is filed on is the person's own before the organization's
  // (issue 651), and only `GET /profile` says what it is. Read with the week so
  // the grid's today is the server's, not the browser's.
  const loadProfileZone = async (operation: AuthOperation): Promise<string | null> => {
    if (api.getProfile === undefined) return null
    try {
      const profile = await api.getProfile(operation.signal)
      return profile.timezone === 'UTC' ? null : profile.timezone
    } catch (error) {
      // A session that has ended is the week's failure, not this read's. Any
      // other refusal or fault falls back to the browser's clock: the zone
      // decides which cell is today, and a week that cannot say is still a
      // week worth showing.
      if (error instanceof EzactoApiError && error.status === 401) throw error
      return null
    }
  }

  const stoppingTimers = new Set<number>()
  const stopRowTimer = async (entryId: number): Promise<void> => {
    const operation = sessionOperation()
    if (operation === null || stoppingTimers.has(entryId)) return
    stoppingTimers.add(entryId)
    try {
      await api.stopTimeEntry(entryId, operation.signal)
      if (!isSessionCurrent(operation)) return
      await refresh(operation)
    } catch (error: unknown) {
      if (handleSessionFailure(error, operation)) return
      status.textContent = messageFor(error)
    } finally {
      stoppingTimers.delete(entryId)
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

  /**
   * A row's Start where today carries no entry to continue. Neither
   * `spent_date` nor `seconds` is sent: that is the timer request the entry
   * editor already makes, and the date a running timer is filed under belongs
   * to the server, which derives it from the operator's timezone (then the
   * organization's) and refuses to be told one that disagrees.
   */
  const startRowToday = async (
    seed: WeekRowSeed,
    notes: string | null,
  ): Promise<void> => {
    const operation = sessionOperation()
    if (operation === null) return
    try {
      await api.createTimeEntry(
        {
          project_id: seed.projectId,
          task_id: seed.taskId,
          ...(notes === null ? {} : { notes }),
        },
        operation.signal,
      )
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
    const requestedPerson = viewedPerson
    const selectedDate =
      grid?.dates[selectedDay] ?? weekDates(requestedWithin, weekStartDay)[selectedDay]
    const loaded = await loadShellSnapshot(
      api,
      new Date(`${requestedWithin}T12:00:00`),
      operation.signal,
      requestedPerson?.id,
    )
    const loadedWeekStartDay = loaded.timeEntrySettings.week_start_day
    const [approval, policy, zone] = await Promise.all([
      loadApprovalData(operation, requestedWithin, loadedWeekStartDay),
      loadLockPolicyData(operation),
      loadProfileZone(operation),
    ])
    // A week that answers after the person on screen changed is somebody
    // else's week now, the same as one that answers after the week changed.
    if (
      !isSessionCurrent(operation) ||
      within !== requestedWithin ||
      viewedPerson !== requestedPerson
    ) {
      return false
    }
    weekStartDay = loadedWeekStartDay
    weekPeriod.setWeekStartDay(loadedWeekStartDay)
    // The generation wizard offers Week too, and was computing Monday-Sunday
    // regardless of the setting -- so on a Saturday-start organisation a draft
    // claimed work across two of its weeks, and the wizard's own label
    // disagreed with what the timesheet called the same week.
    invoicePeriod.setWeekStartDay(loadedWeekStartDay)
    snapshot = loaded
    // A module an administrator switched off is not offered in the strip
    // (issue 815), the way Approvals and Team already are not. Only hidden,
    // never removed: the route still answers with its own "unavailable" state
    // for anyone who kept a bookmark.
    for (const link of document.querySelectorAll<HTMLElement>('[data-expenses-nav]')) {
      link.hidden = !loaded.expensesAvailable
    }
    // Publish before anything renders: the week total, approval cards and the
    // running-timer elapsed all format seconds, and all of them run ahead of
    // the grid render where this used to be set.
    setActiveTimeFormat(loaded.timeEntrySettings.time_format)
    supplementalRows = loadSupplementalRows(weekPersonId(operation), within, weekStartDay)
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
    profileZone = zone
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
        const name = document.createElement('span')
        name.textContent = resourceLabel(project)
        const waiting = document.createElement('small')
        waiting.dataset.projectUninvoiced = String(project.id)
        label.append(input, name, waiting)
        return label
      }),
    )
  }

  /**
   * The period the dialog bills. All uninvoiced sends no start: the server
   * takes every billable row up to today and dates the draft from the earliest
   * one it consumed. The report the dialog reads to preview that has no open
   * start, so it is asked from a day older than any tracked work.
   */
  const invoiceRange = (): { readonly from: string | undefined; readonly to: string } => {
    const choice = invoiceForm.querySelector<HTMLInputElement>('[data-invoice-period-choice]:checked')
    return choice?.value === 'range' ? invoicePeriod.range() : { from: undefined, to: localDate() }
  }

  /**
   * The checked radio of a group, read from each radio's own state. A cached
   * `:checked` selector answers with the radio that was checked when the
   * markup was parsed in some DOM implementations, which is the wrong one the
   * moment a person picks another.
   */
  const checkedValue = (selector: string): string | undefined =>
    [...invoiceForm.querySelectorAll<HTMLInputElement>(selector)].find((input) => input.checked)
      ?.value

  const invoiceKind = (): 'tracked' | 'free_form' | 'banded' => {
    const kind = checkedValue('[data-invoice-kind]')
    return kind === 'free_form' || kind === 'banded' ? kind : 'tracked'
  }

  const invoiceSelectedProjectIds = (): number[] =>
    [...invoiceProjects.querySelectorAll<HTMLInputElement>('input[name="project"]:checked')]
      .map((input) => Number(input.value))
      .filter((projectId) => Number.isSafeInteger(projectId) && projectId > 0)

  /**
   * What a band's figures are written in: the selected projects' billing
   * currency, which is the client's unless a project bills in its own. Null
   * when the catalog does not say, and the figures print without a symbol.
   */
  const invoiceBandCurrency = (): string | null => {
    const currency = (value: unknown): string | null =>
      typeof value === 'string' && /^[A-Za-z]{3}$/u.test(value) ? value.toUpperCase() : null
    const selected = new Set(invoiceSelectedProjectIds())
    const project = invoiceCatalog?.projects.find((candidate) => selected.has(candidate.id))
    const client = invoiceCatalog?.clients.find(
      (candidate) => candidate.id === Number(invoiceClient.value),
    )
    return currency(project?.['billing_currency']) ?? currency(client?.['currency'])
  }

  const bandMoney = (cents: number): string => {
    const currency = invoiceBandCurrency()
    return currency === null ? (cents / 100).toFixed(2) : formatMoney(cents, currency)
  }

  const invoiceFeeRows = (): HTMLElement[] => [
    ...invoiceFeeLines.querySelectorAll<HTMLElement>('[data-invoice-fee-line]'),
  ]

  const invoiceFeeValues = (row: HTMLElement): InvoiceFeeLineValues => ({
    description: row.querySelector<HTMLInputElement>('[data-invoice-fee-description]')!.value,
    quantity: row.querySelector<HTMLInputElement>('[data-invoice-fee-quantity]')!.value,
    unitPrice: row.querySelector<HTMLInputElement>('[data-invoice-fee-unit-price]')!.value,
  })

  const invoiceBandValues = (): InvoiceBandValues => ({
    lines: invoiceFeeRows().map(invoiceFeeValues),
    claimMode: checkedValue('[data-invoice-claim-mode]') === 'ceiling' ? 'ceiling' : 'all',
    ceilingUnit: invoiceCeilingUnit.value === 'value' ? 'value' : 'hours',
    ceiling: invoiceCeilingAmount.value,
    overageSummary: invoiceOverageSummary.value,
  })

  /** The limit as typed, or null while it does not parse. */
  const invoiceBandLimit = (
    values: InvoiceBandValues,
  ): { readonly unit: 'seconds' | 'cents'; readonly value: number } | null => {
    try {
      if (values.ceilingUnit === 'hours') {
        return { unit: 'seconds', value: invoiceBandCeilingSeconds(values.ceiling) }
      }
      const cents = invoiceLineUnitPriceCents(values.ceiling)
      return cents < 1 ? null : { unit: 'cents', value: cents }
    } catch {
      return null
    }
  }

  /**
   * Each fee line's amount and the fee's total, in money, as they will be
   * saved -- and the limit read back the same way, so a figure typed as cents
   * shows as a hundredfold fee or limit before anything is sent.
   */
  const paintInvoiceBand = (): void => {
    const values = invoiceBandValues()
    let total = 0
    let complete = true
    for (const row of invoiceFeeRows()) {
      const cents = invoiceFeeLineAmountCents(invoiceFeeValues(row))
      const amount = row.querySelector<HTMLElement>('[data-invoice-fee-amount]')!
      amount.textContent = cents === null ? '—' : bandMoney(cents)
      markMoney(amount, cents !== null)
      if (cents === null) complete = false
      else total += cents
    }
    invoiceFeeTotal.textContent = complete ? bandMoney(total) : '—'
    markMoney(invoiceFeeTotal, complete)
    const limit = invoiceBandLimit(values)
    invoiceCeilingHint.textContent =
      values.ceilingUnit === 'hours'
        ? limit === null
          ? 'Hours, as 100, 99.5 or 99h30m.'
          : `Up to ${(limit.value / 3_600).toFixed(2)} h of the period's time.`
        : limit === null
          ? 'Work at list, as an amount like 4500.00.'
          : `Up to ${bandMoney(limit.value)} of work at list.`
    markMoney(invoiceCeilingHint, values.ceilingUnit === 'value' && limit !== null)
    if (invoiceKind() !== 'banded' || invoiceUninvoiced === null) {
      invoiceBandPreviewText.textContent = ''
      return
    }
    const totals = invoiceSelectedProjectIds().flatMap(
      (projectId) => invoiceUninvoiced?.get(projectId) ?? [],
    )
    invoiceBandPreviewText.textContent = invoiceBandPreview(
      {
        seconds: totals.reduce((sum, row) => sum + row.rounded_seconds, 0),
        cents: totals.every((row) => row.time_cents !== undefined)
          ? totals.reduce((sum, row) => sum + (row.time_cents ?? 0), 0)
          : null,
        unpricedEntries: totals.reduce((sum, row) => sum + row.unpriced_time_entry_count, 0),
      },
      values.claimMode,
      values.claimMode === 'ceiling' ? limit : null,
      bandMoney,
    )
  }

  const renumberInvoiceFeeLines = (): void => {
    const rows = invoiceFeeRows()
    for (const [index, row] of rows.entries()) {
      row.setAttribute('aria-label', `Fee line ${index + 1}`)
      const remove = row.querySelector<HTMLButtonElement>('[data-invoice-fee-remove]')!
      remove.setAttribute('aria-label', `Remove fee line ${index + 1}`)
      // A band has a fee, so its last line stays.
      remove.hidden = rows.length === 1
    }
  }

  const addInvoiceFeeLine = (): HTMLElement => {
    const row = invoiceFeeLineTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement
    invoiceFeeLines.append(row)
    renumberInvoiceFeeLines()
    paintInvoiceBand()
    return row
  }

  /** What each project has waiting, so choosing projects is not choosing blind. */
  const paintInvoiceProjectTotals = (
    rows: ReadonlyMap<number, readonly UninvoicedCurrencyTotal[]> | null,
  ): void => {
    for (const label of invoiceProjects.querySelectorAll<HTMLElement>('[data-project-uninvoiced]')) {
      const totals = rows?.get(Number(label.dataset.projectUninvoiced))
      if (rows === null) {
        label.replaceChildren()
      } else if (totals === undefined || totals.length === 0) {
        label.replaceChildren('Nothing uninvoiced')
      } else {
        label.replaceChildren(
          ...totals.flatMap((total, index) => [
            ...(index === 0 ? [] : [' + ']),
            total.total_cents === undefined
              ? `${(total.rounded_seconds / 3_600).toFixed(2)} h`
              : moneyText(formatMoney(total.total_cents, total.currency)),
          ]),
        )
      }
    }
  }

  const checkInvoiceExpenses = async (operation: AuthOperation): Promise<void> => {
    const check = ++invoiceExpenseCheck
    const clientId = Number(invoiceClient.value)
    const { from, to } = invoiceRange()
    const projectIds = new Set(
      [...invoiceProjects.querySelectorAll<HTMLInputElement>('input[name="project"]:checked')]
        .map((input) => Number(input.value)),
    )
    if (
      api.getUninvoicedReport === undefined ||
      !Number.isSafeInteger(clientId) ||
      clientId < 1 ||
      (from !== undefined && (!isCalendarDay(from) || from > to)) ||
      !isCalendarDay(to)
    ) {
      invoiceUninvoiced = null
      paintInvoiceProjectTotals(null)
      paintInvoiceBand()
      setInvoiceExpensesAvailable(true)
      return
    }
    try {
      const report = await api.getUninvoicedReport(
        { from: from ?? '1970-01-01', to, client_id: clientId },
        operation.signal,
      )
      if (!isSessionCurrent(operation) || check !== invoiceExpenseCheck) return
      invoiceUninvoiced = new Map(
        report.projects.map((project) => [project.project_id, project.totals]),
      )
      paintInvoiceProjectTotals(invoiceUninvoiced)
      paintInvoiceBand()
      const expenses = report.projects
        .filter((project) => projectIds.has(project.project_id))
        .flatMap((project) => project.totals)
        .reduce((sum, total) => sum + total.expense_count, 0)
      setInvoiceExpensesAvailable(expenses > 0)
    } catch {
      if (check !== invoiceExpenseCheck) return
      invoiceUninvoiced = null
      paintInvoiceProjectTotals(null)
      paintInvoiceBand()
      setInvoiceExpensesAvailable(true)
    }
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

  // The invoice list shows a client on every row, so it loads every client's
  // name, once. The invoice page shows one client and reads that one itself.
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

  const setInvoicePeriodChoice = (choice: 'all' | 'range'): void => {
    for (const input of invoiceForm.querySelectorAll<HTMLInputElement>('[data-invoice-period-choice]')) {
      input.checked = input.value === choice
    }
    syncInvoiceDialog()
  }

  const loadInvoiceJournalDefault = async (operation: AuthOperation): Promise<void> => {
    const journal = invoiceAttachJournal.closest<HTMLElement>('.invoice-new-journal')!
    if (api.setInvoiceJournal === undefined) {
      journal.hidden = true
      return
    }
    if (api.getOrganizationInvoiceJournal === undefined) return
    try {
      invoiceJournalDefault = await api.getOrganizationInvoiceJournal(operation.signal)
    } catch {
      // Unchecked is the safe reading: nothing is attached that was not asked for.
      return
    }
    if (!isSessionCurrent(operation)) return
    invoiceAttachJournal.checked = invoiceJournalDefault.level !== false
    invoiceJournalLevel.value =
      invoiceJournalDefault.level === false ? 'detailed' : invoiceJournalDefault.level
    for (const box of invoiceJournalFormats.querySelectorAll<HTMLInputElement>('input')) {
      box.checked = invoiceJournalDefault.formats.includes(box.value as 'pdf' | 'csv' | 'xlsx')
    }
    syncInvoiceDialog()
  }

  /** `null` when the report is wanted but no format is ticked. */
  const invoiceJournalChoice = (): InvoiceJournalChoice | null => {
    if (!invoiceAttachJournal.checked) return { level: false, formats: [] }
    const formats = [
      ...invoiceJournalFormats.querySelectorAll<HTMLInputElement>('input:checked'),
    ].map((box) => box.value as 'pdf' | 'csv' | 'xlsx')
    if (formats.length === 0) return null
    return { level: invoiceJournalLevel.value === 'summary' ? 'summary' : 'detailed', formats }
  }

  const sameInvoiceJournal = (
    left: InvoiceJournalChoice,
    right: InvoiceJournalChoice,
  ): boolean =>
    left.level === right.level &&
    (left.level === false ||
      [...left.formats].sort().join() === [...right.formats].sort().join())

  /**
   * Free form needs only the client; a band shares the projects and period
   * with a tracked draft and has its fee and limit where the summaries were. A
   * date range shows the period control, and a limit what is billed past it.
   */
  const syncInvoiceDialog = (): void => {
    const kind = invoiceKind()
    invoiceJournalLevel.hidden = !invoiceAttachJournal.checked
    invoiceJournalFormats.hidden = !invoiceAttachJournal.checked
    invoiceTracked.hidden = kind === 'free_form'
    invoiceTrackedOnly.hidden = kind !== 'tracked'
    invoiceBand.hidden = kind !== 'banded'
    invoiceCeiling.hidden = invoiceBandValues().claimMode !== 'ceiling'
    invoicePeriodMount.hidden =
      invoiceForm.querySelector<HTMLInputElement>('[data-invoice-period-choice]:checked')
        ?.value !== 'range'
    paintInvoiceBand()
  }

  const openInvoiceDialog = (operation: AuthOperation): void => {
    invoiceCommandId = null
    if (!invoiceGenerationPending) invoiceResult.textContent = ''
    syncInvoiceDialog()
    if (!invoiceNewDialog.open) invoiceNewDialog.showModal()
    if (invoiceCatalog === null) {
      if (!invoiceGenerationPending) void loadInvoiceGeneration(operation)
    } else if (invoiceKind() !== 'free_form') {
      void checkInvoiceExpenses(operation)
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
      void loadInvoiceJournalDefault(operation)
      invoiceClient.replaceChildren(
        ...clients.map((client) => option(client.id, resourceLabel(client))),
      )
      // Month-to-date, unchanged: the wizard has always opened on the 1st
      // through today, and the control simply presents that as the custom range
      // it is. Opening on the whole month instead would silently widen every
      // draft invoice generated from the default.
      const today = localDate()
      invoicePeriod.setRange({ from: `${today.slice(0, 8)}01`, to: today })
      const prefill = invoiceGenerationPrefill
      const prefilledClientId = Number(prefill.get('client_id'))
      if (
        Number.isSafeInteger(prefilledClientId) &&
        prefilledClientId > 0 &&
        clients.some((client) => client.id === prefilledClientId)
      ) {
        invoiceClient.value = String(prefilledClientId)
      }
      const prefilledFrom = prefill.get('from') ?? ''
      const prefilledTo = prefill.get('to') ?? ''
      if (
        isCalendarDay(prefilledFrom) &&
        isCalendarDay(prefilledTo) &&
        prefilledFrom <= prefilledTo
      ) {
        invoicePeriod.setRange({ from: prefilledFrom, to: prefilledTo })
        setInvoicePeriodChoice('range')
      }
      renderInvoiceProjects()
      const prefilledProjectId = Number(prefill.get('project_id'))
      if (Number.isSafeInteger(prefilledProjectId) && prefilledProjectId > 0) {
        const projectInputs = [
          ...invoiceProjects.querySelectorAll<HTMLInputElement>('input[name="project"]'),
        ]
        if (projectInputs.some((input) => Number(input.value) === prefilledProjectId)) {
          for (const input of projectInputs) {
            input.checked = Number(input.value) === prefilledProjectId
          }
        }
      }
      if (clients.length === 0) {
        invoiceResult.textContent = 'Create an active client before generating an invoice.'
        setInvoiceFormPending(false)
        invoiceSubmit.disabled = true
        return
      }
      invoiceResult.textContent = 'Review the selection, then generate a draft.'
      setInvoiceFormPending(false)
      void checkInvoiceExpenses(operation)
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
    const overdue = invoiceFilter === 'overdue'
    const today = localDate()
    const complete = invoiceNextCursor === null
    const matching = invoiceListRows.filter(
      (invoice) =>
        invoiceMatchesSearch(invoice, invoiceSearch.value) &&
        (!overdue ||
          (invoice.state === 'open' && invoice.due_amount_cents > 0 && invoice.due_date < today)),
    )
    invoiceListCount = renderInvoiceListItems(
      matching,
      searching
        ? 'No loaded invoices match that search.'
        : overdue
          ? complete ? 'No past-due invoices.' : 'No past-due invoices in the loaded pages.'
          : undefined,
    )
    invoiceListStatus.textContent = searching
      ? `${invoiceListCount} of ${invoiceListRows.length} loaded ${invoiceListRows.length === 1 ? 'invoice matches' : 'invoices match'}${complete ? '.' : '; load more to search the rest.'}`
      : overdue
        ? `${invoiceListCount} past-due ${invoiceListCount === 1 ? 'invoice' : 'invoices'}${complete ? '.' : ' in loaded pages; load more to check the rest.'}`
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
      openInvoiceDialog(authenticated)
      await Promise.all([loadInvoiceList(authenticated), loadWeek(authenticated)])
    } else if (invoiceListPage) {
      await Promise.all([loadInvoiceList(authenticated), loadWeek(authenticated)])
    } else if (invoiceDetailPage) {
      // The page names its one client itself. Racing the list of every client
      // for that name is what painted "Client #5" on a fresh load.
      await Promise.all([
        invoicePayments.activate(
          identity,
          authenticated.signal,
          (error) => handleSessionFailure(error, authenticated),
        ),
        loadWeek(authenticated),
      ])
    } else if (invoiceEditPage) {
      await Promise.all([
        invoiceEditor.activate(
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
    } else if (roleListPage) {
      await Promise.all([
        roleAdmin.activate(
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
    } else if (document.querySelector('[data-deliveries-page]:not([hidden])') !== null) {
      await Promise.all([deliveries.activate(authenticated.signal), loadWeek(authenticated)])
    } else if (document.documentElement.dataset.appView === 'staff-payments') {
      await staffPayments.activate(identity, authenticated.signal)
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
    } else if (invoiceRecurringEditorPage) {
      await Promise.all([
        recurringEditor.activate(
          identity,
          authenticated.signal,
          (error) => handleSessionFailure(error, authenticated),
        ),
        loadWeek(authenticated),
      ])
    } else if (invoiceEstimatesPage) {
      await Promise.all([
        estimateWorkspace.activate(
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
      await Promise.all([loadTimePeople(identity, authenticated), loadWeek(authenticated)])
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
      cellStates.delete(cell.key)
      focusCell(focus)
      return true
    }
    // Invalid syntax is a local editing state. Replacing the focused input and
    // focusing it again from a blur handler can start another blur/save cycle.
    let seconds: number
    try {
      seconds = parseCellSeconds(rawValue)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Use decimal hours or H:MM.'
      cellStates.set(cell.key, { ...current, state: 'invalid', rawValue, message })
      input.setAttribute('aria-invalid', 'true')
      const wrapper = input.closest<HTMLElement>('.week-cell')
      if (wrapper !== null) {
        wrapper.dataset.cellState = 'invalid'
        const status = wrapper.querySelector<HTMLElement>('.cell-status')
        if (status !== null) status.textContent = message
      }
      return false
    }
    const minimumNoteLength = effectiveMinimumNoteLength(cell, current)
    const pendingNotes = notesForCell(cell, current)
    if (
      seconds > 0 &&
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
      viewedPerson?.id,
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
      if (focus !== undefined) focusCell({ key: cell.key, view })
      return false
    }
    // A commit that zeroed a cell holding an entry removed it, note and all.
    // Saying so is the whole difference between a correction and a loss
    // somebody discovers later (issue 753).
    //
    // Announced above the grid rather than on the cell, because removing the
    // last entry of a row takes the row with it -- and a message on a cell that
    // no longer exists is a message nobody reads.
    const removed = cell.entries.length > 0 && parseCellSeconds(rawValue) === 0
    if (removed) {
      const hadNote = timeEntryNoteLength(notesForCell(cell, current)) > 0
      announceRemoval(
        `Removed ${formatCellHours(cell.totalSeconds, snapshot?.timeEntrySettings.time_format ?? 'decimal')} on ${dayLabel(cell.date)}${hadNote ? ', and its note' : ''}.`,
      )
    }
    cellStates.set(cell.key, { state: removed ? 'removed' : 'saved', rawValue })
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
    // The options are built for this entry's assignment and the values set from
    // the same pair, rather than assigned here and read back: the task list is
    // still narrowed to whichever project the editor last showed, and a select
    // drops a value it does not offer.
    updateEntrySuggestions({
      project: project === undefined ? String(next.projectId) : resourceLabel(project),
      task: task === undefined ? String(next.taskId) : resourceLabel(task),
    })
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
    // Only where there is something to delete, and never on a running timer --
    // that one is stopped, not deleted. A locked entry shows neither Save nor
    // Delete: the dialog is open to say why it cannot change, and a control that
    // can only refuse is worse than no control beside a sentence that already
    // explains itself (issue 496).
    deleteEntry.hidden = next.entry === null || running || next.entry.is_locked
    entryResult.textContent = message
    open(entryDialog)
    // A locked entry disables every field and hides both actions, so the usual
    // targets are all unfocusable and `.focus()` would quietly do nothing,
    // leaving the keyboard behind the modal.
    if (next.entry?.is_locked === true) {
      entryDialog.querySelector<HTMLButtonElement>('[data-dialog-close]')?.focus()
      return
    }
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

  /**
   * Opens the editor on one entry from a Detailed time row, for an
   * administrator correcting it (issue 917). The entry is read fresh rather than
   * trusted from the report, and when it is somebody else's the editor offers
   * that person's project/task pairs. `onChanged` is the report reloading once
   * the entry is saved, stopped or removed. Failures are thrown for the report
   * to show where it is being looked at.
   */
  async function editReportedEntry(entryId: number, onChanged: () => void): Promise<void> {
    const operation = sessionOperation()
    const getTimeEntry = api.getTimeEntry
    if (operation === null || getTimeEntry === undefined) return
    try {
      const entry = await getTimeEntry(entryId, operation.signal)
      const theirs = entry.user_id !== operation.userId
      const options = theirs
        ? await api.listTimeEntryOptions(operation.signal, entry.user_id)
        : undefined
      const week = snapshot
      if (!isSessionCurrent(operation) || week === null) return
      const project = week.catalog.projects.find((resource) => resource.id === entry.project_id)
      const task = week.catalog.tasks.find((resource) => resource.id === entry.task_id)
      const displayed: DisplayTimeEntry = {
        ...entry,
        project_label: project === undefined ? `#${entry.project_id}` : resourceLabel(project),
        task_label: task === undefined ? `#${entry.task_id}` : resourceLabel(task),
      }
      configureEntryEditor(
        {
          context: 'edit',
          entry: displayed,
          projectId: entry.project_id,
          taskId: entry.task_id,
          spentDate: entry.spent_date,
          seconds: entry.seconds,
          notes: entry.notes ?? null,
          mode: modeForEntryDraft(entry, week.timeEntrySettings.time_entry_mode),
          timer: false,
          minimumNoteLength: entry.minimum_note_length,
          ...(options === undefined ? {} : { owner: { userId: entry.user_id, options } }),
          onChanged,
        },
        entry.is_locked === true
          ? `This entry cannot be changed: ${entry.locked_reason ?? 'it is locked'}.`
          : '',
      )
    } catch (error) {
      if (handleSessionFailure(error, operation)) return
      throw error
    }
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
      (cell.isLocked && cell.entries.length !== 1) ||
      snapshot === null
    )
      return
    const minimumNoteLength = effectiveMinimumNoteLength(cell, state)
    const entry = cell.entries[0] ?? null
    // The reason is the entry's own. `deriveLockReasonCode` names it -- invoiced,
    // approved, policy_locked, an archived client, project or task -- and it is
    // the whole point of opening a locked entry, so it is said on arrival rather
    // than waiting for someone to press a control and be refused.
    const lockedMessage =
      entry?.is_locked === true
        ? `This entry cannot be changed: ${entry.locked_reason ?? 'it is locked'}.`
        : message
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
        ...(viewedPerson === null
          ? {}
          : {
              owner: {
                userId: viewedPerson.id,
                options: snapshot.catalog.timeEntryOptions,
              },
            }),
        durationWasEditedBeforeOpen:
          state?.rawValue !== undefined &&
          state.rawValue !==
            formatCellHours(cell.totalSeconds, snapshot.timeEntrySettings.time_format),
      },
      lockedMessage,
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
    // The week on screen is a teammate's (issue 917) and so are its project/task
    // pairs; a timer of your own starts from your own week.
    if (viewedPerson !== null) {
      setSessionStatus('Go back to your own timesheet to start a timer.', 'ready')
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
  required<HTMLButtonElement>('[data-menu-trigger]').addEventListener('click', () => {
    loadProfileTimezone()
    open(menuDialog)
    // The first destination, not the close button showModal() lands on
    // (issue 861). Gates hide links with `hidden`, which the stylesheet makes
    // display:none and focus() then ignores, so it is the first link still
    // showing. Were none showing, the close button would keep focus.
    const firstLink = [...menuDialog.querySelectorAll<HTMLAnchorElement>('nav a')].find(
      (link) => !link.hidden,
    )
    firstLink?.focus()
  })
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
      // A log line searches no destinations, so reporting that none matched is
      // answering a question nobody asked -- and it reads as "you typed it
      // wrong" for a command that works.
      const preview = quickAddPreview(query)
      empty.textContent = preview ?? 'No destination matches that.'
      if (preview !== null) empty.dataset.commandPreview = 'true'
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
    // showModal() focuses the first focusable thing in the dialog, which is
    // the close button in its header, so ⌘K took a Tab before it took a
    // keystroke (issue 861). The query is what the shortcut is for. Selecting
    // what the last use left behind keeps what that Tab did: typing replaces it.
    commandInput.focus()
    commandInput.select()
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
    const selectedOption = editorOptions().find(
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
            : {
                ...(editor.owner === undefined ? {} : { user_id: editor.owner.userId }),
                ...common,
                spent_date: entryDate.value,
                ...timing,
              },
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
        editor.onChanged?.()
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

  /**
   * The note rule belongs to the project/task pair, so it follows the pair.
   *
   * This used to hang off the `input` event of every text field in the form and
   * test whether the field was one of the two assignment boxes. They are selects
   * now, which that loop does not reach and which fire `change` rather than
   * `input`, so it is attached to the two controls it is actually about.
   */
  const syncAssignmentNoteRule = (): void => {
    if (activeEntry === null || snapshot === null) return
    const projectId = editorResourceId('project', entryProject.value, activeEntry.projectId)
    const taskId = editorResourceId('task', entryTask.value, activeEntry.taskId)
    const option = editorOptions().find(
      (candidate) => candidate.project_id === projectId && candidate.task_id === taskId,
    )
    if (option === undefined) return
    activeEntry = {
      ...activeEntry,
      projectId: option.project_id,
      taskId: option.task_id,
      minimumNoteLength: option.minimum_note_length,
    }
    configureNoteInput(entryNoteInput, entryNoteHint, option.minimum_note_length)
  }

  for (const control of [entryProject, entryTask]) {
    control.addEventListener('change', () => {
      entryResult.textContent = ''
      syncAssignmentNoteRule()
    })
  }

  for (const input of entryForm.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input, textarea',
  )) {
    input.addEventListener('input', () => {
      entryResult.textContent = ''
    })
  }

  stopTimer.addEventListener('click', () => {
    const operation = sessionOperation()
    if (operation === null) return
    const editor = activeEntry
    const running = editor?.entry
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
        editor?.onChanged?.()
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        entryResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (isSessionCurrent(operation)) stopTimer.disabled = false
      })
  })

  deleteEntry.addEventListener('click', () => {
    const operation = sessionOperation()
    const editor = activeEntry
    const existing = editor?.entry
    if (operation === null || existing === undefined || existing === null) return
    // The button is already hidden in both of the cases it could be pressed in
    // error, so this is belt and braces -- but only one of them has a second
    // line. `deleteTimeEntry` refuses a locked entry in the tracked-mutation
    // predicate, and would say so itself; nothing in it refuses a running one,
    // so this is the only thing standing between a running timer and deletion.
    if (existing.is_running === true) {
      entryResult.textContent = 'Stop the running timer before deleting this entry.'
      return
    }
    entryResult.textContent = 'Deleting entry…'
    deleteEntry.disabled = true
    void api
      .deleteTimeEntry(existing.id, operation.signal)
      .then(async () => {
        if (!isSessionCurrent(operation)) return
        if (!(await refresh(operation))) return
        entryDialog.close()
        activeEntry = null
        editor?.onChanged?.()
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        entryResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (isSessionCurrent(operation)) deleteEntry.disabled = false
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
    if (alreadyExists) {
      // Keep feedback beside the submit button, including when the existing
      // day's entry is running or locked and its duration input cannot focus.
      result.textContent = 'That project and task are already on this week. Choose another pair, or close this dialog to edit the existing row.'
      return
    }
    supplementalRows = [
      ...new Map(
        [...supplementalRows, { projectId, taskId }].map((row) => [
          `${row.projectId}:${row.taskId}`,
          row,
        ]),
      ).values(),
    ]
    saveSupplementalRows(weekPersonId(operation), within, supplementalRows, weekStartDay)
    render()
    rowDialog.close()
    result.textContent = ''
    const firstDate = grid?.dates[selectedDay]
    if (firstDate !== undefined) {
      const focused = focusCell({ key: `${key}:${firstDate}`, view: visibleGridView() })
      setSessionStatus(
        focused
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
    const unfinished = [...cellStates].find(([, state]) =>
      state.state === 'dirty' || state.state === 'invalid' ||
      state.state === 'saving' || state.state === 'retry',
    )
    if (unfinished !== undefined) {
      timesheetResult.textContent = unfinished[1].state === 'saving'
        ? 'Wait for your changes to finish saving, then submit the week.'
        : 'Fix or save the unfinished time entries before submitting the week. Use decimal hours (2.5) or H:MM (2:30).'
      if (unfinished[1].state !== 'saving') {
        focusCell({ key: unfinished[0], view: visibleGridView() })
      }
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
    if (time === '') {
      lockPolicyResult.textContent = 'Enter a deadline time.'
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

  // The organization timezone saves on its own. It used to ride along with the
  // lock deadline, so an instance that wanted a timezone and no automatic
  // locking could not set one at all -- the form refused to submit without a
  // deadline time. The API has always accepted a timezone-only patch.
  orgTimezoneForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const operation = sessionOperation()
    if (operation === null || api.updateTimesheetLockPolicy === undefined) return
    const timezone = orgTimezone.value.trim()
    if (timezone === '') {
      orgTimezoneResult.textContent = 'Enter an organization timezone.'
      return
    }
    orgTimezoneSubmit.disabled = true
    orgTimezoneResult.textContent = 'Saving timezone…'
    void api
      .updateTimesheetLockPolicy({ timezone }, operation.signal)
      .then(async () => {
        if (!(await refresh(operation))) return
        orgTimezoneResult.textContent = `Saved. Tracked work files on the day it is in ${timezone}.`
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        orgTimezoneResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (!isSessionCurrent(operation)) return
        orgTimezoneSubmit.disabled = false
      })
  })

  // A person's own timezone. `PATCH /profile` has existed since the timer bug
  // was fixed but nothing in the shell ever called it, so the only way to set
  // one was for an administrator to edit that person on the team page.
  // The card's name, read once per sign-in. A failure leaves the role showing;
  // a session that has ended is the week's to report, not this read's.
  const loadIdentityName = (operation: AuthOperation): void => {
    if (api.getProfile === undefined) return
    void api
      .getProfile(operation.signal)
      .then((profile) => {
        if (isSessionCurrent(operation)) showIdentityName(profile)
      })
      .catch(() => undefined)
  }

  const loadProfileTimezone = (): void => {
    const operation = sessionOperation()
    if (operation === null || api.getProfile === undefined) return
    void api
      .getProfile(operation.signal)
      .then((profile) => {
        if (!isSessionCurrent(operation)) return
        showIdentityName(profile)
        if (document.activeElement === profileTimezone) return
        // 'UTC' is this column's "unset", not a choice: say so rather than
        // showing a zone the person never picked.
        const unset = profile.timezone === 'UTC'
        showTimezone(profileTimezone, unset ? '' : profile.timezone)
        profileTimezoneHint.textContent = unset
          ? 'Not set. Your work files on the organization timezone.'
          : 'Your work files on the day it is where you are.'
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        profileTimezoneResult.textContent = messageFor(error)
      })
  }

  profileTimezoneForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const operation = sessionOperation()
    if (operation === null || api.updateProfile === undefined) return
    const timezone = profileTimezone.value.trim()
    if (timezone === '') {
      profileTimezoneResult.textContent = 'Enter a timezone.'
      return
    }
    profileTimezoneSubmit.disabled = true
    profileTimezoneResult.textContent = 'Saving timezone…'
    void api
      .updateProfile(timezone, operation.signal)
      .then(async (profile) => {
        if (!isSessionCurrent(operation)) return
        profileTimezoneResult.textContent = `Saved. Your work files on the day it is in ${profile.timezone}.`
        profileTimezoneHint.textContent = 'Your work files on the day it is where you are.'
        await refresh(operation)
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        profileTimezoneResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (!isSessionCurrent(operation)) return
        profileTimezoneSubmit.disabled = false
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
    supplementalRows = loadSupplementalRows(weekPersonId(operation), within, weekStartDay)
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
    supplementalRows = loadSupplementalRows(weekPersonId(operation), within, weekStartDay)
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
  /**
   * Issue 904: the Day view for a week cell's date, in place and on the same
   * week, with focus on the first of the entries the cell was holding. The
   * address says Day too, as the strip's own link would, so a reload stays.
   */
  const openDay = (cell: WeekGridCell): void => {
    if (currentIdentity === null || grid === null) return
    const index = grid.dates.indexOf(cell.date)
    if (index < 0) return
    selectedDay = index
    document.documentElement.dataset.timeView = 'day'
    const url = new URL(globalThis.location.href)
    url.searchParams.set('view', 'day')
    globalThis.history.replaceState(null, '', url)
    markTimeViewTab()
    render()
    document
      .querySelector<HTMLInputElement>(`[data-day-rows] input[data-cell-key^="${cell.key}:entry:"]`)
      ?.focus()
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
    const personId = weekPersonId(operation)
    const lastWeek = weekRange(previousMonday, weekStartDay)
    void api
      .listTimeEntries(
        viewedPerson === null ? lastWeek : { ...lastWeek, user_id: viewedPerson.id },
        operation.signal,
      )
      .then((entries) => {
        if (!isSessionCurrent(operation) || weekPersonId(operation) !== personId) return
        const copied = seedsFromEntries(entries)
        supplementalRows = [
          ...new Map(
            [...supplementalRows, ...copied].map((row) => [`${row.projectId}:${row.taskId}`, row]),
          ).values(),
        ]
        saveSupplementalRows(personId, within, supplementalRows, weekStartDay)
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
  invoiceForm.addEventListener('change', (event) => {
    syncInvoiceDialog()
    // The hours report is not part of the generation command, so changing it
    // keeps the key: a retry after its setting failed replays the same draft.
    if (
      event.target === invoiceAttachJournal ||
      event.target === invoiceJournalLevel ||
      (event.target instanceof Node && invoiceJournalFormats.contains(event.target))
    ) {
      return
    }
    invoiceCommandId = null
    const operation = sessionOperation()
    // The fee and its limit change what is asked, not what is waiting, so the
    // report already read still answers for them.
    if (
      operation !== null &&
      invoiceKind() !== 'free_form' &&
      event.target !== invoiceExpenseSummary &&
      !(event.target instanceof Node && invoiceBand.contains(event.target))
    ) {
      void checkInvoiceExpenses(operation)
    }
    if (!invoiceGenerationPending) invoiceResult.textContent = ''
  })
  // Amounts read back as they are typed, not only once a field is left.
  invoiceBand.addEventListener('input', () => paintInvoiceBand())
  required<HTMLButtonElement>('[data-invoice-fee-add]').addEventListener('click', () => {
    invoiceCommandId = null
    addInvoiceFeeLine().querySelector<HTMLInputElement>('[data-invoice-fee-description]')!.focus()
  })
  invoiceFeeLines.addEventListener('click', (event) => {
    const remove =
      event.target instanceof Element ? event.target.closest('[data-invoice-fee-remove]') : null
    if (remove === null || invoiceFeeRows().length === 1) return
    invoiceCommandId = null
    remove.closest('[data-invoice-fee-line]')!.remove()
    renumberInvoiceFeeLines()
    paintInvoiceBand()
    invoiceFeeRows()[0]!.querySelector<HTMLInputElement>('[data-invoice-fee-description]')!.focus()
  })
  addInvoiceFeeLine()
  required<HTMLAnchorElement>('[data-invoice-new]').addEventListener('click', (event) => {
    const operation = sessionOperation()
    if (operation === null) return
    event.preventDefault()
    openInvoiceDialog(operation)
  })
  // /invoices/new is the list with this open; closing it leaves the list.
  invoiceNewDialog.addEventListener('close', () => {
    if (globalThis.location.pathname.replace(/\/$/u, '') === '/invoices/new') {
      globalThis.history.replaceState(null, '', '/invoices')
    }
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
        (next !== 'outstanding' && next !== 'overdue' &&
          next !== 'paid' && next !== 'closed' && next !== 'all') ||
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
    if (!Number.isSafeInteger(clientId) || clientId < 1) {
      invoiceResult.textContent = 'Choose a client.'
      return
    }
    let input: InvoiceGenerationInput
    const kind = invoiceKind()
    if (kind === 'free_form') {
      input = { kind: 'free_form', client_id: clientId }
    } else if (kind === 'banded') {
      const { from, to } = invoiceRange()
      const projectIds = data
        .getAll('project')
        .map(Number)
        .filter((projectId) => Number.isSafeInteger(projectId) && projectId > 0)
      if (
        (from !== undefined && (!isCalendarDay(from) || from > to)) ||
        !isCalendarDay(to) ||
        projectIds.length === 0
      ) {
        invoiceResult.textContent = 'Choose a client, date range, and at least one project.'
        return
      }
      let terms: InvoiceBandTerms
      try {
        terms = invoiceBandTerms(invoiceBandValues())
      } catch (error) {
        invoiceResult.textContent = messageFor(error)
        return
      }
      input = {
        kind: 'banded',
        client_id: clientId,
        ...(from === undefined ? {} : { from }),
        to,
        project_ids: projectIds,
        ...terms,
      }
    } else {
      const { from, to } = invoiceRange()
      const projectIds = data
        .getAll('project')
        .map(Number)
        .filter((projectId) => Number.isSafeInteger(projectId) && projectId > 0)
      const rawTimeSummary = data.get('timeSummary')
      // A disabled control is not in the FormData; greyed out means none.
      const rawExpenseSummary = data.get('expenseSummary') ?? ''
      const timeSummaries = new Set(['project', 'task', 'people', 'detailed'])
      const expenseSummaries = new Set(['project', 'category', 'people', 'detailed'])
      if (
        // A date range reads as real days, in order. The control's inputs are
        // not required, because a half-typed custom range is a normal state to
        // be in while choosing one, so the check that would be the browser's is ours.
        (from !== undefined && (!isCalendarDay(from) || from > to)) ||
        !isCalendarDay(to) ||
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
      input = {
        kind: 'tracked',
        client_id: clientId,
        ...(from === undefined ? {} : { from }),
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
    }
    const journal = invoiceJournalChoice()
    if (input.kind !== 'free_form' && journal === null) {
      invoiceResult.textContent = 'Choose at least one format for the hours report.'
      return
    }
    invoiceCommandId ??= `web.invoice.create:${globalThis.crypto.randomUUID()}`
    const commandId = invoiceCommandId
    setInvoiceFormPending(true)
    invoiceSubmit.textContent = 'Generating…'
    invoiceResult.textContent =
      input.kind === 'free_form'
        ? 'Creating the draft…'
        : 'Atomically claiming tracked work and creating the draft…'
    void api
      .generateInvoice(commandId, input, operation.signal)
      .then(async (invoice) => {
        if (!isSessionCurrent(operation)) return
        // The hours report is rendered when the invoice is emailed, from the
        // entries this draft just claimed; here it is only the invoice's choice.
        if (
          journal !== null &&
          input.kind !== 'free_form' &&
          api.setInvoiceJournal !== undefined &&
          !sameInvoiceJournal(journal, invoiceJournalDefault)
        ) {
          try {
            await api.setInvoiceJournal(invoice.id, journal, operation.signal)
          } catch (error) {
            if (handleSessionFailure(error, operation)) return
            // The command id is kept, so submitting again replays the same
            // draft rather than making a second one, then retries this.
            invoiceResult.textContent = `Draft invoice ${invoice.number} was created, but the hours report setting was not saved: ${messageFor(error)} Create draft again to retry; it will not make a second invoice.`
            return
          }
          if (!isSessionCurrent(operation)) return
        }
        // The draft is the next step, as it was in Harvest: open it.
        invoiceResult.textContent = `Draft invoice ${invoice.number} created. Opening it…`
        globalThis.location.assign(invoicePagePath(invoice))
      })
      .catch((error: unknown) => {
        if (handleSessionFailure(error, operation)) return
        invoiceResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (!isSessionCurrent(operation)) return
        setInvoiceFormPending(false)
        invoiceSubmit.textContent = 'Create draft'
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
      .then(async (result) => {
        if (!isGenerationCurrent(operation)) return
        // An enrolled user is not signed in yet. There is no session cookie in
        // this response, so going on to load the shell would 401 and read as a
        // failed password.
        if (isTwoFactorRequired(result)) {
          openTwoFactorStep(result.challenge)
          return
        }
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

  twoFactorForm.addEventListener('submit', (event) => {
    event.preventDefault()
    if (verifyingSecondFactor || pendingChallenge === null) return
    const code = twoFactorCode.value.trim()
    if (code === '') {
      twoFactorResult.textContent = 'Enter the code from your authenticator app.'
      return
    }
    const complete = api.completeTwoFactorChallenge
    if (complete === undefined) {
      twoFactorResult.textContent =
        'This instance cannot complete two-factor sign-in. Contact your administrator.'
      return
    }
    const challenge = pendingChallenge
    const operation = beginAuthGeneration(null)
    verifyingSecondFactor = true
    setTwoFactorPending(true)
    twoFactorResult.textContent = 'Verifying…'
    void complete(
      { code, ...(challenge === '' ? {} : { challenge }) },
      operation.signal,
    )
      .then(async () => {
        if (!isGenerationCurrent(operation)) return
        pendingChallenge = null
        await loadAuthenticatedShell(operation)
      })
      .catch((error: unknown) => {
        if (!isGenerationCurrent(operation)) return
        const message = twoFactorMessage(error)
        // A dead challenge cannot be answered; the only way on is the password.
        if (message.expired) closeTwoFactorStep(message.text)
        else twoFactorResult.textContent = message.text
      })
      .finally(() => {
        if (!isGenerationCurrent(operation)) return
        verifyingSecondFactor = false
        setTwoFactorPending(false)
        twoFactorCode.value = ''
      })
  })

  twoFactorCancel.addEventListener('click', () => {
    if (verifyingSecondFactor) return
    closeTwoFactorStep('Sign in to load and edit your week.')
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

  // Text size, beside density and for the same reason (issue 800): a display
  // preference with nothing to wait for, applied before the session resolves.
  const textSize = createTextSizeRuntime({
    store: browserTextSizeStore(globalThis.localStorage),
    target: document.documentElement,
  })
  const syncTextSizeChoice = (current: TextSize): void => {
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      '[data-text-size-choice]',
    )) {
      button.setAttribute('aria-pressed', String(button.dataset.textSizeChoice === current))
    }
  }
  syncTextSizeChoice(textSize.start())
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-text-size-choice]')) {
    button.addEventListener('click', () => {
      const chosen = button.dataset.textSizeChoice
      if (chosen === undefined || !(textSizes as readonly string[]).includes(chosen)) return
      syncTextSizeChoice(textSize.set(chosen as TextSize))
    })
  }

  // The company settings page shows one section at a time, chosen by the hash
  // (issue 800). Every section stays in the document for the controllers that
  // find their elements at construction; only `hidden` moves. A section the
  // page has marked unavailable -- Payouts, until Wise is configured -- falls
  // back to the first, so a stale link opens a page and not a blank one.
  if (moduleSettingsPage) {
    const sections = [...document.querySelectorAll<HTMLElement>('[data-settings-section]')]
    const links = [...document.querySelectorAll<HTMLElement>('[data-settings-section-link]')]
    const unavailable = (section: HTMLElement): boolean =>
      section.hasAttribute('data-settings-unavailable')
    const showSection = (): void => {
      let current = resolveSettingsSection(globalThis.location.hash)
      const chosen = sections.find((section) => section.dataset.settingsSection === current)
      if (chosen !== undefined && unavailable(chosen)) current = DEFAULT_COMPANY_SETTINGS_SECTION
      applySettingsSection(current, sections, links, unavailable)
    }
    showSection()
    globalThis.addEventListener('hashchange', showSection)
  }

  // The theme runtime resolved a stored choice against an organization default
  // and kept the document theme separate from it, and nothing had ever
  // constructed it -- the shell wrote the theme name as a literal in three
  // places instead, so a user could not choose a theme and an invoice could not
  // keep the organization's while the shell wore someone else's (issue 459).
  //
  // Applied beside density and for the same reason: it is a display preference
  // with nothing to wait for, so it runs before the session resolves.
  //
  // The policy is the generated default on both slots today. That is the honest
  // value -- the OSS bundle ships one theme -- rather than an invented second
  // one; carrying an organization's own default on the deployment is the seam
  // issue 67's settings screen attaches to.
  const theme = createThemeRuntime({
    registry: themeManifest,
    policy: { orgDefaultTheme: defaultTheme, orgDocumentTheme: defaultTheme },
    preference: browserThemeStore(globalThis.localStorage),
    applicationRoot: document.documentElement,
    // Every invoice or document shell on the page, so the thing a client
    // receives keeps the organization's theme whatever the operator picked.
    documentRoots: [...document.querySelectorAll<HTMLElement>('[data-document-shell]')],
  })
  const syncThemeChoice = (current: string): void => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')) {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === current))
    }
  }
  syncThemeChoice(theme.start().application)
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')) {
    button.addEventListener('click', () => {
      const chosen = button.dataset.themeChoice
      if (chosen === undefined || !Object.hasOwn(themeManifest, chosen)) return
      syncThemeChoice(theme.switchUserTheme(chosen as keyof typeof themeManifest).application)
    })
  }

  // Light, dark, or the operating system's (the 2026-10 reskin). The server has
  // already rendered the stored choice onto the root from the same cookie, so
  // starting here changes nothing on screen; it only takes over once somebody
  // picks, and a page is never painted in the wrong scheme and then corrected.
  // Secure on https only: a self-hosted box served over plain http cannot set
  // a Secure cookie at all, and would lose every choice on reload.
  const secureCookies = globalThis.location.protocol === 'https:'
  const colorScheme = createColorSchemeRuntime({
    store: browserCookieStore(document, COLOR_SCHEME_COOKIE, secureCookies),
    target: document.documentElement,
    meta: document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]'),
  })
  const syncColorSchemeChoice = (current: ColorScheme): void => {
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      '[data-color-scheme-choice]',
    )) {
      button.setAttribute('aria-pressed', String(button.dataset.colorSchemeChoice === current))
    }
  }
  syncColorSchemeChoice(colorScheme.start())
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-color-scheme-choice]')) {
    button.addEventListener('click', () => {
      const chosen = button.dataset.colorSchemeChoice
      if (chosen === undefined || !(colorSchemes as readonly string[]).includes(chosen)) return
      syncColorSchemeChoice(colorScheme.set(chosen as ColorScheme))
    })
  }

  // The search chip's modifier: the server renders it blank because it cannot
  // see the keyboard, and it is filled here before the shell is shown.
  const shortcutModifier = commandShortcutModifier(
    globalThis.navigator as Navigator & PlatformHints,
  )
  for (const slot of document.querySelectorAll<HTMLElement>('[data-command-modifier]')) {
    slot.textContent = shortcutModifier
  }

  // Sidebar or top bar, and how wide the sidebar is (the 2026-10 reskin). The
  // server rendered both onto the root from the same cookies, so starting here
  // moves nothing on screen; they only take over once somebody picks. Both
  // layouts are the one header, so switching is an attribute and not a
  // rebuild: the links, the timer chip and every handler stay where they are.
  const navLayout = createNavLayoutRuntime({
    store: browserCookieStore(document, NAV_LAYOUT_COOKIE, secureCookies),
    target: document.documentElement,
  })
  const syncNavLayoutChoice = (current: NavLayout): void => {
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      '[data-nav-layout-choice]',
    )) {
      button.setAttribute('aria-pressed', String(button.dataset.navLayoutChoice === current))
    }
  }
  syncNavLayoutChoice(navLayout.start())
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-nav-layout-choice]')) {
    button.addEventListener('click', () => {
      const chosen = button.dataset.navLayoutChoice
      if (chosen === undefined || !(navLayouts as readonly string[]).includes(chosen)) return
      syncNavLayoutChoice(navLayout.set(chosen as NavLayout))
    })
  }
  const sidebarState = createSidebarRuntime({
    store: browserCookieStore(document, SIDEBAR_COOKIE, secureCookies),
    target: document.documentElement,
  })
  const sidebarToggle = document.querySelector<HTMLButtonElement>('[data-sidebar-toggle]')
  const syncSidebarToggle = (current: SidebarState): void => {
    sidebarToggle?.setAttribute('aria-pressed', String(current === 'collapsed'))
  }
  syncSidebarToggle(sidebarState.start())
  sidebarToggle?.addEventListener('click', () => {
    syncSidebarToggle(
      sidebarState.set(sidebarState.current() === 'collapsed' ? 'expanded' : 'collapsed'),
    )
  })
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-density-choice]')) {
    button.addEventListener('click', () => {
      const chosen = button.dataset.densityChoice
      if (chosen !== 'comfortable' && chosen !== 'compact') return
      syncDensityChoice(density.set(chosen))
    })
  }

  // A magic link answered by an enrolled user lands here with a challenge
  // cookie and no session. The cookie is HttpOnly, so the redirect says so with
  // a flag -- it names no credential, and the token stays out of the URL.
  const landedOnChallenge =
    new URLSearchParams(globalThis.location.search).get('two_factor') === '1'
  if (landedOnChallenge) {
    globalThis.history.replaceState(null, '', globalThis.location.pathname)
    openTwoFactorStep('')
    return
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
