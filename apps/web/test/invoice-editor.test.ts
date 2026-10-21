/** @vitest-environment happy-dom */

import {
  EzactoApiError,
  type GeneralResource,
  type Invoice,
  type InvoiceEditInput,
  type InvoiceLine,
  type InvoiceHoursReconciliationEnvelope,
  type InvoiceLineInput,
  type InvoiceLineUpdateInput,
  type VersionedRowDeleteInput,
  type Whoami,
} from '@conflict-hq/ezacto-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInvoiceEditorController } from '../src/invoices/editor.js'
import type { InvoiceEditorApi } from '../src/invoices/model.js'
import { renderAppShell, webAssets } from '../src/index.js'

const timestamp = '2026-08-28T12:00:00.000Z'
const later = '2026-08-29T12:00:00.000Z'

const identity = (authentication: Whoami['authentication'] = { kind: 'session' }): Whoami => ({
  user_id: 1,
  profile: 'accounting',
  manager_grants: [],
  authentication,
})

const line = (overrides: Partial<InvoiceLine> = {}): InvoiceLine => ({
  id: 21,
  invoice_id: 7,
  position: 0,
  kind: 'Service',
  description: 'Platform support',
  quantity: 2,
  unit_price_cents: 1_500,
  amount_cents: 3_000,
  taxed: false,
  taxed2: false,
  project_id: 1,
  created_at: timestamp,
  updated_at: timestamp,
  ...overrides,
})

const invoice = (overrides: Partial<Invoice> = {}): Invoice => ({
  id: 7,
  client_id: 4,
  created_by_user_id: 1,
  number: 'INV-7',
  subject: 'August services',
  purchase_order: 'PO-1',
  notes: 'Thank you.',
  currency: 'USD',
  issue_date: '2026-08-01',
  due_date: '2026-08-31',
  payment_terms: 'net_30',
  state: 'open',
  version: 1,
  close_reason: null,
  close_write_off_cents: 0,
  sent_at: timestamp,
  paid_at: null,
  paid_date: null,
  closed_at: null,
  period_start: null,
  period_end: null,
  project_id: null,
  retainer_id: null,
  recurring_invoice_id: null,
  estimate_id: null,
  reminder_policy: null,
  tax_rate_ppm: null,
  tax2_rate_ppm: null,
  discount_rate_ppm: null,
  amount_cents: 4_000,
  due_amount_cents: 4_000,
  tax_amount_cents: 0,
  tax2_amount_cents: 0,
  discount_amount_cents: 0,
  written_off_cents: 0,
  payment_options: [],
  reference_token: null,
  created_at: timestamp,
  updated_at: timestamp,
  line_items: [
    line(),
    line({
      id: 22,
      position: 1,
      kind: 'Product',
      description: 'Licence',
      quantity: 1,
      unit_price_cents: 1_000,
      amount_cents: 1_000,
      project_id: 9,
    }),
  ],
  ...overrides,
})

const resource = (id: number, fields: Record<string, unknown>): GeneralResource => ({
  id,
  created_at: timestamp,
  updated_at: timestamp,
  ...fields,
})

const conflict = (code: string): EzactoApiError =>
  new EzactoApiError(409, { error: { code, message: 'server conflict', fields: [] } }, null)

/**
 * The invoice commands as the server answers them: one edit per request, a
 * version check on every one, a row check on line writes, and the ledger's
 * replay of a retried key -- the same answer for the same request, a refusal
 * for a different one. Enough of the real thing that a test proves the page
 * against the rules it has to live with, rather than against a stub that
 * agrees with whatever it is sent.
 */
const server = (initial: Invoice) => {
  let current = initial
  let nextLineId = 100
  const ledger = new Map<string, { readonly body: string; readonly result: Invoice }>()
  const failures: {
    method: string
    error: unknown
    afterCommit: boolean
    when: (input: unknown) => boolean
  }[] = []
  const stamp = (): string => `2026-08-29T12:00:${String(current.version).padStart(2, '0')}.000Z`
  const commit = (patch: Partial<Invoice>): Invoice => {
    const lines = patch.line_items ?? current.line_items
    const amount = lines.reduce((sum, item) => sum + item.amount_cents, 0)
    current = {
      ...current,
      ...patch,
      line_items: lines,
      amount_cents: amount,
      due_amount_cents: amount,
      version: current.version + 1,
    }
    return current
  }
  const run = async (
    method: string,
    commandId: string,
    input: unknown,
    apply: () => Invoice,
  ): Promise<Invoice> => {
    const body = JSON.stringify(input)
    const prior = ledger.get(commandId)
    if (prior !== undefined) {
      if (prior.body === body) return prior.result
      throw conflict('command_id_reused')
    }
    const failure = failures.findIndex(
      (candidate) => candidate.method === method && candidate.when(input),
    )
    const planned = failure === -1 ? null : failures.splice(failure, 1)[0]!
    if (planned !== null && !planned.afterCommit) throw planned.error
    const result = apply()
    ledger.set(commandId, { body, result })
    if (planned !== null) throw planned.error
    return result
  }
  const expectVersion = (expected: number): void => {
    if (expected !== current.version) throw conflict('invoice_version_conflict')
  }
  const existing = (lineId: number, updatedAt: string): InvoiceLine => {
    const found = current.line_items.find((candidate) => candidate.id === lineId)
    if (found === undefined || found.updated_at !== updatedAt) throw conflict('trigger_row_conflict')
    return found
  }
  const priced = (quantity: number, unit: number): number => Math.round(quantity * unit)
  const api = {
    getInvoice: vi.fn(async () => current),
    // The list narrowed to one number: exact, and compared as text.
    findInvoiceByNumber: vi.fn(async (number: string) =>
      number === current.number ? current : null,
    ),
    getDirectoryClient: vi.fn(async (id: number) => resource(id, { name: 'Northpeak' })),
    listInvoiceClientProjects: vi.fn(async () => ({
      data: [
        resource(1, { name: 'Ingest rebuild', is_active: true }),
        resource(2, { name: 'Old migration', is_active: false }),
      ],
      page: { next_cursor: null },
    })),
    updateInvoice: vi.fn(async (_id: number, commandId: string, input: InvoiceEditInput) =>
      run('updateInvoice', commandId, input, () => {
        expectVersion(input.expected_version)
        const edit: Partial<InvoiceEditInput> = { ...input }
        delete edit.expected_version
        return commit(edit as Partial<Invoice>)
      }),
    ),
    createInvoiceLine: vi.fn(async (_id: number, commandId: string, input: InvoiceLineInput) =>
      run('createInvoiceLine', commandId, input, () => {
        expectVersion(input.expected_version)
        const created = line({
          id: nextLineId++,
          position: input.position,
          kind: input.kind,
          description: input.description ?? null,
          quantity: input.quantity,
          unit_price_cents: input.unit_price_cents,
          amount_cents: priced(input.quantity, input.unit_price_cents),
          taxed: input.taxed ?? false,
          taxed2: input.taxed2 ?? false,
          project_id: input.project_id ?? null,
          updated_at: stamp(),
        })
        return commit({ line_items: [...current.line_items, created] })
      }),
    ),
    updateInvoiceLine: vi.fn(
      async (_id: number, lineId: number, commandId: string, input: InvoiceLineUpdateInput) =>
        run('updateInvoiceLine', commandId, input, () => {
          expectVersion(input.expected_version)
          const found = existing(lineId, input.expected_updated_at)
          const changed: InvoiceLine = {
            ...found,
            position: input.position,
            kind: input.kind,
            description: input.description ?? null,
            quantity: input.quantity,
            unit_price_cents: input.unit_price_cents,
            amount_cents: priced(input.quantity, input.unit_price_cents),
            taxed: input.taxed ?? false,
            taxed2: input.taxed2 ?? false,
            project_id: input.project_id ?? null,
            updated_at: stamp(),
          }
          return commit({
            line_items: current.line_items.map((item) => (item.id === lineId ? changed : item)),
          })
        }),
    ),
    deleteInvoiceLine: vi.fn(
      async (_id: number, lineId: number, commandId: string, input: VersionedRowDeleteInput) =>
        run('deleteInvoiceLine', commandId, input, () => {
          expectVersion(input.expected_version)
          existing(lineId, input.expected_updated_at)
          return commit({ line_items: current.line_items.filter((item) => item.id !== lineId) })
        }),
    ),
  } satisfies InvoiceEditorApi
  return {
    api,
    current: () => current,
    /** Somebody else's write, landing between the page's read and its save. */
    elsewhere: (patch: Partial<Invoice>) => {
      commit(patch)
    },
    /**
     * The next call to `method` (that `when` picks out) fails -- before it
     * commits, or after it, which is an answer lost on the way back.
     */
    fail: (
      method: keyof typeof api,
      error: unknown,
      options: { readonly afterCommit?: boolean; readonly when?: (input: unknown) => boolean } = {},
    ) => {
      failures.push({
        method,
        error,
        afterCommit: options.afterCommit ?? false,
        when: options.when ?? (() => true),
      })
    },
  }
}

const renderEditor = (path: string, hash: string): void => {
  window.history.replaceState(null, '', `${path}${hash}`)
  globalThis.sessionStorage.clear()
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'invoice-editor-test',
      activeSection: 'Invoices',
      view: 'invoice-edit',
    })
      .replace(/ {2}<link[^>]+>\n/gu, '')
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
  // What the shell has done by the time the page activates: named the page and
  // let the signed-in shell take focus.
  document.title = 'eZacto — Edit invoice'
  const shell = document.querySelector<HTMLElement>('[data-authenticated-shell]')!
  shell.hidden = false
  shell.inert = false
}

const open = async (
  api: Partial<InvoiceEditorApi>,
  options: {
    readonly path?: string
    readonly hash?: string
    readonly who?: Whoami
    readonly signal?: AbortSignal
  } = {},
): Promise<void> => {
  // Where every link in the app sends it: the invoice's number.
  renderEditor(options.path ?? '/invoices/INV-7/edit', options.hash ?? '')
  await createInvoiceEditorController(api).activate(
    options.who ?? identity(),
    options.signal ?? new AbortController().signal,
    () => false,
  )
}

const stubNavigation = (): ReturnType<typeof vi.fn> => {
  const assign = vi.fn()
  vi.stubGlobal('location', Object.assign(new URL(globalThis.location.href), { assign }))
  return assign
}

const control = <Element extends HTMLElement>(selector: string): Element => {
  const element = document.querySelector<Element>(selector)
  if (element === null) throw new Error(`missing test selector: ${selector}`)
  return element
}

const rows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-invoice-edit-line-list] [data-invoice-edit-line]'),
]

const field = <Element extends HTMLElement = HTMLInputElement>(
  position: number,
  name: string,
): Element => {
  const row = rows()[position]
  if (row === undefined) throw new Error(`no line at position ${position}`)
  const found = row.querySelector<Element>(`[data-invoice-edit-line-field="${name}"]`)
  if (found === null) throw new Error(`no ${name} on line ${position}`)
  return found
}

/** As a person does it: the value, then the event that says it changed. */
const type = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void => {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

const save = (): void => {
  control<HTMLFormElement>('[data-invoice-edit-form]').dispatchEvent(
    new SubmitEvent('submit', { bubbles: true, cancelable: true }),
  )
}

const result = (): HTMLElement => control<HTMLElement>('[data-invoice-edit-result]')

const notice = (): unknown =>
  JSON.parse(globalThis.sessionStorage.getItem('ezacto.page-notice') ?? 'null')

const hoursReview = (): InvoiceHoursReconciliationEnvelope['data'] => ({
  invoice_id: 7,
  invoice_version: 1,
  invoice_state: 'draft',
  linked_seconds: 7200,
  billed_seconds: 7200,
  difference_seconds: 0,
  status: 'matched',
  tolerance_seconds: 36,
  total_tolerance_seconds: 36,
  comparison_complete: true,
  has_mismatch: false,
  not_compared_entry_ids: [],
  projects: [
    {
      project_id: 1,
      project_name: 'Platform',
      linked_seconds: 7200,
      billed_seconds: 7200,
      difference_seconds: 0,
      status: 'matched',
      tolerance_seconds: 36,
    },
  ],
  not_compared: [],
  lines: [
    {
      line_id: 21,
      project_id: 1,
      entry_ids: [1],
      linked_seconds: 7200,
      billed_seconds: 7200,
      difference_seconds: 0,
      status: 'matched',
    },
  ],
  entries: [
    {
      entry_id: 1,
      user_id: 1,
      user_name: 'Person',
      spent_date: '2026-08-01',
      project_id: 1,
      project_name: 'Platform',
      seconds: 7200,
    },
  ],
})

describe('invoice edit page', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('shows linked vs billed hours immediately when a generated quantity is trimmed and clears them at session end', async () => {
    const { api } = server(invoice()),
      abort = new AbortController()
    const read = vi.fn(async () => hoursReview())
    await open(
      { ...api, getInvoiceHoursReconciliation: read },
      { signal: abort.signal },
    )
    const warning = control('[data-invoice-edit-hours-warning]')
    expect(warning.hidden).toBe(true)
    type(field<HTMLInputElement>(0, 'quantity'), '1.5')
    expect(warning.hidden).toBe(false)
    expect(warning.textContent).toContain(
      'Linked: 2.00 h · compared lines bill: 1.50 h',
    )
    expect(
      rows()[0]!.querySelector('[data-invoice-edit-linked-hours]')!.textContent,
    ).toContain('Linked: 2.00 h · billed: 1.50 h')
    type(field<HTMLInputElement>(0, 'quantity'), '2')
    expect(warning.hidden).toBe(true)
    abort.abort()
    expect(warning.textContent).toBe('')
  })
  it('distinguishes unavailable provenance from matching hours and does not treat fee quantities as hours', async () => {
    const { api } = server(invoice())
    const review = {
      ...hoursReview(),
      comparison_complete: false,
      status: 'not_comparable' as const,
      lines: [],
      not_compared_entry_ids: [1],
    }
    await open({
      ...api,
      getInvoiceHoursReconciliation: vi.fn(async () => review),
    })
    type(field<HTMLInputElement>(0, 'quantity'), '12')
    expect(control('[data-invoice-edit-hours-warning]').textContent).toContain(
      'cannot be compared with a billed hours quantity',
    )
    expect(
      control('[data-invoice-edit-hours-warning]').textContent,
    ).not.toContain('bill: 12')
  })
  it('does not show a mismatch for an invoice with no linked time and explains a failed read', async () => {
    const { api } = server(invoice())
    await open({
      ...api,
      getInvoiceHoursReconciliation: vi.fn(async () => ({
        ...hoursReview(),
        entries: [],
        linked_seconds: 0,
      })),
    })
    type(field<HTMLInputElement>(0, 'quantity'), '1')
    expect(control('[data-invoice-edit-hours-warning]').hidden).toBe(true)
    await open({
      ...api,
      getInvoiceHoursReconciliation: vi.fn(async () => {
        throw new Error('offline')
      }),
    })
    expect(control('[data-invoice-edit-hours-warning]').textContent).toContain(
      'could not be compared',
    )
  })



  it('[browser] opens on the document and every line, with the client and its projects', async () => {
    const { api } = server(invoice())
    await open(api)

    // The address carries the number; the page reads the record by its id.
    expect(api.findInvoiceByNumber).toHaveBeenCalledWith('INV-7', expect.any(AbortSignal))
    expect(api.getInvoice).toHaveBeenCalledWith(7, expect.any(AbortSignal))
    expect(globalThis.location.pathname).toBe('/invoices/INV-7/edit')
    expect(control<HTMLFormElement>('[data-invoice-edit-form]').hidden).toBe(false)
    expect(control('[data-invoice-edit-title]').textContent).toBe('Edit invoice INV-7')
    expect(document.title).toBe('eZacto — Edit invoice INV-7')
    expect(control('[data-invoice-edit-client]').textContent).toBe('Northpeak')
    expect(api.listInvoiceClientProjects).toHaveBeenCalledWith(4, undefined, expect.any(AbortSignal))
    expect(control<HTMLInputElement>('[data-invoice-edit-subject]').value).toBe('August services')
    expect(control<HTMLInputElement>('[data-invoice-edit-purchase-order]').value).toBe('PO-1')
    expect(control<HTMLInputElement>('[data-invoice-edit-issue-date]').value).toBe('2026-08-01')
    expect(control<HTMLInputElement>('[data-invoice-edit-due-date]').value).toBe('2026-08-31')
    expect(control<HTMLSelectElement>('[data-invoice-edit-payment-terms]').value).toBe('net_30')
    expect(control<HTMLTextAreaElement>('[data-invoice-edit-notes]').value).toBe('Thank you.')
    expect(control<HTMLInputElement>('[data-invoice-edit-tax]').value).toBe('')
    // Back and Cancel return to the invoice the page was opened from.
    expect(control<HTMLAnchorElement>('[data-invoice-edit-back]').getAttribute('href')).toBe(
      '/invoices/INV-7',
    )
    expect(control<HTMLAnchorElement>('[data-invoice-edit-cancel]').getAttribute('href')).toBe(
      '/invoices/INV-7',
    )

    expect(rows()).toHaveLength(2)
    expect(field(0, 'kind').value).toBe('Service')
    expect(field<HTMLTextAreaElement>(0, 'description').value).toBe('Platform support')
    expect(field(0, 'quantity').value).toBe('2')
    expect(field(0, 'rate').value).toBe('15.00')
    expect(control('[data-invoice-edit-rate-heading]').textContent).toBe('Unit price (USD)')
    // The client's projects, archived ones named as such, and a link the list
    // did not return kept rather than silently unlinked on the next save.
    const linked = field<HTMLSelectElement>(0, 'projectId')
    expect([...linked.options].map((option) => [option.value, option.textContent])).toEqual([
      ['', 'No project'],
      ['1', 'Ingest rebuild'],
      ['2', 'Old migration (archived)'],
    ])
    expect(linked.value).toBe('1')
    const stranded = field<HTMLSelectElement>(1, 'projectId')
    expect(stranded.value).toBe('9')
    expect(stranded.selectedOptions[0]?.textContent).toBe('Project #9')
    expect(control('[data-invoice-edit-subtotal]').textContent).toBe('$40.00')
  })

  it('[e2e:invoice-header] saves the document and the rates as two sequenced commands, then returns to the invoice', async () => {
    const backend = server(invoice())
    await open(backend.api)
    const assign = stubNavigation()

    type(control('[data-invoice-edit-subject]'), 'Revised subject')
    type(control('[data-invoice-edit-purchase-order]'), 'PO-77')
    // Notes are prose the client reads, so the line breaks someone typed are
    // part of what they wrote and have to survive the round trip.
    type(control('[data-invoice-edit-notes]'), 'Thanks for your business.\nWire details overleaf.')
    type(control('[data-invoice-edit-due-date]'), '2026-09-15')
    type(control('[data-invoice-edit-payment-terms]'), 'net_45')
    type(control('[data-invoice-edit-tax]'), '8.25')
    save()

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/invoices/INV-7'))
    expect(backend.api.updateInvoice).toHaveBeenCalledTimes(2)
    expect(backend.api.updateInvoice).toHaveBeenNthCalledWith(
      1,
      7,
      expect.stringMatching(/^web\.invoice\.header:/u),
      {
        expected_version: 1,
        subject: 'Revised subject',
        purchase_order: 'PO-77',
        notes: 'Thanks for your business.\nWire details overleaf.',
        issue_date: '2026-08-01',
        due_date: '2026-09-15',
        payment_terms: 'net_45',
      },
      expect.any(AbortSignal),
    )
    // The API takes one edit kind per request, so the rates are a second
    // command at the version the first returned.
    expect(backend.api.updateInvoice).toHaveBeenNthCalledWith(
      2,
      7,
      expect.stringMatching(/^web\.invoice\.financials:/u),
      { expected_version: 2, tax_rate_ppm: 82_500, tax2_rate_ppm: null, discount_rate_ppm: null },
      expect.any(AbortSignal),
    )
    expect(backend.api.createInvoiceLine).not.toHaveBeenCalled()
    expect(backend.api.updateInvoiceLine).not.toHaveBeenCalled()
    expect(notice()).toEqual({ pathname: '/invoices/INV-7', message: 'Invoice saved.' })
  })

  it('[e2e:invoice-header] clears a note to null and sends nothing when nothing changed', async () => {
    const backend = server(invoice())
    await open(backend.api)
    const assign = stubNavigation()

    // Saving without touching anything must not invent a command: a write
    // bumps the version, so a spurious one would trip the next real edit.
    save()
    expect(result().textContent).toBe('Nothing changed.')
    expect(backend.api.updateInvoice).not.toHaveBeenCalled()
    expect(assign).not.toHaveBeenCalled()

    // An emptied field is a removed note, not the empty string -- the column is
    // nullable and "" would print a blank Notes section on the invoice.
    type(control('[data-invoice-edit-notes]'), '   ')
    save()
    await vi.waitFor(() => expect(backend.api.updateInvoice).toHaveBeenCalledTimes(1))
    expect(backend.api.updateInvoice.mock.calls[0]?.[2]).toMatchObject({ notes: null })
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/invoices/INV-7'))
  })

  it('[reliability] keeps a committed header edit and retries only the failed rate command', async () => {
    const backend = server(invoice())
    // The header lands; the rates are refused on their way out.
    backend.fail('updateInvoice', new Error('network unavailable'), {
      when: (input) => typeof input === 'object' && input !== null && 'tax_rate_ppm' in input,
    })
    await open(backend.api)
    const assign = stubNavigation()

    type(control('[data-invoice-edit-purchase-order]'), 'PO-9')
    type(control('[data-invoice-edit-discount]'), '5')
    save()
    await vi.waitFor(() =>
      expect(result().textContent).toBe(
        'network unavailable What saved before this stays saved; save again to send the rest.',
      ),
    )
    expect(result().dataset.outcome).toBe('error')
    expect(assign).not.toHaveBeenCalled()
    expect(backend.current().purchase_order).toBe('PO-9')
    const firstRates = backend.api.updateInvoice.mock.calls[1]!

    save()
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/invoices/INV-7'))
    // Only what was left, under the key it was first sent with, at the version
    // the committed header returned.
    expect(backend.api.updateInvoice).toHaveBeenCalledTimes(3)
    expect(backend.api.updateInvoice.mock.calls[2]?.[2]).toEqual({
      expected_version: 2,
      tax_rate_ppm: null,
      tax2_rate_ppm: null,
      discount_rate_ppm: 50_000,
    })
    expect(backend.api.updateInvoice.mock.calls[2]?.[1]).toBe(firstRates[1])
    expect(backend.current().discount_rate_ppm).toBe(50_000)
  })

  it('[conflict] keeps the edits when the invoice moved on, and saves them at the new version', async () => {
    const backend = server(invoice())
    await open(backend.api)
    const assign = stubNavigation()

    type(control('[data-invoice-edit-subject]'), 'Revised subject')
    // Somebody else corrects the purchase order before this page saves.
    backend.elsewhere({ purchase_order: 'PO-2' })
    save()
    await vi.waitFor(() =>
      expect(result().textContent).toContain('Latest values are loaded with your changes kept'),
    )
    expect(assign).not.toHaveBeenCalled()
    // A stale version is the one failure that must not cost the edit, and the
    // reload must not cost the other person theirs: what was typed here stays,
    // and what was not takes the newer value.
    expect(control<HTMLInputElement>('[data-invoice-edit-subject]').value).toBe('Revised subject')
    expect(control<HTMLInputElement>('[data-invoice-edit-purchase-order]').value).toBe('PO-2')
    expect(control<HTMLInputElement>('[data-invoice-edit-subject]').disabled).toBe(false)

    save()
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/invoices/INV-7'))
    const [first, second] = backend.api.updateInvoice.mock.calls
    expect(second?.[2]).toMatchObject({
      expected_version: 2,
      subject: 'Revised subject',
      purchase_order: 'PO-2',
    })
    // A different version is a different request, so a different key.
    expect(second?.[1]).not.toBe(first?.[1])
  })

  it('[e2e:invoice-lines] removes, changes and adds lines in one save, each under its own held key', async () => {
    const backend = server(invoice())
    // The new line lands and its answer is lost on the way back.
    backend.fail('createInvoiceLine', new Error('network unavailable'), { afterCommit: true })
    await open(backend.api)
    const assign = stubNavigation()

    type(field(0, 'quantity'), '1.5')
    type(field(0, 'rate'), '2.05')
    type(field<HTMLSelectElement>(0, 'projectId'), '')
    expect(rows()[0]!.querySelector('[data-invoice-edit-line-amount]')?.textContent).toBe('$3.08')
    rows()[1]!.querySelector<HTMLButtonElement>('[data-invoice-edit-line-remove]')!.click()
    control<HTMLButtonElement>('[data-invoice-edit-add-line]').click()
    expect(rows()).toHaveLength(3)
    type(field(2, 'kind'), 'Consulting')
    type(field<HTMLTextAreaElement>(2, 'description'), 'Exact tenth-hour adjustment')
    type(field(2, 'quantity'), '0.1')
    type(field(2, 'rate'), '1.05')
    field(2, 'taxed').click()
    type(field<HTMLSelectElement>(2, 'projectId'), '1')
    expect(rows()[2]!.querySelector('[data-invoice-edit-line-amount]')?.textContent).toBe('$0.11')
    // The removed line no longer counts toward the total.
    expect(control('[data-invoice-edit-subtotal]').textContent).toBe('$3.19')
    save()

    await vi.waitFor(() =>
      expect(result().textContent).toBe(
        'network unavailable What saved before this stays saved; save again to send the rest.',
      ),
    )
    // Removals first, then changes, then additions, each on the version the
    // one before it returned.
    expect(backend.api.deleteInvoiceLine).toHaveBeenCalledWith(
      7,
      22,
      expect.stringMatching(/^web\.invoice\.line\.delete:/u),
      { expected_version: 1, expected_updated_at: timestamp },
      expect.any(AbortSignal),
    )
    expect(backend.api.updateInvoiceLine).toHaveBeenCalledWith(
      7,
      21,
      expect.stringMatching(/^web\.invoice\.line\.update:/u),
      {
        expected_version: 2,
        expected_updated_at: timestamp,
        position: 0,
        kind: 'Service',
        description: 'Platform support',
        quantity: 1.5,
        unit_price_cents: 205,
        taxed: false,
        taxed2: false,
        project_id: null,
      },
      expect.any(AbortSignal),
    )
    expect(backend.api.createInvoiceLine).toHaveBeenCalledWith(
      7,
      expect.stringMatching(/^web\.invoice\.line\.create:/u),
      {
        expected_version: 3,
        // After the line it was removed from: positions are read off the
        // invoice as each command left it, not as the page first found it.
        position: 1,
        kind: 'Consulting',
        description: 'Exact tenth-hour adjustment',
        quantity: 0.1,
        unit_price_cents: 105,
        taxed: true,
        taxed2: false,
        project_id: 1,
      },
      expect.any(AbortSignal),
    )
    // Committed work is off the page: the removed row is gone.
    expect(rows()).toHaveLength(2)

    save()
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/invoices/INV-7'))
    // The lost answer is replayed under the key it was sent with, not sent
    // again as a second line; nothing that landed is sent twice.
    expect(backend.api.createInvoiceLine).toHaveBeenCalledTimes(2)
    expect(backend.api.createInvoiceLine.mock.calls[1]?.[1]).toBe(
      backend.api.createInvoiceLine.mock.calls[0]?.[1],
    )
    expect(backend.api.deleteInvoiceLine).toHaveBeenCalledTimes(1)
    expect(backend.api.updateInvoiceLine).toHaveBeenCalledTimes(1)
    expect(backend.current().line_items.map((item) => item.kind)).toEqual(['Service', 'Consulting'])
  })

  it('[browser] refuses a line that does not parse, names it, and sends nothing', async () => {
    const backend = server(invoice())
    await open(backend.api)
    stubNavigation()

    type(control('[data-invoice-edit-subject]'), 'Revised subject')
    type(field(1, 'quantity'), '1,5')
    save()
    expect(result().textContent).toBe('Line 2: Quantity must be a plain decimal number.')
    expect(result().dataset.outcome).toBe('error')

    type(field(1, 'quantity'), '1')
    type(field(0, 'kind'), '  ')
    save()
    expect(result().textContent).toBe('Line 1: Enter an item type.')
    // Checked before anything is sent: the subject waits with the lines.
    expect(backend.api.updateInvoice).not.toHaveBeenCalled()
    expect(backend.api.updateInvoiceLine).not.toHaveBeenCalled()
  })

  it('[conflict] reloads a line changed elsewhere and keeps the change typed here', async () => {
    const backend = server(invoice())
    await open(backend.api)
    const assign = stubNavigation()

    type(field<HTMLTextAreaElement>(0, 'description'), 'Preserve my line correction')
    // Somebody else changes the same line's quantity in the meantime.
    backend.elsewhere({
      line_items: [
        line({ quantity: 3, amount_cents: 4_500, updated_at: later }),
        backend.current().line_items[1]!,
      ],
    })
    save()
    await vi.waitFor(() => expect(result().textContent).toContain('Latest values are loaded'))
    expect(field<HTMLTextAreaElement>(0, 'description').value).toBe('Preserve my line correction')
    expect(field(0, 'quantity').value).toBe('3')

    save()
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/invoices/INV-7'))
    const calls = backend.api.updateInvoice.mock.calls.length
    expect(calls).toBe(0)
    const [first, second] = backend.api.updateInvoiceLine.mock.calls
    expect(second?.[3]).toMatchObject({
      expected_version: 2,
      expected_updated_at: later,
      description: 'Preserve my line correction',
      quantity: 3,
    })
    expect(second?.[2]).not.toBe(first?.[2])
  })

  it('[browser] marks a saved line for removal and can keep it; a new line simply goes', async () => {
    const { api } = server(invoice())
    await open(api)

    const [saved] = rows()
    saved!.querySelector<HTMLButtonElement>('[data-invoice-edit-line-remove]')!.click()
    expect(saved!.hasAttribute('data-removed')).toBe(true)
    expect(saved!.querySelector<HTMLElement>('[data-invoice-edit-line-removed]')!.hidden).toBe(false)
    expect(field(0, 'quantity').disabled).toBe(true)
    const keep = saved!.querySelector<HTMLButtonElement>('[data-invoice-edit-line-restore]')!
    expect(keep.disabled).toBe(false)
    expect(document.activeElement).toBe(keep)
    expect(control('[data-invoice-edit-subtotal]').textContent).toBe('$10.00')
    keep.click()
    expect(saved!.hasAttribute('data-removed')).toBe(false)
    expect(field(0, 'quantity').disabled).toBe(false)
    expect(control('[data-invoice-edit-subtotal]').textContent).toBe('$40.00')

    control<HTMLButtonElement>('[data-invoice-edit-add-line]').click()
    expect(rows()).toHaveLength(3)
    expect(document.activeElement).toBe(field(2, 'kind'))
    rows()[2]!.querySelector<HTMLButtonElement>('[data-invoice-edit-line-remove]')!.click()
    expect(rows()).toHaveLength(2)
  })

  it('[browser] opens on the line it was sent to, or on a fresh one', async () => {
    const { api } = server(invoice())
    await open(api, { hash: '#line-22' })
    expect(document.activeElement).toBe(field(1, 'description'))

    await open(api, { hash: '#new-line' })
    expect(rows()).toHaveLength(3)
    expect(field(2, 'kind').value).toBe('Service')
    expect(field(2, 'quantity').value).toBe('1')
    expect(document.activeElement).toBe(field(2, 'description'))
  })

  it('[browser] opened by id, lands on the number with its hash, and leads back there', async () => {
    const { api } = server(invoice())
    const entries = globalThis.history.length
    await open(api, { path: '/invoices/by-id/7/edit', hash: '#line-22' })

    expect(api.findInvoiceByNumber).not.toHaveBeenCalled()
    expect(api.getInvoice).toHaveBeenCalledWith(7, expect.any(AbortSignal))
    // Replaced rather than pushed: going back leaves the page, it does not
    // revisit the id.
    expect(globalThis.location.pathname).toBe('/invoices/INV-7/edit')
    expect(globalThis.location.hash).toBe('#line-22')
    expect(globalThis.history.length).toBe(entries)
    expect(document.activeElement).toBe(field(1, 'description'))
    expect(control<HTMLAnchorElement>('[data-invoice-edit-back]').getAttribute('href')).toBe(
      '/invoices/INV-7',
    )
    expect(control<HTMLAnchorElement>('[data-invoice-edit-cancel]').getAttribute('href')).toBe(
      '/invoices/INV-7',
    )

    // A number that cannot be a path segment keeps the id it was opened by.
    const spaced = server(invoice({ number: 'INV 7' }))
    await open(spaced.api, { path: '/invoices/by-id/7/edit' })
    expect(control<HTMLFormElement>('[data-invoice-edit-form]').hidden).toBe(false)
    expect(globalThis.location.pathname).toBe('/invoices/by-id/7/edit')
    expect(control<HTMLAnchorElement>('[data-invoice-edit-back]').getAttribute('href')).toBe(
      '/invoices/by-id/7',
    )
  })

  it('[browser] says so when no invoice has the number, and reads nothing else', async () => {
    const { api } = server(invoice())
    await open(api, { path: '/invoices/INV-8/edit' })

    expect(api.findInvoiceByNumber).toHaveBeenCalledWith('INV-8', expect.any(AbortSignal))
    expect(api.getInvoice).not.toHaveBeenCalled()
    expect(control('[data-invoice-edit-status]').textContent).toBe('That invoice does not exist.')
    expect(control<HTMLFormElement>('[data-invoice-edit-form]').hidden).toBe(true)
    expect(control<HTMLAnchorElement>('[data-invoice-edit-back]').getAttribute('href')).toBe(
      '/invoices/INV-8',
    )
  })

  it('[money] previews each line in exact cents, and holds the total while a line does not parse', async () => {
    const { api } = server(invoice())
    await open(api)
    type(field(0, 'quantity'), '0.1')
    type(field(0, 'rate'), '1.05')
    expect(rows()[0]!.querySelector('[data-invoice-edit-line-amount]')?.textContent).toBe('$0.11')
    expect(control('[data-invoice-edit-subtotal]').textContent).toBe('$10.11')
    type(field(0, 'rate'), '1.055')
    expect(rows()[0]!.querySelector('[data-invoice-edit-line-amount]')?.textContent).toBe('—')
    expect(control('[data-invoice-edit-subtotal]').textContent).toBe('—')
  })

  it('[security] offers no form for a closed invoice, a read-only token, or a build without the routes', async () => {
    const closed = server(invoice({ state: 'closed', close_reason: 'cancelled' }))
    await open(closed.api)
    expect(control<HTMLFormElement>('[data-invoice-edit-form]').hidden).toBe(true)
    expect(control('[data-invoice-edit-status]').textContent).toBe(
      'A closed invoice can no longer be edited. Reopen it from the invoice page to change it.',
    )

    const reader = server(invoice())
    await open(reader.api, {
      who: identity({ kind: 'token', token_id: 3, scopes: ['invoices:read'] }),
    })
    expect(control<HTMLFormElement>('[data-invoice-edit-form]').hidden).toBe(true)
    expect(control('[data-invoice-edit-status]').textContent).toBe(
      'You have read-only invoice access. Editing an invoice requires the invoices:write scope.',
    )
    expect(reader.api.getInvoice).not.toHaveBeenCalled()
    expect(reader.api.findInvoiceByNumber).not.toHaveBeenCalled()

    const partial: Partial<InvoiceEditorApi> = { ...server(invoice()).api }
    delete partial.deleteInvoiceLine
    await open(partial)
    expect(control('[data-invoice-edit-status]').textContent).toBe(
      'Invoice editing is unavailable in this build.',
    )
  })

  it('[browser] offers a retry when the invoice cannot be read', async () => {
    const backend = server(invoice())
    backend.api.getInvoice.mockRejectedValueOnce(
      new EzactoApiError(503, { error: { code: 'unavailable', message: 'Try again shortly.' } }, null),
    )
    await open(backend.api)
    expect(control('[data-invoice-edit-status]').textContent).toBe('Try again shortly.')
    const retry = control<HTMLButtonElement>('[data-invoice-edit-retry]')
    expect(retry.hidden).toBe(false)
    retry.click()
    await vi.waitFor(() =>
      expect(control<HTMLFormElement>('[data-invoice-edit-form]').hidden).toBe(false),
    )
  })

  it('[security] takes the form down with the session', async () => {
    const session = new AbortController()
    const { api } = server(invoice())
    await open(api, { signal: session.signal })
    expect(rows()).toHaveLength(2)
    session.abort()
    expect(control<HTMLFormElement>('[data-invoice-edit-form]').hidden).toBe(true)
    expect(rows()).toHaveLength(0)
    expect(control('[data-invoice-edit-client]').textContent).toBe('—')
    expect(control('[data-invoice-edit-status]').textContent).toBe('Sign in to edit this invoice.')
    expect(document.title).toBe('eZacto — Edit invoice')
  })

  it('[e2e:phone-editor] keeps the line meta row to the project and the two taxes', () => {
    // The invoice's second row under a line carries three controls where the
    // recurring definition's carries five, so it has a column template of its
    // own, and on a phone both fold to two columns.
    expect(webAssets.stylesheet).toMatch(
      /\.invoice-line-meta \{\n {2}grid-template-columns: minmax\(0, 30rem\) auto auto;/u,
    )
    expect(webAssets.stylesheet).toMatch(
      /\.line-editor-meta,\n {2}\.invoice-line-meta \{\n {4}grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/u,
    )
  })
})
