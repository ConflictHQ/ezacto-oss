import {
  assertOrganizationHolidayFields,
  OrganizationHolidayError,
  type OrganizationHoliday,
  type OrganizationHolidayFilter,
  type OrganizationHolidayRepository,
  type OrganizationHolidayWindow,
} from '@ezacto/core'
import { atomic, nativeClient, type ActivityDatabase } from './activity-log.js'

type Row = {
  id: number
  holiday_date: string
  name: string
  version: number
  created_at: string
  updated_at: string
}
const record = (row: Row): OrganizationHoliday => ({
  id: row.id,
  date: row.holiday_date,
  name: row.name,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})
const snapshot = (row: OrganizationHoliday | null) =>
  row ? { id: row.id, date: row.date, name: row.name, version: row.version } : null
const liveAdministrator =
  "EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=1 AND profile='administrator')"
export const createOrganizationHolidayRepository = (
  database: ActivityDatabase,
): OrganizationHolidayRepository => {
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
  const get = async (id: number) => {
    const row = (await query<Row>('SELECT * FROM organization_holidays WHERE id=?', [id]))[0]
    return row ? record(row) : null
  }
  const entries = (filter: OrganizationHolidayFilter) => {
    const conditions = ['1'],
      params: unknown[] = []
    if (filter.from !== undefined) {
      conditions.push('holiday_date>=?')
      params.push(filter.from)
    }
    if (filter.to !== undefined) {
      conditions.push('holiday_date<=?')
      params.push(filter.to)
    }
    const where = conditions.join(' AND ')
    return {
      highWatermark: async () =>
        (
          await query<{ id: number | null }>(
            `SELECT max(id) AS id FROM organization_holidays WHERE ${where}`,
            params,
          )
        )[0]?.id ?? null,
      list: async (window: OrganizationHolidayWindow) => {
        if (!Number.isSafeInteger(window.take) || window.take < 1 || window.take > 201)
          throw new RangeError('Invalid holiday page size')
        return (
          await query<Row>(
            `SELECT * FROM organization_holidays WHERE ${where} AND id<=?${window.afterId === null ? '' : ' AND id>?'} ORDER BY id LIMIT ?`,
            [
              ...params,
              window.throughId,
              ...(window.afterId === null ? [] : [window.afterId]),
              window.take,
            ],
          )
        ).map(record)
      },
    }
  }
  const audit = (
    kind: 'created' | 'updated' | 'deleted',
    actorId: number,
    before: OrganizationHoliday | null,
    after: OrganizationHoliday | null,
    now: string,
  ) => {
    const eventId = crypto.randomUUID(),
      type = `organization_holiday.${kind}`
    const payload = JSON.stringify({
      schema_version: 1,
      event_id: eventId,
      event_type: type,
      occurred_at: now,
      aggregate: { type: 'organization_calendar', id: 1, sequence: 0 },
      actor: { type: 'user', id: actorId },
      holiday: { before: snapshot(before), after: snapshot(after) },
    })
    return {
      sql: `INSERT INTO event_outbox(id,aggregate_type,aggregate_id,aggregate_sequence,event_type,payload_json,occurred_at,available_at)
      SELECT ?,'organization_calendar',1,sequence,?,json_set(json(?),'$.aggregate.sequence',sequence${kind === 'created' ? ", '$.holiday.after.id',last_insert_rowid()" : ''}),?,?
      FROM(SELECT coalesce(max(aggregate_sequence),0)+1 AS sequence FROM event_outbox WHERE aggregate_type='organization_calendar' AND aggregate_id=1)
      WHERE changes()=1`,
      params: [eventId, type, payload, now, now],
    }
  }
  const write = async (
    sql: string,
    params: readonly unknown[],
    event: ReturnType<typeof audit>,
    actor: number,
  ): Promise<OrganizationHoliday> => {
    if (!Number.isSafeInteger(actor) || actor < 1)
      throw new OrganizationHolidayError('holiday_forbidden')
    try {
      const result = await atomic(client, [{ sql, params }, event])
      const row = result[0]?.[0] as Row | undefined
      if (row) return record(row)
    } catch (cause) {
      const seen = new Set<unknown>()
      let error = cause
      while (error instanceof Error && !seen.has(error) && seen.size < 8) {
        if (/UNIQUE constraint failed: organization_holidays.holiday_date/.test(error.message))
          throw new OrganizationHolidayError('holiday_date_exists')
        seen.add(error)
        error = (error as Error & { cause?: unknown }).cause
      }
      throw cause
    }
    if (
      !(
        await query("SELECT 1 FROM users WHERE id=? AND is_active=1 AND profile='administrator'", [
          actor,
        ])
      ).length
    )
      throw new OrganizationHolidayError('holiday_forbidden')
    throw new OrganizationHolidayError('holiday_changed')
  }
  const existing = async (id: number) => {
    const row = await get(id)
    if (!row) throw new OrganizationHolidayError('holiday_not_found')
    return row
  }
  return {
    get,
    entries,
    async create(actor, fields, now) {
      assertOrganizationHolidayFields(fields)
      const pending = { ...fields, id: 0, version: 0, createdAt: now, updatedAt: now }
      return write(
        `INSERT INTO organization_holidays(holiday_date,name,created_at,updated_at) SELECT ?,?,?,? WHERE ${liveAdministrator} RETURNING *`,
        [fields.date, fields.name, now, now, actor],
        audit('created', actor, null, pending, now),
        actor,
      )
    },
    async update(actor, id, fields, version, now) {
      assertOrganizationHolidayFields(fields)
      const before = await existing(id)
      if (before.version !== version) throw new OrganizationHolidayError('holiday_changed')
      const after = { ...before, ...fields, version: version + 1, updatedAt: now }
      return write(
        `UPDATE organization_holidays SET holiday_date=?,name=?,version=version+1,updated_at=? WHERE id=? AND version=? AND ${liveAdministrator} RETURNING *`,
        [fields.date, fields.name, now, id, version, actor],
        audit('updated', actor, before, after, now),
        actor,
      )
    },
    async remove(actor, id, version, now) {
      const before = await existing(id)
      if (before.version !== version) throw new OrganizationHolidayError('holiday_changed')
      return write(
        `DELETE FROM organization_holidays WHERE id=? AND version=? AND ${liveAdministrator} RETURNING *`,
        [id, version, actor],
        audit('deleted', actor, before, null, now),
        actor,
      )
    },
  }
}
