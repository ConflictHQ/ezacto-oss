import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { renderDataTable } from '../components/data-table.js'
import type { HolidayApi, HolidayRow, PlanningRange } from './model.js'

const message = (
  error: unknown,
  fallback = 'The holiday could not be saved. Refresh and try again.',
) => {
  if (error instanceof EzactoApiError && error.body && typeof error.body === 'object') {
    const detail = (
      error.body as { error?: { message?: unknown; fields?: { message?: unknown }[] } }
    ).error
    if (Array.isArray(detail?.fields) && typeof detail.fields[0]?.message === 'string')
      return detail.fields[0].message
    if (typeof detail?.message === 'string') return detail.message
  }
  return fallback
}
export const createOrganizationHolidayController = (
  root: HTMLElement,
  api: HolidayApi,
  onChanged: () => void,
) => {
  const find = <T extends Element>(selector: string) => root.querySelector<T>(selector)!
  const form = find<HTMLFormElement>('[data-holiday-form]'),
    status = find<HTMLElement>('[data-holiday-status]')
  const dialog = find<HTMLDialogElement>('[data-holiday-delete-dialog]')
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement
  let active: { signal: AbortSignal; range: PlanningRange } | null = null,
    editing: HolidayRow | null = null,
    deleting: HolidayRow | null = null,
    pending = false,
    readRevision = 0
  const current = (a: NonNullable<typeof active>) =>
    active?.signal === a.signal && !a.signal.aborted
  const busy = (value: boolean) => {
    pending = value
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      'input,button',
    ))
      control.disabled = value
  }
  const reset = () => {
    form.reset()
    editing = null
    find<HTMLElement>('[data-holiday-save]').textContent = 'Add holiday'
    find<HTMLElement>('[data-holiday-cancel]').hidden = true
  }
  const run = async (work: (a: NonNullable<typeof active>) => Promise<void>, success: string) => {
    const a = active
    if (!a || pending || a.signal.aborted) return
    busy(true)
    status.textContent = 'Saving…'
    try {
      await work(a)
      if (current(a)) {
        reset()
        status.textContent = success
        onChanged()
      }
    } catch (error) {
      if (current(a)) status.textContent = message(error)
    } finally {
      if (current(a)) busy(false)
    }
  }
  const render = (rows: readonly HolidayRow[]) => {
    find<HTMLElement>('[data-holiday-table]').replaceChildren(
      renderDataTable<HolidayRow>({
        caption: 'Organization holidays in these weeks',
        table: 'organization-holidays',
        rows,
        rowKey: (row) => String(row.id),
        defaultSort: { column: 'date', direction: 'ascending' },
        empty: 'No organization holidays in these weeks.',
        columns: [
          { key: 'date', label: 'Date', fit: true, render: (row) => row.date, sortValue: (row) => row.date },
          {
            key: 'name',
            label: 'Holiday',
            wrap: true,
            render: (row) => row.name,
            sortValue: (row) => row.name,
          },
        ],
        actions: (row) => [
          {
            label: 'Edit holiday',
            primary: true,
            onSelect: () => {
              if (pending) return
              editing = row
              field('date').value = row.date
              field('name').value = row.name
              find<HTMLElement>('[data-holiday-save]').textContent = 'Save holiday'
              find<HTMLElement>('[data-holiday-cancel]').hidden = false
              field('name').focus()
            },
          },
          {
            label: 'Remove holiday',
            onSelect: () => {
              if (pending) return
              deleting = row
              find<HTMLElement>('[data-holiday-delete-description]').textContent =
                `${row.date}: ${row.name}`
              dialog.showModal()
            },
          },
        ],
      }),
    )
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!form.reportValidity()) return
    const row = editing,
      input = { date: field('date').value, name: field('name').value.trim() }
    void run(
      async (a) => {
        if (row) await api.update(row.id, { ...input, version: row.version }, a.signal)
        else await api.create(input, a.signal)
      },
      row ? 'Holiday saved.' : 'Holiday added.',
    )
  })
  find<HTMLButtonElement>('[data-holiday-cancel]').addEventListener('click', reset)
  find<HTMLButtonElement>('[data-holiday-delete-cancel]').addEventListener('click', () =>
    dialog.close(),
  )
  dialog.addEventListener('close', () => {
    deleting = null
  })
  find<HTMLFormElement>('[data-holiday-delete-form]').addEventListener('submit', (event) => {
    event.preventDefault()
    const row = deleting
    if (!row) return
    dialog.close()
    void run((a) => api.remove(row.id, row.version, a.signal).then(() => {}), 'Holiday removed.')
  })
  const clear = () => {
    active = null
    readRevision++
    editing = null
    deleting = null
    dialog.close()
    reset()
    busy(false)
    status.textContent = ''
    find<HTMLElement>('[data-holiday-table]').replaceChildren()
    root.hidden = true
  }
  return {
    clear,
    async refresh(range: PlanningRange, signal: AbortSignal) {
      if (signal.aborted) return
      const a = { signal, range },
        revision = ++readRevision
      const changedSignal = active?.signal !== signal
      active = a
      root.hidden = false
      if (changedSignal)
        signal.addEventListener(
          'abort',
          () => {
            if (active?.signal === signal) clear()
          },
          { once: true },
        )
      try {
        const rows = await api.list(range, signal)
        if (current(a) && revision === readRevision) {
          render(rows)
          busy(pending)
        }
      } catch (error) {
        if (current(a) && revision === readRevision)
          status.textContent = message(
            error,
            'Organization holidays could not be loaded. Refresh capacity to retry.',
          )
      }
    },
  }
}
