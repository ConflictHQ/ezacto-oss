/**
 * Whether this screen draws its amounts, and where that is remembered.
 *
 * **This is not a security control.** `canViewMoneyField` answers "may this
 * person read this field", and the answer decides what the server sends. This
 * answers "does the person at this keyboard want figures visible while somebody
 * is standing behind them", which is a different question with a different
 * scope: the payload still arrives, the screen still totals it, and the reader
 * chooses not to have it drawn. Routing this through the permission rule would
 * have returned false for an administrator who is entitled and corrupted every
 * other caller of it -- and dropped money out of payloads the screens need for
 * arithmetic. Anyone who can open the console can read the masked figure, and
 * that is the correct amount of protection for a control whose threat model is
 * a colleague's eyes.
 *
 * Shaped after `density.ts`, and for its reason: browser storage rather than a
 * column, because whether you want figures on screen right now is a fact about
 * who is in the room, not about the company's books. Nobody else's screen
 * changes because of it, and it follows the person on the machine they set it
 * on.
 *
 * The hiding itself is CSS over a marker, so a screen opts in by saying which
 * of its numbers are money. Hours, counts and percentages carry no marker and
 * are never touched -- masking a timesheet would be a different feature and a
 * worse one.
 */

export type MoneyDisplay = 'shown' | 'hidden'

export const DEFAULT_MONEY_DISPLAY: MoneyDisplay = 'shown'

export interface MoneyDisplayStore {
  read(): string | null
  write(display: string): void
}

export interface MoneyDisplayTarget {
  setAttribute(name: 'data-money', value: string): void
  removeAttribute(name: 'data-money'): void
}

const isMoneyDisplay = (candidate: string | null): candidate is MoneyDisplay =>
  candidate === 'shown' || candidate === 'hidden'

/** Anything unrecognised is the default rather than an error: it is a display preference. */
export const resolveMoneyDisplay = (stored: string | null): MoneyDisplay =>
  isMoneyDisplay(stored) ? stored : DEFAULT_MONEY_DISPLAY

/**
 * Shown removes the attribute rather than setting it, so an unmasked shell is
 * the stylesheet's own `:root` and not a second set of rules that could drift
 * from it.
 */
export const applyMoneyDisplay = (target: MoneyDisplayTarget, display: MoneyDisplay): void => {
  if (display === 'shown') target.removeAttribute('data-money')
  else target.setAttribute('data-money', display)
}

export interface MoneyDisplayRuntime {
  current(): MoneyDisplay
  start(): MoneyDisplay
  set(display: MoneyDisplay): MoneyDisplay
  toggle(): MoneyDisplay
}

export const createMoneyDisplayRuntime = (options: {
  readonly store: MoneyDisplayStore
  readonly target: MoneyDisplayTarget
}): MoneyDisplayRuntime => {
  let display = resolveMoneyDisplay(options.store.read())
  const set = (next: MoneyDisplay): MoneyDisplay => {
    display = next
    options.store.write(next)
    applyMoneyDisplay(options.target, next)
    return display
  }
  return {
    current: () => display,
    start: () => {
      applyMoneyDisplay(options.target, display)
      return display
    },
    set,
    toggle: () => set(display === 'hidden' ? 'shown' : 'hidden'),
  }
}

export const MONEY_DISPLAY_STORAGE_KEY = 'ezacto.money-display'

/**
 * Storage throws in a private window and in an embedded frame with site data
 * blocked. A display preference is not worth a broken shell, so a failure to
 * read or write means the default, quietly.
 */
export const browserMoneyDisplayStore = (storage: Storage): MoneyDisplayStore => ({
  read: () => {
    try {
      return storage.getItem(MONEY_DISPLAY_STORAGE_KEY)
    } catch {
      return null
    }
  },
  write: (display) => {
    try {
      storage.setItem(MONEY_DISPLAY_STORAGE_KEY, display)
    } catch {
      // Preference lost on this machine; the shell still renders.
    }
  },
})

/**
 * The marker every rendered amount carries. Nothing marked anything as money
 * before this, which is why the audit that put it on invoice totals, KPI
 * figures, report tables, rate columns and ledger rows was most of the work:
 * one stylesheet rule can only mask what has said it is an amount.
 *
 * A class rather than a data attribute because the shell already reads
 * `data-money` on the root for the state, and one word meaning two things one
 * selector apart is how a rule comes to match the wrong element.
 */
export const MONEY_CLASS = 'money'

/**
 * Marks (or unmarks) an element that already exists as holding an amount.
 * Unmarking matters: a card whose figure falls back to a dash or an error
 * sentence is no longer an amount, and dots drawn over "This could not be
 * loaded." would be a lie about what is behind them.
 */
export const markMoney = (element: Element, isMoney = true): void => {
  element.classList.toggle(MONEY_CLASS, isMoney)
}

/**
 * An amount as its own element, for the many places a figure is one part of a
 * cell, a list item or a sentence. Returning a node rather than a string is
 * what lets a column whose rows are money on one project and hours on the next
 * -- retainers and project budgets both are -- mark per row instead of lying at
 * the column level.
 */
export const moneyText = (text: string): HTMLSpanElement => {
  const element = document.createElement('span')
  element.className = MONEY_CLASS
  element.textContent = text
  return element
}
