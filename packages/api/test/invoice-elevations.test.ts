import { createApiIdempotencyAuthorization } from '../src/idempotency-auth.js'
import type { ApiAuthentication } from '../src/auth.js'
import { unlinkElevatedInvoiceTime } from '../../db/src/invoice-elevated-time.js'
import { canProfileUseApiScope } from '@ezacto/core'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createContainerDatabase } from '../../db/src/adapters.js'
import { migrateContainer } from '../../db/src/migrate.js'
import { createInvoiceElevationStore } from '../../db/src/invoice-elevations.js'
import { createMoneyResourceRepository } from '../../db/src/money-resources.js'
import { createApiApp, type UserProfile } from '../src/index.js'
import { installMoneyResourceRoutes } from '../src/money-resources.js'
import {
  installInvoiceElevationRoutes,
  type InvoiceElevationRouteOptions,
} from '../src/invoice-elevations.js'
const instant = '2026-10-01T09:00:00.000Z',
  fixturePassword = 'Correct fixture reauthentication password'
let authorizeReplay: ReturnType<typeof createApiIdempotencyAuthorization>
let sqlite: BetterSqlite3.Database,
  profile: UserProfile,
  passwordLive: boolean,
  totp: boolean,
  email: boolean,
  now: string,
  app: ReturnType<typeof createApiApp>,
  options: InvoiceElevationRouteOptions
const fail = async (): Promise<never> => {
  throw new Error('Unused fixture operation')
}
beforeEach(() => {
  sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  sqlite
    .prepare(
      `INSERT INTO organizations(id,name,currency,modules,created_at,updated_at) VALUES(1,'Invoice fixture','USD','{}',?,?)`,
    )
    .run(instant, instant)
  sqlite
    .prepare(
      `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(3,'Keep','Owner','administrator','[]',?,?),(1,'Invoice','Admin','administrator','[]',?,?)`,
    )
    .run(instant, instant, instant, instant)
  sqlite
    .prepare(
      `INSERT INTO user_passwords(user_id,credential_version,algorithm,iterations,salt,password_hash,created_at,updated_at) VALUES(1,1,'pbkdf2-sha256',600000,?,?,?,?)`,
    )
    .run('A'.repeat(22), 'A'.repeat(43), instant, instant)
  sqlite
    .prepare(
      `INSERT INTO api_tokens(id,user_id,selector,secret_hash,name,scopes,created_at,updated_at) VALUES(1,1,'aaaaaaaaaaaaaaaa',?,'First','["invoices:read","invoices:write","time_entries:write"]',?,?),(2,1,'bbbbbbbbbbbbbbbb',?,'Second','["invoices:read","invoices:write","time_entries:write"]',?,?)`,
    )
    .run('1'.repeat(64), instant, instant, '2'.repeat(64), instant, instant)
  sqlite
    .prepare(
      `INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Client','USD',?,?)`,
    )
    .run(instant, instant)
  sqlite
    .prepare(
      `INSERT INTO invoices(id,client_id,number,currency,issue_date,due_date,state,created_at,updated_at) VALUES(1,1,'DRAFT','USD','2026-10-01','2026-10-31','draft',?,?)`,
    )
    .run(instant, instant)
  profile = 'administrator'
  passwordLive = true
  totp = false
  email = false
  now = instant
  const db = createContainerDatabase(sqlite)
  let activeChallenge = 'C'.repeat(43)
  options = {
    store: createInvoiceElevationStore(db),
    unlinkTime: (command, elevation, at) => unlinkElevatedInvoiceTime(db, command, elevation, at),
    passwords: {
      signup: fail,
      verifyEmail: fail,
      requestPasswordReset: fail,
      resetPassword: fail,
      signIn: vi.fn(async (input) =>
        input.password === fixturePassword && input.email === 'admin@example.test'
          ? {
              status: 'authenticated' as const,
              principal: { userId: 1, profile: 'administrator' as const, managerGrants: [] },
              credentialVersion: 1,
            }
          : { status: 'invalid_credentials' as const },
      ),
    },
    policy: { isLive: async () => passwordLive },
    secondFactor: {
      isEnrolled: async () => totp,
      isEmailFactorEnabled: async () => email,
      issueChallenge: vi.fn(async () => ({
        token: 'C'.repeat(43),
        expiresAt: '2026-10-01T09:05:00.000Z',
      })),
      resendEmailCode: vi.fn(async (token) => {
        if (!email || token !== activeChallenge) return { status: 'unknown_challenge' as const }
        activeChallenge = 'E'.repeat(43)
        return {
          status: 'sent' as const,
          userId: 1,
          token: activeChallenge,
          expiresAt: '2026-10-01T09:06:00.000Z',
          emailCode: '123456',
          emailTo: 'admin@example.test',
        }
      }),
      redeemChallenge: vi.fn(async (token, code) =>
        token !== activeChallenge
          ? { status: 'unknown_challenge' as const }
          : code === '123456'
            ? { status: 'accepted' as const, userId: 1 }
            : { status: 'rejected' as const },
      ),
    },
    emailCodesReady: true,
    emailCodeMailer: { enqueue: vi.fn(async () => {}) },
    clock: () => now,
    clientKey: () => 'elevation-fixture',
  }
  const authentication: ApiAuthentication = {
    tokens: {
      authenticate: async (token) => ({
        userId: 1,
        tokenId: token === 'second' ? 2 : 1,
        profile,
        managerGrants: [],
        scopes: canProfileUseApiScope(profile, 'invoices:read')
          ? ['invoices:read', 'invoices:write', 'time_entries:write']
          : ['time_entries:read'],
      }),
      issue: fail,
      list: async () => [],
      revoke: async () => null,
    },
    sessions: {
      resolve: async (request) =>
        request.headers.get('x-test-session') === 'yes'
          ? {
              type: 'user',
              userId: 1,
              profile,
              managerGrants: [],
              authentication: { kind: 'session', sessionId: 'browser-fixture' },
            }
          : null,
    },
  }
  authorizeReplay = createApiIdempotencyAuthorization(
    authentication,
    async () => 'fixture-revision',
    { invoiceElevations: options.store, clock: () => now },
  )
  app = createApiApp({
    authentication,
    installApi: (api) => {
      installInvoiceElevationRoutes(api, options)
      installMoneyResourceRoutes(api, {
        service: createMoneyResourceRepository(db),
        invoiceElevations: options.store,
        cursorSigningKey: new Uint8Array(32),
        clock: () => now,
      })
    },
  })
})
afterEach(() => sqlite.close())
const request = (
  path: string,
  method: string,
  body?: unknown,
  extra: Record<string, string> = {},
) =>
  app.request('https://api.test/api/v1' + path, {
    method,
    headers: Object.fromEntries(
      Object.entries({
        origin: 'https://api.test',
        'content-type': 'application/json',
        Authorization: 'Bearer first',
        'Idempotency-Key': 'invoice-edit',
        ...extra,
      }).filter(([key, value]) => key !== 'Authorization' || value !== ''),
    ),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const issue = () =>
  request('/invoice-elevations', 'POST', {
    invoice_id: 1,
    email: 'admin@example.test',
    password: fixturePassword,
  })
const json = async (response: Response) =>
  (await response.json()) as { data: Record<string, unknown>; error?: { code: string } }
it('requires elevation on each edit route and records exact before/after values in the same transaction', async () => {
  for (const [path, method] of [
    ['/invoices/1', 'PATCH'],
    ['/invoices/1/line-items', 'POST'],
    ['/invoices/1/line-items/1', 'PATCH'],
    ['/invoices/1/line-items/1', 'DELETE'],
  ])
    expect((await request(path!, method!, {})).status).toBe(403)
  const minted = await issue()
  expect(minted.status).toBe(201)
  expect(minted.headers.get('cache-control')).toBe('no-store')
  const grant = (await json(minted)).data
  expect(grant).toMatchObject({
    status: 'elevated',
    invoice_id: 1,
    scope: 'invoice_drafts:write',
    expires_at: '2026-10-01T09:15:00.000Z',
  })
  const credential = grant.credential as string
  expect(
    (
      await request(
        '/invoices/1',
        'PATCH',
        { expected_version: 0, subject: 'Corrected subject' },
        { 'X-Ezacto-Invoice-Elevation': credential },
      )
    ).status,
  ).toBe(200)
  const row = sqlite
    .prepare(
      `SELECT elevation_id,elevation_before_json,elevation_after_json FROM invoice_command_ledger WHERE command_id='invoice-edit'`,
    )
    .get() as { elevation_id: string; elevation_before_json: string; elevation_after_json: string }
  expect(row.elevation_id).toBe(grant.id)
  expect(JSON.parse(row.elevation_before_json).header.subject).toBeNull()
  expect(JSON.parse(row.elevation_after_json).header.subject).toBe('Corrected subject')
  expect(
    (
      await request(
        '/invoices/1',
        'PATCH',
        { expected_version: 1, notes: 'Wrong base token' },
        { Authorization: 'Bearer second', 'X-Ezacto-Invoice-Elevation': credential },
      )
    ).status,
  ).toBe(403)
  expect((await request('/invoice-elevations/' + grant.id, 'DELETE')).status).toBe(204)
  expect(
    (
      await request(
        '/invoices/1',
        'PATCH',
        { expected_version: 1, notes: 'After revoke' },
        { 'X-Ezacto-Invoice-Elevation': credential },
      )
    ).status,
  ).toBe(403)
})
it.each(['member', 'project_manager', 'people_admin', 'accounting', 'executive_manager'] as const)(
  'refuses elevation and token edits by %s',
  async (value) => {
    profile = value
    expect((await issue()).status).toBe(403)
    expect(options.passwords.signIn).not.toHaveBeenCalled()
    expect(
      (await request('/invoices/1', 'PATCH', { expected_version: 0, subject: 'No' })).status,
    ).toBe(403)
  },
)
it('fails closed for disabled password authentication and incorrect credentials', async () => {
  passwordLive = false
  expect((await issue()).status).toBe(403)
  expect(options.passwords.signIn).not.toHaveBeenCalled()
  passwordLive = true
  expect(
    (
      await request('/invoice-elevations', 'POST', {
        invoice_id: 1,
        email: 'admin@example.test',
        password: 'incorrect',
      })
    ).status,
  ).toBe(403)
  expect(sqlite.prepare('SELECT count(*) AS n FROM invoice_elevations').get()).toEqual({ n: 0 })
})
it.each(['authenticator', 'email'] as const)(
  'requires %s MFA and binds verification to the original API token',
  async (method) => {
    email = method === 'email'
    totp = method === 'authenticator'
    if (email)
      sqlite
        .prepare('INSERT INTO user_email_second_factors(user_id,enabled_at) VALUES(1,?)')
        .run(instant)
    else
      sqlite
        .prepare(
          'INSERT INTO user_totp_enrolments(user_id,secret,confirmed_at,last_used_step,created_at,updated_at) VALUES(1,?,?,1,?,?)',
        )
        .run('A'.repeat(32), instant, instant, instant)
    const response = await issue()
    expect(response.status).toBe(202)
    let challenge = (await json(response)).data
    expect(challenge.methods).toEqual([method === 'email' ? 'email' : 'totp'])
    expect(challenge).not.toHaveProperty('credential')
    expect(
      (
        await request(
          '/invoice-elevations/verify',
          'POST',
          { challenge_token: challenge.challenge_token, code: '123456' },
          { Authorization: 'Bearer second' },
        )
      ).status,
    ).toBe(403)
    expect(options.secondFactor.redeemChallenge).not.toHaveBeenCalled()
    if (method === 'email') {
      const original = challenge.challenge_token
      now = '2026-10-01T09:01:00.000Z'
      const mailed = await request('/invoice-elevations/email-code', 'POST', {
        challenge_token: original,
      })
      expect(mailed.status).toBe(200)
      challenge = (await json(mailed)).data
      expect(challenge.challenge_token).not.toBe(original)
      expect(challenge.expires_at).toBe('2026-10-01T09:05:00.000Z')
      expect(options.emailCodeMailer!.enqueue).toHaveBeenCalledWith({
        to: 'admin@example.test',
        code: '123456',
        expiresAt: '2026-10-01T09:05:00.000Z',
      })
      expect(
        (
          await request('/invoice-elevations/verify', 'POST', {
            challenge_token: original,
            code: '123456',
          })
        ).status,
      ).toBe(403)
    }
    expect(
      (
        await request('/invoice-elevations/verify', 'POST', {
          challenge_token: challenge.challenge_token,
          code: 'wrong',
        })
      ).status,
    ).toBe(403)
    const verified = await request('/invoice-elevations/verify', 'POST', {
      challenge_token: challenge.challenge_token,
      code: '123456',
    })
    expect(verified.status).toBe(201)
    expect((await json(verified)).data).toHaveProperty('credential')
    expect(
      (
        await request('/invoice-elevations/verify', 'POST', {
          challenge_token: challenge.challenge_token,
          code: '123456',
        })
      ).status,
    ).toBe(403)
  },
)
it('refuses a password-only capability after expiry and preserves authenticated browser editing', async () => {
  const grant = (await json(await issue())).data
  now = '2026-10-01T09:15:00.000Z'
  expect(
    (
      await request(
        '/invoices/1',
        'PATCH',
        { expected_version: 0, subject: 'Expired' },
        { 'X-Ezacto-Invoice-Elevation': grant.credential as string },
      )
    ).status,
  ).toBe(403)
  profile = 'accounting'
  expect(
    (
      await request(
        '/invoices/1',
        'PATCH',
        { expected_version: 0, subject: 'Browser edit' },
        { Authorization: '', 'x-test-session': 'yes' },
      )
    ).status,
  ).toBe(200)
})

it('requires fresh elevation before cached replies and never caches credential responses', async () => {
  const grant = (await json(await issue())).data
  const make = (path: string) =>
    new Request('https://api.test/api/v1' + path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer first',
        'X-Ezacto-Invoice-Elevation': grant.credential as string,
      },
    })
  expect(await authorizeReplay(make('/invoice-elevations'))).toBeNull()
  const valid = await authorizeReplay(make('/invoices/1/line-items'))
  expect(typeof valid).toBe('string')
  expect(valid).toContain(grant.id)
  expect(valid).not.toContain(grant.credential)
  await options.store.revoke(grant.id as string, { userId: 1, tokenId: 1 }, now)
  const refused = await authorizeReplay(make('/invoices/1/line-items'))
  expect(refused).toBeInstanceOf(Response)
  expect((refused as Response).status).toBe(403)
})
it('unlinks a complete invoice-scoped selection with an immutable audit and idempotent replay', async () => {
  sqlite.exec(`
  INSERT INTO invoices(id,client_id,number,currency,issue_date,due_date,state,created_at,updated_at) VALUES(2,1,'OTHER','USD','2026-10-01','2026-10-31','draft','${instant}','${instant}');
  INSERT INTO projects(id,client_id,name,billing_method,created_at,updated_at) VALUES(1,1,'Work','time_materials','${instant}','${instant}');
  INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Advisory','${instant}','${instant}');
  INSERT INTO user_assignments(id,project_id,user_id,created_at,updated_at) VALUES(1,1,1,'${instant}','${instant}');
  INSERT INTO task_assignments(id,project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,1,'${instant}','${instant}');
  INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,invoice_id,created_at,updated_at)
   VALUES(1,1,1,1,1,1,'2026-10-01',600,600,600,1,1,'${instant}','${instant}'),(2,1,1,1,1,1,'2026-10-01',900,900,900,1,2,'${instant}','${instant}');
 `)
  const body = { expected_version: 0, entry_ids: [1], confirmed: true }
  expect((await request('/invoices/1/unlink-time', 'POST', body)).status).toBe(403)
  const grant = (await json(await issue())).data,
    headers = { 'X-Ezacto-Invoice-Elevation': grant.credential as string }
  expect(
    (await request('/invoices/1/unlink-time', 'POST', { ...body, entry_ids: [1, 2] }, headers))
      .status,
  ).toBe(409)
  expect(sqlite.prepare('SELECT count(*) AS n FROM invoice_elevated_time_commands').get()).toEqual({
    n: 0,
  })
  const response = await request('/invoices/1/unlink-time', 'POST', body, headers)
  expect(response.status).toBe(200)
  expect((await json(response)).data.released_entry_ids).toEqual([1])
  expect(sqlite.prepare('SELECT id,invoice_id FROM time_entries ORDER BY id').all()).toEqual([
    { id: 1, invoice_id: null },
    { id: 2, invoice_id: 2 },
  ])
  const replay = await request('/invoices/1/unlink-time', 'POST', body, headers)
  expect(replay.status).toBe(200)
  expect((await json(replay)).data.replayed).toBe(true)
})
