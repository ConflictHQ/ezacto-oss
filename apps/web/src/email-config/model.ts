/**
 * What the invoice-configuration screen has to say.
 *
 * Two things live behind the Invoices strip's last tab, and they are the two
 * halves of the same question -- what a client sees when an invoice arrives:
 *
 * - **Sender identities**, which decide who it comes from. A deployment can
 *   hold several and exactly one is the default. The interesting field is not
 *   the address, it is the evidence: a sender the provider has not verified
 *   will be refused at send time, and finding that out from a bounce is finding
 *   it out too late.
 * - **Email templates**, which decide what it says. Five kinds, versioned, with
 *   `%token%` variables in Harvest's own syntax -- which is the parity point,
 *   because an operator moving across brings templates written that way.
 *
 * Templates are append-only: a new version is posted against the version it was
 * written from, and the server refuses a stale one. So the editor carries the
 * version it loaded rather than "the latest", and a conflict is reported as a
 * conflict rather than silently overwriting someone else's edit.
 *
 * `unknownTemplateTokens` exists because the server's `unknown_variable_policy`
 * is a choice between two bad outcomes at send time -- fail the send, or put
 * the literal `%typo%` in front of a client -- and neither is as good as saying
 * so while the template is still being written.
 */

import type {
  EmailTemplate,
  EmailTemplateVariable,
  EmailTemplateVariableGroup,
  SenderIdentity,
} from '@ezacto/client'

export type EmailTemplateKind = EmailTemplate['kind']

export interface EmailConfigurationApi {
  listSenderIdentities(signal?: AbortSignal): Promise<readonly SenderIdentity[]>
  setDefaultSenderIdentity(
    id: number,
    expectedVersion: number,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<SenderIdentity>
  archiveSenderIdentity(
    id: number,
    expectedVersion: number,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<SenderIdentity>
  /**
   * The evidence carries its own version, separate from the identity's: a
   * refresh is a claim about what the provider last said, not about the row.
   * An identity that has never been checked has no evidence version to send,
   * which is why `senderEvidenceRefreshVersion` can answer null.
   */
  refreshSenderIdentityEvidence(
    id: number,
    expectedEvidenceVersion: number,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<SenderIdentity>
  listEmailTemplates(signal?: AbortSignal): Promise<readonly EmailTemplate[]>
  listEmailTemplateVersions(
    kind: EmailTemplateKind,
    signal?: AbortSignal,
  ): Promise<readonly EmailTemplate[]>
  listEmailTemplateVariables(
    signal?: AbortSignal,
  ): Promise<readonly EmailTemplateVariableGroup[]>
  createEmailTemplateVersion(
    kind: EmailTemplateKind,
    idempotencyKey: string,
    body: {
      readonly expected_version: number
      readonly subject_template: string
      readonly text_template: string
      readonly html_template?: string | null
      readonly unknown_variable_policy?: 'error' | 'literal'
    },
    signal?: AbortSignal,
  ): Promise<EmailTemplate>
}

const kindLabels: Record<EmailTemplateKind, string> = {
  invoice: 'Invoice',
  reminder: 'Payment reminder',
  thank_you: 'Thank you',
  auth_email_verification: 'Email verification',
  auth_password_reset: 'Password reset',
}

/**
 * What each template is for, because "reminder" and "thank_you" do not say who
 * receives them or when, and the difference decides whether someone should be
 * editing it at all.
 */
const kindPurposes: Record<EmailTemplateKind, string> = {
  invoice: 'Sent to a client when an invoice goes out.',
  reminder: 'Sent to a client while an invoice is still outstanding.',
  thank_you: 'Sent to a client once an invoice is paid.',
  auth_email_verification: 'Sent to a person confirming their own address. Not client-facing.',
  auth_password_reset: 'Sent to a person who asked to reset their password. Not client-facing.',
}

export const emailTemplateKindLabel = (kind: EmailTemplateKind): string => kindLabels[kind]

export const emailTemplateKindPurpose = (kind: EmailTemplateKind): string => kindPurposes[kind]

/** Client-facing templates first: they are the ones an operator came to change. */
export const emailTemplateOrder = (
  templates: readonly EmailTemplate[],
): readonly EmailTemplate[] => {
  const rank: Record<EmailTemplateKind, number> = {
    invoice: 0,
    reminder: 1,
    thank_you: 2,
    auth_email_verification: 3,
    auth_password_reset: 4,
  }
  return [...templates].sort((left, right) => rank[left.kind] - rank[right.kind])
}

export const emailConfigTemplateFromUrl = (url: URL): EmailTemplateKind | null => {
  const raw = url.searchParams.get('template')
  return raw !== null && raw in kindLabels ? (raw as EmailTemplateKind) : null
}

export const emailConfigUrl = (kind: EmailTemplateKind | null = null): string =>
  kind === null ? '/invoices/configure' : `/invoices/configure?template=${kind}`

export type SenderEvidenceState = 'verified' | 'pending' | 'failed' | 'unknown'

/**
 * One word for whether this sender will be allowed to send.
 *
 * `operator_configured` counts as verified: it means the deployment asserted
 * the identity itself rather than a provider API confirming it, which is the
 * shape a self-hosted SMTP install has and is not a lesser state.
 *
 * DKIM failing while verification passed is still a failure to surface. Mail
 * that sends but lands in spam is a worse outcome than mail that is refused,
 * because nobody is told.
 */
export const senderEvidenceState = (
  identity: Readonly<Pick<SenderIdentity, 'evidence'>>,
): SenderEvidenceState => {
  const evidence = identity.evidence
  if (evidence === null) return 'unknown'
  if (
    evidence.verification_status === 'failed' ||
    evidence.dkim_status === 'failed' ||
    evidence.mail_from_status === 'failed'
  ) {
    return 'failed'
  }
  if (
    evidence.verification_status === 'verified' ||
    evidence.verification_status === 'operator_configured'
  ) {
    return evidence.dkim_status === 'pending' ? 'pending' : 'verified'
  }
  return 'pending'
}

export const senderEvidenceLabel = (
  identity: Readonly<Pick<SenderIdentity, 'evidence'>>,
): string => {
  const state = senderEvidenceState(identity)
  if (state === 'unknown') return 'Never checked'
  if (state === 'failed') return 'Failed'
  if (state === 'pending') return 'Pending'
  return identity.evidence?.verification_status === 'operator_configured'
    ? 'Configured'
    : 'Verified'
}

/** The detail behind the word, for the row that is not simply fine. */
export const senderEvidenceDetail = (
  identity: Readonly<Pick<SenderIdentity, 'evidence'>>,
): string => {
  const evidence = identity.evidence
  if (evidence === null) {
    return 'No provider evidence has been recorded. Refresh to ask the provider.'
  }
  const parts = [
    `Identity ${evidence.verification_status}`,
    `DKIM ${evidence.dkim_status}`,
    `MAIL FROM ${evidence.mail_from_status}`,
  ]
  return `${parts.join(' · ')} — observed ${evidence.observed_at.slice(0, 10)}`
}

/**
 * Default first, then live ones, then archived. The default is the one that
 * matters -- it is what every invoice goes out as -- and burying it in an
 * alphabetical list is how an operator ends up unsure which one is in use.
 */
export const senderIdentityOrder = (
  identities: readonly SenderIdentity[],
): readonly SenderIdentity[] =>
  [...identities].sort((left, right) => {
    if (left.is_default !== right.is_default) return left.is_default ? -1 : 1
    const leftArchived = left.archived_at !== null
    const rightArchived = right.archived_at !== null
    if (leftArchived !== rightArchived) return leftArchived ? 1 : -1
    return left.email.localeCompare(right.email, 'en-US')
  })

/**
 * The one thing this screen can tell an operator that a bounce cannot: mail is
 * about to go out as an address the provider will refuse.
 */
export const senderDefaultWarning = (
  identities: readonly SenderIdentity[],
): string | null => {
  const live = identities.filter((identity) => identity.archived_at === null)
  if (live.length === 0) {
    return 'No sender identity is configured, so nothing can be emailed from this deployment.'
  }
  const fallback = live.find((identity) => identity.is_default)
  if (fallback === undefined) {
    return 'No sender is marked default, so an invoice has no address to go out as.'
  }
  const state = senderEvidenceState(fallback)
  if (state === 'failed') {
    return `The default sender, ${fallback.email}, has failing provider evidence. Mail sent as it is likely to be refused or filtered.`
  }
  if (state === 'unknown') {
    return `The default sender, ${fallback.email}, has never been checked against the provider.`
  }
  return null
}

/**
 * The evidence version to refresh against, or null where there is none.
 *
 * A sender the provider has never been asked about has no evidence row, so
 * there is no version to claim. Sending the identity's own version instead
 * would be a different assertion about a different thing, and the server would
 * be right to take it at face value.
 */
export const senderEvidenceRefreshVersion = (
  identity: Readonly<Pick<SenderIdentity, 'evidence'>>,
): number | null => identity.evidence?.version ?? null

export const templateVariablesFor = (
  catalog: readonly EmailTemplateVariableGroup[],
  kind: EmailTemplateKind,
): readonly EmailTemplateVariable[] =>
  catalog.find((group) => group.kind === kind)?.variables ?? []

/** Harvest's own syntax, which is why an operator's existing templates paste in. */
const tokenPattern = /%[a-z0-9_]+%/giu

/**
 * Tokens the template names that this kind has no variable for.
 *
 * At send time the deployment's `unknown_variable_policy` decides between
 * failing the send and putting the literal `%typo%` in front of a client.
 * Neither is as good as saying so now, while it is still a draft.
 */
export const unknownTemplateTokens = (
  templates: readonly string[],
  variables: readonly EmailTemplateVariable[],
): readonly string[] => {
  const known = new Set(variables.map((variable) => variable.token.toLowerCase()))
  const seen = new Set<string>()
  for (const template of templates) {
    for (const match of template.matchAll(tokenPattern)) {
      const token = match[0].toLowerCase()
      if (!known.has(token)) seen.add(token)
    }
  }
  return [...seen].sort()
}

export interface TemplateDraft {
  readonly subject: string
  readonly text: string
  readonly html: string
}

export const templateDraftFrom = (template: Readonly<EmailTemplate>): TemplateDraft => ({
  subject: template.subject_template,
  text: template.text_template,
  html: template.html_template ?? '',
})

export const templateDraftChanged = (
  draft: TemplateDraft,
  template: Readonly<EmailTemplate>,
): boolean => {
  const current = templateDraftFrom(template)
  return (
    draft.subject !== current.subject ||
    draft.text !== current.text ||
    draft.html !== current.html
  )
}

export interface TemplateSaveOutcome {
  readonly kind: 'saved' | 'stale' | 'invalid' | 'error'
  readonly message: string
}

/**
 * A stale version is not a failure of the operator's; it is someone else having
 * saved first. Saying so, and saying to reload, is the difference between that
 * and "something went wrong".
 */
export const templateSaveOutcome = (error: unknown): TemplateSaveOutcome => {
  const status = typeof error === 'object' && error !== null ? Reflect.get(error, 'status') : null
  const body = typeof error === 'object' && error !== null ? Reflect.get(error, 'body') : null
  const detail =
    typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : null
  const message =
    typeof detail === 'object' && detail !== null ? Reflect.get(detail, 'message') : null
  const text = typeof message === 'string' && message.trim() !== '' ? message.trim() : null
  if (status === 409) {
    return {
      kind: 'stale',
      message:
        text ??
        'Someone saved a newer version of this template. Reload it and apply your change again.',
    }
  }
  if (status === 422 || status === 400) {
    return { kind: 'invalid', message: text ?? 'The template was rejected.' }
  }
  if (status === 401) {
    return { kind: 'error', message: 'Your session ended. Sign in again to continue.' }
  }
  if (status === 403) {
    return { kind: 'error', message: 'You do not have access to email configuration.' }
  }
  return { kind: 'error', message: text ?? 'The template could not be saved.' }
}
