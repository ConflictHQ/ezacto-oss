import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLI_CONFIG_VERSION, writeConfig } from '../src/config.js'
import { errorMessage, runCli, type CliRuntime } from '../src/cli.js'

const token = `ezacto_abcdefghijklmnop_${'A'.repeat(43)}`
const now = '2026-10-01T00:00:00.000Z'

const line = (id: number, position: number) => ({
  id, invoice_id: 7, position, kind: 'Service', description: `line ${position}`,
  quantity: 2, unit_price_cents: 10000, amount_cents: 20000, taxed: false,
  taxed2: false, project_id: 3, created_at: now, updated_at: `${now}#${id}`,
})

const invoice = (state: string, version = 4) => ({
  id: 7, client_id: 1, number: '1400', state, version, currency: 'USD',
  amount_cents: 40000, subject: null, notes: null, line_items: [line(11, 1), line(12, 2)],
})

interface Call { method: string; path: string; headers: Headers; body: unknown }

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
  const notFound = () => reply(404, { error: { code: 'not_found', message: 'no route', fields: [] } })
  const runtime = (out: string[]): CliRuntime => ({
    environment: {},
    stdout: (value) => out.push(value),
    stderr: () => undefined,
    readStdin: async () => '',
  })
  const run = async (args: string[]) => {
    const out: string[] = []
    try {
      const code = await runCli(['--config', configPath, ...args], runtime(out))
      return { code, out: out.join('\n'), thrown: '' }
    } catch (error) {
      return { code: 1, out: out.join('\n'), thrown: error instanceof Error ? error.message : String(error) }
    }
  }
  const writes = () => calls.filter((call) => call.method !== 'GET')

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ezacto-cli-invoice-edit-'))
    configPath = join(directory, 'config.json')
    await writeConfig(configPath, organization('accounting', [
      'invoices:read', 'invoices:write', 'reports:read', 'time_entries:write',
    ]))
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

  const invoiceRoutes = (state = 'draft') => (call: Call) => {
    if (call.method === 'GET' && call.path === '/api/v1/invoices') {
      return reply(200, { data: [invoice(state)], links: {}, page: { next_cursor: null } })
    }
    if (call.method === 'GET' && call.path === '/api/v1/invoices/7') {
      return reply(200, { data: invoice(state), links: {} })
    }
    if (call.method === 'PATCH' && call.path === '/api/v1/invoices/7') {
      return reply(200, { data: { invoice: { ...invoice(state, 5), subject: 'New' }, command: {} }, links: {} })
    }
    if (call.method === 'PATCH' && call.path === '/api/v1/invoices/7/line-items/12') {
      return reply(200, { data: { invoice: invoice(state, 6), command: {} }, links: {} })
    }
    return notFound()
  }

  it('[unit] edits the header then a line, each write with a fresh key and the current version', async () => {
    routes = invoiceRoutes()
    const result = await run([
      'invoice', 'edit', '1400', '--subject', 'New', '--line', '2',
      '--quantity', '3', '--rate', '150.50', '--description', 'Reworked',
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
      'invoice', 'edit', '#1400', '--notes-file', notes, '--terms', 'net_30', '--issue-date', '2026-10-05',
    ])
    expect(result.thrown).toBe('')
    expect(writes()[0]!.body).toEqual({
      expected_version: 4,
      notes: 'Thanks for your business.\n',
      issue_date: '2026-10-05',
      payment_terms: 'net_30',
    })
  })

  it.each(['open', 'paid', 'closed'])('[unit] refuses a %s invoice before sending any write', async (state) => {
    routes = invoiceRoutes(state)
    const result = await run(['invoice', 'edit', '1400', '--subject', 'New'])
    expect(result.thrown).toBe(`invoice #1400 is ${state}; ez invoice edit changes drafts only`)
    expect(writes()).toEqual([])
  })

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
      { error: { code: 'profile_forbidden', message: 'Your profile may not edit invoices.', fields: [] } },
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
          fields: [{ field: 'quantity', code: 'out_of_range', message: 'quantity must be greater than zero.' }],
        },
      },
      null,
    )
    expect(errorMessage(error)).toBe('quantity must be greater than zero. (422, validation_failed)')
  })

  it('[unit] a stale version says to run the command again', () => {
    const error = new EzactoApiError(
      409,
      { error: { code: 'invoice_version_conflict', message: 'Version 4 is not current.', fields: [] } },
      null,
    )
    expect(errorMessage(error)).toBe(
      'the invoice changed since it was read; run the command again (409, invoice_version_conflict)',
    )
  })

  it('[unit] unlink-time wraps mark_uninvoiced and prints changed versus ineligible ids', async () => {
    routes = (call) =>
      call.method === 'POST' && call.path === '/api/v1/reports/detailed-time/actions'
        ? reply(200, {
            data: {
              command_id: (call.body as { command_id: string }).command_id,
              action: 'mark_uninvoiced',
              requested: 3,
              changed_entry_ids: [1, 2],
              ineligible_entry_ids: [3],
              replayed: false,
            },
            links: {},
          })
        : notFound()
    const result = await run(['invoice', 'unlink-time', '--entries', '1,2,3,3'])
    expect(result.thrown).toBe('')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toMatchObject({
      action: 'mark_uninvoiced', entry_ids: [1, 2, 3], confirmed: true,
    })
    expect((calls[0]!.body as { command_id: string }).command_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.out).toContain('unlinked 2 of 3')
    expect(result.out).toContain('changed:    1, 2')
    expect(result.out).toContain('ineligible: 3')
  })

  it.each([
    [['invoice', 'unlink-time'], /requires --entries/],
    [['invoice', 'unlink-time', '--entries', '1,x'], /invalid time entry id/],
    [['invoice', 'send', '7', '--entries', '1'], /only with ez invoice unlink-time/],
  ])('[unit] unlink-time rejects %j', async (args, pattern) => {
    const result = await run(args)
    expect(result.thrown).toMatch(pattern)
    expect(calls).toEqual([])
  })

  it('[unit] unlink-time names the missing scope', async () => {
    await writeConfig(configPath, organization('accounting', ['invoices:write', 'reports:read']))
    const result = await run(['invoice', 'unlink-time', '--entries', '1'])
    expect(result.thrown).toMatch(/lacks the required time_entries:write scope/)
    expect(calls).toEqual([])
  })
})
