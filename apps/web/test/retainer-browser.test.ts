/** @vitest-environment happy-dom */

import {
  EzactoApiError,
  type GeneralResource,
  type Retainer,
  type RetainerLedgerEntry,
  type Whoami,
} from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import { createRetainerWorkspaceController } from '../src/retainers/browser.js'
import type { RetainerWorkspaceApi } from '../src/retainers/model.js'
import { invoiceTabs, renderAppShell } from '../src/index.js'

const timestamp = '2026-09-02T12:00:00.000Z'

const northpeak: Retainer = {
  id: 1,
  client_id: 4,
  project_id: null,
  state: 'ongoing',
  denomination: 'money',
  amount_cents: 500_000,
  seconds: null,
  locked_rate_cents: null,
  rate_locked_at: null,
  period: 'monthly',
  rollover: 'carry',
  expires_at: null,
  on_exhaustion: 'block',
  balance: 320_000,
  created_at: timestamp,
  updated_at: timestamp,
}

/** The cutover shape: zero agreed amount, empty ledger, client from the invoice. */
const importedStub: Retainer = {
  ...northpeak,
  id: 2,
  client_id: 5,
  amount_cents: 0,
  balance: 0,
  period: null,
  rollover: null,
}

const closed: Retainer = { ...northpeak, id: 3, state: 'closed', balance: 0 }

const ledger: readonly RetainerLedgerEntry[] = [
  {
    id: 'ret_deposit',
    retainer_id: 1,
    kind: 'deposit',
    unit: 'cents',
    amount: 500_000,
    invoice_id: 77,
    occurred_on: '2026-01-05',
    notes: null,
    created_at: timestamp,
  },
  {
    id: 'ret_draw',
    retainer_id: 1,
    kind: 'drawdown',
    unit: 'cents',
    amount: -120_000,
    invoice_id: 81,
    occurred_on: '2026-02-05',
    notes: null,
    created_at: timestamp,
  },
  {
    id: 'ret_expiry',
    retainer_id: 1,
    kind: 'expiry',
    unit: 'cents',
    amount: -60_000,
    invoice_id: null,
    occurred_on: '2026-03-01',
    notes: 'Quarter boundary',
    created_at: timestamp,
  },
]

const resource = (id: number, fields: Record<string, unknown>): GeneralResource => ({
  id,
  created_at: timestamp,
  updated_at: timestamp,
  ...fields,
})

const identity = (): Whoami => ({
  user_id: 1,
  profile: 'administrator',
  manager_grants: [],
  authentication: { kind: 'session' },
})

const page = <Resource>(data: readonly Resource[], nextCursor: string | null = null) => ({
  data,
  page: { next_cursor: nextCursor },
})

const writeDocument = (path = '/invoices/retainers'): void => {
  window.history.replaceState(null, '', path)
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'retainer-browser-test',
      activeSection: 'Invoices',
      view: 'invoice-retainers',
      tabs: invoiceTabs('invoice-retainers'),
    })
      .replace(
        / {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu,
        '',
      )
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const baseApi = (
  overrides: Partial<RetainerWorkspaceApi> = {},
): Partial<RetainerWorkspaceApi> => ({
  listRetainers: vi.fn(async () => page([northpeak, importedStub, closed])),
  getRetainerDetail: vi.fn(async (id: number) =>
    [northpeak, importedStub, closed].find((candidate) => candidate.id === id)!,
  ),
  listRetainerLedger: vi.fn(async (id: number) => (id === northpeak.id ? ledger : [])),
  listRetainerClients: vi.fn(async () =>
    page([
      resource(4, { name: 'Northpeak', currency: 'USD' }),
      resource(5, { name: 'Alva Works', currency: 'USD' }),
    ]),
  ),
  listRetainerProjects: vi.fn(async () => page<GeneralResource>([])),
  ...overrides,
})

const activate = async (
  api: Partial<RetainerWorkspaceApi>,
  signal = new AbortController().signal,
): Promise<void> => {
  await createRetainerWorkspaceController(api).activate(identity(), signal, () => false)
}

const listText = (): string =>
  document.querySelector('[data-retainer-list]')?.textContent ?? ''

const ledgerText = (): string =>
  document.querySelector('[data-retainer-ledger]')?.textContent ?? ''

describe('Retainer workspace controller', () => {
  it('[browser] lists what is on retainer and what remains, by client', async () => {
    writeDocument()
    await activate(baseApi())

    // Ongoing is the default, so the closed retainer is not in the table.
    expect(listText()).toContain('Northpeak')
    expect(listText()).toContain('Alva Works')
    const rows = [...document.querySelectorAll('[data-retainer-list] tbody tr[data-row]')]
    expect(rows.map((row) => row.getAttribute('data-row-key'))).toEqual(['2', '1'])
    expect(listText()).toContain('$5,000.00')
    expect(listText()).toContain('$3,200.00')
    // The imported stub says its agreed amount is unrecorded rather than zero,
    // and has no share to show against it.
    expect(listText()).toContain('Not recorded')
    expect(document.querySelector('[data-retainer-list-status]')?.textContent).toContain(
      '2 retainers loaded',
    )
  })

  it('[browser] opens a retainer, and the ledger ends on the balance it reports', async () => {
    writeDocument()
    const api = baseApi()
    await activate(api)

    const open = document.querySelector<HTMLButtonElement>(
      '[data-retainer-list] tr[data-row-key="1"] button',
    )!
    open.click()
    await vi.waitFor(() => expect(api.listRetainerLedger).toHaveBeenCalledWith(1, expect.any(AbortSignal)))
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-retainer-detail-body]')?.hidden).toBe(
        false,
      ),
    )

    expect(window.location.search).toBe('?retainer=1')
    expect(document.querySelector<HTMLElement>('[data-retainer-list-view]')?.hidden).toBe(true)
    expect(document.querySelector('[data-retainer-commitment]')?.textContent).toBe('$5,000.00')
    expect(document.querySelector('[data-retainer-deposited]')?.textContent).toBe('$5,000.00')
    expect(document.querySelector('[data-retainer-drawn]')?.textContent).toBe('$1,200.00')
    expect(document.querySelector('[data-retainer-expired]')?.textContent).toBe('$600.00')
    expect(document.querySelector('[data-retainer-remaining]')?.textContent).toBe('$3,200.00')
    expect(document.querySelector('[data-retainer-share]')?.textContent).toBe('64%')

    // The running balance walks the ledger and lands on the retainer's own
    // balance; the footer totals the amounts to the same number, which is
    // invariant 10 rendered twice and agreeing with itself.
    const balances = [
      ...document.querySelectorAll('[data-retainer-ledger] tbody td[data-column="running"]'),
    ].map((cell) => cell.textContent)
    expect(balances).toEqual(['$5,000.00', '$3,800.00', '$3,200.00'])
    expect(
      document.querySelector('[data-retainer-ledger] tfoot td[data-column="amount"]')
        ?.textContent,
    ).toBe('$3,200.00')
    expect(ledgerText()).toContain('Quarter boundary')
    expect(
      document
        .querySelector('[data-retainer-ledger] tbody a')
        ?.getAttribute('href'),
    ).toBe('/invoices/77')
    // Nothing to warn about on a retainer with a deposit and an agreed amount.
    expect(document.querySelector<HTMLElement>('[data-retainer-notes]')?.hidden).toBe(true)
  })

  it('[browser] admits what an imported retainer does not yet say', async () => {
    writeDocument('/invoices/retainers?retainer=2')
    await activate(baseApi())
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-retainer-detail-body]')?.hidden).toBe(
        false,
      ),
    )

    expect(document.querySelector('[data-retainer-commitment]')?.textContent).toBe(
      'Not recorded',
    )
    expect(document.querySelector<HTMLElement>('[data-retainer-share-row]')?.hidden).toBe(true)
    const notes = document.querySelector<HTMLElement>('[data-retainer-notes]')!
    expect(notes.hidden).toBe(false)
    expect(notes.textContent).toContain('No movements recorded yet')
    expect(notes.textContent).toContain('No agreed amount is recorded')
    expect(ledgerText()).toContain('No movements recorded yet.')
  })

  it('[browser] waits for the client names before painting a deep-linked detail', async () => {
    writeDocument('/invoices/retainers?retainer=1')
    let releaseClients!: () => void
    const clientsLoaded = new Promise<void>((resolve) => {
      releaseClients = resolve
    })
    const listRetainerClients = vi.fn(async () => {
      await clientsLoaded
      return page([resource(4, { name: 'Northpeak', currency: 'EUR' })])
    })
    const activation = activate(baseApi({ listRetainerClients }))

    // The retainer and its ledger can be in hand well before the names are, and
    // a detail painted then would name the wrong client and the wrong currency.
    await vi.waitFor(() => expect(listRetainerClients).toHaveBeenCalled())
    expect(document.querySelector<HTMLElement>('[data-retainer-detail-body]')?.hidden).toBe(true)

    releaseClients()
    await activation
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-retainer-detail-body]')?.hidden).toBe(
        false,
      ),
    )
    expect(document.querySelector('[data-retainer-detail-client]')?.textContent).toBe(
      'Northpeak',
    )
    expect(document.querySelector('[data-retainer-remaining]')?.textContent).toContain('€')
  })

  it('[browser] shows closed retainers only when asked, and leaves the detail behind', async () => {
    writeDocument('/invoices/retainers?retainer=1')
    await activate(baseApi())
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-retainer-detail-view]')?.hidden).toBe(
        false,
      ),
    )

    document.querySelector<HTMLButtonElement>('[data-retainer-filter="all"]')!.click()
    expect(window.location.search).toBe('?status=all')
    expect(document.querySelector<HTMLElement>('[data-retainer-detail-view]')?.hidden).toBe(true)
    expect(
      [...document.querySelectorAll('[data-retainer-list] tbody tr[data-row]')].map((row) =>
        row.getAttribute('data-row-key'),
      ),
    ).toEqual(['2', '1', '3'])
    expect(listText()).toContain('Closed')

    document.querySelector<HTMLButtonElement>('[data-retainer-filter="ongoing"]')!.click()
    expect(window.location.pathname + window.location.search).toBe('/invoices/retainers')
    expect(
      document.querySelectorAll('[data-retainer-list] tbody tr[data-row]'),
    ).toHaveLength(2)
  })

  it('[browser] offers a retry rather than an empty table when the list fails', async () => {
    writeDocument()
    const listRetainers = vi
      .fn<RetainerWorkspaceApi['listRetainers']>()
      .mockRejectedValueOnce(
        new EzactoApiError(500, { error: { message: 'Retainers are unavailable.' } }, null),
      )
      .mockResolvedValueOnce(page([northpeak]))
    await activate(baseApi({ listRetainers }))

    expect(document.querySelector('[data-retainer-list-status]')?.textContent).toBe(
      'Retainers are unavailable.',
    )
    const retry = document.querySelector<HTMLButtonElement>('[data-retainer-list-retry]')!
    expect(retry.hidden).toBe(false)
    retry.click()
    await vi.waitFor(() => expect(listText()).toContain('Northpeak'))
    expect(retry.hidden).toBe(true)
  })

  it('[browser] paints nothing into a session that has already ended', async () => {
    writeDocument()
    const controller = new AbortController()
    await activate(baseApi(), controller.signal)
    expect(listText()).toContain('Northpeak')

    controller.abort()
    expect(listText()).toBe('')
    expect(document.querySelector('[data-retainer-list-status]')?.textContent).toBe(
      'Sign in to view retainers.',
    )
  })
})
