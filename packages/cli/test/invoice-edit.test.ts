import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLI_CONFIG_VERSION, writeConfig } from '../src/config.js'
import { errorMessage, runCli, type CliRuntime } from '../src/cli.js'

const token = `ezacto_abcdefghijklmnop_${'A'.repeat(43)}`
const now = '2026-10-01T00:00:00.000Z'
const elevationCredential = 'ezi_' + 'b'.repeat(64)
const fixturePassword = 'Fixture reauthentication password'

const line = (id: number, position: number) => ({
  id,
  invoice_id: 7,
  position,
  kind: 'Service',
  description: `line ${position}`,
  quantity: 2,
  unit_price_cents: 10000,
  amount_cents: 20000,
  taxed: false,
  taxed2: false,
  project_id: 3,
  created_at: now,
  updated_at: `${now}#${id}`,
})

const invoice = (state: string, version = 4) => ({
  id: 7,
  client_id: 1,
  number: '1400',
  state,
  version,
  currency: 'USD',
  amount_cents: 40000,
  subject: null,
  notes: null,
  line_items: [line(11, 1), line(12, 2)],
})

interface Call {
  method: string
  path: string
  headers: Headers
  body: unknown
}

const organization = (profile: string, scopes: string[]) => ({
  version: CLI_CONFIG_VERSION,
  active_organization: 'default',
  organizations: {
    default: { base_url: 'http://127.0.0.1:9', token, user_id: 1, profile, scopes },
  },
})

describe('ez invoice edit and unlink-time', () => {
  let directory: string
  let configPath: string
  let calls: Call[]
  let routes: (call: Call) => { status: number; body: unknown }

  const reply = (status: number, body: unknown) => ({ status, body })
  const notFound = () =>
    reply(404, { error: { code: 'not_found', message: 'no route', fields: [] } })
  const runtime = (out: string[]): CliRuntime => ({
    environment: {},
    stdout: (value) => out.push(value),
    stderr: () => undefined,
    readStdin: async () =>
      JSON.stringify({ email: 'admin@example.test', password: fixturePassword }),
    readSecret: async (prompt) =>
      prompt.startsWith('Verified')
        ? 'admin@example.test'
        : prompt.startsWith('Password')
          ? fixturePassword
          : '123456',
  })
  const run = async (args: string[], overrides: Partial<CliRuntime> = {}) => {
    const out: string[] = []
    try {
      const code = await runCli(['--config', configPath, ...args], {
        ...runtime(out),
        ...overrides,
      })
      return { code, out: out.join('\n'), thrown: '' }
    } catch (error) {
      return {
        code: 1,
        out: out.join('\n'),
        thrown: error instanceof Error ? error.message : String(error),
      }
    }
  }
  const writes = () =>
    calls.filter((call) => call.method !== 'GET' && call.path.startsWith('/api/v1/invoices/'))

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ezacto-cli-invoice-edit-'))
    configPath = join(directory, 'config.json')
    await writeConfig(
      configPath,
      organization('administrator', [
        'invoices:read',
        'invoices:write',
        'reports:read',
        'time_entries:write',
      ]),
    )
    calls = []
    routes = notFound
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input))
      const call: Call = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      }
      calls.push(call)
      const result = routes(call)
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      })
    })
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(directory, { recursive: true, force: true })
  })

  const invoiceRoutes =
    (state = 'draft') =>
    (call: Call) => {
      if (call.method === 'GET' && call.path === '/api/v1/whoami')
        return reply(200, {
          data: {
            user_id: 1,
            profile: 'administrator',
            manager_grants: [],
            authentication: {
              kind: 'token',
              scopes: ['invoices:read', 'invoices:write', 'time_entries:write'],
            },
          },
        })
      if (call.method === 'POST' && call.path === '/api/v1/invoice-elevations')
        return reply(201, {
          data: {
            status: 'elevated',
            id: 'temporary-elevation-id',
            credential: elevationCredential,
            invoice_id: 7,
            scope: 'invoice_drafts:write',
            expires_at: '2026-10-01T00:15:00.000Z',
          },
        })
      if (
        call.method === 'DELETE' &&
        call.path === '/api/v1/invoice-elevations/temporary-elevation-id'
      )
        return reply(204, undefined)
      if (
        call.method !== 'GET' &&
        call.path.startsWith('/api/v1/invoices/') &&
        call.headers.get('X-Ezacto-Invoice-Elevation') !== elevationCredential
      )
        return reply(403, {
          error: {
            code: 'invoice_elevation_required',
            message: 'Use ez sudo to edit this draft.',
            fields: [],
          },
        })
      if (call.method === 'GET' && call.path === '/api/v1/invoices') {
        return reply(200, { data: [invoice(state)], links: {}, page: { next_cursor: null } })
      }
      if (call.method === 'GET' && call.path === '/api/v1/invoices/7') {
        return reply(200, { data: invoice(state), links: {} })
      }
      if (call.method === 'PATCH' && call.path === '/api/v1/invoices/7') {
        return reply(200, {
          data: { invoice: { ...invoice(state, 5), subject: 'New' }, command: {} },
          links: {},
        })
      }
      if (call.method === 'PATCH' && call.path === '/api/v1/invoices/7/line-items/12') {
        return reply(200, { data: { invoice: invoice(state, 6), command: {} }, links: {} })
      }
      return notFound()
    }

  it('[unit] edits the header then a line, each write with a fresh key and the current version', async () => {
    routes = invoiceRoutes()
    const result = await run([
      'sudo',
      'invoice',
      'edit',
      '1400',
      '--subject',
      'New',
      '--line',
      '2',
      '--quantity',
      '3',
      '--rate',
      '150.50',
      '--description',
      'Reworked',
    ])
    expect(result.thrown).toBe('')
    expect(result.code).toBe(0)
    expect(writes().map((call) => call.path)).toEqual([
      '/api/v1/invoices/7',
      '/api/v1/invoices/7/line-items/12',
    ])
    expect(writes()[0]!.body).toEqual({ expected_version: 4, subject: 'New' })
    expect(writes()[1]!.body).toMatchObject({
      expected_version: 5,
      expected_updated_at: `${now}#12`,
      position: 2,
      description: 'Reworked',
      quantity: 3,
      unit_price_cents: 15050,
      project_id: 3,
    })
    const keys = writes().map((call) => call.headers.get('idempotency-key'))
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/)
    expect(keys[0]).not.toBe(keys[1])
    expect(result.out).toContain('invoice #1400 updated')
    expect(result.out).toContain('changed: subject, line 2')
  })

  it('[unit] reads notes from a file and maps terms and issue date', async () => {
    routes = invoiceRoutes()
    const notes = join(directory, 'notes.txt')
    await writeFile(notes, 'Thanks for your business.\n')
    const result = await run([
      'sudo',
      'invoice',
      'edit',
      '#1400',
      '--notes-file',
      notes,
      '--terms',
      'net_30',
      '--issue-date',
      '2026-10-05',
      '--due-date',
      '2026-11-04',
    ])
    expect(result.thrown).toBe('')
    expect(writes()[0]!.body).toEqual({
      expected_version: 4,
      notes: 'Thanks for your business.\n',
      issue_date: '2026-10-05',
      due_date: '2026-11-04',
      payment_terms: 'net_30',
    })
  })

  it.each(['open', 'paid', 'closed'])(
    '[unit] refuses a %s invoice before sending any write',
    async (state) => {
      routes = invoiceRoutes(state)
      const result = await run(['invoice', 'edit', '1400', '--subject', 'New'])
      expect(result.thrown).toBe(`invoice #1400 is ${state}; ez invoice edit changes drafts only`)
      expect(writes()).toEqual([])
    },
  )

  it('[unit] refuses an unknown line and makes no write', async () => {
    routes = invoiceRoutes()
    const result = await run(['invoice', 'edit', '1400', '--line', '9', '--quantity', '1'])
    expect(result.thrown).toMatch(/there is no line 9/)
    expect(writes()).toEqual([])
  })

  it.each([
    [['invoice', 'edit', '1400'], /nothing to edit/],
    [['invoice', 'edit', '1400', '--quantity', '2'], /require --line/],
    [['invoice', 'edit', '1400', '--line', '1'], /needs at least one/],
    [['invoice', 'edit', '1400', '--line', '0', '--quantity', '1'], /invalid --line/],
    [['invoice', 'edit', '1400', '--line', '1', '--rate', 'abc'], /invalid --rate/],
    [['invoice', 'edit', '1400', '--terms', 'soon'], /invalid --terms/],
    [['invoice', 'list', '--subject', 'x'], /valid only with ez invoice edit/],
  ])('[unit] rejects bad input %j before any request', async (args, pattern) => {
    const result = await run(args)
    expect(result.thrown).toMatch(pattern)
    expect(calls).toEqual([])
  })

  it('[unit] a token without invoices:write fails with the scope guidance before any request', async () => {
    await writeConfig(configPath, organization('member', ['invoices:read']))
    const result = await run(['invoice', 'edit', '1400', '--subject', 'New'])
    expect(result.thrown).toMatch(/lacks the required invoices:write scope/)
    expect(calls).toEqual([])
  })

  it('[unit] a server 403 is surfaced verbatim', () => {
    const error = new EzactoApiError(
      403,
      {
        error: {
          code: 'profile_forbidden',
          message: 'Your profile may not edit invoices.',
          fields: [],
        },
      },
      'req_1',
    )
    expect(errorMessage(error)).toBe(
      'Your profile may not edit invoices. (403, profile_forbidden, request req_1)',
    )
  })

  it('[unit] a validation error is one sentence from fields[].message', () => {
    const error = new EzactoApiError(
      422,
      {
        error: {
          code: 'validation_failed',
          message: 'The request contains invalid fields.',
          fields: [
            {
              field: 'quantity',
              code: 'out_of_range',
              message: 'quantity must be greater than zero.',
            },
          ],
        },
      },
      null,
    )
    expect(errorMessage(error)).toBe('quantity must be greater than zero. (422, validation_failed)')
  })

  it('[unit] a stale version says to run the command again', () => {
    const error = new EzactoApiError(
      409,
      {
        error: {
          code: 'invoice_version_conflict',
          message: 'Version 4 is not current.',
          fields: [],
        },
      },
      null,
    )
    expect(errorMessage(error)).toBe(
      'the invoice changed since it was read; run the command again (409, invoice_version_conflict)',
    )
  })

  it('[unit] unlink-time names the draft, uses elevated authority and leaves other invoices outside the command', async () => {
    routes = (call) =>
      call.method === 'POST' && call.path === '/api/v1/invoices/7/unlink-time'
        ? reply(200, {
            data: {
              invoice_id: 7,
              command_id: call.headers.get('Idempotency-Key'),
              elevation_id: 'temporary-elevation-id',
              released_entry_ids: [1, 2, 3],
              recorded_at: now,
              replayed: false,
            },
          })
        : invoiceRoutes()(call)
    const result = await run(['sudo', 'invoice', 'unlink-time', '1400', '--entries', '1,2,3,3'])
    expect(result.thrown).toBe('')
    expect(writes()).toHaveLength(1)
    expect(writes()[0]!.body).toEqual({
      expected_version: 4,
      entry_ids: [1, 2, 3],
      confirmed: true,
    })
    expect(writes()[0]!.headers.get('X-Ezacto-Invoice-Elevation')).toBe(elevationCredential)
    expect(writes()[0]!.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.out).toContain('unlinked 3 selected time entries from draft #1400')
    expect(calls.some((call) => call.path === '/api/v1/reports/detailed-time/actions')).toBe(false)
  })

  it.each([
    [['invoice', 'unlink-time', '1400'], /requires --entries/],
    [['invoice', 'unlink-time', '1400', '--entries', '1,x'], /invalid time entry id/],
    [['invoice', 'send', '7', '--entries', '1'], /only with ez invoice unlink-time/],
  ])('[unit] unlink-time rejects %j', async (args, pattern) => {
    const result = await run(args)
    expect(result.thrown).toMatch(pattern)
    expect(calls).toEqual([])
  })

  it('[unit] unlink-time names the missing scope', async () => {
    await writeConfig(
      configPath,
      organization('accounting', ['invoices:read', 'invoices:write', 'reports:read']),
    )
    const result = await run(['invoice', 'unlink-time', '1400', '--entries', '1'])
    expect(result.thrown).toMatch(/lacks the required time_entries:write scope/)
    expect(calls).toEqual([])
  })
  it('[security] refuses a normal unelevated edit and never starts reauthentication implicitly', async () => {
    routes = invoiceRoutes()
    const result = await run(['invoice', 'edit', '1400', '--subject', 'New'])
    expect(result.thrown).toContain('403')
    expect(calls.some((call) => call.path === '/api/v1/invoice-elevations')).toBe(false)
  })
  it('[security] holds elevation only in memory, sends it on writes and revokes it after success', async () => {
    routes = invoiceRoutes()
    const before = await readFile(configPath, 'utf8')
    const result = await run([
      'sudo',
      'invoice',
      'edit',
      '1400',
      '--subject',
      'New',
      '--reauth-stdin',
      '--json',
    ])
    expect(result.thrown).toBe('')
    expect(writes()[0]!.headers.get('X-Ezacto-Invoice-Elevation')).toBe(elevationCredential)
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: '/api/v1/invoice-elevations/temporary-elevation-id',
    })
    expect(await readFile(configPath, 'utf8')).toBe(before)
    expect(result.out).not.toContain(elevationCredential)
    expect(result.out).not.toContain(fixturePassword)
  })
  it('[security] revokes elevation after a failed edit', async () => {
    routes = (call) =>
      call.method === 'PATCH'
        ? reply(409, {
            error: { code: 'invoice_version_conflict', message: 'The draft changed.', fields: [] },
          })
        : invoiceRoutes()(call)
    const result = await run(['sudo', 'invoice', 'edit', '1400', '--subject', 'New'])
    expect(result.thrown).toContain('409')
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: '/api/v1/invoice-elevations/temporary-elevation-id',
    })
  })
  it('[security] validates a requested line before saving any accompanying header', async () => {
    routes = invoiceRoutes()
    const result = await run([
      'sudo',
      'invoice',
      'edit',
      '1400',
      '--subject',
      'New',
      '--line',
      '99',
      '--quantity',
      '3',
    ])
    expect(result.thrown).toContain('no line 99')
    expect(writes()).toEqual([])
    expect(calls.some((call) => call.path === '/api/v1/invoice-elevations')).toBe(false)
  })
  it('[security] refuses a changed draft after reauthentication and revokes its credential', async () => {
    let issued = false
    routes = (call) => {
      if (call.method === 'POST' && call.path === '/api/v1/invoice-elevations') {
        issued = true
        return invoiceRoutes()(call)
      }
      if (issued && call.method === 'GET' && call.path === '/api/v1/invoices/7')
        return reply(200, { data: invoice('draft', 5) })
      return invoiceRoutes()(call)
    }
    const result = await run(['sudo', 'invoice', 'edit', '1400', '--subject', 'New'])
    expect(result.thrown).toContain('changed during reauthentication')
    expect(writes()).toEqual([])
    expect(calls.at(-1)?.method).toBe('DELETE')
  })
  it('[unit] reports a saved header clearly if the later line edit fails', async () => {
    routes = (call) =>
      call.method === 'PATCH' && call.path.includes('line-items')
        ? reply(409, {
            error: { code: 'invoice_version_conflict', message: 'The line changed.', fields: [] },
          })
        : invoiceRoutes()(call)
    const result = await run([
      'sudo',
      'invoice',
      'edit',
      '1400',
      '--subject',
      'New',
      '--line',
      '2',
      '--quantity',
      '3',
    ])
    expect(result.thrown).toContain('header was saved')
    expect(result.thrown).toContain('line edit failed')
    expect(calls.at(-1)?.method).toBe('DELETE')
  })
  it.each(['totp', 'email'] as const)(
    '[security] completes %s MFA without disclosing a challenge or credential',
    async (method) => {
      const oldChallenge = 'C'.repeat(43),
        newChallenge = 'E'.repeat(43)
      routes = (call) => {
        if (call.method === 'POST' && call.path === '/api/v1/invoice-elevations')
          return reply(202, {
            data: {
              status: 'challenge_required',
              challenge_token: oldChallenge,
              expires_at: '2026-10-01T00:05:00.000Z',
              methods: [method],
            },
          })
        if (call.method === 'POST' && call.path === '/api/v1/invoice-elevations/email-code')
          return reply(200, {
            data: {
              status: 'challenge_required',
              challenge_token: newChallenge,
              expires_at: '2026-10-01T00:05:00.000Z',
              methods: ['email'],
            },
          })
        if (call.method === 'POST' && call.path === '/api/v1/invoice-elevations/verify')
          return invoiceRoutes()({ ...call, path: '/api/v1/invoice-elevations' })
        return invoiceRoutes()(call)
      }
      const result = await run(['sudo', 'invoice', 'edit', '1400', '--subject', 'New', '--json'])
      expect(result.thrown).toBe('')
      const verification = calls.find((call) => call.path === '/api/v1/invoice-elevations/verify')!
      expect(verification.body).toEqual({
        challenge_token: method === 'email' ? newChallenge : oldChallenge,
        code: '123456',
      })
      expect(calls.some((call) => call.path === '/auth/two-factor/email-code')).toBe(false)
      expect(result.out).not.toContain(oldChallenge)
      expect(result.out).not.toContain(newChallenge)
      expect(result.out).not.toContain(elevationCredential)
    },
  )
  it('[security] binds the initially reviewed notes file through reauthentication', async () => {
    routes = invoiceRoutes()
    const path = join(directory, 'reviewed-notes.txt')
    await writeFile(path, 'Originally reviewed')
    const result = await run(['sudo', 'invoice', 'edit', '1400', '--notes-file', path], {
      readSecret: async (prompt) => {
        if (prompt.startsWith('Verified')) return 'admin@example.test'
        await writeFile(path, 'Changed during reauthentication')
        return fixturePassword
      },
    })
    expect(result.thrown).toBe('')
    expect(writes()[0]!.body).toMatchObject({ notes: 'Originally reviewed' })
  })
  it('[security] refuses a configuration change during reauthentication and revokes the grant', async () => {
    routes = invoiceRoutes()
    const result = await run(['sudo', 'invoice', 'edit', '1400', '--subject', 'New'], {
      readSecret: async (prompt) => {
        if (prompt.startsWith('Verified')) return 'admin@example.test'
        const changed = organization('administrator', ['invoices:read', 'invoices:write'])
        changed.organizations.default.base_url = 'http://127.0.0.1:10'
        await writeConfig(configPath, changed)
        return fixturePassword
      },
    })
    expect(result.thrown).toContain('organization changed')
    expect(writes()).toEqual([])
    expect(calls.at(-1)?.method).toBe('DELETE')
  })
  it('[unit] rejects password argv flags and malformed stdin without sending credentials', async () => {
    routes = invoiceRoutes()
    const argv = await run([
      'sudo',
      'invoice',
      'edit',
      '1400',
      '--subject',
      'New',
      '--password',
      'do-not-accept-argv',
    ])
    expect(argv.thrown).toContain('Unknown option')
    expect(calls).toEqual([])
    const input = await run(
      ['sudo', 'invoice', 'edit', '1400', '--subject', 'New', '--reauth-stdin'],
      { readStdin: async () => '{bad JSON' },
    )
    expect(input.thrown).toContain('expects one JSON object')
    expect(calls.some((call) => call.path === '/api/v1/invoice-elevations')).toBe(false)
  })
})
