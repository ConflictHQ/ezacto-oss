import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAuth } from '../src/auth.js'
import { readManifest } from '../src/manifest.js'

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

describe('runAuth', () => {
  let dir: string
  let order: string[]
  let usersMeResponse: { id: number; access_roles: string[] }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-auth-'))
    order = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('id.getharvest.com')) {
          order.push('accounts')
          return Promise.resolve(jsonResponse(ACCOUNTS))
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
})
