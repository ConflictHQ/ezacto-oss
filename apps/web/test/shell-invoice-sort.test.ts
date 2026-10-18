/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  browserApi,
  invoice,
  mountShell,
  renderBrowserShell,
  resource,
  type ShellApi,
} from './support/shell-harness.js'

/**
 * Issue 852. The invoice list is ordered by the server, so choosing a column
 * asks for the list again in that order and Load more carries on in it.
 */

afterEach(() => {
  localStorage.clear()
})

const sortButton = (column: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`thead button[data-sort-column="${column}"]`)!

const rowKeys = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('tbody tr[data-row-key]')].map(
    (row) => row.dataset.rowKey!,
  )

describe('sorting the invoice list', () => {
  it('[browser] fetches the list again in the chosen order and keeps it through Load more', async () => {
    renderBrowserShell({ view: 'invoice-list' })
    const listInvoices = vi
      .fn<NonNullable<ShellApi['listInvoices']>>()
      // Newest first, as the server sends it with no sort.
      .mockResolvedValueOnce({ data: [invoice(9), invoice(7)], page: { next_cursor: null } })
      .mockResolvedValueOnce({
        data: [invoice(7), invoice(9)],
        page: { next_cursor: 'more' },
      })
      .mockResolvedValueOnce({ data: [invoice(11)], page: { next_cursor: null } })
    const api: ShellApi = {
      ...browserApi(),
      listInvoices,
      listClients: async () => ({
        data: [resource(11, 'Northwind Freight')],
        page: { next_cursor: null },
      }),
    }
    await mountShell(api)
    await vi.waitFor(() => expect(rowKeys()).toEqual(['9', '7']))

    // Issued is the order the list arrives in, and the header says so.
    expect(
      document.querySelector('thead th[data-column="issued"]')?.getAttribute('aria-sort'),
    ).toBe('descending')
    // Client and Status are not offered: the server cannot order them.
    expect(sortButton('client')).toBeNull()
    expect(sortButton('status')).toBeNull()

    sortButton('number').click()
    await vi.waitFor(() => expect(listInvoices).toHaveBeenCalledTimes(2))
    expect(listInvoices).toHaveBeenNthCalledWith(2, undefined, expect.anything(), undefined, ['draft', 'open'], 'number')
    await vi.waitFor(() => expect(rowKeys()).toEqual(['7', '9']))
    expect(
      document.querySelector('thead th[data-column="number"]')?.getAttribute('aria-sort'),
    ).toBe('ascending')
    expect(
      document.querySelector('thead th[data-column="issued"]')?.hasAttribute('aria-sort'),
    ).toBe(false)

    document.querySelector<HTMLButtonElement>('[data-invoice-load-more]')!.click()
    await vi.waitFor(() => expect(listInvoices).toHaveBeenCalledTimes(3))
    expect(listInvoices).toHaveBeenNthCalledWith(3, 'more', expect.anything(), undefined, ['draft', 'open'], 'number')
    await vi.waitFor(() => expect(rowKeys()).toEqual(['7', '9', '11']))
  })

  it('[browser] sorts descending on a second click and remembers the choice for next time', async () => {
    renderBrowserShell({ view: 'invoice-list' })
    const listInvoices = vi
      .fn<NonNullable<ShellApi['listInvoices']>>()
      .mockResolvedValue({ data: [invoice(7)], page: { next_cursor: null } })
    const api: ShellApi = { ...browserApi(), listInvoices }
    await mountShell(api)
    await vi.waitFor(() => expect(rowKeys()).toEqual(['7']))

    sortButton('balance').click()
    await vi.waitFor(() => expect(listInvoices).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(sortButton('balance')).not.toBeNull())
    sortButton('balance').click()
    await vi.waitFor(() => expect(listInvoices).toHaveBeenCalledTimes(3))
    expect(listInvoices).toHaveBeenLastCalledWith(
      undefined,
      expect.anything(),
      undefined,
      ['draft', 'open'],
      '-balance',
    )
    await vi.waitFor(() =>
      expect(
        document.querySelector('thead th[data-column="balance"]')?.getAttribute('aria-sort'),
      ).toBe('descending'),
    )
    // Focus returns to the header that was activated, not to the top of the page.
    await vi.waitFor(() => expect(document.activeElement).toBe(sortButton('balance')))
  })
})
