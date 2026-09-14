/** @vitest-environment happy-dom */

import { EzactoApiError, type GeneralResource, type RecurringInvoice, type Whoami } from '@conflict-hq/ezacto-client'
import { describe, expect, it, vi } from 'vitest'
import { createRecurringWorkspaceController } from '../src/recurring/browser.js'
import type { RecurringWorkspaceApi } from '../src/recurring/model.js'
import { invoiceTabs, renderAppShell } from '../src/index.js'

const timestamp = '2026-09-09T12:00:00.000Z'
const today = () => '2026-10-01T09:00:00.000Z'

const managed: RecurringInvoice = {
  id: 1,
  client_id: 4,
  subject_template: 'Managed services',
  notes_template: 'Thank you.',
  every_n_months: 1,
  day_of_month: 1,
  next_issue_on: '2026-10-01',
  amount_config: {
    schema_version: 1,
    type: 'fixed_lines',
    line_items: [
      {
        kind: 'Service',
        description: 'Retainer',
        quantity: 1,
        unit_price_cents: 1_620_000,
        taxed: false,
        taxed2: false,
        project_id: null,
      },
      {
        kind: 'Service',
        description: 'Support',
        quantity: 2,
        unit_price_cents: 450_000,
        taxed: false,
        taxed2: false,
        project_id: 7,
      },
    ],
  },
  can_draw_from_retainer_id: null,
  claims_project_ids: null,
  claim_mode: 'all',
  claim_ceiling_seconds: null,
  claim_ceiling_cents: null,
  claim_scope: 'billable',
  created_at: timestamp,
  updated_at: timestamp,
}

const sweep: RecurringInvoice = {
  ...managed,
  id: 2,
  client_id: 5,
  subject_template: 'Time and materials',
  next_issue_on: '2026-09-01',
  amount_config: {
    schema_version: 1,
    type: 'line_items_import',
    project_ids: [7],
    time: { summary_type: 'project' },
  },
  can_draw_from_retainer_id: 3,
}

/**
 * A definition whose second line stops on a date and counts itself off. It is
 * the shape the live Halcyon Biolabs definition has, and the one an edit must
 * carry back out untouched: `PATCH` replaces the whole definition, so a lost
 * `through` is a line that bills forever.
 */
const credited: RecurringInvoice = {
  ...managed,
  id: 3,
  subject_template: 'Platform and credit',
  amount_config: {
    schema_version: 1,
    type: 'fixed_lines',
    line_items: [
      {
        kind: 'Service',
        description: 'Platform',
        quantity: 1,
        unit_price_cents: 900_000,
        taxed: false,
        taxed2: false,
        project_id: null,
      },
      {
        kind: 'Credit',
        description: 'CREDIT %line_installment_number% of %line_installment_total%',
        quantity: 1,
        unit_price_cents: -45_000,
        taxed: false,
        taxed2: false,
        project_id: 7,
        through: '2026-12-01',
        installments: 4,
      },
    ],
  },
}

const resource = (id: number, fields: Record<string, unknown>): GeneralResource => ({
  id,
  created_at: timestamp,
  updated_at: timestamp,
  ...fields,
})

const identity = (profile: Whoami['profile'] = 'administrator'): Whoami => ({
  user_id: 1,
  profile,
  manager_grants: [],
  authentication: { kind: 'session' },
})

const page = <Resource>(data: readonly Resource[], nextCursor: string | null = null) => ({
  data,
  page: { next_cursor: nextCursor },
})

const writeDocument = (path = '/invoices/recurring'): void => {
  window.history.replaceState(null, '', path)
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'recurring-browser-test',
      activeSection: 'Invoices',
      view: 'invoice-recurring',
      tabs: invoiceTabs('invoice-recurring'),
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
  overrides: Partial<RecurringWorkspaceApi> = {},
): Partial<RecurringWorkspaceApi> => ({
  listRecurringInvoices: vi.fn(async () => page([managed, sweep])),
  getRecurringInvoice: vi.fn(async (id: number) =>
    [managed, sweep].find((candidate) => candidate.id === id)!,
  ),
  generateRecurringInvoice: vi.fn(async () => ({
    invoice: { id: 91 },
    generation: { period: '2026-09', next_issue_on: '2026-11-01' },
  })),
  listRecurringClients: vi.fn(async () =>
    page([
      resource(4, { name: 'Northpeak', currency: 'EUR' }),
      resource(5, { name: 'Alva Works', currency: 'USD' }),
    ]),
  ),
  listRecurringProjects: vi.fn(async () => page([resource(7, { name: 'Ingest rebuild' })])),
  createRecurringInvoice: vi.fn(async () => ({ ...managed, id: 9 })),
  updateRecurringInvoice: vi.fn(async (id: number) => ({ ...managed, id })),
  deleteRecurringInvoice: vi.fn(async () => undefined),
  ...overrides,
})

const activate = async (
  api: Partial<RecurringWorkspaceApi>,
  signal = new AbortController().signal,
  who = identity(),
): Promise<void> => {
  await createRecurringWorkspaceController(api, today).activate(who, signal, () => false)
}

const control = <Element extends HTMLElement>(selector: string): Element => {
  const item = document.querySelector<Element>(selector)
  if (item === null) throw new Error(`missing test selector: ${selector}`)
  return item
}

const lineFields = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(
    '[data-recurring-editor-line-list] [data-recurring-line]',
  ),
]

const lineInput = (position: number, field: string): HTMLInputElement | HTMLSelectElement => {
  const line = lineFields()[position]
  if (line === undefined) throw new Error(`no editor line at position ${position}`)
  const control_ = line.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[data-recurring-line-field="${field}"]`,
  )
  if (control_ === null) throw new Error(`no ${field} on line ${position}`)
  return control_
}

const submitEditor = (): void => {
  control<HTMLFormElement>('[data-recurring-editor-form]').dispatchEvent(
    new Event('submit', { cancelable: true }),
  )
}

const listText = (): string =>
  document.querySelector('[data-recurring-list]')?.textContent ?? ''

const openDefinition = async (
  api: Partial<RecurringWorkspaceApi>,
  id: number,
): Promise<void> => {
  document
    .querySelector<HTMLButtonElement>(`[data-recurring-list] tr[data-row-key="${id}"] button`)!
    .click()
  await vi.waitFor(() =>
    expect(api.getRecurringInvoice).toHaveBeenCalledWith(id, expect.any(AbortSignal)),
  )
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLElement>('[data-recurring-detail-body]')?.hidden).toBe(
      false,
    ),
  )
}

describe('Recurring workspace controller', () => {
  it('[browser] lists what bills when, soonest first, grouped by client', async () => {
    writeDocument()
    await activate(baseApi())

    expect(listText()).toContain('Northpeak')
    expect(listText()).toContain('Alva Works')
    expect(listText()).toContain('Every month on the 1st')
    // Soonest obligation first: the September sweep is past due on 1 October.
    const rows = [...document.querySelectorAll('[data-recurring-list] tbody tr[data-row]')]
    expect(rows.map((row) => row.getAttribute('data-row-key'))).toEqual(['2', '1'])
    expect(listText()).toContain('Past due')
    expect(listText()).toContain('Due today')
    // The fixed definition has a total; the sweep cannot have one yet.
    expect(listText()).toContain('€25,200.00')
    expect(listText()).toContain('Set when it runs')
  })

  it('[browser] opens a definition and shows the lines that make the total', async () => {
    writeDocument()
    const api = baseApi()
    await activate(api)
    await openDefinition(api, 1)

    expect(window.location.search).toBe('?definition=1')
    expect(document.querySelector<HTMLElement>('[data-recurring-list-view]')?.hidden).toBe(true)
    expect(document.querySelector('[data-recurring-cadence]')?.textContent).toBe(
      'Every month on the 1st',
    )
    expect(document.querySelector('[data-recurring-amount]')?.textContent).toBe('€25,200.00')
    const config = document.querySelector('[data-recurring-config]')?.textContent ?? ''
    expect(config).toContain('Retainer')
    // The project name, not the id, and the line total the quantity implies.
    expect(config).toContain('Ingest rebuild')
    expect(config).toContain('€9,000.00')
    // A definition with no retainer link does not show an empty row for one.
    expect(
      document.querySelector<HTMLElement>('[data-recurring-retainer-row]')?.hidden,
    ).toBe(true)
  })

  it('[browser] says a sweep bills whatever is uninvoiced, and names the projects', async () => {
    writeDocument()
    const api = baseApi()
    await activate(api)
    await openDefinition(api, 2)

    expect(document.querySelector('[data-recurring-basis]')?.textContent).toBe(
      'Uninvoiced time by project on 1 project',
    )
    expect(document.querySelector('[data-recurring-config]')?.textContent).toContain(
      'Ingest rebuild',
    )
    expect(document.querySelector<HTMLElement>('[data-recurring-retainer-row]')?.hidden).toBe(
      false,
    )
  })

  it('[browser] will not issue an invoice on one click', async () => {
    // A recurring invoice becomes a document addressed to a client. A button
    // that raises one without asking is a button somebody presses by accident.
    writeDocument()
    const api = baseApi()
    await activate(api)
    await openDefinition(api, 1)

    document.querySelector<HTMLButtonElement>('[data-recurring-issue]')!.click()
    expect(api.generateRecurringInvoice).not.toHaveBeenCalled()
    expect(document.querySelector('[data-recurring-confirm-body]')?.textContent).toContain(
      'Northpeak',
    )
  })

  it('[browser] issues once confirmed and says where the cadence landed', async () => {
    writeDocument()
    const api = baseApi()
    await activate(api)
    await openDefinition(api, 1)

    document.querySelector<HTMLButtonElement>('[data-recurring-issue]')!.click()
    document.querySelector<HTMLFormElement>('[data-recurring-confirm-form]')!.dispatchEvent(
      new Event('submit', { cancelable: true }),
    )
    await vi.waitFor(() => expect(api.generateRecurringInvoice).toHaveBeenCalled())
    await vi.waitFor(() =>
      expect(document.querySelector('[data-recurring-issue-result]')?.textContent).toContain(
        'Next on 2026-11-01',
      ),
    )

    const link = document.querySelector<HTMLAnchorElement>('[data-recurring-issued-link]')!
    expect(link.hidden).toBe(false)
    expect(link.getAttribute('href')).toBe('/invoices/91')
  })

  it('[security] retries an issue under the key it already used', async () => {
    // The server treats the idempotency key as the command's identity. A fresh
    // key on retry is a fresh command, which is how a network failure nobody
    // saw becomes two invoices to the same client.
    writeDocument()
    const keys: string[] = []
    let attempt = 0
    const api = baseApi({
      generateRecurringInvoice: vi.fn(async (_id: number, key: string) => {
        keys.push(key)
        attempt += 1
        if (attempt === 1) throw Object.assign(new Error('network'), { status: 500 })
        return {
          invoice: { id: 91 },
          generation: { period: '2026-09', next_issue_on: '2026-11-01' },
        }
      }),
    })
    await activate(api)
    await openDefinition(api, 1)

    const confirmAndIssue = async (): Promise<void> => {
      document.querySelector<HTMLButtonElement>('[data-recurring-issue]')!.click()
      document.querySelector<HTMLFormElement>('[data-recurring-confirm-form]')!.dispatchEvent(
        new Event('submit', { cancelable: true }),
      )
    }
    await confirmAndIssue()
    await vi.waitFor(() => expect(keys).toHaveLength(1))
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLButtonElement>('[data-recurring-issue]')?.disabled,
      ).toBe(false),
    )
    await confirmAndIssue()
    await vi.waitFor(() => expect(keys).toHaveLength(2))

    expect(keys[0]).toBe(keys[1])
  })

  it('[browser] reads "not due yet" as the definition working, not failing', async () => {
    writeDocument()
    const api = baseApi({
      generateRecurringInvoice: vi.fn(async () => {
        throw Object.assign(new Error('not due'), {
          status: 409,
          body: {
            error: { code: 'not_due', message: 'definition 1 is not due until 2026-11-01' },
          },
        })
      }),
    })
    await activate(api)
    await openDefinition(api, 1)

    document.querySelector<HTMLButtonElement>('[data-recurring-issue]')!.click()
    document.querySelector<HTMLFormElement>('[data-recurring-confirm-form]')!.dispatchEvent(
      new Event('submit', { cancelable: true }),
    )
    await vi.waitFor(() =>
      // The date is the actionable part, so the server's own message survives.
      expect(document.querySelector('[data-recurring-issue-result]')?.textContent).toBe(
        'definition 1 is not due until 2026-11-01',
      ),
    )
    // Marked as the definition working, not as a failure — the tone is on the
    // element, so a person scanning the page does not have to read the sentence
    // to know nothing went wrong.
    expect(
      document.querySelector<HTMLElement>('[data-recurring-issue-result]')?.dataset.outcome,
    ).toBe('not_due')
    // No invoice, so nothing to open.
    expect(document.querySelector<HTMLElement>('[data-recurring-issued-link]')?.hidden).toBe(
      true,
    )
  })

  it('[browser] says a deployment with no engine changed nothing', async () => {
    writeDocument()
    const api = baseApi({
      generateRecurringInvoice: vi.fn(async () => {
        throw Object.assign(new Error('unavailable'), {
          status: 503,
          body: { error: { code: 'internal_error', message: 'unavailable' } },
        })
      }),
    })
    await activate(api)
    await openDefinition(api, 1)

    document.querySelector<HTMLButtonElement>('[data-recurring-issue]')!.click()
    document.querySelector<HTMLFormElement>('[data-recurring-confirm-form]')!.dispatchEvent(
      new Event('submit', { cancelable: true }),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-recurring-issue-result]')?.textContent).toContain(
        'Nothing has changed',
      ),
    )
    expect(
      document.querySelector<HTMLElement>('[data-recurring-issue-result]')?.dataset.outcome,
    ).toBe('unavailable')
  })

  it('[browser] offers no issue button where the build cannot issue', async () => {
    writeDocument()
    const api = baseApi()
    delete api.generateRecurringInvoice
    await activate(api)
    await openDefinition(api, 1)

    expect(document.querySelector<HTMLButtonElement>('[data-recurring-issue]')?.disabled).toBe(
      true,
    )
    expect(document.querySelector('[data-recurring-issue-hint]')?.textContent).toContain(
      'cannot issue',
    )
  })

  it('[browser] opens a deep link without a list load to lean on', async () => {
    // ?definition=2 arrives with no list behind it, so the client names have to
    // come from the shared catalog or the page paints "Client #5" and USD.
    writeDocument('/invoices/recurring?definition=2')
    const api = baseApi()
    await activate(api)

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-recurring-detail-body]')?.hidden).toBe(
        false,
      ),
    )
    expect(document.querySelector('[data-recurring-detail-client]')?.textContent).toBe(
      'Alva Works',
    )
  })

  it('[money] sends a band ceiling, and shows its boxes only once one applies', async () => {
    // #707. Without a control this is a column nobody can set, which is the
    // same defect #485 catalogued -- and a ceiling box visible while the band
    // claims everything invites a number that never applies.
    writeDocument()
    const api = baseApi()
    await activate(api)

    control<HTMLButtonElement>('[data-recurring-new]').click()
    const ceiling = control<HTMLElement>('[data-recurring-editor-ceiling]')
    expect(ceiling.hidden).toBe(true)

    control<HTMLSelectElement>('[data-recurring-editor-client]').value = '5'
    control<HTMLInputElement>('[data-recurring-editor-subject]').value = 'Banded team'
    control<HTMLInputElement>('[data-recurring-editor-next]').value = '2026-11-10'
    lineInput(0, 'kind').value = 'Service'
    lineInput(0, 'description').value = 'Band'
    lineInput(0, 'quantity').value = '1'
    lineInput(0, 'unitPriceCents').value = '9368500'
    const claims = control<HTMLSelectElement>('[data-recurring-editor-claims]')
    for (const option of claims.options) option.selected = option.value === '7'
    const mode = control<HTMLSelectElement>('[data-recurring-editor-claim-mode]')
    mode.value = 'ceiling'
    mode.dispatchEvent(new window.Event('change'))
    expect(ceiling.hidden).toBe(false)
    control<HTMLSelectElement>('[data-recurring-editor-claim-scope]').value = 'tracked'
    control<HTMLSelectElement>('[data-recurring-editor-ceiling-unit]').value = 'money'
    control<HTMLInputElement>('[data-recurring-editor-ceiling-amount]').value = '9368500'
    submitEditor()

    await vi.waitFor(() => expect(api.createRecurringInvoice).toHaveBeenCalled())
    expect(api.createRecurringInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        claims_project_ids: [7],
        claim_mode: 'ceiling',
        claim_ceiling_seconds: null,
        claim_ceiling_cents: 9_368_500,
        claim_scope: 'tracked',
      }),
      expect.any(String),
      expect.any(AbortSignal),
    )
  })

  it('[browser] creates a definition, carrying a through date and an installment total', async () => {
    // The gap this closes. `createRecurringInvoice` had no call site, so the
    // three live definitions were loaded by a script; nothing in the product
    // could write one, let alone one whose credit line counts itself off.
    writeDocument()
    const api = baseApi()
    await activate(api)

    const newButton = control<HTMLButtonElement>('[data-recurring-new]')
    expect(newButton.hidden).toBe(false)
    newButton.click()

    expect(lineFields()).toHaveLength(1)
    control<HTMLSelectElement>('[data-recurring-editor-client]').value = '5'
    control<HTMLInputElement>('[data-recurring-editor-subject]').value = 'Platform'
    control<HTMLTextAreaElement>('[data-recurring-editor-notes]').value = 'Thanks.'
    control<HTMLInputElement>('[data-recurring-editor-every]').value = '3'
    control<HTMLInputElement>('[data-recurring-editor-day]').value = '15'
    control<HTMLInputElement>('[data-recurring-editor-next]').value = '2026-11-15'
    lineInput(0, 'kind').value = 'Credit'
    lineInput(0, 'description').value = 'CREDIT %line_installment_number% of %line_installment_total%'
    lineInput(0, 'quantity').value = '1'
    lineInput(0, 'unitPriceCents').value = '-45000'
    lineInput(0, 'through').value = '2026-12-15'
    lineInput(0, 'installments').value = '4'
    lineInput(0, 'projectId').value = '7'
    submitEditor()

    await vi.waitFor(() => expect(api.createRecurringInvoice).toHaveBeenCalled())
    expect(api.createRecurringInvoice).toHaveBeenCalledWith(
      {
        client_id: 5,
        subject_template: 'Platform',
        notes_template: 'Thanks.',
        every_n_months: 3,
        day_of_month: 15,
        next_issue_on: '2026-11-15',
        amount_config: {
          schema_version: 1,
          type: 'fixed_lines',
          line_items: [
            {
              kind: 'Credit',
              description: 'CREDIT %line_installment_number% of %line_installment_total%',
              quantity: 1,
              unit_price_cents: -45_000,
              taxed: false,
              taxed2: false,
              project_id: 7,
              through: '2026-12-15',
              installments: 4,
            },
          ],
        },
        can_draw_from_retainer_id: null,
        claims_project_ids: null,
        claim_mode: 'all',
        claim_ceiling_seconds: null,
        claim_ceiling_cents: null,
        claim_scope: 'billable',
      },
      expect.any(String),
      expect.any(AbortSignal),
    )
    // The list is stale the moment a definition exists that was not on it.
    await vi.waitFor(() => expect(api.listRecurringInvoices).toHaveBeenCalledTimes(2))
  })

  it('[browser] edits a definition without rewriting the half it was not shown', async () => {
    // PATCH on this resource is a replace. A form seeded only from the fields on
    // screen sends back an amount config it invented, which is how a line's
    // through date disappears during a correction to the day of month.
    writeDocument()
    const api = baseApi({
      listRecurringInvoices: vi.fn(async () => page([credited])),
      getRecurringInvoice: vi.fn(async () => credited),
    })
    await activate(api)
    await openDefinition(api, 3)

    control<HTMLButtonElement>('[data-recurring-edit]').click()
    expect(lineFields()).toHaveLength(2)
    expect(control<HTMLInputElement>('[data-recurring-editor-subject]').value).toBe(
      'Platform and credit',
    )
    // The two keys the editor exists to reach are on the form, filled in.
    expect(lineInput(1, 'through').value).toBe('2026-12-01')
    expect(lineInput(1, 'installments').value).toBe('4')
    expect(lineInput(0, 'through').value).toBe('')
    expect(lineInput(0, 'installments').value).toBe('')

    control<HTMLInputElement>('[data-recurring-editor-day]').value = '15'
    submitEditor()

    await vi.waitFor(() => expect(api.updateRecurringInvoice).toHaveBeenCalled())
    expect(api.updateRecurringInvoice).toHaveBeenCalledWith(
      3,
      expect.objectContaining({
        day_of_month: 15,
        subject_template: 'Platform and credit',
        notes_template: 'Thank you.',
        amount_config: credited.amount_config,
      }),
      expect.any(AbortSignal),
    )
  })

  it('[browser] keeps a client and a project the catalog did not return', async () => {
    // A definition outlives the archiving of the client it bills, and the
    // catalog is one page-size from being incomplete on a large account. A
    // select that cannot show the id it is set to falls back to its first
    // option, and since `PATCH` is a replace, saving anything at all would then
    // move the definition to a client nobody chose.
    writeDocument()
    const stranded: RecurringInvoice = {
      ...credited,
      client_id: 99,
      amount_config: {
        schema_version: 1,
        type: 'fixed_lines',
        line_items: [
          {
            kind: 'Service',
            description: 'Platform',
            quantity: 1,
            unit_price_cents: 900_000,
            taxed: false,
            taxed2: false,
            project_id: 88,
          },
        ],
      },
    }
    const api = baseApi({
      listRecurringInvoices: vi.fn(async () => page([stranded])),
      getRecurringInvoice: vi.fn(async () => stranded),
    })
    await activate(api)
    await openDefinition(api, 3)

    control<HTMLButtonElement>('[data-recurring-edit]').click()
    const clientSelect = control<HTMLSelectElement>('[data-recurring-editor-client]')
    // Counted first: an empty select would satisfy every check below by having
    // nothing to disagree with.
    const clientOptions = [...clientSelect.options].map((item) => item.value)
    expect(clientOptions).toEqual(['', '4', '5', '99'])
    expect(clientSelect.value).toBe('99')
    expect([...clientSelect.options].at(-1)!.textContent).toBe('#99')
    const projectSelect = lineInput(0, 'projectId') as HTMLSelectElement
    expect([...projectSelect.options].map((item) => item.value)).toEqual(['', '7', '88'])
    expect(projectSelect.value).toBe('88')

    submitEditor()
    await vi.waitFor(() => expect(api.updateRecurringInvoice).toHaveBeenCalled())
    expect(api.updateRecurringInvoice).toHaveBeenCalledWith(
      3,
      expect.objectContaining({
        client_id: 99,
        amount_config: stranded.amount_config,
      }),
      expect.any(AbortSignal),
    )
  })

  it('[browser] refuses an installment total with nothing to count back from', async () => {
    // The 0044 trigger refuses the same config, and so does
    // `assertRecurringAmountConfig`, but neither can say which line. Caught here
    // the request is never sent and the sentence names the row.
    writeDocument()
    const api = baseApi()
    await activate(api)

    control<HTMLButtonElement>('[data-recurring-new]').click()
    control<HTMLSelectElement>('[data-recurring-editor-client]').value = '4'
    control<HTMLInputElement>('[data-recurring-editor-subject]').value = 'Platform'
    control<HTMLInputElement>('[data-recurring-editor-next]').value = '2026-11-15'
    lineInput(0, 'unitPriceCents').value = '100'
    lineInput(0, 'installments').value = '4'
    submitEditor()

    expect(control<HTMLElement>('[data-recurring-editor-result]').textContent).toBe(
      'Line 1 needs a through date before it can count installments.',
    )
    expect(api.createRecurringInvoice).not.toHaveBeenCalled()
    // The dialog stays up with the offending value still in it. Closing it would
    // throw away everything else the person had typed.
    expect(control<HTMLDialogElement>('[data-recurring-editor]').open).toBe(true)
    expect(lineInput(0, 'installments').value).toBe('4')
  })

  it('[browser] shows the server refusal without closing the editor', async () => {
    writeDocument()
    const api = baseApi({
      listRecurringInvoices: vi.fn(async () => page([credited])),
      getRecurringInvoice: vi.fn(async () => credited),
      updateRecurringInvoice: vi.fn(async () => {
        // The real class, because `messageFor` reads the body only off an
        // `EzactoApiError` -- a hand-rolled lookalike would have proved the
        // fallback path instead of the one the shell actually takes.
        throw new EzactoApiError(
          422,
          {
            error: {
              code: 'validation_failed',
              message: 'amount_config must be a versioned object',
            },
          },
          null,
        )
      }),
    })
    await activate(api)
    await openDefinition(api, 3)

    control<HTMLButtonElement>('[data-recurring-edit]').click()
    submitEditor()

    await vi.waitFor(() =>
      expect(control<HTMLElement>('[data-recurring-editor-result]').textContent).toBe(
        'amount_config must be a versioned object',
      ),
    )
    expect(control<HTMLElement>('[data-recurring-editor-result]').dataset.outcome).toBe('error')
    expect(control<HTMLDialogElement>('[data-recurring-editor]').open).toBe(true)
  })

  it('[browser] will not delete a definition on one click, then returns to the list', async () => {
    writeDocument()
    const api = baseApi()
    await activate(api)
    await openDefinition(api, 1)

    control<HTMLButtonElement>('[data-recurring-delete]').click()
    expect(api.deleteRecurringInvoice).not.toHaveBeenCalled()
    expect(control<HTMLElement>('[data-recurring-delete-body]').textContent).toContain(
      'Northpeak',
    )

    control<HTMLFormElement>('[data-recurring-delete-form]').dispatchEvent(
      new Event('submit', { cancelable: true }),
    )
    await vi.waitFor(() =>
      expect(api.deleteRecurringInvoice).toHaveBeenCalledWith(1, expect.any(AbortSignal)),
    )
    // The URL named a definition that no longer exists, so the screen goes back
    // to the list rather than reloading a detail that would answer 404.
    await vi.waitFor(() => expect(window.location.search).toBe(''))
    expect(control<HTMLElement>('[data-recurring-detail-view]').hidden).toBe(true)
  })

  it('[browser] says why a definition that has billed cannot be deleted', async () => {
    // `invoices.recurring_invoice_id` is ON DELETE RESTRICT, and a definition
    // imported through the Harvest worksheet carries a second guard besides, so
    // every definition on a live account refuses deletion. The API reports that
    // as an opaque `resource_conflict`, and the dialog used to promise the
    // opposite outright -- "Invoices it has already raised are untouched".
    writeDocument()
    const api = baseApi()
    api.deleteRecurringInvoice = vi.fn(async () => {
      // The real class, and its real signature: (status, body, requestId).
      throw new EzactoApiError(
        409,
        {
          error: {
            code: 'resource_conflict',
            message: 'The financial command conflicts with current state.',
          },
        },
        null,
      )
    })
    await activate(api)
    await openDefinition(api, 1)

    control<HTMLButtonElement>('[data-recurring-delete]').click()
    const body = control<HTMLElement>('[data-recurring-delete-body]').textContent ?? ''
    expect(body).toContain('cannot be deleted')
    expect(body).not.toContain('are untouched')

    control<HTMLFormElement>('[data-recurring-delete-form]').dispatchEvent(
      new Event('submit', { cancelable: true }),
    )
    await vi.waitFor(() =>
      expect(control<HTMLElement>('[data-recurring-delete-result]').textContent).toContain(
        'already raised an invoice',
      ),
    )
    // Not the generic sentence about financial commands, which names nothing the
    // reader can act on.
    expect(control<HTMLElement>('[data-recurring-delete-result]').textContent).not.toContain(
      'financial command',
    )
  })

  it('[browser] names the client constraint only where it applies', async () => {
    writeDocument()
    const api = baseApi()
    await activate(api)

    // Creating: the client is free, so the constraint is not mentioned.
    control<HTMLButtonElement>('[data-recurring-new]').click()
    expect(control<HTMLElement>('[data-recurring-client-hint]').hidden).toBe(true)
    control<HTMLButtonElement>('[data-recurring-editor-cancel]').click()

    // Editing: the database refuses a client change once an invoice links back,
    // and reports it as the same opaque conflict as everything else.
    await openDefinition(api, 1)
    control<HTMLButtonElement>('[data-recurring-edit]').click()
    expect(control<HTMLElement>('[data-recurring-client-hint]').hidden).toBe(false)
  })

  it('[security] offers no write controls to a profile that cannot write invoices', async () => {
    // The API refuses a member at `invoices:write`; the screen should not put
    // the button in front of one first.
    writeDocument()
    const api = baseApi()
    await activate(api, new AbortController().signal, identity('member'))

    expect(control<HTMLButtonElement>('[data-recurring-new]').hidden).toBe(true)
    await openDefinition(api, 1)
    expect(control<HTMLButtonElement>('[data-recurring-edit]').hidden).toBe(true)
    expect(control<HTMLButtonElement>('[data-recurring-delete]').hidden).toBe(true)
    // Counted before it is judged. `every` over an empty list is true, so a
    // selector that matched nothing -- a renamed attribute, a control added to
    // the markup and never marked -- would pass this as a clean bill of health.
    const writeControls = [...document.querySelectorAll<HTMLElement>('[data-recurring-write]')]
    expect(writeControls).toHaveLength(3)
    expect(writeControls.filter((button) => button.hidden)).toHaveLength(3)
  })

  it('[browser] retries a failed create under the key it already sent', async () => {
    // The create is the only write here not addressed to an id, so the
    // idempotency key is the only thing telling the server that a second
    // attempt is the same command. A fresh key on retry is a second definition
    // -- and a network failure the browser saw is not proof the server did not
    // take the first one.
    writeDocument()
    const createRecurringInvoice = vi
      .fn<RecurringWorkspaceApi['createRecurringInvoice']>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ...managed, id: 9 })
    const api = baseApi({ createRecurringInvoice })
    await activate(api)

    control<HTMLButtonElement>('[data-recurring-new]').click()
    control<HTMLSelectElement>('[data-recurring-editor-client]').value = '4'
    control<HTMLInputElement>('[data-recurring-editor-subject]').value = 'Platform'
    control<HTMLInputElement>('[data-recurring-editor-next]').value = '2026-11-15'
    lineInput(0, 'unitPriceCents').value = '100'
    submitEditor()

    await vi.waitFor(() =>
      expect(control<HTMLElement>('[data-recurring-editor-result]').dataset.outcome).toBe(
        'error',
      ),
    )
    expect(control<HTMLDialogElement>('[data-recurring-editor]').open).toBe(true)

    submitEditor()
    await vi.waitFor(() => expect(createRecurringInvoice).toHaveBeenCalledTimes(2))
    const [firstKey, secondKey] = createRecurringInvoice.mock.calls.map((call) => call[1])
    expect(typeof firstKey).toBe('string')
    expect(secondKey).toBe(firstKey)
    // And the key is spent once it lands: the next definition is a new command.
    await vi.waitFor(() =>
      expect(control<HTMLDialogElement>('[data-recurring-editor]').open).toBe(false),
    )
    control<HTMLButtonElement>('[data-recurring-new]').click()
    control<HTMLSelectElement>('[data-recurring-editor-client]').value = '4'
    control<HTMLInputElement>('[data-recurring-editor-subject]').value = 'Platform again'
    control<HTMLInputElement>('[data-recurring-editor-next]').value = '2026-11-15'
    lineInput(0, 'unitPriceCents').value = '100'
    submitEditor()
    await vi.waitFor(() => expect(createRecurringInvoice).toHaveBeenCalledTimes(3))
    expect(createRecurringInvoice.mock.calls[2]![1]).not.toBe(firstKey)
  })

  it('[browser] hides the write controls where the build has no write path', async () => {
    writeDocument()
    const api = baseApi()
    delete api.createRecurringInvoice
    delete api.updateRecurringInvoice
    delete api.deleteRecurringInvoice
    await activate(api)

    expect(control<HTMLButtonElement>('[data-recurring-new]').hidden).toBe(true)
    await openDefinition(api, 1)
    expect(control<HTMLButtonElement>('[data-recurring-edit]').hidden).toBe(true)
    expect(control<HTMLButtonElement>('[data-recurring-delete]').hidden).toBe(true)
  })

  it('[browser] leaves nothing on the page once the session ends', async () => {
    writeDocument()
    const controller = new AbortController()
    await activate(baseApi(), controller.signal)
    expect(listText()).toContain('Northpeak')

    controller.abort()

    expect(listText()).toBe('')
    expect(document.querySelector('[data-recurring-list-status]')?.textContent).toBe(
      'Sign in to view recurring invoices.',
    )
  })
})
