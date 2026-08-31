// A snapshot is one mutable artifact shared by auth, extract, sync, verify,
// load, reconcile and the offline worksheets. This lock serializes their whole
// transactions, including sync's nested extract.

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

interface SnapshotLockOwner {
  pid: number
  host: string
  command: 'auth' | 'extract' | 'sync' | 'verify' | 'load' | 'reconcile' | 'worksheets'
  started_at: string
  token: string
}

export interface SnapshotLock {
  path: string
  token: string
}

interface SnapshotLockHooks {
  beforeStaleRename?: () => Promise<void>
}

const OWNER_FILE = 'owner.json'
const recovery = (path: string): string =>
  `If the owner is on another host, confirm it has stopped and remove ${path} manually before retrying.`

const pidIsLive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const writeOwner = async (
  path: string,
  command: SnapshotLockOwner['command'],
  token: string,
): Promise<void> => {
  const handle = await open(join(path, OWNER_FILE), 'w')
  try {
    const owner: SnapshotLockOwner = {
      pid: process.pid,
      host: hostname(),
      command,
      started_at: new Date().toISOString(),
      token,
    }
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const createLock = async (
  path: string,
  command: SnapshotLockOwner['command'],
): Promise<SnapshotLock> => {
  await mkdir(path)
  const token = randomUUID()
  try {
    await writeOwner(path, command, token)
  } catch (err) {
    // Do not strand an unreadable lock when the owner record cannot be made.
    await rm(path, { recursive: true, force: true })
    throw err
  }
  return { path, token }
}

export const acquireSnapshotLock = async (
  snapshotDir: string,
  command: SnapshotLockOwner['command'],
  hooks: SnapshotLockHooks = {},
): Promise<SnapshotLock> => {
  const path = join(snapshotDir, '.sync.lock')
  await mkdir(snapshotDir, { recursive: true })
  try {
    return await createLock(path, command)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }

  let owner: SnapshotLockOwner
  try {
    owner = JSON.parse(await readFile(join(path, OWNER_FILE), 'utf8')) as SnapshotLockOwner
    if (
      typeof owner.pid !== 'number' ||
      typeof owner.host !== 'string' ||
      typeof owner.token !== 'string' ||
      (owner.command !== 'auth' &&
        owner.command !== 'extract' &&
        owner.command !== 'sync' &&
        owner.command !== 'verify' &&
        owner.command !== 'load' &&
        owner.command !== 'reconcile' &&
        owner.command !== 'worksheets')
    ) {
      throw new Error('invalid owner')
    }
  } catch {
    throw new Error(`snapshot lock at ${path} has no readable owner metadata. ${recovery(path)}`)
  }
  if (owner.host !== hostname()) {
    throw new Error(
      `snapshot is locked by ${owner.command} on ${owner.host} (pid ${owner.pid}). ${recovery(path)}`,
    )
  }
  if (pidIsLive(owner.pid)) {
    throw new Error(
      `snapshot is locked by ${owner.command} (pid ${owner.pid}). Wait for it to finish.`,
    )
  }

  // Atomically move this exact stale generation out of the lock name. The
  // generation-specific tombstone deliberately remains beside the snapshot:
  // a contender that read the old owner and pauses until after a winner creates
  // a new lock still cannot rename that new lock over the non-empty tombstone.
  // Removing it here reintroduces that ABA race.
  const staleGeneration = createHash('sha256').update(owner.token).digest('hex')
  const quarantine = `${path}.stale-${staleGeneration}`
  await hooks.beforeStaleRename?.()
  try {
    await rename(path, quarantine)
    return await createLock(path, command)
  } catch (err) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes((err as NodeJS.ErrnoException).code ?? '')) {
      throw new Error(`snapshot is locked by another process reclaiming ${path}`)
    }
    throw err
  }
}

export const releaseSnapshotLock = async (lock: SnapshotLock): Promise<void> => {
  let owner: SnapshotLockOwner
  try {
    owner = JSON.parse(await readFile(join(lock.path, OWNER_FILE), 'utf8')) as SnapshotLockOwner
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  if (owner.token !== lock.token) {
    throw new Error(`refusing to release ${lock.path}: lock ownership changed`)
  }
  await rm(lock.path, { recursive: true, force: true })
}
