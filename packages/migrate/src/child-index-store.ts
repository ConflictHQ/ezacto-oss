/**
 * Where the loader keeps its child index (issue 409, slice 2).
 *
 * To resume a child resource (a time entry under its project, an invoice line
 * under its invoice) without rescanning from row zero, the loader builds a
 * fixed-width index of where each parent's children start and end. It was
 * written straight to `raw/.load-index` beside the snapshot, behind an
 * `owner.json` directory lock, so a load that is not running on the machine
 * holding the snapshot had nowhere to put it.
 *
 * This is the narrow port the loader now builds and reads that index through.
 * A store is a flat namespace of named byte files with random access, atomic
 * small text writes and rename, plus one mutual-exclusion turn for the builder.
 * That is exactly what the builder already did with the filesystem, so the
 * build, resume and complete-detection code is shared by every store and none
 * of it knows which one it has.
 *
 * Two implementations: files under the snapshot (the CLI path, behaviour
 * unchanged) and memory (a platform run, no disk). A memory store dies with its
 * process, which is safe: a missing index is rebuilt from the snapshot, the
 * cost being the work already done, never a wrong answer.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

/** One open index file. Positions are byte offsets. */
export interface IndexFile {
  size(): Promise<number>
  /** Up to `length` bytes from `position`; shorter only at the end of the file. */
  read(position: number, length: number): Promise<Uint8Array>
  write(text: string, position: number): Promise<void>
  truncate(size: number): Promise<void>
  /** Make everything written so far durable. */
  sync(): Promise<void>
  /** Idempotent. */
  close(): Promise<void>
}

export type IndexOpenMode =
  /** Existing file, read only. */
  | 'read'
  /** Existing file, read and write. */
  | 'update'
  /** Created, or emptied if present; read and write. */
  | 'create'

export interface ChildIndexStore {
  /**
   * The most index bytes this store will hold, or null when it is bounded only
   * by its medium. The loader checks the whole snapshot's need against it
   * before building anything, so an oversize run fails at once rather than
   * partway through.
   */
  readonly budgetBytes: number | null
  /** Rejects with `code: 'ENOENT'` when `read` or `update` finds no such file. */
  open(name: string, mode: IndexOpenMode): Promise<IndexFile>
  /** Rejects with `code: 'ENOENT'` when absent. */
  readText(name: string): Promise<string>
  /** Replaces the whole text atomically: a reader sees the old text or the new. */
  writeText(name: string, text: string): Promise<void>
  /** Absent is not an error. */
  remove(name: string): Promise<void>
  /** Replaces `to` if present. */
  rename(from: string, to: string): Promise<void>
  /** Clears what a crashed builder leaves half-made. Called inside `exclusive`. */
  tidy(): Promise<void>
  /** Runs `action` as the only index builder against this store. */
  exclusive<T>(action: () => Promise<T>): Promise<T>
}

const enoent = (name: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${name} is not in the child index store`), { code: 'ENOENT' })

// --- memory ------------------------------------------------------------

class MemoryBlob {
  data: Uint8Array = new Uint8Array(0)
}

const memoryFile = (blob: MemoryBlob): IndexFile => {
  let closed = false
  const live = (): void => {
    if (closed) throw Object.assign(new Error('index file is closed'), { code: 'EBADF' })
  }
  return {
    size: async () => (live(), blob.data.length),
    read: async (position, length) => (live(), blob.data.slice(position, position + length)),
    write: async (text, position) => {
      live()
      const bytes = new TextEncoder().encode(text)
      if (position + bytes.length > blob.data.length) {
        const grown = new Uint8Array(position + bytes.length)
        grown.set(blob.data)
        blob.data = grown
      }
      blob.data.set(bytes, position)
    },
    truncate: async (size) => {
      live()
      const next = new Uint8Array(size)
      next.set(blob.data.subarray(0, size))
      blob.data = next
    },
    sync: async () => live(),
    close: async () => {
      closed = true
    },
  }
}

export interface MemoryChildIndexStore extends ChildIndexStore {
  /** Bytes held across every file, partial builds and checkpoints included. */
  heldBytes(): number
  /** Names currently held, sorted. */
  names(): string[]
}

export const memoryChildIndexStore = (
  options: { budgetBytes?: number } = {},
): MemoryChildIndexStore => {
  const blobs = new Map<string, MemoryBlob>()
  let turn: Promise<void> = Promise.resolve()
  const held = (name: string): MemoryBlob => {
    const found = blobs.get(name)
    if (found === undefined) throw enoent(name)
    return found
  }
  return {
    budgetBytes: options.budgetBytes ?? null,
    open: async (name, mode) => {
      if (mode === 'create') {
        const blob = new MemoryBlob()
        blobs.set(name, blob)
        return memoryFile(blob)
      }
      return memoryFile(held(name))
    },
    readText: async (name) => new TextDecoder().decode(held(name).data),
    writeText: async (name, text) => {
      const blob = new MemoryBlob()
      blob.data = new TextEncoder().encode(text)
      blobs.set(name, blob)
    },
    remove: async (name) => {
      blobs.delete(name)
    },
    rename: async (from, to) => {
      blobs.set(to, held(from))
      blobs.delete(from)
    },
    tidy: async () => undefined,
    exclusive: async (action) => {
      const previous = turn
      let release!: () => void
      turn = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      try {
        return await action()
      } finally {
        release()
      }
    },
    heldBytes: () => [...blobs.values()].reduce((sum, blob) => sum + blob.data.length, 0),
    names: () => [...blobs.keys()].sort(),
  }
}

// --- files -------------------------------------------------------------

const REMOTE_LOCK_STALE_MS = 5 * 60 * 1000

interface FileLockOwner {
  pid: number
  host: string
  token: string
  startedAt: number
}

interface FileLock {
  path: string
  token: string
}

const queues = new Map<string, Promise<void>>()

const pidIsLive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** The index as files in `<snapshotDir>/raw/.load-index`; the CLI path. */
export const fileChildIndexStore = (snapshotDir: string): ChildIndexStore => {
  const directory = join(snapshotDir, 'raw', '.load-index')
  const at = (name: string): string => join(directory, name)
  const lockPath = join(directory, '.builder.lock')

  const createLock = async (): Promise<FileLock> => {
    const token = randomUUID()
    const temporary = join(directory, `.builder.lock.claim-${process.pid}-${token}`)
    await mkdir(temporary)
    let installed = false
    try {
      const owner = await open(join(temporary, 'owner.json'), 'wx')
      try {
        const value: FileLockOwner = {
          pid: process.pid,
          host: hostname(),
          token,
          startedAt: Date.now(),
        }
        await owner.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
        await owner.sync()
      } finally {
        await owner.close()
      }
      await syncDirectory(temporary)
      await rename(temporary, lockPath)
      installed = true
      await syncDirectory(directory)
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      if (installed) await rm(lockPath, { recursive: true, force: true })
      throw error
    }
    return { path: lockPath, token }
  }

  const acquireLock = async (): Promise<FileLock> => {
    await mkdir(directory, { recursive: true })
    try {
      return await createLock()
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
    let owner: FileLockOwner
    try {
      owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as FileLockOwner
      if (
        !Number.isSafeInteger(owner.pid) ||
        owner.pid < 1 ||
        typeof owner.host !== 'string' ||
        typeof owner.token !== 'string' ||
        !Number.isSafeInteger(owner.startedAt) ||
        owner.startedAt < 0
      ) {
        throw new Error('invalid child-index lock owner')
      }
    } catch {
      throw new Error(`child index lock at ${lockPath} has no readable owner metadata`)
    }
    const remote = owner.host !== hostname()
    // A child-index turn is capped at 100 source rows and D1 itself caps an
    // invocation at 30 seconds. Preserve fresh cross-host owners, but let a new
    // executor recover a lock whose originating host disappeared long ago.
    const remoteExpired = remote && Date.now() - owner.startedAt > REMOTE_LOCK_STALE_MS
    if ((!remote && pidIsLive(owner.pid)) || (remote && !remoteExpired)) {
      throw new Error(`child index is already being built by pid ${owner.pid} on ${owner.host}`)
    }
    const staleGeneration = createHash('sha256').update(owner.token).digest('hex')
    try {
      await rename(lockPath, `${lockPath}.stale-${staleGeneration}`)
      await syncDirectory(directory)
      return await createLock()
    } catch (error) {
      if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new Error('child index is being reclaimed by another loader')
      }
      throw error
    }
  }

  const releaseLock = async (lock: FileLock): Promise<void> => {
    const owner = JSON.parse(
      await readFile(join(lock.path, 'owner.json'), 'utf8'),
    ) as FileLockOwner
    if (owner.token !== lock.token) throw new Error('refusing to release a changed child-index lock')
    await rm(lock.path, { recursive: true, force: true })
    await syncDirectory(directory)
  }

  return {
    budgetBytes: null,
    open: async (name, mode) => {
      if (mode === 'create') await mkdir(directory, { recursive: true })
      const handle = await open(at(name), mode === 'read' ? 'r' : mode === 'update' ? 'r+' : 'w+')
      let closed = false
      return {
        size: async () => (await handle.stat()).size,
        read: async (position, length) => {
          const buffer = Buffer.alloc(length)
          const { bytesRead } = await handle.read(buffer, 0, length, position)
          return buffer.subarray(0, bytesRead)
        },
        write: async (text, position) => {
          await handle.write(text, position, 'utf8')
        },
        truncate: (size) => handle.truncate(size),
        sync: async () => {
          await handle.sync()
          await syncDirectory(directory)
        },
        close: async () => {
          if (closed) return
          closed = true
          await handle.close()
        },
      }
    },
    readText: (name) => readFile(at(name), 'utf8'),
    writeText: async (name, text) => {
      await mkdir(directory, { recursive: true })
      const temporary = `${at(name)}.${process.pid}.${randomUUID()}.tmp`
      const handle = await open(temporary, 'wx')
      try {
        await handle.writeFile(text, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, at(name))
      await syncDirectory(directory)
    },
    remove: (name) => rm(at(name), { force: true }),
    rename: async (from, to) => {
      await rename(at(from), at(to))
      await syncDirectory(directory)
    },
    tidy: async () => {
      try {
        for (const entry of await readdir(directory)) {
          if (entry.includes('.state.json.') && entry.endsWith('.tmp')) {
            await rm(at(entry), { force: true })
          } else if (entry.startsWith('.builder.lock.claim-')) {
            await rm(at(entry), { recursive: true, force: true })
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
    exclusive: async (action) => {
      const previous = queues.get(directory) ?? Promise.resolve()
      let releaseTurn!: () => void
      const turn = new Promise<void>((resolve) => {
        releaseTurn = resolve
      })
      const queued = previous.catch(() => undefined).then(() => turn)
      queues.set(directory, queued)
      await previous.catch(() => undefined)
      let lock: FileLock | null = null
      try {
        lock = await acquireLock()
        return await action()
      } finally {
        try {
          if (lock !== null) await releaseLock(lock)
        } finally {
          releaseTurn()
          if (queues.get(directory) === queued) queues.delete(directory)
        }
      }
    },
  }
}
