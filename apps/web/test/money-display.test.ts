/** @vitest-environment happy-dom */

import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthPrincipal, Session, Whoami } from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import { mountShell } from '../src/shell/browser.js'
import { renderAppShell, type ShellApi } from '../src/index.js'
import {
  applyMoneyDisplay,
  browserMoneyDisplayStore,
  createMoneyDisplayRuntime,
  DEFAULT_MONEY_DISPLAY,
  markMoney,
  moneyText,
  resolveMoneyDisplay,
  type MoneyDisplay,
  type MoneyDisplayTarget,
} from '../src/money-display.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const timestamp = '2026-09-01T12:00:00.000Z'

const filesUnder = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name)
      return entry.isDirectory() ? filesUnder(path) : Promise.resolve([path])
    }),
  )
  return paths.flat()
}

const target = () => {
  const attributes = new Map<string, string>()
  const element: MoneyDisplayTarget & { value(): string | null } = {
    setAttribute: (name, value) => {
      attributes.set(name, value)
    },
    removeAttribute: (name) => {
      attributes.delete(name)
    },
    value: () => attributes.get('data-money') ?? null,
  }
  return element
}

const memoryStore = (initial: string | null = null) => {
  let stored = initial
  return {
    read: () => stored,
    write: (display: string) => {
      stored = display
    },
    stored: () => stored,
  }
}

const identity: Whoami = {
  user_id: 4,
  profile: 'administrator',
  manager_grants: [],
  authentication: { kind: 'session' },
}

const principal: AuthPrincipal = {
  status: 'authenticated',
  user_id: 4,
  profile: 'administrator',
  manager_grants: [],
}

const session: Session = {
  id: 1,
  created_at: timestamp,
  last_seen_at: timestamp,
  idle_expires_at: timestamp,
  absolute_expires_at: timestamp,
  revoked_at: timestamp,
  revocation_reason: 'user_revoked',
  current: false,
}

const shellApi = (): ShellApi => ({
  whoami: vi.fn(async () => identity),
  signIn: vi.fn(async () => principal),
  logoutCurrentSession: vi.fn(async () => session),
  listProjects: vi.fn(async () => ({ data: [], page: { next_cursor: null } })),
  listTasks: vi.fn(async () => ({ data: [], page: { next_cursor: null } })),
  listTimeEntryOptions: vi.fn(async () => []),
  getTimeEntrySettings: vi.fn(async () => ({
    time_entry_mode: 'duration' as const,
    time_format: 'decimal' as const,
    clock: '12h' as const,
    week_start_day: 'monday' as const,
  })),
  listTimeEntries: vi.fn(async () => []),
  createTimeEntry: vi.fn(),
  updateTimeEntry: vi.fn(),
  deleteTimeEntry: vi.fn(),
  stopTimeEntry: vi.fn(),
  listTimesheetSubmissions: vi.fn(async () => []),
})

const writeShell = (): void => {
  window.history.replaceState(null, '', '/')
  globalThis.localStorage.clear()
  globalThis.sessionStorage.clear()
  document.open()
  document.write(
    renderAppShell({ environment: 'test', release: 'money-display-test' })
      .replace(
        / {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu,
        '',
      )
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const signedIn = async (): Promise<void> => {
  writeShell()
  await mountShell(shellApi())
  await vi.waitFor(() =>
    expect(document.querySelector('[data-current-profile]')?.textContent).toBe(
      'administrator',
    ),
  )
}

const toggle = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('[data-money-toggle]')!

const press = (key: string): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('money display preference', () => {
  it('[unit] treats anything it does not recognise as shown', () => {
    // Read back from storage another version wrote, or from a hand-edited
    // value. A display preference is not worth an error, and the safe
    // resolution is the one that shows the figures rather than the one that
    // silently hides an account's money for good.
    expect(resolveMoneyDisplay('hidden')).toBe('hidden')
    expect(resolveMoneyDisplay('shown')).toBe('shown')
    for (const stored of [null, '', 'HIDDEN', 'masked', 'true']) {
      expect(resolveMoneyDisplay(stored), stored ?? 'null').toBe(DEFAULT_MONEY_DISPLAY)
    }
    expect(DEFAULT_MONEY_DISPLAY).toBe('shown')
  })

  it('[unit] writes no attribute for shown, so an unmasked shell is the stylesheet default', () => {
    const element = target()
    applyMoneyDisplay(element, 'hidden')
    expect(element.value()).toBe('hidden')
    applyMoneyDisplay(element, 'shown')
    expect(element.value()).toBeNull()
  })

  it('[unit] applies the stored preference before anything else runs, and toggles from it', () => {
    // Nothing to wait for: a shell restored with amounts off must not paint
    // them once and then blink them away when a session resolves.
    const store = memoryStore('hidden')
    const element = target()
    const runtime = createMoneyDisplayRuntime({ store, target: element })

    expect(runtime.start()).toBe('hidden')
    expect(element.value()).toBe('hidden')
    expect(runtime.toggle()).toBe('shown')
    expect(element.value()).toBeNull()
    expect(store.stored()).toBe('shown')
    expect(runtime.toggle()).toBe('hidden')
    expect(runtime.current()).toBe('hidden')
    expect(store.stored()).toBe('hidden')
  })

  it('[unit] survives storage that throws', () => {
    const hostile: Storage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    } as unknown as Storage
    const store = browserMoneyDisplayStore(hostile)
    const element = target()

    expect(store.read()).toBeNull()
    expect(() => store.write('hidden')).not.toThrow()
    const runtime = createMoneyDisplayRuntime({ store, target: element })
    expect(runtime.start()).toBe(DEFAULT_MONEY_DISPLAY)
    expect(() => runtime.set('hidden' satisfies MoneyDisplay)).not.toThrow()
    expect(element.value()).toBe('hidden')
  })

  it('[unit] marks and unmarks an element that already exists', () => {
    // A card whose figure falls back to a dash or an error sentence is no
    // longer an amount, and the marker has to come off with the number.
    const element = document.createElement('strong')
    markMoney(element)
    expect(element.className).toBe('money')
    markMoney(element, false)
    expect(element.className).toBe('')
    expect(moneyText('$40.00').outerHTML).toBe('<span class="money">$40.00</span>')
  })

  it('[unit] masks the marked figure without taking its box out of the layout', async () => {
    // The rule that does the work. It is asserted here because the density
    // preference shipped as a stylesheet nothing ever set the attribute for --
    // CSS and the attribute have to be checked against each other, and the
    // browser test below is the other half of that pair.
    const stylesheet = await readFile(resolve(root, 'src', 'shell', 'shell.css'), 'utf8')
    const rule = /\[data-money='hidden'\] \.money \{([^}]*)\}/u.exec(stylesheet)
    expect(rule?.[1]).toBeDefined()
    // Masked, not removed: `display: none` or `content-visibility` would
    // collapse the cell and reflow the table, and a row that jumps as you hide
    // it is its own kind of attention.
    expect(rule![1]).toContain('visibility: hidden')
    expect(rule![1]).not.toContain('display: none')
    const dots = /\[data-money='hidden'\] \.money::after \{([^}]*)\}/u.exec(stylesheet)
    expect(dots?.[1]).toContain("content: '••••'")
    expect(dots![1]).toContain('visibility: visible')
  })

  it('[browser] hides amounts from the root on the toggle, and says so on the control', async () => {
    await signedIn()
    const control = toggle()
    expect(control.getAttribute('aria-pressed')).toBe('false')
    expect(document.documentElement.hasAttribute('data-money')).toBe(false)

    control.click()
    expect(document.documentElement.getAttribute('data-money')).toBe('hidden')
    expect(control.getAttribute('aria-pressed')).toBe('true')
    // The label names the next action rather than repeating the state, which
    // aria-pressed already carries.
    expect(control.getAttribute('aria-label')).toBe('Show money amounts ($)')

    control.click()
    expect(document.documentElement.hasAttribute('data-money')).toBe(false)
    expect(control.getAttribute('aria-pressed')).toBe('false')
    expect(control.getAttribute('aria-label')).toBe('Hide money amounts ($)')
  })

  it('[browser] takes the shortcut, because reaching for the mouse is already too slow', async () => {
    await signedIn()

    press('$')
    expect(document.documentElement.getAttribute('data-money')).toBe('hidden')
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    press('$')
    expect(document.documentElement.hasAttribute('data-money')).toBe(false)
  })

  it('[browser] leaves the key alone while it is being typed into a field', async () => {
    // Every unmodified binding in the shell checks this first: a dollar sign
    // typed into the command bar, a note or an amount box is a character, not a
    // command. The command bar is the likeliest of the three -- "$" is how you
    // would start typing a search for one.
    await signedIn()
    const field = document.querySelector<HTMLInputElement>('#ez-command')!
    field.focus()
    expect(document.activeElement).toBe(field)

    press('$')
    expect(document.documentElement.hasAttribute('data-money')).toBe(false)
  })

  it('[browser] remembers the choice for the next visit on this machine', async () => {
    // Per-viewer, like density: whether you want figures on screen is a fact
    // about who is in the room, not about the company's books. Nobody else's
    // screen changes with it.
    await signedIn()
    toggle().click()
    expect(globalThis.localStorage.getItem('ezacto.money-display')).toBe('hidden')

    // A second mount of the same document is the next page load.
    document.documentElement.removeAttribute('data-money')
    await mountShell(shellApi())
    await vi.waitFor(() =>
      expect(document.documentElement.getAttribute('data-money')).toBe('hidden'),
    )
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
  })

  it('[browser] marks the invoice totals the served shell ships with', async () => {
    // The shell serves the invoice document's totals as empty slots the browser
    // fills, so those four carry the marker in the markup rather than at the
    // point of the write.
    const markup = renderAppShell({ environment: 'test', release: 'money-display-test' })
    const marked = [
      ...markup.matchAll(/<dd class="money" data-invoice-detail-([a-z]+)>/gu),
    ].map((match) => match[1])
    expect(marked).toEqual(['discount', 'tax', 'total', 'due'])
  })

  it('[unit] holds every screen that draws an amount to the marker', async () => {
    // The audit is the feature: a rule that masks `.money` hides nothing on a
    // screen that never said which of its numbers are money, and the next screen
    // to render a total is the one that will forget. This is the standing guard
    // -- a controller that calls one of the currency formatters and does not
    // reach for the marker fails here rather than shipping a figure the toggle
    // cannot put away.
    const formatter =
      /\b(?:formatMoney|invoiceMoney|expenseMoney|projectMoney|retainerMoney|retainerAmount|recurringMoney|teamMoney|formatTaskRate|formatReportMoney|formatReportCents|retainerCommitmentLabel|retainerBalanceLabel|recurringAmountLabel|expenseCategoryPricingLabel)\(/u
    const controllers = (await filesUnder(resolve(root, 'src'))).filter(
      (path) => path.endsWith('browser.ts') && !path.includes('generated'),
    )
    const drawsMoney: string[] = []
    const unmarked: string[] = []
    for (const path of controllers) {
      const source = await readFile(path, 'utf8')
      if (!formatter.test(source)) continue
      drawsMoney.push(path)
      if (!source.includes("from '../money-display.js'")) unmarked.push(path)
    }
    // The count first, so a regex that matched nothing cannot pass this by
    // finding no offenders among no files.
    expect(drawsMoney.length).toBeGreaterThanOrEqual(10)
    expect(unmarked).toEqual([])
  })
})
