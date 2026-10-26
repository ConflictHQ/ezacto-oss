import { createHash, createHmac, randomUUID } from 'node:crypto'
import { proposeMonthEndPack, executeInvoiceLifecycleCommand, createD1EmailConfigurationStore, createD1EmailLogStore } from '@ezacto/db/d1'
import { Buffer } from 'node:buffer'
import http from 'node:http'
import { resolve } from 'node:path'
import { URL } from 'node:url'
import { createD1PasswordAuthService, createD1Database, createAccountDeletionRequestRepository, createMoneyResourceRepository } from '@ezacto/db/d1'
import { build } from 'esbuild'
import { Miniflare, NoOpLog } from 'miniflare'

const listenHost = '127.0.0.1'
// 4173 unless the run says otherwise, so a suite can run beside a harness
// someone already has up on the usual port without either one stopping.
const listenPort = Number(process.env.EZACTO_BROWSER_PORT ?? 4173)
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
  throw new Error('EZACTO_BROWSER_PORT must be a TCP port')
}
const cursorSigningKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const fixtureControlPath = '/__ezacto_browser_fixture__/start-end'
const fixtureControlHeader = 'start-end-round-trip'
// Local-only signing material for the real webhook/browser acceptance.
const feedbackWebhookKey = 'fixture-mailgun-webhook-key-for-tests'
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
  entryPoints: [resolve(repositoryRoot, 'apps/web/scripts/portal-mail-fixture-entry.mjs')],
  bundle: true,
  conditions: ['development'],
  format: 'esm',
  platform: 'browser',
  // Left to workerd rather than bundled (#743): the Sentry Cloudflare SDK
  // imports node:async_hooks for per-request isolation, which the runtime
  // provides under the nodejs_als compatibility flag. esbuild at
  // platform: browser cannot resolve it and must not try.
  external: ['node:async_hooks'],
  target: 'es2022',
  write: false,
})

const deelStagingFixture = process.env.EZACTO_BROWSER_DEEL_STAGING_FIXTURE === '1'
const deelStagingPosts = []
const workerOptions = {
  ...(deelStagingFixture ? {outboundService: async request => {
    const url = new URL(request.url)
    if (url.origin !== 'https://api.letsdeel.com') throw new Error('Unexpected fixture outbound origin')
    if (request.method === 'GET' && url.pathname.endsWith('/people')) return globalThis.Response.json({data:[
      // Optional/null email values occur in real Deel directories. Keep an
      // unrelated same-name person so preview must still match actual addresses.
      {id:'unrelated',full_name:'Deel owned 50001',emails:[{value:null},{},{value:'  '}],employments:[{id:'unrelated-contract',contract_status:'in_progress'}]},
      ...[50001,50002].map(id=>({id:`p${id}`,full_name:`Deel owned ${id}`,emails:[{value:null},{},{value:`deel${id}@example.test`},{value:`DEEL${id}@EXAMPLE.TEST`}],employments:[{id:`contract${id}`,contract_status:'in_progress'}]})),
    ]})
    if (request.method === 'POST' && url.pathname.endsWith('/timesheets')) {
      const body=await request.json(); deelStagingPosts.push(body)
      return globalThis.Response.json({data:{id:`owned-timesheet-${deelStagingPosts.length}`}})
    }
    throw new Error('Unexpected fixture outbound operation')
  }} : {}),
  bindings: {
    ...(deelStagingFixture ? {DEEL_TOKEN:'local-deel-staging-fixture',DEEL_SYNC_START_DATE:'2026-08-01'} : {}),
    API_CURSOR_SIGNING_KEY: cursorSigningKey,
    WEBHOOK_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY',
    MAILGUN_WEBHOOK_SIGNING_KEY: feedbackWebhookKey,
    // Contact sign-in is opt-in, including the real queued-mail browser fixture.
    PORTAL_MAGIC_LINK_SIGNING_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ',
    ENVIRONMENT: 'test',
    RELEASE: 'browser-cookie-e2e',
  },
  compatibilityDate: '2026-08-06',
  // The Sentry SDK's per-request isolation needs AsyncLocalStorage (#743).
  compatibilityFlags: ['nodejs_als'],
  d1Databases: ['DB'],
  r2Buckets: ['ATTACHMENTS'],
  host: listenHost,
  log: new NoOpLog(),
  modules: true,
  port: 0,
  script: bundle.outputFiles[0].text,
}
const miniflare = new Miniflare(workerOptions)
let firstRunRuntime = null

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

let rateCardFixture = null
let scheduledManifestFixture = null
let calendarProposalFixture = null

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

// Reinstated verbatim from 0076 after the fixture has cleared its rows. The
// rules are narrower than the blanket refusal they replaced (#727), so a
// harness that put the old one back would leave the database describing a
// schema the migrations do not produce.
const rateDeleteTriggers = (table) => [
  `CREATE TRIGGER ${table}_delete_current_only BEFORE DELETE ON ${table}
    WHEN OLD.end_date IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'only the current rate may be removed'); END`,
  `CREATE TRIGGER ${table}_delete_unpriced_only BEFORE DELETE ON ${table}
    WHEN EXISTS (
      SELECT 1 FROM time_entries entry
      WHERE entry.user_id = OLD.user_id
        AND entry.spent_date >= coalesce(OLD.start_date, '0000-01-01')
        AND (
          entry.created_at > OLD.created_at
          OR EXISTS (
            SELECT 1 FROM time_entry_rate_reprices reprice
            WHERE reprice.time_entry_id = entry.id
              AND reprice.repriced_at > OLD.created_at
          )
        )
    )
    BEGIN SELECT RAISE(ABORT, 'a rate that has priced work cannot be removed'); END`,
  // The insert closed the rate before it, so a delete puts that one back. The
  // fixture clears whole tables, so this fires with nothing left to reopen --
  // correct either way, and dropped and restored with the rest so the schema it
  // leaves behind is the schema the migrations describe.
  `CREATE TRIGGER ${table}_reopen_previous AFTER DELETE ON ${table} BEGIN
    UPDATE ${table} SET end_date = NULL
    WHERE id = (
      SELECT id FROM ${table} WHERE user_id = OLD.user_id
      ORDER BY coalesce(start_date, '0000-01-01') DESC LIMIT 1
    );
  END`,
]
const receiptDeleteTrigger = `CREATE TRIGGER team_command_ledger_reject_delete
  BEFORE DELETE ON team_command_ledger
  BEGIN SELECT RAISE(ABORT, 'team command receipts are append-only'); END`

const clearTeamRateRows = async () => {
  for (const table of ['user_billable_rates', 'user_cost_rates']) {
    for (const trigger of [
      `${table}_delete_current_only`,
      `${table}_delete_unpriced_only`,
      `${table}_reopen_previous`,
    ]) {
      await run(`DROP TRIGGER ${trigger}`)
    }
    try {
      await run(`DELETE FROM ${table} WHERE user_id = 1`)
    } finally {
      for (const statement of rateDeleteTriggers(table)) await run(statement)
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

/**
 * Client 360's three-level fixture (issue 65): 9300 Root (USD) > 9301 Child
 * (EUR) > 9302 Grandchild (USD), every row invented and every id in 9300-9303
 * so nothing another spec counts moves. The Grandchild is worked for under
 * the Child and billed to the Root, so the two relations differ. The money, all dated inside the
 * fixture's own month so the burn window reaches it:
 *
 *   open invoices   Root USD 100.00 (overdue), Child EUR 250.00,
 *                   Grandchild USD 75.00, plus a Grandchild USD draft of
 *                   999.00 that is owed by nobody
 *   retainers       Root money 500.00 USD, Child money 300.00 EUR,
 *                   Child hours 10, Grandchild money 200.00 USD
 *   cost + expense  Root 1h at cost 40.00 + expense 25.00 USD,
 *                   Child 0.5h at cost 60.00 (organization currency, USD)
 *                   + expense 30.00 EUR, Grandchild 0.25h at cost 50.00
 *                   + expense 15.00 USD
 *
 * An invoice can only be sent, and a ledger only appended to, through their
 * commands, and neither command is a thing a fixture should fake. So the seed
 * and the clear take the triggers that insist on a pending command (and the
 * ledger's append-only delete) off for the length of one write and put back
 * the exact text the migrations wrote, whether or not the write succeeded. The
 * totals triggers stay on: an invoice's amount still comes from its line.
 */
const withoutCommandGuards = async (work, includeLedgerDelete) => {
  const guards = (
    await database
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'trigger' AND (
           sql LIKE '%requires its pending command%'
           ${includeLedgerDelete ? "OR name = 'retainer_ledger_append_only_delete'" : ''}
         )`,
      )
      .all()
  ).results
  if (guards.length === 0) throw new Error('invoice command guards are missing')
  for (const guard of guards) {
    await database.prepare(`DROP TRIGGER "${guard.name}"`).run()
  }
  try {
    await work()
  } finally {
    for (const guard of guards) await database.prepare(guard.sql).run()
  }
}

const client360Projects = [9300, 9301, 9302]
const client360Clear = () =>
  withoutCommandGuards(
    () =>
      database.batch([
        database.prepare('DELETE FROM retainer_ledger WHERE retainer_id BETWEEN 9300 AND 9303'),
        database.prepare('DELETE FROM retainers WHERE id BETWEEN 9300 AND 9303'),
        database.prepare('DELETE FROM invoices WHERE id BETWEEN 9300 AND 9303'),
        database.prepare('DELETE FROM expenses WHERE id BETWEEN 9300 AND 9302'),
        database.prepare('DELETE FROM time_entries WHERE id BETWEEN 9300 AND 9302'),
        database.prepare('DELETE FROM task_assignments WHERE id BETWEEN 9300 AND 9302'),
        database.prepare('DELETE FROM user_assignments WHERE id BETWEEN 9300 AND 9302'),
        database.prepare('DELETE FROM projects WHERE id BETWEEN 9300 AND 9302'),
        database.prepare('DELETE FROM clients WHERE id = 9302'),
        database.prepare('DELETE FROM clients WHERE id = 9301'),
        database.prepare('DELETE FROM clients WHERE id = 9300'),
        database.prepare(`DELETE FROM auth_rate_limits WHERE action = 'sign_in'`),
      ]),
    true,
  )

const client360Seed = async () => {
  await client360Clear()
  await withoutCommandGuards(() => client360Insert(), false)
}

const client360Insert = async () => {
  const at = [timestamp, timestamp]
  const statements = [
    database
      .prepare(
        `INSERT INTO clients (id, name, parent_client_id, currency, created_at, updated_at)
         VALUES (9300, 'Browser 360 Root', NULL, 'USD', ?, ?)`,
      )
      .bind(...at),
    database
      .prepare(
        `INSERT INTO clients (id, name, parent_client_id, currency, created_at, updated_at)
         VALUES (9301, 'Browser 360 Child', 9300, 'EUR', ?, ?)`,
      )
      .bind(...at),
    database
      .prepare(
        `INSERT INTO clients (
           id, name, parent_client_id, bill_to_client_id, currency, created_at, updated_at
         ) VALUES (9302, 'Browser 360 Grandchild', 9301, 9300, 'USD', ?, ?)`,
      )
      .bind(...at),
    ...client360Projects.map((id) =>
      database
        .prepare(
          `INSERT INTO projects (id, client_id, name, code, hourly_rate_cents, created_at, updated_at)
           VALUES (?, ?, ?, ?, 10000, ?, ?)`,
        )
        .bind(id, id, `Browser 360 Project ${id - 9299}`, `B360${id - 9299}`, ...at),
    ),
    ...client360Projects.map((id) =>
      database
        .prepare(
          `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?)`,
        )
        .bind(id, id, ...at),
    ),
    ...client360Projects.map((id) =>
      database
        .prepare(
          `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
           VALUES (?, ?, 1, 1, ?, ?)`,
        )
        .bind(id, id, ...at),
    ),
    ...[
      [9300, 3600, 4000],
      [9301, 1800, 6000],
      [9302, 900, 5000],
    ].map(([id, seconds, cost]) =>
      database
        .prepare(
          `INSERT INTO time_entries (
             id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
             spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
             billable_rate_cents, cost_rate_cents, notes, created_at, updated_at
           ) VALUES (?, 1, ?, 1, ?, ?, ?, ?, ?, ?, 1, 10000, ?, 'Browser 360 fixture', ?, ?)`,
        )
        .bind(id, id, id, id, spentDate, seconds, seconds, seconds, cost, ...at),
    ),
    ...[
      [9300, 2500],
      [9301, 3000],
      [9302, 1500],
    ].map(([id, cents]) =>
      database
        .prepare(
          `INSERT INTO expenses (
             id, user_id, project_id, expense_category_id, spent_date,
             total_cost_cents, billable, created_at, updated_at
           ) VALUES (?, 1, ?, 1, ?, ?, 1, ?, ?)`,
        )
        .bind(id, id, spentDate, cents, ...at),
    ),
    ...[
      [9300, 9300, 'USD', 'open', '2026-08-01', 10000],
      [9301, 9301, 'EUR', 'open', '2026-09-30', 25000],
      [9302, 9302, 'USD', 'open', '2026-09-30', 7500],
      [9303, 9302, 'USD', 'draft', '2026-09-30', 99900],
    ].flatMap(([id, clientId, currency, state, dueDate, cents]) => [
      database
        .prepare(
          `INSERT INTO invoices (
             id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, '2026-07-15', ?, ?, ?, ?)`,
        )
        .bind(id, clientId, `B360-${id - 9299}`, currency, dueDate, state, ...at),
      database
        .prepare(
          `INSERT INTO invoice_line_items (
             invoice_id, position, kind, description, quantity, unit_price_cents,
             amount_cents, created_at, updated_at
           ) VALUES (?, 1, 'Service', 'Browser 360 fixture', 1, ?, ?, ?, ?)`,
        )
        .bind(id, cents, cents, ...at),
    ]),
    ...[
      [9300, 9300, 'money', 'cents', 50000],
      [9301, 9301, 'money', 'cents', 30000],
      [9302, 9301, 'hours', 'seconds', 36000],
      [9303, 9302, 'money', 'cents', 20000],
    ].flatMap(([id, clientId, denomination, unit, amount]) => [
      database
        .prepare(
          `INSERT INTO retainers (
             id, client_id, denomination, amount_cents, seconds, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          clientId,
          denomination,
          denomination === 'money' ? amount : null,
          denomination === 'hours' ? amount : null,
          ...at,
        ),
      database
        .prepare(
          `INSERT INTO retainer_ledger (
             id, retainer_id, kind, unit, amount, occurred_on, notes, created_at
           ) VALUES (?, ?, 'adjustment', ?, ?, '2026-08-01', 'Browser 360 opening balance', ?)`,
        )
        .bind(`browser-360-${id}`, id, unit, amount, timestamp),
    ]),
  ]
  await database.batch(statements)
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
  let payload
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    action = payload.action
  } catch {
    response.statusCode = 400
    response.end()
    return
  }
  if (action === 'deel-stage-seed' && deelStagingFixture) {
    const week = (await database.prepare('SELECT week_start_day FROM organizations WHERE id=1').first()).week_start_day
    const weekFrom = week === 'sunday' ? '2026-08-09' : week === 'saturday' ? '2026-08-08' : '2026-08-10'
    const weekTo = week === 'sunday' ? '2026-08-15' : week === 'saturday' ? '2026-08-14' : '2026-08-16'
    for (const id of [50001,50002]) {
      await run("INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(?,?,'Fixture','member','[]',?,?)",id,`Deel ${id}`,timestamp,timestamp)
      // Existing verified login addresses can predate email kinds; the saved
      // Deel destination is the explicit payroll choice for these people.
      await run("INSERT INTO user_emails(user_id,address,verified_at,created_at,updated_at) VALUES(?,?,?,?,?)",id,`deel${id}@example.test`,timestamp,timestamp,timestamp)
      await run("INSERT INTO user_payout_accounts(user_id,provider,external_id,kind,linked_by_user_id,linked_at,created_at,updated_at) VALUES(?,'deel',?,'account',1,?,?,?)",id,`deel${id}@example.test`,timestamp,timestamp,timestamp)
      await run("INSERT INTO user_assignments(id,project_id,user_id,created_at,updated_at) VALUES(?,1,?,?,?)",id,id,timestamp,timestamp)
      await run("INSERT INTO staff_payment_provider_events(id,user_id,scope,version,provider,command_json,actor_id,recorded_at,request_id) VALUES(?,?,?,1,'deel',?,1,?,?)",`deel-fixture-${id}`,id,`user:${id}`,JSON.stringify({id:`deel-fixture-${id}`,user_id:id,expected_version:0,provider:'deel',note:'Owned staging fixture'}),timestamp,`deel-fixture-${id}`)
      await run("INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,created_at,updated_at) VALUES(?,?,1,1,?,1,'2026-08-10',3600,3600,3600,0,?,?)",id,id,id,timestamp,timestamp)
      // Keep one real unsubmitted entry: administrator staging review is its
      // authorization to sync, and must not change the timesheet approval state.
      if (id === 50002) {
        await run("INSERT INTO timesheet_submissions(id,user_id,period_start,period_end,status,submitted_by_user_id,submitted_at,version,created_at,updated_at) VALUES(?,?,?,?,'submitted',?,?,0,?,?)",id,id,weekFrom,weekTo,id,timestamp,timestamp,timestamp)
        await run("UPDATE time_entries SET approval_status='submitted',timesheet_submission_id=? WHERE id=?",id,id)
        await run("UPDATE timesheet_submissions SET status='approved',version=1,reviewed_by_user_id=1,reviewed_at=? WHERE id=?",timestamp,id)
        await run("UPDATE time_entries SET approval_status='approved' WHERE id=?",id)
      }
    }
  } else if (action === 'deel-stage-receipt' && deelStagingFixture) {
    response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'})
    response.end(JSON.stringify({posts:deelStagingPosts,entries:(await database.prepare('SELECT entry_id FROM deel_transfer_log WHERE entry_id IN(50001,50002) ORDER BY entry_id').all()).results,approvals:(await database.prepare('SELECT id,approval_status,timesheet_submission_id FROM time_entries WHERE id IN(50001,50002) ORDER BY id').all()).results,submissions:(await database.prepare('SELECT id,status,version FROM timesheet_submissions WHERE user_id IN(50001,50002) ORDER BY id').all()).results,payments:(await database.prepare("SELECT count(*) count FROM staff_payment_events WHERE kind='payment'").first()).count}))
    return
  } else if (action === 'first-run-create') {
    if (firstRunRuntime !== null || typeof payload.password !== 'string') {
      response.statusCode = 400
      response.end()
      return
    }
    // A separate, newly migrated database: no fixture directory rows or time
    // entries are removed from the suite's normal acceptance workspace.
    firstRunRuntime = new Miniflare(workerOptions)
    const probe = await firstRunRuntime.dispatchFetch('https://worker.test/api/v1/whoami')
    if (probe.status !== 401) throw new Error('first-run fixture did not fail closed')
    const fresh = await firstRunRuntime.getD1Database('DB')
    const auth = createD1PasswordAuthService(fresh, { now: () => fixtureInstant })
    const delivery = await auth.signup({
      organizationName: 'Fresh Setup Acceptance', firstName: 'Fresh', lastName: 'Owner',
      email: fixtureEmail, password: payload.password, clientKey: 'first-run-acceptance',
    })
    await auth.verifyEmail(delivery.token, 'first-run-acceptance')
    response.setHeader('set-cookie', 'ezacto_browser_first_run=1; Path=/; HttpOnly; SameSite=Strict')
  } else if (action === 'first-run-reset') {
    await firstRunRuntime?.dispose()
    firstRunRuntime = null
    response.setHeader('set-cookie', 'ezacto_browser_first_run=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict')
  } else if (action === 'rate-card-seed') {
    if (rateCardFixture !== null) throw new Error('rate card fixture already active')
    const client = await database.prepare(
      `INSERT INTO clients(name,currency,created_at,updated_at)
       VALUES('Browser Rate Card Client','USD',?,?) RETURNING id`,
    ).bind(timestamp,timestamp).first()
    const project = await database.prepare(
      `INSERT INTO projects(client_id,name,bill_by,created_at,updated_at)
       VALUES(?,'Browser Rate Card Project','people',?,?) RETURNING id`,
    ).bind(client.id,timestamp,timestamp).first()
    const userAssignment = await database.prepare(
      `INSERT INTO user_assignments(project_id,user_id,use_default_rates,created_at,updated_at)
       VALUES(?,1,1,?,?) RETURNING id`,
    ).bind(project.id,timestamp,timestamp).first()
    const taskAssignment = await database.prepare(
      `INSERT INTO task_assignments(project_id,task_id,billable,created_at,updated_at)
       VALUES(?,1,1,?,?) RETURNING id`,
    ).bind(project.id,timestamp,timestamp).first()
    const entry = await database.prepare(
      `INSERT INTO time_entries(user_id,project_id,task_id,user_assignment_id,task_assignment_id,
        spent_date,seconds,seconds_without_timer,rounded_seconds,billable,
        billable_rate_cents,cost_rate_cents,notes,created_at,updated_at)
       VALUES(1,?,1,?,?,?,1800,1800,1800,1,10000,5000,'Browser rate card snapshot',?,?)
       RETURNING id`,
    ).bind(project.id,userAssignment.id,taskAssignment.id,spentDate,timestamp,timestamp).first()
    rateCardFixture = { clientId: client.id, projectId: project.id, entryId: entry.id }
    await run(`DELETE FROM auth_rate_limits WHERE action = 'sign_in'`)
    response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'})
    response.end(JSON.stringify(rateCardFixture))
    return
  } else if (action === 'rate-card-cleanup') {
    if (rateCardFixture !== null) {
      const { clientId, projectId, entryId } = rateCardFixture
      // Keep the immutable card/version history on its archived client. Only
      // this fixture's stopped, uninvoiced work can be removed.
      await run(`DELETE FROM time_entries WHERE id=? AND project_id=? AND invoice_id IS NULL
        AND timer_started_at IS NULL AND notes='Browser rate card snapshot'`,entryId,projectId)
      await run(`UPDATE projects SET is_active=0 WHERE id=? AND client_id=?`,projectId,clientId)
      await run(`UPDATE clients SET is_active=0 WHERE id=? AND name='Browser Rate Card Client'`,clientId)
      if ((await rows('SELECT id FROM time_entries WHERE id=?',entryId)).length !== 0) {
        throw new Error('rate card fixture left work behind')
      }
      rateCardFixture = null
    }
  } else if (action === 'scheduled-manifest-seed') {
    await run(`DELETE FROM auth_rate_limits WHERE action = 'sign_in'`)
    const now = new Date().toISOString(), expires = new Date(Date.now()+3600000).toISOString()
    const clients=[], invoices=[]
    scheduledManifestFixture={clientIds:clients,projectIds:[],jobId:null}
    for (const [index,label] of ['A','B'].entries()) {
      const brand=await database.prepare(`INSERT INTO report_brands(name,created_at,updated_at) VALUES(?,?,?) RETURNING id`).bind(`Browser Month End Brand ${label}`,now,now).first()
      const client=await database.prepare(`INSERT INTO clients(name,currency,report_brand_id,created_at,updated_at) VALUES(?,'USD',?,?,?) RETURNING id`).bind(`Browser Month End Client ${label}`,brand.id,now,now).first()
      clients.push(client.id)
      await run(`INSERT INTO contacts(client_id,first_name,email,invoice_recipient_status,created_at,updated_at) VALUES(?,'Accounts',?,'recipient',?,?)`,client.id,index===0?'month-end-accounts@example.test':'month-end-b@example.test',now,now)
      const invoice=await database.prepare(`INSERT INTO invoices(client_id,number,currency,issue_date,due_date,created_at,updated_at) VALUES(?,?,'USD','2026-09-15','2026-10-01',?,?) RETURNING id`).bind(client.id,`BROWSER-MONTH-${label}-${randomUUID()}`,now,now).first()
      invoices.push(invoice.id)
      await run(`INSERT INTO invoice_line_items(invoice_id,position,kind,description,quantity,unit_price_cents,amount_cents,created_at,updated_at) VALUES(?,0,'Service','Monthly service',1,?,?,?,?)`,invoice.id,12345*(index+1),12345*(index+1),now,now)
      await executeInvoiceLifecycleCommand(createD1Database(database),{invoiceId:invoice.id,commandId:`browser-month-send-${invoice.id}`,command:'send',actor:{type:'user',id:1},authorize:async()=>true,expectedVersion:0,occurredAt:now,messageId:1000000+invoice.id,eventId:`browser-month-sent-${invoice.id}`})
      const project=await database.prepare(`INSERT INTO projects(client_id,name,billing_method,created_at,updated_at) VALUES(?,?,'time_materials',?,?) RETURNING id`).bind(client.id,`Month End Work ${label}`,now,now).first()
      scheduledManifestFixture.projectIds.push(project.id)
      const user=await database.prepare(`INSERT INTO user_assignments(project_id,user_id,created_at,updated_at) VALUES(?,1,?,?) RETURNING id`).bind(project.id,now,now).first()
      const task=await database.prepare(`INSERT INTO task_assignments(project_id,task_id,billable,created_at,updated_at) VALUES(?,1,1,?,?) RETURNING id`).bind(project.id,now,now).first()
      await run(`INSERT INTO time_entries(user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,notes,client_visible,billable,cost_rate_cents,created_at,updated_at)
        VALUES(1,?,1,?,?,'2026-09-15',5400,5400,5400,?,1,1,5000,?,?)`,project.id,user.id,task.id,index===0?'Reviewed https://reference.example.test/55':'Client approved work',now,now)
    }
    const configuration=createD1EmailConfigurationStore(database)
    const senderId=(await database.prepare(`SELECT coalesce(max(id),0)+1 AS id FROM sender_identities`).first()).id
    await configuration.createSenderIdentity({id:senderId,email:'billing@example.test',displayName:'Month End Billing',provider:'mailgun',providerIdentity:'billing@example.test',actorUserId:1,commandId:`browser-month-sender-${senderId}`,occurredAt:now})
    await configuration.recordSenderEvidence({id:senderId,expectedEvidenceVersion:0,evidence:{source:'deployment_config',identityKind:'email_address',verificationStatus:'operator_configured',dkimStatus:'not_applicable',mailFromDomain:null,mailFromStatus:'not_configured',observedAt:now},actorUserId:1,commandId:`browser-month-evidence-${senderId}`,occurredAt:now})
    await configuration.setDefaultSenderIdentity({id:senderId,expectedVersion:0,actorUserId:1,commandId:`browser-month-default-${senderId}`,occurredAt:now})
    const job = await database.prepare(`INSERT INTO scheduled_jobs(action,name,scope_json,cadence,created_by_user_id,created_at,updated_at)
      VALUES('month_end_pack','Browser month-end review',?,'0 9 1 * *',1,?,?) RETURNING id`).bind(JSON.stringify({client_ids:clients}),now,now).first()
    scheduledManifestFixture.jobId=job.id
    const bucket=await miniflare.getR2Bucket('ATTACHMENTS')
    const result = await proposeMonthEndPack(createD1Database(database),{jobId:job.id,occurrenceKey:'2026-09',clientIds:clients,proposedAt:now,expiresAt:expires},{put:async(key,bytes)=>{await bucket.put(key,bytes)}})
    if (result.outcome.outcome !== 'proposed') throw new Error('Manifest fixture was not proposed')
    response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'})
    response.end(JSON.stringify({runId:result.outcome.run.id,invoiceIds:invoices}));return
  } else if (action === 'scheduled-manifest-cleanup') {
    if (scheduledManifestFixture) {
      const now=new Date().toISOString()
      for(const projectId of scheduledManifestFixture.projectIds) {
        await run(`DELETE FROM time_entries WHERE project_id=? AND invoice_id IS NULL AND timer_started_at IS NULL`,projectId)
        await run(`UPDATE projects SET is_active=0,updated_at=? WHERE id=?`,now,projectId)
      }
      for(const clientId of scheduledManifestFixture.clientIds)
        await run(`UPDATE clients SET is_active=0,updated_at=? WHERE id=?`,now,clientId)
      if(scheduledManifestFixture.jobId!==null)
        await run(`UPDATE scheduled_jobs SET is_active=0,version=version+1,updated_at=? WHERE id=?`,now,scheduledManifestFixture.jobId)
      // Keep the immutable manifest, invoices, attachments and delivery history.
      scheduledManifestFixture=null
    }
  } else if (action === 'email-feedback-seed') {
    await run(`DELETE FROM auth_rate_limits WHERE action = 'sign_in'`)
    const log = createD1EmailLogStore(database)
    const identifier = randomUUID()
    const to = 'feedback-recipient@example.test', cc = 'feedback-copy@example.test'
    const stamp = String(Math.floor(Date.now()/1000))
    const events = []
    for (const [index,sender] of ['feedback-a@example.test','feedback-b@example.test'].entries()) {
      const mail = await log.createQueued({from:{email:sender},to:[{email:to}],cc:[{email:cc}],template:'feedback_fixture',subject:'Feedback fixture',text:'Local acceptance only.'})
      const messageId = `browser-feedback-${identifier}-${index}`
      await log.claimAttempt(mail.id,'mailgun',messageId,60)
      await log.markSent(mail.id,'mailgun',{messageId},messageId)
      const token = `feedback-${identifier}-${index}`
      events.push(JSON.stringify({signature:{timestamp:stamp,token,signature:createHmac('sha256',feedbackWebhookKey).update(stamp+token).digest('hex')},'event-data':{id:token,event:index===0?'failed':'complained',severity:'permanent',recipient:index===0?to:cc,message:{headers:{'message-id':messageId}}}}))
    }
    response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'})
    response.end(JSON.stringify({events,to,cc}));return
  } else if (action === 'portal-estimate-seed') {
    const instant = new Date().toISOString()
    await database.batch([
      database.prepare("INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(120001,'Estimate Contact Fixture','USD',?,?)").bind(instant,instant),
      database.prepare("INSERT INTO contacts(id,client_id,first_name,last_name,email,created_at,updated_at) VALUES(120001,120001,'Jordan','Reviewer','estimate-contact@example.test',?,?)").bind(instant,instant),
      database.prepare("INSERT INTO estimates(id,client_id,number,currency,issue_date,amount_cents,created_at,updated_at) VALUES(120001,120001,'EST-MAILED-1010','USD','2026-10-01',10000,?,?)").bind(instant,instant),
      database.prepare("INSERT INTO estimate_line_items(estimate_id,position,kind,description,quantity,unit_price_cents,amount_cents,created_at,updated_at) VALUES(120001,0,'Service','Reviewable scope',1,10000,10000,?,?)").bind(instant,instant),
    ])
    const repo = createMoneyResourceRepository(createD1Database(database))
    const estimate = await repo.getEstimate(120001)
    await repo.executeEstimateMessage({estimateId:120001,commandId:'browser-contact-estimate-send',actorUserId:1,messageId:120001,expectedVersion:estimate.version,eventType:'send',sentBy:'Browser Owner',sentByEmail:fixtureEmail,sentFrom:null,sentFromEmail:null,recipients:[{name:'Jordan Reviewer',email:'estimate-contact@example.test'}],subject:'Review estimate',body:'Please review.',sendMeACopy:false,occurredAt:instant})
  } else if (action === 'portal-estimate-result') {
    const rows = (await database.prepare("SELECT contact_id,content_hash,estimate_version,event_type FROM estimate_messages WHERE estimate_id=120001 AND contact_id IS NOT NULL").all()).results
    response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'})
    response.end(JSON.stringify({rows}));return
  } else if (action === 'portal-estimate-cleanup') {
    await database.prepare('UPDATE clients SET is_active=0 WHERE id=120001').run()
  } else if (action === 'seed') {
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
  } else if (action === 'banded-invoice-seed') {
    /**
     * A band's month on a project of its own, so nothing another spec bills
     * or counts moves: 8h, 8h and 2h in July at 100.00/h, all 'Browser Band
     * fixture' rows. Under a 17h limit the first two are covered and the 2h
     * entry, which would cross it, is billed whole.
     */
    await database.batch([
      database.prepare(
        `DELETE FROM time_entries
         WHERE invoice_id IS NULL AND notes LIKE 'Browser band fixture%'`,
      ),
      database
        .prepare(
          `INSERT OR IGNORE INTO projects (
             id, client_id, name, code, hourly_rate_cents, created_at, updated_at
           ) VALUES (9100, 1, 'Browser Band Project', 'BAND', 10000, ?, ?)`,
        )
        .bind(timestamp, timestamp),
      database
        .prepare(
          `INSERT OR IGNORE INTO user_assignments (id, project_id, user_id, created_at, updated_at)
           VALUES (9100, 9100, 1, ?, ?)`,
        )
        .bind(timestamp, timestamp),
      database
        .prepare(
          `INSERT OR IGNORE INTO task_assignments (
             id, project_id, task_id, billable, created_at, updated_at
           ) VALUES (9100, 9100, 1, 1, ?, ?)`,
        )
        .bind(timestamp, timestamp),
      database
        .prepare(
          `INSERT INTO time_entries (
             id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
             spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
             billable_rate_cents, cost_rate_cents, notes, created_at, updated_at
           ) VALUES
             (9101, 1, 9100, 1, 9100, 9100, '2026-07-06', 28800, 28800, 28800, 1,
              10000, 5000, 'Browser band fixture week one', ?, ?),
             (9102, 1, 9100, 1, 9100, 9100, '2026-07-13', 28800, 28800, 28800, 1,
              10000, 5000, 'Browser band fixture week two', ?, ?),
             (9103, 1, 9100, 1, 9100, 9100, '2026-07-20', 7200, 7200, 7200, 1,
              10000, 5000, 'Browser band fixture overage', ?, ?)`,
        )
        .bind(timestamp, timestamp, timestamp, timestamp, timestamp, timestamp),
      database.prepare(`DELETE FROM auth_rate_limits WHERE action = 'sign_in'`),
    ])
    const seeded = await database
      .prepare(
        `SELECT count(*) AS count, sum(rounded_seconds) AS seconds FROM time_entries
         WHERE invoice_id IS NULL AND notes LIKE 'Browser band fixture%'`,
      )
      .first()
    if (seeded?.count !== 3 || seeded.seconds !== 64800) {
      throw new Error('banded invoice fixture did not own one exact work set')
    }
  } else if (action === 'banded-invoice-cleanup') {
    await database.batch([
      database.prepare(
        `DELETE FROM time_entries
         WHERE invoice_id IS NULL AND notes LIKE 'Browser band fixture%'`,
      ),
      database.prepare(`DELETE FROM auth_rate_limits WHERE action = 'sign_in'`),
    ])
  } else if (action === 'end-client-invoice-seed') {
    /**
     * A parent client with three levels of end-clients beneath it, each with a
     * project and one entry of its own (issue 33), all 'Browser F7 fixture'
     * rows in ids 9200-9213 so nothing another spec bills or counts moves:
     *
     *   9200 Parent        1h at 100.00 ->  $100.00
     *   +-- 9201 Alpha     2h           ->  $200.00
     *   +-- 9202 Bravo     1.5h         ->  $150.00
     *       +-- 9203 Charlie  0.5h      ->   $50.00
     */
    await database.batch([
      database.prepare(
        `DELETE FROM time_entries
         WHERE invoice_id IS NULL AND notes LIKE 'Browser F7 fixture%'`,
      ),
      database
        .prepare(
          `INSERT OR IGNORE INTO clients (id, name, parent_client_id, currency, payment_terms, created_at, updated_at)
           VALUES (9200, 'Browser F7 Parent', NULL, 'USD', 'net_30', ?, ?)`,
        )
        .bind(timestamp, timestamp),
      database
        .prepare(
          `INSERT OR IGNORE INTO clients (id, name, parent_client_id, currency, payment_terms, created_at, updated_at)
           VALUES (9201, 'Browser F7 Alpha', 9200, 'USD', 'net_30', ?, ?),
                  (9202, 'Browser F7 Bravo', 9200, 'USD', 'net_30', ?, ?)`,
        )
        .bind(timestamp, timestamp, timestamp, timestamp),
      database
        .prepare(
          `INSERT OR IGNORE INTO clients (id, name, parent_client_id, currency, payment_terms, created_at, updated_at)
           VALUES (9203, 'Browser F7 Charlie', 9202, 'USD', 'net_30', ?, ?)`,
        )
        .bind(timestamp, timestamp),
      ...[9200, 9201, 9202, 9203].flatMap((id) => [
        database
          .prepare(
            `INSERT OR IGNORE INTO projects (
               id, client_id, name, code, hourly_rate_cents, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 10000, ?, ?)`,
          )
          .bind(id, id, `Browser F7 Project ${id - 9199}`, `F7${id - 9199}`, timestamp, timestamp),
        database
          .prepare(
            `INSERT OR IGNORE INTO user_assignments (id, project_id, user_id, created_at, updated_at)
             VALUES (?, ?, 1, ?, ?)`,
          )
          .bind(id, id, timestamp, timestamp),
        database
          .prepare(
            `INSERT OR IGNORE INTO task_assignments (
               id, project_id, task_id, billable, created_at, updated_at
             ) VALUES (?, ?, 1, 1, ?, ?)`,
          )
          .bind(id, id, timestamp, timestamp),
      ]),
      ...[
        [9210, 9200, 3600],
        [9211, 9201, 7200],
        [9212, 9202, 5400],
        [9213, 9203, 1800],
      ].map(([id, projectId, seconds]) =>
        database
          .prepare(
            `INSERT INTO time_entries (
               id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
               spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
               billable_rate_cents, cost_rate_cents, notes, created_at, updated_at
             ) VALUES (?, 1, ?, 1, ?, ?, '2026-07-08', ?, ?, ?, 1, 10000, 5000,
               'Browser F7 fixture', ?, ?)`,
          )
          .bind(id, projectId, projectId, projectId, seconds, seconds, seconds, timestamp, timestamp),
      ),
      database.prepare(`DELETE FROM auth_rate_limits WHERE action = 'sign_in'`),
    ])
    const seeded = await database
      .prepare(
        `SELECT count(*) AS count, sum(rounded_seconds) AS seconds FROM time_entries
         WHERE invoice_id IS NULL AND notes LIKE 'Browser F7 fixture%'`,
      )
      .first()
    if (seeded?.count !== 4 || seeded.seconds !== 18000) {
      throw new Error('end-client invoice fixture did not own one exact work set')
    }
  } else if (action === 'end-client-invoice-cleanup') {
    await database.batch([
      database.prepare(
        `DELETE FROM time_entries
         WHERE invoice_id IS NULL AND notes LIKE 'Browser F7 fixture%'`,
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
     * Ids 9001–9008 belong to this roster. Other browser fixtures use higher
     * ranges, including retained closure history, so cleanup owns only these ids.
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
      database.prepare('DELETE FROM time_entries WHERE user_id BETWEEN 9001 AND 9008'),
      database.prepare('DELETE FROM user_assignments WHERE user_id BETWEEN 9001 AND 9008'),
      database.prepare('DELETE FROM user_emails WHERE user_id BETWEEN 9001 AND 9008'),
      database.prepare('DELETE FROM users WHERE id BETWEEN 9001 AND 9008'),
      database.prepare(`DELETE FROM auth_rate_limits WHERE action = 'sign_in'`),
    ])
  } else if (action === 'teammate-time-seed' || action === 'teammate-time-cleanup') {
    // A teammate with one entry on the fixture's own day, for the administrator
    // to correct from Detailed time (issue 917). Ids above 9100 stay clear of
    // the team roster's, and the seed clears first so a run that died before
    // its cleanup does not leave this one a duplicate.
    const teammateId = 9101
    await database.batch([
      database.prepare('DELETE FROM time_entries WHERE user_id = ?').bind(teammateId),
      database.prepare('DELETE FROM user_assignments WHERE user_id = ?').bind(teammateId),
      database.prepare('DELETE FROM user_emails WHERE user_id = ?').bind(teammateId),
      database.prepare('DELETE FROM users WHERE id = ?').bind(teammateId),
      database.prepare(`DELETE FROM auth_rate_limits WHERE action = 'sign_in'`),
    ])
    if (action === 'teammate-time-seed') {
      await database.batch([
        database
          .prepare(
            `INSERT INTO users (
               id, first_name, last_name, timezone, is_contractor, is_active,
               weekly_capacity, profile, manager_grants, created_at, updated_at
             ) VALUES (?, 'Rosa', 'Fictional', ?, 0, 1, 126000, 'member', '[]', ?, ?)`,
          )
          .bind(teammateId, fixtureTimeZone, timestamp, timestamp),
        database
          .prepare(
            `INSERT INTO user_emails (
               id, user_id, address, verified_at, is_primary, created_at, updated_at
             ) VALUES (?, ?, 'rosa.fictional@example.test', ?, 1, ?, ?)`,
          )
          .bind(teammateId, teammateId, timestamp, timestamp, timestamp),
        database
          .prepare(
            `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
             VALUES (?, 1, ?, ?, ?)`,
          )
          .bind(teammateId, teammateId, timestamp, timestamp),
        database
          .prepare(
            `INSERT INTO time_entries (
               id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
               spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
               billable_rate_cents, cost_rate_cents, notes, created_at, updated_at
             ) VALUES (?, ?, 1, 1, ?, 1, ?, 4500, 4500, 4500, 1, 10000, 5000,
               'Fictional teammate entry', ?, ?)`,
          )
          .bind(91011, teammateId, teammateId, spentDate, timestamp, timestamp),
      ])
    }
  } else if (action === "account-closure-seed") {
    // Disposable person in this harness's ephemeral D1 only; never close the owner.
    await database
      .prepare(
        `INSERT INTO users(id,first_name,last_name,profile,is_active,manager_grants,telephone,created_at,updated_at) VALUES(97201,'Fictional','Closure','member',1,'[]','555-0199',?,?)`,
      )
      .bind(fixtureInstant, fixtureInstant)
      .run();
    const request = createAccountDeletionRequestRepository(
      createD1Database(database),
    );
    await request.request({
      userId: 97201,
      id: "browser-closure-972",
      now: fixtureInstant,
    });
  } else if (action === "account-closure-assert") {
    const person = await database
      .prepare(
        "SELECT first_name,last_name,is_active,telephone FROM users WHERE id=97201",
      )
      .first();
    const receipt = await database
      .prepare(
        "SELECT request_id FROM account_closures WHERE request_id='browser-closure-972'",
      )
      .first();
    if (
      !receipt ||
      person.is_active !== 0 ||
      person.telephone !== null ||
      person.first_name !== "Closed" ||
      person.last_name !== "account"
    )
      throw new Error("Disposable closure was not durably applied");
  } else if (action === 'calendar-proposals-seed' || action === 'calendar-proposals-cleanup') {
    if (calendarProposalFixture !== null) {
      await run(`UPDATE timesheet_lock_windows SET version=version+1,unlocked_by_user_id=1,unlocked_at=?,unlock_reason='Owned fixture cleanup'
        WHERE lock_reason='browser-1201-lock' AND unlocked_at IS NULL`, new Date().toISOString())
      const created = await rows(`SELECT time_entry_id AS id FROM calendar_proposals WHERE calendar_id='browser-owned-1201' AND time_entry_id IS NOT NULL`)
      await run(`DELETE FROM calendar_proposals WHERE calendar_id='browser-owned-1201'`)
      for (const { id } of created) await run('DELETE FROM time_entries WHERE id=? AND user_id=1 AND invoice_id IS NULL', id)
      await run('DELETE FROM user_assignments WHERE user_id=120190')
      await run('DELETE FROM users WHERE id=120190')
      const old = calendarProposalFixture
      await run(`UPDATE organizations SET time_entry_mode=?,time_format=?,clock=?,timezone=?,week_start_day=?,modules=? WHERE id=1`,
        old.organization.time_entry_mode, old.organization.time_format, old.organization.clock,
        old.organization.timezone, old.organization.week_start_day, old.organization.modules)
      await run('UPDATE users SET timezone=? WHERE id=1', old.owner.timezone)
      calendarProposalFixture = null
    }
    if (action === 'calendar-proposals-seed') {
      if ((await rows('SELECT id FROM users WHERE id=120190')).length ||
          (await rows('SELECT id FROM calendar_proposals WHERE id BETWEEN 120101 AND 120107')).length)
        throw new Error('Calendar proposal fixture identifiers are already occupied')
      calendarProposalFixture = {
        organization: (await rows('SELECT time_entry_mode,time_format,clock,timezone,week_start_day,modules FROM organizations WHERE id=1'))[0],
        owner: (await rows('SELECT timezone FROM users WHERE id=1'))[0],
      }
      await run(`UPDATE organizations SET time_entry_mode='duration',time_format='decimal',clock='24h',timezone='America/Costa_Rica',week_start_day='monday',modules=json_set(modules,'$.approval',json('true')) WHERE id=1`)
      await run("UPDATE users SET timezone='UTC' WHERE id=1")
      await run(`INSERT INTO users(id,first_name,last_name,profile,manager_grants,timezone,created_at,updated_at)
        VALUES(120190,'Proposal','Other','member','[]','America/Costa_Rica',?,?)`, timestamp, timestamp)
      await run(`INSERT INTO user_assignments(id,project_id,user_id,created_at,updated_at) VALUES(120190,1,120190,?,?)`, timestamp, timestamp)
      const values = [
        [120101,1,'Owned proposed workshop','2026-08-27T15:00:00.000Z','2026-08-27T16:00:00.000Z'],
        [120102,1,'Owned proposed discard','2026-08-28T16:00:00.000Z','2026-08-28T16:30:00.000Z'],
        [120103,1,'Owned overnight proposal','2026-08-28T05:30:00.000Z','2026-08-28T07:00:00.000Z'],
        [120104,1,'Owned locked proposal','2026-08-26T15:00:00.000Z','2026-08-26T16:00:00.000Z'],
        [120105,120190,'Other person private calendar','2026-08-27T15:00:00.000Z','2026-08-27T16:00:00.000Z'],
      ]
      for (const [id,userId,title,start,end] of values)
        await run(`INSERT INTO calendar_proposals(id,user_id,provider,calendar_id,event_id,title,starts_at,ends_at,created_at,updated_at)
          VALUES(?,?,'google','browser-owned-1201',?,?,?, ?,?,?)`, id,userId,`browser-1201:${id}`,title,start,end,timestamp,timestamp)
      await run("DELETE FROM auth_rate_limits WHERE action='sign_in'")
    }
  } else if (action === 'calendar-proposals-start-end') {
    if (calendarProposalFixture === null) throw new Error('Calendar proposal fixture is not active')
    await run("UPDATE organizations SET time_entry_mode='start_end' WHERE id=1")
  } else if (action === 'calendar-proposals-dst') {
    if (calendarProposalFixture === null) throw new Error('Calendar proposal fixture is not active')
    await run("UPDATE users SET timezone='America/New_York' WHERE id=1")
    await run(`INSERT INTO calendar_proposals(id,user_id,provider,calendar_id,event_id,title,starts_at,ends_at,created_at,updated_at)
      VALUES(120106,1,'google','browser-owned-1201','browser-1201:120106','Owned DST clock proposal','2026-11-01T05:45:00.000Z','2026-11-01T06:15:00.000Z',?,?),
        (120107,1,'google','browser-owned-1201','browser-1201:120107','Owned precise-second proposal','2026-11-01T15:00:15.000Z','2026-11-01T16:00:00.000Z',?,?)`, timestamp,timestamp,timestamp,timestamp)
  } else if (action === 'calendar-proposals-assert') {
    const proposals = await rows(`SELECT id,status,time_entry_id FROM calendar_proposals WHERE calendar_id='browser-owned-1201' ORDER BY id`)
    if (proposals.length !== 7 || proposals[0].status !== 'accepted' || proposals[1].status !== 'discarded' ||
        proposals.slice(2).some((item) => item.status !== 'proposed')) throw new Error('Proposal decisions were not isolated')
    const entries = await rows(`SELECT user_id,project_id,task_id,spent_date,seconds,started_time,ended_time,calendar_event_ref FROM time_entries WHERE id=?`, proposals[0].time_entry_id)
    const entry = entries[0]
    if (entries.length !== 1 || entry.user_id !== 1 || entry.project_id !== 1 || entry.task_id !== 1 ||
        entry.spent_date !== '2026-08-27' || entry.seconds !== 3600 || entry.started_time !== null || entry.ended_time !== null ||
        JSON.parse(entry.calendar_event_ref).event_id !== 'browser-1201:120101') throw new Error('Atomic acceptance changed source timing or assignment')
  } else if (action === 'planning-business-fingerprint') {
    // Read-only, disposable-harness evidence: never ship a SQL/debug API.
    const tables = (await database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'auth_%' AND (name='time_entries' OR name LIKE '%rate%' OR name LIKE '%invoice%' OR name LIKE '%payment%' OR name LIKE '%approval%') ORDER BY name").all()).results
    const records = []
    for (const { name } of tables) records.push([name, (await database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()).results])
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ sha256: createHash('sha256').update(JSON.stringify(records)).digest('hex'), tables: tables.map(row => row.name) }))
    return
  } else if (action === 'payment-run-reset' || action === 'sign-in-rate-reset') {
    // Clearing the sign-in limit is all either does. The second name is for a
    // spec that signs in late in a run, after the rest of the suite has spent
    // the limit, and has nothing to do with payment runs.
    await database.prepare(`DELETE FROM auth_rate_limits WHERE action = 'sign_in'`).run()
  } else if (action === 'client-360-seed') {
    await client360Seed()
  } else if (action === 'client-360-cleanup') {
    await client360Clear()
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
  const proxyHost = request.headers.host === `localhost:${listenPort}` ? `localhost:${listenPort}` : `${listenHost}:${listenPort}`
  const url = new URL(request.url ?? '/', `http://${proxyHost}`)
  // Test-only delivery handoff: mint a real one-time token without an external
  // mail provider. The production Worker bundle never contains this endpoint.
  if (url.pathname === '/__ezacto_browser_fixture__/password-reset') {
    if (request.method !== 'POST' || request.headers['x-ezacto-browser-fixture-control'] !== fixtureControlHeader) {
      response.writeHead(403); response.end(); return
    }
    const delivery = await createD1PasswordAuthService(database).requestPasswordReset(fixtureEmail, 'browser-recovery-fixture')
    if (!delivery) throw new Error('password recovery fixture account is unavailable')
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ token: delivery.token }))
    return
  }
  if (url.pathname === fixtureControlPath) {
    await fixtureControl(request, response)
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks)
  const runtime = firstRunRuntime !== null && /(?:^|;\s*)ezacto_browser_first_run=1(?:;|$)/u.test(request.headers.cookie ?? '')
    ? firstRunRuntime : miniflare
  const upstream = await runtime.dispatchFetch(url, {
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
  server.close(() => { void miniflare.dispose(); void firstRunRuntime?.dispose() })
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
