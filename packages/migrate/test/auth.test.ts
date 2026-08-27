import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAuth, visibilityWarning } from '../src/auth.js'
import {
  readManifest,
  readManifestIfExists,
  writeManifest,
  type Manifest,
} from '../src/manifest.js'
import {
  COMPANY_RESPONSE as COMPANY,
  COMPANY_SETTINGS,
  preflight,
  resourceProgress,
} from './fixtures.js'

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200 })

const ACCOUNTS = {
  user: { id: 1, first_name: 'A', last_name: 'B', email: 'a@b.com' },
  accounts: [{ id: 999, name: 'CONFLICT', product: 'harvest' }],
}

const baseEnv = { pat: 'p', accountId: undefined, userAgentEmail: 'e@x.com' }

describe('runAuth', () => {
  let dir: string
  let order: string[]
  let usersMeResponse: unknown
  let accountsResponse: unknown
  let companyResponse: unknown

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-auth-'))
    order = []
    accountsResponse = ACCOUNTS
    companyResponse = COMPANY
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('id.getharvest.com')) {
          order.push('accounts')
          return Promise.resolve(jsonResponse(accountsResponse))
        }
        if (url.includes('/v2/company')) {
          order.push('company')
          return Promise.resolve(jsonResponse(companyResponse))
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
    expect(manifest.preflight).toMatchObject({
      clock: COMPANY.clock,
      wants_timestamp_timers: COMPANY.wants_timestamp_timers,
      expense_feature: COMPANY.expense_feature,
      invoice_feature: COMPANY.invoice_feature,
      estimate_feature: COMPANY.estimate_feature,
      approval_feature: COMPANY.approval_feature,
      user: { id: 1, access_roles: ['administrator'], is_administrator: true },
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

  it('[unit] refuses auth while extract owns the snapshot lock, before any API request', async () => {
    await mkdir(join(dir, '.sync.lock'))
    await writeFile(
      join(dir, '.sync.lock', 'owner.json'),
      JSON.stringify({ pid: process.pid, host: hostname(), command: 'extract', started_at: '2026-08-26T00:00:00.000Z', token: 'live-extract' }),
    )

    await expect(runAuth({ env: baseEnv, toolVersion: '0.0.0', snapshotDir: dir })).rejects.toThrow(
      'snapshot is locked by extract',
    )
    expect(order).toEqual([])
  })

  it('[unit] carries extract progress forward: a re-run preserves resources, watermarks, and started_at', async () => {
    usersMeResponse = { id: 1, access_roles: ['administrator'] }
    const half: Manifest = {
      account: { id: '999', name: 'CONFLICT' },
      company_name: 'CONFLICT',
      started_at: '2026-08-01T00:00:00.000Z',
      finished_at: null,
      tool_version: '0.0.0',
      preflight: preflight({ clock: '24h', wants_timestamp_timers: false }),
      resources: {
        time_entries: resourceProgress({
          count: 48213,
          pages: 25,
          next_url: 'https://api.harvestapp.com/v2/time_entries?cursor=eyJhZnRlciI6MTIzfQ',
          complete: false,
          finished_at: null,
        }),
      },
      updated_since: { time_entries: '2026-08-20T10:00:00Z' },
      deleted_upstream: { roles: [7] },
      full_id_sweeps: {
        roles: {
          completed_at: '2026-08-20T10:00:00.000Z',
          seen_count: 3,
          total_entries: 3,
          requests: 1,
        },
      },
      binaries: {
        receipts: {
          '17': {
            source_id: 17,
            sha256: 'a'.repeat(64),
            path: 'binaries/sha256/aa/archive.pdf',
            bytes: 42,
            content_type: 'application/pdf',
          },
        },
        avatars: {},
        anomalies: [],
      },
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
    expect(manifest.deleted_upstream).toEqual(half.deleted_upstream)
    expect(manifest.full_id_sweeps).toEqual(half.full_id_sweeps)
    expect(manifest.binaries).toEqual(half.binaries)
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
    const first = await readManifest(dir)
    first.deleted_upstream = { roles: [7] }
    first.full_id_sweeps = {
      roles: {
        completed_at: '2026-08-26T00:00:00.000Z',
        seen_count: 3,
        total_entries: 3,
        requests: 1,
      },
    }
    first.binaries = {
      receipts: {},
      avatars: {},
      anomalies: [],
    }
    await writeManifest(dir, first)

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
    expect(manifest.deleted_upstream).toBeUndefined()
    expect(manifest.full_id_sweeps).toBeUndefined()
    expect(manifest.binaries).toBeUndefined()
    expect(logs.some((l) => l.includes('raw/'))).toBe(true)
  })

  // AC #4 is about `extract`, a separate CLI invocation (migration-spec §0) that
  // re-reads HARVEST_PAT and checks the identity it gets against this record before
  // sweeping. If the manifest does not say who authenticated, a member-scoped
  // snapshot is byte-identical to an administrator's, extract has nothing to
  // compare its own /v2/users/me against, and nothing downstream can explain the deltas.
  it('[unit] records the authenticating user, so a member-scoped snapshot is distinguishable', async () => {
    usersMeResponse = { id: 4242, access_roles: ['member', 'project_manager'] }

    await runAuth({ env: baseEnv, toolVersion: '0.0.0', snapshotDir: dir, log: () => {} })

    const manifest = await readManifest(dir)
    expect(manifest.preflight.user).toEqual({
      id: 4242,
      access_roles: ['member', 'project_manager'],
      is_administrator: false,
    })
    // and the warning extract must raise is reproducible from the manifest alone
    expect(visibilityWarning(manifest.preflight.user)).toContain('not an administrator')
  })

  // migration-spec §1 step 2 records the display settings too: they become the
  // `organization` row at load, and extract is the expensive, rate-limited step —
  // dropping them here means re-running it to get them back.
  it('[unit] preflight persists the /v2/company display settings, not just the parse inputs', async () => {
    usersMeResponse = { id: 1, access_roles: ['administrator'] }

    await runAuth({ env: baseEnv, toolVersion: '0.0.0', snapshotDir: dir })

    expect((await readManifest(dir)).preflight).toEqual({
      ...COMPANY_SETTINGS,
      user: { id: 1, access_roles: ['administrator'], is_administrator: true },
    })
  })

  // A snapshot's rows are only ever what the authenticating PAT could see, so
  // re-stamping carried progress with a different identity leaves a manifest that
  // misdescribes the raw/ files underneath it (migration-spec §6).
  it('[unit] refuses to re-stamp progress gathered as a different user', async () => {
    usersMeResponse = { id: 1, access_roles: ['administrator'] }
    await runAuth({ env: baseEnv, toolVersion: '0.0.0', snapshotDir: dir })
    const stamped = await readManifest(dir)
    await writeManifest(dir, {
      ...stamped,
      resources: { clients: resourceProgress({ count: 12, pages: 1 }) },
    })

    usersMeResponse = { id: 2, access_roles: ['administrator'] }
    const err = await runAuth({ env: baseEnv, toolVersion: '0.0.0', snapshotDir: dir }).catch(
      (e: unknown) => e as Error,
    )

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('was 1, is now 2')
    expect((err as Error).message).toContain('--force')
    // and it left the snapshot exactly as it found it
    expect((await readManifest(dir)).preflight.user.id).toBe(1)
  })

  it('[unit] refuses to re-stamp progress after the same user loses administrator access', async () => {
    usersMeResponse = { id: 1, access_roles: ['administrator'] }
    await runAuth({ env: baseEnv, toolVersion: '0.0.0', snapshotDir: dir })
    const stamped = await readManifest(dir)
    await writeManifest(dir, {
      ...stamped,
      resources: { clients: resourceProgress({ count: 12, pages: 1 }) },
    })

    usersMeResponse = { id: 1, access_roles: ['member'] }
    const err = await runAuth({
      env: baseEnv,
      toolVersion: '0.0.0',
      snapshotDir: dir,
      log: () => {},
    }).catch((e: unknown) => e as Error)

    expect((err as Error).message).toContain('was administrator, is now member-scoped')
  })

  it('[unit] an identity change on a snapshot with no progress yet is not an error', async () => {
    usersMeResponse = { id: 1, access_roles: ['administrator'] }
    await runAuth({ env: baseEnv, toolVersion: '0.0.0', snapshotDir: dir })

    usersMeResponse = { id: 2, access_roles: ['administrator'] }
    const logs: string[] = []
    await runAuth({
      env: baseEnv,
      toolVersion: '0.0.0',
      snapshotDir: dir,
      log: (l) => logs.push(l),
    })

    expect((await readManifest(dir)).preflight.user.id).toBe(2)
    expect(logs.some((l) => l.includes('identity changed'))).toBe(true)
  })

  it('[unit] --force overwrites the preflight and warns that raw/ keeps the old visibility', async () => {
    usersMeResponse = { id: 1, access_roles: ['administrator'] }
    await runAuth({ env: baseEnv, toolVersion: '0.0.0', snapshotDir: dir })
    const stamped = await readManifest(dir)
    await writeManifest(dir, {
      ...stamped,
      resources: { clients: resourceProgress({ count: 12, pages: 1 }) },
    })

    usersMeResponse = { id: 2, access_roles: ['administrator'] }
    const logs: string[] = []
    await runAuth({
      env: baseEnv,
      toolVersion: '0.0.0',
      snapshotDir: dir,
      force: true,
      log: (l) => logs.push(l),
    })

    expect((await readManifest(dir)).preflight.user.id).toBe(2)
    expect(logs.some((l) => l.includes('identity changed'))).toBe(true)
  })

  it('[unit] a company setting changed since the snapshot was stamped is named in a warning', async () => {
    usersMeResponse = { id: 1, access_roles: ['administrator'] }
    await runAuth({ env: baseEnv, toolVersion: '0.0.0', snapshotDir: dir })

    companyResponse = { ...COMPANY, clock: '24h', estimate_feature: false }
    const logs: string[] = []
    await runAuth({
      env: baseEnv,
      toolVersion: '0.0.0',
      snapshotDir: dir,
      log: (l) => logs.push(l),
    })

    const warning = logs.find((l) => l.includes('company settings changed'))
    expect(warning).toContain('clock: 12h -> 24h')
    expect(warning).toContain('estimate_feature: true -> false')
    expect((await readManifest(dir)).preflight.clock).toBe('24h')
  })

  it('[unit] an administrator manifest is distinguishable from a member one', async () => {
    usersMeResponse = { id: 7, access_roles: ['administrator'] }

    await runAuth({ env: baseEnv, toolVersion: '0.0.0', snapshotDir: dir })

    const manifest = await readManifest(dir)
    expect(manifest.preflight.user.is_administrator).toBe(true)
    expect(visibilityWarning(manifest.preflight.user)).toBeNull()
  })
})

// A bare `as` cast over a preflight response writes a manifest full of holes and
// still exits 0. manifest.preflight.clock is what later commands use to parse
// started_time/ended_time, so a silently empty preflight poisons the snapshot.
describe('runAuth preflight validation', () => {
  let dir: string
  let usersMeResponse: unknown
  let accountsResponse: unknown
  let companyResponse: unknown

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-auth-bad-'))
    accountsResponse = ACCOUNTS
    companyResponse = COMPANY
    usersMeResponse = { id: 1, access_roles: ['administrator'] }
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('id.getharvest.com'))
          return Promise.resolve(jsonResponse(accountsResponse))
        if (url.includes('/v2/company')) return Promise.resolve(jsonResponse(companyResponse))
        if (url.includes('/v2/users/me')) return Promise.resolve(jsonResponse(usersMeResponse))
        throw new Error(`unexpected url ${url}`)
      }),
    )
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  const expectRefusal = async (contains: string[]): Promise<void> => {
    const err = await runAuth({
      env: baseEnv,
      toolVersion: '0.0.0',
      snapshotDir: dir,
      log: () => {},
    }).catch((e: unknown) => e as Error)

    expect(err).toBeInstanceOf(Error)
    for (const fragment of contains) {
      expect((err as Error).message).toContain(fragment)
    }
    // and nothing half-formed is left for extract to resume from
    expect(await readManifestIfExists(dir)).toBeNull()
  }

  it('[unit] refuses a /v2/company response missing clock', async () => {
    companyResponse = { name: 'CONFLICT', full_domain: 'acme.harvestapp.com' }
    await expectRefusal(['/v2/company', 'clock', 'missing'])
  })

  it('[unit] refuses a /v2/company response whose feature flags are not booleans', async () => {
    companyResponse = { ...COMPANY, approval_feature: 'true' }
    await expectRefusal(['/v2/company', 'approval_feature', 'expected a boolean'])
  })

  it('[unit] refuses a /v2/users/me response without access_roles', async () => {
    usersMeResponse = { id: 1 }
    await expectRefusal(['/v2/users/me', 'access_roles'])
  })

  it('[unit] refuses an accounts response that is not the documented shape', async () => {
    accountsResponse = { user: ACCOUNTS.user }
    await expectRefusal(['accounts', 'expected an array'])
  })
})
