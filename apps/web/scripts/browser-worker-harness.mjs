import { Buffer } from 'node:buffer'
import http from 'node:http'
import { resolve } from 'node:path'
import { URL } from 'node:url'
import { createD1PasswordAuthService } from '@ezacto/db/d1'
import { build } from 'esbuild'
import { Miniflare, NoOpLog } from 'miniflare'

const listenHost = '127.0.0.1'
const listenPort = 4173
const cursorSigningKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const fixtureControlPath = '/__ezacto_browser_fixture__/start-end'
const fixtureControlHeader = 'start-end-round-trip'
const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL
const fixtureInstant = process.env.EZACTO_BROWSER_FIXTURE_INSTANT
const fixtureTimeZone = process.env.EZACTO_BROWSER_FIXTURE_TIME_ZONE

if (
  fixtureEmail === undefined ||
  process.env.EZACTO_BROWSER_FIXTURE_PASSWORD === undefined ||
  fixtureInstant === undefined ||
  fixtureTimeZone === undefined
) {
  throw new Error('browser fixture credentials are unavailable')
}

const fixtureDate = new Date(fixtureInstant)
if (
  !Number.isFinite(fixtureDate.valueOf()) ||
  fixtureDate.toISOString() !== fixtureInstant
) {
  throw new Error('browser fixture instant must be canonical UTC')
}

const localDateAt = (instant, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(instant)
  const part = (type) => parts.find((value) => value.type === type)?.value
  const year = part('year')
  const month = part('month')
  const day = part('day')
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error('browser fixture local date is unavailable')
  }
  return `${year}-${month}-${day}`
}

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const bundle = await build({
  entryPoints: [resolve(repositoryRoot, 'entries/worker/src/index.ts')],
  bundle: true,
  conditions: ['development'],
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
})

const miniflare = new Miniflare({
  bindings: {
    API_CURSOR_SIGNING_KEY: cursorSigningKey,
    ENVIRONMENT: 'test',
    RELEASE: 'browser-cookie-e2e',
  },
  compatibilityDate: '2026-08-06',
  d1Databases: ['DB'],
  r2Buckets: ['ATTACHMENTS'],
  host: listenHost,
  log: new NoOpLog(),
  modules: true,
  port: 0,
  script: bundle.outputFiles[0].text,
})

// https, because the Worker now refuses cleartext on a real hostname (#548) and
// this probe is the one request the harness makes under its own name rather
// than through the loopback proxy below. Answering a 301 here would send the
// probe at DNS for a host that does not exist.
const migrationProbe = await miniflare.dispatchFetch(
  'https://worker.test/api/v1/whoami',
)
if (migrationProbe.status !== 401) {
  throw new Error('browser fixture migration probe did not fail closed')
}

const database = await miniflare.getD1Database('DB')
const passwordAuth = createD1PasswordAuthService(database, {
  now: () => fixtureInstant,
})
const seedPasswordUser = async () => {
  const password = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD
  if (password === undefined) {
    throw new Error('browser fixture password is unavailable')
  }
  const delivery = await passwordAuth.signup({
    organizationName: 'Browser Acceptance Organization',
    firstName: 'Browser',
    lastName: 'Owner',
    email: fixtureEmail,
    password,
    clientKey: 'browser-fixture-seed',
  })
  await passwordAuth.verifyEmail(delivery.token, 'browser-fixture-seed')
}
await seedPasswordUser()
await database
  .prepare(
    `UPDATE organizations
     SET modules = json_set(modules, '$.approval', json('true'))
     WHERE id = 1`,
  )
  .run()

// Leave the generated password and one-time verification token in memory only
// for the minimum setup window. Neither value is written to the D1 fixture in
// plaintext, a URL, console output, Playwright trace, or browser storage.
delete process.env.EZACTO_BROWSER_FIXTURE_PASSWORD

const timestamp = fixtureInstant
const spentDate = localDateAt(fixtureDate, fixtureTimeZone)
// The team summary reads one week, Monday to Sunday, around the fixture's own
// day -- the same range `teamWeekRange` derives in the browser from the
// organization's `week_start_day`, which is `monday` by default and is left at
// the default here. The roster seed asserts its totals over exactly this range,
// so the range has to be computed rather than written down: move the fixture
// instant and a hardcoded week would silently start measuring an empty week.
const rosterWeek = (() => {
  const day = new Date(`${spentDate}T00:00:00.000Z`)
  const mondayOffset = (day.getUTCDay() + 6) % 7
  const from = new Date(day.valueOf() - mondayOffset * 86_400_000)
  const to = new Date(from.valueOf() + 6 * 86_400_000)
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  }
})()

const run = async (statement, ...bindings) => {
  await database.prepare(statement).bind(...bindings).run()
}

const rows = async (statement, ...bindings) =>
  (await database.prepare(statement).bind(...bindings).all()).results

const teamRateState = async () => ({
  organization: await rows('SELECT modules FROM organizations WHERE id = 1'),
  user: await rows(
    `SELECT version, team_write_token, updated_at FROM users WHERE id = 1`,
  ),
  preferences: await rows(
    `SELECT * FROM notification_preferences WHERE user_id = 1`,
  ),
  assignments: await rows(
    `SELECT id, project_id, user_id, is_active, is_project_manager,
       use_default_rates, hourly_rate_cents, budget_seconds,
       time_entry_notes_minimum_length, created_at, updated_at
     FROM user_assignments WHERE user_id = 1 ORDER BY id`,
  ),
  billableRates: await rows(
    `SELECT * FROM user_billable_rates WHERE user_id = 1 ORDER BY id`,
  ),
  costRates: await rows(
    `SELECT * FROM user_cost_rates WHERE user_id = 1 ORDER BY id`,
  ),
  receipts: await rows(
    `SELECT * FROM team_command_ledger WHERE target_user_id = 1
     ORDER BY command_kind, command_id`,
  ),
})

const rateDeleteTrigger = (table) => `CREATE TRIGGER ${table}_append_only_delete
  BEFORE DELETE ON ${table}
  BEGIN SELECT RAISE(ABORT, 'rates are append-only'); END`
const receiptDeleteTrigger = `CREATE TRIGGER team_command_ledger_reject_delete
  BEFORE DELETE ON team_command_ledger
  BEGIN SELECT RAISE(ABORT, 'team command receipts are append-only'); END`

const clearTeamRateRows = async () => {
  for (const table of ['user_billable_rates', 'user_cost_rates']) {
    await run(`DROP TRIGGER ${table}_append_only_delete`)
    try {
      await run(`DELETE FROM ${table} WHERE user_id = 1`)
    } finally {
      await run(rateDeleteTrigger(table))
    }
  }
  await run('DROP TRIGGER team_command_ledger_reject_delete')
  try {
    await run('DELETE FROM team_command_ledger WHERE target_user_id = 1')
  } finally {
    await run(receiptDeleteTrigger)
  }
}

const insertRows = async (table, values) => {
  for (const value of values) {
    const columns = Object.keys(value)
    await database
      .prepare(
        `INSERT INTO ${table} (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
      )
      .bind(...columns.map((column) => value[column]))
      .run()
  }
}

const restoreRows = async (table, conflictColumn, values) => {
  for (const value of values) {
    const columns = Object.keys(value)
    const mutable = columns.filter((column) => column !== conflictColumn)
    await database
      .prepare(
        `INSERT INTO ${table} (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})
         ON CONFLICT(${conflictColumn}) DO UPDATE SET
           ${mutable.map((column) => `${column} = excluded.${column}`).join(', ')}`,
      )
      .bind(...columns.map((column) => value[column]))
      .run()
  }
}

const insertRateRows = async (table, values) => {
  for (const value of values) {
    const insertable = Object.fromEntries(
      Object.entries(value).filter(([column]) => column !== 'end_date'),
    )
    await insertRows(table, [insertable])
  }
}

let activeTeamRateBaseline = null
let restoredTeamRateBaseline = null

const restoreTeamRateState = async () => {
  if (activeTeamRateBaseline === null) throw new Error('team rate fixture was not seeded')
  const baseline = activeTeamRateBaseline
  await clearTeamRateRows()
  await insertRateRows('user_billable_rates', baseline.billableRates)
  await insertRateRows('user_cost_rates', baseline.costRates)
  await insertRows('team_command_ledger', baseline.receipts)

  const assignmentIds = baseline.assignments.map(({ id }) => Number(id))
  await run(
    assignmentIds.length === 0
      ? 'DELETE FROM user_assignments WHERE user_id = 1'
      : `DELETE FROM user_assignments WHERE user_id = 1
         AND id NOT IN (${assignmentIds.join(', ')})`,
  )
  await restoreRows('user_assignments', 'id', baseline.assignments)
  const preference = baseline.preferences[0]
  if (preference !== undefined) {
    await restoreRows('notification_preferences', 'user_id', [preference])
  } else {
    await run('DELETE FROM notification_preferences WHERE user_id = 1')
  }
  const user = baseline.user[0]
  const organization = baseline.organization[0]
  if (user === undefined || organization === undefined) {
    throw new Error('team rate baseline is incomplete')
  }
  await database.batch([
    database
      .prepare(
        `UPDATE users SET version = ?, team_write_token = ?, updated_at = ? WHERE id = 1`,
      )
      .bind(user.version, user.team_write_token, user.updated_at),
    database
      .prepare('UPDATE organizations SET modules = ? WHERE id = 1')
      .bind(organization.modules),
  ])
  const restored = await teamRateState()
  if (JSON.stringify(restored) !== JSON.stringify(baseline)) {
    throw new Error('team rate fixture did not restore its exact baseline')
  }
  restoredTeamRateBaseline = baseline
  activeTeamRateBaseline = null
}

const fixtureControl = async (request, response) => {
  if (
    request.method !== 'POST' ||
    request.headers['x-ezacto-browser-fixture-control'] !== fixtureControlHeader
  ) {
    response.statusCode = 404
    response.end()
    return
  }
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > 1_024) {
      response.statusCode = 413
      response.end()
      return
    }
    chunks.push(chunk)
  }
  let action
  try {
    action = JSON.parse(Buffer.concat(chunks).toString('utf8')).action
  } catch {
    response.statusCode = 400
    response.end()
    return
  }
  if (action === 'seed') {
    await database.batch([
      database.prepare(
        `UPDATE organizations
         SET time_entry_mode = 'start_end', time_format = 'hours_minutes', clock = '12h'
         WHERE id = 1`,
      ),
      database.prepare('DELETE FROM time_entries WHERE id = 900'),
      database
        .prepare(
          `INSERT INTO time_entries (
             id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
             spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
             billable_rate_cents, cost_rate_cents, started_time, ended_time, notes,
             created_at, updated_at
           ) VALUES (
             900, 1, 1, 1, 1, 1, '2026-08-29', 30600, 30600, 30600, 1,
             10000, 5000, '09:05', '17:35', 'Real D1 start/end entry', ?, ?
           )`,
        )
        .bind(timestamp, timestamp),
    ])
  } else if (action === 'reset') {
    await database.batch([
      database.prepare('DELETE FROM time_entries WHERE id = 900'),
      database.prepare(
        `UPDATE organizations
         SET time_entry_mode = 'duration', time_format = 'decimal', clock = '12h'
         WHERE id = 1`,
      ),
    ])
  } else if (action === 'approval-seed') {
    await database.batch([
      database.prepare('DELETE FROM time_entries WHERE id = 901'),
      database.prepare('DELETE FROM expenses WHERE id = 901'),
      database.prepare(
        `UPDATE organizations
         SET time_entry_mode = 'duration', time_format = 'decimal', clock = '12h',
             week_start_day = 'sunday',
             modules = json_set(modules, '$.approval', json('true'))
         WHERE id = 1`,
      ),
      database
        .prepare(
          `INSERT INTO time_entries (
             id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
             spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
             billable_rate_cents, cost_rate_cents, notes, created_at, updated_at
           ) VALUES (
             901, 1, 1, 1, 1, 1, '2026-08-19', 3600, 3600, 3600, 1,
             10000, 5000, 'Ready for review', ?, ?
           )`,
        )
        .bind(timestamp, timestamp),
      database
        .prepare(
          `INSERT INTO expenses (
             id, user_id, project_id, expense_category_id, spent_date, notes,
             total_cost_cents, billable, created_at, updated_at
           ) VALUES (
             901, 1, 1, 1, '2026-08-19', 'Receipt ready for review',
             1250, 1, ?, ?
           )`,
        )
        .bind(timestamp, timestamp),
    ])
  } else if (action === 'approval-expense-only-seed') {
    await database.batch([
      database.prepare(
        `DELETE FROM time_entries
         WHERE user_id = 1 AND spent_date BETWEEN '2026-08-09' AND '2026-08-15'`,
      ),
      database.prepare('DELETE FROM expenses WHERE id = 902'),
      database.prepare(
        `UPDATE organizations
         SET time_entry_mode = 'duration', time_format = 'decimal', clock = '12h',
             week_start_day = 'sunday',
             modules = json_set(modules, '$.approval', json('true'))
         WHERE id = 1`,
      ),
      database
        .prepare(
          `INSERT INTO expenses (
             id, user_id, project_id, expense_category_id, spent_date, notes,
             total_cost_cents, billable, created_at, updated_at
           ) VALUES (
             902, 1, 1, 1, '2026-08-12', 'Expense-only receipt',
             875, 1, ?, ?
           )`,
        )
        .bind(timestamp, timestamp),
    ])
  } else if (action === 'invoice-payment-seed') {
    await database.batch([
      database.prepare('DELETE FROM time_entries WHERE id = 903'),
      database
        .prepare(
          `INSERT INTO time_entries (
             id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
             spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
             billable_rate_cents, cost_rate_cents, notes, created_at, updated_at
           ) VALUES (
             903, 1, 1, 1, 1, 1, '2026-08-15', 2700, 2700, 2700, 1,
             10000, 5000, 'Invoice payment acceptance', ?, ?
           )`,
        )
        .bind(timestamp, timestamp),
    ])
  } else if (action === 'team-rate-seed') {
    if (activeTeamRateBaseline !== null) {
      throw new Error('team rate fixture already has an active baseline')
    }
    activeTeamRateBaseline = await teamRateState()
    restoredTeamRateBaseline = null
    await clearTeamRateRows()
    await database.batch([
      database.prepare(
        `UPDATE organizations
         SET modules = json_set(modules, '$.team', json('true'))
         WHERE id = 1`,
      ),
      database.prepare(
        `UPDATE users SET version = 0, team_write_token = NULL, updated_at = ? WHERE id = 1`,
      ).bind(timestamp),
      database.prepare(
        `UPDATE notification_preferences SET
           daily_reminder_enabled = 0, reminder_time = NULL, reminder_days = '[]',
           email_enabled = 0, desktop_enabled = 0, slack_enabled = 0,
           include_in_team_reminders = 0, weekly_digest = 0,
           notify_project_deleted = 0, updated_at = ?
         WHERE user_id = 1`,
      ).bind(timestamp),
      database.prepare(
        `INSERT INTO user_billable_rates (
           id, user_id, amount_cents, start_date, end_date, created_at, updated_at
         ) VALUES (950, 1, 10000, '2026-08-01', NULL, ?, ?)`,
      ).bind(timestamp, timestamp),
    ])
  } else if (action === 'team-rate-reset') {
    await restoreTeamRateState()
  } else if (action === 'team-rate-assert-clean') {
    if (restoredTeamRateBaseline === null) {
      throw new Error('team rate fixture has no restored baseline')
    }
    const current = await teamRateState()
    if (JSON.stringify(current) !== JSON.stringify(restoredTeamRateBaseline)) {
      throw new Error('team rate fixture baseline changed after restoration')
    }
  } else if (action === 'project-directory-cleanup') {
    await database.batch([
      database
        .prepare(
          `UPDATE task_assignments
           SET is_active = 0, updated_at = ?
           WHERE project_id IN (
             SELECT id FROM projects WHERE name = 'Browser UI Project'
           )`,
        )
        .bind(timestamp),
      database
        .prepare(
          `UPDATE user_assignments
           SET is_active = 0, updated_at = ?
           WHERE project_id IN (
             SELECT id FROM projects WHERE name = 'Browser UI Project'
           )`,
        )
        .bind(timestamp),
      database
        .prepare(
          `UPDATE projects
           SET is_active = 0, updated_at = ?
           WHERE name = 'Browser UI Project'`,
        )
        .bind(timestamp),
      database.prepare(`DELETE FROM auth_rate_limits WHERE action = 'sign_in'`),
    ])
    const remaining = await database
      .prepare(
        `SELECT count(*) AS count
         FROM projects
         WHERE name = 'Browser UI Project' AND is_active = 1`,
      )
      .first()
    if (remaining?.count !== 0) {
      throw new Error('project directory fixture cleanup left active work behind')
    }
  } else if (action === 'invoice-generation-seed') {
    await database.batch([
      database.prepare(
        `DELETE FROM time_entries
         WHERE invoice_id IS NULL
           AND (
             id IN (1, 2)
             OR notes IN (
               'Browser invoice generation fixture 1',
               'Browser invoice generation fixture 2'
             )
           )`,
      ),
      database
        .prepare(
          `INSERT INTO time_entries (
             id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
             spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
             billable_rate_cents, cost_rate_cents, budgeted, notes, created_at, updated_at
           ) VALUES (
             (SELECT coalesce(max(id), 0) + 1 FROM time_entries),
             1, 1, 1, 1, 1, ?, 1800, 1800, 1800, 1, 10000, 5000,
             1, 'Browser invoice generation fixture 1', ?, ?
           )`,
        )
        .bind(spentDate, timestamp, timestamp),
      database
        .prepare(
          `INSERT INTO time_entries (
             id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
             spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
             billable_rate_cents, cost_rate_cents, budgeted, notes, created_at, updated_at
           ) VALUES (
             (SELECT coalesce(max(id), 0) + 1 FROM time_entries),
             1, 1, 1, 1, 1, ?, 900, 900, 900, 1, 10000, 5000,
             1, 'Browser invoice generation fixture 2', ?, ?
           )`,
        )
        .bind(spentDate, timestamp, timestamp),
      database.prepare(`DELETE FROM auth_rate_limits WHERE action = 'sign_in'`),
    ])
    const seeded = await database
      .prepare(
        `SELECT count(*) AS count, sum(rounded_seconds) AS seconds
         FROM time_entries
         WHERE invoice_id IS NULL
           AND notes IN (
             'Browser invoice generation fixture 1',
             'Browser invoice generation fixture 2'
           )`,
      )
      .first()
    if (seeded?.count !== 2 || seeded.seconds !== 2700) {
      throw new Error('invoice generation fixture did not own one exact work set')
    }
  } else if (action === 'invoice-generation-cleanup') {
    await database.batch([
      database.prepare(
        `DELETE FROM time_entries
         WHERE invoice_id IS NULL
           AND notes IN (
             'Browser invoice generation fixture 1',
             'Browser invoice generation fixture 2'
           )`,
      ),
      database.prepare(`DELETE FROM auth_rate_limits WHERE action = 'sign_in'`),
    ])
  } else if (action === 'invoice-line-seed') {
    await database.batch([
      database.prepare('DELETE FROM time_entries WHERE id = 904'),
      database
        .prepare(
          `INSERT INTO time_entries (
             id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
             spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
             billable_rate_cents, cost_rate_cents, notes, created_at, updated_at
           ) VALUES (
             904, 1, 1, 1, 1, 1, '2026-08-14', 2700, 2700, 2700, 1,
             10000, 5000, 'Invoice line acceptance', ?, ?
           )`,
        )
        .bind(timestamp, timestamp),
    ])
  } else if (action === 'team-summary-seed') {
    /**
     * A roster, not a lone owner.
     *
     * The team summary strip is only worth asserting against when its numbers
     * are the size real numbers are. With the signed-in owner as the only
     * person it reads `1`, `35h`, `0.75h`, `0.75h`, `0h`, `2.1%` -- figures two
     * to five characters wide, which fit any track at any width. That is what
     * made the collision guard #515 wanted vacuous, and note the mechanism is
     * not a hidden strip: the strip renders, so a count assertion passes too.
     * Only the width of the figures was ever the problem.
     *
     * These eight people restore the shape the demo instance had when the
     * overlap was reported, to the digit: 9 people, 315h capacity, 328.25h
     * tracked, 284.5h billable, 43.75h non-billable, 104.2% utilization.
     * `328.25h` is the seven-character figure that overran its 140px track.
     *
     * Seeded per spec rather than into the base fixture, which is the second
     * thing #515 could not have known: 284.5h of billable time on the
     * acceptance project is 284.5h the invoice wizard will sweep, and a roster
     * in the base fixture turns `[e2e:invoice-cycle]`'s `$75.00` draft into
     * `$28,450.00` -- measured, not guessed. `invoice-generation-seed` already
     * owns this shape, so this follows it.
     *
     * Ids sit above 9000 so nothing an earlier spec creates through the API can
     * collide with them, and the cleanup below is keyed on the same range.
     */
    const rosterTargets = {
      // 315h, 328.25h, 284.5h, 43.75h -- the strip's own figures, in seconds.
      capacity: 1_134_000,
      tracked: 1_181_700,
      billable: 1_024_200,
      nonBillable: 157_500,
    }
    const roster = [
      { id: 9001, firstName: 'Ana', lastName: 'Solano', contractor: 0, billable: 38.5, nonBillable: 0 },
      { id: 9002, firstName: 'Diego', lastName: 'Vargas', contractor: 0, billable: 40, nonBillable: 2.5 },
      { id: 9003, firstName: 'Marta', lastName: 'Quesada', contractor: 0, billable: 36.25, nonBillable: 4 },
      { id: 9004, firstName: 'Luis', lastName: 'Herrera', contractor: 0, billable: 41, nonBillable: 1.5 },
      { id: 9005, firstName: 'Paula', lastName: 'Mora', contractor: 0, billable: 33.5, nonBillable: 6.25 },
      { id: 9006, firstName: 'Tomas', lastName: 'Alfaro', contractor: 1, billable: 39.75, nonBillable: 3 },
      { id: 9007, firstName: 'Nadia', lastName: 'Rojas', contractor: 1, billable: 30, nonBillable: 12.5 },
    ]

    /**
     * One person absorbs whatever the run already left in this week.
     *
     * The owner's own time is not a constant by the time this spec runs. The
     * invoice wizard takes an entry out of `invoice-generation-cleanup`'s reach
     * by stamping `invoice_id` on it, so the week carries 0.75h on one ordering
     * and 1h on another -- measured: the first version of this seed asserted
     * `1181700` and got `1182600` in a full-suite run and `1181700` alone.
     *
     * Rounding the assertion to a band was the alternative and was rejected:
     * the whole point of the roster is that `328.25h` is seven characters wide,
     * and a band lets it drift to a width that cannot collide -- the vacuous
     * test again, one step removed. So the eight person's hours are the target
     * minus what is already there, the totals stay exact, and the assertion
     * below stays an equality.
     */
    const existing = await database
      .prepare(
        `SELECT
           coalesce(sum(CASE WHEN billable = 1 THEN rounded_seconds ELSE 0 END), 0) AS billable,
           coalesce(sum(CASE WHEN billable = 0 THEN rounded_seconds ELSE 0 END), 0) AS nonBillable
         FROM time_entries WHERE spent_date BETWEEN ? AND ?`,
      )
      .bind(rosterWeek.from, rosterWeek.to)
      .first()
    const plannedBillable = roster.reduce((total, person) => total + person.billable, 0) * 3_600
    const plannedNonBillable =
      roster.reduce((total, person) => total + person.nonBillable, 0) * 3_600
    const absorbed = {
      billable: rosterTargets.billable - existing.billable - plannedBillable,
      nonBillable: rosterTargets.nonBillable - existing.nonBillable - plannedNonBillable,
    }
    // Forty hours is the widest slack one person can carry and still look like
    // a week. Past that the acceptance run has left something this seed does
    // not understand, and saying so beats seeding a roster that quietly reads
    // wrong.
    if (
      absorbed.billable <= 0 ||
      absorbed.nonBillable <= 0 ||
      absorbed.billable > 144_000 ||
      absorbed.nonBillable > 144_000
    ) {
      throw new Error(
        `team summary roster cannot absorb the week already seeded: ${JSON.stringify({
          existing,
          absorbed,
        })}`,
      )
    }
    roster.push({
      id: 9008,
      firstName: 'Oscar',
      lastName: 'Brenes',
      contractor: 1,
      billable: absorbed.billable / 3_600,
      nonBillable: absorbed.nonBillable / 3_600,
    })

    for (const person of roster) {
      await run(
        `INSERT INTO users (
           id, first_name, last_name, timezone, is_contractor, is_active,
           weekly_capacity, profile, manager_grants, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, 126000, 'member', '[]', ?, ?)`,
        person.id,
        person.firstName,
        person.lastName,
        fixtureTimeZone,
        person.contractor,
        timestamp,
        timestamp,
      )
      await run(
        `INSERT INTO user_emails (
           id, user_id, address, verified_at, is_primary, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
        person.id,
        person.id,
        `${person.firstName.toLowerCase()}.${person.lastName.toLowerCase()}@example.test`,
        timestamp,
        timestamp,
        timestamp,
      )
      await run(
        `INSERT INTO user_assignments (
           id, project_id, user_id, created_at, updated_at
         ) VALUES (?, 1, ?, ?, ?)`,
        person.id,
        person.id,
        timestamp,
        timestamp,
      )
      // The task assignment carries a billable default; the entry carries the
      // fact. Splitting the week on the entry rather than adding a second task
      // assignment keeps the project's own catalog exactly as the other
      // acceptance specs already found it.
      for (const [kind, hours, billable] of [
        ['billable', person.billable, 1],
        ['internal', person.nonBillable, 0],
      ]) {
        if (hours === 0) continue
        await run(
          `INSERT INTO time_entries (
             id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
             spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
             billable_rate_cents, cost_rate_cents, budgeted, notes, created_at, updated_at
           ) VALUES (?, ?, 1, 1, ?, 1, ?, ?, ?, ?, ?, 10000, 5000, 1, ?, ?, ?)`,
          person.id * 10 + billable,
          person.id,
          person.id,
          spentDate,
          hours * 3_600,
          hours * 3_600,
          hours * 3_600,
          billable,
          `Team summary roster ${kind} week`,
          timestamp,
          timestamp,
        )
      }
    }
    await run(`DELETE FROM auth_rate_limits WHERE action = 'sign_in'`)
    // The strip's six figures are what the regression guard measures, so the
    // seed asserts the totals behind them. Anything this seed did not account
    // for fails here, loudly, rather than shifting `328.25h` to a width that
    // cannot collide and quietly turning the guard back into the vacuous test
    // it exists to replace.
    const totals = await database
      .prepare(
        `SELECT
           (SELECT count(*) FROM users WHERE is_active = 1) AS people,
           (SELECT sum(weekly_capacity) FROM users WHERE is_active = 1) AS capacity,
           coalesce(sum(rounded_seconds), 0) AS tracked,
           coalesce(sum(CASE WHEN billable = 1 THEN rounded_seconds ELSE 0 END), 0) AS billable
         FROM time_entries WHERE spent_date BETWEEN ? AND ?`,
      )
      .bind(rosterWeek.from, rosterWeek.to)
      .first()
    if (
      totals?.people !== 9 ||
      totals.capacity !== rosterTargets.capacity ||
      totals.tracked !== rosterTargets.tracked ||
      totals.billable !== rosterTargets.billable
    ) {
      throw new Error(
        `team summary roster totals drifted: ${JSON.stringify(totals)}`,
      )
    }
  } else if (action === 'team-summary-cleanup') {
    await database.batch([
      database.prepare('DELETE FROM time_entries WHERE user_id >= 9000'),
      database.prepare('DELETE FROM user_assignments WHERE user_id >= 9000'),
      database.prepare('DELETE FROM user_emails WHERE user_id >= 9000'),
      database.prepare('DELETE FROM users WHERE id >= 9000'),
      database.prepare(`DELETE FROM auth_rate_limits WHERE action = 'sign_in'`),
    ])
  } else if (action === 'task-admin-cleanup') {
    await database.batch([
      database.prepare(
        `DELETE FROM task_assignments
         WHERE task_id IN (SELECT id FROM tasks WHERE name = 'Browser Default Task Updated')
            OR project_id IN (SELECT id FROM projects WHERE name LIKE 'Task admin default project %')`,
      ),
      database.prepare(
        `DELETE FROM user_assignments
         WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'Task admin default project %')`,
      ),
      database.prepare(
        `DELETE FROM projects WHERE name LIKE 'Task admin default project %'`,
      ),
      database.prepare(
        `DELETE FROM tasks WHERE name = 'Browser Default Task Updated'`,
      ),
      database.prepare(`DELETE FROM auth_rate_limits WHERE action = 'sign_in'`),
    ])
  } else {
    response.statusCode = 400
    response.end()
    return
  }
  response.statusCode = 204
  response.setHeader('cache-control', 'no-store')
  response.end()
}

await run(
  `INSERT INTO clients (id, name, currency, created_at, updated_at)
   VALUES (1, 'Browser Acceptance Client', 'USD', ?, ?)`,
  timestamp,
  timestamp,
)
await run(
  `INSERT INTO projects (
     id, client_id, name, code, hourly_rate_cents,
     budget_by, budget_seconds, time_entry_notes_minimum_length, created_at, updated_at
   ) VALUES
     (1, 1, 'Browser Acceptance Project', 'BROWSER', 10000, 'project', 14400, NULL, ?, ?),
     (2, 1, 'Browser Secondary Project', 'SECONDARY', 12500, 'none', NULL, 8, ?, ?)`,
  timestamp,
  timestamp,
  timestamp,
  timestamp,
)
await run(
  `INSERT INTO tasks (id, name, created_at, updated_at)
   VALUES
     (1, 'Browser Acceptance Task', ?, ?),
     (2, 'Browser Secondary Task', ?, ?)`,
  timestamp,
  timestamp,
  timestamp,
  timestamp,
)
await run(
  `INSERT INTO expense_categories (
     id, name, unit_name, unit_price_cents, created_at, updated_at
   ) VALUES
     (1, 'Travel', NULL, NULL, ?, ?),
     (2, 'Mileage', 'mile', 67, ?, ?)`,
  timestamp,
  timestamp,
  timestamp,
  timestamp,
)
await run(
  `INSERT INTO user_assignments (
     id, project_id, user_id, created_at, updated_at
   ) VALUES
     (1, 1, 1, ?, ?),
     (2, 2, 1, ?, ?)`,
  timestamp,
  timestamp,
  timestamp,
  timestamp,
)
await run(
  `INSERT INTO task_assignments (
     id, project_id, task_id, billable, created_at, updated_at
   ) VALUES
     (1, 1, 1, 1, ?, ?),
     (2, 2, 2, 1, ?, ?)`,
  timestamp,
  timestamp,
  timestamp,
  timestamp,
)
await run(
  `INSERT INTO time_entries (
     id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
     spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
     billable_rate_cents, cost_rate_cents, budgeted, notes, created_at, updated_at
   ) VALUES
     (
       1, 1, 1, 1, 1, 1, ?, 1800, 1800, 1800, 1, 10000, 5000,
       1, 'First line\nSecond line with delivery detail', ?, ?
     ),
     (
       2, 1, 1, 1, 1, 1, ?, 900, 900, 900, 1, 10000, 5000,
       1, 'Separate follow-up', ?, ?
     )`,
  spentDate,
  timestamp,
  timestamp,
  spentDate,
  timestamp,
  timestamp,
)

const proxyFetch = async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${listenHost}:${listenPort}`)
  if (url.pathname === fixtureControlPath) {
    await fixtureControl(request, response)
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks)
  const upstream = await miniflare.dispatchFetch(url, {
    method: request.method,
    headers: request.headers,
    ...(body === undefined ? {} : { body }),
    redirect: 'manual',
  })

  response.statusCode = upstream.status
  const setCookies =
    typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : [upstream.headers.get('set-cookie')].filter((value) => value !== null)
  upstream.headers.forEach((value, name) => {
    if (name !== 'set-cookie') response.setHeader(name, value)
  })
  if (setCookies.length > 0) response.setHeader('set-cookie', setCookies)
  response.end(Buffer.from(await upstream.arrayBuffer()))
}

const server = http.createServer((request, response) => {
  void proxyFetch(request, response).catch((error) => {
    // A fixture seed that throws used to reach the spec as a bare 500, and the
    // reason it threw stayed inside this process: diagnosing one cost a full
    // suite run. The message goes to stderr, which Playwright already pipes and
    // prefixes `[WebServer]`, rather than into the response -- the control
    // endpoint answers a browser the specs also drive, and its failures are not
    // something to hand back over HTTP.
    process.stderr.write(
      `browser fixture request failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    if (!response.headersSent) {
      response.statusCode = 500
      response.setHeader('content-type', 'text/plain; charset=utf-8')
    }
    response.end('browser fixture request failed')
  })
})

await new Promise((resolveReady, reject) => {
  server.once('error', reject)
  server.listen(listenPort, listenHost, resolveReady)
})

const shutdown = () => {
  server.close(() => void miniflare.dispose())
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
