import type { UserProfile } from './api-authorization.js'
import type { ActingUserAuthority } from './money-permissions.js'

export interface ProviderIdentityAssertion {
  /** Application-owned provider key, for example `google` or `github`. */
  provider: string
  /** Stable, provider-issued subject. This is opaque and case-sensitive. */
  subject: string
  email: string
  emailVerified: boolean
  /**
   * The domain the provider says this account belongs to — Google's `hd` claim.
   * Preferred over the address domain when deciding whether an unknown person
   * may provision an account, because a provider that asserts it has checked
   * the account really is administered by that domain, while an address domain
   * is only what the local part happens to be followed by.
   */
  hostedDomain?: string
  /** Profile material used only when the assertion creates a new user. */
  firstName?: string
  lastName?: string
}

export type ProviderIdentityMatch = 'subject' | 'verified_email' | 'created'

export interface ResolvedUserIdentity extends ActingUserAuthority {
  userId: number
  profile: UserProfile
  managerGrants: string[]
}

/**
 * An assertion that matched nobody and came from a domain this instance has not
 * proven it owns. It is deliberately not a `ResolvedUserIdentity`: there is no
 * user, and callers are forced by the type to say what happens instead of
 * reading a `userId` that provisioning declined to create.
 */
export interface ProviderProvisioningRefusal {
  status: 'provisioning_not_permitted'
}

export type ProviderIdentityResolution =
  | (ResolvedUserIdentity & {
      status: 'active' | 'disabled'
      matchedBy: ProviderIdentityMatch
    })
  | ProviderProvisioningRefusal

export type EmailSignInResolution =
  | (ResolvedUserIdentity & { status: 'active' })
  | { status: 'verification_required' }

export interface NormalizedProviderIdentityAssertion {
  provider: string
  subject: string
  email: string
  emailVerified: boolean
  /**
   * The domain provisioning is scoped against: the asserted hosted domain when
   * the provider sent one, otherwise the domain of the asserted address. Null
   * when that domain is not a name a provisioning row could ever hold, which
   * refuses provisioning without refusing the sign-in — an address that cannot
   * be scoped may still link to a user who already verified it.
   */
  provisioningDomain: string | null
  firstName?: string
  lastName?: string
}

const printableText = (
  value: string,
  field: string,
  maximum: number,
): string => {
  if (typeof value !== 'string')
    throw new TypeError(`${field} must be a string`)
  const normalized = value.normalize('NFC').trim()
  const length = [...normalized].length
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 31 || codePoint === 127
  })
  if (length < 1 || length > maximum || hasControlCharacter) {
    throw new RangeError(
      `${field} must contain between 1 and ${maximum} printable characters`,
    )
  }
  return normalized
}

const opaqueText = (value: string, field: string, maximum: number): string => {
  if (typeof value !== 'string')
    throw new TypeError(`${field} must be a string`)
  const length = [...value].length
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 31 || codePoint === 127
  })
  if (
    length < 1 ||
    length > maximum ||
    value.trim() !== value ||
    hasControlCharacter
  ) {
    throw new RangeError(
      `${field} must be an opaque, printable value of at most ${maximum} characters`,
    )
  }
  return value
}

export const normalizeIdentityEmail = (value: string): string => {
  const email = printableText(value, 'email', 254).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new RangeError('email must be a valid email address')
  }
  return email
}

/**
 * A DNS name reduced to the form the provisioning-domain rows are stored in:
 * lowercase, no trailing root dot, ASCII labels only. Anything a resolver would
 * have to interpret — an empty label, a leading or trailing hyphen, a unicode
 * label that has not been punycoded — is rejected rather than normalized,
 * because two spellings of one name would let a domain be claimed twice.
 */
export const normalizeProvisioningDomain = (value: string): string => {
  const domain = printableText(value, 'domain', 253)
    .toLowerCase()
    .replace(/\.$/, '')
  const labels = domain.split('.')
  if (
    domain.length < 4 ||
    domain.length > 253 ||
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length < 1 ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith('-') ||
        label.endsWith('-'),
    )
  ) {
    throw new RangeError('domain must be a lowercase ASCII DNS name')
  }
  return domain
}

const scopedDomain = (value: string): string | null => {
  try {
    return normalizeProvisioningDomain(value)
  } catch {
    return null
  }
}

export const normalizeProviderIdentityAssertion = (
  assertion: ProviderIdentityAssertion,
): NormalizedProviderIdentityAssertion => {
  const provider = printableText(
    assertion.provider,
    'provider',
    100,
  ).toLowerCase()
  if (!/^[a-z][a-z0-9._-]*$/.test(provider)) {
    throw new RangeError('provider must be a lowercase provider key')
  }
  const subject = opaqueText(assertion.subject, 'subject', 500)
  if (typeof assertion.emailVerified !== 'boolean') {
    throw new TypeError('emailVerified must be a boolean')
  }
  const firstName =
    assertion.firstName === undefined
      ? undefined
      : printableText(assertion.firstName, 'firstName', 100)
  const lastName =
    assertion.lastName === undefined
      ? undefined
      : printableText(assertion.lastName, 'lastName', 100)
  const email = normalizeIdentityEmail(assertion.email)
  return {
    provider,
    subject,
    email,
    emailVerified: assertion.emailVerified,
    provisioningDomain: scopedDomain(
      assertion.hostedDomain ?? email.slice(email.lastIndexOf('@') + 1),
    ),
    ...(firstName === undefined ? {} : { firstName }),
    ...(lastName === undefined ? {} : { lastName }),
  }
}
