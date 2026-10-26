import { sql } from 'drizzle-orm'
import {
  CalendarFeedError,
  CalendarFeedInputError,
  ResourceCalendarReadError,
  canProfileUseApiScope,
  calendarFeedExpiry,
  createCalendarFeedSecret,
  hashCalendarFeedPassword,
  verifyCalendarFeedPassword,
  isCalendarFeedId,
  isAllocationDate,
  calendarFeedFacts,
  reconcileCalendarFeed,
  serializeCalendarFeed,
  type CalendarFeedAuthority,
  type CalendarFeedInput,
  type CalendarFeedDescriptor,
  type CalendarFeedService,
  type CalendarFeedEventState,
  type TeamViewer,
} from '@ezacto/core'
import type { InvoiceStateDatabase } from './invoice-state.js'
import { createResourceCalendarRepository } from './resource-calendar.js'

type RecordRow = CalendarFeedDescriptor & {
  owner_user_id: number
  password_hash: string | null
  instance_nonce: string
  uid_namespace: string
  authority_facts: string
  state_json: string
  state_revision: number
}
type Owner = { viewer: TeamViewer; nonce: string; facts: string }
const descriptor = (row: RecordRow): CalendarFeedDescriptor => ({
  id: row.id,
  scope: row.scope,
  project_id: row.project_id,
  from_date: row.from_date,
  through_date: row.through_date,
  include_names: Boolean(row.include_names),
  issued_at: row.issued_at,
  expires_at: row.expires_at,
  revoked_at: row.revoked_at,
  credential_generation: row.credential_generation,
})
const sessionProof = (a: CalendarFeedAuthority | undefined, now: string) =>
  a === undefined
    ? sql`1`
    : sql`EXISTS(
  SELECT 1 FROM sessions s WHERE s.id=${a.sessionId} AND s.user_id=${a.userId} AND s.revoked_at IS NULL
    AND s.profile_snapshot=u.profile AND json(s.manager_grants_snapshot)=json(u.manager_grants)
    AND julianday(s.idle_expires_at)>julianday(${now}) AND julianday(s.absolute_expires_at)>julianday(${now}))`
const validInput = (input: CalendarFeedInput) => {
  if (
    !['self', 'project', 'team'].includes(input.scope) ||
    typeof input.include_names !== 'boolean' ||
    !isAllocationDate(input.from_date) ||
    !isAllocationDate(input.through_date) ||
    input.from_date > input.through_date ||
    Date.parse(input.through_date) - Date.parse(input.from_date) > 364 * 86400000 ||
    (input.scope === 'project'
      ? !Number.isSafeInteger(input.project_id) || input.project_id! < 1
      : input.project_id !== null)
  )
    throw new CalendarFeedError(
      'invalid',
      'Choose a valid scope and a date range of at most one year.',
    )
}
/** Every response is fenced by the current projection revision and current owner
 * authority. Stored reconciliation state contains no names, reasons or amounts. */
export const createCalendarFeedService = (
  database: InvoiceStateDatabase,
  options: {
    now?: () => Date
    afterProjection?: () => Promise<void>
  } = {},
): CalendarFeedService => {
  const now = () => (options.now?.() ?? new Date()).toISOString()
  const owner = async (id: number, authority?: CalendarFeedAuthority, scope: CalendarFeedInput['scope'] = 'self'): Promise<Owner> => {
    const stamp = now()
    const rows = await database.all<{
      profile: TeamViewer['profile']
      manager_grants: string
      nonce: string
      assignments: string
      teammates: string
    }>(sql`
      SELECT u.profile,u.manager_grants,i.nonce,
        (SELECT json_group_array(json_array(project_id,is_active,is_project_manager)) FROM
          (SELECT project_id,is_active,is_project_manager FROM user_assignments WHERE user_id=u.id ORDER BY project_id,id)) assignments,
        (SELECT json_group_array(user_id) FROM (SELECT user_id FROM teammate_assignments WHERE manager_id=u.id ORDER BY user_id)) teammates
      FROM users u CROSS JOIN planning_calendar_instance i WHERE u.id=${id} AND u.is_active=1
        AND NOT EXISTS(SELECT 1 FROM account_closures c WHERE c.user_id=u.id) AND ${sessionProof(authority, stamp)}`)
    const row = rows[0]
    if (!row || !canProfileUseApiScope(row.profile, 'schedule:read'))
      throw new CalendarFeedError('forbidden')
    return {
      viewer: { userId: id, profile: row.profile, managerGrants: JSON.parse(row.manager_grants) },
      nonce: row.nonce,
      facts: JSON.stringify([
        row.profile,
        JSON.parse(row.manager_grants),
        ...(scope === 'self' ? [] : [JSON.parse(row.assignments), JSON.parse(row.teammates)]),
      ]),
    }
  }
  const readRecord = async (id: string, authority?: CalendarFeedAuthority) => {
    if (!isCalendarFeedId(id)) throw new CalendarFeedError('not_found')
    const rows = await database.all<RecordRow>(
      sql`SELECT * FROM planning_calendar_feeds WHERE id=${id}`,
    )
    const row = rows[0]
    if (!row || (authority && row.owner_user_id !== authority.userId))
      throw new CalendarFeedError('not_found')
    return row
  }
  const check = (row: RecordRow, who: Owner, stamp: string) => {
    if (
      row.revoked_at !== null ||
      row.expires_at <= stamp ||
      row.password_hash === null ||
      row.instance_nonce !== who.nonce ||
      row.authority_facts !== who.facts
    )
      throw new CalendarFeedError('not_found')
    if (row.scope !== 'self' && !canProfileUseApiScope(who.viewer.profile, 'schedule:write'))
      throw new CalendarFeedError('forbidden')
  }
  const projection = async (input: CalendarFeedInput, who: Owner) => {
    if (input.scope !== 'self' && !canProfileUseApiScope(who.viewer.profile, 'schedule:write'))
      throw new CalendarFeedError('forbidden')
    let revision = -1
    try {
      const result = await createResourceCalendarRepository(database, {
        planningOnly: true,
        captureFeedRevision: (value) => {
          revision = value
        },
      }).read(
        who.viewer,
        {
          view: input.scope === 'project' ? 'project' : 'team',
          from: input.from_date,
          to: input.through_date,
          limit: 100,
          ...(input.scope === 'project' ? { projectId: input.project_id! } : {}),
          ...(input.scope === 'self' ? { personId: who.viewer.userId } : {}),
        },
        new Date(now()),
      )
      const facts = calendarFeedFacts(result, { includeNames: input.include_names })
      await options.afterProjection?.()
      return { facts, revision }
    } catch (error) {
      if (error instanceof ResourceCalendarReadError)
        throw new CalendarFeedError(error.code === 'range_too_large' ? 'invalid' : 'forbidden')
      if (error instanceof CalendarFeedInputError)
        throw new CalendarFeedError('invalid', error.message)
      throw error
    }
  }
  const read = async (id: string, authority?: CalendarFeedAuthority, password?: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await readRecord(id, authority),
        who = await owner(row.owner_user_id, authority, row.scope),
        stamp = now()
      check(row, who, stamp)
      if (
        !authority &&
        !(await verifyCalendarFeedPassword(who.nonce, id, password ?? '', row.password_hash!))
      )
        throw new CalendarFeedError('not_found')
      const rate = await database.all(sql`UPDATE planning_calendar_feeds SET
        rate_count=CASE WHEN rate_window=${Math.floor(Date.parse(stamp) / 60000)} THEN rate_count+1 ELSE 1 END,
        rate_window=${Math.floor(Date.parse(stamp) / 60000)}
        WHERE id=${id} AND (rate_window<>${Math.floor(Date.parse(stamp) / 60000)} OR rate_count<60) RETURNING id`)
      if (!rate.length) throw new CalendarFeedError('rate_limited')
      const current = await projection(row, who)
      const again = await owner(row.owner_user_id, authority, row.scope)
      check(row, again, now())
      const reconciled = reconcileCalendarFeed(
        row.uid_namespace,
        JSON.parse(row.state_json) as CalendarFeedEventState[],
        current.facts,
        stamp,
      )
      const saved =
        await database.all(sql`UPDATE planning_calendar_feeds SET state_json=${JSON.stringify(reconciled.state)},state_revision=state_revision+1
        WHERE id=${id} AND state_revision=${row.state_revision} AND credential_generation=${row.credential_generation}
          AND revoked_at IS NULL AND password_hash=${row.password_hash} AND expires_at>${now()}
          AND instance_nonce=(SELECT nonce FROM planning_calendar_instance WHERE singleton=1)
          AND (SELECT revision FROM planning_calendar_source WHERE singleton=1)=${current.revision}
          AND EXISTS(SELECT 1 FROM users u WHERE u.id=${row.owner_user_id} AND ${sessionProof(authority, now())}) RETURNING id`)
      if (saved.length) return serializeCalendarFeed(reconciled.events)
    }
    throw new CalendarFeedError(
      'conflict',
      'Planning changed while preparing the feed. Reload to retry.',
    )
  }
  return {
    list: async (authority) => {
      await owner(authority.userId, authority)
      return (
        await database.all<RecordRow>(
          sql`SELECT * FROM planning_calendar_feeds WHERE owner_user_id=${authority.userId} ORDER BY (revoked_at IS NULL AND expires_at>${now()}) DESC,issued_at DESC,id LIMIT 20`,
        )
      ).map(descriptor)
    },
    create: async (authority, input) => {
      validInput(input)
      const who = await owner(authority.userId, authority, input.scope),
        stamp = now(),
        secret = createCalendarFeedSecret()
      let expires: string
      try {
        expires = calendarFeedExpiry(new Date(stamp), input.expires_at)
      } catch {
        throw new CalendarFeedError('invalid', 'Choose an expiry within 90 days.')
      }
      const current = await projection(input, who),
        again = await owner(authority.userId, authority, input.scope)
      if (who.facts !== again.facts || who.nonce !== again.nonce)
        throw new CalendarFeedError('conflict')
      const state = reconcileCalendarFeed(secret.namespace, [], current.facts, stamp).state
      const rows =
        await database.all(sql`INSERT INTO planning_calendar_feeds(id,owner_user_id,scope,project_id,from_date,through_date,include_names,password_hash,instance_nonce,uid_namespace,authority_facts,issued_at,expires_at,state_json)
        SELECT ${secret.id},${authority.userId},${input.scope},${input.project_id},${input.from_date},${input.through_date},${Number(input.include_names)},${await hashCalendarFeedPassword(who.nonce, secret.id, secret.password)},${who.nonce},${secret.namespace},${who.facts},${stamp},${expires},${JSON.stringify(state)}
        WHERE (SELECT revision FROM planning_calendar_source WHERE singleton=1)=${current.revision}
          AND (SELECT nonce FROM planning_calendar_instance WHERE singleton=1)=${who.nonce}
          AND (SELECT count(*) FROM planning_calendar_feeds WHERE owner_user_id=${authority.userId} AND revoked_at IS NULL AND expires_at>${now()})<20
          AND EXISTS(SELECT 1 FROM users u WHERE u.id=${authority.userId} AND ${sessionProof(authority, now())}) RETURNING id`)
      if (!rows.length)
        throw new CalendarFeedError(
          'conflict',
          'Planning changed or the 20-feed limit was reached. Refresh or revoke an unused feed.',
        )
      return {
        feed: descriptor(await readRecord(secret.id, authority)),
        username: secret.id,
        password: secret.password,
      }
    },
    rotate: async (authority, id) => {
      const row = await readRecord(id, authority),
        who = await owner(authority.userId, authority, row.scope),
        secret = createCalendarFeedSecret(),
        stamp = now()
      if (row.authority_facts !== who.facts)
        throw new CalendarFeedError('forbidden', 'Permissions changed. Create a new scoped feed.')
      const current = await projection(row, who),
        again = await owner(authority.userId, authority, row.scope)
      if (who.facts !== again.facts || who.nonce !== again.nonce)
        throw new CalendarFeedError('conflict')
      const rows =
        await database.all(sql`UPDATE planning_calendar_feeds SET password_hash=${await hashCalendarFeedPassword(who.nonce, id, secret.password)},instance_nonce=${who.nonce},issued_at=${stamp},expires_at=${calendarFeedExpiry(new Date(stamp))},revoked_at=NULL,credential_generation=credential_generation+1
        WHERE id=${id} AND owner_user_id=${authority.userId} AND credential_generation=${row.credential_generation}
          AND (SELECT count(*) FROM planning_calendar_feeds WHERE owner_user_id=${authority.userId} AND id<>${id} AND revoked_at IS NULL AND expires_at>${now()})<20
          AND (SELECT revision FROM planning_calendar_source WHERE singleton=1)=${current.revision}
          AND (SELECT nonce FROM planning_calendar_instance WHERE singleton=1)=${who.nonce}
          AND EXISTS(SELECT 1 FROM users u WHERE u.id=${authority.userId} AND ${sessionProof(authority, now())}) RETURNING id`)
      if (!rows.length) throw new CalendarFeedError('conflict')
      return {
        feed: descriptor(await readRecord(id, authority)),
        username: id,
        password: secret.password,
      }
    },
    revoke: async (authority, id) => {
      await owner(authority.userId, authority)
      await readRecord(id, authority)
      const rows=await database.all(sql`UPDATE planning_calendar_feeds SET revoked_at=${now()},password_hash=NULL,credential_generation=credential_generation+1 WHERE id=${id} AND owner_user_id=${authority.userId}
        AND EXISTS(SELECT 1 FROM users u WHERE u.id=${authority.userId} AND ${sessionProof(authority, now())}) RETURNING id`)
      if(!rows.length) throw new CalendarFeedError('forbidden')
    },
    download: (authority, id) => read(id, authority),
    subscribe: (id, password) => read(id, undefined, password),
  }
}
