import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'
import { readObjectBody } from './resources/support.js'

/**
 * Administrator control of the Deel time sync (#1102). The runtime lives in
 * `@ezacto/integrations`; this file is only the HTTP surface over it, so the
 * shapes here are what the operator sees, not what the planner computes.
 */

export interface DeelSyncWindowBody {
  from: string
  to: string
}

export interface DeelSyncRunBody extends DeelSyncWindowBody {
  entry_ids: readonly number[]
}

export interface DeelSyncApiRuntime {
  status(): { configured: boolean; reason: string | null }
  preview(window: DeelSyncWindowBody): Promise<DeelSyncApiResult>
  run(request: {
    window: DeelSyncWindowBody
    expectedEntryIds: readonly number[]
    trigger: 'manual'
    userId: number
  }): Promise<DeelSyncApiResult>
}

export interface DeelSyncApiSettings {
  get(): Promise<{
    mode: 'manual' | 'automatic'
    runTime: string
    updatedAt: string
    updatedByUserId: number | null
  }>
  save(
    input: { mode: 'manual' | 'automatic'; runTime: string; userId: number },
    now: string,
  ): Promise<void>
}

export interface DeelSyncApiRunRecord {
  id: number
  startedAt: string
  finishedAt: string | null
  outcome: 'running' | 'completed' | 'failed'
  timesheetsSubmitted: number
  entriesTransferred: number
  detail: unknown
}

/** A runtime result. The fields are read by name in the routes below. */
export type DeelSyncApiResult = {
  status: string
  reason?: unknown
  window?: unknown
  entryIds?: unknown
  timesheets?: unknown
  alreadyTransferred?: unknown
  conflicts?: unknown
  unsyncable?: unknown
  unmatched?: unknown
  runId?: unknown
  timesheetsSubmitted?: unknown
  entriesTransferred?: unknown
  failed?: unknown
  reconciliation?: unknown
  error?: unknown
}

export interface DeelSyncApiDependencies {
  runtime: DeelSyncApiRuntime
  settings: DeelSyncApiSettings
  recentRuns(limit: number): Promise<readonly DeelSyncApiRunRecord[]>
  clock: () => string
}

const runTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u
const isoDate = /^\d{4}-\d{2}-\d{2}$/u

const invalid = (field: string, message: string): never => {
  throw validationError([{ field, code: 'invalid', message }])
}

const windowOf = (body: Record<string, unknown>): DeelSyncWindowBody => {
  if (typeof body.from !== 'string' || !isoDate.test(body.from))
    invalid('from', 'Provide the first day of the window as YYYY-MM-DD.')
  if (typeof body.to !== 'string' || !isoDate.test(body.to))
    invalid('to', 'Provide the last day of the window as YYYY-MM-DD.')
  return { from: body.from as string, to: body.to as string }
}

/** Refuses the states a caller must act on; anything else is a result to return. */
const refuseUnlessRan = (result: DeelSyncApiResult): void => {
  switch (result.status) {
    case 'unconfigured':
      throw new ApiError({
        status: 409,
        code: 'deel_sync_unconfigured',
        message: String(result.reason),
      })
    case 'busy':
      throw new ApiError({
        status: 409,
        code: 'deel_sync_busy',
        message: 'A Deel sync is already running.',
      })
    case 'stale':
      throw new ApiError({
        status: 409,
        code: 'deel_sync_stale',
        message: String(result.reason),
      })
    case 'invalid':
      throw new ApiError({
        status: 422,
        code: 'deel_sync_invalid',
        message: String(result.reason),
      })
    default:
      return
  }
}

export const installDeelSyncRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  dependencies: DeelSyncApiDependencies,
): void => {
  const administrator = (context: Context<ApiContext<Bindings>>) => {
    const principal = requireSessionPrincipal(context)
    if (principal.profile !== 'administrator')
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'Only administrators can control the Deel sync.',
      })
    return principal
  }
  api.use('/deel-sync', async (context, next) => {
    administrator(context)
    await next()
  })
  api.use('/deel-sync/*', async (context, next) => {
    administrator(context)
    await next()
  })

  api.get('/deel-sync', async (context) => {
    const status = dependencies.runtime.status()
    const settings = await dependencies.settings.get()
    const runs = await dependencies.recentRuns(10)
    return context.json(
      {
        configured: status.configured,
        reason: status.reason,
        mode: settings.mode,
        run_time: settings.runTime,
        updated_at: settings.updatedAt,
        updated_by_user_id: settings.updatedByUserId,
        runs: runs.map((run) => ({
          id: run.id,
          started_at: run.startedAt,
          finished_at: run.finishedAt,
          outcome: run.outcome,
          timesheets_submitted: run.timesheetsSubmitted,
          entries_transferred: run.entriesTransferred,
          detail: run.detail,
        })),
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.patch('/deel-sync/settings', async (context) => {
    const principal = administrator(context)
    const body = await readObjectBody(context)
    if (body.mode !== 'manual' && body.mode !== 'automatic')
      invalid('mode', 'Choose manual or automatic.')
    if (typeof body.run_time !== 'string' || !runTimePattern.test(body.run_time))
      invalid('run_time', 'Choose a time of day as HH:MM, 24-hour.')
    await dependencies.settings.save(
      {
        mode: body.mode as 'manual' | 'automatic',
        runTime: body.run_time as string,
        userId: principal.userId,
      },
      dependencies.clock(),
    )
    return context.body(null, 204, { 'cache-control': 'no-store' })
  })

  api.post('/deel-sync/preview', async (context) => {
    administrator(context)
    const window = windowOf(await readObjectBody(context))
    const result = await dependencies.runtime.preview(window)
    refuseUnlessRan(result)
    return context.json(
      {
        status: 'ready',
        window: result.window,
        entry_ids: result.entryIds,
        timesheets: result.timesheets,
        already_transferred: result.alreadyTransferred,
        conflicts: result.conflicts,
        unsyncable: result.unsyncable,
        unmatched: result.unmatched,
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/deel-sync/runs', async (context) => {
    const principal = administrator(context)
    const body = await readObjectBody(context)
    const window = windowOf(body)
    if (
      !Array.isArray(body.entry_ids) ||
      !body.entry_ids.every((id) => Number.isInteger(id) && (id as number) > 0)
    )
      invalid('entry_ids', 'Provide the entry ids from the preview you are sending.')
    const result = await dependencies.runtime.run({
      window,
      expectedEntryIds: body.entry_ids as number[],
      trigger: 'manual',
      userId: principal.userId,
    })
    refuseUnlessRan(result)
    return context.json(
      {
        status: result.status,
        run_id: result.runId,
        timesheets_submitted: result.timesheetsSubmitted,
        entries_transferred: result.entriesTransferred,
        failed: result.failed,
        reconciliation: result.reconciliation,
        error: result.error,
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })
}
