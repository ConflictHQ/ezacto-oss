import type { UserProfile } from './api-authorization.js'
import type { ActingUserAuthority } from './money-permissions.js'

export interface ProviderIdentityAssertion {
  /** Application-owned provider key, for example `google` or `github`. */
  provider: string
  /** Stable, provider-issued subject. This is opaque and case-sensitive. */
  subject: string
  email: string
  emailVerified: boolean
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

export type ProviderIdentityResolution = ResolvedUserIdentity & {
  status: 'active' | 'disabled'
  matchedBy: ProviderIdentityMatch
}

export type EmailSignInResolution =
  | (ResolvedUserIdentity & { status: 'active' })
  | { status: 'verification_required' }

export interface NormalizedProviderIdentityAssertion {
  provider: string
  subject: string
  email: string
  emailVerified: boolean
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
  return {
    provider,
    subject,
    email: normalizeIdentityEmail(assertion.email),
    emailVerified: assertion.emailVerified,
    ...(firstName === undefined ? {} : { firstName }),
    ...(lastName === undefined ? {} : { lastName }),
  }
}
