import type { Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError } from './errors.js'
import { logOrderFor, singleChoice, withTotal } from './log-paging.js'
import { keysetCursorPage } from './pagination.js'

export interface BackupStatusRecord {
  id: number
  status: 'running' | 'completed' | 'failed'
  trigger: 'nightly' | 'manual'
  started_at: string
  completed_at: string | null
  r2_prefix: string | null
  table_count: number | null
  total_rows: number | null
  error_message: string | null
}

export interface BackupRunFilter {
  status?: BackupStatusRecord['status']
  trigger?: BackupStatusRecord['trigger']
}

export interface BackupRunPageWindow extends BackupRunFilter {
  /** Where the previous page ended, newest first; null on the first page. */
  after: { startedAt: string; id: number } | null
  startedThrough: string
  take: number
}

export interface BackupStatusReader {
  latestRuns(limit: number): Promise<BackupStatusRecord[]>
  /** The latest start in the whole history, or null when nothing has run. */
  runsSnapshot(): Promise<string | null>
  pageRuns(window: BackupRunPageWindow): Promise<BackupStatusRecord[]>
  countRuns(filter: BackupRunFilter): Promise<number>
}

export interface BackupStatusRouteOptions {
  /** Signs the page cursors. */
  cursorSigningKey: Uint8Array
}

const requireAdministratorSession = <Bindings extends object>(
  context: Parameters<typeof requireSessionPrincipal<Bindings>>[0],
) => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator') {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can view backup status.',
    })
  }
  return principal
}

const serializeRun = (run: BackupStatusRecord) => ({
  id: run.id,
  status: run.status,
  trigger: run.trigger,
  started_at: run.started_at,
  completed_at: run.completed_at,
  r2_prefix: run.r2_prefix,
  table_count: run.table_count,
  total_rows: run.total_rows,
  error_message: run.error_message,
})

export const installBackupStatusRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  reader: BackupStatusReader,
  options: BackupStatusRouteOptions,
): void => {
  api.get('/backup/status', async (context) => {
    requireAdministratorSession(context)
    const runs = await reader.latestRuns(20)
    const lastCompleted = runs.find((r) => r.status === 'completed') ?? null
    const lastFailed = runs.find((r) => r.status === 'failed') ?? null
    return context.json(
      {
        data: {
          last_completed: lastCompleted === null ? null : serializeRun(lastCompleted),
          last_failed: lastFailed === null ? null : serializeRun(lastFailed),
          recent_runs: runs.map(serializeRun),
          has_failure: lastFailed !== null,
        },
        links: { self: '/api/v1/backup/status' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.get('/backup/runs', async (context) => {
    const principal = requireAdministratorSession(context)
    const requestUrl = new URL(context.req.url)
    const status = singleChoice(requestUrl, 'status', ['running', 'completed', 'failed'] as const)
    const trigger = singleChoice(requestUrl, 'trigger', ['nightly', 'manual'] as const)
    const filter: BackupRunFilter = {
      ...(status === undefined ? {} : { status }),
      ...(trigger === undefined ? {} : { trigger }),
    }
    type Row = { id: number; created_at: string; run: BackupStatusRecord }
    // Newest first only: a backup history is read from the latest run back.
    const page = await keysetCursorPage({
      requestUrl,
      cursorSigningKey: options.cursorSigningKey,
      viewer: principal,
      serializer: (row: Readonly<Row>) => serializeRun(row.run),
      order: logOrderFor<Row>('newest', ['number'], (row) => [row.created_at, row.id]),
      source: {
        snapshot: () => reader.runsSnapshot(),
        list: async (window) =>
          (
            await reader.pageRuns({
              ...filter,
              after:
                window.after === null
                  ? null
                  : { startedAt: window.after[0], id: window.after[1] as number },
              startedThrough: window.createdThrough,
              take: window.take,
            })
          ).map((run) => ({ id: run.id, created_at: run.started_at, run })),
      },
    })
    return context.json(withTotal(page, await reader.countRuns(filter)), 200, {
      'cache-control': 'no-store',
    })
  })
}
