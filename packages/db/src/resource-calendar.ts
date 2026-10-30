import {
  assertResourceCalendarQuery,
  canProfileUseApiScope,
  capacityWeeks,
  composeResourceCalendar,
  effectiveTimeZone,
  ResourceCalendarReadError,
  TrackedResourceInputError,
  resourceCalendarContext,
  type AllocationWeekStartDay,
  type ResourceCalendarRepository,
  type ResourceCalendarRows,
  type ResourceCalendarAllocationRange,
  type ResourceCalendarProjectOption,
  type TeamViewer,
} from '@ezacto/core'
import type { InvoiceStateDatabase } from './invoice-state.js'
import { teamPersonAccessPredicate, teamProjectAccessPredicate } from './team-access.js'

/** Refuse a narrower date window rather than returning silently partial totals. */
export const maximumResourceCalendarFacts = 20_000

interface CalendarSnapshot extends ResourceCalendarRows {
  actorAllowed: number
  projectAllowed: number
  personAllowed: number
  rangeAllowed: number
  timeZone: string
  feedRevision?: number
}

const peopleAccess = (viewer: Readonly<TeamViewer>) =>
  canProfileUseApiScope(viewer.profile, 'schedule:write')
    ? teamPersonAccessPredicate(viewer, 'person')
    : { sql: 'person.id=?', bindings: [viewer.userId] }

const projectAccess = (viewer: Readonly<TeamViewer>) => {
  if (viewer.profile === 'member')
    return {
      sql: 'EXISTS(SELECT 1 FROM user_assignments assignment WHERE assignment.project_id=project.id AND assignment.user_id=?)',
      bindings: [viewer.userId],
    }
  // Other read-only profiles have the same self-only identity ceiling.
  if (!canProfileUseApiScope(viewer.profile, 'schedule:write'))
    return {
      sql: 'EXISTS(SELECT 1 FROM user_assignments assignment WHERE assignment.project_id=project.id AND assignment.user_id=?)',
      bindings: [viewer.userId],
    }
  return teamProjectAccessPredicate(viewer, 'project')
}

const actorAccess = (viewer: Readonly<TeamViewer>) => ({
  sql: `EXISTS(SELECT 1 FROM users actor WHERE actor.id=? AND actor.is_active=1
    AND actor.profile=? AND json(actor.manager_grants)=json(?)
    AND NOT EXISTS(SELECT 1 FROM account_closures closed WHERE closed.user_id=actor.id))`,
  bindings: [viewer.userId, viewer.profile, JSON.stringify(viewer.managerGrants)],
})
const select = async <Row>(
  database: InvoiceStateDatabase,
  text: string,
  params: readonly unknown[],
): Promise<Row[]> => {
  const client = database.$client
  return 'batch' in client
    ? (
        await client
          .prepare(text)
          .bind(...params)
          .all<Row>()
      ).results
    : (client.prepare(text).all(...params) as Row[])
}

/**
 * One SELECT reads a coherent, bounded native snapshot on SQLite and D1. The
 * reference composer remains the only weekly aggregation algorithm. No lock
 * materialization, aggregate table, or private leave field is involved.
 */
export const createResourceCalendarRepository = (
  database: InvoiceStateDatabase,
  options: { captureFeedRevision?: (revision: number) => void; planningOnly?: boolean } = {},
): ResourceCalendarRepository => ({
  async projects(viewer, query) {
    const limit = query.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TrackedResourceInputError('limit', 'invalid_integer', 'must be between 1 and 100')
    if (query.cursor !== undefined && (!Number.isSafeInteger(query.cursor) || query.cursor < 1))
      throw new TrackedResourceInputError('cursor', 'invalid_integer', 'must be a positive integer')
    if (query.isActive !== undefined && typeof query.isActive !== 'boolean')
      throw new TrackedResourceInputError('is_active', 'invalid_boolean', 'must be true or false')
    const actor = actorAccess(viewer),
      project = projectAccess(viewer)
    const [snapshot] = await select<{ actor_allowed: number; rows: string }>(
      database,
      `WITH
      allowed_actor AS(SELECT 1 WHERE ${actor.sql}),
      options AS(SELECT project.id,project.name,project.is_active FROM projects project
        WHERE EXISTS(SELECT 1 FROM allowed_actor) AND (${project.sql}) AND project.id>?
          AND (? IS NULL OR project.is_active=?) ORDER BY project.id LIMIT ?)
      SELECT EXISTS(SELECT 1 FROM allowed_actor) AS actor_allowed,
        (SELECT json_group_array(json_object('id',id,'name',name,'isActive',json(CASE is_active WHEN 1 THEN 'true' ELSE 'false' END))) FROM options) AS rows`,
      [
        ...actor.bindings,
        ...project.bindings,
        query.cursor ?? 0,
        query.isActive === undefined ? null : Number(query.isActive),
        query.isActive === undefined ? null : Number(query.isActive),
        limit + 1,
      ],
    )
    if (!snapshot?.actor_allowed) throw new ResourceCalendarReadError('actor_required')
    const rows = JSON.parse(snapshot.rows) as ResourceCalendarProjectOption[]
    return {
      rows: rows.slice(0, limit),
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
    }
  },
  async allocations(viewer, query) {
    const limit = assertResourceCalendarQuery(query)
    const actor = actorAccess(viewer),
      person = peopleAccess(viewer),
      project = projectAccess(viewer)
    const [snapshot] = await select<{
      actor_allowed: number
      project_allowed: number
      person_allowed: number
      week_start_day: AllocationWeekStartDay
      range_allowed: number
      rows: string
    }>(
      database,
      `WITH
      allowed_actor AS(SELECT 1 WHERE ${actor.sql}),
      organization AS(SELECT week_start_day FROM organizations WHERE id=1),
      input AS(SELECT ? AS from_date,? AS to_date),
      raw_bounds AS(SELECT date(from_date,'-'||((CAST(strftime('%w',from_date) AS INTEGER)-
        CASE week_start_day WHEN 'saturday' THEN 6 WHEN 'sunday' THEN 0 ELSE 1 END+7)%7)||' days') AS first_day,
        date(to_date,'-'||((CAST(strftime('%w',to_date) AS INTEGER)-
        CASE week_start_day WHEN 'saturday' THEN 6 WHEN 'sunday' THEN 0 ELSE 1 END+7)%7)||' days','+6 days') AS last_day
        FROM input CROSS JOIN organization),
      bounds AS(SELECT * FROM raw_bounds WHERE first_day<=last_day AND julianday(last_day)-julianday(first_day)<371
        AND (SELECT from_date<=to_date FROM input)),
      allowed_people AS(SELECT person.id FROM users person WHERE person.is_active=1
        AND EXISTS(SELECT 1 FROM allowed_actor) AND (${person.sql})),
      allowed_projects AS(SELECT project.id,project.name FROM projects project WHERE EXISTS(SELECT 1 FROM allowed_actor) AND (${project.sql})),
      ranges AS(SELECT allocation.*,project.name AS project_name FROM allocations allocation
        JOIN projects project ON project.id=allocation.project_id CROSS JOIN bounds
        WHERE allocation.user_id IN(SELECT id FROM allowed_people) AND allocation.project_id IN(SELECT id FROM allowed_projects)
          AND project.is_active=1 AND allocation.end_date>=first_day AND allocation.start_date<=last_day
          AND allocation.id>? AND (? IS NULL OR allocation.project_id=?) AND (? IS NULL OR allocation.user_id=?)
        ORDER BY allocation.id LIMIT ?)
      SELECT EXISTS(SELECT 1 FROM allowed_actor) AS actor_allowed,week_start_day,
        (? IS NULL OR EXISTS(SELECT 1 FROM allowed_projects WHERE id=?)) AS project_allowed,
        (? IS NULL OR EXISTS(SELECT 1 FROM allowed_people WHERE id=?)) AS person_allowed,
        EXISTS(SELECT 1 FROM bounds) AS range_allowed,
        (SELECT json_group_array(json_object('id',id,'version',version,'userId',user_id,'projectId',project_id,'projectName',project_name,
          'startDate',start_date,'endDate',end_date,'plannedSecondsPerWeek',planned_seconds_per_week)) FROM ranges) AS rows FROM organization`,
      [
        ...actor.bindings,
        query.from,
        query.to,
        ...person.bindings,
        ...project.bindings,
        query.cursor ?? 0,
        query.view === 'project' ? query.projectId : null,
        query.view === 'project' ? query.projectId : null,
        query.personId ?? null,
        query.personId ?? null,
        limit + 1,
        query.projectId ?? null,
        query.projectId ?? null,
        query.personId ?? null,
        query.personId ?? null,
      ],
    )
    if (!snapshot?.actor_allowed) throw new ResourceCalendarReadError('actor_required')
    if (!snapshot.project_allowed || !snapshot.person_allowed)
      throw new ResourceCalendarReadError('not_found')
    if (!snapshot.range_allowed) capacityWeeks(query.from, query.to, snapshot.week_start_day)
    const rows = JSON.parse(snapshot.rows) as ResourceCalendarAllocationRange[]
    return {
      rows: rows.slice(0, limit),
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
    }
  },
  async context(viewer, now) {
    const params = [viewer.userId, viewer.profile, JSON.stringify(viewer.managerGrants)]
    const text = `SELECT timezone,week_start_day FROM organizations WHERE id=1
      AND EXISTS(SELECT 1 FROM users actor WHERE actor.id=? AND actor.is_active=1
        AND actor.profile=? AND json(actor.manager_grants)=json(?)
        AND NOT EXISTS(SELECT 1 FROM account_closures closed WHERE closed.user_id=actor.id))`
    const client = database.$client
    const rows =
      'batch' in client
        ? (
            await client
              .prepare(text)
              .bind(...params)
              .all<{ timezone: string; week_start_day: AllocationWeekStartDay }>()
          ).results
        : (client.prepare(text).all(...params) as {
            timezone: string
            week_start_day: AllocationWeekStartDay
          }[])
    const row = rows[0]
    if (!row) throw new ResourceCalendarReadError('actor_required')
    return resourceCalendarContext(now, effectiveTimeZone(null, row.timezone), row.week_start_day)
  },
  async read(viewer, query, now) {
    const limit = assertResourceCalendarQuery(query)
    const people = peopleAccess(viewer)
    const projects = projectAccess(viewer)
    const params: unknown[] = []
    const bind = (value: unknown) => {
      params.push(value)
      return '?'
    }
    const predicate = (value: { sql: string; bindings: readonly unknown[] }) => {
      params.push(...value.bindings)
      return value.sql
    }
    const factsLimit = maximumResourceCalendarFacts + 1
    const text = `WITH
      actor AS (
        SELECT id FROM users WHERE id=${bind(viewer.userId)} AND is_active=1
          AND profile=${bind(viewer.profile)} AND json(manager_grants)=json(${bind(JSON.stringify(viewer.managerGrants))})
          AND NOT EXISTS(SELECT 1 FROM account_closures closed WHERE closed.user_id=users.id)
      ),
      organization AS (SELECT timezone,week_start_day FROM organizations WHERE id=1),
      input AS (SELECT ${bind(query.from)} AS from_date,${bind(query.to)} AS to_date),
      raw_bounds AS (
        SELECT date(from_date,'-'||((CAST(strftime('%w',from_date) AS INTEGER)-
          CASE week_start_day WHEN 'saturday' THEN 6 WHEN 'sunday' THEN 0 ELSE 1 END+7)%7)||' days') AS first_day,
          date(to_date,'-'||((CAST(strftime('%w',to_date) AS INTEGER)-
          CASE week_start_day WHEN 'saturday' THEN 6 WHEN 'sunday' THEN 0 ELSE 1 END+7)%7)||' days','+6 days') AS last_day
        FROM input CROSS JOIN organization
      ),
      bounds AS (SELECT * FROM raw_bounds WHERE first_day<=last_day
        AND julianday(last_day)-julianday(first_day)<371
        AND (SELECT from_date<=to_date FROM input)),
      eligible_people AS (
        SELECT person.id,person.first_name,person.last_name,person.weekly_capacity
        FROM users person WHERE person.is_active=1 AND EXISTS(SELECT 1 FROM actor)
          AND (${predicate(people)})
      ),
      allowed_projects AS (
        SELECT project.id,project.name FROM projects project
        WHERE EXISTS(SELECT 1 FROM actor) AND (${predicate(projects)})
      ),
      person_page AS (
        SELECT * FROM eligible_people WHERE id>${bind(query.cursor ?? 0)}
          AND (${bind(query.personId ?? null)} IS NULL OR id=${bind(query.personId ?? null)})
        ORDER BY id LIMIT ${limit + 1}
      ),
      page_facts_people AS (SELECT id FROM person_page ORDER BY id LIMIT ${limit}),
      plan_facts AS (
        SELECT allocation.*,project.is_active AS project_active
        FROM allocations allocation JOIN projects project ON project.id=allocation.project_id CROSS JOIN bounds
        WHERE allocation.user_id IN(SELECT id FROM page_facts_people)
          AND allocation.end_date>=first_day AND allocation.start_date<=last_day AND project.is_active=1
        ORDER BY allocation.id LIMIT ${factsLimit}
      ),
      away_facts AS (
        SELECT away.user_id,away.start_date,away.end_date,away.seconds_per_day
        FROM time_off away CROSS JOIN bounds WHERE away.user_id IN(SELECT id FROM page_facts_people)
          AND away.end_date>=first_day AND away.start_date<=last_day
        ORDER BY away.id LIMIT ${factsLimit}
      ),
      holiday_facts AS (
        SELECT holiday.holiday_date AS date FROM organization_holidays holiday CROSS JOIN bounds
        WHERE holiday.holiday_date BETWEEN first_day AND last_day ORDER BY holiday.holiday_date LIMIT ${factsLimit}
      ),
      tracked_facts AS (
        SELECT entry.user_id,entry.project_id,entry.spent_date,sum(entry.rounded_seconds) AS rounded_seconds
        FROM time_entries entry CROSS JOIN bounds
        WHERE ${options.planningOnly ? '0' : '1'} AND entry.user_id IN(SELECT id FROM page_facts_people) AND entry.spent_date BETWEEN first_day AND last_day
        GROUP BY entry.user_id,entry.project_id,entry.spent_date
        ORDER BY entry.user_id,entry.project_id,entry.spent_date LIMIT ${factsLimit}
      ),
      placeholder_facts AS (
        SELECT demand.*,definition.name,project.is_active AS project_active
        FROM placeholder_allocations demand JOIN placeholders definition ON definition.id=demand.placeholder_id
        JOIN projects project ON project.id=demand.project_id CROSS JOIN bounds
        WHERE EXISTS(SELECT 1 FROM actor) AND ${canProfileUseApiScope(viewer.profile, 'schedule:write') ? '1' : '0'}
          AND ${query.cursor === undefined && query.personId === undefined ? '1' : '0'}
          AND demand.project_id IN(SELECT id FROM allowed_projects)
          AND demand.state='open' AND definition.is_active=1 AND project.is_active=1
          AND demand.end_date>=first_day AND demand.start_date<=last_day
          AND (${bind(query.view === 'project' ? query.projectId : null)} IS NULL OR demand.project_id=${bind(query.view === 'project' ? query.projectId : null)})
        ORDER BY demand.id LIMIT 101
      )
      SELECT json_object(
        ${options.captureFeedRevision ? "'feedRevision',(SELECT revision FROM planning_calendar_source WHERE singleton=1)," : ''}
        'actorAllowed',EXISTS(SELECT 1 FROM actor),
        'rangeAllowed',EXISTS(SELECT 1 FROM bounds),
        'projectAllowed',${query.projectId === undefined ? '1' : `EXISTS(SELECT 1 FROM allowed_projects WHERE id=${bind(query.projectId)})`},
        'personAllowed',${query.personId === undefined ? '1' : `EXISTS(SELECT 1 FROM eligible_people WHERE id=${bind(query.personId)})`},
        'timeZone',timezone,'weekStartDay',week_start_day,
        'hasHiddenPlaceholderDemand',json(CASE WHEN ${canProfileUseApiScope(viewer.profile, 'schedule:write') && query.cursor === undefined && query.personId === undefined && query.view === 'team' ? '1' : '0'}
          AND EXISTS(SELECT 1 FROM placeholder_allocations hidden JOIN placeholders definition ON definition.id=hidden.placeholder_id
            JOIN projects project ON project.id=hidden.project_id CROSS JOIN bounds
            WHERE hidden.state='open' AND definition.is_active=1 AND project.is_active=1
              AND hidden.end_date>=first_day AND hidden.start_date<=last_day
              AND hidden.project_id NOT IN(SELECT id FROM allowed_projects)) THEN 'true' ELSE 'false' END),
        'people',json((SELECT json_group_array(json_object('id',id,'name',trim(first_name||' '||last_name),'weeklyCapacitySeconds',weekly_capacity,'archived',json('false'))) FROM person_page)),
        'visibleProjects',json((SELECT json_group_array(json_object('id',id,'name',name)) FROM allowed_projects WHERE
          id IN(SELECT project_id FROM plan_facts UNION SELECT project_id FROM tracked_facts UNION SELECT project_id FROM placeholder_facts))),
        'allocations',json((SELECT json_group_array(json_object('id',id,'personId',user_id,'projectId',project_id,'projectArchived',json('false'),'startDate',start_date,'endDate',end_date,'plannedSecondsPerWeek',planned_seconds_per_week,'revision',version)) FROM plan_facts)),
        'placeholders',json((SELECT json_group_array(json_object('id',id,'name',name,'projectId',project_id,'projectArchived',json('false'),'startDate',start_date,'endDate',end_date,'plannedSecondsPerWeek',planned_seconds_per_week,'revision',revision)) FROM placeholder_facts)),
        'timeOff',json((SELECT json_group_array(json_object('personId',user_id,'startDate',start_date,'endDate',end_date,'secondsPerDay',seconds_per_day)) FROM away_facts)),
        'holidays',json((SELECT json_group_array(json_object('date',date)) FROM holiday_facts)),
        'tracked',json((SELECT json_group_array(json_object('personId',user_id,'projectId',project_id,'spentDate',spent_date,'roundedSeconds',rounded_seconds)) FROM tracked_facts))
      ) AS snapshot FROM organization`
    const client = database.$client
    const rows =
      'batch' in client
        ? (
            await client
              .prepare(text)
              .bind(...params)
              .all<{ snapshot: string }>()
          ).results
        : (client.prepare(text).all(...params) as { snapshot: string }[])
    const snapshot = rows[0] ? (JSON.parse(rows[0].snapshot) as CalendarSnapshot) : null
    if (!snapshot?.actorAllowed) throw new ResourceCalendarReadError('actor_required')
    if (!snapshot.projectAllowed || !snapshot.personAllowed)
      throw new ResourceCalendarReadError('not_found')
    if (!snapshot.rangeAllowed) capacityWeeks(query.from, query.to, snapshot.weekStartDay)
    if (
      [snapshot.allocations, snapshot.timeOff, snapshot.holidays, snapshot.tracked].some(
        (facts) => facts.length > maximumResourceCalendarFacts,
      )
    )
      throw new ResourceCalendarReadError('range_too_large')
    if (options.captureFeedRevision) {
      if (!Number.isSafeInteger(snapshot.feedRevision)) throw new ResourceCalendarReadError('actor_required')
      options.captureFeedRevision(snapshot.feedRevision!)
    }
    const context = resourceCalendarContext(
      now,
      effectiveTimeZone(null, snapshot.timeZone),
      snapshot.weekStartDay as AllocationWeekStartDay,
    )
    return composeResourceCalendar(context, query, snapshot)
  },
})
