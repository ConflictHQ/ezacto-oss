import { sql } from 'drizzle-orm'
import { DeelStageError, paymentMonthEnd, type DeelStageAuthority } from '@ezacto/core'
import type { DeelPaymentStatusStore } from '@ezacto/integrations'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
const authorized = (authority: DeelStageAuthority | undefined, now: string) =>
  authority === undefined
    ? sql`1`
    : sql`EXISTS(
  SELECT 1 FROM users actor JOIN sessions session ON session.user_id=actor.id
  WHERE actor.id=${authority.userId} AND actor.is_active=1 AND actor.profile='administrator'
    AND session.id=${authority.sessionId} AND session.profile_snapshot='administrator' AND session.revoked_at IS NULL
    AND julianday(session.idle_expires_at)>julianday(${now}) AND julianday(session.absolute_expires_at)>julianday(${now})
    AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=actor.id))`
const inMonth = (month: string | null) =>
  month === null
    ? sql`1`
    : sql`EXISTS(
  SELECT 1 FROM time_entries entry JOIN deel_transfer_log receipt ON receipt.entry_id=entry.id
  WHERE receipt.timesheet_id=log.timesheet_id AND entry.spent_date BETWEEN ${month + '-01'} AND ${paymentMonthEnd(month)})`
const due = (now: string) =>
  sql`(cache.timesheet_id IS NULL OR (cache.last_attempt_at <= ${new Date(Date.parse(now) - 60000).toISOString()} AND (cache.last_error IS NOT NULL OR cache.status IS NULL OR cache.checked_at <= ${new Date(Date.parse(now) - 300000).toISOString()}) AND (cache.lease_until IS NULL OR cache.lease_until <= ${now})))`
export const createDeelPaymentStatusStore = (database: Database): DeelPaymentStatusStore => {
  const assertAuthority = async (authority: DeelStageAuthority | undefined, now: string) => {
    const rows = await database.all<{ allowed: number }>(
      sql`SELECT ${authorized(authority, now)} AS allowed`,
    )
    if (rows[0]?.allowed !== 1) throw new DeelStageError('forbidden')
  }
  return {
    acquireRefresh: async (now, authority) => {
      await assertAuthority(authority, now)
      const leaseId = crypto.randomUUID(), until = new Date(Date.parse(now) + 60000).toISOString()
      const claimed = await database.all<{ lease_id: string }>(sql`
        UPDATE deel_status_refresh_lock SET lease_id=${leaseId},lease_until=${until}
        WHERE id=1 AND (lease_until IS NULL OR lease_until<=${now}) AND cooldown_until<=${now}
          AND ${authorized(authority, now)} RETURNING lease_id`)
      if (claimed.length) return { leaseId, retryAfterMs: 0 }
      const rows = await database.all<{ cooldown_until: string; lease_until: string | null }>(sql`
        SELECT cooldown_until,lease_until FROM deel_status_refresh_lock WHERE id=1`)
      const row = rows[0]
      if (!row) throw new Error('Deel refresh throttle is unavailable')
      return { leaseId: null, retryAfterMs: Math.max(500, Date.parse(row.cooldown_until)-Date.parse(now), row.lease_until === null ? 0 : Date.parse(row.lease_until)-Date.parse(now)) }
    },
    touchRefresh: async (leaseId, now, authority) => {
      const rows = await database.all(sql`UPDATE deel_status_refresh_lock SET lease_until=${new Date(Date.parse(now)+60000).toISOString()}
        WHERE id=1 AND lease_id=${leaseId} AND lease_until>${now} AND cooldown_until<=${now} AND ${authorized(authority, now)} RETURNING id`)
      return rows.length === 1
    },
    releaseRefresh: async (leaseId, cooldownMs, now) => {
      const until = new Date(Date.parse(now) + Math.max(500, cooldownMs)).toISOString()
      await database.run(sql`UPDATE deel_status_refresh_lock SET
        lease_id=CASE WHEN lease_id=${leaseId} THEN NULL ELSE lease_id END,
        lease_until=CASE WHEN lease_id=${leaseId} THEN NULL ELSE lease_until END,
        cooldown_until=MAX(cooldown_until,${until}) WHERE id=1`)
    },
    releaseClaims: async (claims) => {
      for (const claim of claims) await database.run(sql`UPDATE deel_timesheet_status SET lease_id=NULL,lease_until=NULL,last_attempt_at=COALESCE(checked_at,'1970-01-01T00:00:00.000Z')
        WHERE timesheet_id=${claim.timesheetId} AND lease_id=${claim.leaseId}`)
    },
    claim: async (month, now, authority) => {
      await assertAuthority(authority, now)
      const candidates = await database.all<{ timesheet_id: string }>(sql`
        SELECT log.timesheet_id FROM deel_transfer_log log
        LEFT JOIN deel_timesheet_status cache ON cache.timesheet_id=log.timesheet_id
        WHERE ${inMonth(month)} AND ${due(now)}
        GROUP BY log.timesheet_id ORDER BY COALESCE(cache.last_attempt_at, ''), log.timesheet_id LIMIT 5`)
      const claimed = []
      for (const item of candidates) {
        const leaseId = crypto.randomUUID(),
          leaseUntil = new Date(Date.parse(now) + 60000).toISOString()
        const rows = await database.all<{ timesheet_id: string }>(sql`
          INSERT INTO deel_timesheet_status(timesheet_id,last_attempt_at,lease_id,lease_until)
          SELECT ${item.timesheet_id},${now},${leaseId},${leaseUntil} WHERE ${authorized(authority, now)}
          ON CONFLICT(timesheet_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at, lease_id=excluded.lease_id, lease_until=excluded.lease_until
          WHERE deel_timesheet_status.last_attempt_at <= ${new Date(Date.parse(now) - 60000).toISOString()}
            AND (deel_timesheet_status.last_error IS NOT NULL OR deel_timesheet_status.status IS NULL OR deel_timesheet_status.checked_at <= ${new Date(Date.parse(now) - 300000).toISOString()})
            AND (deel_timesheet_status.lease_until IS NULL OR deel_timesheet_status.lease_until <= ${now})
          RETURNING timesheet_id`)
        if (!rows.length) continue
        const logs = await database.all<{ fingerprint: string }>(
          sql`SELECT fingerprint FROM deel_transfer_log WHERE timesheet_id=${item.timesheet_id}`,
        )
        const parsed = logs.map((row) =>
          /^(.*):(\d{4}-\d{2}-\d{2}):([1-9]\d*)$/.exec(row.fingerprint),
        )
        const contractIds = [...new Set(parsed.map((match) => match?.[1] ?? ''))]
        const dates = [...new Set(parsed.map((match) => match?.[2] ?? ''))]
        const seconds = parsed.reduce((sum, match) => sum + Number(match?.[3] ?? NaN), 0)
        claimed.push({
          timesheetId: item.timesheet_id,
          contractIds,
          spentDate: dates.length === 1 ? dates[0]! : null,
          seconds,
          leaseId,
        })
      }
      return claimed
    },
    complete: async (claim, outcome, now, authority) => {
      const changes =
        'status' in outcome
          ? sql`status=${outcome.status},checked_at=${now},last_error=NULL`
          : sql`last_error=${outcome.error}`
      await database.run(sql`UPDATE deel_timesheet_status SET ${changes},lease_id=NULL,lease_until=NULL
        WHERE timesheet_id=${claim.timesheetId} AND lease_id=${claim.leaseId} AND ${authorized(authority, now)}`)
      await assertAuthority(authority, now)
    },
    remaining: async (month, now, authority) => {
      await assertAuthority(authority, now)
      const rows = await database.all<{ count: number }>(sql`
        SELECT count(DISTINCT log.timesheet_id) AS count FROM deel_transfer_log log
        LEFT JOIN deel_timesheet_status cache ON cache.timesheet_id=log.timesheet_id
        WHERE ${inMonth(month)} AND ${due(now)}`)
      return rows[0]?.count ?? 0
    },
  }
}
