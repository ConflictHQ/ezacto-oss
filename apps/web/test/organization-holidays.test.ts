/** @vitest-environment happy-dom */
import { expect, it, vi } from 'vitest'
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { createOrganizationHolidayController } from '../src/capacity/organization-holidays-browser.js'
import { renderPlanningSection } from '../src/capacity/render.js'
import type { HolidayApi, HolidayRow } from '../src/capacity/model.js'
const range = { from: '2026-10-12', to: '2026-10-18' }
const row: HolidayRow = { id: 1, date: range.from, name: 'Office closed', version: 0 }
const setup = (api: HolidayApi) => {
  document.body.innerHTML = renderPlanningSection()
  const root = document.querySelector<HTMLElement>('[data-organization-holidays]')!
  return { root, controller: createOrganizationHolidayController(root, api, vi.fn()) }
}
it('clears controls when a session ends after changing weeks, and ignores late list responses', async () => {
  const resolve: ((rows: HolidayRow[]) => void)[] = []
  const api: HolidayApi = {
    list: vi.fn(() => new Promise<HolidayRow[]>((done) => resolve.push(done))),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }
  const { root, controller } = setup(api),
    signal = new AbortController()
  const first = controller.refresh(range, signal.signal)
  const second = controller.refresh({ from: '2026-11-02', to: '2026-11-08' }, signal.signal)
  const name = root.querySelector<HTMLInputElement>('[name="name"]')!
  name.value = 'Unsaved operator name'
  signal.abort()
  for (const done of resolve) done([row])
  await Promise.all([first, second])
  expect(root.hidden).toBe(true)
  expect(name.value).toBe('')
  expect(root.querySelector('[data-holiday-table]')!.textContent).toBe('')
})
it('keeps unsaved fields and shows the server conflict when another administrator edits first', async () => {
  const api: HolidayApi = {
    list: vi.fn(async () => [row]),
    create: vi.fn(),
    update: vi.fn(async () => {
      throw new EzactoApiError(
        409,
        { error: { message: 'The holiday changed. Refresh before trying again.' } },
        null,
      )
    }),
    remove: vi.fn(),
  }
  const { root, controller } = setup(api)
  await controller.refresh(range, new AbortController().signal)
  const edit = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Edit holiday',
  )!
  edit.click()
  const form = root.querySelector<HTMLFormElement>('[data-holiday-form]')!,
    name = form.elements.namedItem('name') as HTMLInputElement
  name.value = 'My unsaved correction'
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() =>
    expect(root.querySelector('[data-holiday-status]')!.textContent).toContain(
      'The holiday changed.',
    ),
  )
  expect(name.value).toBe('My unsaved correction')
  expect(name.disabled).toBe(false)
  expect(api.update).toHaveBeenCalledWith(
    1,
    { date: range.from, name: 'My unsaved correction', version: 0 },
    expect.any(AbortSignal),
  )
})
