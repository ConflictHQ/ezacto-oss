import { describe, expect, it } from 'vitest'
import { renderAppShell } from '../src/shell/render.js'

const page = (options: object = {}) =>
  renderAppShell({ environment: 'test', release: 'abcdef012345', ...options })

describe('operator module switches in the shell markup (issue 1254)', () => {
  it('[unit] marks each switched-off module on the page and leaves the others unmarked', () => {
    const on = page()
    for (const module of ['sso', 'backups', 'invoices', 'accounting']) {
      expect(on).not.toContain(`data-${module}-unavailable`)
    }
    const off = page({
      ssoAvailable: false,
      backupsAvailable: false,
      invoicesAvailable: false,
      accountingAvailable: false,
    })
    for (const module of ['sso', 'backups', 'invoices', 'accounting']) {
      expect(off).toContain(`data-${module}-unavailable`)
    }
  })

  it('[unit] drops Invoices from the sidebar and the Menu only where invoices are off', () => {
    expect(page()).toContain('data-money-nav')
    expect(page()).toContain('menu-hint-invoices')
    const off = page({ invoicesAvailable: false })
    expect(off).not.toContain('data-money-nav')
    expect(off).not.toContain('menu-hint-invoices')
    expect(off).toContain('data-expenses-nav')
  })
})
