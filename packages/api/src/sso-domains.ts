import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError } from './errors.js'
import { assertFields, readObjectBody, resourceId, unknownFieldErrors } from './resources/support.js'

/** The DNS label the challenge is published under, kept clear of SPF and DMARC. */
export const SSO_CHALLENGE_LABEL = '_ezacto-challenge'
/** The TXT value an operator publishes. The prefix keeps it self-describing in a zone file. */
export const SSO_CHALLENGE_PREFIX = 'ezacto-verification='

export interface SsoProvisioningDomain {
  id: number
  domain: string
  challengeToken: string
  verifiedAt: string | null
  lastCheckedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface SsoProvisioningDomainService {
  list(): Promise<readonly SsoProvisioningDomain[]>
  get(id: number): Promise<SsoProvisioningDomain>
  add(domain: string, now: string): Promise<SsoProvisioningDomain>
  remove(id: number): Promise<void>
  recordCheck(id: number, verified: boolean, checkedAt: string): Promise<SsoProvisioningDomain>
}

export interface SsoDomainRouteOptions {
  service: SsoProvisioningDomainService
  clock(): string
  /**
   * DNS-over-HTTPS endpoints, queried in full and required to agree. Two
   * independent resolvers by default so one poisoned answer cannot grant a
   * domain the instance does not own.
   */
  resolvers?: readonly string[]
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  timeoutMs?: number
}

interface DnsAnswer {
  type?: number
  data?: string
}

interface DnsResponse {
  Status?: number
  AD?: boolean
  Answer?: readonly DnsAnswer[]
}

interface ResolverOutcome {
  found: boolean
  dnssecValidated: boolean
}

const DEFAULT_RESOLVERS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
] as const

const bodyKeys = new Set(['domain'])

const assertAdministrator = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator') {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can manage SSO provisioning domains.',
    })
  }
}

const translate = (error: unknown): never => {
  if (error instanceof Error && error.name === 'SsoProvisioningDomainError') {
    const code = (error as Error & { code?: string }).code
    if (code === 'invalid_domain') {
      throw new ApiError({
        status: 422,
        code: 'invalid_input',
        message: error.message,
        fields: [{ field: 'domain', code: 'invalid', message: error.message }],
      })
    }
    if (code === 'conflict') {
      throw new ApiError({ status: 409, code: 'conflict', message: error.message })
    }
    throw new ApiError({ status: 404, code: 'not_found', message: error.message })
  }
  throw error
}

/**
 * A TXT answer arrives as one or more quoted character-strings; a value longer
 * than 255 bytes is split across several and has to be rejoined before it means
 * anything. Escaped quotes are left alone because the token alphabet is
 * base64url and can never contain one.
 */
const txtValue = (data: string): string =>
  data
    .split('"')
    .filter((_, index) => index % 2 === 1)
    .join('')
    .trim() || data.trim()

const lookup = async (
  endpoint: string,
  name: string,
  expected: string,
  options: SsoDomainRouteOptions,
): Promise<ResolverOutcome> => {
  const url = new URL(endpoint)
  url.searchParams.set('name', name)
  url.searchParams.set('type', 'TXT')
  const request = options.fetch ?? fetch
  const response = await request(url.href, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  })
  if (!response.ok) throw new Error(`DNS resolver ${url.host} answered ${response.status}`)
  const answer = (await response.json()) as DnsResponse
  const records = (answer.Answer ?? []).filter((record) => record.type === 16)
  return {
    found: records.some((record) => txtValue(record.data ?? '') === expected),
    dnssecValidated: answer.AD === true,
  }
}

/**
 * Every configured resolver must see the record. Agreement is the requirement
 * rather than DNSSEC validation because most zones are still unsigned and a
 * hard `AD` requirement would make the feature unusable; what the answer was
 * validated by is reported so an operator can see it, and recorded as the
 * check that happened either way.
 */
const verifyDomain = async (
  domain: string,
  challengeToken: string,
  options: SsoDomainRouteOptions,
): Promise<{ verified: boolean; dnssecValidated: boolean }> => {
  const endpoints = options.resolvers ?? DEFAULT_RESOLVERS
  const name = `${SSO_CHALLENGE_LABEL}.${domain}`
  const expected = `${SSO_CHALLENGE_PREFIX}${challengeToken}`
  let outcomes: readonly ResolverOutcome[]
  try {
    outcomes = await Promise.all(
      endpoints.map((endpoint) => lookup(endpoint, name, expected, options)),
    )
  } catch {
    throw new ApiError({
      status: 503,
      code: 'dns_lookup_failed',
      message: 'The DNS challenge could not be looked up. Try again.',
    })
  }
  return {
    verified: outcomes.length > 0 && outcomes.every((outcome) => outcome.found),
    dnssecValidated: outcomes.every((outcome) => outcome.dnssecValidated),
  }
}

const serialize = (record: SsoProvisioningDomain) => ({
  id: record.id,
  domain: record.domain,
  verified: record.verifiedAt !== null,
  verified_at: record.verifiedAt,
  last_checked_at: record.lastCheckedAt,
  record_name: `${SSO_CHALLENGE_LABEL}.${record.domain}`,
  record_type: 'TXT' as const,
  record_value: `${SSO_CHALLENGE_PREFIX}${record.challengeToken}`,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
})

export const installSsoDomainRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: SsoDomainRouteOptions,
): void => {
  api.get('/settings/sso-domains', async (context) => {
    assertAdministrator(context)
    const domains = await options.service.list()
    return context.json(
      {
        data: domains.map(serialize),
        links: { self: '/api/v1/settings/sso-domains' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/settings/sso-domains', async (context) => {
    assertAdministrator(context)
    const body = await readObjectBody(context)
    const errors = unknownFieldErrors(body, bodyKeys)
    if (typeof body.domain !== 'string' || body.domain.trim() === '') {
      errors.push({
        field: 'domain',
        code: body.domain === undefined ? 'required' : 'invalid',
        message: 'domain must be a DNS name such as example.com',
      })
    }
    assertFields(errors)
    try {
      const record = await options.service.add(body.domain as string, options.clock())
      return context.json({ data: serialize(record) }, 201, { 'cache-control': 'no-store' })
    } catch (error) {
      return translate(error)
    }
  })

  api.delete('/settings/sso-domains/:id', async (context) => {
    assertAdministrator(context)
    const id = resourceId(context.req.param('id'), 'SSO provisioning domain')
    try {
      await options.service.remove(id)
    } catch (error) {
      return translate(error)
    }
    return context.body(null, 204, { 'cache-control': 'no-store' })
  })

  // On click, not on a schedule: the settings panel asks and gets the answer in
  // the response. The same route re-checks a domain that is already verified,
  // which is how a record that has been taken down loses its rights.
  api.post('/settings/sso-domains/:id/verify', async (context) => {
    assertAdministrator(context)
    const id = resourceId(context.req.param('id'), 'SSO provisioning domain')
    let existing: SsoProvisioningDomain
    try {
      existing = await options.service.get(id)
    } catch (error) {
      return translate(error)
    }
    const outcome = await verifyDomain(existing.domain, existing.challengeToken, options)
    const record = await options.service.recordCheck(id, outcome.verified, options.clock())
    return context.json(
      { data: { ...serialize(record), dnssec_validated: outcome.dnssecValidated } },
      200,
      { 'cache-control': 'no-store' },
    )
  })
}
