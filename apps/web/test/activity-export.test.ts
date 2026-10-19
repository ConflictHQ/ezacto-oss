/** @vitest-environment happy-dom */

import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createActivityController, type ActivityApi } from '../src/activity/browser.js'
import { renderActivityLogPage } from '../src/module-settings/render.js'
import { createSameOriginShellApi } from '../src/shell/model.js'

const control = <Element extends HTMLElement>(name: string): Element =>
  document.querySelector<Element>(`[data-activity-${name}]`)!

const change = (element: HTMLElement, value: string): void => {
  ;(element as HTMLInputElement).value = value
  element.dispatchEvent(new Event('change'))
}

type Exporter = NonNullable<ActivityApi['exportActivityLog']>

const mount = async (exportActivityLog?: Exporter) => {
  document.body.innerHTML = renderActivityLogPage('settings-activity')
  const listActivityLog = vi.fn(async () => ({ data: [] }))
  await createActivityController({
    listActivityLog,
    ...(exportActivityLog === undefined ? {} : { exportActivityLog }),
  }).activate(new AbortController().signal, { administrator: true })
  return { listActivityLog }
}

const status = (): string => control('log-status').textContent ?? ''

describe('activity log export (web)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('[e2e] downloads the current filters as a file and names it', async () => {
    const clicked: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download)
    })
    URL.createObjectURL = vi.fn(() => 'blob:activity')
    URL.revokeObjectURL = vi.fn()
    const exportActivityLog = vi.fn<Exporter>(async () => ({
      blob: new Blob(['Event id\r\n'], { type: 'text/csv' }),
      filename: 'activity-log-from-2026-09-01.csv',
      truncated: false,
    }))
    await mount(exportActivityLog)

    change(control('from'), '2026-09-01')
    change(control('entity'), 'timesheet_submission')
    control<HTMLButtonElement>('export').click()

    await vi.waitFor(() => expect(clicked).toEqual(['activity-log-from-2026-09-01.csv']))
    // The filters as they stand, with no cursor: the export walks the log itself.
    expect(exportActivityLog.mock.calls[0]![0]).toEqual({
      from: '2026-09-01',
      aggregate_type: 'timesheet_submission',
    })
    expect(status()).toBe('Downloaded activity-log-from-2026-09-01.csv.')
  })

  it('[unit] says plainly when the file was cut at its cap', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    URL.createObjectURL = vi.fn(() => 'blob:activity')
    URL.revokeObjectURL = vi.fn()
    await mount(
      vi.fn<Exporter>(async () => ({ blob: new Blob(['x']), filename: 'activity-log.csv', truncated: true })),
    )

    control<HTMLButtonElement>('export').click()

    await vi.waitFor(() => expect(status()).toContain('only the newest entries'))
  })

  it('[unit] a switched-off module disables the export along with the filters', async () => {
    const refused = new EzactoApiError(403, { error: { code: 'module_disabled' } }, null)
    await mount(
      vi.fn<Exporter>(async () => {
        throw refused
      }),
    )

    control<HTMLButtonElement>('export').click()

    await vi.waitFor(() => expect(status()).toContain('switched off'))
    expect(control<HTMLButtonElement>('export').disabled).toBe(true)
  })

  it('[unit] hides the button where the build cannot export', async () => {
    await mount()
    expect(control<HTMLButtonElement>('export').hidden).toBe(true)
  })

  it('[api] the shell fetches the export route with the filters and reads the cap header', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('Event id\r\n', {
          status: 200,
          headers: {
            'content-type': 'text/csv',
            'content-disposition': 'attachment; filename="activity-log-from-2026-09-01.csv"',
            'x-export-truncated': 'true',
          },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const api = createSameOriginShellApi()

    const file = await api.exportActivityLog!({ from: '2026-09-01', aggregate_type: 'invoice', aggregate_id: 4 })

    const url = String((fetchMock.mock.calls[0] as unknown[])[0])
    expect(url).toContain('/api/v1/activity-log/export?')
    expect(new URL(url, 'http://x').searchParams.get('aggregate_id')).toBe('4')
    expect(new URL(url, 'http://x').searchParams.get('from')).toBe('2026-09-01')
    expect(file.filename).toBe('activity-log-from-2026-09-01.csv')
    expect(file.truncated).toBe(true)
  })
})
