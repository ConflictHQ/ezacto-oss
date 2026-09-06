import type { Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError } from './errors.js'

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

export interface BackupStatusReader {
  latestRuns(limit: number): Promise<BackupStatusRecord[]>
}

const requireAdministratorSession = <Bindings extends object>(
  context: Parameters<typeof requireSessionPrincipal<Bindings>>[0],
): void => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator') {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can view backup status.',
    })
  }
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
}
