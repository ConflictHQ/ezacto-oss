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
  host: listenHost,
  log: new NoOpLog(),
  modules: true,
  port: 0,
  script: bundle.outputFiles[0].text,
})

const migrationProbe = await miniflare.dispatchFetch(
  'http://worker.test/api/v1/whoami',
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
const run = async (statement, ...bindings) => {
  await database.prepare(statement).bind(...bindings).run()
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
     time_entry_notes_minimum_length, created_at, updated_at
   ) VALUES
     (1, 1, 'Browser Acceptance Project', 'BROWSER', 10000, NULL, ?, ?),
     (2, 1, 'Browser Secondary Project', 'SECONDARY', 12500, 8, ?, ?)`,
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
  `INSERT INTO expense_categories (id, name, created_at, updated_at)
   VALUES (1, 'Travel', ?, ?)`,
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
     billable_rate_cents, cost_rate_cents, notes, created_at, updated_at
   ) VALUES
     (
       1, 1, 1, 1, 1, 1, ?, 1800, 1800, 1800, 1, 10000, 5000,
       'First line\nSecond line with delivery detail', ?, ?
     ),
     (
       2, 1, 1, 1, 1, 1, ?, 900, 900, 900, 1, 10000, 5000,
       'Separate follow-up', ?, ?
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
  void proxyFetch(request, response).catch(() => {
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
