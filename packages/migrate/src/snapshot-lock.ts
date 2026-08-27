// A snapshot is one mutable artifact shared by auth, extract and sync. This
// lock serializes their whole transactions, including sync's nested extract.

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

interface SnapshotLockOwner {
  pid: number
  host: string
  command: 'auth' | 'extract' | 'sync'
  started_at: string
  token: string
}

export interface SnapshotLock {
  path: string
  token: string
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
      (owner.command !== 'auth' && owner.command !== 'extract' && owner.command !== 'sync')
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
    throw new Error(`snapshot is locked by ${owner.command} (pid ${owner.pid}). Wait for it to finish.`)
  }

  // Atomically move the stale directory out of the lock name. Exactly one
  // contender can win this rename; unlike rm+mkdir, a loser can never delete a
  // new live lock the winner has already created.
  const quarantine = `${path}.stale-${randomUUID()}`
  try {
    await rename(path, quarantine)
    return await createLock(path, command)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Another contender claimed the stale directory. Read the lock it made
      // (or its own in-progress owner) rather than acting on the stale state.
      return acquireSnapshotLock(snapshotDir, command)
    }
    throw err
  } finally {
    await rm(quarantine, { recursive: true, force: true })
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
