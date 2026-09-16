import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEXT_SIZE,
  applyTextSize,
  browserTextSizeStore,
  createTextSizeRuntime,
  resolveTextSize,
  textSizes,
  type TextSizeTarget,
} from '../src/text-size.js'

const target = () => {
  const attributes = new Map<string, string>()
  const element: TextSizeTarget & { value(): string | null } = {
    setAttribute: (name, value) => {
      attributes.set(name, value)
    },
    removeAttribute: (name) => {
      attributes.delete(name)
    },
    value: () => attributes.get('data-text-size') ?? null,
  }
  return element
}

const memoryStore = (initial: string | null = null) => {
  let stored = initial
  return {
    read: () => stored,
    write: (size: string) => {
      stored = size
    },
    stored: () => stored,
  }
}

describe('text size (issue 800)', () => {
  it('[unit] anything unrecognised is the default, not an error', () => {
    expect(resolveTextSize(null)).toBe(DEFAULT_TEXT_SIZE)
    expect(resolveTextSize('huge')).toBe(DEFAULT_TEXT_SIZE)
    for (const size of textSizes) expect(resolveTextSize(size)).toBe(size)
  })

  it('[unit] the default removes the attribute so the stylesheet keeps one copy of its sizes', () => {
    const root = target()
    applyTextSize(root, 'large')
    expect(root.value()).toBe('large')
    applyTextSize(root, 'default')
    expect(root.value()).toBeNull()
  })

  it('[unit] a choice is applied at once and remembered for the next visit', () => {
    const store = memoryStore()
    const root = target()
    const runtime = createTextSizeRuntime({ store, target: root })
    expect(runtime.start()).toBe('default')
    expect(runtime.set('larger')).toBe('larger')
    expect(root.value()).toBe('larger')
    expect(store.stored()).toBe('larger')

    const next = createTextSizeRuntime({ store, target: target() })
    expect(next.start()).toBe('larger')
  })

  it('[unit] storage that throws means the default, quietly', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage
    const store = browserTextSizeStore(broken)
    expect(store.read()).toBeNull()
    expect(() => store.write('large')).not.toThrow()
  })
})
