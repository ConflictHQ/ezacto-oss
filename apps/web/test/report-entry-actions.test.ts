/** @vitest-environment happy-dom */
import { EzactoApiError, type DetailedTimeReport, type Whoami } from '@conflict-hq/ezacto-client'
import { describe, expect, it, vi } from 'vitest'
import { createReportsController } from '../src/reports/browser.js'
import type { ReportWorkspaceApi } from '../src/reports/model.js'
import { identity, writeDocument, baseApi, detailedTimeRow, detailedTimeReport } from './support/report-harness.js'

describe('Detailed time row corrections (issue 917)', () => {
  const entryReport = (): DetailedTimeReport =>
    detailedTimeReport({
      grain: 'entry',
      seconds: 5_400,
      rounded_seconds: 5_400,
      billable_seconds: 5_400,
      uninvoiced_billable_seconds: 5_400,
      time_entry_count: 2,
      rows: [
        detailedTimeRow({
          time_entry_id: 901,
          user_id: 7,
          user_name: 'Rosa Teammate',
          notes: 'Delivery notes',
          invoice_id: null,
        }),
        detailedTimeRow({
          time_entry_id: 902,
          spent_date: '2026-08-12',
          seconds: 1_800,
          rounded_seconds: 1_800,
          notes: null,
          invoice_id: null,
        }),
      ],
    })

  const open = async (
    profile: Whoami['profile'],
    overrides: Partial<ReportWorkspaceApi>,
    editTimeEntry?: (entryId: number, onChanged: () => void) => Promise<void>,
  ) => {
    writeDocument('/reports?report=detailed-time&from=2026-08-01&to=2026-08-31&grain=entry')
    const getDetailedTimeReport = vi.fn(async () => entryReport())
    const session = new AbortController()
    await createReportsController(
      baseApi({ getDetailedTimeReport, ...overrides }),
      editTimeEntry === undefined ? {} : { editTimeEntry },
    ).activate(identity(profile), session.signal, () => false)
    return { getDetailedTimeReport }
  }

  const button = (selector: string): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>(selector)!
  const deleteDialog = (): HTMLDialogElement =>
    document.querySelector<HTMLDialogElement>('[data-report-entry-delete-dialog]')!
  const confirmDeletion = (): void => {
    document
      .querySelector<HTMLFormElement>('[data-report-entry-delete-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
  }

  it('[browser] gives an administrator Edit and Delete on each entry row, and keeps the table square', async () => {
    await open('administrator', { deleteTimeEntry: vi.fn(async () => {}) }, vi.fn(async () => {}))
    const table = document.querySelector<HTMLTableElement>('.report-detailed-table')!
    const headings = [...table.querySelectorAll('thead th')].map((cell) => cell.textContent)
    expect(headings.at(-1)).toBe('Actions')
    const edits = [...document.querySelectorAll<HTMLElement>('[data-report-entry-edit]')]
    const deletes = [...document.querySelectorAll<HTMLElement>('[data-report-entry-delete]')]
    expect(edits.map((element) => element.dataset['reportEntryEdit']).sort()).toEqual(['901', '902'])
    expect(deletes.map((element) => element.dataset['reportEntryDelete']).sort()).toEqual([
      '901',
      '902',
    ])
    expect(edits[0]!.getAttribute('aria-label')).toMatch(/^Edit .+'s entry on 2026-08-1[02]$/u)
    // Every band, entry and total row spans exactly the header: the hours stay
    // under Hours and the new column only adds a cell at the end.
    for (const row of table.querySelectorAll('tbody tr, tfoot tr')) {
      const width = [...row.children].reduce(
        (sum, cell) => sum + ((cell as HTMLTableCellElement).colSpan || 1),
        0,
      )
      expect(width).toBe(headings.length)
    }
  })

  for (const profile of ['executive_manager', 'accounting'] as const) {
    it(`[security] offers ${profile.replace('_', ' ')}s neither Edit nor Delete on a row`, async () => {
      await open(profile, { deleteTimeEntry: vi.fn(async () => {}) }, vi.fn(async () => {}))
      expect(document.querySelector('[data-report-entry-edit], button[data-report-entry-delete]')).toBeNull()
      expect(
        [...document.querySelectorAll('.report-detailed-table thead th')].map((cell) => cell.textContent),
      ).not.toContain('Actions')
    })
  }

  it('[browser] asks in the page before deleting, then deletes and reads the report again', async () => {
    const deleteTimeEntry = vi.fn(async () => {})
    const { getDetailedTimeReport } = await open(
      'administrator',
      { deleteTimeEntry },
      vi.fn(async () => {}),
    )

    button('button[data-report-entry-delete="901"]').click()
    expect(deleteDialog().open).toBe(true)
    expect(document.querySelector('[data-report-entry-delete-body]')!.textContent).toBe(
      "Rosa Teammate's 1.00 hours on Launch / Delivery on 2026-08-10 will be removed from their timesheet. This cannot be undone.",
    )
    expect(deleteTimeEntry).not.toHaveBeenCalled()

    // Cancelling leaves the entry alone.
    button('footer [data-report-entry-delete-cancel]').click()
    expect(deleteDialog().open).toBe(false)
    expect(deleteTimeEntry).not.toHaveBeenCalled()

    button('button[data-report-entry-delete="901"]').click()
    confirmDeletion()
    await vi.waitFor(() => expect(deleteTimeEntry).toHaveBeenCalledWith(901, expect.any(AbortSignal)))
    await vi.waitFor(() => expect(getDetailedTimeReport).toHaveBeenCalledTimes(2))
    expect(deleteDialog().open).toBe(false)
  })

  it('keeps a newly opened deletion review independent of an older request', async () => {
    let fail!: (error: Error) => void
    const deleteTimeEntry = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject }))
    await open('administrator', { deleteTimeEntry })
    button('button[data-report-entry-delete="901"]').click()
    confirmDeletion()
    confirmDeletion()
    expect(deleteTimeEntry).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-report-entry-delete-result]')!.getAttribute('aria-busy')).toBe('true')
    button('footer [data-report-entry-delete-cancel]').click()
    button('button[data-report-entry-delete="902"]').click()
    fail(new Error('Previous delete failed'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(deleteDialog().open).toBe(true)
    expect(document.querySelector('[data-report-entry-delete-body]')!.textContent).toContain('2026-08-12')
    expect(document.querySelector('[data-report-entry-delete-result]')!.textContent).toBe('')
    expect(button('[data-report-entry-delete-submit]').disabled).toBe(false)
  })

  it('[browser] says in the dialog why an entry could not be deleted', async () => {
    const deleteTimeEntry = vi.fn(async () => {
      throw new EzactoApiError(
        422,
        {
          error: {
            code: 'tracked_mutation_locked',
            message: 'The tracked record is locked and cannot be changed.',
            fields: [{ field: 'time_entry', code: 'approved', message: 'Approved' }],
          },
        },
        'req-917',
      )
    })
    const { getDetailedTimeReport } = await open(
      'administrator',
      { deleteTimeEntry },
      vi.fn(async () => {}),
    )
    button('button[data-report-entry-delete="902"]').click()
    confirmDeletion()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-report-entry-delete-result]')!.textContent).toBe(
        'This entry cannot be deleted: Approved.',
      ),
    )
    expect(deleteDialog().open).toBe(true)
    expect(button('[data-report-entry-delete-submit]').disabled).toBe(false)
    expect(getDetailedTimeReport).toHaveBeenCalledTimes(1)
  })

  it("[browser] opens the timesheet's editor on a row and reads the report again once it changes", async () => {
    let changed: (() => void) | undefined
    const editTimeEntry = vi.fn(async (_entryId: number, onChanged: () => void) => {
      changed = onChanged
    })
    const { getDetailedTimeReport } = await open(
      'administrator',
      { deleteTimeEntry: vi.fn(async () => {}) },
      editTimeEntry,
    )
    button('[data-report-entry-edit="901"]').click()
    expect(editTimeEntry).toHaveBeenCalledWith(901, expect.any(Function))
    changed!()
    await vi.waitFor(() => expect(getDetailedTimeReport).toHaveBeenCalledTimes(2))

    // An entry that went in the meantime says so where the report is read.
    editTimeEntry.mockRejectedValueOnce(
      new EzactoApiError(404, { error: { code: 'not_found', message: 'gone', fields: [] } }, null),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-report-entry-edit="902"]')).not.toBeNull(),
    )
    button('[data-report-entry-edit="902"]').click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-report-status]')!.textContent).toBe(
        'This entry no longer exists.',
      ),
    )
  })
})
