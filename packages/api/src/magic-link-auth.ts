import type { Hono, Context } from 'hono'
import type { ApiContext } from './context.js'
import {
  requireSameOriginForUnsafeSessionRequest,
  type SessionPrincipal,
  type ApiSessionResolver,
} from './auth.js'
import { ApiError, readJsonBody, validationError } from './errors.js'

export const PORTAL_SESSION_COOKIE_NAME = '__Host-ezacto_portal'

export interface MagicLinkDelivery {
  kind: 'magic_link'
  to: string
  token: string
  expiresAt: string
}

export interface MagicLinkMailer {
  enqueue(delivery: MagicLinkDelivery): Promise<void>
}

export interface ContactLookup {
  contactId: number
  clientId: number
  email: string
  firstName: string
  lastName: string | null
}

export interface MagicLinkService {
  /** Look up a contact by email address. */
  findContactByEmail(email: string): Promise<ContactLookup | null>
  /**
   * Whether this address was already sent a link that is still live. #734: the
   * route is unauthenticated, so without a throttle anyone could have us mail
   * a known contact as fast as they could post. Optional so a deployment that
   * has not wired it keeps working, but the runtime does wire it.
   */
  hasActiveLink?(email: string): Promise<boolean>
  /** Generate a magic-link token for the contact. */
  createToken(contact: ContactLookup): Promise<{
    token: string
    jti: string
    expiresAt: string
  }>
  /** Persist the magic-link record in the database. */
  recordToken(input: {
    jti: string
    contactEmail: string
    contactId: number
    clientId: number
    tokenHash: string
    expiresAt: string
  }): Promise<void>
  /** Verify the token HMAC and expiry, then consume the DB record (single-use). */
  verifyAndConsume(token: string): Promise<{
    contactId: number
    clientId: number
    contactEmail: string
  } | null>
}

export interface PortalSessionIssuer {
  issue(
    contactId: number,
    clientId: number,
  ): Promise<{ setCookie: string; sessionId: string }>
}

export interface PortalStatementReader {
  /** Read the invoice summary for a given client. */
  listClientInvoices(clientId: number): Promise<readonly PortalInvoiceSummary[]>
}

export interface PortalInvoiceSummary {
  id: number
  number: string
  subject: string | null
  currency: string
  issueDate: string
  dueDate: string
  state: string
  amountCents: number
  dueAmountCents: number
}

/**
 * What a contact sees of their own client's estimates. The shapes are the
 * database package's customer views, passed through as JSON.
 */
export interface PortalEstimateService {
  /** Sent, accepted and declined estimates of the client; never drafts. */
  list(clientId: number): Promise<readonly { id: number }[]>
  /** Null when the estimate is missing, a draft, or another client's. */
  get(clientId: number, estimateId: number): Promise<{ id: number } | null>
  respond(input: {
    clientId: number
    contactId: number
    estimateId: number
    decision: 'accept' | 'decline'
    version: string
  }): Promise<{ estimate: { id: number }; replayed: boolean }>
}

export interface MagicLinkRouteOptions {
  service: MagicLinkService
  sessions: PortalSessionIssuer
  sessionStore: PortalSessionStore
  mailer?: MagicLinkMailer
  statements?: PortalStatementReader
  estimates?: PortalEstimateService
}

const requireMailer = (mailer: MagicLinkMailer | undefined): MagicLinkMailer => {
  if (mailer !== undefined) return mailer
  throw new ApiError({
    status: 503,
    code: 'mailer_unavailable',
    message: 'Magic link email delivery is temporarily unavailable.',
  })
}

export const installMagicLinkRoutes = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  options: MagicLinkRouteOptions,
): void => {
  app.post('/portal/magic-link', async (context) => {
    const body = await readJsonBody<unknown>(context, { maxBytes: 4 * 1024 })
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw validationError([
        { field: 'body', code: 'invalid', message: 'body must be a JSON object' },
      ])
    }
    const record = body as Record<string, unknown>
    if (typeof record.email !== 'string' || record.email.trim() === '') {
      throw validationError([
        { field: 'email', code: 'required', message: 'email must be a non-empty string' },
      ])
    }
    const unknownFields = Object.keys(record).filter((key) => key !== 'email')
    if (unknownFields.length > 0) {
      throw validationError(
        unknownFields.map((field) => ({
          field,
          code: 'unknown',
          message: `${field} is not accepted`,
        })),
      )
    }

    const mailer = requireMailer(options.mailer)
    const email = record.email.trim().toLowerCase()

    // Always return 202 to prevent email enumeration.
    const contact = await options.service.findContactByEmail(email)
    if (contact === null) {
      return context.json(
        { data: { status: 'magic_link_sent' as const } },
        202,
        { 'cache-control': 'no-store' },
      )
    }

    // One live link per address at a time. Answer 202 either way: which of the
    // two reasons it was, is exactly what an enumerator wants to learn.
    if ((await options.service.hasActiveLink?.(contact.email)) === true) {
      return context.json(
        { data: { status: 'magic_link_sent' as const } },
        202,
        { 'cache-control': 'no-store' },
      )
    }

    const { token, jti, expiresAt } = await options.service.createToken(contact)
    const tokenHash = await sha256Hex(token)
    await options.service.recordToken({
      jti,
      contactEmail: contact.email,
      contactId: contact.contactId,
      clientId: contact.clientId,
      tokenHash,
      expiresAt,
    })

    const delivery: MagicLinkDelivery = {
      kind: 'magic_link',
      to: contact.email,
      token,
      expiresAt,
    }
    await mailer.enqueue(delivery)

    return context.json(
      { data: { status: 'magic_link_sent' as const } },
      202,
      { 'cache-control': 'no-store' },
    )
  })

  const verify = async (context: Context<ApiContext<Bindings>>, token: string | undefined) => {
    context.header('cache-control', 'no-store')
    context.header('referrer-policy', 'no-referrer')
    if (token === undefined || token === '') {
      throw new ApiError({
        status: 400,
        code: 'missing_token',
        message: 'A magic link token is required.',
      })
    }

    const result = await options.service.verifyAndConsume(token)
    if (result === null) {
      throw new ApiError({
        status: 401,
        code: 'invalid_magic_link',
        message: 'The magic link is invalid, expired, or has already been used.',
      })
    }

    const session = await options.sessions.issue(result.contactId, result.clientId)
    context.header('set-cookie', session.setCookie, { append: true })

    return context.json(
      {
        data: {
          status: 'authenticated' as const,
          contact_id: result.contactId,
          client_id: result.clientId,
        },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  }
  // Legacy direct callers may still verify by GET. Emailed links and the web
  // page use the POST exchange so credentials do not enter request URLs.
  app.get('/portal/verify', (context) => verify(context, context.req.query('token')))
  app.post('/portal/verify', async (context) => {
    context.header('cache-control', 'no-store')
    requireSameOriginForUnsafeSessionRequest(context.req.raw)
    const body = await readJsonBody<unknown>(context, { maxBytes: 8192 })
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !('token' in body) ||
      typeof body.token !== 'string' ||
      !body.token.trim()
    )
      throw validationError([
        { field: 'token', code: 'invalid', message: 'Provide one sign-in token.' },
      ])
    return verify(context, body.token)
  })

  app.get('/portal/statements', async (context) => {
    const principal = await resolvePortalSession(context.req.raw, options)
    if (principal === null) {
      throw new ApiError({
        status: 401,
        code: 'authentication_required',
        message: 'A valid portal session is required.',
      })
    }

    if (options.statements === undefined) {
      throw new ApiError({
        status: 503,
        code: 'service_unavailable',
        message: 'Statement reading is temporarily unavailable.',
      })
    }

    const invoices = await options.statements.listClientInvoices(principal.clientId)
    return context.json(
      {
        data: {
          contact_id: principal.contactId,
          client_id: principal.clientId,
          invoices: invoices.map((invoice) => ({
            id: invoice.id,
            number: invoice.number,
            subject: invoice.subject,
            currency: invoice.currency,
            issue_date: invoice.issueDate,
            due_date: invoice.dueDate,
            state: invoice.state,
            amount_cents: invoice.amountCents,
            due_amount_cents: invoice.dueAmountCents,
          })),
        },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  const requirePortalContact = async (request: Request) => {
    const principal = await resolvePortalSession(request, options)
    if (principal === null) {
      throw new ApiError({
        status: 401,
        code: 'authentication_required',
        message: 'A valid portal session is required.',
      })
    }
    if (options.estimates === undefined) {
      throw new ApiError({
        status: 503,
        code: 'service_unavailable',
        message: 'Estimate review is temporarily unavailable.',
      })
    }
    return { principal, estimates: options.estimates }
  }

  const estimateId = (raw: string | undefined): number => {
    if (raw === undefined || !/^[1-9][0-9]{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw estimateNotFound()
    }
    return Number(raw)
  }

  app.get('/portal/estimates', async (context) => {
    const { principal, estimates } = await requirePortalContact(context.req.raw)
    return context.json(
      { data: { estimates: await estimates.list(principal.clientId) } },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  app.get('/portal/estimates/:id', async (context) => {
    const { principal, estimates } = await requirePortalContact(context.req.raw)
    const estimate = await estimates.get(principal.clientId, estimateId(context.req.param('id')))
    if (estimate === null) throw estimateNotFound()
    return context.json({ data: estimate }, 200, { 'cache-control': 'no-store' })
  })

  app.post('/portal/estimates/:id/response', async (context) => {
    requireSameOriginForUnsafeSessionRequest(context.req.raw)
    const { principal, estimates } = await requirePortalContact(context.req.raw)
    const id = estimateId(context.req.param('id'))
    const body = await readJsonBody<unknown>(context, { maxBytes: 1024 })
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw validationError([
        { field: 'body', code: 'invalid', message: 'body must be a JSON object' },
      ])
    }
    const record = body as Record<string, unknown>
    const fields = [
      ...Object.keys(record)
        .filter((key) => key !== 'decision' && key !== 'version')
        .map((field) => ({ field, code: 'unknown', message: `${field} is not accepted` })),
      ...(record.decision === 'accept' || record.decision === 'decline'
        ? []
        : [{ field: 'decision', code: 'invalid', message: 'decision must be accept or decline' }]),
      ...(typeof record.version === 'string' && /^[0-9a-f]{64}$/.test(record.version)
        ? []
        : [
            {
              field: 'version',
              code: 'invalid',
              message: 'version must be the version of the estimate that was shown',
            },
          ]),
    ]
    if (fields.length > 0) throw validationError(fields)
    try {
      const result = await estimates.respond({
        clientId: principal.clientId,
        contactId: principal.contactId,
        estimateId: id,
        decision: record.decision as 'accept' | 'decline',
        version: record.version as string,
      })
      return context.json(
        { data: result.estimate, replayed: result.replayed },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      throw translateEstimateResponseError(error)
    }
  })
}

const estimateNotFound = (): ApiError =>
  new ApiError({
    status: 404,
    code: 'not_found',
    message: 'The requested estimate does not exist.',
  })

const translateEstimateResponseError = (error: unknown): unknown => {
  if (error instanceof ApiError) return error
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : null
  if (code === 'estimate_not_found') return estimateNotFound()
  if (code === 'estimate_content_changed') {
    return new ApiError({
      status: 409,
      code,
      message: 'This estimate changed after it was shown. Reload it to review the current version.',
    })
  }
  if (code === 'estimate_needs_resend') {
    return new ApiError({
      status: 409,
      code,
      message: 'This estimate is being revised and cannot be answered until it is sent again.',
    })
  }
  if (code === 'estimate_expired') {
    return new ApiError({
      status: 410,
      code,
      message: 'This estimate has expired and can no longer be answered. Ask the sender for a new one.',
    })
  }
  if (code === 'estimate_state_conflict') {
    return new ApiError({
      status: 409,
      code,
      message: 'This estimate has already been answered.',
    })
  }
  return error
}

/** Resolve a contact principal from the portal session cookie. */
const resolvePortalSession = async (
  request: Request,
  options: MagicLinkRouteOptions,
): Promise<{ contactId: number; clientId: number } | null> => {
  const header = request.headers.get('cookie')
  if (header === null) return null
  const matches = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${PORTAL_SESSION_COOKIE_NAME}=`))
    .map((part) => part.slice(PORTAL_SESSION_COOKIE_NAME.length + 1))
  if (matches.length !== 1 || matches[0] === '') return null
  const authenticated = await options.sessionStore.authenticate(matches[0]!)
  if (authenticated === null) return null
  return { contactId: authenticated.contactId, clientId: authenticated.clientId }
}

/**
 * Create a portal session resolver that reads the __Host-ezacto_portal cookie
 * and returns a contact-typed SessionPrincipal.
 */
export interface PortalSessionStore {
  authenticate(token: string): Promise<{
    contactId: number
    clientId: number
    session: { id: number; absoluteExpiresAt: string }
  } | null>
}

export const createPortalSessionResolver = (
  store: PortalSessionStore,
): ApiSessionResolver => ({
  resolve: async (request) => {
    const header = request.headers.get('cookie')
    if (header === null) return null
    const matches = header
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${PORTAL_SESSION_COOKIE_NAME}=`))
      .map((part) => part.slice(PORTAL_SESSION_COOKIE_NAME.length + 1))
    if (matches.length !== 1 || matches[0] === '') return null

    const authenticated = await store.authenticate(matches[0]!)
    if (authenticated === null) return null

    const principal: SessionPrincipal = {
      type: 'contact',
      contactId: authenticated.contactId,
      clientId: authenticated.clientId,
      authentication: {
        kind: 'session',
        sessionId: String(authenticated.session.id),
      },
    }
    return principal
  },
})

/**
 * Compose user and portal session resolvers into a single resolver.
 * The user resolver is tried first; if it returns null, the portal resolver runs.
 */
export const createCompositeSessionResolver = (
  userResolver: ApiSessionResolver,
  portalResolver: ApiSessionResolver,
): ApiSessionResolver => ({
  resolve: async (request) => {
    const userResult = await userResolver.resolve(request)
    if (userResult !== null) return userResult
    return portalResolver.resolve(request)
  },
})

export const createPortalSessionService = (
  store: PortalSessionStore & {
    issue(
      contactId: number,
      clientId: number,
    ): Promise<{ token: string; session: { id: number; absoluteExpiresAt: string } }>
  },
): PortalSessionIssuer => ({
  issue: async (contactId, clientId) => {
    const issued = await store.issue(contactId, clientId)
    const cookie = portalSessionCookie(
      issued.token,
      issued.session.absoluteExpiresAt,
    )
    return { setCookie: cookie, sessionId: String(issued.session.id) }
  },
})

export const portalSessionCookie = (token: string, absoluteExpiresAt: string): string => {
  if (!/^ezacto_portal_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('contact session store returned malformed bearer material')
  }
  const expires = new Date(absoluteExpiresAt)
  if (!Number.isFinite(expires.valueOf())) {
    throw new Error('contact session store returned malformed absolute expiry')
  }
  // #733. Path must be `/` because the name carries the `__Host-` prefix, and
  // that prefix is a promise to the browser: Secure, no Domain, Path=/. A
  // `__Host-` cookie on any other path is dropped outright by Chrome, Firefox
  // and Safari, so `Path=/portal` meant portal sign-in could never complete in
  // a real browser. It failed closed, but it failed.
  //
  // Widening the path costs nothing here and the prefix is worth keeping: it
  // is what stops a subdomain setting this cookie. The name is already
  // distinct from the staff cookie, and apiAuthenticationMiddleware refuses a
  // contact principal on /api/v1 regardless of which path sent it.
  return `${PORTAL_SESSION_COOKIE_NAME}=${token}; Path=/; Expires=${expires.toUTCString()}; HttpOnly; Secure; SameSite=Lax`
}

const sha256Hex = async (value: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  )
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
