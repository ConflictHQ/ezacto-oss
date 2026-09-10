/** @vitest-environment happy-dom */

import {
  EzactoApiError,
  type GeneralResource,
  type Invoice,
  type Retainer,
  type RetainerDrawdownInput,
  type RetainerInput,
  type RetainerLedgerEntry,
  type RetainerLedgerInput,
  type RetainerLedgerMutation,
  type RetainerPatch,
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

/** Denominated in hours: the same columns, and not one of them an amount. */
const hoursRetainer: Retainer = {
  ...northpeak,
  id: 4,
  client_id: 6,
  denomination: 'hours',
  amount_cents: null,
  seconds: 360_000,
  balance: 180_000,
}

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

  it('[browser #521] marks a money retainer as money and an hours retainer as neither', async () => {
    // The same three columns hold money on one row and hours on the next, which
    // is why the $ toggle's marker is decided per row. A column-level marker
    // would mask "50 hours" as though it were an amount, and hours are not the
    // reader's to lose when they hide their money.
    writeDocument()
    await activate(
      baseApi({
        listRetainers: vi.fn(async () => page([northpeak, hoursRetainer])),
        listRetainerClients: vi.fn(async () =>
          page([
            resource(4, { name: 'Northpeak', currency: 'USD' }),
            resource(6, { name: 'Vantage', currency: 'USD' }),
          ]),
        ),
      }),
    )

    const rows = [...document.querySelectorAll('[data-retainer-list] tbody tr[data-row]')]
    // Counted before anything is read out of it: a selector that matched
    // nothing would otherwise agree with every claim below.
    expect(rows.map((row) => row.getAttribute('data-row-key'))).toEqual(['1', '4'])
    const cell = (rowKey: string, column: string): HTMLElement =>
      document.querySelector<HTMLElement>(
        `[data-retainer-list] tr[data-row-key="${rowKey}"] td[data-column="${column}"]`,
      )!

    expect(cell('1', 'balance').textContent).toBe('$3,200.00')
    expect(cell('1', 'balance').querySelectorAll('.money')).toHaveLength(1)
    expect(cell('1', 'commitment').querySelectorAll('.money')).toHaveLength(1)

    expect(cell('4', 'balance').textContent).toBe('50 hours')
    expect(cell('4', 'balance').querySelectorAll('.money')).toHaveLength(0)
    expect(cell('4', 'commitment').textContent).toBe('100 hours')
    expect(cell('4', 'commitment').querySelectorAll('.money')).toHaveLength(0)
    // Nor is the percentage beside them: a share is a ratio, not an amount.
    expect(cell('1', 'share').querySelectorAll('.money')).toHaveLength(0)
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

/**
 * The write path, end to end against a ledger that behaves the way the API
 * does. Nothing below asserts a balance this test also wrote by hand: the fake
 * applies `sign = drawdown|expiry ? -1 : +1` to whatever magnitude the screen
 * sends, sums the rows for the balance the way `retainer_balances` does, and
 * replays a command id it has already seen instead of writing a second row.
 */

/** The id the fake assigns to the first retainer these tests create. */
const createdRetainerId = 10

const invoice = (overrides: Partial<Invoice> = {}): Invoice =>
  ({
    id: 77,
    client_id: 4,
    number: 'INV-77',
    currency: 'USD',
    issue_date: '2026-02-01',
    amount_cents: 500_000,
    state: 'open',
    retainer_id: createdRetainerId,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  }) as Invoice

interface LedgerServer {
  readonly retainers: Retainer[]
  readonly entries: RetainerLedgerEntry[]
  readonly invoices: Invoice[]
  readonly commandIds: string[]
  balanceOf(id: number): number
  create(commandId: string, input: RetainerInput): Retainer
  append(
    id: number,
    commandId: string,
    kind: RetainerLedgerEntry['kind'],
    body: Readonly<Record<string, unknown>>,
  ): RetainerLedgerMutation
}

const ledgerServer = (
  seed: readonly Retainer[] = [],
  seedInvoices: readonly Invoice[] = [],
): LedgerServer => {
  const retainers = seed.map((retainer) => ({ ...retainer }))
  const invoices = seedInvoices.map((candidate) => ({ ...candidate }))
  const commandIds: string[] = []
  const byCommand = new Map<string, RetainerLedgerMutation>()
  const created = new Map<string, Retainer>()
  // A seeded balance is backed by the row that produced it, because on the real
  // server there is no other way to have one: `retainer_balances` is
  // `SUM(entry.amount)` and nothing else. An adjustment is the shape the
  // cutover's opening balances actually arrived in.
  const entries: RetainerLedgerEntry[] = retainers
    .filter((retainer) => retainer.balance !== 0)
    .map((retainer) => ({
      id: `ret_opening_${String(retainer.id)}`,
      retainer_id: retainer.id,
      kind: 'adjustment' as const,
      unit: retainer.denomination === 'money' ? ('cents' as const) : ('seconds' as const),
      amount: retainer.balance,
      invoice_id: null,
      occurred_on: '2026-01-01',
      notes: 'Opening balance',
      created_at: timestamp,
    }))
  const balanceOf = (id: number): number =>
    entries
      .filter((candidate) => candidate.retainer_id === id)
      .reduce((total, candidate) => total + candidate.amount, 0)
  return {
    retainers,
    entries,
    invoices,
    commandIds,
    balanceOf,
    create(commandId, input) {
      commandIds.push(commandId)
      const replay = created.get(commandId)
      if (replay !== undefined) return replay
      const retainer: Retainer = {
        id: createdRetainerId + created.size,
        client_id: input.client_id ?? null,
        project_id: input.project_id ?? null,
        state: 'ongoing',
        denomination: input.denomination,
        amount_cents: input.denomination === 'money' ? input.amount_cents : null,
        seconds: input.denomination === 'hours' ? input.seconds : null,
        locked_rate_cents: 'locked_rate_cents' in input ? input.locked_rate_cents : null,
        rate_locked_at: 'rate_locked_at' in input ? input.rate_locked_at : null,
        period: input.period ?? null,
        rollover: input.rollover ?? null,
        expires_at: input.expires_at ?? null,
        on_exhaustion: input.on_exhaustion ?? 'block',
        balance: 0,
        created_at: timestamp,
        updated_at: timestamp,
      }
      retainers.push(retainer)
      created.set(commandId, retainer)
      return retainer
    },
    append(id, commandId, kind, body) {
      commandIds.push(commandId)
      const replay = byCommand.get(commandId)
      if (replay !== undefined) return replay
      const retainer = retainers.find((candidate) => candidate.id === id)!
      const unit = retainer.denomination === 'money' ? 'cents' : 'seconds'
      const requested = Number(body[unit === 'cents' ? 'amount_cents' : 'seconds'])
      // The line this fake exists for: the API signs the magnitude, the screen
      // never does.
      const sign = kind === 'drawdown' || kind === 'expiry' ? -1 : 1
      const entry: RetainerLedgerEntry = {
        id: `ret_${commandId}`,
        retainer_id: id,
        kind,
        unit,
        amount: sign * requested,
        invoice_id: typeof body.invoice_id === 'number' ? body.invoice_id : null,
        occurred_on: String(body.occurred_on),
        notes: typeof body.notes === 'string' ? body.notes : null,
        created_at: timestamp,
      }
      entries.push(entry)
      retainer.balance = balanceOf(id)
      const mutation: RetainerLedgerMutation = {
        entry,
        balance: retainer.balance,
        denomination: retainer.denomination,
      }
      byCommand.set(commandId, mutation)
      return mutation
    },
  }
}

const writableApi = (server: LedgerServer): Partial<RetainerWorkspaceApi> => ({
  listRetainers: vi.fn(async () => page(server.retainers.map((retainer) => ({ ...retainer })))),
  getRetainerDetail: vi.fn(async (id: number) => ({
    ...server.retainers.find((candidate) => candidate.id === id)!,
  })),
  listRetainerLedger: vi.fn(async (id: number) =>
    server.entries
      .filter((candidate) => candidate.retainer_id === id)
      .map((candidate) => ({ ...candidate })),
  ),
  listRetainerClients: vi.fn(async () =>
    page([resource(4, { name: 'Northpeak', currency: 'USD' })]),
  ),
  listRetainerProjects: vi.fn(async () => page<GeneralResource>([])),
  listRetainerInvoices: vi.fn(async () =>
    page(server.invoices.map((candidate) => ({ ...candidate }))),
  ),
  createRetainer: vi.fn(async (commandId: string, input: RetainerInput) =>
    server.create(commandId, input),
  ),
  drawDownRetainer: vi.fn(async (id: number, commandId: string, input: RetainerDrawdownInput) =>
    server.append(id, commandId, 'drawdown', input),
  ),
  appendRetainerLedger: vi.fn(async (id: number, commandId: string, input: RetainerLedgerInput) =>
    server.append(id, commandId, input.kind, input),
  ),
  updateRetainer: vi.fn(async (id: number, patch: RetainerPatch) => {
    const retainer = server.retainers.find((candidate) => candidate.id === id)!
    Object.assign(retainer, patch)
    return { ...retainer }
  }),
})

const submit = (selector: string): void => {
  document
    .querySelector<HTMLFormElement>(selector)!
    .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
}

const fill = (selector: string, value: string): void => {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

const choose = (selector: string, value: string): void => {
  const field = document.querySelector<HTMLSelectElement>(selector)!
  field.value = value
  field.dispatchEvent(new Event('change', { bubbles: true }))
}

const writeStatusText = (): string =>
  document.querySelector('[data-retainer-write-status]')?.textContent ?? ''

const optionCount = (selector: string): number =>
  document.querySelector<HTMLSelectElement>(selector)!.options.length

/** The detail is painted and the controls act on the retainer it just painted. */
const detailReady = async (): Promise<void> => {
  await vi.waitFor(() => {
    expect(document.querySelector<HTMLElement>('[data-retainer-detail-body]')!.hidden).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('[data-retainer-drawdown]')!.disabled).toBe(
      false,
    )
  })
}

describe('Retainer write path controller', () => {
  it('[e2e:retainers] creates, deposits, draws down and adjusts, and the balance is the ledger sum', async () => {
    writeDocument()
    const server = ledgerServer([], [invoice()])
    const api = writableApi(server)
    await activate(api)

    // Create. The client catalog is on the dialog before anything is typed,
    // because a retainer names the client it belongs to.
    const createTrigger = document.querySelector<HTMLButtonElement>('[data-retainer-create]')!
    expect(createTrigger.hidden).toBe(false)
    expect(createTrigger.disabled).toBe(false)
    createTrigger.click()
    expect(document.querySelector<HTMLDialogElement>('[data-retainer-create-dialog]')!.open).toBe(
      true,
    )
    expect(optionCount('[data-retainer-create-client]')).toBe(2)
    choose('[data-retainer-create-client]', '4')
    expect(document.querySelector('[data-retainer-create-amount-label]')?.textContent).toBe(
      'Agreed amount (USD)',
    )
    // Money is the default, so the create-only rate lock is out of the way.
    expect(document.querySelector<HTMLElement>('[data-retainer-create-rate-row]')!.hidden).toBe(
      true,
    )
    fill('[data-retainer-create-amount]', '5000.00')
    submit('[data-retainer-create-form]')
    await detailReady()

    expect(api.createRetainer).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.createRetainer!).mock.calls[0]![1]).toEqual({
      client_id: 4,
      project_id: null,
      denomination: 'money',
      amount_cents: 500_000,
      period: null,
      rollover: null,
      expires_at: null,
      on_exhaustion: 'block',
    })
    expect(document.querySelector<HTMLDialogElement>('[data-retainer-create-dialog]')!.open).toBe(
      false,
    )
    expect(writeStatusText()).toContain('Retainer #10 created')
    // An agreed amount is not a balance: the new retainer holds nothing until a
    // movement says otherwise.
    expect(document.querySelector('[data-retainer-commitment]')?.textContent).toBe('$5,000.00')
    expect(document.querySelector('[data-retainer-remaining]')?.textContent).toBe('$0.00')

    // Deposit $5,000.00 against the invoice it arrived on.
    document.querySelector<HTMLButtonElement>('[data-retainer-movement]')!.click()
    choose('[data-retainer-movement-kind]', 'deposit')
    await vi.waitFor(() => expect(optionCount('[data-retainer-movement-invoice]')).toBe(1))
    expect(
      document.querySelector<HTMLSelectElement>('[data-retainer-movement-invoice]')!.options[0]!
        .textContent,
    ).toBe('INV-77 · $5,000.00 · 2026-02-01')
    // A deposit is not signed, so no direction control is offered for it.
    expect(
      document.querySelector<HTMLElement>('[data-retainer-movement-direction-label]')!.hidden,
    ).toBe(true)
    fill('[data-retainer-movement-amount]', '5000')
    expect(document.querySelector('[data-retainer-movement-projection]')?.textContent).toBe(
      '$5,000.00',
    )
    submit('[data-retainer-movement-form]')
    await vi.waitFor(() =>
      expect(writeStatusText()).toBe(
        'Deposit of $5,000.00 recorded. The balance is now $5,000.00.',
      ),
    )
    await detailReady()

    // Draw down $1,200.00 against the same invoice.
    document.querySelector<HTMLButtonElement>('[data-retainer-drawdown]')!.click()
    await vi.waitFor(() => expect(optionCount('[data-retainer-drawdown-invoice]')).toBe(1))
    fill('[data-retainer-drawdown-amount]', '1200')
    expect(document.querySelector('[data-retainer-drawdown-projection]')?.textContent).toBe(
      '$3,800.00',
    )
    submit('[data-retainer-drawdown-form]')
    await vi.waitFor(() =>
      expect(writeStatusText()).toBe('Drew down $1,200.00. The balance is now $3,800.00.'),
    )
    await detailReady()
    // The screen sent a magnitude; the ledger holds the negative.
    expect(vi.mocked(api.drawDownRetainer!).mock.calls[0]![2]).toEqual({
      invoice_id: 77,
      amount_cents: 120_000,
      occurred_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
      notes: null,
    })
    expect(server.entries.at(-1)!.amount).toBe(-120_000)

    // Take $300.00 off with an adjustment — the one movement the ledger demands
    // a reason for, and the shape the cutover's opening balance took.
    document.querySelector<HTMLButtonElement>('[data-retainer-movement]')!.click()
    expect(document.querySelector<HTMLSelectElement>('[data-retainer-movement-kind]')!.value).toBe(
      'adjustment',
    )
    expect(
      document.querySelector<HTMLElement>('[data-retainer-movement-direction-label]')!.hidden,
    ).toBe(false)
    choose('[data-retainer-movement-direction]', 'decrease')
    fill('[data-retainer-movement-amount]', '300')
    fill('[data-retainer-movement-notes]', 'Correcting a double-billed hour')
    expect(document.querySelector('[data-retainer-movement-projection]')?.textContent).toBe(
      '$3,500.00',
    )
    submit('[data-retainer-movement-form]')
    await vi.waitFor(() =>
      expect(writeStatusText()).toBe(
        'Adjustment of -$300.00 recorded. The balance is now $3,500.00.',
      ),
    )
    await detailReady()

    // What arithmetic says, computed from the rows rather than restated:
    // 500,000 - 120,000 - 30,000.
    expect(server.entries).toHaveLength(3)
    expect(server.entries.map((row) => row.amount)).toEqual([500_000, -120_000, -30_000])
    expect(server.balanceOf(createdRetainerId)).toBe(350_000)
    expect(server.entries.reduce((total, row) => total + row.amount, 0)).toBe(
      server.balanceOf(createdRetainerId),
    )

    // And what the screen says, which has to be the same number three times
    // over: the running balance, the Remaining fact, and the list column.
    const running = [
      ...document.querySelectorAll('[data-retainer-ledger] tbody td[data-column="running"]'),
    ].map((cell) => cell.textContent)
    expect(running).toHaveLength(3)
    expect(running).toEqual(['$5,000.00', '$3,800.00', '$3,500.00'])
    expect(document.querySelector('[data-retainer-remaining]')?.textContent).toBe('$3,500.00')
    expect(document.querySelector('[data-retainer-deposited]')?.textContent).toBe('$5,000.00')
    expect(document.querySelector('[data-retainer-drawn]')?.textContent).toBe('$1,200.00')
    expect(document.querySelector('[data-retainer-adjusted]')?.textContent).toBe('-$300.00')

    // One create and three movements, each under its own key: a key is spent
    // once the server has decided about it.
    expect(server.commandIds).toHaveLength(4)
    expect(new Set(server.commandIds).size).toBe(4)
    for (const id of server.commandIds) expect(id).toMatch(/^[A-Za-z0-9._:-]{1,128}$/u)
  })

  it('[e2e:retainers] draws an hours retainer down in whole seconds', async () => {
    writeDocument()
    const server = ledgerServer([], [invoice()])
    const api = writableApi(server)
    await activate(api)

    document.querySelector<HTMLButtonElement>('[data-retainer-create]')!.click()
    choose('[data-retainer-create-client]', '4')
    choose('[data-retainer-create-basis]', 'hours')
    expect(document.querySelector('[data-retainer-create-amount-label]')?.textContent).toBe(
      'Agreed hours',
    )
    // The rate lock is offered exactly here, because `RetainerPatch` has no
    // field to add one later.
    expect(document.querySelector<HTMLElement>('[data-retainer-create-rate-row]')!.hidden).toBe(
      false,
    )
    fill('[data-retainer-create-amount]', '40')
    fill('[data-retainer-create-rate]', '150')
    submit('[data-retainer-create-form]')
    await detailReady()

    expect(vi.mocked(api.createRetainer!).mock.calls[0]![1]).toEqual({
      client_id: 4,
      project_id: null,
      denomination: 'hours',
      seconds: 144_000,
      locked_rate_cents: 15_000,
      rate_locked_at: expect.any(String),
      period: null,
      rollover: null,
      expires_at: null,
      on_exhaustion: 'block',
    })

    document.querySelector<HTMLButtonElement>('[data-retainer-movement]')!.click()
    choose('[data-retainer-movement-kind]', 'deposit')
    await vi.waitFor(() => expect(optionCount('[data-retainer-movement-invoice]')).toBe(1))
    expect(document.querySelector('[data-retainer-movement-amount-label]')?.textContent).toBe(
      'Hours',
    )
    fill('[data-retainer-movement-amount]', '40')
    submit('[data-retainer-movement-form]')
    await vi.waitFor(() => expect(writeStatusText()).toContain('The balance is now 40 hours.'))
    await detailReady()

    document.querySelector<HTMLButtonElement>('[data-retainer-drawdown]')!.click()
    await vi.waitFor(() => expect(optionCount('[data-retainer-drawdown-invoice]')).toBe(1))
    // 1.13 hours is 4,068 seconds exactly, and `1.13 * 3600` in binary floating
    // point is 4067.9999999999995 -- so a scale-and-truncate bills 4,067 and
    // leaves the client a second they already paid for.
    fill('[data-retainer-drawdown-amount]', '1.13')
    submit('[data-retainer-drawdown-form]')
    await vi.waitFor(() => expect(server.entries).toHaveLength(2))

    expect(vi.mocked(api.drawDownRetainer!).mock.calls[0]![2]).toEqual({
      invoice_id: 77,
      seconds: 4_068,
      occurred_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
      notes: null,
    })
    expect(server.balanceOf(createdRetainerId)).toBe(144_000 - 4_068)
    await detailReady()
    expect(document.querySelector('[data-retainer-remaining]')?.textContent).toBe('38.87 hours')
  })

  it('[money] refuses an overdraw before it reaches the ledger, and says by how much', async () => {
    writeDocument('/invoices/retainers?retainer=1')
    const server = ledgerServer([northpeak], [invoice({ retainer_id: 1 })])
    const api = writableApi(server)
    await activate(api)
    await detailReady()
    expect(server.entries).toHaveLength(1)

    document.querySelector<HTMLButtonElement>('[data-retainer-drawdown]')!.click()
    await vi.waitFor(() => expect(optionCount('[data-retainer-drawdown-invoice]')).toBe(1))
    // Northpeak holds $3,200.00 and blocks an overdraw.
    fill('[data-retainer-drawdown-amount]', '4000')
    expect(document.querySelector('[data-retainer-drawdown-projection]')?.textContent).toBe(
      '-$800.00 — more than this retainer holds',
    )
    submit('[data-retainer-drawdown-form]')

    expect(document.querySelector('[data-retainer-drawdown-result]')?.textContent).toBe(
      'This retainer holds $3,200.00. Drawing down $4,000.00 would overdraw it, which its exhaustion policy does not allow.',
    )
    expect(api.drawDownRetainer).not.toHaveBeenCalled()
    expect(server.entries).toHaveLength(1)

    // Zero is refused for the reason the API refuses it, without spending a
    // request to find out.
    fill('[data-retainer-drawdown-amount]', '0')
    submit('[data-retainer-drawdown-form]')
    expect(document.querySelector('[data-retainer-drawdown-result]')?.textContent).toBe(
      'A drawdown of zero changes nothing and the ledger refuses it.',
    )
    expect(api.drawDownRetainer).not.toHaveBeenCalled()

    // To the cent is not an overdraw, so the same dialog lets that through.
    fill('[data-retainer-drawdown-amount]', '3200')
    submit('[data-retainer-drawdown-form]')
    await vi.waitFor(() => expect(server.entries).toHaveLength(2))
    expect(server.balanceOf(1)).toBe(0)
  })

  it('[money] retries a lost drawdown under the same key, so the balance moves once', async () => {
    writeDocument('/invoices/retainers?retainer=1')
    const server = ledgerServer([northpeak], [invoice({ retainer_id: 1 })])
    const api = writableApi(server)
    const commit = api.drawDownRetainer!
    let attempts = 0
    const drawDown = vi.fn<RetainerWorkspaceApi['drawDownRetainer']>(
      async (id, commandId, input, signal) => {
        attempts += 1
        const mutation = await commit(id, commandId, input, signal)
        // The shape that makes an idempotency key worth carrying: the row landed
        // and the response did not come back. A fresh key on the retry would
        // draw the retainer down twice.
        if (attempts === 1) throw new TypeError('Load failed')
        return mutation
      },
    )
    api.drawDownRetainer = drawDown
    await activate(api)
    await detailReady()

    document.querySelector<HTMLButtonElement>('[data-retainer-drawdown]')!.click()
    await vi.waitFor(() => expect(optionCount('[data-retainer-drawdown-invoice]')).toBe(1))
    fill('[data-retainer-drawdown-amount]', '1200')
    submit('[data-retainer-drawdown-form]')
    await vi.waitFor(() =>
      expect(document.querySelector('[data-retainer-drawdown-result]')?.textContent).toBe(
        'Load failed',
      ),
    )
    // The typed amount survives the failure, so the retry is the same command
    // rather than a second one the operator has to re-type.
    expect(document.querySelector<HTMLInputElement>('[data-retainer-drawdown-amount]')!.value).toBe(
      '1200',
    )

    submit('[data-retainer-drawdown-form]')
    await vi.waitFor(() =>
      expect(writeStatusText()).toBe('Drew down $1,200.00. The balance is now $2,000.00.'),
    )

    expect(drawDown).toHaveBeenCalledTimes(2)
    const keys = drawDown.mock.calls.map((call) => call[1])
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
    // Two requests, one row: the server replayed the key rather than repeating
    // the command.
    expect(server.entries).toHaveLength(2)
    expect(server.balanceOf(1)).toBe(320_000 - 120_000)
  })

  it('[conflict] reloads the balance a refused movement lost to, and takes a new key', async () => {
    writeDocument('/invoices/retainers?retainer=1')
    const server = ledgerServer([northpeak], [invoice({ retainer_id: 1 })])
    const api = writableApi(server)
    const commit = api.appendRetainerLedger!
    let attempts = 0
    const appendLedger = vi.fn<RetainerWorkspaceApi['appendRetainerLedger']>(
      async (id, commandId, input, signal) => {
        attempts += 1
        if (attempts > 1) return commit(id, commandId, input, signal)
        // Someone else moved the balance between this screen's read and its
        // write, and `retainer_ledger_balance_guard` refused the row.
        server.append(id, 'concurrent-elsewhere', 'drawdown', {
          amount_cents: 200_000,
          invoice_id: 77,
          occurred_on: '2026-03-01',
          notes: null,
        })
        throw new EzactoApiError(
          409,
          { error: { code: 'trigger_row_conflict', message: 'resource conflict', fields: [] } },
          null,
        )
      },
    )
    api.appendRetainerLedger = appendLedger
    await activate(api)
    await detailReady()

    document.querySelector<HTMLButtonElement>('[data-retainer-movement]')!.click()
    fill('[data-retainer-movement-amount]', '300')
    fill('[data-retainer-movement-notes]', 'Opening balance from the worksheet')
    submit('[data-retainer-movement-form]')
    await vi.waitFor(() =>
      expect(document.querySelector('[data-retainer-movement-result]')?.textContent).toBe(
        'This retainer changed elsewhere. The current balance is loading; check it and try again.',
      ),
    )
    await detailReady()
    // The reload is the point of the message: the operator now sees the balance
    // that won, not the one their movement was computed against.
    expect(document.querySelector('[data-retainer-remaining]')?.textContent).toBe('$1,200.00')

    submit('[data-retainer-movement-form]')
    await vi.waitFor(() =>
      expect(writeStatusText()).toBe(
        'Adjustment of $300.00 recorded. The balance is now $1,500.00.',
      ),
    )
    const keys = appendLedger.mock.calls.map((call) => call[1])
    expect(keys).toHaveLength(2)
    // A key the server has already decided about cannot carry the next command.
    expect(keys[0]).not.toBe(keys[1])
    expect(server.balanceOf(1)).toBe(320_000 - 200_000 + 30_000)
  })

  it('[browser] asks an adjustment for the reason the ledger requires, and no other kind', async () => {
    writeDocument('/invoices/retainers?retainer=1')
    const server = ledgerServer([northpeak], [invoice({ retainer_id: 1 })])
    const api = writableApi(server)
    await activate(api)
    await detailReady()

    document.querySelector<HTMLButtonElement>('[data-retainer-movement]')!.click()
    expect(document.querySelector('[data-retainer-movement-notes-label]')?.textContent).toBe(
      'Reason (required)',
    )
    fill('[data-retainer-movement-amount]', '300')
    submit('[data-retainer-movement-form]')
    expect(document.querySelector('[data-retainer-movement-result]')?.textContent).toBe(
      'An adjustment needs a reason. Say what it corrects.',
    )
    expect(api.appendRetainerLedger).not.toHaveBeenCalled()

    // An expiry is not an adjustment, and the ledger asks it for nothing.
    choose('[data-retainer-movement-kind]', 'expiry')
    expect(document.querySelector('[data-retainer-movement-notes-label]')?.textContent).toBe(
      'Reason',
    )
    submit('[data-retainer-movement-form]')
    await vi.waitFor(() => expect(server.entries).toHaveLength(2))
    // An expiry is a magnitude the server negates, so the screen sends 30,000
    // positive and the row lands negative.
    expect(vi.mocked(api.appendRetainerLedger!).mock.calls[0]![2]).toEqual({
      kind: 'expiry',
      amount_cents: 30_000,
      occurred_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
      notes: null,
    })
    expect(server.entries.at(-1)!.amount).toBe(-30_000)
    expect(server.balanceOf(1)).toBe(290_000)
  })

  it('[browser] sends only the policy fields that changed, because PATCH carries no version', async () => {
    writeDocument('/invoices/retainers?retainer=1')
    const server = ledgerServer([northpeak], [])
    const api = writableApi(server)
    await activate(api)
    await detailReady()

    document.querySelector<HTMLButtonElement>('[data-retainer-policy-edit]')!.click()
    expect(document.querySelector<HTMLDialogElement>('[data-retainer-policy-dialog]')!.open).toBe(
      true,
    )
    // The dialog opens on the retainer's own policy rather than on defaults.
    expect(document.querySelector<HTMLInputElement>('[data-retainer-policy-period]')!.value).toBe(
      'monthly',
    )
    expect(document.querySelector<HTMLSelectElement>('[data-retainer-policy-rollover]')!.value).toBe(
      'carry',
    )

    submit('[data-retainer-policy-form]')
    expect(document.querySelector('[data-retainer-policy-result]')?.textContent).toBe(
      'Nothing has changed.',
    )
    expect(api.updateRetainer).not.toHaveBeenCalled()

    choose('[data-retainer-policy-state]', 'closed')
    submit('[data-retainer-policy-form]')
    await vi.waitFor(() => expect(writeStatusText()).toBe('Retainer policy saved.'))
    // Four values nobody touched stay out of the body: with no expected version
    // to guard them, sending them would clobber another writer's change.
    expect(vi.mocked(api.updateRetainer!).mock.calls[0]![1]).toEqual({ state: 'closed' })
  })

  it('[security] offers no write control to an identity without invoices:write', async () => {
    writeDocument('/invoices/retainers?retainer=1')
    const server = ledgerServer([northpeak], [invoice({ retainer_id: 1 })])
    const api = writableApi(server)
    await createRetainerWorkspaceController(api).activate(
      {
        user_id: 2,
        profile: 'accounting',
        manager_grants: [],
        authentication: { kind: 'token', token_id: 3, scopes: ['invoices:read'] },
      },
      new AbortController().signal,
      () => false,
    )
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-retainer-detail-body]')!.hidden).toBe(
        false,
      ),
    )

    // The read path still works — this is a reader, not a stranger.
    expect(document.querySelector('[data-retainer-remaining]')?.textContent).toBe('$3,200.00')
    const create = document.querySelector<HTMLButtonElement>('[data-retainer-create]')!
    expect(create.hidden).toBe(true)
    expect(create.disabled).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-retainer-write-actions]')!.hidden).toBe(true)
    const triggers = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[data-retainer-drawdown], [data-retainer-movement], [data-retainer-policy-edit]',
      ),
    ]
    expect(triggers).toHaveLength(3)
    for (const trigger of triggers) expect(trigger.disabled).toBe(true)

    // And a click that gets past a disabled attribute still writes nothing.
    for (const trigger of triggers) trigger.click()
    create.click()
    expect(document.querySelector<HTMLDialogElement>('[data-retainer-create-dialog]')!.open).toBe(
      false,
    )
    expect(document.querySelector<HTMLDialogElement>('[data-retainer-drawdown-dialog]')!.open).toBe(
      false,
    )
    expect(api.createRetainer).not.toHaveBeenCalled()
    expect(api.drawDownRetainer).not.toHaveBeenCalled()
    expect(api.appendRetainerLedger).not.toHaveBeenCalled()
  })
})
