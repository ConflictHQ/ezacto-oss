import type { Context, Hono } from 'hono'
import { captureRequestActivity, type ActivityRecorder } from './activity-log.js'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, type FieldError } from './errors.js'
import { assertFields, readObjectBody, unknownFieldErrors } from './resources/support.js'

/**
 * The optional automatic-approval policy for submitted timesheets (issue 1009).
 * Off by default; administrators only, because it decides when time that bills
 * clients stops waiting for a person.
 */

export const minimumAutoApprovalDays = 1
export const maximumAutoApprovalDays = 60

export interface TimesheetAutoApprovalBody {
  readonly enabled: boolean
  /** Calendar days counted from the week's submission; null until chosen. */
  readonly window_days: number | null
  /** The clock always starts at submission, and a resubmission restarts it. */
  readonly clock_starts_at: 'submitted_at'
  /** Weeks submitted before this are never approved automatically. */
  readonly effective_from: string | null
  /** False while the Approval module is off: the policy then cannot run. */
  readonly approval_module_enabled: boolean
}

/** What the repository keeps, in the repository's own spelling. */
export interface StoredTimesheetAutoApproval {
  readonly enabled: boolean
  readonly windowDays: number | null
  readonly effectiveFrom: string | null
  readonly approvalModuleEnabled: boolean
}

export interface TimesheetAutoApprovalStore {
  read(): Promise<StoredTimesheetAutoApproval>
  update(
    actorUserId: number,
    patch: { readonly enabled?: boolean; readonly windowDays?: number },
  ): Promise<StoredTimesheetAutoApproval>
}

export interface TimesheetAutoApprovalService {
  read(): Promise<TimesheetAutoApprovalBody>
  update(
    actorUserId: number,
    patch: { readonly enabled?: boolean; readonly window_days?: number },
  ): Promise<TimesheetAutoApprovalBody>
}

export const createTimesheetAutoApprovalService = (
  store: Readonly<TimesheetAutoApprovalStore>,
): TimesheetAutoApprovalService => {
  const wire = (value: StoredTimesheetAutoApproval): TimesheetAutoApprovalBody => ({
    enabled: value.enabled,
    window_days: value.windowDays,
    clock_starts_at: 'submitted_at',
    effective_from: value.effectiveFrom,
    approval_module_enabled: value.approvalModuleEnabled,
  })
  return {
    read: async () => wire(await store.read()),
    update: async (actorUserId, patch) =>
      wire(
        await store.update(actorUserId, {
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.window_days === undefined ? {} : { windowDays: patch.window_days }),
        }),
      ),
  }
}

const assertAdministrator = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator') {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can change automatic timesheet approval.',
    })
  }
}

const fields = new Set(['enabled', 'window_days'])

export const installTimesheetAutoApprovalRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: {
    readonly service: Readonly<TimesheetAutoApprovalService>
    readonly activity?: ActivityRecorder
    readonly clock: () => string
  },
): void => {
  const { service, activity, clock } = options
  api.get('/settings/timesheet-auto-approval', async (context) => {
    assertAdministrator(context)
    return context.json({ data: await service.read() }, 200, { 'cache-control': 'no-store' })
  })

  api.post('/settings/timesheet-auto-approval', async (context) => {
    assertAdministrator(context)
    const body = await readObjectBody(context)
    const errors: FieldError[] = unknownFieldErrors(body, fields)
    const patch: { enabled?: boolean; window_days?: number } = {}
    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean') {
        errors.push({ field: 'enabled', code: 'invalid_boolean', message: 'enabled must be a boolean' })
      } else {
        patch.enabled = body.enabled
      }
    }
    if ('window_days' in body) {
      const days = body.window_days
      if (
        typeof days !== 'number' ||
        !Number.isInteger(days) ||
        days < minimumAutoApprovalDays ||
        days > maximumAutoApprovalDays
      ) {
        errors.push({
          field: 'window_days',
          code: 'invalid',
          message: `window_days must be a whole number of days from ${minimumAutoApprovalDays} to ${maximumAutoApprovalDays}`,
        })
      } else {
        patch.window_days = days
      }
    }
    if (Object.keys(patch).length === 0 && errors.length === 0) {
      errors.push({ field: 'body', code: 'required', message: 'name at least one setting to change' })
    }
    assertFields(errors)
    if (patch.enabled === true) {
      const current = await service.read()
      if (!current.approval_module_enabled) {
        errors.push({
          field: 'enabled',
          code: 'module_disabled',
          message: 'turn on the Approval module before enabling automatic approval',
        })
      }
      if (patch.window_days === undefined && current.window_days === null) {
        errors.push({
          field: 'window_days',
          code: 'required',
          message: 'choose how many days a week waits before it is approved automatically',
        })
      }
      assertFields(errors)
    }
    const principal = requireSessionPrincipal(context)
    const saved = await service.update(principal.userId, patch)
    if (activity !== undefined) {
      await captureRequestActivity(context, activity, {
        eventType: 'timesheet_auto_approval.updated',
        subjectId: 1,
        occurredAt: clock(),
        detail: {
          enabled: saved.enabled,
          window_days: saved.window_days,
          effective_from: saved.effective_from,
        },
      })
    }
    return context.json({ data: saved }, 200, { 'cache-control': 'no-store' })
  })
}
