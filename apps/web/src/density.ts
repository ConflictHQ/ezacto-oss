/**
 * Row density, and where it is remembered.
 *
 * §6 of the legacy-UI analysis asks for "a Comfortable / Compact toggle
 * persisted per user, swapping to 32/40". The CSS for it shipped —
 * `[data-density='compact']` overrides `--ez-row-h` and `--ez-row-h-lead` — and
 * nothing ever set the attribute, so the rule matched no document and the
 * setting existed only as a stylesheet nobody could reach.
 *
 * Per-user rather than per-organisation on purpose: how many rows someone wants
 * above the fold is a fact about their eyes and their monitor, not about the
 * company's books. That makes it browser storage rather than a column — it
 * follows the person on the machine they set it on, and nobody else's screen
 * changes because of it.
 */

export type Density = 'comfortable' | 'compact'

export const DEFAULT_DENSITY: Density = 'comfortable'

export interface DensityStore {
  read(): string | null
  write(density: string): void
}

export interface DensityTarget {
  setAttribute(name: 'data-density', value: string): void
  removeAttribute(name: 'data-density'): void
}

const isDensity = (candidate: string | null): candidate is Density =>
  candidate === 'comfortable' || candidate === 'compact'

/** Anything unrecognised is the default rather than an error: it is a display preference. */
export const resolveDensity = (stored: string | null): Density =>
  isDensity(stored) ? stored : DEFAULT_DENSITY

/**
 * Comfortable removes the attribute rather than setting it, so the default is
 * the stylesheet's own `:root` values and not a second copy of them that could
 * drift.
 */
export const applyDensity = (target: DensityTarget, density: Density): void => {
  if (density === 'comfortable') target.removeAttribute('data-density')
  else target.setAttribute('data-density', density)
}

export interface DensityRuntime {
  current(): Density
  start(): Density
  set(density: Density): Density
}

export const createDensityRuntime = (options: {
  readonly store: DensityStore
  readonly target: DensityTarget
}): DensityRuntime => {
  let density = resolveDensity(options.store.read())
  return {
    current: () => density,
    start: () => {
      applyDensity(options.target, density)
      return density
    },
    set: (next) => {
      density = next
      options.store.write(next)
      applyDensity(options.target, next)
      return density
    },
  }
}

export const DENSITY_STORAGE_KEY = 'ezacto.density'

/**
 * Storage throws in a private window and in an embedded frame with site data
 * blocked. A display preference is not worth a broken shell, so a failure to
 * read or write means the default, quietly.
 */
export const browserDensityStore = (storage: Storage): DensityStore => ({
  read: () => {
    try {
      return storage.getItem(DENSITY_STORAGE_KEY)
    } catch {
      return null
    }
  },
  write: (density) => {
    try {
      storage.setItem(DENSITY_STORAGE_KEY, density)
    } catch {
      // Preference lost on this machine; the shell still renders.
    }
  },
})
