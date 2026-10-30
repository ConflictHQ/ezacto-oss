import { isMigrationLoadId, type MigrationLoadStatus } from '@ezacto/core'
import type { Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError } from './errors.js'

export interface MigrationLoadStatusReader {
  status(id: string): Promise<MigrationLoadStatus | null>
}
export const installMigrationLoadRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  reader: MigrationLoadStatusReader,
): void => {
  api.get('/migration-loads/:id', async (context) => {
    const principal = requireSessionPrincipal(context)
    if (principal.profile !== 'administrator')
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'Only administrators can view migration status.',
      })
    const id = context.req.param('id')
    if (!isMigrationLoadId(id))
      throw new ApiError({
        status: 422,
        code: 'validation_failed',
        message: 'A migration run UUID is required.',
        fields: [{ field: 'id', code: 'invalid_uuid', message: 'Expected a migration run UUID.' }],
      })
    const job = await reader.status(id)
    if (!job)
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The migration run was not found.',
      })
    return context.json({
      data: {
        id: job.id,
        status: job.status,
        snapshot_sha256: job.snapshotSha256,
        source_rows: job.sourceRows,
        resource: job.resource,
        rows_done: job.rowsDone,
        sequence: job.sequence,
        attempts: job.attempts,
        error_code: job.errorCode,
        created_at: job.createdAt,
        started_at: job.startedAt,
        completed_at: job.completedAt,
        source_cleaned_at: job.sourceCleanedAt,
        updated_at: job.updatedAt,
      },
      links: { self: `/api/v1/migration-loads/${job.id}` },
    })
  })
}
