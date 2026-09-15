import type { Hono } from 'hono'
import type { ApiContext } from './context.js'
import { requireApiScope } from './auth.js'
import { readObjectBody, unknownFieldErrors } from './resources/support.js'
import { validationError, type FieldError } from './errors.js'

/**
 * Self-service profile. A signed-in user setting their own preferences, with no
 * special permission: the only field today is the timezone, which the mobile
 * app syncs from the device so a running timer files on the user's local day
 * (see the tracked-resource repository, which reads users.timezone).
 */

export interface ProfileRepositoryPort {
  /**
   * The stored value, which is 'UTC' for anyone who has never set one. The
   * control that reads this shows "not set" for that, because it is: the
   * organization zone is what actually decides their day until they choose.
   */
  readTimezone(userId: number): Promise<string | null>
  updateTimezone(userId: number, timezone: string, occurredAt: string): Promise<void>
}

export interface ProfileRouteOptions {
  repository: ProfileRepositoryPort
  clock: () => string
}

const ALLOWED_FIELDS: ReadonlySet<string> = new Set(['timezone'])

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
  api.get('/profile', async (context) => {
    requireApiScope(context, 'time_entries:read')
    const principal = context.get('principal')
    const timezone = await options.repository.readTimezone(principal.userId)
    return context.json(
      {
        data: { user_id: principal.userId, timezone: timezone ?? 'UTC' },
        links: { self: '/api/v1/profile' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.patch('/profile', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    const body = await readObjectBody(context)
    const errors: FieldError[] = [...unknownFieldErrors(body, ALLOWED_FIELDS)]
    if (!Object.hasOwn(body, 'timezone')) {
      errors.push({ field: 'timezone', code: 'required', message: 'timezone is required' })
    }
    const timezone = Object.hasOwn(body, 'timezone')
      ? readTimezone(body.timezone, errors)
      : undefined
    if (errors.length > 0 || timezone === undefined) {
      throw validationError(errors)
    }
    await options.repository.updateTimezone(principal.userId, timezone, options.clock())
    return context.json(
      {
        data: { user_id: principal.userId, timezone },
        links: { self: '/api/v1/profile' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })
}
