/** @vitest-environment happy-dom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Whoami } from '@conflict-hq/ezacto-client'
import {
  createCompanyDataTools,
  renderCompanyDataTools,
} from '../src/module-settings/data-tools.js'
import { sessionPresenter } from '../src/session.js'
const controllers: AbortController[] = []
const active = (profile: Whoami['profile'] = 'administrator') => {
  const owner = new AbortController()
  controllers.push(owner)
  return {
    owner,
    signal: owner.signal,
    identity: {
      user_id: 1,
      profile,
      manager_grants: [],
      authentication: { kind: 'session' as const },
    },
    ...sessionPresenter(
      () => !owner.signal.aborted,
      () => false,
    ),
  }
}
const flags = [
  { module: 'expenses', enabled: false },
  { module: 'approval', enabled: false },
  { module: 'activity_log', enabled: false },
]
const by = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const urls = vi.fn<typeof URL.createObjectURL>(() => 'blob:company-data-fixture')
beforeEach(() => {
  document.body.innerHTML = renderCompanyDataTools()
  urls.mockClear()
  const OriginalURL = URL
  class FixtureURL extends OriginalURL {
    static createObjectURL = urls
    static revokeObjectURL = vi.fn()
  }
  vi.stubGlobal('URL', FixtureURL)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('downloads the requested range and format, with client-visible notes unless explicitly changed', async () => {
  const download = vi.fn(async () => ({
    blob: new Blob(['fixture']),
    filename: 'time-fixture.csv',
  }))
  const tools = createCompanyDataTools(
    {
      downloadDetailedTimeReport: download,
      getTimesheetLockPolicy: async () => ({ timezone: 'America/Costa_Rica' }),
    },
    async () => flags,
  )
  const session = active()
  await tools.loadExports(session)
  by<HTMLInputElement>('[data-settings-data-from]').value = '2026-08-01'
  by<HTMLInputElement>('[data-settings-data-to]').value = '2026-08-31'
  by<HTMLButtonElement>('[data-settings-data-download="time-csv"]').click()
  await vi.waitFor(() => expect(download).toHaveBeenCalledOnce())
  expect(download.mock.calls[0]).toEqual([
    { from: '2026-08-01', to: '2026-08-31', grain: 'entry' },
    'csv',
    'client',
    session.signal,
  ])
  await vi.waitFor(() =>
    expect(by('[data-settings-data-result]').textContent).toContain('Downloaded'),
  )
  by<HTMLInputElement>('[data-settings-data-internal]').checked = true
  by<HTMLButtonElement>('[data-settings-data-download="time-xlsx"]').click()
  await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(2))
  expect(download.mock.calls[1]).toEqual([
    { from: '2026-08-01', to: '2026-08-31', grain: 'entry' },
    'xlsx',
    'internal',
    session.signal,
  ])
  expect(by('[data-settings-data-zone]').textContent).toContain('America/Costa_Rica')
  expect(by<HTMLButtonElement>('[data-settings-data-download="expense-csv"]').disabled).toBe(true)
})
it('refuses invalid dates and reflects disabled modules in the action catalog', async () => {
  const download = vi.fn(async () => ({ blob: new Blob(), filename: 'unused.csv' })),
    modules = vi.fn(async () => flags)
  const tools = createCompanyDataTools({ downloadDetailedTimeReport: download }, modules),
    session = active()
  await tools.loadExports(session)
  by<HTMLInputElement>('[data-settings-data-from]').value = '2026-09-30'
  by<HTMLInputElement>('[data-settings-data-to]').value = '2026-09-01'
  by<HTMLButtonElement>('[data-settings-data-download="time-csv"]').click()
  expect(download).not.toHaveBeenCalled()
  expect(by('[data-settings-data-result]').textContent).toContain('From on or before Through')
  await tools.loadBulk(session)
  expect(by('[data-settings-bulk-actions]').textContent).toContain('Timesheet approval is off')
  expect(by('[data-settings-bulk-actions]').querySelector('a[href="/approvals"]')).toBeNull()
  expect(by('[data-settings-bulk-actions]').querySelectorAll('a[href^="/reports?"]')).toHaveLength(
    3,
  )
})
it('does not fetch company capabilities or export for a non-administrator', async () => {
  const modules = vi.fn(async () => flags),
    download = vi.fn(async () => ({ blob: new Blob(), filename: 'unused.csv' }))
  const tools = createCompanyDataTools({ downloadDetailedTimeReport: download }, modules),
    session = active('member')
  await tools.loadExports(session)
  await tools.loadBulk(session)
  expect(modules).not.toHaveBeenCalled()
  expect(by('[data-settings-data-content]').hidden).toBe(true)
  by<HTMLFormElement>('[data-settings-data-export]').dispatchEvent(
    new Event('submit', { cancelable: true }),
  )
  expect(download).not.toHaveBeenCalled()
})
it('a download finishing after sign-out cannot create a file for the next session', async () => {
  let finish!: (file: { blob: Blob; filename: string }) => void
  const pending = new Promise<{ blob: Blob; filename: string }>((resolve) => {
    finish = resolve
  })
  const download = vi.fn(async () => pending),
    tools = createCompanyDataTools({ downloadDetailedTimeReport: download }, async () => flags)
  const previous = active()
  await tools.loadExports(previous)
  by<HTMLButtonElement>('[data-settings-data-download="time-csv"]').click()
  expect(download).toHaveBeenCalledOnce()
  previous.owner.abort()
  await tools.loadExports(active('member'))
  finish({ blob: new Blob(['private result']), filename: 'private-result.csv' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(urls).not.toHaveBeenCalled()
  expect(by('[data-settings-data-result]').textContent).toBe('')
  expect(by('[data-settings-data-content]').hidden).toBe(true)
})
