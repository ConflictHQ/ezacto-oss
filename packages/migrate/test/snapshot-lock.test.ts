import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireSnapshotLock, releaseSnapshotLock } from '../src/snapshot-lock.js'

let dir: string

describe('snapshot mutation lock', () => {
  beforeEach(async () => {
    dir = await mkdtemp('/tmp/ezacto-migrate-lock-')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('[unit] reclaims a demonstrably stale local PID left by SIGKILL/restart', async () => {
    const lockDir = join(dir, '.sync.lock')
    await mkdir(lockDir)
    await writeFile(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 2_147_483_647, host: hostname(), command: 'sync', started_at: '2026-08-26T00:00:00.000Z', token: 'stale' }),
    )

    const lock = await acquireSnapshotLock(dir, 'extract')
    expect(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'))).toMatchObject({
      pid: process.pid,
      host: hostname(),
      command: 'extract',
    })
    await releaseSnapshotLock(lock)
  })

  it('[unit] lets exactly one of two contenders claim the same stale lock', async () => {
    const lockDir = join(dir, '.sync.lock')
    await mkdir(lockDir)
    await writeFile(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 2_147_483_647, host: hostname(), command: 'sync', started_at: '2026-08-26T00:00:00.000Z', token: 'stale' }),
    )

    const results = await Promise.allSettled([
      acquireSnapshotLock(dir, 'auth'),
      acquireSnapshotLock(dir, 'extract'),
    ])
    const acquired = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireSnapshotLock>>> =>
        result.status === 'fulfilled',
    )
    expect(acquired).toHaveLength(1)
    await releaseSnapshotLock(acquired[0].value)
  })

  it('[unit] never releases a lock whose owner token changed', async () => {
    const lock = await acquireSnapshotLock(dir, 'sync')
    await writeFile(
      join(lock.path, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: hostname(), command: 'extract', started_at: '2026-08-26T00:00:00.000Z', token: 'replacement' }),
    )

    await expect(releaseSnapshotLock(lock)).rejects.toThrow('ownership changed')
    expect(await readFile(join(lock.path, 'owner.json'), 'utf8')).toContain('replacement')
  })

  it('[unit] rejects a live local owner and cross-host ambiguity without deleting either lock', async () => {
    const lockDir = join(dir, '.sync.lock')
    await mkdir(lockDir)
    await writeFile(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: hostname(), command: 'auth', started_at: '2026-08-26T00:00:00.000Z', token: 'live' }),
    )
    await expect(acquireSnapshotLock(dir, 'extract')).rejects.toThrow('snapshot is locked by auth')

    await rm(lockDir, { recursive: true, force: true })
    await mkdir(lockDir)
    await writeFile(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 1, host: 'another-host', command: 'sync', started_at: '2026-08-26T00:00:00.000Z', token: 'remote' }),
    )
    await expect(acquireSnapshotLock(dir, 'extract')).rejects.toThrow('remove')
  })
})
