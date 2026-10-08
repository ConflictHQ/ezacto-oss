import type { Hono } from 'hono'
import type { ApiContext } from './context.js'
import { requireApiScope } from './auth.js'
import { readObjectBody, unknownFieldErrors } from './resources/support.js'
import { ApiError, validationError, type FieldError } from './errors.js'

/**
 * Self-service profile. A signed-in user setting their own preferences, with no
 * special permission: the timezone, which the mobile app syncs from the device
 * so a running timer files on the user's local day (see the tracked-resource
 * repository, which reads users.timezone), and whether they are copied on the
 * invoice emails they send -- Harvest's "send me a copy", kept as a standing
 * choice rather than a box ticked every month.
 */

export interface ProfileRepositoryPort {
  /**
   * The stored value, which is 'UTC' for anyone who has never set one. The
   * control that reads this shows "not set" for that, because it is: the
   * organization zone is what actually decides their day until they choose.
   */
  readTimezone(userId: number): Promise<string | null>
  updateTimezone(userId: number, timezone: string, occurredAt: string): Promise<void>
  /** Absent where the deployment does not send invoice email. */
  readInvoiceCopy?(userId: number): Promise<boolean | null>
  updateInvoiceCopy?(userId: number, copy: boolean, occurredAt: string): Promise<void>
  /**
   * Records that the signed-in person asked for their account to be deleted,
   * and names the administrators who decide. Deletes and deactivates nothing.
   */
  requestDeletion?(input: {
    userId: number
    occurredAt: string
    requestId: string
  }): Promise<AccountDeletionRequest>
}

/** What a deletion request recorded, and who it goes to. */
export interface AccountDeletionRequest {
  /** When the person first asked; asking again keeps it. */
  readonly requestedAt: string
  /** False for a retry of a request already recorded, which tells nobody again. */
  readonly recorded: boolean
  readonly person: { readonly name: string; readonly email: string | null }
  /** Every active administrator's primary address. */
  readonly administrators: readonly string[]
}

/** Tells the administrators who asked to have their account deleted, and when. */
export interface AccountDeletionMailer {
  notify(request: AccountDeletionRequest): Promise<void>
}

export interface ProfileRouteOptions {
  repository: ProfileRepositoryPort
  clock: () => string
  /** Absent where the deployment sends no mail; the request is still recorded. */
  deletionMailer?: AccountDeletionMailer
}

const ALLOWED_FIELDS: ReadonlySet<string> = new Set(['timezone', 'invoice_copy_to_self'])

// The canonical IANA check used across this codebase: a non-empty string that
// Intl accepts as a time zone. (Mirrors the validator in timesheet-lock-policy.)
const readTimezone = (value: unknown, errors: FieldError[]): string | undefined => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    errors.push({
      field: 'timezone',
      code: value === undefined ? 'required' : 'invalid_timezone',
      message: 'timezone must be an IANA timezone name',
    })
    return undefined
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0))
  } catch {
    errors.push({
      field: 'timezone',
      code: 'invalid_timezone',
      message: 'timezone must be an IANA timezone name',
    })
    return undefined
  }
  return value
}

export const installProfileRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: ProfileRouteOptions,
): void => {
  const profileData = async (userId: number, timezone: string | null) => {
    const copy = (await options.repository.readInvoiceCopy?.(userId)) ?? null
    return {
      user_id: userId,
      timezone: timezone ?? 'UTC',
      // On unless the person turned it off; absent where nothing sends invoices.
      ...(copy === null ? {} : { invoice_copy_to_self: copy }),
    }
  }

  api.get('/profile', async (context) => {
    requireApiScope(context, 'time_entries:read')
    const principal = context.get('principal')
    const timezone = await options.repository.readTimezone(principal.userId)
    return context.json(
      {
        data: await profileData(principal.userId, timezone),
        links: { self: '/api/v1/profile' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  /**
   * Asking for one's own account to be deleted, from inside an app (App Store
   * Guideline 5.1.1(v), Google Play's account deletion policy).
   *
   * A request, not a deletion: an account on an instance is its
   * organization's, and what goes and what is kept is that organization's
   * retention decision. The request is recorded and the administrators are
   * told; nothing about the account changes. That is also why the public demo
   * needs no refusal here: its published accounts survive every reviewer who
   * asks, and the reviewer still sees the whole flow.
   *
   * 202 rather than 201: something was set in motion, and it is somebody
   * else's to finish. Asking again answers with the first request's time.
   */
  api.post('/profile/deletion-request', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    if (options.repository.requestDeletion === undefined) {
      throw new ApiError({
        status: 503,
        code: 'service_unavailable',
        message: 'Account deletion requests are not available in this deployment.',
      })
    }
    const request = await options.repository.requestDeletion({
      userId: principal.userId,
      occurredAt: options.clock(),
      requestId: context.get('requestId'),
    })
    // Each new ask is mailed; a retry of the same request is not mailed twice.
    if (request.recorded && request.administrators.length > 0) {
      await options.deletionMailer?.notify(request)
    }
    return context.json(
      {
        data: { user_id: principal.userId, requested_at: request.requestedAt },
        links: { self: '/api/v1/profile/deletion-request' },
      },
      202,
      { 'cache-control': 'no-store' },
    )
  })

  api.patch('/profile', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    const body = await readObjectBody(context)
    const errors: FieldError[] = [...unknownFieldErrors(body, ALLOWED_FIELDS)]
    const hasTimezone = Object.hasOwn(body, 'timezone')
    const hasCopy = Object.hasOwn(body, 'invoice_copy_to_self')
    if (!hasTimezone && !hasCopy) {
      errors.push({
        field: 'timezone',
        code: 'required',
        message: 'provide timezone, invoice_copy_to_self, or both',
      })
    }
    const timezone = hasTimezone ? readTimezone(body.timezone, errors) : undefined
    if (hasCopy && typeof body.invoice_copy_to_self !== 'boolean') {
      errors.push({
        field: 'invoice_copy_to_self',
        code: 'invalid_boolean',
        message: 'invoice_copy_to_self must be true or false',
      })
    }
    if (hasCopy && options.repository.updateInvoiceCopy === undefined) {
      errors.push({
        field: 'invoice_copy_to_self',
        code: 'unavailable',
        message: 'This deployment does not send invoice email.',
      })
    }
    if (errors.length > 0 || (hasTimezone && timezone === undefined)) {
      throw validationError(errors)
    }
    const occurredAt = options.clock()
    if (timezone !== undefined) {
      await options.repository.updateTimezone(principal.userId, timezone, occurredAt)
    }
    if (hasCopy) {
      await options.repository.updateInvoiceCopy!(
        principal.userId,
        body.invoice_copy_to_self as boolean,
        occurredAt,
      )
    }
    return context.json(
      {
        data: await profileData(
          principal.userId,
          timezone ?? (await options.repository.readTimezone(principal.userId)),
        ),
        links: { self: '/api/v1/profile' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })
}
