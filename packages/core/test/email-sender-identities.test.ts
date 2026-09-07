import { describe, expect, it } from 'vitest'
import {
  senderIdentityEligibilityFailure,
  type ResolvedSenderIdentity,
} from '../src/email-sender-identities.js'

const identity = (
  overrides: Partial<ResolvedSenderIdentity> = {},
): ResolvedSenderIdentity => ({
  id: 41,
  email: 'billing@example.test',
  displayName: 'Billing',
  replyToEmail: null,
  provider: 'ses',
  providerIdentity: 'example.test',
  isDefault: false,
  archivedAt: null,
  evidence: {
    source: 'provider_api',
    identityKind: 'domain',
    verificationStatus: 'verified',
    dkimStatus: 'verified',
    mailFromDomain: null,
    mailFromStatus: 'not_configured',
    observedAt: '2026-09-02T00:00:00.000Z',
  },
  ...overrides,
})

describe('sender identity eligibility', () => {
  it('[unit] accepts authoritative aligned SES domain evidence', () => {
    expect(senderIdentityEligibilityFailure(identity())).toBeNull()
  })

  it('[security] rejects SES email evidence without aligned DKIM or MAIL FROM', () => {
    expect(senderIdentityEligibilityFailure(identity({
      providerIdentity: 'billing@example.test',
      evidence: {
        source: 'provider_api',
        identityKind: 'email_address',
        verificationStatus: 'verified',
        dkimStatus: 'not_applicable',
        mailFromDomain: null,
        mailFromStatus: 'not_configured',
        observedAt: '2026-09-02T00:00:00.000Z',
      },
    }))).toBe('sender_alignment_missing')
  })

  it('[security] rejects deployment-config evidence for SES', () => {
    expect(senderIdentityEligibilityFailure(identity({
      evidence: {
        source: 'deployment_config',
        identityKind: 'email_address',
        verificationStatus: 'operator_configured',
        dkimStatus: 'not_applicable',
        mailFromDomain: null,
        mailFromStatus: 'not_configured',
        observedAt: '2026-09-02T00:00:00.000Z',
      },
    }))).toBe('sender_evidence_untrusted')
  })

  it('[unit] accepts exact operator-configured SMTP evidence', () => {
    expect(senderIdentityEligibilityFailure(identity({
      provider: 'smtp',
      providerIdentity: 'billing@example.test',
      evidence: {
        source: 'deployment_config',
        identityKind: 'email_address',
        verificationStatus: 'operator_configured',
        dkimStatus: 'not_applicable',
        mailFromDomain: null,
        mailFromStatus: 'not_configured',
        observedAt: '2026-09-02T00:00:00.000Z',
      },
    }))).toBeNull()
  })

  it('[unit] accepts exact operator-configured Mailgun evidence', () => {
    expect(senderIdentityEligibilityFailure(identity({
      provider: 'mailgun',
      providerIdentity: 'billing@example.test',
      evidence: {
        source: 'deployment_config',
        identityKind: 'email_address',
        verificationStatus: 'operator_configured',
        dkimStatus: 'not_applicable',
        mailFromDomain: null,
        mailFromStatus: 'not_configured',
        observedAt: '2026-09-02T00:00:00.000Z',
      },
    }))).toBeNull()
  })

  it('[security] rejects Mailgun evidence that is provider-sourced or mismatched', () => {
    expect(senderIdentityEligibilityFailure(identity({
      provider: 'mailgun',
      providerIdentity: 'billing@example.test',
    }))).toBe('sender_evidence_untrusted')
    expect(senderIdentityEligibilityFailure(identity({
      provider: 'mailgun',
      providerIdentity: 'other@example.test',
      evidence: {
        source: 'deployment_config',
        identityKind: 'email_address',
        verificationStatus: 'operator_configured',
        dkimStatus: 'not_applicable',
        mailFromDomain: null,
        mailFromStatus: 'not_configured',
        observedAt: '2026-09-02T00:00:00.000Z',
      },
    }))).toBe('sender_identity_binding_mismatch')
  })

  it('[security] rejects SMTP evidence that is absent, provider-sourced, or mismatched', () => {
    expect(senderIdentityEligibilityFailure(identity({
      provider: 'smtp',
      providerIdentity: 'billing@example.test',
      evidence: null,
    }))).toBe('sender_deployment_configuration_missing')
    expect(senderIdentityEligibilityFailure(identity({
      provider: 'smtp',
      providerIdentity: 'billing@example.test',
    }))).toBe('sender_evidence_untrusted')
    expect(senderIdentityEligibilityFailure(identity({
      provider: 'smtp',
      providerIdentity: 'other@example.test',
      evidence: {
        source: 'deployment_config',
        identityKind: 'email_address',
        verificationStatus: 'operator_configured',
        dkimStatus: 'not_applicable',
        mailFromDomain: null,
        mailFromStatus: 'not_configured',
        observedAt: '2026-09-02T00:00:00.000Z',
      },
    }))).toBe('sender_identity_binding_mismatch')
  })
})
