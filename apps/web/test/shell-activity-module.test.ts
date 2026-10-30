/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import {
  browserApi,
  identity,
  mountShell,
  renderBrowserShell,
  type ShellApi,
} from './support/shell-harness.js'

const tab = (): HTMLElement => document.querySelector<HTMLElement>('[data-settings-activity-tab]')!

const openPalette = (): void => {
  document.querySelector<HTMLButtonElement>('[data-command-trigger]')!.click()
}

const paletteLabels = (): string[] =>
  [...document.querySelectorAll<HTMLAnchorElement>('[data-command-option]')].map(
    (option) => option.textContent ?? '',
  )

const apiWith = (getActivityLogEnabled: ShellApi['getActivityLogEnabled']): ShellApi => ({
  ...browserApi(),
  whoami: vi.fn(async () => identity),
  ...(getActivityLogEnabled === undefined ? {} : { getActivityLogEnabled }),
})

describe('activity log module in the shell', () => {
  it('[e2e] keeps the Activity tab and palette entry for an administrator when the module is on', async () => {
    renderBrowserShell()
    const enabled = vi.fn(async () => true)
    await mountShell(apiWith(enabled))
    await vi.waitFor(() => expect(enabled).toHaveBeenCalled())
    await vi.waitFor(() => expect(tab().hidden).toBe(false))

    openPalette()
    expect(paletteLabels()).toContain('Activity log')
  })

  it('[e2e] removes the Activity tab and palette entry when the module is off', async () => {
    renderBrowserShell()
    const enabled = vi.fn(async () => false)
    await mountShell(apiWith(enabled))
    await vi.waitFor(() => expect(enabled).toHaveBeenCalled())
    await vi.waitFor(() => expect(tab().hidden).toBe(true))

    openPalette()
    expect(paletteLabels()).not.toContain('Activity log')
    // Hiding the surface is not hiding the rest of company settings.
    expect(document.querySelector<HTMLElement>('[data-settings-company-tab]')!.hidden).toBe(false)
  })

  it('[e2e] leaves the tab alone when the status cannot be read', async () => {
    renderBrowserShell()
    const enabled = vi.fn(async () => {
      throw new Error('offline')
    })
    await mountShell(apiWith(enabled))
    await vi.waitFor(() => expect(enabled).toHaveBeenCalled())
    await vi.waitFor(() => expect(tab().hidden).toBe(false))
  })
})
