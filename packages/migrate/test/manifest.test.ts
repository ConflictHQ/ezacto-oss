import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readManifest,
  readManifestIfExists,
  writeManifest,
  type Manifest,
} from '../src/manifest.js'

describe('manifest', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-manifest-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('[unit] round-trips clock, timer mode, and the four feature flags', async () => {
    const manifest: Manifest = {
      account: { id: '123', name: 'CONFLICT' },
      company_name: 'CONFLICT',
      started_at: '2026-08-26T00:00:00.000Z',
      finished_at: null,
      tool_version: '0.0.0',
      preflight: {
        clock: '12h',
        wants_timestamp_timers: true,
        expense_feature: true,
        invoice_feature: false,
        estimate_feature: true,
        approval_feature: false,
      },
      resources: {},
      updated_since: {},
    }

    await writeManifest(dir, manifest)
    const read = await readManifest(dir)

    expect(read.preflight.clock).toBe('12h')
    expect(read.preflight.wants_timestamp_timers).toBe(true)
    expect(read.preflight.expense_feature).toBe(true)
    expect(read.preflight.invoice_feature).toBe(false)
    expect(read.preflight.estimate_feature).toBe(true)
    expect(read.preflight.approval_feature).toBe(false)
  })

  it('[unit] mkdir -p creates a missing snapshot directory', async () => {
    const nested = join(dir, 'nested', 'snapshot')
    const manifest: Manifest = {
      account: { id: '1', name: 'x' },
      company_name: 'x',
      started_at: 'now',
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
      resources: {},
      updated_since: {},
    }

    await writeManifest(nested, manifest)
    const read = await readManifest(nested)
    expect(read.account.id).toBe('1')
  })

  it('[unit] writes atomically: no partial file is left behind for extract to resume from', async () => {
    const manifest: Manifest = {
      account: { id: '1', name: 'x' },
      company_name: 'x',
      started_at: '2026-08-26T00:00:00.000Z',
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
      resources: {},
      updated_since: {},
    }

    await writeManifest(dir, manifest)
    await writeManifest(dir, manifest)

    expect(await readdir(dir)).toEqual(['manifest.json'])
  })

  it('[unit] readManifestIfExists returns null for a snapshot dir with no manifest yet', async () => {
    expect(await readManifestIfExists(dir)).toBeNull()
  })
})
