/** Portable in-memory child index; file adapters live in child-index-store.ts. */
import type { ChildIndexStore, IndexFile } from './child-index-store.js'
const enoent = (name: string): Error & { code: string } =>
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
  snapshot(): ReadonlyMap<string, Uint8Array>
}

export const memoryChildIndexStore = (
  options: { budgetBytes?: number; initialFiles?: ReadonlyMap<string, Uint8Array> } = {},
): MemoryChildIndexStore => {
  const blobs = new Map<string, MemoryBlob>()
  for (const [name, bytes] of options.initialFiles ?? []) {
    const blob = new MemoryBlob()
    blob.data = new Uint8Array(bytes)
    blobs.set(name, blob)
  }
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
    snapshot: () => new Map([...blobs].map(([name, blob]) => [name, blob.data.slice()])),
  }
}
