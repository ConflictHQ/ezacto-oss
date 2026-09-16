/**
 * Text size, and where it is remembered.
 *
 * Every font size in the stylesheet is a pixel literal, so a person who finds
 * the text small had only the browser zoom, which scales the chrome with it
 * (issue 800). This is the same shape as row density, for the same reason: how
 * large someone wants the type is a fact about their eyes and their monitor,
 * not about the company's books, so it is browser storage rather than a
 * column, and nobody else's screen changes because of it.
 */

export const textSizes = ['small', 'default', 'large', 'larger'] as const
export type TextSize = (typeof textSizes)[number]

export const DEFAULT_TEXT_SIZE: TextSize = 'default'

export interface TextSizeStore {
  read(): string | null
  write(size: string): void
}

export interface TextSizeTarget {
  setAttribute(name: 'data-text-size', value: string): void
  removeAttribute(name: 'data-text-size'): void
}

const isTextSize = (candidate: string | null): candidate is TextSize =>
  candidate !== null && (textSizes as readonly string[]).includes(candidate)

/** Anything unrecognised is the default rather than an error: it is a display preference. */
export const resolveTextSize = (stored: string | null): TextSize =>
  isTextSize(stored) ? stored : DEFAULT_TEXT_SIZE

/**
 * The default removes the attribute rather than setting it, so the stylesheet's
 * own sizes stay the one copy and not a second one that could drift.
 */
export const applyTextSize = (target: TextSizeTarget, size: TextSize): void => {
  if (size === 'default') target.removeAttribute('data-text-size')
  else target.setAttribute('data-text-size', size)
}

export interface TextSizeRuntime {
  current(): TextSize
  start(): TextSize
  set(size: TextSize): TextSize
}

export const createTextSizeRuntime = (options: {
  readonly store: TextSizeStore
  readonly target: TextSizeTarget
}): TextSizeRuntime => {
  let size = resolveTextSize(options.store.read())
  return {
    current: () => size,
    start: () => {
      applyTextSize(options.target, size)
      return size
    },
    set: (next) => {
      size = next
      options.store.write(next)
      applyTextSize(options.target, next)
      return size
    },
  }
}

export const TEXT_SIZE_STORAGE_KEY = 'ezacto.text-size'

/**
 * Storage throws in a private window and in an embedded frame with site data
 * blocked. A display preference is not worth a broken shell, so a failure to
 * read or write means the default, quietly.
 */
export const browserTextSizeStore = (storage: Storage): TextSizeStore => ({
  read: () => {
    try {
      return storage.getItem(TEXT_SIZE_STORAGE_KEY)
    } catch {
      return null
    }
  },
  write: (size) => {
    try {
      storage.setItem(TEXT_SIZE_STORAGE_KEY, size)
    } catch {
      // Preference lost on this machine; the shell still renders.
    }
  },
})
