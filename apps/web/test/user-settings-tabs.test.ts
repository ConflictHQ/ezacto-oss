import { describe, expect, it } from 'vitest'
import { renderModuleSettingsPage } from '../src/module-settings/render.js'
import { USER_SETTINGS_SECTIONS } from '../src/settings-sections.js'

describe('personal settings tabs', () => {
  const page = renderModuleSettingsPage('settings-user')

  it('[unit] gives every part a tab and a pane, and hides every pane until its tab is chosen', () => {
    for (const section of USER_SETTINGS_SECTIONS) {
      expect(page, `tab ${section.id}`).toContain(`data-settings-user-link="${section.id}"`)
      expect(page, `pane ${section.id}`).toMatch(
        new RegExp(`data-settings-user-pane="${section.id}" hidden>`),
      )
    }
  })

  it('[unit] keeps the Deel block inside the payouts pane, so it opens with it', () => {
    const payouts = page.indexOf('data-settings-user-pane="payouts"')
    const deel = page.indexOf('data-settings-payout-deel')
    const twoFactor = page.indexOf('data-settings-user-pane="two-factor"')
    expect(payouts).toBeGreaterThan(-1)
    expect(deel).toBeGreaterThan(payouts)
    expect(deel).toBeLessThan(twoFactor)
  })
})
