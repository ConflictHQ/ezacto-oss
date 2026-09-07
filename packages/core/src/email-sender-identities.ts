export type SenderIdentityVerificationStatus =
  | 'pending'
  | 'verified'
  | 'failed'
  | 'temporary_failure'
  | 'operator_configured'

export interface ResolvedSenderIdentity {
  id: number
  /** Present for version-fenced delivery snapshots. Legacy resolvers may omit it. */
  version?: number
  email: string
  displayName: string
  replyToEmail: string | null
  provider: string
  providerIdentity: string
  isDefault: boolean
  archivedAt: string | null
  evidence: null | {
    /** Present for version-fenced delivery snapshots. Legacy resolvers may omit it. */
    version?: number
    source: 'provider_api' | 'deployment_config'
    identityKind: 'email_address' | 'domain'
    verificationStatus: SenderIdentityVerificationStatus
    dkimStatus: 'pending' | 'verified' | 'failed' | 'not_applicable'
    mailFromDomain: string | null
    mailFromStatus: 'pending' | 'verified' | 'failed' | 'not_configured'
    observedAt: string
  }
}

export type SenderIdentityUnavailableCode =
  | 'sender_identity_missing'
  | 'sender_identity_archived'
  | 'sender_identity_not_default'
  | 'sender_provider_mismatch'
  | 'sender_provider_unsupported'
  | 'sender_identity_binding_mismatch'
  | 'sender_evidence_untrusted'
  | 'sender_verification_pending'
  | 'sender_verification_temporary_failure'
  | 'sender_verification_failed'
  | 'sender_dkim_pending'
  | 'sender_dkim_failed'
  | 'sender_mail_from_pending'
  | 'sender_mail_from_failed'
  | 'sender_alignment_missing'
  | 'sender_deployment_configuration_missing'

const unavailableMessages: Readonly<Record<SenderIdentityUnavailableCode, string>> = {
  sender_identity_missing:
    'Configure and verify an organization sender identity before sending email.',
  sender_identity_archived:
    'Select an active organization sender identity before sending email.',
  sender_identity_not_default:
    'Select this verified sender identity as the organization default before sending email.',
  sender_provider_mismatch:
    'Select a sender identity verified by this deployment\'s configured email provider.',
  sender_provider_unsupported:
    'Configure this sender with a provider that supports authoritative identity verification.',
  sender_identity_binding_mismatch:
    'Configure provider identity evidence that authorizes the exact From address domain.',
  sender_evidence_untrusted:
    'Refresh this sender identity from this deployment\'s configured provider before sending.',
  sender_verification_pending:
    'Wait for the email provider to verify this sender identity, then refresh its status.',
  sender_verification_temporary_failure:
    'The email provider verification check failed temporarily. Retry the status refresh before sending.',
  sender_verification_failed:
    'Correct the sender identity DNS or provider configuration, then refresh its status.',
  sender_dkim_pending:
    'Wait for DKIM verification to finish, then refresh the sender identity status.',
  sender_dkim_failed:
    'Correct the DKIM DNS records, then refresh the sender identity status.',
  sender_mail_from_pending:
    'Wait for custom MAIL FROM verification to finish, then refresh the sender identity status.',
  sender_mail_from_failed:
    'Correct the custom MAIL FROM DNS records, then refresh the sender identity status.',
  sender_alignment_missing:
    'Enable verified DKIM or configure a verified custom MAIL FROM domain aligned with the From domain, then refresh this sender.',
  sender_deployment_configuration_missing:
    'Refresh this sender to attest its exact address against the deployment From configuration before sending.',
}

export const senderIdentityUnavailableMessage = (
  code: SenderIdentityUnavailableCode,
): string => unavailableMessages[code]

const senderDomain = (email: string): string =>
  email.slice(email.lastIndexOf('@') + 1).normalize('NFC').trim().toLowerCase()

const mailFromAligns = (mailFromDomain: string | null, fromDomain: string): boolean => {
  if (mailFromDomain === null) return false
  const normalized = mailFromDomain.normalize('NFC').trim().toLowerCase()
  return normalized === fromDomain || normalized.endsWith(`.${fromDomain}`)
}

/**
 * Providers with no API that can speak to an individual From address. Mailgun
 * verifies sending domains only, and SMTP has nothing to ask at all, so both
 * attest the exact address the deployment already configured and leave DNS
 * alignment explicitly operator-owned.
 */
export const deploymentAttestedProviders: readonly string[] = ['smtp', 'mailgun']

/**
 * Provider-specific eligibility shared by persistence and send-time enforcement.
 * SES requires authoritative aligned DNS evidence; a deployment-attested provider
 * requires an exact deployment configuration attestation instead.
 */
export const senderIdentityEligibilityFailure = (
  identity: ResolvedSenderIdentity,
): SenderIdentityUnavailableCode | null => {
  if (identity.archivedAt !== null) return 'sender_identity_archived'
  const evidence = identity.evidence
  if (deploymentAttestedProviders.includes(identity.provider)) {
    if (evidence === null) return 'sender_deployment_configuration_missing'
    if (
      evidence.source !== 'deployment_config' ||
      evidence.verificationStatus !== 'operator_configured' ||
      evidence.identityKind !== 'email_address' ||
      evidence.dkimStatus !== 'not_applicable' ||
      evidence.mailFromDomain !== null ||
      evidence.mailFromStatus !== 'not_configured'
    ) {
      return 'sender_evidence_untrusted'
    }
    const address = identity.email.normalize('NFC').trim().toLowerCase()
    const providerIdentity = identity.providerIdentity.normalize('NFC').trim().toLowerCase()
    return providerIdentity === address ? null : 'sender_identity_binding_mismatch'
  }
  if (identity.provider !== 'ses') return 'sender_provider_unsupported'
  if (evidence === null || evidence.verificationStatus === 'pending') {
    return 'sender_verification_pending'
  }
  if (evidence.source !== 'provider_api') return 'sender_evidence_untrusted'
  if (evidence.verificationStatus !== 'verified') {
    return evidence.verificationStatus === 'temporary_failure'
      ? 'sender_verification_temporary_failure'
      : 'sender_verification_failed'
  }

  const fromDomain = senderDomain(identity.email)
  const providerIdentity = identity.providerIdentity.normalize('NFC').trim().toLowerCase()
  const providerAuthorizesFrom =
    evidence.identityKind === 'email_address'
      ? providerIdentity === identity.email.normalize('NFC').trim().toLowerCase()
      : evidence.identityKind === 'domain' && providerIdentity === fromDomain
  if (!providerAuthorizesFrom) return 'sender_identity_binding_mismatch'

  const dkimAligned = evidence.dkimStatus === 'verified'
  const mailFromAligned =
    evidence.mailFromStatus === 'verified' &&
    mailFromAligns(evidence.mailFromDomain, fromDomain)
  if (dkimAligned || mailFromAligned) return null

  if (evidence.dkimStatus === 'pending') return 'sender_dkim_pending'
  if (evidence.dkimStatus === 'failed') return 'sender_dkim_failed'
  if (evidence.mailFromStatus === 'pending') return 'sender_mail_from_pending'
  if (evidence.mailFromStatus === 'failed') return 'sender_mail_from_failed'
  return 'sender_alignment_missing'
}
