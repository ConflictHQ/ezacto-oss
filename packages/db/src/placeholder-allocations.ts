import {
  assertAllocationFields,
  canProfileUseApiScope,
  decideAssignment,
  PlaceholderAssignmentError,
  TrackedResourceInputError,
  type AllocationWeekStartDay,
  type AssignmentContext,
  type AssignmentResult,
  type PersonAllocationRow,
  type PlaceholderAllocation,
  type PlaceholderAllocationState,
  type TeamViewer,
} from '@ezacto/core'
import { atomic, nativeClient, type ActivityDatabase } from './activity-log.js'
import { teamProjectAccessPredicate } from './team-access.js'

/**
 * Unassigned project demand (issue 1191, parent 1007): named placeholders and
 * their dated allocations, and the one command that turns a placeholder
 * allocation into a person's plan.
 *
 * Nothing here touches capacity, rates, time entries, invoices or payments, and
 * it grants no staffing or project access. The decision order, warnings and
 * prerequisites are `decideAssignment` in `@ezacto/core`; this file supplies its
 * facts from the database and commits the result as one batch (D1) or
 * transaction (SQLite). Every write is guarded in SQL as well, so a change that
 * races the read commits nothing.
 *
 * Who sees what: only schedule managers read or write. Administrators and
 * executive managers see every placeholder; a project manager is confined to
 * the projects they manage. Everyone else is refused, never shown an empty list.
 */

export interface PlaceholderAllocationRecord extends PlaceholderAllocation {
  readonly name: string
}

export interface PlaceholderRecord {
  readonly id: number
  readonly name: string
  readonly isActive: boolean
}

export interface CreatePlaceholderAllocationRequest {
  placeholderId: number
  projectId: number
  startDate: string
  endDate: string
  plannedSecondsPerWeek: number
}

export interface PlaceholderAllocationFilters {
  projectId?: number
  state?: PlaceholderAllocationState
  /** Allocations that reach this day or later. */
  from?: string
  /** Allocations that begin on this day or earlier. */
  to?: string
}

export interface AssignPlaceholderRequest {
  idempotencyKey: string
  placeholderAllocationId: number
  expectedRevision: number
  userId: number
}

interface Row {
  id: number
  placeholder_id: number
  name: string
  project_id: number
  start_date: string
  end_date: string
  planned_seconds_per_week: number
  state: PlaceholderAllocationState
  revision: number
  assigned_allocation_id: number | null
}

const record = (row: Row): PlaceholderAllocationRecord => ({
  id: String(row.id),
  placeholderId: String(row.placeholder_id),
  name: row.name,
  projectId: String(row.project_id),
  startDate: row.start_date,
  endDate: row.end_date,
  plannedSecondsPerWeek: row.planned_seconds_per_week,
  state: row.state,
  revision: row.revision,
  assignedAllocationId:
    row.assigned_allocation_id === null ? null : String(row.assigned_allocation_id),
})

const select = `SELECT pa.*, ph.name FROM placeholder_allocations pa
  JOIN placeholders ph ON ph.id = pa.placeholder_id`

const canManage = (viewer: Readonly<TeamViewer>): boolean =>
  canProfileUseApiScope(viewer.profile, 'schedule:write')

const forbidden = () =>
  new PlaceholderAssignmentError('placeholder_forbidden', 'You cannot manage this project.')

const hasMessage = (error: unknown, pattern: RegExp): boolean => {
  const seen = new Set<unknown>()
  let current = error
  while (current instanceof Error && !seen.has(current) && seen.size < 8) {
    if (pattern.test(current.message)) return true
    seen.add(current)
    current = (current as Error & { cause?: unknown }).cause
  }
  return false
}

interface Fragment {
  sql: string
  params: unknown[]
}

/** The actor is still who the session says, and still active. */
const liveActor = (viewer: Readonly<TeamViewer>): Fragment => ({
  sql: `EXISTS (SELECT 1 FROM users actor WHERE actor.id = ? AND actor.is_active = 1 AND actor.profile = ?)`,
  params: [viewer.userId, viewer.profile],
})

/** The viewer manages `alias`, a projects row. Administrators and executives manage all. */
const projectScope = (viewer: Readonly<TeamViewer>, alias: string): Fragment => {
  const predicate = teamProjectAccessPredicate(viewer, alias)
  return { sql: predicate.sql, params: [...predicate.bindings] }
}

type Statement = { sql: string; params: unknown[] }

/**
 * The outbox row for one change, run straight after the write it describes: it
 * reads `changes()` from the statement before it, so there is no event for a
 * refused write and no committed write without its event.
 */
const event = (
  aggregateType: 'placeholder' | 'placeholder_allocation',
  eventType: string,
  actorId: number,
  body: Record<string, unknown>,
  subject: { expr: string; params: unknown[] },
  idPath: string | null,
  now: string,
  sets: { path: string; expr: string; params: unknown[] }[] = [],
): Statement => {
  const eventId = crypto.randomUUID()
  const payload = JSON.stringify({
    schema_version: 1,
    event_id: eventId,
    event_type: eventType,
    occurred_at: now,
    aggregate: { type: aggregateType, id: 0, sequence: 0 },
    actor: { type: 'user', id: actorId },
    ...body,
  })
  const extra = [
    ...(idPath === null ? [] : [{ path: idPath, expr: 'subject.id', params: [] as unknown[] }]),
    ...sets,
  ]
  return {
    sql: `INSERT INTO event_outbox (
        id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
        payload_json, occurred_at, available_at
      )
      SELECT ?, ?, subject.id, subject.sequence, ?,
        json_set(json(?),
          '$.aggregate.id', subject.id,
          '$.aggregate.sequence', subject.sequence${extra.map((set) => `, '${set.path}', ${set.expr}`).join('')}),
        ?, ?
      FROM (
        SELECT target.id AS id, coalesce((
          SELECT max(aggregate_sequence) FROM event_outbox
          WHERE aggregate_type = ? AND aggregate_id = target.id
        ), 0) + 1 AS sequence
        FROM (SELECT ${subject.expr} AS id) target
      ) subject
      WHERE changes() = 1`,
    // Parameters in the order the placeholders appear above.
    params: [
      eventId,
      aggregateType,
      eventType,
      payload,
      ...extra.flatMap((set) => set.params),
      now,
      now,
      aggregateType,
      ...subject.params,
    ],
  }
}

export const createPlaceholderAllocationRepository = (database: ActivityDatabase) => {
  const client = nativeClient(database)
  const query = async <T>(sql: string, params: readonly unknown[] = []): Promise<T[]> => {
    if ('batch' in client)
      return (
        await client
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results
    return client.prepare(sql).all(...params) as T[]
  }

  const readOne = async (id: number): Promise<PlaceholderAllocationRecord | undefined> => {
    const row = (await query<Row>(`${select} WHERE pa.id = ?`, [id]))[0]
    return row ? record(row) : undefined
  }

  /** Does this viewer currently manage the project? */
  const manages = async (viewer: Readonly<TeamViewer>, projectId: number): Promise<boolean> => {
    if (!canManage(viewer)) return false
    const actor = liveActor(viewer)
    const scope = projectScope(viewer, 'project')
    return (
      (
        await query(
          `SELECT 1 FROM projects project WHERE project.id = ? AND ${actor.sql} AND ${scope.sql}`,
          [projectId, ...actor.params, ...scope.params],
        )
      ).length > 0
    )
  }

  /** The first refusal that applies to a placeholder allocation, in the contract's order. */
  const refuse = async (
    viewer: Readonly<TeamViewer>,
    id: number,
    expectedRevision: number,
  ): Promise<PlaceholderAllocationRecord> => {
    const row = await readOne(id)
    if (!row)
      throw new PlaceholderAssignmentError(
        'placeholder_not_found',
        'The placeholder does not exist.',
      )
    if (!(await manages(viewer, Number(row.projectId)))) throw forbidden()
    if (row.revision !== expectedRevision)
      throw new PlaceholderAssignmentError(
        'placeholder_stale',
        'The placeholder changed. Read it again.',
      )
    if (row.state !== 'open')
      throw new PlaceholderAssignmentError(
        'placeholder_not_open',
        'The placeholder is no longer open.',
      )
    return row
  }

  const context = async (
    viewer: Readonly<TeamViewer>,
    placeholder: PlaceholderAllocationRecord,
    userId: number,
  ): Promise<AssignmentContext> => {
    const projectId = Number(placeholder.projectId)
    const person = (
      await query<{ is_active: number; weekly_capacity: number }>(
        'SELECT is_active, weekly_capacity FROM users WHERE id = ?',
        [userId],
      )
    )[0]
    const project = (
      await query<{ is_active: number }>('SELECT is_active FROM projects WHERE id = ?', [projectId])
    )[0]
    const access = await query(
      'SELECT 1 FROM user_assignments WHERE user_id = ? AND project_id = ? AND is_active = 1',
      [userId, projectId],
    )
    const organization = (
      await query<{ week_start_day: AllocationWeekStartDay }>(
        'SELECT week_start_day FROM organizations WHERE id = 1',
      )
    )[0]
    const personAllocations = (
      await query<{
        id: number
        user_id: number
        project_id: number
        start_date: string
        end_date: string
        planned_seconds_per_week: number
      }>('SELECT * FROM allocations WHERE user_id = ?', [userId])
    ).map((row): PersonAllocationRow => ({
      id: String(row.id),
      userId: String(row.user_id),
      projectId: String(row.project_id),
      startDate: row.start_date,
      endDate: row.end_date,
      plannedSecondsPerWeek: row.planned_seconds_per_week,
    }))
    return {
      actorCanManageProject: await manages(viewer, projectId),
      personActive: person?.is_active === 1,
      projectActive: project?.is_active === 1,
      personHasProjectAccess: access.length > 0,
      personWeeklyCapacitySeconds: person?.weekly_capacity ?? 0,
      weekStartDay: organization?.week_start_day ?? 'monday',
      personAllocations,
    }
  }

  const snapshot = (row: PlaceholderAllocation | null) =>
    row === null
      ? null
      : {
          id: Number(row.id),
          project_id: Number(row.projectId),
          start_date: row.startDate,
          end_date: row.endDate,
          planned_seconds_per_week: row.plannedSecondsPerWeek,
          state: row.state,
          revision: row.revision,
        }

  const stored = async (viewer: Readonly<TeamViewer>, key: string) =>
    (
      await query<{ fingerprint: string; placeholder_allocation_id: number; result_json: string }>(
        'SELECT fingerprint, placeholder_allocation_id, result_json FROM placeholder_assignment_keys WHERE actor_id = ? AND idempotency_key = ?',
        [viewer.userId, key],
      )
    )[0]

  return {
    /** A name for unassigned demand. It names no person. */
    async createPlaceholder(
      viewer: Readonly<TeamViewer>,
      input: Readonly<{ name: string }>,
      now: string,
    ): Promise<PlaceholderRecord> {
      if (!canManage(viewer)) throw forbidden()
      const name = typeof input.name === 'string' ? input.name.trim() : ''
      if (name.length < 1 || name.length > 120)
        throw new TrackedResourceInputError(
          'name',
          'invalid_name',
          'name must be 1 to 120 characters',
        )
      const actor = liveActor(viewer)
      const results = await atomic(client, [
        {
          sql: `INSERT INTO placeholders (name, created_at, updated_at)
            SELECT ?, ?, ? WHERE ${actor.sql} RETURNING id, name, is_active`,
          params: [name, now, now, ...actor.params],
        },
        event(
          'placeholder',
          'placeholder.created',
          viewer.userId,
          { placeholder: { name } },
          { expr: 'last_insert_rowid()', params: [] },
          null,
          now,
        ),
      ])
      const row = results[0]?.[0] as { id: number; name: string; is_active: number } | undefined
      if (!row) throw forbidden()
      return { id: row.id, name: row.name, isActive: row.is_active === 1 }
    },

    async createAllocation(
      viewer: Readonly<TeamViewer>,
      input: Readonly<CreatePlaceholderAllocationRequest>,
      now: string,
    ): Promise<PlaceholderAllocationRecord> {
      if (!canManage(viewer)) throw forbidden()
      assertAllocationFields(input)
      const actor = liveActor(viewer)
      const scope = projectScope(viewer, 'project')
      const results = await atomic(client, [
        {
          sql: `INSERT INTO placeholder_allocations
              (placeholder_id, project_id, start_date, end_date, planned_seconds_per_week, created_at, updated_at)
            SELECT ph.id, project.id, ?, ?, ?, ?, ?
            FROM projects project JOIN placeholders ph ON ph.id = ? AND ph.is_active = 1
            WHERE project.id = ? AND project.is_active = 1 AND ${actor.sql} AND ${scope.sql}
            RETURNING id`,
          params: [
            input.startDate,
            input.endDate,
            input.plannedSecondsPerWeek,
            now,
            now,
            input.placeholderId,
            input.projectId,
            ...actor.params,
            ...scope.params,
          ],
        },
        event(
          'placeholder_allocation',
          'placeholder_allocation.created',
          viewer.userId,
          {
            placeholder_allocation: {
              before: null,
              after: {
                id: 0,
                project_id: input.projectId,
                start_date: input.startDate,
                end_date: input.endDate,
                planned_seconds_per_week: input.plannedSecondsPerWeek,
                state: 'open',
                revision: 0,
              },
            },
          },
          { expr: 'last_insert_rowid()', params: [] },
          '$.placeholder_allocation.after.id',
          now,
        ),
      ])
      const id = results[0]?.[0]?.id
      if (typeof id !== 'number') {
        const placeholder = (
          await query<{ is_active: number }>('SELECT is_active FROM placeholders WHERE id = ?', [
            input.placeholderId,
          ])
        )[0]
        if (!placeholder || placeholder.is_active !== 1)
          throw new TrackedResourceInputError(
            'placeholder_id',
            'unknown_placeholder',
            'placeholder_id does not name an active placeholder',
          )
        throw new TrackedResourceInputError(
          'project_id',
          'unknown_project',
          'project_id does not name an active project you can plan',
        )
      }
      return (await readOne(id))!
    },

    async list(
      viewer: Readonly<TeamViewer>,
      filters: Readonly<PlaceholderAllocationFilters> = {},
    ): Promise<PlaceholderAllocationRecord[]> {
      if (!canManage(viewer)) throw forbidden()
      const scope = projectScope(viewer, 'project')
      const conditions = [
        `EXISTS (SELECT 1 FROM projects project WHERE project.id = pa.project_id AND ${scope.sql})`,
      ]
      const params: unknown[] = [...scope.params]
      if (filters.projectId !== undefined) {
        conditions.push('pa.project_id = ?')
        params.push(filters.projectId)
      }
      if (filters.state !== undefined) {
        conditions.push('pa.state = ?')
        params.push(filters.state)
      }
      if (filters.from !== undefined) {
        conditions.push('pa.end_date >= ?')
        params.push(filters.from)
      }
      if (filters.to !== undefined) {
        conditions.push('pa.start_date <= ?')
        params.push(filters.to)
      }
      return (
        await query<Row>(
          `${select} WHERE ${conditions.join(' AND ')} ORDER BY pa.start_date, pa.id LIMIT 200`,
          params,
        )
      ).map(record)
    },

    async archive(
      viewer: Readonly<TeamViewer>,
      id: number,
      expectedRevision: number,
      now: string,
    ): Promise<PlaceholderAllocationRecord> {
      const before = await refuse(viewer, id, expectedRevision)
      const actor = liveActor(viewer)
      const scope = projectScope(viewer, 'project')
      const after: PlaceholderAllocation = {
        ...before,
        state: 'archived',
        revision: before.revision + 1,
      }
      const results = await atomic(client, [
        {
          sql: `UPDATE placeholder_allocations
            SET state = 'archived', revision = revision + 1, updated_at = ?
            WHERE id = ? AND revision = ? AND state = 'open' AND ${actor.sql}
              AND EXISTS (SELECT 1 FROM projects project
                WHERE project.id = placeholder_allocations.project_id AND ${scope.sql})
            RETURNING id`,
          params: [now, id, expectedRevision, ...actor.params, ...scope.params],
        },
        event(
          'placeholder_allocation',
          'placeholder_allocation.archived',
          viewer.userId,
          { placeholder_allocation: { before: snapshot(before), after: snapshot(after) } },
          { expr: '?', params: [id] },
          null,
          now,
        ),
      ])
      if (results[0]?.[0] === undefined) await refuse(viewer, id, expectedRevision)
      return (await readOne(id))!
    },

    /**
     * The assignment command. One batch creates the person's allocation, marks
     * the placeholder allocation assigned (revision + 1), records the key's
     * result and writes the audit event. Any failure, including a date overlap
     * caught by the allocations trigger, commits none of it.
     */
    async assign(
      viewer: Readonly<TeamViewer>,
      input: Readonly<AssignPlaceholderRequest>,
      now: string,
    ): Promise<AssignmentResult> {
      const command = {
        actorId: String(viewer.userId),
        idempotencyKey: input.idempotencyKey,
        placeholderAllocationId: String(input.placeholderAllocationId),
        expectedRevision: input.expectedRevision,
        userId: String(input.userId),
      }
      const fingerprint = JSON.stringify([
        command.placeholderAllocationId,
        command.expectedRevision,
        command.userId,
      ])
      const replay = async (): Promise<AssignmentResult | undefined> => {
        const prior = await stored(viewer, input.idempotencyKey)
        if (!prior) return undefined
        if (prior.fingerprint !== fingerprint)
          throw new PlaceholderAssignmentError(
            'idempotency_key_reused',
            'This key was already used for a different request.',
          )
        const placeholder = await readOne(prior.placeholder_allocation_id)
        if (!placeholder || !(await manages(viewer, Number(placeholder.projectId))))
          throw forbidden()
        return JSON.parse(prior.result_json) as AssignmentResult
      }

      const replayed = await replay()
      if (replayed) return replayed
      const placeholder = await readOne(input.placeholderAllocationId)
      const decision = decideAssignment(
        command,
        placeholder,
        placeholder ? await context(viewer, placeholder, input.userId) : ({} as AssignmentContext),
        '0',
      )
      const actor = liveActor(viewer)
      const scope = projectScope(viewer, 'project')
      const id = input.placeholderAllocationId
      try {
        const results = await atomic(client, [
          {
            sql: `INSERT INTO allocations
                (user_id, project_id, start_date, end_date, planned_seconds_per_week, created_at, updated_at)
              SELECT person.id, pa.project_id, pa.start_date, pa.end_date, pa.planned_seconds_per_week, ?, ?
              FROM placeholder_allocations pa
                JOIN projects project ON project.id = pa.project_id
                JOIN users person ON person.id = ?
              WHERE pa.id = ? AND pa.revision = ? AND pa.state = 'open'
                AND project.is_active = 1 AND person.is_active = 1
                AND ${actor.sql} AND ${scope.sql}
              RETURNING id`,
            params: [
              now,
              now,
              input.userId,
              id,
              input.expectedRevision,
              ...actor.params,
              ...scope.params,
            ],
          },
          {
            sql: `UPDATE placeholder_allocations
              SET state = 'assigned', revision = revision + 1,
                assigned_allocation_id = last_insert_rowid(), updated_at = ?
              WHERE id = ? AND revision = ? AND state = 'open' AND changes() = 1
              RETURNING id`,
            params: [now, id, input.expectedRevision],
          },
          {
            sql: `INSERT INTO placeholder_assignment_keys
                (actor_id, idempotency_key, fingerprint, placeholder_allocation_id, result_json, created_at)
              SELECT ?, ?, ?, pa.id,
                json_set(json(?),
                  '$.allocation.id', CAST(pa.assigned_allocation_id AS TEXT),
                  '$.placeholder.assignedAllocationId', CAST(pa.assigned_allocation_id AS TEXT)),
                ?
              FROM placeholder_allocations pa WHERE pa.id = ? AND changes() = 1`,
            params: [
              viewer.userId,
              input.idempotencyKey,
              fingerprint,
              JSON.stringify(decision),
              now,
              id,
            ],
          },
          event(
            'placeholder_allocation',
            'placeholder_allocation.assigned',
            viewer.userId,
            {
              placeholder_allocation: {
                before: snapshot(placeholder!),
                after: snapshot(decision.placeholder),
              },
              user_id: input.userId,
            },
            { expr: '?', params: [id] },
            null,
            now,
            [
              {
                path: '$.allocation_id',
                expr: '(SELECT assigned_allocation_id FROM placeholder_allocations WHERE id = ?)',
                params: [id],
              },
            ],
          ),
        ])
        if (results[1]?.[0] === undefined) {
          await refuse(viewer, id, input.expectedRevision)
          throw new PlaceholderAssignmentError(
            'placeholder_stale',
            'The placeholder changed. Read it again.',
          )
        }
      } catch (error) {
        if (hasMessage(error, /allocation overlaps another allocation/))
          throw new PlaceholderAssignmentError(
            'allocation_overlap',
            'This person already has a plan on this project for these dates.',
          )
        if (hasMessage(error, /UNIQUE constraint failed: placeholder_assignment_keys/)) {
          const raced = await replay()
          if (raced) return raced
        }
        throw error
      }
      return (await replay())!
    },
  }
}

export type PlaceholderAllocationRepository = ReturnType<
  typeof createPlaceholderAllocationRepository
>
