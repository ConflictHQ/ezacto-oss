/** @vitest-environment happy-dom */

import type { GeneralResource, RecurringInvoice, Whoami } from '@ezacto/client'
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
  ...overrides,
})

const activate = async (
  api: Partial<RecurringWorkspaceApi>,
  signal = new AbortController().signal,
): Promise<void> => {
  await createRecurringWorkspaceController(api, today).activate(identity(), signal, () => false)
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
