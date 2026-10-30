/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInvoicePaymentController } from '../src/invoices/browser.js'
import { invoiceEndClientSubtotals } from '../src/invoices/model.js'
import { renderAppShell } from '../src/shell/render.js'
import type { Whoami } from '@conflict-hq/ezacto-client'
import {
  browserApi,
  invoice,
  mountShell,
  renderBrowserShell,
  resource,
  type ShellApi,
} from './support/shell-harness.js'

/**
 * Issue 33 (F7): one invoice, many end-clients, subtotalled. The wizard offers
 * the projects of the clients beneath the one chosen; the invoice page lists
 * what each end-client's lines come to.
 */

const line = (id: number, projectId: number | null, amountCents: number) => ({
  ...invoice(7).line_items[0]!,
  id,
  project_id: projectId,
  amount_cents: amountCents,
})

describe('invoice end-client subtotals', () => {
  it('[unit] gathers lines by the client of their project, in whole cents', () => {
    const clientOfProject = new Map([
      [1, 11],
      [2, 12],
      [3, 12],
    ])
    expect(
      invoiceEndClientSubtotals(
        [line(1, 1, 10_000), line(2, 2, 15_000), line(3, 3, 333), line(4, null, 700)],
        clientOfProject,
      ),
    ).toEqual([
      { clientId: 11, cents: 10_000 },
      { clientId: 12, cents: 15_333 },
      { clientId: null, cents: 700 },
    ])
  })

  it('[unit] says nothing for one end-client, or for lines whose projects are unknown', () => {
    expect(invoiceEndClientSubtotals([line(1, 1, 5), line(2, 2, 5)], new Map([[1, 11], [2, 11]]))).toBeNull()
    expect(invoiceEndClientSubtotals([line(1, 1, 5), line(2, 2, 5)], new Map())).toBeNull()
    expect(invoiceEndClientSubtotals([], new Map())).toBeNull()
  })
})

describe('invoice detail by end-client', () => {
  const accounting: Whoami = {
    user_id: 1,
    profile: 'accounting',
    manager_grants: [],
    authentication: { kind: 'session' },
  }
  // As the invoice page's own tests draw it: the shell with its script and
  // stylesheet link left out, at the record's id address.
  const renderDetail = (): void => {
    window.history.replaceState(null, '', '/invoices/by-id/7')
    document.open()
    document.write(
      renderAppShell({
        environment: 'test',
        release: 'invoice-end-clients-test',
        activeSection: 'Invoices',
        view: 'invoice-detail',
      })
        .replace(/ {2}<link[^>]+>\n/gu, '')
        .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
    )
    document.close()
  }

  it('[browser] lists what each end-client comes to, matching the lines', async () => {
    renderDetail()
    const projects: Record<number, Record<string, unknown>> = {
      1: { id: 1, name: 'Parent Project', client_id: 11 },
      2: { id: 2, name: 'Alpha Project', client_id: 12 },
      3: { id: 3, name: 'Charlie Project', client_id: 13 },
    }
    const clients: Record<number, Record<string, unknown>> = {
      11: { id: 11, name: 'Parent Holdings' },
      12: { id: 12, name: 'Alpha Unit' },
      13: { id: 13, name: 'Charlie Site' },
    }
    await createInvoicePaymentController({
      findInvoiceByNumber: async () => null,
      getInvoice: async () =>
        invoice(7, {
          client_id: 11,
          line_items: [
            line(1, 1, 10_000),
            line(2, 2, 15_000),
            line(3, 2, 1_250),
            line(4, 3, 5_333),
          ],
        }),
      getDirectoryProject: async (id: number) => projects[id] as never,
      getDirectoryClient: async (id: number) => clients[id] as never,
      listInvoiceMessages: async () => [],
      listInvoicePayments: async () => [],
    }).activate(accounting, new AbortController().signal, () => false)

    const panel = document.querySelector<HTMLElement>('[data-invoice-end-clients]')!
    await vi.waitFor(() => expect(panel.hidden).toBe(false))
    const rows = [...panel.querySelectorAll<HTMLElement>('[data-invoice-end-client-rows] tr')]
    expect(rows.map((row) => row.querySelector('th')!.textContent)).toEqual([
      'Parent Holdings',
      'Alpha Unit',
      'Charlie Site',
    ])
    expect(rows.map((row) => row.dataset['endClient'])).toEqual(['11', '12', '13'])
    expect(rows.map((row) => row.querySelector('td')!.textContent)).toEqual([
      expect.stringContaining('100.00'),
      expect.stringContaining('162.50'),
      expect.stringContaining('53.33'),
    ])
  })

  it('[browser] leaves the panel out for an invoice with one end-client', async () => {
    renderDetail()
    const getDirectoryProject = vi.fn(async (id: number) => ({ id, name: `P${id}`, client_id: 11 }) as never)
    await createInvoicePaymentController({
      findInvoiceByNumber: async () => null,
      getInvoice: async () => invoice(7, { line_items: [line(1, 1, 100), line(2, 2, 200)] }),
      getDirectoryProject,
      getDirectoryClient: async (id: number) => ({ id, name: 'Only' }) as never,
      listInvoiceMessages: async () => [],
      listInvoicePayments: async () => [],
    }).activate(accounting, new AbortController().signal, () => false)
    expect(document.querySelector<HTMLElement>('[data-invoice-document]')?.hidden).toBe(false)
    // Both projects are read, found to be one client's, and nothing is listed.
    await vi.waitFor(() => expect(getDirectoryProject).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.querySelector<HTMLElement>('[data-invoice-end-clients]')!.hidden).toBe(true)
    expect(document.querySelectorAll('[data-invoice-end-client-rows] tr')).toHaveLength(0)
  })
})

describe('invoice wizard by end-client', () => {
  afterEach(() => vi.useRealTimers())

  it('[browser] offers the projects beneath the client, in tree order, and bills the ones chosen', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-14T12:00:00.000Z'))
    renderBrowserShell({ view: 'invoice-generation' })
    const generateInvoice = vi
      .fn<NonNullable<ShellApi['generateInvoice']>>()
      .mockResolvedValue(invoice(21))
    const api: ShellApi = {
      ...browserApi(),
      listClients: async () => ({
        data: [
          { ...resource(11, 'Parent Holdings'), currency: 'USD' },
          { ...resource(13, 'Euro Branch'), parent_client_id: 11, currency: 'EUR' },
          { ...resource(12, 'Bravo Division'), parent_client_id: 11, currency: 'USD' },
          { ...resource(14, 'Charlie Site'), parent_client_id: 12, currency: 'USD' },
          { ...resource(15, 'Unrelated Co'), currency: 'USD' },
        ],
        page: { next_cursor: null },
      }),
      listProjects: async () => ({
        data: [
          { ...resource(1, 'Parent Project'), client_id: 11 },
          { ...resource(2, 'Bravo Project'), client_id: 12 },
          { ...resource(3, 'Euro Project'), client_id: 13 },
          { ...resource(4, 'Charlie Project'), client_id: 14 },
          { ...resource(5, 'Outside Project'), client_id: 15 },
        ],
        page: { next_cursor: null },
      }),
      generateInvoice,
    }
    await mountShell(api)

    const wizard = document.querySelector<HTMLFormElement>('[data-invoice-generation-form]')!
    const clientSelect = wizard.querySelector<HTMLSelectElement>('[data-invoice-client]')!
    await vi.waitFor(() => expect(clientSelect.options.length).toBe(5))
    clientSelect.value = '11'
    clientSelect.dispatchEvent(new Event('change'))
    await vi.waitFor(() =>
      expect(wizard.querySelectorAll('[data-invoice-projects] [name="project"]')).toHaveLength(4),
    )
    const inputs = [...wizard.querySelectorAll<HTMLInputElement>('[data-invoice-projects] [name="project"]')]
    // The client, then Bravo and what is beneath it, then the euro branch: by
    // name among siblings, each followed by its own. The outsider is not offered.
    expect(inputs.map((input) => input.value)).toEqual(['1', '2', '4', '3'])
    // The euro branch bills in another currency, so it is not chosen unasked.
    expect(inputs.map((input) => input.checked)).toEqual([true, true, true, false])
    const endClient = (id: string): string | undefined =>
      wizard
        .querySelector<HTMLInputElement>(`[data-invoice-projects] [value="${id}"]`)!
        .closest('label')!
        .querySelector('.project-end-client')?.textContent ?? undefined
    expect(endClient('1')).toBeUndefined()
    expect(endClient('2')).toBe('For Bravo Division')
    expect(endClient('4')).toBe('For Charlie Site')

    wizard.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(generateInvoice).toHaveBeenCalledTimes(1))
    expect(generateInvoice.mock.calls[0]![1]).toMatchObject({
      kind: 'tracked',
      client_id: 11,
      project_ids: [1, 2, 4],
    })

    // A band claims its own client's work only: the end-clients' projects are set aside.
    const banded = wizard.querySelector<HTMLInputElement>('[data-invoice-kind][value="banded"]')!
    banded.checked = true
    banded.dispatchEvent(new Event('change', { bubbles: true }))
    expect(
      [...wizard.querySelectorAll<HTMLInputElement>('[data-invoice-projects] [name="project"]')].map(
        (input) => [input.value, input.checked, input.disabled],
      ),
    ).toEqual([
      ['1', true, false],
      ['2', false, true],
      ['4', false, true],
      ['3', false, true],
    ])
  })
})
