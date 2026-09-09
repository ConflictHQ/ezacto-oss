import { describe, expect, it } from 'vitest'
import {
  applyDensity,
  browserDensityStore,
  createDensityRuntime,
  DEFAULT_DENSITY,
  resolveDensity,
  type Density,
  type DensityTarget,
} from '../src/density.js'

const target = () => {
  const attributes = new Map<string, string>()
  const element: DensityTarget & { value(): string | null } = {
    setAttribute: (name, value) => {
      attributes.set(name, value)
    },
    removeAttribute: (name) => {
      attributes.delete(name)
    },
    value: () => attributes.get('data-density') ?? null,
  }
  return element
}

const memoryStore = (initial: string | null = null) => {
  let stored = initial
  return {
    read: () => stored,
    write: (density: string) => {
      stored = density
    },
    stored: () => stored,
  }
}

describe('row density', () => {
  it('[unit] treats anything it does not recognise as the default', () => {
    // A display preference read back from storage someone else wrote, or from a
    // version that spelled it differently. None of those is worth an error.
    expect(resolveDensity('compact')).toBe('compact')
    expect(resolveDensity('comfortable')).toBe('comfortable')
    for (const stored of [null, '', 'cosy', 'COMPACT', 'true']) {
      expect(resolveDensity(stored), stored ?? 'null').toBe(DEFAULT_DENSITY)
    }
  })

  it('[unit] writes no attribute for the default, so the stylesheet stays the source', () => {
    // Comfortable is `:root`'s own --ez-row-h. Setting a second copy of those
    // values under an attribute is how the two come to disagree.
    const element = target()
    applyDensity(element, 'compact')
    expect(element.value()).toBe('compact')
    applyDensity(element, 'comfortable')
    expect(element.value()).toBeNull()
  })

  it('[unit] applies the stored preference before anything else runs', () => {
    // It has nothing to wait for: the shell should not paint comfortable and
    // then jump when a session resolves.
    const element = target()
    const runtime = createDensityRuntime({ store: memoryStore('compact'), target: element })

    expect(runtime.start()).toBe('compact')
    expect(element.value()).toBe('compact')
  })

  it('[unit] remembers a change for the next visit', () => {
    const store = memoryStore()
    const element = target()
    const runtime = createDensityRuntime({ store, target: element })
    runtime.start()

    expect(runtime.set('compact')).toBe('compact')
    expect(store.stored()).toBe('compact')
    expect(element.value()).toBe('compact')
    expect(runtime.current()).toBe('compact')

    runtime.set('comfortable')
    expect(store.stored()).toBe('comfortable')
    expect(element.value()).toBeNull()
  })

  it('[unit] survives storage that throws', () => {
    // Private windows and embedded frames with site data blocked throw on both
    // accessors. A row-height preference is not worth a broken shell.
    const hostile: Storage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    } as unknown as Storage
    const store = browserDensityStore(hostile)
    const element = target()

    expect(store.read()).toBeNull()
    expect(() => store.write('compact')).not.toThrow()
    const runtime = createDensityRuntime({ store, target: element })
    expect(runtime.start()).toBe(DEFAULT_DENSITY)
    expect(() => runtime.set('compact' satisfies Density)).not.toThrow()
    expect(element.value()).toBe('compact')
  })
})
