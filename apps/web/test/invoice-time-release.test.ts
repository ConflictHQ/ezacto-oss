/** @vitest-environment happy-dom */
import { expect, it, vi } from 'vitest'
import { createInvoiceTimeRelease } from '../src/invoices/time-release.js'
import type { InvoiceHoursReview, InvoiceTimeReleaseApi } from '../src/invoices/model.js'
const view = (): InvoiceHoursReview => ({
  invoice_id: 7,
  invoice_version: 1,
  invoice_state: 'draft',
  hours_version: 'a'.repeat(64),
  linked_seconds: 7200,
  billed_seconds: 5400,
  difference_seconds: -1800,
  status: 'billed_below_linked',
  tolerance_seconds: 36,
  total_tolerance_seconds: 36,
  comparison_complete: true,
  has_mismatch: true,
  not_compared_entry_ids: [],
  projects: [],
  not_compared: [],
  lines: [
    {
      line_id: 21,
      project_id: 1,
      entry_ids: [1, 2, 3],
      linked_seconds: 7200,
      billed_seconds: 5400,
      difference_seconds: -1800,
      status: 'billed_below_linked',
    },
  ],
  entries: [
    {
      entry_id: 1,
      user_id: 2,
      user_name: 'Person A',
      project_id: 1,
      project_name: 'Project',
      spent_date: '2026-08-01',
      seconds: 3600,
      eligible_for_release: true,
    },
    {
      entry_id: 2,
      user_id: 2,
      user_name: 'Person A',
      project_id: 1,
      project_name: 'Project',
      spent_date: '2026-08-02',
      seconds: 1800,
      eligible_for_release: true,
    },
    {
      entry_id: 3,
      user_id: 3,
      user_name: 'Person B',
      project_id: 1,
      project_name: 'Project',
      spent_date: '2026-08-03',
      seconds: 1800,
      eligible_for_release: true,
    },
  ],
})
const mount = (api: InvoiceTimeReleaseApi, dirty = false) => {
  document.body.innerHTML =
    '<fieldset data-line-id="21"><div class="invoice-line-meta"></div></fieldset>'
  const row = document.querySelector<HTMLElement>('fieldset')!,
    abort = new AbortController(),
    reload = vi.fn(async () => {}),
    save = vi.fn(async () => {})
  let busy = false
  const controller = createInvoiceTimeRelease(api, {
    context: () => ({ signal: abort.signal, pending: busy }),
    busy: (value) => {
      busy = value
    },
    reload,
    saveForReview: save,
    error: (error) => (error as Error).message,
  })
  const review = view()
  controller.sync(row, review, review.lines[0], dirty, 5400)
  return { row, reload, save, abort, controller, review }
}
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === name,
  )!
it('filters by person, sums whole entries, and retries an uncertain result with the identical command', async () => {
  const release = vi.fn<NonNullable<InvoiceTimeReleaseApi['releaseInvoiceLineTime']>>(
    async (_id, command) => ({
      command_id: command.command_id,
      invoice_id: 7,
      line_id: 21,
      expected_version: 1,
      hours_version: 'a'.repeat(64),
      released_entry_ids: [2],
      released_seconds: 1800,
      recorded_at: '2026-09-01',
      replayed: true,
    }),
  )
  release.mockRejectedValueOnce(new Error('Response lost'))
  const { reload } = mount({ releaseInvoiceLineTime: release })
  const people = document.querySelector('select')!
  people.value = '2'
  people.dispatchEvent(new Event('change', { bubbles: true }))
  expect(document.querySelectorAll('input')).toHaveLength(2)
  const choose = (id: number) => {
    const input = document.querySelector<HTMLInputElement>(`input[value="${id}"]`)!
    input.checked = !input.checked
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  expect(button('Confirm release of selected time').disabled).toBe(true)
  choose(1)
  expect(button('Confirm release of selected time').disabled).toBe(true)
  choose(1)
  choose(2)
  expect(button('Confirm release of selected time').disabled).toBe(false)
  button('Confirm release of selected time').click()
  await vi.waitFor(() => expect(button('Retry same release')).toBeDefined())
  expect(people.disabled).toBe(true)
  const first = release.mock.calls[0]
  button('Retry same release').click()
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  expect(release.mock.calls[1]).toEqual(first)
  expect(first?.[1]).toMatchObject({
    entry_ids: [2],
    confirmed: true,
    expected_version: 1,
    hours_version: 'a'.repeat(64),
  })
})
it('requires saving an unsaved quantity before any release selection', async () => {
  const release = vi.fn(),
    { save } = mount({ releaseInvoiceLineTime: release }, true)
  expect(document.querySelectorAll('input')).toHaveLength(0)
  button('Save changes and review linked time').click()
  expect(save).toHaveBeenCalledTimes(1)
  expect(release).not.toHaveBeenCalled()
})
it('clears hidden selections when the chosen person changes', () => {
  mount({ releaseInvoiceLineTime: vi.fn() })
  const input = document.querySelector<HTMLInputElement>('input[value="3"]')!
  input.checked = true
  input.dispatchEvent(new Event('change', { bubbles: true }))
  expect(button('Confirm release of selected time').disabled).toBe(false)
  const people = document.querySelector('select')!
  people.value = '2'
  people.dispatchEvent(new Event('change', { bubbles: true }))
  expect(button('Confirm release of selected time').disabled).toBe(true)
  expect(document.querySelectorAll('input:checked')).toHaveLength(0)
})

it('keeps running entries unavailable in the checklist',()=>{
 const {row,review,controller}=mount({releaseInvoiceLineTime:vi.fn()})
 review.entries[1]!.eligible_for_release=false;review.hours_version='b'.repeat(64)
 controller.sync(row,review,review.lines[0],false,5400)
 expect(document.querySelector<HTMLInputElement>('input[value="2"]')!.disabled).toBe(true)
})
