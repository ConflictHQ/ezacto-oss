/** @vitest-environment happy-dom */

import { EzactoApiError, type Whoami } from '@conflict-hq/ezacto-client'
import { describe, expect, it, vi } from 'vitest'
import { createActivityController } from '../src/activity/browser.js'
import { renderActivityLogPage } from '../src/module-settings/render.js'
import { createReportsController } from '../src/reports/browser.js'
import type { ReportWorkspaceApi } from '../src/reports/model.js'
import { renderAppShell, reportKindTabs } from '../src/index.js'

const disabled = (): EzactoApiError =>
  new EzactoApiError(
    403,
    { error: { code: 'module_disabled', message: 'The activity log module is not enabled.' } },
    'req-1',
  )

const administrator: Whoami = {
  user_id: 1,
  profile: 'administrator',
  manager_grants: [],
  authentication: { kind: 'session' },
}

const writeDocument = (path: string): void => {
  window.history.replaceState(null, '', path)
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'activity-module-gating-test',
      activeSection: 'Reports',
      view: 'reports',
      tabs: reportKindTabs(new URL(path, 'https://example.test').searchParams.get('report')),
    })
      .replace(/ {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu, '')
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const emptyPage = { data: [], page: { next_cursor: null } }
const unused = () => vi.fn(async () => ({}) as never)

const reportsApi = (overrides: Partial<ReportWorkspaceApi> = {}): Partial<ReportWorkspaceApi> => ({
  listReportClients: vi.fn(async () => emptyPage),
  listReportProjects: vi.fn(async () => emptyPage),
  getUninvoicedReport: unused(),
  getClientRollupReport: unused(),
  getProjectBudgetReport: unused(),
  getMyHoursReport: unused(),
  getContractorCostReport: unused(),
  getDetailedTimeReport: unused(),
  getTimeReport: unused(),
  getInvoicedReport: unused(),
  getPaymentsReceivedReport: unused(),
  getReceivablesReport: unused(),
  getDetailedExpenseReport: unused(),
  getProfitabilityReport: unused(),
  getActivityLog: vi.fn(async () => []),
  ...overrides,
})

const activityTab = (): Element | undefined =>
  [...document.querySelectorAll('.tabstrip a')].find((tab) =>
    tab.textContent?.includes('Activity log'),
  )

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
}

describe('activity log module gating', () => {
  it('[browser] says the module is switched off, rather than failing, on a deep link to /settings/activity', async () => {
    document.body.innerHTML = renderActivityLogPage('settings-activity')
    const listActivityLog = vi.fn(async () => {
      throw disabled()
    })
    await createActivityController({ listActivityLog }).activate(new AbortController().signal)

    const status = document.querySelector<HTMLElement>('[data-activity-log-status]')!
    expect(status.textContent).toBe('The Activity log module is switched off for this organization.')
    expect(document.querySelector('[data-activity-log-list]')?.textContent).toBe('')
    expect(document.querySelector<HTMLInputElement>('[data-activity-from]')?.disabled).toBe(true)
  })

  it('[browser] still reports a real failure as a failure', async () => {
    document.body.innerHTML = renderActivityLogPage('settings-activity')
    const listActivityLog = vi.fn(async () => {
      throw new EzactoApiError(500, { error: { code: 'internal' } }, 'req-2')
    })
    await createActivityController({ listActivityLog }).activate(new AbortController().signal)

    expect(document.querySelector<HTMLInputElement>('[data-activity-from]')?.disabled).toBe(false)
    expect(
      document.querySelector<HTMLElement>('[data-activity-log-status]')?.textContent,
    ).not.toContain('switched off')
  })

  it('[browser] removes the Reports tab entry when the module is off', async () => {
    writeDocument('/reports?report=time&from=2026-08-01&to=2026-08-31')
    expect(activityTab()).toBeDefined()
    const getActivityLogEnabled = vi.fn(async () => false)
    await createReportsController(reportsApi({ getActivityLogEnabled })).activate(
      administrator,
      new AbortController().signal,
      () => false,
    )
    await settle()

    expect(getActivityLogEnabled).toHaveBeenCalled()
    expect(activityTab()).toBeUndefined()
  })

  it('[browser] keeps the Reports tab entry when the module is on', async () => {
    writeDocument('/reports?report=time&from=2026-08-01&to=2026-08-31')
    await createReportsController(
      reportsApi({ getActivityLogEnabled: vi.fn(async () => true) }),
    ).activate(administrator, new AbortController().signal, () => false)
    await settle()

    expect(activityTab()).toBeDefined()
  })

  it('[browser] shows the standard disabled state on a deep link, with no retry, and drops the tab', async () => {
    writeDocument('/reports?report=activity-log&from=2026-08-01&to=2026-08-31')
    const getActivityLog = vi.fn(async () => {
      throw disabled()
    })
    await createReportsController(reportsApi({ getActivityLog })).activate(
      administrator,
      new AbortController().signal,
      () => false,
    )
    await settle()

    expect(getActivityLog).toHaveBeenCalled()
    expect(document.querySelector('[data-report-status]')?.textContent).toBe(
      'The Activity log module is switched off.',
    )
    expect(document.querySelector<HTMLElement>('[data-report-retry]')?.hidden).toBe(true)
    expect(activityTab()).toBeUndefined()
  })
})
