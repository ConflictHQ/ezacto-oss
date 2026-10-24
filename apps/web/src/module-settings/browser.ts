import { accountingAvailable } from '../accounting-availability.js'
import { backupsAvailable } from '../backups-availability.js'
import { createWebhookController } from './webhooks.js'
import { createPayoutProviderSwitches } from './payout-provider-switches.js'
import { createCompanyDataTools } from './data-tools.js'
import { createEmailSuppressionController } from './email-suppressions-browser.js'
import { createDeletionRequestsController } from './deletion-requests.js'
import { createRetentionController } from './retention.js'
import { createTimeRoundingController } from './time-rounding.js'
import {
  EzactoApiError,
  type InvoiceRecipient,
  type SenderIdentity,
  type SsoDomain,
  type Whoami,
} from '@conflict-hq/ezacto-client'
import { renderDataTable } from '../components/data-table.js'
import { dateInTimeZone, timeInTimeZone } from '@ezacto/core'
import { createPagedLog, type PagedLog } from '../components/paged-log.js'
import { DEMO_UNAVAILABLE, demoUnavailable, isDemoDeployment } from '../demo.js'
import { invoiceAddressLines } from '../invoice-addresses.js'
import { defaultTheme, themeManifest } from '../theme.js'
import { sessionPresenter, type SessionPresenter } from '../session.js'
import { shellFetch } from '../shell/net.js'
import {
  DEFAULT_COMPANY_SETTINGS_SECTION,
  resolveSettingsSection,
} from '../settings-sections.js'
import {
  apiErrorMessage,
  brandAssetAccept,
  brandAssetRejection,
  brandAssetSlotCopy,
  loadFailureMessage,
  themeSlotCopy,
  themeSlotGroups,
  noteSettingsPatch,
  reminderPolicyFromForm,
  ratePercentage,
  emailReputationWarning,
  senderVerificationLabel,
  ssoDomainStatus,
  ssoLastCheckedLabel,
  ssoVerificationMessage,
  timeTrackingFacts,
  invoiceAlwaysCcChange,
  invoiceSendingChanges,
  invoiceSendingChoice,
  type CompanySettingsApi,
  type InvoiceDefaultsSetting,
  type InvoiceDocumentsSetting,
  type InvoiceSendingChoice,
  type OrganizationInvoiceSendingSetting,
  type InstanceThemeView,
  type BackupRun,
  type NotificationSettingsState,
  type TimesheetAutoApprovalState,
} from './model.js'

interface ModuleState {
  module: string
  enabled: boolean
}

interface ModuleListEnvelope {
  data: readonly ModuleState[]
}

/** One stored brand mark as `/api/v1/settings/brand-assets` reports it (#489). */
interface BrandAssetState {
  slot: string
  content_type: string
  byte_size: number
  url: string
  updated_at: string
}

interface BrandAssetListEnvelope {
  data: readonly BrandAssetState[]
}

/**
 * These three go through `fetch` rather than the generated client for the same
 * reason `fetchModules` does: the upload is `multipart/form-data`, which the
 * generated JSON client has no shape for, and having the list travel by a
 * different road from the upload that changes it is how the two drift. The
 * fetch is still the shell's own, so the writes are keyed and retried like
 * every other (issue 953).
 */
const fetchBrandAssets = async (
  signal?: AbortSignal,
): Promise<readonly BrandAssetState[]> => {
  const response = await shellFetch('/api/v1/settings/brand-assets', {
    credentials: 'same-origin',
    ...withSignal(signal),
  })
  if (!response.ok) throw new EzactoApiError(
      response.status,
      await errorBody(response),
      response.headers.get('x-request-id'),
    )
  return ((await response.json()) as BrandAssetListEnvelope).data
}

const errorBody = async (response: Response): Promise<unknown> =>
  response.json().catch(() => null)

const uploadBrandAsset = async (
  segment: string,
  file: File,
  signal?: AbortSignal,
): Promise<void> => {
  const body = new FormData()
  body.append('file', file)
  const response = await shellFetch(`/api/v1/settings/brand-assets/${segment}`, {
    method: 'POST',
    body,
    credentials: 'same-origin',
    ...withSignal(signal),
  })
  if (!response.ok) throw new EzactoApiError(
      response.status,
      await errorBody(response),
      response.headers.get('x-request-id'),
    )
}

const removeBrandAsset = async (segment: string, signal?: AbortSignal): Promise<void> => {
  const response = await shellFetch(`/api/v1/settings/brand-assets/${segment}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    ...withSignal(signal),
  })
  if (!response.ok) throw new EzactoApiError(
      response.status,
      await errorBody(response),
      response.headers.get('x-request-id'),
    )
}

const moduleDescriptions: Readonly<Record<string, { label: string; warning: string }>> = {
  approval: {
    label: 'Timesheet approval',
    warning:
      'Disabling hides the Approvals navigation link and returns 404 from approval API endpoints. Existing submissions, approval states, and audit history are preserved. New time entries remain unsubmitted while approval is off. Existing approved locks still reject writes.',
  },
  expenses: {
    label: 'Expenses',
    warning:
      'Disabling hides the Expenses navigation link and returns 404 from expense API endpoints. Existing expense records are preserved.',
  },
  activity_log: {
    label: 'Activity log',
    warning:
      'Disabling hides the Activity log from Settings and Reports and refuses the activity log API with module_disabled. Nothing stops being recorded: events keep being captured while it is off, and appear again when it is switched back on.',
  },
  own_money: {
    label: 'Your own rates and take-home',
    warning:
      'Enabling lets a person read the billable rate and the take-home cost recorded on their own time entries, through the API and the ez command line. Nothing on anybody else’s entries becomes visible: a rate snapshot is served only to the person whose entry it is. Administrators already see both across everyone and are unaffected. The app’s own screens do not show these two figures yet. Disabling hides them again on the next request, and no stored data changes either way.',
  },
}

const required = <ElementType extends Element>(selector: string): ElementType => {
  const item = document.querySelector<ElementType>(selector)
  if (item === null) throw new Error(`module settings element missing: ${selector}`)
  return item
}

interface ActiveSession extends SessionPresenter {
  readonly signal: AbortSignal
  readonly identity: Whoami
}

export interface ModuleSettingsController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

const facts = (
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
 * A 403 here is configuration, not a broken page: the notes policy answers to an
 * executive manager, email health to an administrator alone. Saying which is the
 * difference between a section an operator can act on and one that looks broken.
 */
/**
 * The built-in colours, as the swatch to show for a slot the operator has not
 * set. Read from the shipped theme rather than restated, so a retuned token
 * moves the control with it.
 */
const themeBaseline: Readonly<Record<string, string>> = themeManifest[defaultTheme].colors

const messageFor = (error: unknown, forbidden: string, fallback: string): string => {
  if (error instanceof EzactoApiError && error.status === 403) return forbidden
  return error instanceof Error ? error.message : fallback
}

const withSignal = (signal?: AbortSignal): { signal?: AbortSignal } =>
  signal === undefined ? {} : { signal }

const fetchModules = async (signal?: AbortSignal): Promise<readonly ModuleState[]> => {
  const response = await shellFetch('/api/v1/admin/modules', {
    credentials: 'same-origin',
    ...withSignal(signal),
  })
  // The client's own error, request id and all, so a failed read says where
  // to look for it (#809). The writes below keep their sentences: a refusal
  // there is the API's own words, and those are the message.
  if (!response.ok) {
    throw new EzactoApiError(
      response.status,
      await errorBody(response),
      response.headers.get('x-request-id'),
    )
  }
  const envelope = (await response.json()) as ModuleListEnvelope
  return envelope.data
}

const patchModule = async (
  module: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<readonly ModuleState[]> => {
  const response = await shellFetch(`/api/v1/admin/modules/${module}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
    credentials: 'same-origin',
    ...withSignal(signal),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Failed to update module (${response.status}): ${text}`)
  }
  const envelope = (await response.json()) as ModuleListEnvelope
  return envelope.data
}

interface SignInMethodState {
  readonly method: 'password' | 'magic_link' | 'google' | 'github' | 'apple'
  readonly configured: boolean
  readonly enabled: boolean
}

/**
 * The API's own words, not the transport's. Every refusal here is a guard an
 * operator has to act on -- "you have not signed in with any of the remaining
 * methods" is the whole message -- and `Failed to update (409): {...}` throws
 * that away.
 */
const refusal = (body: string, fallback: string): string => {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } }
    const message = parsed.error?.message
    return typeof message === 'string' && message !== '' ? message : fallback
  } catch {
    return fallback
  }
}

const fetchSignInMethods = async (
  signal?: AbortSignal,
): Promise<readonly SignInMethodState[]> => {
  const response = await shellFetch('/api/v1/admin/sign-in-methods', {
    credentials: 'same-origin',
    ...withSignal(signal),
  })
  if (!response.ok) {
    throw new EzactoApiError(
      response.status,
      await errorBody(response),
      response.headers.get('x-request-id'),
    )
  }
  const envelope = (await response.json()) as { data: readonly SignInMethodState[] }
  return envelope.data
}

const patchSignInMethod = async (
  method: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<readonly SignInMethodState[]> => {
  const response = await shellFetch(
    `/api/v1/admin/sign-in-methods/${method}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
      credentials: 'same-origin',
      ...withSignal(signal),
    },
  )
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(refusal(text, 'That sign-in method could not be changed.'))
  }
  const envelope = (await response.json()) as { data: readonly SignInMethodState[] }
  return envelope.data
}

const signInMethodLabels: Record<SignInMethodState['method'], string> = {
  password: 'Email and password',
  magic_link: 'Sign-in link by email',
  google: 'Google',
  github: 'GitHub',
  // No button on the sign-in card: the app holds Apple's own prompt and posts
  // the identity token back. It is listed because it is still a way in.
  apple: 'Apple (in the mobile app)',
}

const renderSignInMethodCard = (state: SignInMethodState, demo: boolean): string => {
  const label = signInMethodLabels[state.method]
  // An unconfigured method is shown rather than hidden, and its toggle is
  // disabled: "this deployment has no credentials for it" is the answer an
  // administrator came here for, and an absent row answers nothing.
  const note = state.configured
    ? state.enabled
      ? 'Live. People can sign in this way.'
      : 'Switched off. The routes refuse it.'
    : 'Not configured in this deployment, so it cannot be switched on here.'
  // The switch is named by the method's heading as well as its state word, so
  // a screen reader hears "Google Enabled" rather than five switches all
  // called "Enabled". The span stays the label's first: the change handler
  // below rewrites the state word through it.
  const id = `settings-sign-in-${state.method}`
  return (
    `<article class="module-settings-card" data-sign-in-card="${state.method}">` +
    `<header class="module-settings-card-header">` +
    `<h3 id="${id}-title">${label}</h3>` +
    `<label class="module-toggle"><input type="checkbox" data-sign-in-toggle="${state.method}" aria-labelledby="${id}-title ${id}-state" aria-describedby="${id}-note"${state.enabled ? ' checked' : ''}${state.configured && !demo ? '' : ' disabled'}><span id="${id}-state">${state.enabled ? 'Enabled' : 'Disabled'}</span></label>` +
    `</header>` +
    `<p class="module-settings-warning" id="${id}-note">${note}</p>` +
    `<p class="form-result" data-sign-in-result="${state.method}" role="status" aria-live="polite"></p>` +
    `</article>`
  )
}

const renderModuleCard = (state: ModuleState): string => {
  const description = moduleDescriptions[state.module]
  const label = description?.label ?? state.module
  const warning = description?.warning ?? ''
  // Named and described the way a sign-in method's switch is, above.
  const id = `settings-module-${state.module}`
  return (
    `<article class="module-settings-card" data-module-card="${state.module}">` +
    `<header class="module-settings-card-header">` +
    `<h3 id="${id}-title">${label}</h3>` +
    `<label class="module-toggle"><input type="checkbox" data-module-toggle="${state.module}" aria-labelledby="${id}-title ${id}-state" aria-describedby="${id}-note"${state.enabled ? ' checked' : ''}><span id="${id}-state">${state.enabled ? 'Enabled' : 'Disabled'}</span></label>` +
    `</header>` +
    `<p class="module-settings-warning" id="${id}-note">${warning}</p>` +
    `<p class="form-result" data-module-result="${state.module}" role="status" aria-live="polite"></p>` +
    `</article>`
  )
}

export const createModuleSettingsController = (
  api: Partial<CompanySettingsApi>,
): ModuleSettingsController => {
  const status = required<HTMLElement>('[data-module-settings-status]')
  const list = required<HTMLElement>('[data-module-settings-list]')
  const signInStatus = required<HTMLElement>('[data-settings-sign-in-status]')
  const signInList = required<HTMLElement>('[data-settings-sign-in-list]')
  const timeStatus = required<HTMLElement>('[data-settings-time-status]')
  const timeFacts = required<HTMLElement>('[data-settings-time-facts]')
  const noteForm = required<HTMLFormElement>('[data-note-settings-form]')
  const noteRequired = required<HTMLInputElement>('[data-note-settings-required]')
  const noteMinimum = required<HTMLInputElement>('[data-note-settings-minimum]')
  const noteSubmit = required<HTMLButtonElement>('[data-note-settings-submit]')
  const noteResult = required<HTMLElement>('[data-note-settings-result]')
  const emailStatus = required<HTMLElement>('[data-settings-email-status]')
  const emailSenders = required<HTMLElement>('[data-settings-sender-identities]')
  const emailReputation = required<HTMLElement>('[data-settings-email-reputation]')
  const emailIdentityHealth = required<HTMLElement>('[data-settings-email-identities-health]')
  const webhookController = createWebhookController(api.webhooks)
  const suppressionReview = createEmailSuppressionController(api)
  const wiseSection = required<HTMLElement>('[data-settings-wise]')
  const wiseStatus = required<HTMLElement>('[data-settings-wise-status]')
  const wiseFacts = required<HTMLElement>('[data-settings-wise-facts]')
  const wiseAlarm = required<HTMLElement>('[data-settings-wise-alarm]')
  const backupStatus = required<HTMLElement>('[data-settings-backup-status]')
  const backupAlarm = required<HTMLElement>('[data-settings-backup-alarm]')
  const backupFacts = required<HTMLElement>('[data-settings-backup-facts]')
  const backupRuns = required<HTMLElement>('[data-settings-backup-runs]')
  const backupDownload = required<HTMLElement>('[data-settings-backup-download]')
  const backupControls = required<HTMLElement>('[data-settings-backup-controls]')
  const backupRunsStatus = required<HTMLElement>('[data-settings-backup-runs-status]')
  const brandStatus = required<HTMLElement>('[data-settings-brand-status]')
  const brandSlots = required<HTMLElement>('[data-settings-brand-slots]')
  const brandResult = required<HTMLElement>('[data-settings-brand-result]')
  const quickBooksStatus = required<HTMLElement>('[data-settings-quickbooks-status]')
  const quickBooksFacts = required<HTMLElement>('[data-settings-quickbooks-facts]')
  const quickBooksActions = required<HTMLElement>('[data-settings-quickbooks-actions]')
  const quickBooksConnect = required<HTMLButtonElement>('[data-quickbooks-connect]')
  const quickBooksPaymentRow = required<HTMLElement>('[data-quickbooks-payment-row]')
  const quickBooksAllowPayment = required<HTMLInputElement>('[data-quickbooks-allow-payment]')
  const quickBooksDisconnect = required<HTMLButtonElement>('[data-quickbooks-disconnect]')
  const quickBooksResult = required<HTMLElement>('[data-settings-quickbooks-result]')
  const quickBooksReconcilePanel = required<HTMLElement>('[data-quickbooks-reconcile-panel]')
  const quickBooksReconcile = required<HTMLButtonElement>('[data-quickbooks-reconcile]')
  const quickBooksReconcileResult = required<HTMLElement>('[data-quickbooks-reconcile-result]')
  const quickBooksReconcileTable = required<HTMLElement>('[data-quickbooks-reconcile-table]')
  const refreshControls = document.querySelectorAll<HTMLButtonElement>('[data-settings-refresh]')
  const themeStatus = required<HTMLElement>('[data-settings-theme-status]')
  const themeSlots = required<HTMLElement>('[data-settings-theme-slots]')
  const themeActions = required<HTMLElement>('[data-settings-theme-actions]')
  const themeSave = required<HTMLButtonElement>('[data-theme-save]')
  const themeRevert = required<HTMLButtonElement>('[data-theme-revert]')
  const themeReset = required<HTMLButtonElement>('[data-theme-reset]')
  const themeResult = required<HTMLElement>('[data-settings-theme-result]')
  const ssoStatus = required<HTMLElement>('[data-settings-sso-status]')
  const ssoDomains = required<HTMLElement>('[data-settings-sso-domains]')
  const ssoForm = required<HTMLFormElement>('[data-sso-domain-form]')
  const ssoInput = required<HTMLInputElement>('[data-sso-domain-input]')
  const ssoSubmit = required<HTMLButtonElement>('[data-sso-domain-submit]')
  const ssoResult = required<HTMLElement>('[data-sso-domain-result]')
  const invoicesStatus = required<HTMLElement>('[data-settings-invoices-status]')
  const invoiceDefaultsForm = required<HTMLFormElement>('[data-invoice-defaults-form]')
  const invoiceDefaultsName = required<HTMLInputElement>('[data-invoice-defaults-name]')
  const invoiceDefaultsAddress = required<HTMLTextAreaElement>('[data-invoice-defaults-address]')
  const invoiceDefaultsSubject = required<HTMLInputElement>('[data-invoice-defaults-subject]')
  const invoiceDefaultsNotes = required<HTMLTextAreaElement>('[data-invoice-defaults-notes]')
  const invoiceDefaultsEstimateDays = required<HTMLInputElement>(
    '[data-invoice-defaults-estimate-days]',
  )
  const invoiceDefaultsViewReceipts = required<HTMLInputElement>('[data-invoice-defaults-view-receipts]')
  const invoiceDefaultsSubmit = required<HTMLButtonElement>('[data-invoice-defaults-submit]')
  const invoiceDefaultsResult = required<HTMLElement>('[data-invoice-defaults-result]')
  // The public demo (issue 931). The company information and default values
  // are what every invoice tells a client to pay into, and its marks are files
  // in storage the nightly rebuild never empties, so both are read-only there
  // and say so. The sending defaults below them stay the demo's to change.
  const demo = isDemoDeployment()
  const invoiceDefaultsDemo = required<HTMLElement>('[data-invoice-defaults-demo]')
  const brandDemo = required<HTMLElement>('[data-settings-brand-demo]')
  invoiceDefaultsDemo.hidden = !demo
  brandDemo.hidden = !demo
  for (const field of [
    invoiceDefaultsName,
    invoiceDefaultsAddress,
    invoiceDefaultsSubject,
    invoiceDefaultsNotes,
    invoiceDefaultsEstimateDays,
    invoiceDefaultsViewReceipts,
  ]) {
    field.disabled = demo
  }
  // Sending: what an invoice's email carries unless the invoice says otherwise.
  const sendingParts = [
    ...document.querySelectorAll<HTMLElement>('[data-invoice-defaults-sending]'),
  ]
  const sendingPdf = required<HTMLInputElement>('[data-invoice-defaults-attach-pdf]')
  const sendingJournal = required<HTMLInputElement>('[data-invoice-defaults-attach-journal]')
  const sendingJournalDetail = required<HTMLElement>('[data-invoice-defaults-journal-detail]')
  const sendingJournalLevel = required<HTMLSelectElement>('[data-invoice-defaults-journal-level]')
  const sendingJournalFormats = required<HTMLFieldSetElement>(
    '[data-invoice-defaults-journal-formats]',
  )
  const sendingFiles = required<HTMLInputElement>('[data-invoice-defaults-attach-files]')
  const sendingAppend = required<HTMLInputElement>('[data-invoice-defaults-append-pdfs]')
  const sendingHeading = required<HTMLElement>('h3[data-invoice-defaults-sending]')
  // The company's own mailboxes, copied on every invoice email: the same
  // heading, its own endpoint, so it is shown and hidden on its own read.
  const alwaysCcParts = [
    ...document.querySelectorAll<HTMLElement>('[data-invoice-defaults-always-cc]'),
  ]
  const alwaysCcList = required<HTMLTextAreaElement>('[data-invoice-defaults-always-cc-list]')
  const remindersStatus = required<HTMLElement>('[data-settings-reminders-status]')
  const remindersForm = required<HTMLFormElement>('[data-reminder-settings-form]')
  const remindersEnabled = required<HTMLInputElement>('[data-reminder-settings-enabled]')
  const remindersFirst = required<HTMLInputElement>('[data-reminder-settings-first]')
  const remindersEvery = required<HTMLInputElement>('[data-reminder-settings-every]')
  const remindersSubmit = required<HTMLButtonElement>('[data-reminder-settings-submit]')
  const remindersResult = required<HTMLElement>('[data-reminder-settings-result]')
  const notificationsStatus = required<HTMLElement>('[data-settings-notifications-status]')
  const notificationsForm = required<HTMLFormElement>('[data-notification-settings-form]')
  const notificationsAdmins = required<HTMLInputElement>('[data-notification-settings-admins]')
  // Not `required<HTMLSelectElement>`: see the note on `type` above.
  const notificationsDay = required('[data-notification-settings-day]') as unknown as HTMLInputElement
  const notificationsTime = required<HTMLInputElement>('[data-notification-settings-time]')
  const notificationsSubmit = required<HTMLButtonElement>('[data-notification-settings-submit]')
  const notificationsResult = required<HTMLElement>('[data-notification-settings-result]')
  const autoApprovalStatus = required<HTMLElement>('[data-auto-approval-status]')
  const autoApprovalForm = required<HTMLFormElement>('[data-auto-approval-form]')
  const autoApprovalEnabled = required<HTMLInputElement>('[data-auto-approval-enabled]')
  const autoApprovalDays = required<HTMLInputElement>('[data-auto-approval-days]')
  const autoApprovalSince = required<HTMLElement>('[data-auto-approval-since]')
  const autoApprovalSubmit = required<HTMLButtonElement>('[data-auto-approval-submit]')
  const autoApprovalResult = required<HTMLElement>('[data-auto-approval-result]')

  // The list is held rather than re-fetched after every action: add, verify and
  // remove all answer with what they changed, and a re-fetch would throw away
  // the challenge token the operator is part way through publishing.
  let ssoState: readonly SsoDomain[] = []
  let ssoBusy = false
  let brandState: readonly BrandAssetState[] = []
  let brandBusy = false

  // What the server holds, and what the operator has typed since. Kept apart so
  // "undo my changes" is a real answer and so a save sends the whole palette --
  // the contrast rule is a property of the palette, not of one colour, so a
  // partial send could only be checked against whatever happened to be stored.
  let themeStored: Readonly<Record<string, string>> = {}
  let themeDraft: Record<string, string> = {}
  let themeBusy = false

  // The form is wired once, not on every activation: a sign-out and a sign-in
  // back into the page would otherwise leave two listeners on it and send the
  // policy twice.
  let session: ActiveSession | null = null

  // Which sections this session has read, by the promise that read them. A
  // section loads the first time it is shown and not again (issue 809): the
  // page used to fire every read the moment it opened, so opening Accounting
  // called Wise. A failed read takes itself out of here, which is what makes
  // Retry a second attempt rather than a cached failure.
  const loaded = new Map<string, Promise<void>>()

  /**
   * The session an operation may start for, or null when there is none. A
   * request begun for a session that has already ended is a request whose
   * answer has nowhere to go.
   */
  const currentSession = (): ActiveSession | null =>
    session === null || session.signal.aborted ? null : session

  /**
   * A read that failed. A 403 is an answer -- this profile cannot read the
   * section -- and stays as it was. Anything else says what to do and offers
   * to do it: the section comes out of `loaded`, so Retry is a second read of
   * that section and of nothing else.
   */
  const sectionFailed = (
    section: string,
    target: HTMLElement,
    error: unknown,
    forbidden: string,
    fallback: string,
  ): void => {
    if (error instanceof EzactoApiError && error.status === 403) {
      target.textContent = forbidden
      return
    }
    loaded.delete(section)
    target.textContent = loadFailureMessage(error, fallback)
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'settings-retry'
    retry.dataset.settingsRetry = section
    retry.textContent = 'Retry'
    retry.addEventListener('click', () => {
      retry.disabled = true
      void load(section)
    })
    target.append(' ', retry)
  }

  // The policy's numbers only matter while it is on; greying them out says so
  // without hiding what the default would be when switched back on.
  const syncReminderFields = (): void => {
    remindersFirst.disabled = !remindersEnabled.checked
    remindersEvery.disabled = !remindersEnabled.checked
  }
  remindersEnabled.addEventListener('change', syncReminderFields)

  const showReminderPolicy = (
    policy: { first_after_days: number; every_days: number } | null,
  ): void => {
    remindersEnabled.checked = policy !== null
    remindersFirst.value = String(policy?.first_after_days ?? 3)
    remindersEvery.value = String(policy?.every_days ?? 7)
    syncReminderFields()
  }

  // The Sending defaults as stored, so a save writes only what changed; null
  // where this build or this read has none to offer.
  let sending: InvoiceDocumentsSetting | null = null
  // The always-copied addresses as stored, held the same way and for the same
  // reason.
  let alwaysCc: readonly InvoiceRecipient[] | null = null

  const sendingFormatBoxes = (): HTMLInputElement[] => [
    ...sendingJournalFormats.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ]

  // The heading stands over either half, so it goes only when both have.
  const syncSendingHeading = (): void => {
    sendingHeading.hidden = sending === null && alwaysCc === null
  }

  const showAlwaysCc = (setting: OrganizationInvoiceSendingSetting | null): void => {
    alwaysCc = setting === null ? null : setting.always_cc
    for (const part of alwaysCcParts) part.hidden = setting === null
    alwaysCcList.value = setting === null ? '' : invoiceAddressLines(setting.always_cc)
    syncSendingHeading()
  }

  // The report's detail and files only matter while it is attached.
  const syncSendingJournal = (): void => {
    const shown = sending !== null && sendingJournal.checked
    sendingJournalDetail.hidden = !shown
    sendingJournalFormats.hidden = !shown
  }
  sendingJournal.addEventListener('change', syncSendingJournal)

  const showSending = (setting: InvoiceDocumentsSetting | null): void => {
    sending = setting
    for (const part of sendingParts) part.hidden = setting === null
    if (setting !== null) {
      const choice = invoiceSendingChoice(setting)
      sendingPdf.checked = choice.attachPdf
      sendingFiles.checked = choice.attachFiles
      sendingAppend.checked = choice.appendPdfs
      sendingJournal.checked = choice.journal !== false
      sendingJournalLevel.value = choice.journal === false ? 'detailed' : choice.journal
      for (const box of sendingFormatBoxes()) {
        box.checked = choice.journalFormats.some((format) => format === box.value)
      }
    }
    syncSendingJournal()
    syncSendingHeading()
  }

  const chosenSending = (): InvoiceSendingChoice => ({
    attachPdf: sendingPdf.checked,
    attachFiles: sendingFiles.checked,
    appendPdfs: sendingAppend.checked,
    journal: sendingJournal.checked
      ? sendingJournalLevel.value === 'summary'
        ? 'summary'
        : 'detailed'
      : false,
    journalFormats: sendingFormatBoxes()
      .filter((box) => box.checked)
      .map((box) => box.value as InvoiceSendingChoice['journalFormats'][number]),
  })

  const showInvoiceDefaults = (defaults: InvoiceDefaultsSetting): void => {
    invoiceDefaultsName.value = defaults.company_name
    invoiceDefaultsAddress.value = defaults.company_address ?? ''
    invoiceDefaultsSubject.value = defaults.subject ?? ''
    invoiceDefaultsNotes.value = defaults.notes ?? ''
    invoiceDefaultsEstimateDays.value =
      defaults.estimate_validity_days === null ? '' : String(defaults.estimate_validity_days)
    invoiceDefaultsViewReceipts.checked = defaults.view_receipts === true
  }

  invoiceDefaultsForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const active = currentSession()
    if (active === null || api.updateInvoiceDefaults === undefined) return
    if (invoiceDefaultsName.value.trim() === '') {
      invoiceDefaultsResult.textContent = 'The company name cannot be blank.'
      return
    }
    const estimateDays = invoiceDefaultsEstimateDays.value.trim()
    if (
      estimateDays !== '' &&
      (!/^[1-9][0-9]{0,3}$/.test(estimateDays) || Number(estimateDays) > 3650)
    ) {
      invoiceDefaultsResult.textContent =
        'Estimate validity is a whole number of days from 1 to 3650, or blank.'
      return
    }
    let sendingChange: ReturnType<typeof invoiceSendingChanges>
    let alwaysCcChange: ReturnType<typeof invoiceAlwaysCcChange>
    try {
      sendingChange = sending === null ? null : invoiceSendingChanges(sending, chosenSending())
      alwaysCcChange = alwaysCc === null ? null : invoiceAlwaysCcChange(alwaysCc, alwaysCcList.value)
    } catch (error) {
      invoiceDefaultsResult.textContent =
        error instanceof Error ? error.message : 'Check the sending defaults.'
      return
    }
    invoiceDefaultsResult.textContent = 'Saving…'
    invoiceDefaultsSubmit.disabled = true
    // Blank is no default; the server stores it as one.
    const text = (value: string): string | null => (value.trim() === '' ? null : value)
    let defaultsSaved = false
    let attachmentsSaved = false
    try {
      // Read-only on the demo, so only the halves below are written there.
      if (!demo) {
        const saved = await api.updateInvoiceDefaults(
          {
            company_name: invoiceDefaultsName.value,
            company_address: text(invoiceDefaultsAddress.value),
            subject: text(invoiceDefaultsSubject.value),
            notes: text(invoiceDefaultsNotes.value),
            estimate_validity_days: estimateDays === '' ? null : Number(estimateDays),
            view_receipts: invoiceDefaultsViewReceipts.checked,
          },
          active.signal,
        )
        active.present(() => showInvoiceDefaults(saved))
      }
      defaultsSaved = true
      // The two halves are two endpoints. Sending is written second and only
      // where it changed, so a refusal there leaves the first half saved and
      // says so rather than reading as though nothing was.
      if (sendingChange !== null && api.setOrganizationInvoiceDocuments !== undefined) {
        const stored = await api.setOrganizationInvoiceDocuments(sendingChange, active.signal)
        active.present(() => showSending(stored))
      }
      attachmentsSaved = true
      // The always-copied addresses are a third endpoint, written last and
      // only where they changed, for the same reason the attachments are.
      if (alwaysCcChange !== null && api.setOrganizationInvoiceSending !== undefined) {
        const stored = await api.setOrganizationInvoiceSending(
          { always_cc: alwaysCcChange },
          active.signal,
        )
        active.present(() => showAlwaysCc(stored))
      }
      active.present(() => {
        invoiceDefaultsResult.textContent = 'Saved.'
      })
    } catch (error) {
      active.presentFailure(error, () => {
        const reason = messageFor(
          error,
          'Only administrators and accounting can change invoice settings.',
          'Invoice settings could not be saved.',
        )
        invoiceDefaultsResult.textContent = !defaultsSaved
          ? reason
          : !attachmentsSaved
            ? `The company information and default values were saved, but the sending defaults were not: ${reason}`
            : `Everything else was saved, but the addresses to always copy were not: ${reason}`
      })
    } finally {
      if (currentSession() === active) invoiceDefaultsSubmit.disabled = false
    }
  })

  remindersForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const active = currentSession()
    if (active === null || api.updateInvoiceReminders === undefined) return
    remindersResult.textContent = 'Saving…'
    remindersSubmit.disabled = true
    try {
      const saved = await api.updateInvoiceReminders(
        reminderPolicyFromForm({
          enabled: remindersEnabled.checked,
          firstAfterDays: remindersFirst.value,
          everyDays: remindersEvery.value,
        }),
        active.signal,
      )
      active.present(() => {
        showReminderPolicy(saved.policy)
        remindersResult.textContent =
          saved.policy === null
            ? 'Saved. Payment reminders are off.'
            : saved.applied === 0
              ? 'Saved.'
              : `Saved. Booked for ${saved.applied} open ${saved.applied === 1 ? 'invoice' : 'invoices'} with nothing pending.`
      })
    } catch (error) {
      active.presentFailure(error, () => {
        remindersResult.textContent = messageFor(
          error,
          'Only administrators and accounting can change payment reminders.',
          'Payment reminders could not be saved.',
        )
      })
    } finally {
      if (currentSession() === active) remindersSubmit.disabled = false
    }
  })

  const showNotificationSettings = (settings: NotificationSettingsState): void => {
    notificationsAdmins.checked = settings.budget_alerts_include_admins
    notificationsDay.value = settings.submission_reminder?.day ?? ''
    notificationsTime.value = settings.submission_reminder?.time ?? ''
  }

  notificationsForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const active = currentSession()
    if (active === null || api.updateNotificationSettings === undefined) return
    // A day with no time (or the reverse) is half a schedule: say so rather
    // than guess which half was meant.
    if ((notificationsDay.value === '') !== (notificationsTime.value === '')) {
      notificationsResult.textContent =
        notificationsDay.value === ''
          ? 'Choose a day for the submission reminder, or clear the time.'
          : 'Choose a time for the submission reminder.'
      return
    }
    notificationsResult.textContent = 'Saving…'
    notificationsSubmit.disabled = true
    try {
      const saved = await api.updateNotificationSettings(
        {
          budget_alerts_include_admins: notificationsAdmins.checked,
          submission_reminder:
            notificationsDay.value === ''
              ? null
              : {
                  day: notificationsDay.value as NonNullable<
                    NotificationSettingsState['submission_reminder']
                  >['day'],
                  time: notificationsTime.value,
                },
        },
        active.signal,
      )
      active.present(() => {
        showNotificationSettings(saved)
        notificationsResult.textContent = 'Saved.'
      })
    } catch (error) {
      active.presentFailure(error, () => {
        notificationsResult.textContent = messageFor(
          error,
          'Only administrators can change notification settings.',
          'Notification settings could not be saved.',
        )
      })
    } finally {
      if (currentSession() === active) notificationsSubmit.disabled = false
    }
  })

  const showAutoApproval = (settings: TimesheetAutoApprovalState): void => {
    autoApprovalEnabled.checked = settings.enabled
    autoApprovalDays.value = settings.window_days === null ? '' : String(settings.window_days)
    autoApprovalSince.textContent = !settings.approval_module_enabled
      ? 'Needs the Approval module, which is off.'
      : settings.enabled && settings.effective_from !== null
        ? `Applies to weeks submitted on or after ${settings.effective_from.slice(0, 10)}.`
        : 'Turning this on does not approve weeks that are already waiting.'
  }

  autoApprovalForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const active = currentSession()
    if (active === null || api.updateTimesheetAutoApproval === undefined) return
    if (autoApprovalEnabled.checked && autoApprovalDays.value === '') {
      autoApprovalResult.textContent = 'Choose how many days a week waits before it is approved.'
      return
    }
    autoApprovalResult.textContent = 'Saving…'
    autoApprovalSubmit.disabled = true
    try {
      const saved = await api.updateTimesheetAutoApproval(
        {
          enabled: autoApprovalEnabled.checked,
          ...(autoApprovalDays.value === '' ? {} : { window_days: Number(autoApprovalDays.value) }),
        },
        active.signal,
      )
      active.present(() => {
        showAutoApproval(saved)
        autoApprovalResult.textContent = 'Saved.'
      })
    } catch (error) {
      active.presentFailure(error, () => {
        autoApprovalResult.textContent = messageFor(
          error,
          'Only administrators can change automatic approval.',
          'Automatic approval could not be saved.',
        )
      })
    } finally {
      if (currentSession() === active) autoApprovalSubmit.disabled = false
    }
  })

  noteForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const active = currentSession()
    if (active === null || api.updateTimeEntryNoteSettings === undefined) return
    noteResult.textContent = 'Saving…'
    noteSubmit.disabled = true
    try {
      const saved = await api.updateTimeEntryNoteSettings(
        noteSettingsPatch({
          required: noteRequired.checked,
          minimumLength: noteMinimum.value,
        }),
        active.signal,
      )
      active.present(() => {
        noteRequired.checked = saved.required
        noteMinimum.value = String(saved.minimum_length)
        noteResult.textContent = 'Saved.'
      })
    } catch (error) {
      active.presentFailure(error, () => {
        noteResult.textContent = messageFor(
          error,
          'Only executive managers and administrators can change the notes policy.',
          'The notes policy could not be saved.',
        )
      })
    } finally {
      // Re-enabling belongs to the session that disabled it. The next session
      // gets its controls back from clearPrivatePresentation instead.
      active.present(() => {
        noteSubmit.disabled = false
      })
    }
  })

  const senderTable = (identities: readonly SenderIdentity[]): HTMLElement =>
    renderDataTable<SenderIdentity>({
      caption: 'Sender identities',
      table: 'settings-senders',
      defaultSort: { column: 'default', direction: 'ascending' },
      rows: identities,
      rowKey: (identity) => String(identity.id),
      empty: 'No sender identity is configured, so nothing this instance sends has a from address.',
      columns: [
        { key: 'email', label: 'Sends as', sortValue: (identity) => identity.email, render: (identity) => identity.email },
        {
          key: 'display_name',
          label: 'Display name',
          sortValue: (identity) => identity.display_name,
          render: (identity) => identity.display_name,
        },
        {
          key: 'provider',
          label: 'Transport',
          sortValue: (identity) => identity.provider,
          render: (identity) => identity.provider,
        },
        {
          key: 'verification',
          label: 'Verification',
          sortValue: (identity) => senderVerificationLabel(identity),
          render: (identity) => senderVerificationLabel(identity),
        },
        {
          key: 'default',
          label: 'Default',
          sortValue: (identity) => identity.is_default ? 0 : 1,
          render: (identity) => (identity.is_default ? 'Default' : ''),
        },
      ],
    })

  /**
   * The row's payload. A domain verifies only once this exact TXT record is in
   * the zone, so the name and the value are on screen to be copied — the
   * alternative, before this screen existed, was reading the challenge token
   * out of D1 by hand.
   */
  const ssoRecordCell = (domain: SsoDomain): HTMLElement => {
    const wrapper = document.createElement('div')
    wrapper.className = 'sso-record'
    const name = document.createElement('code')
    name.textContent = `${domain.record_name} ${domain.record_type}`
    const value = document.createElement('code')
    value.textContent = domain.record_value
    wrapper.append(name, value)
    return wrapper
  }

  const paintSsoDomains = (): void => {
    ssoDomains.replaceChildren(
      renderDataTable<SsoDomain>({
        caption: 'SSO provisioning domains',
        table: 'settings-sso-domains',
        defaultSort: { column: 'domain', direction: 'ascending' },
        rows: ssoState,
        rowKey: (domain) => String(domain.id),
        empty:
          'No domain is provisioned, so single sign-on creates nobody. Add the email domain your directory signs in with.',
        // The domain, its status and the date take their own width; the record
        // is what an operator copies into a zone file, so it takes the rest and
        // wraps rather than ending in an ellipsis on a narrow window.
        columns: [
          {
            key: 'domain',
            label: 'Domain',
            fit: true,
            sortValue: (domain) => domain.domain,
            render: (domain) => domain.domain,
          },
          {
            key: 'status',
            label: 'Status',
            fit: true,
            sortValue: (domain) => ssoDomainStatus(domain),
            render: (domain) => ssoDomainStatus(domain),
          },
          {
            key: 'checked',
            label: 'Last checked',
            fit: true,
            sortValue: (domain) => domain.last_checked_at,
            render: (domain) => ssoLastCheckedLabel(domain),
          },
          { key: 'record', label: 'DNS record', wrap: true, render: (domain) => ssoRecordCell(domain) },
        ],
        // The demo refuses both (issue 931), so neither is offered as if it worked.
        actions: (domain) => [
          {
            label: 'Verify',
            primary: true,
            disabled: ssoBusy || demo,
            onSelect: () => void verifySsoDomain(domain),
          },
          {
            label: 'Remove',
            disabled: ssoBusy || demo,
            onSelect: () => void removeSsoDomain(domain),
          },
        ],
      }),
    )
    ssoDomains.hidden = false
  }

  /**
   * One card per slot, drawn on the ground the mark will actually be drawn on.
   * A light-on-transparent wordmark previewed on white is invisible, which is
   * the same mistake as uploading it to the wrong slot and looks identical to
   * an operator, so the preview commits to the ground the label names.
   */
  const paintBrandAssets = (): void => {
    brandSlots.replaceChildren(
      ...brandAssetSlotCopy.map((copy) => {
        const stored = brandState.find((asset) => asset.slot === copy.slot)
        const card = document.createElement('article')
        card.className = 'brand-slot'
        card.dataset.brandSlot = copy.slot

        const heading = document.createElement('h3')
        heading.textContent = copy.label
        const hint = document.createElement('p')
        hint.className = 'hint'
        hint.textContent = copy.hint

        const preview = document.createElement('div')
        preview.className = 'brand-slot-preview'
        preview.dataset.ground = copy.preview
        if (stored === undefined) {
          const empty = document.createElement('p')
          empty.className = 'hint'
          // Two different nothings. No mark stored does not mean no mark shown:
          // the deployment may still be setting one by environment variable,
          // and saying "nothing uploaded" rather than "no logo" is what keeps
          // an operator from hunting for a logo that is working as configured.
          empty.textContent = 'Nothing uploaded. The deployment setting applies.'
          preview.append(empty)
        } else {
          const image = document.createElement('img')
          image.src = stored.url
          image.alt = `${copy.label} preview`
          preview.append(image)
        }

        // A button-shaped label over a visually hidden file input: the upload
        // starts the moment a file is chosen, so the browser's own "No file
        // chosen" box had nothing to say, and it squeezed the label beside it
        // into three lines.
        const picker = document.createElement('label')
        picker.className = 'brand-slot-picker editor-secondary'
        picker.append(stored === undefined ? 'Upload an image' : 'Replace')
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = brandAssetAccept
        input.disabled = brandBusy || demo
        input.addEventListener('change', () => {
          const file = input.files?.[0]
          input.value = ''
          if (file !== undefined) void submitBrandAsset(copy.segment, file)
        })
        picker.append(input)

        const actions = document.createElement('div')
        actions.className = 'brand-slot-actions'
        actions.append(picker)
        if (stored !== undefined) {
          const remove = document.createElement('button')
          remove.type = 'button'
          remove.className = 'editor-secondary'
          remove.textContent = 'Remove'
          remove.disabled = brandBusy
          remove.addEventListener('click', () => void discardBrandAsset(copy.segment))
          actions.append(remove)
        }

        card.append(heading, hint, preview, actions)
        return card
      }),
    )
    brandSlots.hidden = false
  }

  const submitBrandAsset = async (segment: string, file: File): Promise<void> => {
    const active = currentSession()
    if (active === null) return
    const rejection = brandAssetRejection(file)
    if (rejection !== null) {
      brandResult.textContent = rejection
      return
    }
    brandBusy = true
    paintBrandAssets()
    brandResult.textContent = `Uploading ${file.name}…`
    try {
      await uploadBrandAsset(segment, file, active.signal)
      const assets = await fetchBrandAssets(active.signal)
      active.present(() => {
        brandState = assets
        // The URL carries the content hash, so a replaced mark is a new URL and
        // the browser cannot show the old one back from cache.
        brandResult.textContent = `${file.name} is now in use.`
      })
    } catch (error) {
      active.presentFailure(error, () => {
        brandResult.textContent = apiErrorMessage(error, 'The brand asset could not be uploaded.')
      })
    } finally {
      brandBusy = false
      active.present(paintBrandAssets)
    }
  }

  const discardBrandAsset = async (segment: string): Promise<void> => {
    const active = currentSession()
    if (active === null) return
    brandBusy = true
    paintBrandAssets()
    brandResult.textContent = 'Removing…'
    try {
      await removeBrandAsset(segment, active.signal)
      const assets = await fetchBrandAssets(active.signal)
      active.present(() => {
        brandState = assets
        brandResult.textContent =
          'Removed. This instance is back to whatever the deployment configures for that mark.'
      })
    } catch (error) {
      active.presentFailure(error, () => {
        brandResult.textContent = apiErrorMessage(error, 'The brand asset could not be removed.')
      })
    } finally {
      brandBusy = false
      active.present(paintBrandAssets)
    }
  }

  const verifySsoDomain = async (domain: SsoDomain): Promise<void> => {
    const active = currentSession()
    if (active === null || api.verifySsoDomain === undefined) return
    ssoBusy = true
    paintSsoDomains()
    ssoResult.textContent = `Checking ${domain.domain}…`
    try {
      const check = await api.verifySsoDomain(domain.id, active.signal)
      active.present(() => {
        ssoState = ssoState.map((row) => (row.id === check.id ? check : row))
        ssoResult.textContent = ssoVerificationMessage(check)
      })
    } catch (error) {
      active.presentFailure(error, () => {
        // A lookup that could not run is not a domain that failed the check: the
        // record may be published and perfect. The API's own message says which
        // happened, so an operator does not go and pull a correct record.
        ssoResult.textContent = apiErrorMessage(error, 'The domain could not be checked.')
      })
    } finally {
      ssoBusy = false
      active.present(paintSsoDomains)
    }
  }

  const removeSsoDomain = async (domain: SsoDomain): Promise<void> => {
    const active = currentSession()
    if (active === null || api.removeSsoDomain === undefined) return
    ssoBusy = true
    paintSsoDomains()
    ssoResult.textContent = `Removing ${domain.domain}…`
    try {
      await api.removeSsoDomain(domain.id, active.signal)
      active.present(() => {
        ssoState = ssoState.filter((row) => row.id !== domain.id)
        ssoResult.textContent = `${domain.domain} no longer provisions anyone.`
      })
    } catch (error) {
      active.presentFailure(error, () => {
        ssoResult.textContent = apiErrorMessage(error, 'The domain could not be removed.')
      })
    } finally {
      ssoBusy = false
      active.present(paintSsoDomains)
    }
  }

  ssoForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const active = currentSession()
    if (active === null || api.addSsoDomain === undefined) return
    const domain = ssoInput.value.trim()
    if (domain === '') {
      ssoResult.textContent = 'Enter the email domain to provision from, such as example.com.'
      return
    }
    ssoResult.textContent = 'Adding…'
    ssoSubmit.disabled = true
    try {
      const added = await api.addSsoDomain(domain, active.signal)
      // The new domain reaches the held list here and not a line earlier: a
      // domain added into a session that has ended is a challenge token
      // waiting for the next paint to put it on someone else's screen.
      active.present(() => {
        ssoState = [...ssoState, added]
        ssoInput.value = ''
        paintSsoDomains()
        // Added is not enabled: nothing is provisioned from it until the record
        // published below verifies, and the next step has to be said out loud or
        // a half-configured domain reads as a working one.
        ssoResult.textContent =
          `${added.domain} added. Publish the ${added.record_type} record shown, then verify it.`
      })
    } catch (error) {
      active.presentFailure(error, () => {
        ssoResult.textContent = apiErrorMessage(error, 'The domain could not be added.')
      })
    } finally {
      active.present(() => {
        ssoSubmit.disabled = false
      })
    }
  })

  /**
   * Everything a signed-in session put on this page. activate() calls it before
   * it does anything else, because the page outlives the session: signing out
   * and back in as someone else happens in the same document, and the previous
   * administrator's sender identities and reputation figures were still on
   * screen for whoever signed in next. Rewriting the status strings, which is
   * all the non-privileged branch used to do, does not remove what is rendered
   * above them.
   */
  const deletionRequests = createDeletionRequestsController(required<HTMLElement>('[data-module-settings-page]'), demo)
  const retention = createRetentionController(required<HTMLElement>('[data-module-settings-page]'), demo)
  const timeRounding = createTimeRoundingController(
    required<HTMLElement>('[data-settings-section="time"]'),
    api,
    () => session,
  )

  const clearPrivatePresentation = (): void => {
    // The previous session stops owning the page here, before anything is
    // taken off it. Whatever it still has in flight then has nowhere to paint,
    // whether or not the shell remembered to abort its signal on the way out.
    session = null
    loaded.clear()
    retention.clear()
    deletionRequests.clear()
    backupHistoryOwner?.abort()
    backupHistoryOwner = null
    backupLog = null
    backupFacts.replaceChildren()
    backupFacts.hidden = true
    backupRuns.replaceChildren()
    backupRuns.hidden = backupControls.hidden = true
    backupRunsStatus.textContent = ''
    backupAlarm.hidden = true
    backupAlarm.textContent = backupStatus.textContent = ''
    backupDownload.hidden = true
    backupDownloadCode.value = backupDownloadLink.value = ''
    backupDownloadResult.textContent = ''
    backupDownloadCodeRow.hidden = backupDownloadLinkRow.hidden = true
    backupDownloadMint.disabled = false
    offsiteSession = null
    offsiteCheckRow.hidden = true
    offsiteCheckResult.textContent = ''
    offsiteCheck.disabled = false
    // Its controls come back with the page rather than from the finally of an
    // operation that is no longer allowed to touch anything.
    noteSubmit.disabled = false
    ssoSubmit.disabled = false
    ssoBusy = false
    emailSenders.replaceChildren()
    emailSenders.hidden = true
    webhookController.clear()
    suppressionReview.clear()
    emailIdentityHealth.replaceChildren()
    emailIdentityHealth.hidden = true
    emailReputation.replaceChildren()
    emailReputation.hidden = true
    timeFacts.replaceChildren()
    noteForm.hidden = true
    timeRounding.clear()
    dataTools.clear()
    // The result line sits outside the form, so hiding the form leaves the
    // previous session's "Saved." or its 403 on screen under the next
    // person's notice.
    noteResult.textContent = ''
    list.replaceChildren()
    // The challenge tokens are the domains' proof of ownership as much as the
    // record they name, so they go with the rest of the previous session's
    // company data rather than sitting under a notice saying it is not yours.
    // The marks themselves are public, but which of them this instance has
    // uploaded is company configuration, so it leaves with the rest of it.
    brandState = []
    brandBusy = false
    brandSlots.replaceChildren()
    brandSlots.hidden = true
    brandResult.textContent = ''
    ssoState = []
    ssoDomains.replaceChildren()
    ssoDomains.hidden = true
    ssoForm.hidden = true
    ssoInput.value = ''
    ssoResult.textContent = ''
  }

  /**
   * Two sections, loaded independently. A deployment with no mail transport
   * still has a notes policy worth reading, so one section's 403 or 500 must
   * not take the other down with it.
   */
  const loadTimeTracking = async (active: ActiveSession): Promise<void> => {
    if (api.getTimeEntrySettings === undefined || api.getTimeEntryNoteSettings === undefined) {
      timeStatus.textContent = 'This build has no time tracking settings endpoint.'
      return
    }
    try {
      const [settings, notes] = await Promise.all([
        api.getTimeEntrySettings(active.signal),
        api.getTimeEntryNoteSettings(active.signal),
      ])
      active.present(() => {
        facts(timeFacts, timeTrackingFacts(settings))
        noteRequired.checked = notes.required
        noteMinimum.value = String(notes.minimum_length)
        noteForm.hidden = false
        timeRounding.show(active, settings.time_rounding)
        timeStatus.textContent = ''
      })
    } catch (error) {
      // Every other controller in the shell answers a 401 by ending the
      // session rather than printing the transport error. Without it the shell
      // still presents a signed-out user as signed in, over a raw
      // "request failed with status 401".
      active.presentFailure(error, () => {
        sectionFailed(
          'time',
          timeStatus,
          error,
          'Only executive managers and administrators can read the time tracking settings.',
          'Time tracking settings could not be loaded.',
        )
      })
    }
  }

  const loadInvoiceDefaults = async (active: ActiveSession): Promise<void> => {
    if (api.getInvoiceDefaults === undefined) {
      invoicesStatus.textContent = 'This build has no invoice settings endpoint.'
      return
    }
    try {
      // Sending is read beside the defaults and is the lesser half: a build
      // without its routes, or a read of it that fails, leaves the rest of the
      // form working and says so, rather than taking the section down.
      const [defaults, documents, copies] = await Promise.all([
        api.getInvoiceDefaults(active.signal),
        api.getOrganizationInvoiceDocuments === undefined ||
        api.setOrganizationInvoiceDocuments === undefined
          ? Promise.resolve(null)
          : api.getOrganizationInvoiceDocuments(active.signal).then(
              (setting): InvoiceDocumentsSetting | Error => setting,
              (error: unknown): InvoiceDocumentsSetting | Error =>
                error instanceof Error ? error : new Error('The sending defaults could not be loaded.'),
            ),
        api.getOrganizationInvoiceSending === undefined ||
        api.setOrganizationInvoiceSending === undefined
          ? Promise.resolve(null)
          : api.getOrganizationInvoiceSending(active.signal).then(
              (setting): OrganizationInvoiceSendingSetting | Error => setting,
              (error: unknown): OrganizationInvoiceSendingSetting | Error =>
                error instanceof Error
                  ? error
                  : new Error('The addresses to always copy could not be loaded.'),
            ),
      ])
      active.present(() => {
        showInvoiceDefaults(defaults)
        showSending(documents instanceof Error ? null : documents)
        showAlwaysCc(copies instanceof Error ? null : copies)
        invoiceDefaultsForm.hidden = false
        const unread = [
          ...(documents instanceof Error
            ? [`The sending defaults could not be loaded: ${documents.message}`]
            : []),
          ...(copies instanceof Error
            ? [`The addresses to always copy could not be loaded: ${copies.message}`]
            : []),
        ]
        invoicesStatus.textContent =
          unread.length > 0
            ? unread.join(' ')
            : defaults.company_address === null
              ? 'No company address yet: invoices print the name alone until one is saved.'
              : ''
      })
    } catch (error) {
      active.presentFailure(error, () => {
        sectionFailed(
          'invoices',
          invoicesStatus,
          error,
          'Only administrators and accounting can read invoice settings.',
          'Invoice settings could not be loaded.',
        )
      })
    }
  }

  const loadReminders = async (active: ActiveSession): Promise<void> => {
    if (api.getInvoiceReminders === undefined) {
      remindersStatus.textContent = 'This build has no payment reminder settings endpoint.'
      return
    }
    try {
      const policy = await api.getInvoiceReminders(active.signal)
      active.present(() => {
        showReminderPolicy(policy)
        remindersForm.hidden = false
        remindersStatus.textContent = ''
      })
    } catch (error) {
      active.presentFailure(error, () => {
        sectionFailed(
          'reminders',
          remindersStatus,
          error,
          'Only administrators and accounting can read payment reminder settings.',
          'Payment reminder settings could not be loaded.',
        )
      })
    }
  }

  const loadAutoApproval = async (active: ActiveSession): Promise<void> => {
    if (api.getTimesheetAutoApproval === undefined) {
      autoApprovalStatus.textContent = 'This build has no automatic approval endpoint.'
      return
    }
    try {
      const settings = await api.getTimesheetAutoApproval(active.signal)
      active.present(() => {
        showAutoApproval(settings)
        autoApprovalForm.hidden = false
        autoApprovalStatus.textContent = ''
      })
    } catch (error) {
      active.presentFailure(error, () => {
        sectionFailed(
          'approval',
          autoApprovalStatus,
          error,
          'Only administrators can read automatic approval.',
          'Automatic approval could not be loaded.',
        )
      })
    }
  }

  const loadNotifications = async (active: ActiveSession): Promise<void> => {
    if (api.getNotificationSettings === undefined) {
      notificationsStatus.textContent = 'This build has no notification settings endpoint.'
      return
    }
    try {
      const settings = await api.getNotificationSettings(active.signal)
      active.present(() => {
        showNotificationSettings(settings)
        notificationsForm.hidden = false
        notificationsStatus.textContent = ''
      })
    } catch (error) {
      active.presentFailure(error, () => {
        sectionFailed(
          'notifications',
          notificationsStatus,
          error,
          'Only administrators can read notification settings.',
          'Notification settings could not be loaded.',
        )
      })
    }
  }

  const loadEmail = async (identity: Whoami, active: ActiveSession): Promise<void> => {
    // email-health and sender-identities are both administrator-only. Asking as
    // an executive manager buys two 403s and tells the operator nothing.
    if (identity.profile !== 'administrator') {
      emailStatus.textContent = 'Email delivery is visible to administrators only.'
      return
    }
    if (api.listSenderIdentities === undefined || api.getEmailHealth === undefined) {
      emailStatus.textContent = 'This build has no email delivery endpoints.'
      return
    }
    try {
      const [identities, health] = await Promise.all([
        api.listSenderIdentities(active.signal),
        api.getEmailHealth(active.signal),
      ])
      const presented = active.present(() => {
        emailSenders.replaceChildren(senderTable(identities))
        emailSenders.hidden = false
        emailIdentityHealth.replaceChildren(
          renderDataTable({
            caption: 'Recorded sender health',
            table: 'email-identity-health',
            rows: health.identities ?? [],
            rowKey: (row) => row.sender,
            empty: 'No sender delivery history is recorded.',
            columns: [
              {
                key: 'sender',
                label: 'Sender',
                sortValue: (row) => row.sender,
                render: (row) => row.sender,
              },
              {
                key: 'accepted',
                label: 'Accepted messages',
                numeric: true,
                render: (row) => String(row.sent),
              },
              {
                key: 'bounced',
                label: 'Bounced',
                render: (row) => `${row.bounced} (${ratePercentage(row.bounce_rate_ppm)})`,
              },
              {
                key: 'complained',
                label: 'Complained',
                render: (row) => `${row.complained} (${ratePercentage(row.complaint_rate_ppm)})`,
              },
              {
                key: 'failed',
                label: 'Failed to send',
                numeric: true,
                render: (row) => String(row.failed),
              },
              {
                key: 'feedback',
                label: 'Feedback',
                render: (row) =>
                  [
                    row.complained > 0
                      ? 'Complaint recorded'
                      : row.bounced > 0
                        ? 'Bounce recorded'
                        : 'No negative feedback recorded',
                    emailReputationWarning(row),
                  ]
                    .filter(Boolean)
                    .join('. '),
              },
            ],
          }),
        )

        emailIdentityHealth.hidden = false
        facts(emailReputation, [
          // reputation.sent is counts.sent + bounced + complained — the total
          // accepted, and the denominator both rates are taken over. Labelling it
          // Delivered overstated delivery and implied a total larger than the
          // real one, since a reader adds the bounced and complained rows to it.
          ['Accepted', String(health.reputation.sent)],
          ['Bounced', `${health.reputation.bounced} (${ratePercentage(health.reputation.bounce_rate_ppm)})`],
          [
            'Complained',
            `${health.reputation.complained} (${ratePercentage(health.reputation.complaint_rate_ppm)})`,
          ],
          ['Failed to send', String(health.reputation.failed)],
        ])
        emailStatus.textContent = ''
      })
      if (presented) await suppressionReview.activate({identity,signal:active.signal,failed:(error,paint)=>{active.presentFailure(error,paint)}})
    } catch (error) {
      active.presentFailure(error, () => {
        sectionFailed(
          'email',
          emailStatus,
          error,
          'Only administrators can view email delivery.',
          'Email delivery could not be loaded.',
        )
      })
    }
  }

  /**
   * How long ago, said the way someone reading a backup screen is thinking.
   * "2026-09-07T03:00:12Z" answers a different question from "2 days ago", and
   * the question here is whether the last one is recent enough.
   */
  const sinceLabel = (at: string, now: number): string => {
    const elapsed = now - Date.parse(at)
    if (!Number.isFinite(elapsed) || elapsed < 0) return at.slice(0, 10)
    const hours = Math.floor(elapsed / 3_600_000)
    if (hours < 1) return 'less than an hour ago'
    if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
    const days = Math.floor(hours / 24)
    return `${days} ${days === 1 ? 'day' : 'days'} ago`
  }

  // Said in UTC until the organization's timezone is known, and labelled so.
  let backupZone = 'UTC'

  const backupRunTable = (runs: readonly BackupRun[]): HTMLElement =>
    renderDataTable<BackupRun>({
      caption: 'Recent backup runs',
      table: 'settings-backup-runs',
      defaultSort: { column: 'started', direction: 'descending' },
      rows: runs,
      rowKey: (run) => String(run.id),
      empty: 'No backup has run yet.',
      columns: [
        {
          key: 'started',
          label: `Started (${backupZone})`,
          sortValue: (run) => run.started_at,
          // In the organization's timezone, to the minute, like the other logs.
          render: (run) =>
            Number.isNaN(Date.parse(run.started_at))
              ? run.started_at
              : `${dateInTimeZone(run.started_at, backupZone)} ${timeInTimeZone(run.started_at, backupZone)}`,
        },
        { key: 'trigger', label: 'Trigger', sortValue: (run) => run.trigger, render: (run) => run.trigger },
        {
          key: 'status',
          label: 'Result',
          sortValue: (run) => run.status,
          render: (run) => {
            const pill = document.createElement('span')
            pill.className = 'invoice-state'
            pill.dataset.backupStatus = run.status
            pill.textContent = run.status
            return pill
          },
        },
        {
          key: 'rows',
          label: 'Rows',
          numeric: true,
          sortValue: (run) => run.total_rows,
          render: (run) =>
            run.total_rows === null ? '—' : run.total_rows.toLocaleString('en-US'),
        },
        {
          key: 'tables',
          label: 'Tables',
          numeric: true,
          sortValue: (run) => run.table_count,
          render: (run) => (run.table_count === null ? '—' : String(run.table_count)),
        },
        // The reason it failed, where there is one. A failed run whose message
        // is only in a log is a failure nobody reads.
        { key: 'error', label: 'Detail', render: (run) => run.error_message ?? '' },
      ],
    })

  /**
   * Backups.
   *
   * The endpoint has served this since it was written and no screen asked it,
   * so whether the nightly export was working was a question only a terminal
   * could answer. A backup nobody looks at is a backup nobody knows is broken,
   * and it stays in that state until the day it is needed.
   *
   * Administrator-only, like the two sections above, and for the same reason:
   * asking as an executive manager buys a 403 and tells the operator nothing
   * about why the section is empty.
   */
  /**
   * The QuickBooks connection, and the one button that starts one.
   *
   * Connecting is a grant over the whole book, so a non-administrator is told
   * that rather than shown a control the route would refuse. A deployment with
   * no Intuit keys is told that too -- offering a connect button that answers
   * 404 is worse than offering none.
   */
  /**
   * One colour control per slot, grouped.
   *
   * Two inputs bound to one value: the swatch is how a colour is picked and the
   * text box is how a brand hex is pasted, which is the way an operator
   * actually arrives here -- with a value out of a brand document rather than a
   * wish to hunt for it in a picker. Neither is authoritative; the draft is.
   */
  const renderThemeSlots = (): void => {
    themeSlots.replaceChildren(
      ...themeSlotGroups.flatMap((group) => {
        const slots = themeSlotCopy.filter((copy) => copy.group === group)
        if (slots.length === 0) return []
        const section = document.createElement('fieldset')
        section.className = 'theme-group'
        const legend = document.createElement('legend')
        legend.textContent = group
        section.append(legend)

        for (const copy of slots) {
          const row = document.createElement('div')
          row.className = 'theme-slot'
          row.dataset.themeSlot = copy.slot

          const label = document.createElement('label')
          label.htmlFor = `ez-theme-${copy.slot}`
          label.textContent = copy.label

          const swatch = document.createElement('input')
          swatch.type = 'color'
          swatch.id = `ez-theme-${copy.slot}`
          swatch.dataset.themeSwatch = copy.slot

          const hex = document.createElement('input')
          hex.type = 'text'
          hex.className = 'theme-hex'
          hex.dataset.themeHex = copy.slot
          hex.spellcheck = false
          hex.setAttribute('aria-label', `${copy.label} hex value`)
          hex.placeholder = themeBaseline[copy.slot] ?? '#000000'

          const value = themeDraft[copy.slot] ?? themeBaseline[copy.slot] ?? '#000000'
          swatch.value = value.toLowerCase()
          hex.value = themeDraft[copy.slot] ?? ''

          swatch.addEventListener('input', () => {
            themeDraft[copy.slot] = swatch.value.toUpperCase()
            hex.value = swatch.value.toUpperCase()
          })
          hex.addEventListener('input', () => {
            const typed = hex.value.trim()
            if (typed === '') {
              // Emptying the box is how one slot goes back to the built-in
              // colour without retyping the rest of the palette.
              delete themeDraft[copy.slot]
              swatch.value = (themeBaseline[copy.slot] ?? '#000000').toLowerCase()
              return
            }
            themeDraft[copy.slot] = typed.toUpperCase()
            if (/^#[0-9A-Fa-f]{6}$/u.test(typed)) swatch.value = typed.toLowerCase()
          })

          row.append(label, swatch, hex)
          if (copy.hint !== undefined) {
            const hint = document.createElement('p')
            hint.className = 'field-hint'
            hint.textContent = copy.hint
            row.append(hint)
          }
          section.append(row)
        }
        return [section]
      }),
    )
  }

  const showTheme = (view: InstanceThemeView): void => {
    themeStored = view?.palette ?? {}
    themeDraft = { ...themeStored }
    themeSlots.hidden = false
    themeActions.hidden = false
    themeReset.hidden = view === null
    themeStatus.textContent =
      view === null
        ? 'This instance uses the built-in colours.'
        : 'This instance has colours of its own.'
    renderThemeSlots()
  }

  const loadInstanceTheme = async (
    identity: Whoami,
    active: ActiveSession,
  ): Promise<void> => {
    if (identity.profile !== 'administrator') {
      themeStatus.textContent = 'Changing how this instance looks is an administrator action.'
      return
    }
    if (api.getInstanceTheme === undefined) {
      themeStatus.textContent = 'This deployment does not store an instance theme.'
      return
    }
    try {
      const view = await api.getInstanceTheme(active.signal)
      active.present(() => showTheme(view))
    } catch (error) {
      active.presentFailure(error, () => {
        sectionFailed(
          'appearance',
          themeStatus,
          error,
          'Changing how this instance looks is an administrator action.',
          'The instance theme could not be read.',
        )
      })
    }
  }

  const loadQuickBooks = async (identity: Whoami, active: ActiveSession): Promise<void> => {
    // The demo connects to no provider at all, so there is no connection to
    // read -- and asking would read as a failure to retry.
    if (demo) {
      quickBooksStatus.textContent = DEMO_UNAVAILABLE
      return
    }
    if (identity.profile !== 'administrator') {
      quickBooksStatus.textContent =
        'Connecting an accounting system is an administrator action.'
      return
    }
    if (api.getQuickBooksConnection === undefined || !accountingAvailable()) {
      quickBooksStatus.textContent =
        'This deployment is not configured for QuickBooks.'
      return
    }
    try {
      const view = await api.getQuickBooksConnection(active.signal)
      active.present(() => {
        if (!view.configured) {
          // Keys are a deployment concern, not something an operator can fix
          // from this screen, so it says so rather than offering a button.
          quickBooksStatus.textContent =
            'This deployment has no Intuit credentials, so QuickBooks cannot be connected here.'
          return
        }
        const connection = view.connection
        quickBooksActions.hidden = false
        quickBooksConnect.hidden = connection !== null
        quickBooksDisconnect.hidden = connection === null
        quickBooksPaymentRow.hidden = connection === null
        quickBooksReconcilePanel.hidden =
          connection === null || api.getQuickBooksReconciliation === undefined
        if (connection === null) {
          quickBooksFacts.hidden = true
          quickBooksStatus.textContent = 'Not connected.'
          return
        }
        facts(quickBooksFacts, [
          ['Company', connection.company_name ?? connection.realm_id],
          ['Connected', connection.connected_at.slice(0, 10)],
          ['Access', connection.scope],
        ])
        quickBooksFacts.hidden = false
        quickBooksAllowPayment.checked = connection.allow_online_payment
        quickBooksStatus.textContent = ''
      })
    } catch (error) {
      active.presentFailure(error, () => {
        sectionFailed(
          'integrations',
          quickBooksStatus,
          error,
          'Connecting an accounting system is an administrator action.',
          'The QuickBooks connection could not be read.',
        )
      })
    }
  }

  /**
   * A build without the Wise routes hides the Payouts section rather than
   * showing an empty one. Whether the routes exist is known before anything is
   * read, and the section has to be offered before it can be opened, so this
   * runs on activation while the read itself waits for the section (#809).
   */
  const revealWiseSection = (): void => {
    if (api.getWiseConnection === undefined) return
    wiseSection.hidden = false
    // Available now, so the section strip may offer it. The shell re-applies
    // the chosen section on the same event it follows for the hash, which
    // hides this one again unless it is the one chosen (issue 800).
    wiseSection.removeAttribute('data-settings-unavailable')
    for (const link of document.querySelectorAll<HTMLElement>(
      '[data-settings-section-link="payouts"]',
    )) {
      link.hidden = false
    }
    globalThis.dispatchEvent(new Event('hashchange'))
  }

  /**
   * The payout connection.
   *
   * No profile check of its own: `activate` refuses anyone who is not an
   * administrator or an executive manager before any of these loaders run, so a
   * second one here would be a branch nothing can reach.
   */
  const payoutProviderSwitches = createPayoutProviderSwitches(
    required<HTMLElement>('[data-settings-payout-providers]'),
    api,
  )

  const loadWiseConnection = async (active: ActiveSession): Promise<void> => {
    const read = api.getWiseConnection
    if (read === undefined) return
    try {
      const state = await read(active.signal)
      active.present(() => {
        if (!state.configured || state.connection === null) {
          wiseFacts.hidden = true
          wiseAlarm.hidden = true
          wiseStatus.textContent = state.configured
            ? 'Wise is configured, but no profile could be read from the token.'
            : 'Wise is not connected on this deployment. Payouts cannot be sent.'
          return
        }
        const connection = state.connection
        facts(wiseFacts, [
          ['Paying profile', connection.profileName ?? `Profile ${connection.profileId}`],
          ['People it can pay', connection.payableRecipients.toLocaleString('en-US')],
          ['Delivery receipts', connection.webhooksVerifiable ? 'Verified' : 'Not verifiable'],
        ])
        wiseFacts.hidden = false
        // The alarm, not a row to be scanned for. Money still leaves without a
        // signing key; what stops is anything ever saying whether it arrived.
        wiseAlarm.hidden = connection.webhooksVerifiable
        wiseAlarm.textContent = connection.webhooksVerifiable
          ? ''
          : 'Wise has no signing key on this deployment, so every delivery it sends is refused. Payouts still go out and nothing records whether they arrived.'
        // Nobody to pay is its own state: the connection is fine and the
        // payment run has nothing in it, which reads as working until payday.
        if (connection.payableRecipients === 0) {
          wiseAlarm.hidden = false
          wiseAlarm.textContent = `${wiseAlarm.textContent} No recipient is set up, so there is nobody this profile can pay.`.trim()
        }
        wiseStatus.textContent = ''
      })
    } catch (error) {
      active.presentFailure(error, () => {
        wiseFacts.hidden = true
        wiseAlarm.hidden = true
        // A 404 is a deployment without the Wise routes (no token configured),
        // not a failure to retry: the generated client always has the method,
        // so this answer is the only thing that says whether the section
        // applies. Withdraw it from the strip again rather than offer Retry
        // against a route that does not exist.
        if (error instanceof EzactoApiError && error.status === 404) {
          wiseStatus.textContent =
            'Wise is not connected on this deployment. Payouts cannot be sent.'
          withdrawWiseSection()
          return
        }
        sectionFailed(
          'payouts',
          wiseStatus,
          error,
          'Only administrators and accounting can view the payout connection.',
          'The payout connection could not be loaded.',
        )
      })
    }
  }

  const withdrawWiseSection = (): void => {
    wiseSection.setAttribute('data-settings-unavailable', '')
    for (const link of document.querySelectorAll<HTMLElement>(
      '[data-settings-section-link="payouts"]',
    )) {
      link.hidden = true
    }
    globalThis.dispatchEvent(new Event('hashchange'))
  }

  /**
   * The whole backup history, a page at a time. The status above it carries
   * only the latest runs, which is enough to say whether the last one worked
   * and not enough to find out when the last one before it did.
   */
  let backupLog: PagedLog | null = null
  let backupHistoryOwner: AbortController | null = null
  const backupHistory = (list: NonNullable<CompanySettingsApi['listBackupRuns']>): PagedLog => {
    backupLog ??= createPagedLog<BackupRun>({
      prefix: 'backup',
      filterKeys: ['status', 'trigger'],
      controls: backupControls,
      list: backupRuns,
      status: backupRunsStatus,
      noun: 'runs',
      failure: 'Backup history could not be loaded.',
      read: (address, signal) => {
        const { status, trigger } = address.filters
        return list(
          {
            per_page: address.perPage,
            ...(address.cursor === null ? {} : { cursor: address.cursor }),
            ...(status === 'completed' || status === 'failed' || status === 'running'
              ? { status }
              : {}),
            ...(trigger === 'nightly' || trigger === 'manual' ? { trigger } : {}),
          },
          signal,
        )
      },
      empty: (filtered) =>
        filtered ? 'No backup run matches these filters.' : 'No backup has run yet.',
      draw: (runs) => backupRunTable(runs),
    })
    return backupLog
  }

  /**
   * Mints the single-use download link (issue 39). The server decides whether
   * a code is needed; the field appears when it says so, rather than the page
   * guessing who has an authenticator enrolled.
   */
  const backupDownloadMint = required<HTMLButtonElement>('[data-backup-download-mint]')
  const backupDownloadCode = required<HTMLInputElement>('[data-backup-download-code]')
  const backupDownloadCodeRow = required<HTMLElement>('[data-backup-download-code-row]')
  const backupDownloadResult = required<HTMLElement>('[data-backup-download-result]')
  const backupDownloadLink = required<HTMLInputElement>('[data-backup-download-link]')
  const backupDownloadLinkRow = required<HTMLElement>('[data-backup-download-link-row]')
  const backupDownloadErrorCode = (error: unknown): string | null => {
    if (!(error instanceof EzactoApiError) || typeof error.body !== 'object' || error.body === null) {
      return null
    }
    const detail: unknown = Reflect.get(error.body, 'error')
    if (typeof detail !== 'object' || detail === null) return null
    const code: unknown = Reflect.get(detail, 'code')
    return typeof code === 'string' ? code : null
  }
  const backupDownloadFailure = (error: unknown): string => {
    const code = backupDownloadErrorCode(error)
    if (code === 'two_factor_code_required') {
      backupDownloadCodeRow.hidden = false
      backupDownloadCode.focus()
      return 'Enter a current verification code to create the link.'
    }
    if (code === 'invalid_two_factor_code') return 'That code is incorrect. Try again.'
    if (code === 'two_factor_locked') return 'Too many incorrect codes. Wait a few minutes and try again.'
    if (error instanceof EzactoApiError && error.status === 429) {
      return 'Too many links requested. Try again in a minute.'
    }
    if (error instanceof EzactoApiError && error.status === 404) {
      return 'There is no completed backup to download.'
    }
    if (error instanceof EzactoApiError && error.status === 403) {
      return 'Only administrators can create a download link.'
    }
    return 'The link could not be created. Try again.'
  }
  const mintBackupDownload = async (): Promise<void> => {
    const active = currentSession()
    if (active === null || active.identity.profile !== 'administrator' || api.createBackupDownloadLink === undefined) return
    backupDownloadMint.disabled = true
    backupDownloadLinkRow.hidden = true
    backupDownloadLink.value = ''
    backupDownloadResult.textContent = 'Creating the link…'
    const code = backupDownloadCode.value.trim()
    try {
      const link = await api.createBackupDownloadLink(code === '' ? {} : { code },active.signal)
      active.present(() => {
        backupDownloadCode.value = ''
        backupDownloadLink.value = new URL(link.url, globalThis.location.origin).href
        backupDownloadLinkRow.hidden = false
        backupDownloadResult.textContent = `Link created. It works once and expires at ${new Date(link.expires_at).toLocaleString()}. It will not be shown again.`
      })
    } catch (error) {
      const paint = () => { backupDownloadResult.textContent = backupDownloadFailure(error) }
      const factorCode = backupDownloadErrorCode(error)
      if (factorCode === 'two_factor_code_required' || factorCode === 'invalid_two_factor_code' || factorCode === 'two_factor_locked') active.present(paint)
      else active.presentFailure(error,paint)
    } finally {
      if (currentSession() === active) backupDownloadMint.disabled = false
    }
  }
  backupDownloadMint.addEventListener('click', () => void mintBackupDownload())

  const offsiteCheckRow = required<HTMLElement>('[data-backup-offsite-check-row]')
  const offsiteCheck = required<HTMLButtonElement>('[data-backup-offsite-check]')
  const offsiteCheckResult = required<HTMLElement>('[data-backup-offsite-check-result]')
  let offsiteSession: ActiveSession | null = null
  offsiteCheck.addEventListener('click', () => {
    const active = offsiteSession
    if (!active || currentSession() !== active || active.identity.profile !== 'administrator' || !api.checkOffsiteBackupDestination) return
    offsiteCheck.disabled = true
    offsiteCheckResult.textContent = 'Verifying an encrypted test object…'
    void api
      .checkOffsiteBackupDestination(active.signal)
      .then((result) => {
        active.present(() => {
          offsiteCheckResult.textContent = `Destination verified at ${new Date(result.checked_at).toLocaleString()}. This check did not create a backup.`
        })
      })
      .catch((error) => {
        active.presentFailure(error, () => {
          const detail =
            error instanceof EzactoApiError && typeof error.body === 'object' && error.body !== null
              ? Reflect.get(error.body, 'error')
              : null
          const message =
            typeof detail === 'object' && detail !== null ? Reflect.get(detail, 'message') : null
          offsiteCheckResult.textContent =
            backupDownloadErrorCode(error) === 'offsite_backup_unavailable' &&
            typeof message === 'string'
              ? message
              : 'E14: The off-site destination could not be verified. Check its configuration and bucket permissions.'
        })
      })
      .finally(() => {
        active.present(() => {
          offsiteCheck.disabled = false
        })
      })
  })

  const loadBackups = async (identity: Whoami, active: ActiveSession): Promise<void> => {
    offsiteSession = null
    offsiteCheckRow.hidden = true
    offsiteCheckResult.textContent = ''
    if (identity.profile !== 'administrator') {
      backupStatus.textContent = 'Backups are visible to administrators only.'
      return
    }
    if (api.getBackupStatus === undefined) {
      // The container composes no reader: its backups are the operator's
      // filesystem, and RESTORE.md is the contract there rather than this page.
      backupStatus.textContent = 'This deployment does not manage its own backups. See RESTORE.md.'
      return
    }
    try {
      const status = await api.getBackupStatus(active.signal)
      if (currentSession() !== active) return
      offsiteSession = active
      active.signal.addEventListener(
        'abort',
        () => {
          if (offsiteSession === active) {
            offsiteSession = null
            offsiteCheckRow.hidden = true
            offsiteCheckResult.textContent = ''
          }
        },
        { once: true },
      )
      active.present(() => {
        const now = Date.now()
        facts(backupFacts, [
          [
            'Last completed (L1)',
            status.last_completed === null
              ? 'Never'
              : `${sinceLabel(status.last_completed.completed_at ?? status.last_completed.started_at, now)} · ${(status.last_completed.total_rows ?? 0).toLocaleString('en-US')} rows`,
          ],
          ['Destination', status.last_completed?.r2_prefix ?? '—'],
          [
            'Last off-site copy (L2)',
            status.offsite?.last_completed
              ? sinceLabel(
                  status.offsite.last_completed.completed_at ??
                    status.offsite.last_completed.started_at,
                  now,
                )
              : status.offsite === undefined
                ? 'Not reported by this deployment'
                : 'Never',
          ],
          [
            'Off-site state',
            status.offsite === undefined
              ? 'See RESTORE.md'
              : status.offsite.state === 'disabled'
                ? 'Not configured'
                : status.offsite.state === 'misconfigured'
                  ? 'Configuration needs attention'
                  : status.offsite.state === 'waiting'
                    ? 'Waiting for a scheduled copy'
                    : status.offsite.state === 'running'
                      ? `Copy in progress · ${status.offsite.latest?.uploaded_objects ?? 0}/${status.offsite.latest?.total_objects ?? 0} objects`
                      : status.offsite.state === 'failed'
                        ? 'Copy failed'
                        : 'Verified encrypted copy completed',
          ],
          ['Off-site destination', status.offsite?.destination ?? '—'],
          // Without a paged history the status is all there is to count; with
          // one, the pager under the table says how many runs there are.
          ...(api.listBackupRuns === undefined
            ? ([['Runs recorded', String(status.recent_runs.length)]] as const)
            : []),
        ])
        // A failure is not a row in a table to be scanned for; it is the answer
        // to the only question this section is asked.
        backupAlarm.hidden = !status.has_failure
        backupAlarm.textContent =
          status.last_failed === null
            ? ''
            : `The last attempt on ${status.last_failed.started_at.slice(0, 10)} failed: ${status.last_failed.error_message ?? 'no reason was recorded'}`
        // Never having run is its own alarm. An empty history reads as "fine"
        // and is the state in which nothing can be restored.
        if (status.last_completed === null) {
          backupAlarm.hidden = false
          backupAlarm.textContent =
            'No backup has ever completed, so there is nothing to restore from.'
        }
        backupStatus.textContent = status.offsite?.error
          ? `${status.offsite.error.code}: ${status.offsite.error.message}`
          : ''
        offsiteCheckRow.hidden =
          !status.offsite?.configured || api.checkOffsiteBackupDestination === undefined
        offsiteCheck.disabled = false
        if (api.createBackupDownloadLink !== undefined) {
          backupDownload.hidden = false
          const none = status.last_completed === null
          backupDownloadMint.disabled = none
          if (none) {
            backupDownloadResult.textContent =
              'There is no completed backup yet, so there is nothing to download.'
          }
        }
        if (api.listBackupRuns === undefined) {
          backupRuns.replaceChildren(backupRunTable(status.recent_runs))
          backupRuns.hidden = false
        }
      })
      if (api.listBackupRuns !== undefined && currentSession() === active) {
        backupControls.hidden = false
        backupRuns.hidden = false
        let zone = 'UTC'
        try { zone = (await api.getTimesheetLockPolicy?.(active.signal))?.timezone ?? 'UTC' }
        catch { /* The header explicitly says UTC when the setting is unavailable. */ }
        if (currentSession() !== active) return
        backupZone = zone
        backupHistoryOwner?.abort()
        const owner = new AbortController()
        backupHistoryOwner = owner
        active.signal.addEventListener('abort',()=>owner.abort(),{once:true})
        await backupHistory(api.listBackupRuns).load(owner.signal)
      }
    } catch (error) {
      active.presentFailure(error, () => {
        if (error instanceof EzactoApiError && error.status === 404) {
          backupStatus.textContent =
            'This deployment uses operator-managed backups. See RESTORE.md for scheduling and recovery.'
          return
        }
        sectionFailed(
          'backup',
          backupStatus,
          error,
          'Only administrators can view backups.',
          'Backup status could not be loaded.',
        )
      })
    }
  }

  /**
   * Administrator-only, like the sections above it: every brand-asset route
   * answers 403 to anyone else, and asking anyway buys a 403 that tells the
   * operator nothing about why the section is empty.
   */
  const loadBrandAssets = async (identity: Whoami, active: ActiveSession): Promise<void> => {
    if (identity.profile !== 'administrator') {
      brandStatus.textContent = 'Brand assets are visible to administrators only.'
      return
    }
    try {
      const assets = await fetchBrandAssets(active.signal)
      active.present(() => {
        brandState = assets
        paintBrandAssets()
        brandStatus.textContent = ''
      })
    } catch (error) {
      active.presentFailure(error, () => {
        sectionFailed(
          'brand',
          brandStatus,
          error,
          'Only administrators can change the brand assets.',
          'Brand assets could not be loaded.',
        )
      })
    }
  }

  const loadSsoDomains = async (identity: Whoami, active: ActiveSession): Promise<void> => {
    // Every sso-domains route is administrator-only. Asking as an executive
    // manager buys a 403 and tells the operator nothing about why the section
    // is empty.
    if (identity.profile !== 'administrator') {
      ssoStatus.textContent = 'SSO provisioning domains are visible to administrators only.'
      return
    }
    if (api.listSsoDomains === undefined) {
      ssoStatus.textContent = 'This build has no SSO provisioning domain endpoints.'
      return
    }
    try {
      const domains = await api.listSsoDomains(active.signal)
      active.present(() => {
        ssoState = domains
        paintSsoDomains()
        // A domain is who single sign-on lets in, so on the public demo
        // (issue 931) the list is shown and nothing about it changes.
        ssoForm.hidden = demo
        ssoStatus.textContent = demo
          ? demoUnavailable('Adding, verifying or removing a domain')
          : ''
      })
    } catch (error) {
      active.presentFailure(error, () => {
        sectionFailed(
          'sso',
          ssoStatus,
          error,
          'Only administrators can manage SSO provisioning domains.',
          'SSO provisioning domains could not be loaded.',
        )
      })
    }
  }

  quickBooksConnect.addEventListener('click', () => {
    const active = currentSession()
    if (active === null || api.startQuickBooksAuthorization === undefined) return
    quickBooksConnect.disabled = true
    quickBooksResult.textContent = 'Starting…'
    void api
      .startQuickBooksAuthorization(active.signal)
      .then((started) => {
        // Sent rather than followed by the fetch: this is a consent screen a
        // person has to see and answer on Intuit's own domain.
        window.location.assign(started.authorize_url)
      })
      .catch((error: unknown) => {
        active.presentFailure(error, () => {
          quickBooksResult.textContent = messageFor(
            error,
            'Connecting an accounting system is an administrator action.',
            'QuickBooks could not be reached.',
          )
        })
      })
      .finally(() => {
        if (currentSession() === active) quickBooksConnect.disabled = false
      })
  })

  quickBooksAllowPayment.addEventListener('change', () => {
    const active = currentSession()
    if (active === null || api.updateQuickBooksSettings === undefined) return
    const wanted = quickBooksAllowPayment.checked
    quickBooksAllowPayment.disabled = true
    void api
      .updateQuickBooksSettings(wanted, active.signal)
      .then(() => {
        quickBooksResult.textContent = wanted
          ? 'Mirrored invoices will offer QuickBooks payment links.'
          : 'Mirrored invoices will not offer payment links.'
      })
      .catch((error: unknown) => {
        active.presentFailure(error, () => {
          // Put back, because the checkbox is showing a state the server did
          // not accept and a person would otherwise believe it.
          quickBooksAllowPayment.checked = !wanted
          quickBooksResult.textContent = messageFor(
            error,
            'Connecting an accounting system is an administrator action.',
            'That setting could not be saved.',
          )
        })
      })
      .finally(() => {
        if (currentSession() === active) quickBooksAllowPayment.disabled = false
      })
  })

  // The reconciliation report (issue 1013): a read, shown as a table of what
  // differs. There is no action on a row -- nothing here corrects anything.
  quickBooksReconcile.addEventListener('click', () => {
    const active = currentSession()
    if (active === null || api.getQuickBooksReconciliation === undefined) return
    quickBooksReconcile.disabled = true
    quickBooksReconcileResult.textContent = 'Comparing…'
    api
      .getQuickBooksReconciliation(active.signal)
      .then((report) => {
        active.present(() => {
          const money = (cents: number | null): string =>
            cents === null ? '—' : (cents / 100).toFixed(2)
          // A payment QuickBooks no longer counts sits beside the invoice
          // differences: same table, same rule that nothing here corrects it.
          const differing = [
            ...report.rows
              .filter((row) => row.status !== 'matched')
              .map((row) => ({
                key: `${row.status}:${row.number}`,
                number: row.number,
                difference: row.status.replaceAll('_', ' '),
                ezacto: row.ezacto_amount_cents,
                quickbooks: row.quickbooks_amount_cents,
                detail: row.detail,
              })),
            ...report.payment_divergences.map((divergence) => {
              const total = divergence.receipts.reduce((sum, receipt) => sum + receipt.amount_cents, 0)
              return {
                key: `payment:${divergence.quickbooks_payment_id}`,
                number: divergence.receipts.map((receipt) => receipt.invoice_number).join(', '),
                difference: `payment ${divergence.kind} in QuickBooks`,
                ezacto: total,
                quickbooks: null,
                detail: `Receipts here still count ${money(total)} from QuickBooks payment ${divergence.quickbooks_payment_id}; review them.`,
              }
            }),
          ]
          const matched = report.counts['matched'] ?? 0
          const catchUp =
            report.recovery?.last_outcome === 'failed'
              ? ' The last catch-up for missed QuickBooks events failed.'
              : report.recovery?.last_outcome === 'full_reconcile_needed'
                ? ' QuickBooks catch-up could not prove a complete history (an old gap or the provider response limit). Compare the books and review missing payments.'
                : ''
          quickBooksReconcileResult.textContent =
            (differing.length === 0
              ? `Everything agrees (${String(matched)} invoices matched).`
              : `${String(differing.length)} to look at, ${String(matched)} matched.`) + catchUp
          quickBooksReconcileTable.replaceChildren(
            renderDataTable({
              caption: 'Differences between ezacto and QuickBooks',
              table: 'quickbooks-comparison',
              defaultSort: { column: 'number', direction: 'ascending' },
              rows: differing,
              rowKey: (row) => row.key,
              empty: 'No differences.',
              columns: [
                { key: 'number', label: 'Invoice', sortValue: (row) => row.number || null, fit: true, render: (row) => row.number || '—' },
                { key: 'status', label: 'Difference', sortValue: (row) => row.difference, fit: true, render: (row) => row.difference },
                { key: 'ezacto', label: 'ezacto', sortValue: (row) => row.ezacto, numeric: true, render: (row) => money(row.ezacto) },
                { key: 'quickbooks', label: 'QuickBooks', sortValue: (row) => row.quickbooks, numeric: true, render: (row) => money(row.quickbooks) },
                { key: 'detail', label: 'Detail', sortValue: (row) => row.detail || null, wrap: true, render: (row) => row.detail },
              ],
            }),
          )
          quickBooksReconcileTable.hidden = false
        })
      })
      .catch((error: unknown) => {
        active.presentFailure(error, () => {
          quickBooksReconcileTable.hidden = true
          quickBooksReconcileResult.textContent = messageFor(
            error,
            'The reconciliation is for administrators and accounting.',
            'QuickBooks could not be compared.',
          )
        })
      })
      .finally(() => {
        if (currentSession() === active) quickBooksReconcile.disabled = false
      })
  })

  themeSave.addEventListener('click', () => {
    const active = currentSession()
    if (active === null || themeBusy || api.setInstanceTheme === undefined) return
    themeBusy = true
    themeSave.disabled = true
    themeResult.textContent = 'Saving…'
    void api
      .setInstanceTheme({ ...themeDraft }, active.signal)
      .then((view) => {
        active.present(() => {
          showTheme(view)
          themeResult.textContent =
            'Saved. Reload to see the new colours.'
        })
      })
      .catch((error: unknown) => {
        active.presentFailure(error, () => {
          // The draft is left exactly as typed. A refused palette is one the
          // operator is part way through fixing, and throwing it away would
          // make them start the whole palette again to correct one slot.
          themeResult.textContent = messageFor(
            error,
            'Changing how this instance looks is an administrator action.',
            'Those colours could not be saved.',
          )
        })
      })
      .finally(() => {
        themeBusy = false
        if (currentSession() === active) themeSave.disabled = false
      })
  })

  themeRevert.addEventListener('click', () => {
    if (themeBusy) return
    themeDraft = { ...themeStored }
    renderThemeSlots()
    themeResult.textContent = 'Your unsaved changes have been discarded.'
  })

  themeReset.addEventListener('click', () => {
    const active = currentSession()
    if (active === null || themeBusy || api.clearInstanceTheme === undefined) return
    themeBusy = true
    themeReset.disabled = true
    void api
      .clearInstanceTheme(active.signal)
      .then(() => {
        active.present(() => {
          showTheme(null)
          themeResult.textContent =
            'Back to the built-in colours. Reload to see them.'
        })
      })
      .catch((error: unknown) => {
        active.presentFailure(error, () => {
          themeResult.textContent = messageFor(
            error,
            'Changing how this instance looks is an administrator action.',
            'The instance theme could not be reset.',
          )
        })
      })
      .finally(() => {
        themeBusy = false
        if (currentSession() === active) themeReset.disabled = false
      })
  })

  quickBooksDisconnect.addEventListener('click', () => {
    const active = currentSession()
    if (active === null || api.disconnectQuickBooks === undefined) return
    quickBooksDisconnect.disabled = true
    void api
      .disconnectQuickBooks(active.signal)
      .then(async () => {
        quickBooksResult.textContent = 'Disconnected.'
        // Re-read rather than assume: disconnecting also revokes the grant at
        // Intuit, and what the server now holds is the thing to show.
        if (session !== null) await loadQuickBooks({ profile: 'administrator' } as Whoami, session)
      })
      .catch((error: unknown) => {
        active.presentFailure(error, () => {
          quickBooksResult.textContent = messageFor(
            error,
            'Connecting an accounting system is an administrator action.',
            'QuickBooks could not be disconnected.',
          )
        })
      })
      .finally(() => {
        if (currentSession() === active) quickBooksDisconnect.disabled = false
      })
  })

  // Painted whole on every change rather than patched in place: switching
  // one method off can be what makes another one's toggle the last one
  // standing, and a card that still offers a switch the server would now
  // refuse is worse than a redraw.
  const paintSignInMethods = (
    active: ActiveSession,
    states: readonly SignInMethodState[],
  ): void => {
    // The public demo shares one administrator with every visitor (issue
    // 931), and a method switched off is the next visitor locked out: the
    // methods are shown, and no switch moves.
    signInStatus.textContent = demo ? demoUnavailable('Switching a sign-in method') : ''
    signInList.hidden = false
    signInList.innerHTML = states.map((state) => renderSignInMethodCard(state, demo)).join('')
    for (const toggle of signInList.querySelectorAll<HTMLInputElement>(
      '[data-sign-in-toggle]',
    )) {
      toggle.addEventListener('change', async () => {
        const method = toggle.dataset.signInToggle!
        const result = signInList.querySelector<HTMLElement>(
          `[data-sign-in-result="${method}"]`,
        )
        const span = toggle.parentElement?.querySelector('span')
        toggle.disabled = true
        if (result) result.textContent = 'Saving…'
        try {
          const updated = await patchSignInMethod(method, toggle.checked, active.signal)
          active.present(() => paintSignInMethods(active, updated))
        } catch (error) {
          active.presentFailure(error, () => {
            // The refusal is the point, so the checkbox goes back to what
            // the server still believes and the reason stays on screen.
            toggle.checked = !toggle.checked
            if (span) span.textContent = toggle.checked ? 'Enabled' : 'Disabled'
            toggle.disabled = false
            if (result) {
              result.textContent =
                error instanceof Error
                  ? error.message
                  : 'That sign-in method could not be changed.'
            }
          })
        }
      })
    }
  }

  const loadSignInMethods = async (active: ActiveSession): Promise<void> => {
    try {
      const methods = await fetchSignInMethods(active.signal)
      active.present(() => paintSignInMethods(active, methods))
    } catch (error) {
      active.presentFailure(error, () => {
        sectionFailed(
          'sign-in',
          signInStatus,
          error,
          'Only administrators can manage sign-in methods.',
          'Sign-in methods could not be loaded.',
        )
      })
    }
  }

  const loadModules = async (active: ActiveSession): Promise<void> => {
    try {
      const modules = await fetchModules(active.signal)
      active.present(() => {
        status.textContent = ''
        list.innerHTML = modules.map(renderModuleCard).join('')

        for (const toggle of list.querySelectorAll<HTMLInputElement>('[data-module-toggle]')) {
          toggle.addEventListener('change', async () => {
            const moduleName = toggle.dataset.moduleToggle!
            const result = list.querySelector<HTMLElement>(`[data-module-result="${moduleName}"]`)
            const span = toggle.parentElement?.querySelector('span')
            toggle.disabled = true
            if (result) result.textContent = 'Saving…'

            try {
              const updated = await patchModule(moduleName, toggle.checked, active.signal)
              active.present(() => {
                loaded.delete('import-export')
                loaded.delete('bulk-actions')
                const state = updated.find((m) => m.module === moduleName)
                if (span) span.textContent = state?.enabled ? 'Enabled' : 'Disabled'
                if (result) result.textContent = ''
              })
            } catch (error) {
              active.presentFailure(error, () => {
                toggle.checked = !toggle.checked
                if (span) span.textContent = toggle.checked ? 'Enabled' : 'Disabled'
                if (result) {
                  result.textContent = error instanceof Error
                    ? error.message
                    : 'The module update could not be completed.'
                }
              })
            } finally {
              active.present(() => {
                toggle.disabled = false
              })
            }
          })
        }
      })
    } catch (error) {
      active.presentFailure(error, () => {
        sectionFailed(
          'modules',
          status,
          error,
          'Only administrators can manage module settings.',
          'Modules could not be loaded.',
        )
      })
    }
  }

  /**
   * One reader per section, keyed the way the strip and the hash key them
   * (issue 800). A section is read the first time it is shown and not again
   * for the session; what it showed stays, and a Retry or Refresh reads it
   * once more.
   */
  const dataTools = createCompanyDataTools(api,signal=>fetchModules(signal))
  const sectionLoaders: Readonly<Record<string, (active: ActiveSession) => Promise<void>>> = {
    modules: loadModules,
    webhooks: active => webhookController.load(active),
    'import-export': async active=>{
      try { await dataTools.loadExports(active) }
      catch(error){active.presentFailure(error,()=>sectionFailed('import-export',required<HTMLElement>('[data-settings-data-status]'),error,'Only administrators can use company import and export.','Available exports could not be loaded.'))}
    },
    'bulk-actions': async active=>{
      try { await dataTools.loadBulk(active) }
      catch(error){active.presentFailure(error,()=>sectionFailed('bulk-actions',required<HTMLElement>('[data-settings-bulk-status]'),error,'Only administrators can view company bulk actions.','Available bulk actions could not be loaded.'))}
    },
    erasure: async (active) => {
      try { await retention.load(active); await deletionRequests.load(active) }
      catch (error) {
        active.presentFailure(error, () => sectionFailed('erasure', required<HTMLElement>('[data-retention-status]'), error, 'Only administrators can manage this policy.', 'The policy could not be loaded.'))
      }
    },
    'sign-in': loadSignInMethods,
    time: loadTimeTracking,
    email: (active) => loadEmail(active.identity, active),
    invoices: loadInvoiceDefaults,
    reminders: loadReminders,
    approval: loadAutoApproval,
    notifications: loadNotifications,
    payouts: async (active) => {
      await Promise.all([loadWiseConnection(active), payoutProviderSwitches.load(active.signal)])
    },
    backup: (active) => (backupsAvailable() ? loadBackups(active.identity, active) : Promise.resolve()),
    brand: (active) => loadBrandAssets(active.identity, active),
    appearance: (active) => loadInstanceTheme(active.identity, active),
    integrations: (active) => loadQuickBooks(active.identity, active),
    sso: (active) => loadSsoDomains(active.identity, active),
  }

  const load = (section: string): Promise<void> => {
    const active = currentSession()
    const read = sectionLoaders[section]
    if (active === null || read === undefined) return Promise.resolve()
    const pending = loaded.get(section)
    if (pending !== undefined) return pending
    const run = read(active)
    loaded.set(section, run)
    return run
  }

  /**
   * The section on screen: the one the hash names, or the first where that
   * one is Payouts and the deployment has no Wise routes -- the same fallback
   * the shell makes when it decides what to show.
   */
  const shownSection = (): string => {
    const wanted = resolveSettingsSection(globalThis.location.hash)
    return (wanted === 'payouts' && wiseSection.hasAttribute('data-settings-unavailable')) ||
      (wanted === 'integrations' && !accountingAvailable()) ||
      (wanted === 'backup' && !backupsAvailable())
      ? DEFAULT_COMPANY_SETTINGS_SECTION
      : wanted
  }

  // Where the platform backs the tenant up the screen is not offered at all
  // (issue 1216): withdrawn from the strip like Payouts, and never read, so no
  // request reaches the backup endpoints.
  if (!backupsAvailable()) {
    document
      .querySelector<HTMLElement>('[data-settings-section="backup"]')
      ?.setAttribute('data-settings-unavailable', '')
    for (const link of document.querySelectorAll<HTMLElement>(
      '[data-settings-section-link="backup"]',
    )) {
      link.hidden = true
    }
    globalThis.dispatchEvent(new Event('hashchange'))
  }

  // Following a link in the strip is a hash change (issue 800), and the
  // section it shows is read then, if this session has not read it yet.
  // Nothing happens off the company page: there is no session to read for.
  globalThis.addEventListener('hashchange', () => {
    void load(shownSection())
  })

  // The integration sections read what another system holds, and an operator
  // who just connected QuickBooks in another tab should not need a reload to
  // see it. A refresh is a read the cache has forgotten.
  for (const control of refreshControls) {
    control.addEventListener('click', async () => {
      const section = control.dataset.settingsRefresh
      if (section === undefined || currentSession() === null) return
      loaded.delete(section)
      control.disabled = true
      try {
        await load(section)
      } finally {
        control.disabled = false
      }
    })
  }

  return {
    async activate(identity, signal, onSessionFailure) {
      clearPrivatePresentation()
      if (identity.profile !== 'administrator' && identity.profile !== 'executive_manager') {
        status.textContent = 'Only administrators can manage module settings.'
        timeStatus.textContent = ''
        emailStatus.textContent = ''
        brandStatus.textContent = ''
        quickBooksStatus.textContent = ''
        ssoStatus.textContent = ''
        backupStatus.textContent = 'Backups are visible to administrators only.'
        return
      }

      const active: ActiveSession = {
        signal,
        identity,
        ...sessionPresenter(() => currentSession() === active, onSessionFailure),
      }
      if (signal.aborted) return
      session = active
      signal.addEventListener('abort',()=>{if(session===active)clearPrivatePresentation()},{once:true})

      revealWiseSection()
      await load(shownSection())
    },
  }
}
