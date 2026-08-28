import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireSnapshotLock, releaseSnapshotLock } from '../src/snapshot-lock.js'

let dir: string

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

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
    expect(JSON.parse(await readFile(join(lock.path, 'owner.json'), 'utf8'))).toMatchObject({
      pid: process.pid,
      host: hostname(),
      command: 'extract',
    })
    await releaseSnapshotLock(lock)
  })

  it('[unit] lets exactly one delayed stale reader reclaim across repeated deterministic races', async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const snapshotDir = join(dir, `race-${attempt}`)
      const lockDir = join(snapshotDir, '.sync.lock')
      await mkdir(lockDir, { recursive: true })
      await writeFile(
        join(lockDir, 'owner.json'),
        JSON.stringify({
          pid: 2_147_483_647,
          host: hostname(),
          command: 'sync',
          started_at: '2026-08-26T00:00:00.000Z',
          token: `stale-${attempt}`,
        }),
      )

      const staleRead = deferred()
      const resumeDelayed = deferred()
      const delayed = acquireSnapshotLock(snapshotDir, 'auth', {
        beforeStaleRename: async () => {
          staleRead.resolve()
          await resumeDelayed.promise
        },
      })
      await staleRead.promise

      const winner = await acquireSnapshotLock(snapshotDir, 'extract')
      const winnerOwner = await readFile(join(winner.path, 'owner.json'), 'utf8')
      resumeDelayed.resolve()

      const results = await Promise.allSettled([delayed, Promise.resolve(winner)])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results[0]).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ message: expect.stringContaining('another process') }),
      })
      expect(await readFile(join(winner.path, 'owner.json'), 'utf8')).toBe(winnerOwner)
      await releaseSnapshotLock(winner)
    }
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
    expect(await readFile(join(lockDir, 'owner.json'), 'utf8')).toContain('live')

    await rm(lockDir, { recursive: true, force: true })
    await mkdir(lockDir)
    await writeFile(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 1, host: 'another-host', command: 'sync', started_at: '2026-08-26T00:00:00.000Z', token: 'remote' }),
    )
    await expect(acquireSnapshotLock(dir, 'extract')).rejects.toThrow('remove')
    expect(await readFile(join(lockDir, 'owner.json'), 'utf8')).toContain('remote')
  })
})
