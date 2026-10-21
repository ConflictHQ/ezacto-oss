import { sql } from 'drizzle-orm'
import {
  ScheduledJobError,
  scheduledJobConfig,
  dueMonthEndOccurrence,
  type ScheduledJob,
  type ScheduledJobConfig,
  type ScheduledJobsService,
} from '@ezacto/core'
import type { createScheduledActionStore } from './scheduled-actions.js'
import { proposeMonthEndPack, type MonthEndArtifactObjects } from './month-end-pack.js'

type Database = Parameters<typeof createScheduledActionStore>[0]
interface Row {
  id: number
  version: number
  action: 'month_end_pack'
  name: string
  scope_json: string
  cadence: string
  confirmation: 'required' | 'none'
  confirm_within_minutes: number
  is_active: number
  created_by_user_id: number
  created_at: string
  updated_at: string
  last_checked_at: string | null
  last_error: string | null
  last_run_id: number | null
}
const columns =
  'id,version,action,name,scope_json,cadence,confirmation,confirm_within_minutes,is_active,created_by_user_id,created_at,updated_at,last_checked_at,last_error,last_run_id'
const present = (row: Row): ScheduledJob => ({
  id: row.id,
  version: row.version,
  action: row.action,
  name: row.name,
  scope: JSON.parse(row.scope_json) as unknown,
  cadence: row.cadence,
  confirmation: row.confirmation,
  confirm_within_minutes: row.confirm_within_minutes,
  is_active: row.is_active === 1,
  created_by: row.created_by_user_id,
  created_at: row.created_at,
  updated_at: row.updated_at,
  last_checked_at: row.last_checked_at,
  last_error: row.last_error,
  last_run_id: row.last_run_id,
})

/** Recognize the client-filter spelling used by older manually configured jobs. */
const compatibleScope = (scope: unknown): unknown => {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return scope
  const fields = scope as Record<string, unknown>,
    keys = Object.keys(fields)
  if (keys.length === 1 && (keys[0] === 'clients' || keys[0] === 'clientIds'))
    return { client_ids: fields[keys[0]!] }
  return scope
}
const configOf = (job: ScheduledJob): ScheduledJobConfig =>
  scheduledJobConfig({
    action: job.action,
    name: job.name,
    scope: compatibleScope(job.scope),
    cadence: job.cadence,
    confirmation: job.confirmation,
    confirm_within_minutes: job.confirm_within_minutes,
    is_active: job.is_active,
  })
const activeAdmin = (actorId: number) =>
  sql`EXISTS(SELECT 1 FROM users WHERE id=${actorId} AND is_active=1 AND profile='administrator')`

export const createScheduledJobsService = (database: Database): ScheduledJobsService => {
  const read = async (id: number) => {
    const rows = await database.all<Row>(
      sql`SELECT ${sql.raw(columns)} FROM scheduled_jobs WHERE id=${id}`,
    )
    return rows[0] ? present(rows[0]) : null
  }
  return {
    read,
    snapshot: async () =>
      Number(
        (
          await database.all<{ id: number }>(
            sql`SELECT coalesce(max(id),0) AS id FROM scheduled_jobs`,
          )
        )[0]!.id,
      ),
    list: async (window) => {
      if (
        !Number.isSafeInteger(window.throughId) ||
        window.throughId < 0 ||
        !Number.isSafeInteger(window.take) ||
        window.take < 1 ||
        window.take > 201 ||
        (window.afterId !== null && (!Number.isSafeInteger(window.afterId) || window.afterId < 1))
      )
        throw new ScheduledJobError('invalid', 'Invalid scheduled-job page.')
      return (
        await database.all<Row>(sql`SELECT ${sql.raw(columns)} FROM scheduled_jobs
        WHERE id<=${window.throughId} AND (${window.afterId} IS NULL OR id>${window.afterId}) ORDER BY id LIMIT ${window.take}`)
      ).map(present)
    },
    create: async (actorId, input, now) => {
      const config = scheduledJobConfig(input)
      const rows = await database.all<Row>(sql`INSERT INTO scheduled_jobs
        (action,name,scope_json,cadence,confirmation,confirm_within_minutes,is_active,created_by_user_id,created_at,updated_at)
        SELECT 'month_end_pack',${config.name},${JSON.stringify(config.scope)},${config.cadence},'required',
          ${config.confirm_within_minutes},${config.is_active ? 1 : 0},${actorId},${now},${now}
        WHERE ${activeAdmin(actorId)} RETURNING ${sql.raw(columns)}`)
      if (!rows[0])
        throw new ScheduledJobError(
          'profile_forbidden',
          'Only active administrators may configure scheduled jobs.',
        )
      return present(rows[0])
    },
    update: async (actorId, id, version, patch, now) => {
      if (!Number.isSafeInteger(version) || version < 0)
        throw new ScheduledJobError(
          'invalid',
          'Provide the reviewed job version.',
          'expected_version',
        )
      const before = await read(id)
      if (!before) throw new ScheduledJobError('not_found', 'That scheduled job does not exist.')
      const config = scheduledJobConfig(patch, { ...before, scope: compatibleScope(before.scope) })
      const rows =
        await database.all<Row>(sql`UPDATE scheduled_jobs SET name=${config.name},scope_json=${JSON.stringify(config.scope)},
        cadence=${config.cadence},confirmation='required',confirm_within_minutes=${config.confirm_within_minutes},
        is_active=${config.is_active ? 1 : 0},version=version+1,updated_at=${now},last_checked_at=NULL,last_error=NULL
        WHERE id=${id} AND version=${version} AND ${activeAdmin(actorId)} RETURNING ${sql.raw(columns)}`)
      if (rows[0]) return present(rows[0])
      const actor = await database.all<{ id: number }>(
        sql`SELECT id FROM users WHERE id=${actorId} AND is_active=1 AND profile='administrator'`,
      )
      if (!actor.length)
        throw new ScheduledJobError(
          'profile_forbidden',
          'Only active administrators may configure scheduled jobs.',
        )
      throw new ScheduledJobError(
        'state_conflict',
        'The job changed. Refresh its settings before saving again.',
      )
    },
  }
}

export interface ScheduledJobSweepResult {
  checked: number
  proposed: readonly { jobId: number; runId: number }[]
  failed: readonly { jobId: number; message: string }[]
}
export const proposeDueScheduledJobs = async (
  database: Database,
  now: string,
  objects?: MonthEndArtifactObjects,
): Promise<ScheduledJobSweepResult> => {
  const organization = (
    await database.all<{ timezone: string }>(sql`SELECT timezone FROM organizations WHERE id=1`)
  )[0]
  if (!organization) return { checked: 0, proposed: [], failed: [] }
  // Round-robin by last check: a large installation advances through every job.
  const rows =
    await database.all<Row>(sql`SELECT ${sql.raw(columns)} FROM scheduled_jobs WHERE is_active=1
    ORDER BY coalesce(last_checked_at,''),id LIMIT 25`)
  const proposed: { jobId: number; runId: number }[] = [],
    failed: { jobId: number; message: string }[] = []
  const record = async (job: ScheduledJob, error: string | null, runId: number | null) => {
    await database.run(sql`UPDATE scheduled_jobs SET last_checked_at=${now},last_error=${error},
      last_run_id=coalesce(${runId},last_run_id) WHERE id=${job.id} AND version=${job.version}
      AND (last_checked_at IS NULL OR last_checked_at<=${now})`)
  }
  for (const row of rows) {
    const job = present(row)
    try {
      const config = configOf(job)
      const occurrence = dueMonthEndOccurrence(now, organization.timezone, config.cadence)
      if (!occurrence) {
        await record(job, null, null)
        continue
      }
      const existing = (
        await database.all<{ id: number }>(
          sql`SELECT id FROM proposed_runs WHERE job_id=${job.id} AND occurrence_key=${occurrence}`,
        )
      )[0]
      if (existing) {
        await record(job, null, existing.id)
        continue
      }
      const result = await proposeMonthEndPack(
        database,
        {
          jobId: job.id,
          expectedJobVersion: job.version,
          occurrenceKey: occurrence,
          clientIds: config.scope.client_ids,
          proposedAt: now,
          expiresAt: new Date(
            Date.parse(now) + config.confirm_within_minutes * 60000,
          ).toISOString(),
        },
        objects,
      )
      if (result.outcome.outcome === 'proposed') {
        proposed.push({ jobId: job.id, runId: result.outcome.run.id })
        await record(job, null, result.outcome.run.id)
      } else if (result.outcome.outcome === 'already_proposed') {
        const current = (
          await database.all<{ id: number }>(
            sql`SELECT id FROM proposed_runs WHERE job_id=${job.id} AND occurrence_key=${occurrence}`,
          )
        )[0]
        await record(job, null, current?.id ?? null)
      } else
        throw new Error(
          result.outcome.outcome === 'empty_manifest'
            ? 'No eligible invoices; no proposal was created.'
            : 'Job settings changed or the job was paused before proposal.',
        )
    } catch (error) {
      const message = (
        error instanceof Error ? error.message : 'The manifest could not be rendered.'
      ).slice(0, 1000)
      failed.push({ jobId: job.id, message })
      await record(job, message, null)
    }
  }
  return { checked: rows.length, proposed, failed }
}
