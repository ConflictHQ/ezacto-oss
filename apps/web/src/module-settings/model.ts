import type {
  EmailHealth,
  SenderIdentity,
  TimeEntryNoteSettings,
  TimeEntryNoteSettingsPatch,
} from '@ezacto/client'
import type { TimeEntrySettings } from '../components/time-entry-editor.js'

/**
 * What the company half of settings reads. Every method here is an endpoint
 * that already shipped and that nothing in the app called: the settings this
 * instance runs on were reachable only with a token and a terminal.
 */
export interface CompanySettingsApi {
  getTimeEntrySettings(signal?: AbortSignal): Promise<TimeEntrySettings>
  getTimeEntryNoteSettings(signal?: AbortSignal): Promise<TimeEntryNoteSettings>
  updateTimeEntryNoteSettings(
    patch: TimeEntryNoteSettingsPatch,
    signal?: AbortSignal,
  ): Promise<TimeEntryNoteSettings>
  getEmailHealth(signal?: AbortSignal): Promise<EmailHealth>
  listSenderIdentities(signal?: AbortSignal): Promise<readonly SenderIdentity[]>
}

const timeEntryModeLabels: Readonly<Record<TimeEntrySettings['time_entry_mode'], string>> = {
  duration: 'Duration',
  start_end: 'Start and end times',
}

const weekStartLabels: Readonly<Record<TimeEntrySettings['week_start_day'], string>> = {
  saturday: 'Saturday',
  sunday: 'Sunday',
  monday: 'Monday',
}

/** Facts, not controls: none of these has a write endpoint to point a form at. */
export const timeTrackingFacts = (
  settings: Readonly<TimeEntrySettings>,
): readonly (readonly [string, string])[] => [
  ['Entry method', timeEntryModeLabels[settings.time_entry_mode]],
  [
    'Duration format',
    settings.time_format === 'decimal' ? 'Decimal (1.5)' : 'Hours and minutes (1:30)',
  ],
  ['Clock', settings.clock === '12h' ? '12-hour' : '24-hour'],
  ['Week starts', weekStartLabels[settings.week_start_day]],
]

/**
 * Parts per million is how the API reports a rate, because a bounce rate is a
 * fraction of a percent long before it is a problem. An operator reads percent.
 */
export const ratePercentage = (partsPerMillion: number): string =>
  `${(partsPerMillion / 10_000).toFixed(2)}%`

const verificationLabels: Readonly<
  Record<NonNullable<SenderIdentity['evidence']>['verification_status'], string>
> = {
  pending: 'Pending',
  verified: 'Verified',
  failed: 'Failed',
  temporary_failure: 'Temporary failure',
  operator_configured: 'Operator configured',
}

/**
 * A sender with no evidence has never been checked against the transport. That
 * is a different state from a failed check and has to read as one, or an
 * operator reads silence as approval.
 */
export const senderVerificationLabel = (identity: Readonly<SenderIdentity>): string => {
  if (identity.archived_at !== null) return 'Archived'
  if (identity.evidence === null) return 'Not verified yet'
  const status = verificationLabels[identity.evidence.verification_status]
  return identity.evidence.dkim_status === 'verified' ? `${status} · DKIM signed` : status
}

export interface NoteSettingsFormValues {
  readonly required: boolean
  readonly minimumLength: string
}

/**
 * A blank or negative minimum is refused here rather than sent: the API answers
 * 422 for both, and a form that has the answer already should not spend a round
 * trip to repeat it.
 */
export const noteSettingsPatch = (
  values: NoteSettingsFormValues,
): TimeEntryNoteSettingsPatch => {
  const minimumLength = Number(values.minimumLength)
  if (
    values.minimumLength.trim() === '' ||
    !Number.isInteger(minimumLength) ||
    minimumLength < 0
  ) {
    throw new Error('Minimum note length must be a whole number of characters, or 0 for none.')
  }
  return { required: values.required, minimum_length: minimumLength }
}
