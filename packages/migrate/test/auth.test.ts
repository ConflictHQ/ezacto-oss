import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAuth } from '../src/auth.js'
import { readManifest, writeManifest, type Manifest } from '../src/manifest.js'

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200 })

const ACCOUNTS = {
  user: { id: 1, first_name: 'A', last_name: 'B', email: 'a@b.com' },
  accounts: [{ id: 999, name: 'CONFLICT', product: 'harvest' }],
}
const COMPANY = {
  name: 'CONFLICT',
  clock: '12h',
  wants_timestamp_timers: true,
  expense_feature: true,
  invoice_feature: true,
  estimate_feature: true,
  approval_feature: true,
}

const baseEnv = { pat: 'p', accountId: undefined, userAgentEmail: 'e@x.com' }

describe('runAuth', () => {
  let dir: string
  let order: string[]
  let usersMeResponse: { id: number; access_roles: string[] }
  let accountsResponse: typeof ACCOUNTS

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-auth-'))
    order = []
    accountsResponse = ACCOUNTS
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('id.getharvest.com')) {
          order.push('accounts')
          return Promise.resolve(jsonResponse(accountsResponse))
        }
        if (url.includes('/v2/company')) {
          order.push('company')
          return Promise.resolve(jsonResponse(COMPANY))
        }
        if (url.includes('/v2/users/me')) {
          order.push('users/me')
          return Promise.resolve(jsonResponse(usersMeResponse))
        }
        throw new Error(`unexpected url ${url}`)
      }),
    )
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  it('[unit] member-scoped PAT: warning names the limitation and fires after users/me, before any later side effect', async () => {
    usersMeResponse = { id: 1, access_roles: ['member'] }
    const logs: string[] = []

    await runAuth({
      env: { pat: 'p', accountId: undefined, userAgentEmail: 'e@x.com' },
      toolVersion: '0.0.0',
      snapshotDir: dir,
      log: (line) => {
        order.push('warning')
        logs.push(line)
      },
    })

    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('not an administrator')
    expect(logs[0]).toContain('visibility')

    // strict call order: accounts, company, users/me, warning — and no fetch
    // call follows the warning in this story's flow.
    expect(order).toEqual(['accounts', 'company', 'users/me', 'warning'])

    const manifest = await readManifest(dir)
    expect(manifest.account.id).toBe('999')
  })

  it('[unit] preflight persists clock, timer mode, and feature flags into the snapshot manifest', async () => {
    usersMeResponse = { id: 1, access_roles: ['administrator'] }

    await runAuth({
      env: { pat: 'p', accountId: undefined, userAgentEmail: 'e@x.com' },
      toolVersion: '0.0.0',
      snapshotDir: dir,
    })

    const manifest = await readManifest(dir)
    expect(manifest.preflight).toEqual({
      clock: COMPANY.clock,
      wants_timestamp_timers: COMPANY.wants_timestamp_timers,
      expense_feature: COMPANY.expense_feature,
      invoice_feature: COMPANY.invoice_feature,
      estimate_feature: COMPANY.estimate_feature,
      approval_feature: COMPANY.approval_feature,
    })
  })

  it('[unit] administrator PAT: no warning is emitted', async () => {
    usersMeResponse = { id: 1, access_roles: ['administrator'] }
    const logs: string[] = []

    const result = await runAuth({
      env: { pat: 'p', accountId: undefined, userAgentEmail: 'e@x.com' },
      toolVersion: '0.0.0',
      snapshotDir: dir,
      log: (line) => logs.push(line),
    })

    expect(logs).toHaveLength(0)
    expect(result.isAdministrator).toBe(true)
    expect(order).toEqual(['accounts', 'company', 'users/me'])
  })

  it('[unit] carries extract progress forward: a re-run preserves resources, watermarks, and started_at', async () => {
    usersMeResponse = { id: 1, access_roles: ['administrator'] }
    const half: Manifest = {
      account: { id: '999', name: 'CONFLICT' },
      company_name: 'CONFLICT',
      started_at: '2026-08-01T00:00:00.000Z',
      finished_at: null,
      tool_version: '0.0.0',
      preflight: {
        clock: '24h',
        wants_timestamp_timers: false,
        expense_feature: false,
        invoice_feature: false,
        estimate_feature: false,
        approval_feature: false,
      },
      resources: { time_entries: { count: 48213, pages: 25, cursor: 'eyJhZnRlciI6MTIzfQ' } },
      updated_since: { time_entries: '2026-08-20T10:00:00Z' },
    }
    await writeManifest(dir, half)

    await runAuth({
      env: baseEnv,
      toolVersion: '0.0.0',
      snapshotDir: dir,
      now: () => new Date('2026-08-26T00:00:00.000Z'),
    })

    const manifest = await readManifest(dir)
    expect(manifest.resources).toEqual(half.resources)
    expect(manifest.updated_since).toEqual(half.updated_since)
    expect(manifest.started_at).toBe('2026-08-01T00:00:00.000Z')
    // the preflight itself is re-stamped from the live company response
    expect(manifest.preflight.clock).toBe(COMPANY.clock)
  })

  it('[unit] refuses to re-stamp a snapshot dir that holds another account, and leaves it untouched', async () => {
    usersMeResponse = { id: 1, access_roles: ['administrator'] }
    accountsResponse = {
      user: ACCOUNTS.user,
      accounts: [
        { id: 111, name: 'ACME', product: 'harvest' },
        { id: 222, name: 'OTHER', product: 'harvest' },
      ],
    }
    await runAuth({ env: baseEnv, toolVersion: '0.0.0', snapshotDir: dir, accountIdFlag: '111' })

    const err = await runAuth({
      env: baseEnv,
      toolVersion: '0.0.0',
      snapshotDir: dir,
      accountIdFlag: '222',
    }).catch((e: unknown) => e as Error)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('111')
    expect((err as Error).message).toContain('--force')
    const manifest = await readManifest(dir)
    expect(manifest.account.id).toBe('111')
  })

  it('[unit] --force re-stamps the account, resets progress, and warns about the stale raw/ data', async () => {
    usersMeResponse = { id: 1, access_roles: ['administrator'] }
    accountsResponse = {
      user: ACCOUNTS.user,
      accounts: [
        { id: 111, name: 'ACME', product: 'harvest' },
        { id: 222, name: 'OTHER', product: 'harvest' },
      ],
    }
    const logs: string[] = []
    await runAuth({ env: baseEnv, toolVersion: '0.0.0', snapshotDir: dir, accountIdFlag: '111' })

    await runAuth({
      env: baseEnv,
      toolVersion: '0.0.0',
      snapshotDir: dir,
      accountIdFlag: '222',
      force: true,
      log: (line) => logs.push(line),
    })

    const manifest = await readManifest(dir)
    expect(manifest.account.id).toBe('222')
    expect(manifest.resources).toEqual({})
    expect(logs.some((l) => l.includes('raw/'))).toBe(true)
  })
})
