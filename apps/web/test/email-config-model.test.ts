import { describe, expect, it } from 'vitest'
import type {
  EmailTemplate,
  EmailTemplateVariable,
  SenderIdentity,
  SenderIdentityEvidence,
} from '@ezacto/client'
import {
  emailConfigTemplateFromUrl,
  emailConfigUrl,
  emailTemplateKindLabel,
  emailTemplateOrder,
  senderDefaultWarning,
  senderEvidenceLabel,
  senderEvidenceRefreshVersion,
  senderEvidenceState,
  senderIdentityOrder,
  templateDraftChanged,
  templateDraftFrom,
  templateSaveOutcome,
  unknownTemplateTokens,
} from '../src/email-config/model.js'

const timestamp = '2026-09-09T12:00:00.000Z'

const evidence = (
  overrides: Partial<SenderIdentityEvidence> = {},
): SenderIdentityEvidence => ({
  version: 3,
  source: 'provider_api',
  identity_kind: 'domain',
  verification_status: 'verified',
  dkim_status: 'verified',
  mail_from_domain: 'mail.example.com',
  mail_from_status: 'verified',
  observed_at: timestamp,
  ...overrides,
})

const sender = (overrides: Partial<SenderIdentity> = {}): SenderIdentity => ({
  id: 1,
  email: 'billing@example.com',
  display_name: 'Folding Forks',
  reply_to_email: null,
  provider: 'mailgun',
  provider_identity: 'example.com',
  is_default: true,
  version: 2,
  archived_at: null,
  evidence: evidence(),
  created_by_user_id: 1,
  created_at: timestamp,
  updated_at: timestamp,
  ...overrides,
})

const template = (overrides: Partial<EmailTemplate> = {}): EmailTemplate => ({
  kind: 'invoice',
  version: 4,
  subject_template: 'Invoice %invoice_number% from %company_name%',
  text_template: 'Amount due: %invoice_amount%',
  html_template: null,
  unknown_variable_policy: 'error',
  created_by_user_id: 1,
  created_at: timestamp,
  ...overrides,
})

const variable = (token: string): EmailTemplateVariable => ({
  name: token.replaceAll('%', ''),
  token,
  description: 'x',
  compatibility: 'harvest',
})

describe('email configuration model', () => {
  it('[unit] reduces provider evidence to one word, and treats DKIM as its equal', () => {
    // Mail that sends but lands in spam is a worse outcome than mail that is
    // refused, because nobody is told. So a DKIM failure is a failure even
    // where the identity itself verified.
    expect(senderEvidenceState(sender())).toBe('verified')
    expect(senderEvidenceState(sender({ evidence: evidence({ dkim_status: 'failed' }) }))).toBe(
      'failed',
    )
    expect(
      senderEvidenceState(sender({ evidence: evidence({ mail_from_status: 'failed' }) })),
    ).toBe('failed')
    expect(
      senderEvidenceState(sender({ evidence: evidence({ dkim_status: 'pending' }) })),
    ).toBe('pending')
    expect(senderEvidenceState(sender({ evidence: null }))).toBe('unknown')
  })

  it('[unit] counts an operator-configured identity as verified, not as lesser', () => {
    // A self-hosted SMTP install asserts its own identity; there is no provider
    // API to confirm it. That is a different provenance, not a worse state.
    const configured = sender({
      evidence: evidence({ source: 'deployment_config', verification_status: 'operator_configured' }),
    })
    expect(senderEvidenceState(configured)).toBe('verified')
    expect(senderEvidenceLabel(configured)).toBe('Configured')
    expect(senderEvidenceLabel(sender())).toBe('Verified')
    expect(senderEvidenceLabel(sender({ evidence: null }))).toBe('Never checked')
  })

  it('[security] warns when the address every invoice goes out as will be refused', () => {
    // The one thing this screen can say that a bounce cannot.
    expect(senderDefaultWarning([sender()])).toBeNull()
    expect(senderDefaultWarning([])).toContain('nothing can be emailed')
    expect(senderDefaultWarning([sender({ is_default: false })])).toContain('no address to go out as')
    expect(
      senderDefaultWarning([sender({ evidence: evidence({ verification_status: 'failed' }) })]),
    ).toContain('likely to be refused')
    expect(senderDefaultWarning([sender({ evidence: null })])).toContain('never been checked')
    // An archived identity is not a sender, so a deployment holding only
    // archived ones has nothing to send as.
    expect(senderDefaultWarning([sender({ archived_at: timestamp })])).toContain(
      'nothing can be emailed',
    )
  })

  it('[unit] puts the default first, then live, then archived', () => {
    const rows = senderIdentityOrder([
      sender({ id: 3, email: 'z@example.com', is_default: false, archived_at: timestamp }),
      sender({ id: 2, email: 'a@example.com', is_default: false }),
      sender({ id: 1, email: 'm@example.com', is_default: true }),
    ])
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3])
  })

  it('[unit] refreshes against the evidence version, not the identity version', () => {
    // Two numbers about two different things. Sending the identity's version
    // would be a different assertion that the server would rightly believe.
    expect(senderEvidenceRefreshVersion(sender())).toBe(3)
    expect(sender().version).toBe(2)
    // Never checked means there is nothing to claim.
    expect(senderEvidenceRefreshVersion(sender({ evidence: null }))).toBeNull()
  })

  it('[unit] finds tokens the template has no variable for', () => {
    // At send time the policy is a choice between failing the send and putting
    // the literal %typo% in front of a client. Neither is as good as saying so
    // while it is still a draft.
    const known = [variable('%invoice_number%'), variable('%company_name%')]
    expect(
      unknownTemplateTokens(['Invoice %invoice_number% from %company_name%'], known),
    ).toEqual([])
    expect(unknownTemplateTokens(['Hello %clint_name%, see %invoice_number%'], known)).toEqual([
      '%clint_name%',
    ])
    // Case-insensitive, and reported once however many times it appears.
    expect(unknownTemplateTokens(['%Typo% and %typo%'], known)).toEqual(['%typo%'])
  })

  it('[unit] knows when a draft differs from what was loaded', () => {
    const current = template()
    expect(templateDraftChanged(templateDraftFrom(current), current)).toBe(false)
    expect(
      templateDraftChanged({ ...templateDraftFrom(current), subject: 'Other' }, current),
    ).toBe(true)
    // A null HTML part and an empty box are the same draft, so clearing an
    // already-absent HTML body is not an edit.
    expect(templateDraftFrom(template({ html_template: null })).html).toBe('')
  })

  it('[unit] reads a stale version as someone else having saved first', () => {
    // Templates are append-only against the version they were written from.
    // "Something went wrong" would send an operator looking for a fault of
    // their own; the fix is to reload and reapply.
    const refusal = (status: number, message?: string) =>
      Object.assign(new Error('x'), {
        status,
        ...(message === undefined ? {} : { body: { error: { message } } }),
      })
    expect(templateSaveOutcome(refusal(409)).kind).toBe('stale')
    expect(templateSaveOutcome(refusal(409)).message).toContain('Reload it')
    expect(templateSaveOutcome(refusal(422, 'subject too long'))).toEqual({
      kind: 'invalid',
      message: 'subject too long',
    })
    expect(templateSaveOutcome(refusal(500)).kind).toBe('error')
  })

  it('[unit] puts the client-facing templates first', () => {
    // Those are the ones an operator came to change; the auth mails are not
    // client-facing and are rarely the reason anyone opened this screen.
    const rows = emailTemplateOrder([
      template({ kind: 'auth_password_reset' }),
      template({ kind: 'thank_you' }),
      template({ kind: 'invoice' }),
      template({ kind: 'reminder' }),
    ])
    expect(rows.map((row) => row.kind)).toEqual([
      'invoice',
      'reminder',
      'thank_you',
      'auth_password_reset',
    ])
    expect(emailTemplateKindLabel('thank_you')).toBe('Thank you')
  })

  it('[unit] round-trips the open template through the URL', () => {
    expect(emailConfigUrl()).toBe('/settings/templates')
    expect(emailConfigUrl('reminder')).toBe('/settings/templates?template=reminder')
    expect(
      emailConfigTemplateFromUrl(new URL('https://x.test/settings/templates?template=reminder')),
    ).toBe('reminder')
    // A kind that is not one opens the list rather than an editor over nothing.
    expect(
      emailConfigTemplateFromUrl(new URL('https://x.test/settings/templates?template=nope')),
    ).toBeNull()
    expect(emailConfigTemplateFromUrl(new URL('https://x.test/settings/templates'))).toBeNull()
  })
})
