import {
  EzactoApiError,
  type EmailHealth,
  type SenderIdentity,
  type SsoDomain,
  type SsoDomainCheck,
  type TimeEntryNoteSettings,
  type TimeEntryNoteSettingsPatch,
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
  listSsoDomains(signal?: AbortSignal): Promise<readonly SsoDomain[]>
  addSsoDomain(domain: string, signal?: AbortSignal): Promise<SsoDomain>
  verifySsoDomain(id: number, signal?: AbortSignal): Promise<SsoDomainCheck>
  removeSsoDomain(id: number, signal?: AbortSignal): Promise<void>
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

/**
 * Three states, not two. A domain nobody has looked up yet and a domain whose
 * record was looked for and not found are both unverified, and collapsing them
 * into one label is exactly how an operator who has not published the TXT
 * record yet concludes single sign-on is broken.
 */
export const ssoDomainStatus = (domain: Readonly<SsoDomain>): string => {
  if (domain.verified) return 'Verified'
  return domain.last_checked_at === null ? 'Awaiting first check' : 'Record not found'
}

export const ssoLastCheckedLabel = (domain: Readonly<SsoDomain>): string => {
  if (domain.last_checked_at === null) return 'Never'
  const checked = new Date(domain.last_checked_at)
  if (!Number.isFinite(checked.valueOf())) return domain.last_checked_at
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(checked)
}

/**
 * What a check that ran actually decided. A `verified: false` answer is a
 * resolver that did not see the record yet — publication is not instant and
 * both resolvers have to agree — which is a different thing from the lookup
 * failing, and the operator is told which one happened so they do not go and
 * pull a record that was never wrong.
 */
export const ssoVerificationMessage = (check: Readonly<SsoDomainCheck>): string => {
  if (check.verified) {
    return check.dnssec_validated
      ? `${check.domain} is verified, on a DNSSEC-validated answer.`
      : `${check.domain} is verified.`
  }
  return (
    `${check.domain} is not verified yet: no ${check.record_type} record at ` +
    `${check.record_name} answers with the challenge value. A record that was ` +
    'just published can take a while to reach both resolvers, so publish it and check again.'
  )
}

/**
 * The API's own message. EzactoApiError says only what the status code was,
 * which cannot tell "the DNS lookup could not run" from "the domain is already
 * on the list", and both arrive here as a failed promise.
 */
export const apiErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof EzactoApiError && typeof error.body === 'object' && error.body !== null) {
    const detail = Reflect.get(error.body, 'error')
    if (typeof detail === 'object' && detail !== null) {
      const fields = Reflect.get(detail, 'fields')
      if (Array.isArray(fields)) {
        const first = fields.find(
          (field) =>
            typeof field === 'object' &&
            field !== null &&
            typeof Reflect.get(field, 'message') === 'string',
        )
        if (first !== undefined) return String(Reflect.get(first, 'message'))
      }
      const message = Reflect.get(detail, 'message')
      if (typeof message === 'string' && message.trim() !== '') return message
    }
  }
  return error instanceof Error ? error.message : fallback
}
