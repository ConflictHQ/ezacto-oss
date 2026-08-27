// A snapshot is one mutable artifact shared by auth, extract and sync. This
// lock serializes their whole transactions, including sync's nested extract.

import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

interface SnapshotLockOwner {
  pid: number
  host: string
  command: 'auth' | 'extract' | 'sync'
  started_at: string
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

const writeOwner = async (path: string, command: SnapshotLockOwner['command']): Promise<void> => {
  const handle = await open(join(path, OWNER_FILE), 'w')
  try {
    const owner: SnapshotLockOwner = { pid: process.pid, host: hostname(), command, started_at: new Date().toISOString() }
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const createLock = async (path: string, command: SnapshotLockOwner['command']): Promise<string> => {
  await mkdir(path)
  try {
    await writeOwner(path, command)
  } catch (err) {
    // Do not strand an unreadable lock when the owner record cannot be made.
    await rm(path, { recursive: true, force: true })
    throw err
  }
  return path
}

export const acquireSnapshotLock = async (
  snapshotDir: string,
  command: SnapshotLockOwner['command'],
): Promise<string> => {
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

  // SIGKILL/restart leaves a dead local PID. It is the only unambiguous stale
  // owner, so it can be reclaimed automatically. A competing creator simply
  // wins the mkdir race below and is never removed by this caller.
  await rm(path, { recursive: true, force: true })
  try {
    return await createLock(path, command)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`snapshot is locked by another process that acquired ${path}`)
    }
    throw err
  }
}

export const releaseSnapshotLock = async (path: string): Promise<void> => {
  await rm(path, { recursive: true, force: true })
}
