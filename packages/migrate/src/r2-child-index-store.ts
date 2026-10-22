/**
 * One conditional R2 object is the atomic directory/checkpoint for a bounded index.
 * A crashed or superseded builder can never publish half a rename/state update.
 * Every exclusive turn reloads the current directory; ETag CAS refuses stale turns.
 * https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations
 */
import { queuedMigrationLimits } from '@ezacto/core'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { sha256Hex } from './portable-hash.js'
import { memoryChildIndexStore, type MemoryChildIndexStore } from './memory-child-index-store.js'
import type { ChildIndexStore, IndexFile, IndexOpenMode } from './child-index-store.js'
export interface IndexBucket {
  get(
    key: string,
  ): Promise<{
    size: number
    etag: string
    checksums?: { sha256?: ArrayBuffer }
    arrayBuffer(): Promise<ArrayBuffer>
  } | null>
  put(
    key: string,
    value: string,
    options: {
      onlyIf: { etagMatches?: string; etagDoesNotMatch?: string }
      sha256: string
    },
  ): Promise<{ etag: string } | null>
}
export class R2ChildIndexConflictError extends Error {
  constructor() {
    super('The child index checkpoint changed during this turn; retry from the current checkpoint.')
    this.name = 'R2ChildIndexConflictError'
  }
}
export const DEFAULT_R2_INDEX_BUDGET = queuedMigrationLimits.indexBytes
const MAX_R2_INDEX_BUDGET = queuedMigrationLimits.maxIndexBytes
const MAX_FILES = 128
const safeName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(name)
interface Cache {
  memory: MemoryChildIndexStore
  etag: string | null
  dirty: boolean
}
export const r2ChildIndexStore = (
  bucket: IndexBucket,
  prefix: string,
  options: { budgetBytes?: number } = {},
): ChildIndexStore => {
  const budgetBytes = options.budgetBytes ?? DEFAULT_R2_INDEX_BUDGET
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1 || budgetBytes > MAX_R2_INDEX_BUDGET)
    throw new Error(
      `R2 child index budget must be 1–${MAX_R2_INDEX_BUDGET} bytes; use the local loader for larger indexes.`,
    )
  const segments = prefix.replace(/\/+$/u, '').split('/')
  if (segments.some((part) => !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..'))
    throw new Error('Invalid R2 child index prefix')
  const key = segments.join('/') + '/checkpoint.json'
  let cache: Cache | null = null,
    active = false,
    turn = Promise.resolve()
  const maximumObjectBytes = budgetBytes * 2 + 64 * 1024
  const validateSize = (memory: MemoryChildIndexStore) => {
    if (memory.heldBytes() > budgetBytes || memory.names().length > MAX_FILES)
      throw new Error(
        `Child index exceeds its ${budgetBytes}-byte Worker memory budget; use the local loader.`,
      )
  }
  const load = async (): Promise<Cache> => {
    const object = await bucket.get(key)
    const files = new Map<string, Uint8Array>()
    if (object !== null) {
      if (object.size > maximumObjectBytes)
        throw new Error('R2 child index checkpoint exceeds its size limit')
      const bytes = new Uint8Array(await object.arrayBuffer())
      if (bytes.length !== object.size) throw new Error('R2 child index checkpoint was truncated')
      if (
        object.checksums?.sha256 === undefined ||
        sha256Hex(bytes) !== bytesToHex(new Uint8Array(object.checksums.sha256))
      )
        throw new Error('R2 child index checkpoint checksum failed')
      const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
        version?: unknown
        revision?: unknown
        files?: unknown
      }
      if (
        document.version !== 1 ||
        typeof document.revision !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(document.revision) ||
        typeof document.files !== 'object' ||
        document.files === null ||
        Array.isArray(document.files)
      )
        throw new Error('Invalid R2 child index checkpoint')
      const entries = Object.entries(document.files)
      if (entries.length > MAX_FILES) throw new Error('Too many R2 child index files')
      let size = 0
      for (const [name, value] of entries) {
        if (
          !safeName(name) ||
          typeof value !== 'string' ||
          value.length % 2 !== 0 ||
          !/^[0-9a-f]*$/.test(value)
        )
          throw new Error('Invalid R2 child index file')
        size += value.length / 2
        if (size > budgetBytes) throw new Error('R2 child index files exceed their memory budget')
        files.set(name, hexToBytes(value))
      }
    }
    return {
      memory: memoryChildIndexStore({ budgetBytes, initialFiles: files }),
      etag: object?.etag ?? null,
      dirty: false,
    }
  }
  const current = async () => (cache ??= await load())
  const publish = async (expected: Cache) => {
    if (cache !== expected) throw new R2ChildIndexConflictError()
    validateSize(expected.memory)
    if (!expected.dirty) return
    const files = Object.fromEntries(
      [...expected.memory.snapshot()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, bytes]) => [name, bytesToHex(bytes)]),
    )
    // A nonce prevents ETag ABA even when a later checkpoint has identical files.
    const text = JSON.stringify({ version: 1, revision: crypto.randomUUID(), files })
    const stored = await bucket.put(key, text, {
      sha256: sha256Hex(text),
      onlyIf: expected.etag === null ? { etagDoesNotMatch: '*' } : { etagMatches: expected.etag },
    })
    if (stored === null) {
      cache = null
      throw new R2ChildIndexConflictError()
    }
    expected.etag = stored.etag
    expected.dirty = false
  }
  const exclusive = async <T,>(action: () => Promise<T>): Promise<T> => {
    const previous = turn
    let release!: () => void
    turn = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      cache = await load()
      active = true
      const result = await action()
      await publish(cache)
      return result
    } catch (error) {
      cache = null
      throw error
    } finally {
      active = false
      release()
    }
  }
  const mutation = async (action: (value: Cache) => Promise<void>) => {
    const apply = async () => {
      const value = await current()
      await action(value)
      value.dirty = true
      validateSize(value.memory)
    }
    if (active) await apply()
    else await exclusive(apply)
  }
  const open = async (name: string, mode: IndexOpenMode): Promise<IndexFile> => {
    if (!safeName(name)) throw new Error('Invalid child index filename')
    const owner = await current(),
      file = await owner.memory.open(name, mode)
    if (mode === 'create') owner.dirty = true
    let closed = false
    const writable = () => {
      if (closed) throw new Error('Child index file is closed')
      if (mode === 'read') throw new Error('Child index file is read-only')
      if (cache !== owner) throw new R2ChildIndexConflictError()
    }
    const sync = async () => {
      if (closed) throw new Error('Child index file is closed')
      await file.sync()
      if (!active && mode !== 'read') await publish(owner)
    }
    return {
      size: () => file.size(),
      read: (position, length) => file.read(position, length),
      write: async (text, position) => {
        writable()
        if (
          !Number.isSafeInteger(position) ||
          position < 0 ||
          position + new TextEncoder().encode(text).length > budgetBytes
        )
          throw new Error('Child index write exceeds its memory budget')
        await file.write(text, position)
        owner.dirty = true
        validateSize(owner.memory)
      },
      truncate: async (size) => {
        writable()
        if (!Number.isSafeInteger(size) || size < 0 || size > budgetBytes)
          throw new Error('Child index truncate exceeds its memory budget')
        await file.truncate(size)
        owner.dirty = true
        validateSize(owner.memory)
      },
      sync,
      close: async () => {
        if (closed) return
        try {
          await sync()
        } finally {
          closed = true
          await file.close()
        }
      },
    }
  }
  return {
    budgetBytes,
    open,
    exclusive,
    readText: async (name) => {
      if (!safeName(name)) throw new Error('Invalid child index filename')
      return (await current()).memory.readText(name)
    },
    writeText: async (name, text) => {
      if (!safeName(name)) throw new Error('Invalid child index filename')
      if (new TextEncoder().encode(text).length > budgetBytes)
        throw new Error('Child index text exceeds its memory budget')
      await mutation(async (value) => {
        await value.memory.writeText(name, text)
      })
    },
    remove: async (name) => {
      if (!safeName(name)) throw new Error('Invalid child index filename')
      await mutation(async (value) => value.memory.remove(name))
    },
    rename: async (from, to) => {
      if (!safeName(from) || !safeName(to)) throw new Error('Invalid child index filename')
      await mutation(async (value) => value.memory.rename(from, to))
    },
    tidy: async () => undefined,
  }
}
