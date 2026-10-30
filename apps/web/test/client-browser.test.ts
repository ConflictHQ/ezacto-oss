/** @vitest-environment happy-dom */

import {
  EzactoApiError,
  type ClientRollupReport,
  type GeneralResource,
  type Invoice,
  type Retainer,
  type Whoami,
} from '@conflict-hq/ezacto-client'
import { setSortPreferenceOwner } from '../src/components/table-sort.js'
import { describe, expect, it, vi } from 'vitest'
import { createClientDirectoryController } from '../src/clients/browser.js'
import type { ClientDirectoryApi, ClientInvoiceSending } from '../src/clients/model.js'
import {
  contrastRatio,
  defaultTheme,
  renderAppShell,
  themeManifest,
  webAssets,
} from '../src/index.js'

const timestamp = '2026-09-01T12:00:00.000Z'
const parent: GeneralResource = {
  id: 10,
  name: 'Parent Holding',
  currency: 'USD',
  is_active: true,
  parent_client_id: null,
  bill_to_client_id: null,
  payment_terms: 'net_30',
  default_tax_pct: 7.25,
  default_tax2_pct: null,
  default_discount_pct: 5,
  address: '1 Parent Way',
  created_at: timestamp,
  updated_at: timestamp,
}
const child: GeneralResource = {
  ...parent,
  id: 11,
  name: 'Worked-For Studio',
  parent_client_id: 10,
  bill_to_client_id: 10,
  address: '2 Child Way',
}
const contact: GeneralResource = {
  id: 21,
  client_id: 11,
  title: 'Dr.',
  first_name: 'Alex',
  last_name: 'Rivera',
  email: 'alex@example.test',
  phone_office: null,
  phone_mobile: '+1 555 0100',
  fax: null,
  invoice_recipient_status: 'cc',
  created_at: timestamp,
  updated_at: timestamp,
}
const project: GeneralResource = {
  id: 31,
  client_id: 11,
  name: 'Launch',
  code: 'WEB',
  is_active: true,
  billing_method: 'time_materials',
  created_at: timestamp,
  updated_at: timestamp,
}

const writeDocument = (
  view: 'client-list' | 'client-detail' = 'client-detail',
  pathname = '/clients/11',
): void => {
  window.history.replaceState(null, '', pathname)
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'client-browser-test',
      activeSection: 'Clients',
      view,
    })
      .replace(/ {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu, '')
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const page = (data: readonly GeneralResource[]) => ({
  data,
  page: { next_cursor: null },
})

const pageOf = <Resource>(data: readonly Resource[]) => ({
  data,
  page: { next_cursor: null as string | null },
})

const openInvoice = (
  id: number,
  clientId: number,
  currency: string,
  dueCents: number,
  dueDate: string,
): Invoice =>
  ({
    id,
    client_id: clientId,
    currency,
    state: 'open',
    due_amount_cents: dueCents,
    due_date: dueDate,
  }) as unknown as Invoice

const heldRetainer = (
  id: number,
  clientId: number | null,
  denomination: Retainer['denomination'],
  balance: number,
): Retainer =>
  ({
    id,
    client_id: clientId,
    project_id: null,
    denomination,
    balance,
    state: 'ongoing',
  }) as unknown as Retainer

const rollupReport = (): ClientRollupReport =>
  ({
    root_client_id: 10,
    from: '2026-09-01',
    to: '2026-09-09',
    nodes: [
      {
        client_id: 10,
        name: 'Parent Holding',
        parent_client_id: null,
        depth: 0,
        direct: { currencies: [] },
        rollup: {
          currencies: [
            { currency: 'USD', expense_cents: 20_000, cost_cents: 100_000 },
            { currency: 'EUR', expense_cents: 5_000, cost_cents: 0 },
          ],
        },
      },
    ],
  }) as unknown as ClientRollupReport

const rollupApi = () => ({
  // The child bills in euros: a retainer carries no currency of its own and
  // borrows its client's, so this is the subtree that spans two of them.
  listDirectoryClients: vi.fn(async () => page([{ ...child, currency: 'EUR' }, parent])),
  getDirectoryClient: vi.fn(async () => parent),
  listClientContacts: vi.fn(async () => page([])),
  listClientProjects: vi.fn(async () => page([])),
  listClientSubtree: vi.fn(async () => [
    { ancestor_id: 10, descendant_id: 10, depth: 0 },
    { ancestor_id: 10, descendant_id: 11, depth: 1 },
  ]),
  listClientOpenInvoices: vi.fn(async () =>
    pageOf([
      openInvoice(1, 10, 'USD', 30_000, '2020-01-31'),
      openInvoice(2, 11, 'USD', 10_000, '2099-01-31'),
      openInvoice(3, 11, 'EUR', 90_000, '2099-01-31'),
    ]),
  ),
  listClientRetainers: vi.fn(async () =>
    pageOf([
      heldRetainer(1, 10, 'money', 250_000),
      heldRetainer(2, 11, 'money', 400_000),
      heldRetainer(3, 10, 'hours', 36_000),
      heldRetainer(4, null, 'money', 999_999),
    ]),
  ),
  getClientRollupReport: vi.fn(async () => rollupReport()),
})

const administrator: Whoami = {
  user_id: 1,
  profile: 'administrator',
  manager_grants: [],
  authentication: { kind: 'session' },
}

describe('Clients V1 browser controller', () => {
  it('[security #466] keeps ungranted manager edits operational without resetting invoice defaults', async () => {
    writeDocument()
    const updateDirectoryClient = vi.fn(async (_id, input) => ({ ...child, ...input }))
    const createClientContact = vi.fn(async (input) => ({ ...contact, ...input }))
    const controller = createClientDirectoryController({
      listDirectoryClients: async () => page([parent, child]),
      getDirectoryClient: async () => child,
      listClientContacts: async () => page([contact]),
      listClientProjects: async () => page([project]),
      updateDirectoryClient, createClientContact,
      createDirectoryClient: vi.fn(), updateClientContact: vi.fn(),
    })
    const identity: Whoami = { user_id: 1, profile: 'project_manager', manager_grants: [], authentication: { kind: 'session' } }
    await controller.activate(identity, new AbortController().signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-client-edit]')!.click()
    const form = document.querySelector<HTMLFormElement>('[data-client-form]')!
    const fields = ['payment_terms', 'default_tax_pct', 'default_tax2_pct', 'default_discount_pct']
    for (const name of fields) {
      const control = form.elements.namedItem(name) as HTMLInputElement
      expect(control.disabled).toBe(true)
      expect(control.closest('label')!.hidden).toBe(true)
    }
    ;(form.elements.namedItem('name') as HTMLInputElement).value = 'Renamed client'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(updateDirectoryClient).toHaveBeenCalledTimes(1))
    for (const name of fields) expect(updateDirectoryClient.mock.calls[0]![1]).not.toHaveProperty(name)
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-client-form-submit]')!.disabled).toBe(false))
    document.querySelector<HTMLButtonElement>('[data-contact-create]')!.click()
    const contactForm = document.querySelector<HTMLFormElement>('[data-contact-form]')!
    const routing = contactForm.elements.namedItem('invoice_recipient_status') as HTMLSelectElement
    expect(routing.disabled).toBe(true)
    expect(routing.closest('label')!.hidden).toBe(true)
    ;(contactForm.elements.namedItem('first_name') as HTMLInputElement).value = 'Operational contact'
    contactForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(createClientContact).toHaveBeenCalledTimes(1))
    expect(createClientContact.mock.calls[0]![0]).not.toHaveProperty('invoice_recipient_status')
  })

  it('[browser #852] sorts a client\'s projects and contacts by a header', async () => {
    writeDocument()
    const later: GeneralResource = { ...project, id: 32, name: 'Alpha site', code: null }
    const api: Partial<ClientDirectoryApi> = {
      listDirectoryClients: vi.fn(async () => page([child, parent])),
      getDirectoryClient: vi.fn(async () => child),
      listClientContacts: vi.fn(async () => page([contact])),
      listClientProjects: vi.fn(async () => page([project, later])),
    }
    const identity: Whoami = {
      user_id: 1,
      profile: 'member',
      manager_grants: [],
      authentication: { kind: 'session' },
    }
    await createClientDirectoryController(api).activate(identity, new AbortController().signal, () => false)

    const names = (): string[] =>
      [...document.querySelectorAll('[data-client-projects] tbody tr[data-row] td[data-column="name"] a')].map(
        (link) => link.textContent ?? '',
      )
    const header = (): HTMLButtonElement =>
      document.querySelector<HTMLButtonElement>(
        '[data-client-projects] thead button[data-sort-column="name"]',
      )!
    expect(names()).toEqual(['Alpha site', '[WEB] Launch'])
    // The table draws itself again on a sort, so the header is found afresh.
    header().click()
    expect(names()).toEqual(['[WEB] Launch', 'Alpha site'])
    header().click()
    expect(names()).toEqual(['Alpha site', '[WEB] Launch'])
  })

  it('[security #466] renders operational relations but no commercial facts for members', async () => {
    writeDocument()
    const api: Partial<ClientDirectoryApi> = {
      listDirectoryClients: vi.fn(async () => page([child, parent])),
      getDirectoryClient: vi.fn(async () => child),
      listClientContacts: vi.fn(async () => page([contact])),
      listClientProjects: vi.fn(async () => page([project])),
      createDirectoryClient: vi.fn(),
      updateDirectoryClient: vi.fn(),
      archiveDirectoryClient: vi.fn(),
      createClientContact: vi.fn(),
      updateClientContact: vi.fn(),
      deleteClientContact: vi.fn(),
    }
    const identity: Whoami = {
      user_id: 1,
      profile: 'member',
      manager_grants: [],
      authentication: { kind: 'session' },
    }
    const controller = createClientDirectoryController(api)

    await controller.activate(identity, new AbortController().signal, () => false)

    expect(document.querySelector('[data-client-detail-parent]')?.textContent).toBe(
      'Parent Holding',
    )
    expect(document.querySelector('[data-client-detail-bill-to]')?.textContent).toBe(
      'Parent Holding',
    )
    expect(document.querySelector('[data-client-projects]')?.textContent).toContain(
      '[WEB] Launch',
    )
    // A client is a hub: its projects are the way through to the work.
    const projectLink = document.querySelector<HTMLAnchorElement>(
      '[data-client-projects] a',
    )
    expect(projectLink?.getAttribute('href')).toBe('/projects/31')
    expect(projectLink?.textContent).toBe('[WEB] Launch')
    expect(document.querySelector('[data-client-contacts]')?.textContent).not.toContain(
      'Invoice CC',
    )
    for (const selector of ['terms', 'tax', 'tax2', 'discount']) {
      const element = document.querySelector<HTMLElement>(`[data-client-detail-${selector}]`)!
      expect(element.textContent).toBe('')
      expect(element.parentElement!.hidden).toBe(true)
    }
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-client-write]')].every(
        (element) => element.hidden,
      ),
    ).toBe(true)
    expect(api.createDirectoryClient).not.toHaveBeenCalled()
    expect(api.archiveDirectoryClient).not.toHaveBeenCalled()
  })

  it('[browser #522] puts a client on another currency from the screen', async () => {
    // `clients.currency` is what decides the currency of every invoice raised
    // for that client, and reports group by it rather than summing across it.
    // Without a control an operator has to reach the database to change it.
    writeDocument()
    const updateDirectoryClient = vi.fn(async (_id, input) => ({ ...child, ...input }))
    const controller = createClientDirectoryController({
      listDirectoryClients: async () => page([parent, child]),
      getDirectoryClient: async () => child,
      listClientContacts: async () => page([contact]),
      listClientProjects: async () => page([project]),
      updateDirectoryClient,
      createClientContact: vi.fn(),
      createDirectoryClient: vi.fn(),
      updateClientContact: vi.fn(),
    })
    const identity: Whoami = {
      user_id: 1,
      profile: 'administrator',
      manager_grants: [],
      authentication: { kind: 'session' },
    }
    await controller.activate(identity, new AbortController().signal, () => false)

    document.querySelector<HTMLButtonElement>('[data-client-edit]')!.click()
    const form = document.querySelector<HTMLFormElement>('[data-client-form]')!
    const currency = form.elements.namedItem('currency') as HTMLInputElement
    // The control is there, and constrained to the shape the column expects --
    // three letters, which `estimates.currency` already checks canonically.
    expect(currency.pattern).toBe('[A-Za-z]{3}')
    expect(currency.maxLength).toBe(3)

    // Typed lower case, because people do.
    currency.value = 'eur'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(updateDirectoryClient).toHaveBeenCalledTimes(1))
    // Upper-cased on the way out: 'eur' and 'EUR' are the same currency, and two
    // spellings in the column would group as two in every report that groups by
    // it.
    expect(updateDirectoryClient.mock.calls[0]![1]).toMatchObject({ currency: 'EUR' })
  })

  it('[browser #486] restores an archived client from the detail header', async () => {
    // 25 of this account's 30 clients arrived archived, so the archived detail
    // page is a normal destination rather than a mistake to be undone once.
    writeDocument()
    const archived: GeneralResource = { ...child, is_active: false }
    const updateDirectoryClient = vi.fn(async (_id: number, input: Record<string, unknown>) => ({
      ...archived,
      ...input,
    }))
    const archiveDirectoryClient = vi.fn(async () => undefined)
    const controller = createClientDirectoryController({
      listDirectoryClients: vi.fn(async () => page([parent, archived])),
      getDirectoryClient: vi.fn(async () => archived),
      listClientContacts: vi.fn(async () => page([contact])),
      listClientProjects: vi.fn(async () => page([project])),
      createDirectoryClient: vi.fn(),
      updateDirectoryClient,
      archiveDirectoryClient,
      createClientContact: vi.fn(),
      updateClientContact: vi.fn(),
      deleteClientContact: vi.fn(),
    })
    const identity: Whoami = {
      user_id: 1,
      profile: 'administrator',
      manager_grants: [],
      authentication: { kind: 'session' },
    }

    await controller.activate(identity, new AbortController().signal, () => false)

    const archiveAction = document.querySelector<HTMLButtonElement>('[data-client-archive]')!
    const restoreAction = document.querySelector<HTMLButtonElement>('[data-client-restore]')!
    expect(document.querySelector('[data-client-detail-active]')?.textContent).toBe('Archived')
    expect(archiveAction.hidden).toBe(true)
    expect(restoreAction.hidden).toBe(false)

    restoreAction.click()

    await vi.waitFor(() =>
      expect(updateDirectoryClient).toHaveBeenCalledWith(
        11,
        { is_active: true },
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-client-detail-status]')?.textContent).toBe(
        'Client restored.',
      ),
    )
    expect(document.querySelector('[data-client-detail-active]')?.textContent).toBe('Active')
    expect(
      document.querySelector<HTMLDialogElement>('[data-client-archive-dialog]')!.open,
    ).toBe(false)
    expect(archiveDirectoryClient).not.toHaveBeenCalled()
    expect(archiveAction.hidden).toBe(false)
    expect(restoreAction.hidden).toBe(true)
  })

  it('[browser] gives each invoice routing state its own pill, shape included', async () => {
    writeDocument()
    const contacts = (['recipient', 'cc', 'bcc', 'none'] as const).map((status, index) => ({
      ...contact,
      id: 21 + index,
      first_name: status,
      invoice_recipient_status: status,
    }))
    const api: Partial<ClientDirectoryApi> = {
      listDirectoryClients: vi.fn(async () => page([child, parent])),
      getDirectoryClient: vi.fn(async () => child),
      listClientContacts: vi.fn(async () => page(contacts)),
      listClientProjects: vi.fn(async () => page([project])),
    }
    const identity: Whoami = {
      user_id: 1,
      profile: 'accounting',
      manager_grants: [],
      authentication: { kind: 'session' },
    }
    const controller = createClientDirectoryController(api)

    await controller.activate(identity, new AbortController().signal, () => false)
    // The pills are only worth anything under the stylesheet the worker serves,
    // so read them through it rather than through the class name.
    const stylesheet = document.createElement('style')
    stylesheet.textContent = webAssets.stylesheet
    document.head.append(stylesheet)

    const pills = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-client-contacts] .client-recipient-pill',
      ),
    ]
    expect(pills.map((pill) => pill.dataset.recipientStatus)).toEqual([
      'bcc',
      'cc',
      'none',
      'recipient',
    ])
    const painted = pills.map((pill) => {
      const style = window.getComputedStyle(pill)
      return {
        fill: style.backgroundColor,
        ink: style.color,
        border:
          style.borderTopColor === 'transparent'
            ? 'none'
            : `${style.borderTopWidth} ${style.borderTopStyle}`,
      }
    })
    // Four states, four appearances: nothing may render the same as anything else.
    expect(new Set(painted.map((paint) => JSON.stringify(paint))).size).toBe(4)
    // And none of it may depend on the fill, because a browser omits
    // background-color when "Background graphics" is off — the default, and so
    // the state a client's printed contact sheet is in. Every label has to
    // stand on its own ink against bare paper; the recipient's did not, because
    // --ez-action-fg is #FFFFFF and printed at 2.3:1, a ghost in the one row
    // the operator opened the sheet to find.
    const paper = themeManifest[defaultTheme].colors.ground
    for (const paint of painted) {
      expect(contrastRatio(paint.ink, paper)).toBeGreaterThanOrEqual(4.5)
    }
    // Hue goes with the fill for a colourblind operator or a greyscale printer,
    // and --ez-action and --ez-data reduce to nearly the same grey, so the
    // border alone has to separate all four states.
    expect(new Set(painted.map((paint) => paint.border)).size).toBe(4)
    // The recipient carries the heaviest of them rather than a fill that prints
    // as nothing, so the row that gets the invoice is the boldest on the page
    // instead of the faintest.
    expect(painted[pills.findIndex(pill => pill.dataset.recipientStatus === 'recipient')]?.border).toBe('2px solid')
  })

  it('[browser] filters the tree without orphaning a matched child', async () => {
    writeDocument('client-list', '/clients')
    const other: GeneralResource = { ...parent, id: 12, name: 'Unrelated Group' }
    const api: Partial<ClientDirectoryApi> = {
      listDirectoryClients: vi.fn(async () => page([parent, child, other])),
    }
    const identity: Whoami = {
      user_id: 1,
      profile: 'member',
      manager_grants: [],
      authentication: { kind: 'session' },
    }
    const controller = createClientDirectoryController(api)
    await controller.activate(identity, new AbortController().signal, () => false)

    const names = (): string[] =>
      [...document.querySelectorAll<HTMLAnchorElement>('[data-client-tree] a')].map(
        (link) => link.textContent ?? '',
      )
    const search = document.querySelector<HTMLInputElement>('[data-client-search]')!
    expect(names()).toEqual(['Parent Holding', 'Worked-For Studio', 'Unrelated Group'])

    search.value = 'worked-for'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    // The parent is kept although it does not match: the child is shown under
    // it, indented, exactly where it lives.
    expect(names()).toEqual(['Parent Holding', 'Worked-For Studio'])
    expect(document.querySelector('[data-client-list-status]')?.textContent).toBe('2 clients shown.')

    search.value = 'nothing'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(names()).toEqual([])
    expect(document.querySelector('[data-client-list-status]')?.textContent).toBe(
      'No clients match that search.',
    )
  })
  it('[browser #486] isolates archived clients and counts them in the filter', async () => {
    // 25 of the 30 clients on the migrated account are archived, so "All" is
    // mostly archive and finding the one to restore means paging a mixed list.
    // The count is what the old roster put in the label -- it says how much is
    // in there before you open it.
    writeDocument('client-list', '/clients')
    const retired: GeneralResource = { ...parent, id: 13, name: 'Retired Group', is_active: false }
    const wound: GeneralResource = { ...parent, id: 14, name: 'Wound Down Ltd', is_active: false }
    const api: Partial<ClientDirectoryApi> = {
      listDirectoryClients: vi.fn(async () => page([parent, child, retired, wound])),
    }
    const identity: Whoami = {
      user_id: 1,
      profile: 'member',
      manager_grants: [],
      authentication: { kind: 'session' },
    }
    await createClientDirectoryController(api).activate(
      identity,
      new AbortController().signal,
      () => false,
    )

    const names = (): string[] =>
      [...document.querySelectorAll<HTMLAnchorElement>('[data-client-tree] a')].map(
        (link) => link.textContent ?? '',
      )
    const archived = document.querySelector<HTMLButtonElement>('[data-client-filter="archived"]')!
    const search = document.querySelector<HTMLInputElement>('[data-client-search]')!
    const status = (): string => document.querySelector('[data-client-list-status]')?.textContent ?? ''

    expect(archived.textContent).toBe('Archived (2)')
    expect(names()).toEqual(['Parent Holding', 'Worked-For Studio'])

    archived.click()
    expect(names()).toEqual(['Retired Group', 'Wound Down Ltd'])
    expect(status()).toBe('2 clients shown.')
    expect(archived.getAttribute('aria-pressed')).toBe('true')
    expect(
      document.querySelector('[data-client-filter="active"]')?.getAttribute('aria-pressed'),
    ).toBe('false')

    // The count is the archive's size, not the size of what the search left
    // standing: it has to mean the same thing whatever else is narrowing the
    // table, or it stops being the reason to open the archive at all.
    search.value = 'wound'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(names()).toEqual(['Wound Down Ltd'])
    expect(archived.textContent).toBe('Archived (2)')

    search.value = ''
    search.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('[data-client-filter="all"]')!.click()
    expect(names()).toEqual([
      'Parent Holding',
      'Worked-For Studio',
      'Retired Group',
      'Wound Down Ltd',
    ])
  })

  it('[browser #486] says the archive is empty rather than that the directory is', async () => {
    writeDocument('client-list', '/clients')
    const shell = document.querySelector<HTMLElement>('[data-authenticated-shell]')!
    shell.inert = false
    shell.hidden = false
    await createClientDirectoryController({
      listDirectoryClients: vi.fn(async () => page([parent, child])),
    }).activate(
      { user_id: 1, profile: 'member', manager_grants: [], authentication: { kind: 'session' } },
      new AbortController().signal,
      () => false,
    )

    const archived = document.querySelector<HTMLButtonElement>('[data-client-filter="archived"]')!
    expect(archived.textContent).toBe('Archived (0)')
    archived.click()
    // "No clients have been created or imported yet" is what this used to say
    // for anything that was not the active filter, and on an account with two
    // clients on screen a moment ago it is simply untrue.
    expect(document.querySelector('[data-client-tree]')?.textContent).toBe(
      'No clients are archived.',
    )
  })

  it('[browser] clears pending mutations after a shared 401 so reauthentication restores CRUD', async () => {
    writeDocument('client-list', '/clients')
    const createDirectoryClient = vi
      .fn()
      .mockRejectedValueOnce(
        new EzactoApiError(401, { error: { message: 'Session expired.' } }, null),
      )
      .mockResolvedValueOnce({ ...parent, id: 12, name: 'Recovered client' })
    const api: Partial<ClientDirectoryApi> = {
      listDirectoryClients: vi.fn(async () => page([parent])),
      createDirectoryClient,
      updateDirectoryClient: vi.fn(),
    }
    const identity: Whoami = {
      user_id: 1,
      profile: 'administrator',
      manager_grants: [],
      authentication: { kind: 'session' },
    }
    const controller = createClientDirectoryController(api)
    const expired = new AbortController()

    await controller.activate(identity, expired.signal, (error) => {
      if (!(error instanceof EzactoApiError) || error.status !== 401) return false
      expired.abort()
      return true
    })

    const form = document.querySelector<HTMLFormElement>('[data-client-form]')!
    const submit = document.querySelector<HTMLButtonElement>('[data-client-form-submit]')!
    document.querySelector<HTMLButtonElement>('[data-client-create]')!.click()
    ;(form.elements.namedItem('name') as HTMLInputElement).value = 'Expired attempt'
    form.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submit }),
    )

    await vi.waitFor(() => expect(createDirectoryClient).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(expired.signal.aborted).toBe(true))
    expect(document.querySelector<HTMLDialogElement>('[data-client-form-dialog]')!.open).toBe(false)

    await controller.activate(identity, new AbortController().signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-client-create]')!.click()
    ;(form.elements.namedItem('name') as HTMLInputElement).value = 'Recovered client'
    form.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submit }),
    )

    await vi.waitFor(() => expect(createDirectoryClient).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-client-list-status]')?.textContent).toBe(
        'Client added.',
      ),
    )
  })

  it('[security] does not sign the next user out with an ended session\u2019s 401', async () => {
    // The whole point of the session presenter. The old handleFailure asked
    // currentSession() who to report to instead of asking the session that made
    // the request, so a 401 arriving after a sign-out was handed to whoever had
    // signed in since -- and their shell, doing exactly what it should with a
    // 401, signed *them* out.
    writeDocument('client-list', '/clients')
    let failList: ((error: unknown) => void) | null = null
    const listDirectoryClients = vi.fn(() =>
      listDirectoryClients.mock.calls.length === 1
        ? new Promise<ReturnType<typeof page>>((_resolve, reject) => {
            failList = reject
          })
        : Promise.resolve(page([parent])),
    )
    const identity = (user_id: number): Whoami => ({
      user_id,
      profile: 'administrator',
      manager_grants: [],
      authentication: { kind: 'session' },
    })
    const controller = createClientDirectoryController({ listDirectoryClients })
    const first = new AbortController()

    const firstActivation = controller.activate(identity(1), first.signal, () => false)
    await vi.waitFor(() => expect(listDirectoryClients).toHaveBeenCalledTimes(1))
    first.abort()

    const second = new AbortController()
    const nextSessionFailure = vi.fn((error: unknown) => {
      if (!(error instanceof EzactoApiError) || error.status !== 401) return false
      second.abort()
      return true
    })
    await controller.activate(identity(2), second.signal, nextSessionFailure)

    failList!(new EzactoApiError(401, { error: { message: 'Session expired.' } }, null))
    await firstActivation

    expect(nextSessionFailure).not.toHaveBeenCalled()
    expect(second.signal.aborted).toBe(false)
    expect(document.body.textContent).not.toContain('Session expired.')
    expect(document.querySelector<HTMLButtonElement>('[data-client-list-retry]')?.hidden).toBe(true)
  })

  it('[security] keeps an ended session\u2019s save failure out of the next user\u2019s dialog', async () => {
    // The other shape in this file, `if (!handleFailure(error)) paint`: for a
    // session that had gone it read as "nobody took it -- carry on", and the
    // previous user's failure was waiting in the dialog the next one opens.
    writeDocument('client-list', '/clients')
    let failSave: ((error: unknown) => void) | null = null
    const createDirectoryClient = vi.fn(
      () =>
        new Promise<GeneralResource>((_resolve, reject) => {
          failSave = reject
        }),
    )
    const identity = (user_id: number): Whoami => ({
      user_id,
      profile: 'administrator',
      manager_grants: [],
      authentication: { kind: 'session' },
    })
    const controller = createClientDirectoryController({
      listDirectoryClients: vi.fn(async () => page([parent])),
      createDirectoryClient,
      updateDirectoryClient: vi.fn(),
    })
    const first = new AbortController()

    await controller.activate(identity(1), first.signal, () => false)
    const form = document.querySelector<HTMLFormElement>('[data-client-form]')!
    const submitter = document.querySelector<HTMLButtonElement>('[data-client-form-submit]')!
    document.querySelector<HTMLButtonElement>('[data-client-create]')!.click()
    ;(form.elements.namedItem('name') as HTMLInputElement).value = 'Left in flight'
    form.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }),
    )
    await vi.waitFor(() => expect(createDirectoryClient).toHaveBeenCalledTimes(1))

    first.abort()
    const nextSessionFailure = vi.fn(() => false)
    await controller.activate(identity(2), new AbortController().signal, nextSessionFailure)

    failSave!(new Error('Saving the client was refused.'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(nextSessionFailure).not.toHaveBeenCalled()
    expect(document.querySelector('[data-client-form-result]')?.textContent).not.toContain(
      'Saving the client was refused.',
    )
    expect(document.body.textContent).not.toContain('Saving the client was refused.')
  })

  /**
   * The rollup is deliberately not awaited by the detail load: a rollup the
   * deployment cannot serve must not take the client's name and contacts down
   * with it. So a test that reads its output has to let it settle first.
   */
  const settleRollup = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('[browser] rolls the three 360 figures up the subtree, one row per currency', async () => {
    // A parent node that is invoiced through its children is owed nothing on
    // its own row, so all three figures are asked for as a set of client ids.
    writeDocument('client-detail', '/clients/10')
    const api = rollupApi()
    const controller = createClientDirectoryController(api)

    await controller.activate(administrator, new AbortController().signal, () => false)
    await settleRollup()

    expect(api.listClientOpenInvoices).toHaveBeenCalledWith(
      [10, 11],
      undefined,
      expect.anything(),
    )
    expect(api.listClientRetainers).toHaveBeenCalledWith([10, 11], undefined, expect.anything())
    expect(document.querySelector<HTMLElement>('[data-client-360]')?.hidden).toBe(false)
    expect(document.querySelector('[data-client-360-scope]')?.textContent).toContain(
      '2 clients',
    )

    const invoices = document.querySelector('[data-client-360-invoices]')!.textContent!
    // Two currencies, two rows. $400.00 is USD's own total and never carries
    // the euros; the blended $1,300.00 must not appear anywhere.
    expect(invoices).toContain('$400.00')
    expect(invoices).toContain('€900.00')
    expect(invoices).toContain('$300.00')
    expect(invoices).not.toContain('1,300.00')

    const retainers = document.querySelector('[data-client-360-retainers]')!.textContent!
    // Money and hours are separate rows in separate units, and the retainer
    // with no client is nobody's balance.
    expect(retainers).toContain('$2,500.00')
    expect(retainers).toContain('€4,000.00')
    expect(retainers).toContain('10 hours')
    expect(retainers).not.toContain('9,999.99')

    const burn = document.querySelector('[data-client-360-burn]')!.textContent!
    expect(burn).toContain('$1,200.00')
    expect(burn).toContain('€50.00')
    // budget_burn_cents on the same payload adds those into 125,000 cents. A
    // blended total is a wrong number that looks right, so it is never read.
    expect(burn).not.toContain('1,250.00')
    expect(
      document.querySelector<HTMLElement>('[data-client-360-burn-note]')?.hidden,
    ).toBe(false)
    expect(
      document.querySelector<HTMLAnchorElement>('[data-client-360-report]')?.getAttribute('href'),
    ).toContain('report=client-rollup&from=')
  })

  it('[security] never asks for the 360 figures on behalf of a profile that may not read money', async () => {
    // Not zeroed and not disabled: a member shown "nothing owed" is told
    // something false about the business, and a 403 painted into the status
    // line says nothing about why. The section is simply not there.
    writeDocument('client-detail', '/clients/10')
    const api = rollupApi()
    const controller = createClientDirectoryController(api)

    await controller.activate(
      { user_id: 2, profile: 'member', manager_grants: [], authentication: { kind: 'session' } },
      new AbortController().signal,
      () => false,
    )

    expect(document.querySelector<HTMLElement>('[data-client-360]')?.hidden).toBe(true)
    expect(api.listClientSubtree).not.toHaveBeenCalled()
    expect(api.listClientOpenInvoices).not.toHaveBeenCalled()
    expect(api.listClientRetainers).not.toHaveBeenCalled()
    expect(api.getClientRollupReport).not.toHaveBeenCalled()
    // The rest of the client page is unaffected -- clients:read is every
    // profile, and the 360 is the only part that is not.
    expect(document.querySelector<HTMLElement>('[data-client-detail]')?.hidden).toBe(false)
  })

  it('[browser] says burn is withheld rather than rendering it as nothing spent', async () => {
    // cost_rate is administrator-only, so an accounting profile gets currency
    // buckets with no cost_cents. An empty burn table there would read as "this
    // subtree consumed nothing", which is a fact about the business that the
    // server did not state.
    writeDocument('client-detail', '/clients/10')
    const api = rollupApi()
    api.getClientRollupReport = vi.fn(
      async () =>
        ({
          ...rollupReport(),
          nodes: [
            {
              ...rollupReport().nodes[0]!,
              rollup: { currencies: [{ currency: 'USD', expense_cents: 20_000 }] },
            },
          ],
        }) as unknown as ClientRollupReport,
    )
    const controller = createClientDirectoryController(api)

    await controller.activate(
      {
        user_id: 3,
        profile: 'accounting',
        manager_grants: [],
        authentication: { kind: 'session' },
      },
      new AbortController().signal,
      () => false,
    )
    await settleRollup()

    expect(document.querySelector('[data-client-360-burn]')?.textContent).toBe('')
    expect(document.querySelector('[data-client-360-burn-note]')?.textContent).toContain(
      'administrator-only',
    )
    // The other two figures are unaffected: they are gated by invoices:read,
    // which this profile holds.
    expect(document.querySelector('[data-client-360-invoices]')?.textContent).toContain(
      '$400.00',
    )
  })
})

describe('billing a client through BILL (issue 542)', () => {
  const base = {
    listDirectoryClients: async () => page([parent, child]),
    getDirectoryClient: async () => child,
    listClientContacts: async () => page([contact]),
    listClientProjects: async () => page([project]),
    updateDirectoryClient: vi.fn(),
    createClientContact: vi.fn(),
    createDirectoryClient: vi.fn(),
    updateClientContact: vi.fn(),
  }
  const administrator: Whoami = {
    user_id: 1,
    profile: 'administrator',
    manager_grants: [],
    authentication: { kind: 'session' },
  }

  const activate = async (api: Partial<ClientDirectoryApi>, billUnavailable = false) => {
    writeDocument()
    if (billUnavailable) document.documentElement.setAttribute('data-bill-unavailable', '')
    const controller = createClientDirectoryController({
      ...base,
      ...api,
    } as unknown as ClientDirectoryApi)
    await controller.activate(administrator, new AbortController().signal, () => false)
    return controller
  }

  const section = () => document.querySelector<HTMLElement>('[data-client-delivery]')!
  const toggle = () =>
    document.querySelector<HTMLInputElement>('[data-client-bill-delivery]')!

  it('[unit] offers the switch, set to what the server holds', async () => {
    await activate({
      getBillStatus: async () => ({ configured: true, can_send_from_bill: true }),
      getBillClientDelivery: async () => ({ deliver_via_bill: true }),
      setBillClientDelivery: vi.fn(),
    })
    expect(section().hidden).toBe(false)
    expect(toggle().checked).toBe(true)
  })

  it('[browser #1217] makes no BILL calls when only another provider is available', async () => {
    document.documentElement.setAttribute('data-bill-unavailable', '')
    try {
      const getBillStatus = vi.fn(), getBillClientDelivery = vi.fn(), setBillClientDelivery = vi.fn()
      await activate({ getBillStatus, getBillClientDelivery, setBillClientDelivery }, true)
      expect(section().hidden).toBe(true)
      expect(getBillStatus).not.toHaveBeenCalled()
      expect(getBillClientDelivery).not.toHaveBeenCalled()
      expect(setBillClientDelivery).not.toHaveBeenCalled()
    } finally { document.documentElement.removeAttribute('data-bill-unavailable') }
  })

  it('[security] hides it entirely where the deployment cannot reach BILL', async () => {
    // A toggle that looks like a setting and refuses every save is worse than
    // no toggle, and the route refuses it for the same reason -- so the screen
    // agrees with the API rather than discovering it on submit.
    await activate({
      getBillStatus: async () => ({ configured: false, can_send_from_bill: false }),
      getBillClientDelivery: async () => ({ deliver_via_bill: false }),
      setBillClientDelivery: vi.fn(),
    })
    expect(section().hidden).toBe(true)
  })

  it('[security] hides it on a build that does not supply the methods at all', async () => {
    await activate({})
    expect(section().hidden).toBe(true)
  })

  it('[unit] says which way the invoice will actually reach the client', async () => {
    // The two deliveries differ, and an operator choosing this should know
    // which one they are choosing.
    await activate({
      getBillStatus: async () => ({ configured: true, can_send_from_bill: false }),
      getBillClientDelivery: async () => ({ deliver_via_bill: false }),
      setBillClientDelivery: vi.fn(),
    })
    const hint = document.querySelector<HTMLElement>('[data-client-delivery-hint]')!
    expect(hint.textContent).toContain('We email the invoice with a BILL payment link')
  })

  it('[unit] saves the change and reports it', async () => {
    const setBillClientDelivery = vi.fn(async (_id: number, wanted: boolean) => ({
      deliver_via_bill: wanted,
    }))
    await activate({
      getBillStatus: async () => ({ configured: true, can_send_from_bill: true }),
      getBillClientDelivery: async () => ({ deliver_via_bill: false }),
      setBillClientDelivery,
    })
    toggle().checked = true
    toggle().dispatchEvent(new Event('change'))
    await vi.waitFor(() => {
      expect(setBillClientDelivery).toHaveBeenCalledWith(11, true, expect.anything())
    })
  })

  it('[security] puts the switch back when the save is refused', async () => {
    // Otherwise the screen shows a state the server did not accept, and the
    // operator believes this client is billed through BILL when they are not.
    await activate({
      getBillStatus: async () => ({ configured: true, can_send_from_bill: true }),
      getBillClientDelivery: async () => ({ deliver_via_bill: false }),
      setBillClientDelivery: vi.fn(async () => {
        throw new EzactoApiError(503, { error: { code: 'service_unavailable' } }, null)
      }),
    })
    toggle().checked = true
    toggle().dispatchEvent(new Event('change'))
    await vi.waitFor(() => {
      expect(toggle().checked).toBe(false)
    })
  })

  it('[unit] renders the client screen even when BILL is unreachable', async () => {
    // A third party being down must not be why a client page fails to render.
    await activate({
      getBillStatus: async () => {
        throw new Error('gateway down')
      },
      getBillClientDelivery: async () => ({ deliver_via_bill: false }),
      setBillClientDelivery: vi.fn(),
    })
    expect(section().hidden).toBe(true)
    expect(
      document.querySelector<HTMLElement>('[data-client-detail-name]')!.textContent,
    ).not.toBe('')
  })
})

describe('putting a client in another currency (#522)', () => {
  it('[money] loads the client’s currency into the form and saves it back', async () => {
    // The one piece #522 called small and real: a column with no control that
    // writes it means an operator cannot move a client to EUR without a
    // terminal. Every report and every invoice groups on this value.
    writeDocument()
    const updateDirectoryClient = vi.fn(async (_id: number, input: Record<string, unknown>) => ({
      ...child,
      ...input,
    }))
    const controller = createClientDirectoryController({
      listDirectoryClients: async () => page([parent, child]),
      getDirectoryClient: async () => child,
      listClientContacts: async () => page([contact]),
      listClientProjects: async () => page([project]),
      updateDirectoryClient,
      createDirectoryClient: vi.fn(),
      createClientContact: vi.fn(),
      updateClientContact: vi.fn(),
    })

    await controller.activate(administrator, new AbortController().signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-client-edit]')!.click()
    const form = document.querySelector<HTMLFormElement>('[data-client-form]')!
    const currency = form.elements.namedItem('currency') as HTMLInputElement
    // Populated, not blank: a form that opens empty and saves is a form that
    // silently clears whatever was there.
    expect(currency.value).toBe('USD')

    currency.value = 'eur'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(updateDirectoryClient).toHaveBeenCalledTimes(1))
    // Upper-cased on the way out. Migration 0059 made the canonical form a
    // check, and 'eur' fails it.
    expect(updateDirectoryClient.mock.calls[0]![1]).toMatchObject({ currency: 'EUR' })
  })

  it('[money] leaves the currency alone rather than clearing it when blank', async () => {
    // A client whose currency is not in the form's reach must keep the one it
    // has. Sending null here would move every invoice it groups.
    writeDocument()
    const updateDirectoryClient = vi.fn(async (_id: number, input: Record<string, unknown>) => ({
      ...child,
      ...input,
    }))
    const controller = createClientDirectoryController({
      listDirectoryClients: async () => page([parent, child]),
      getDirectoryClient: async () => child,
      listClientContacts: async () => page([contact]),
      listClientProjects: async () => page([project]),
      updateDirectoryClient,
      createDirectoryClient: vi.fn(),
      createClientContact: vi.fn(),
      updateClientContact: vi.fn(),
    })

    await controller.activate(administrator, new AbortController().signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-client-edit]')!.click()
    const form = document.querySelector<HTMLFormElement>('[data-client-form]')!
    ;(form.elements.namedItem('currency') as HTMLInputElement).value = '   '
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(updateDirectoryClient).toHaveBeenCalledTimes(1))
    expect(updateDirectoryClient.mock.calls[0]![1]).not.toHaveProperty('currency')
  })
})

describe('a client’s invoice sending', () => {
  const following = (overrides: Partial<ClientInvoiceSending> = {}): ClientInvoiceSending => ({
    client_id: 11,
    recipients: null,
    contacts: {
      to: [{ name: 'Alex Rivera', email: 'alex@example.test' }],
      cc: [{ name: '', email: 'books@example.test' }],
    },
    attach_pdf: null,
    append_pdfs: null,
    attach_files: null,
    attach_journal: null,
    journal_formats: null,
    organization: {
      attach_pdf: true,
      append_pdfs: false,
      attach_files: true,
      attach_journal: 'detailed',
      journal_formats: ['pdf'],
    },
    ...overrides,
  })
  const saved = following({
    recipients: {
      to: [{ name: 'Accounts Payable', email: 'ap@example.com' }],
      cc: [{ name: 'Dana Reyes', email: 'dana@example.test' }],
    },
    attach_pdf: false,
    append_pdfs: true,
    attach_journal: 'summary',
    journal_formats: ['csv'],
  })

  const base = (): Partial<ClientDirectoryApi> => ({
    listDirectoryClients: async () => page([parent, child]),
    getDirectoryClient: async () => child,
    listClientContacts: async () => page([contact]),
    listClientProjects: async () => page([project]),
    updateDirectoryClient: vi.fn(),
    createClientContact: vi.fn(),
    createDirectoryClient: vi.fn(),
    updateClientContact: vi.fn(),
  })

  const activate = async (
    api: Partial<ClientDirectoryApi>,
    identity: Whoami = administrator,
    signal = new AbortController().signal,
  ): Promise<void> => {
    writeDocument()
    await createClientDirectoryController({ ...base(), ...api }).activate(identity, signal, () => false)
  }

  const section = () => document.querySelector<HTMLElement>('[data-client-sending]')!
  const form = () => document.querySelector<HTMLFormElement>('[data-client-sending-form]')!
  const to = () => document.querySelector<HTMLTextAreaElement>('[data-client-sending-to]')!
  const cc = () => document.querySelector<HTMLTextAreaElement>('[data-client-sending-cc]')!
  const source = (value: 'contacts' | 'client') =>
    document.querySelector<HTMLInputElement>(`[data-client-sending-source][value="${value}"]`)!
  const select = (selector: string) => document.querySelector<HTMLSelectElement>(selector)!
  const rule = (field: string) => select(`[data-client-sending-rule="${field}"]`)
  const text = (selector: string) => document.querySelector(selector)?.textContent ?? ''
  const submit = (): void => {
    form().dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
  }
  const loaded = async (): Promise<void> => {
    await vi.waitFor(() => expect(form().hidden).toBe(false))
  }

  it('[browser] follows the contacts’ invoice routing until the client saves lists of its own', async () => {
    const getClientInvoiceSending = vi.fn(async () => following())
    await activate({ getClientInvoiceSending, setClientInvoiceSending: vi.fn() })
    await loaded()

    expect(getClientInvoiceSending).toHaveBeenCalledWith(11, expect.any(AbortSignal))
    expect(section().hidden).toBe(false)
    expect(section().textContent).toContain(
      'Every invoice for this client opens the Send dialog with these, recurring invoices included, and the Send dialog can still change them per invoice.',
    )
    expect(source('contacts').checked).toBe(true)
    expect(source('client').checked).toBe(false)
    // What the contacts give, shown and not editable here: a contact's routing
    // is changed on the contact.
    expect(to().value).toBe('Alex Rivera <alex@example.test>')
    expect(cc().value).toBe('books@example.test')
    expect(to().readOnly).toBe(true)
    expect(cc().readOnly).toBe(true)
    expect(text('[data-client-sending-source-hint]')).toBe(
      'From the contacts’ invoice routing: Recipient goes in To, CC in Cc. Edit a contact to change them.',
    )
    // Every rule follows the organization, and each says what that is today.
    expect(rule('attach_pdf').value).toBe('')
    expect(rule('attach_pdf').options[0]!.textContent).toBe('Organization default (Yes)')
    expect(rule('append_pdfs').options[0]!.textContent).toBe('Organization default (No)')
    expect(rule('attach_files').options[0]!.textContent).toBe('Organization default (Yes)')
    expect(select('[data-client-sending-journal]').options[0]!.textContent).toBe(
      'Organization default (Every entry)',
    )
    expect(select('[data-client-sending-formats-source]').options[0]!.textContent).toBe(
      'Organization default (PDF)',
    )
    // The report goes, so its files are a question; the boxes wait for a choice.
    expect(document.querySelector<HTMLElement>('[data-client-sending-formats-row]')!.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-client-sending-formats]')!.hidden).toBe(true)
  })

  it('[browser] shows the lists and rules a client saved, ready to change', async () => {
    await activate({
      getClientInvoiceSending: vi.fn(async () => saved),
      setClientInvoiceSending: vi.fn(),
    })
    await loaded()

    expect(source('client').checked).toBe(true)
    expect(to().value).toBe('Accounts Payable <ap@example.com>')
    expect(cc().value).toBe('Dana Reyes <dana@example.test>')
    expect(to().readOnly).toBe(false)
    expect(text('[data-client-sending-source-hint]')).toBe(
      'Saved for this client, in place of the contacts’ invoice routing.',
    )
    expect(rule('attach_pdf').value).toBe('false')
    expect(rule('append_pdfs').value).toBe('true')
    expect(rule('attach_files').value).toBe('')
    expect(select('[data-client-sending-journal]').value).toBe('summary')
    expect(select('[data-client-sending-formats-source]').value).toBe('client')
    const boxes = [
      ...document.querySelectorAll<HTMLInputElement>('[data-client-sending-formats] input'),
    ]
    expect(boxes.filter((box) => box.checked).map((box) => box.value)).toEqual(['csv'])
    expect(document.querySelector<HTMLElement>('[data-client-sending-formats]')!.hidden).toBe(false)
  })

  it('[browser] saves the lists and every rule in one request, null where the organization answers', async () => {
    const storedAfter = following({
      recipients: {
        to: [{ name: 'Accounts Payable', email: 'ap@example.com' }],
        cc: [{ name: '', email: 'dana@example.test' }],
      },
      attach_pdf: false,
      append_pdfs: true,
      attach_journal: 'summary',
      journal_formats: ['pdf', 'csv'],
    })
    const getClientInvoiceSending = vi
      .fn<NonNullable<ClientDirectoryApi['getClientInvoiceSending']>>()
      .mockResolvedValueOnce(following())
      .mockResolvedValueOnce(storedAfter)
    const setClientInvoiceSending = vi.fn(async () => undefined)
    await activate({ getClientInvoiceSending, setClientInvoiceSending })
    await loaded()

    // Using this client's own lists starts from what the contacts give.
    source('client').click()
    expect(to().readOnly).toBe(false)
    expect(to().value).toBe('Alex Rivera <alex@example.test>')
    to().value = 'Accounts Payable <AP@Example.com>\n\n'
    cc().value = 'dana@example.test\nap@example.com'
    rule('attach_pdf').value = 'false'
    rule('append_pdfs').value = 'true'
    const journal = select('[data-client-sending-journal]')
    journal.value = 'summary'
    journal.dispatchEvent(new Event('change'))
    const files = select('[data-client-sending-formats-source]')
    files.value = 'client'
    files.dispatchEvent(new Event('change'))
    expect(document.querySelector<HTMLElement>('[data-client-sending-formats]')!.hidden).toBe(false)
    document.querySelector<HTMLInputElement>('[data-client-sending-formats] input[value="csv"]')!.click()
    submit()

    await vi.waitFor(() => expect(setClientInvoiceSending).toHaveBeenCalledTimes(1))
    expect(setClientInvoiceSending).toHaveBeenCalledWith(
      11,
      {
        // The Cc already in To is left out, as the Send dialog leaves it out.
        recipients: {
          to: [{ name: 'Accounts Payable', email: 'AP@Example.com' }],
          cc: [{ name: '', email: 'dana@example.test' }],
        },
        attach_pdf: false,
        append_pdfs: true,
        attach_files: null,
        attach_journal: 'summary',
        journal_formats: ['pdf', 'csv'],
      },
      expect.any(AbortSignal),
    )
    // What was stored is read back and shown, lower-cased as the mailer takes it.
    await vi.waitFor(() =>
      expect(text('[data-client-sending-result]')).toBe(
        'Saved. Invoices for this client open the Send dialog with these from now on.',
      ),
    )
    expect(getClientInvoiceSending).toHaveBeenCalledTimes(2)
    expect(to().value).toBe('Accounts Payable <ap@example.com>')
    expect(document.querySelector<HTMLButtonElement>('[data-client-sending-submit]')!.disabled).toBe(false)
  })

  it('[browser] goes back to following the contacts, and keeps what was typed while it looks', async () => {
    const setClientInvoiceSending = vi.fn(async () => undefined)
    await activate({
      getClientInvoiceSending: vi.fn(async () => saved),
      setClientInvoiceSending,
    })
    await loaded()

    to().value = 'Accounts Payable <ap@example.com>\nOps <ops@example.com>'
    source('contacts').click()
    expect(to().value).toBe('Alex Rivera <alex@example.test>')
    expect(to().readOnly).toBe(true)
    // Coming back is coming back to what was typed, not to what was saved.
    source('client').click()
    expect(to().value).toBe('Accounts Payable <ap@example.com>\nOps <ops@example.com>')

    source('contacts').click()
    submit()
    await vi.waitFor(() => expect(setClientInvoiceSending).toHaveBeenCalledTimes(1))
    expect(setClientInvoiceSending).toHaveBeenCalledWith(
      11,
      expect.objectContaining({ recipients: null }),
      expect.any(AbortSignal),
    )
  })

  it('[browser] refuses an address it cannot send before the request, and names the line', async () => {
    const setClientInvoiceSending = vi.fn(async () => undefined)
    await activate({
      getClientInvoiceSending: vi.fn(async () => saved),
      setClientInvoiceSending,
    })
    await loaded()

    to().value = 'Accounts Payable <ap@example>'
    submit()
    expect(text('[data-client-sending-result]')).toBe(
      'To: “Accounts Payable <ap@example>” is not an email address. Write email@example.com or Name <email@example.com>.',
    )
    to().value = ''
    submit()
    expect(text('[data-client-sending-result]')).toBe(
      'Enter at least one address in To, or follow the contacts’ invoice routing.',
    )
    expect(setClientInvoiceSending).not.toHaveBeenCalled()
  })

  it('[browser] shows the route’s own words when it refuses the save', async () => {
    await activate({
      getClientInvoiceSending: vi.fn(async () => saved),
      setClientInvoiceSending: vi.fn(async () => {
        throw new EzactoApiError(
          422,
          {
            error: {
              code: 'validation_failed',
              message: 'The request is invalid.',
              fields: [{ field: 'to[0]', code: 'invalid_address', message: 'ap@example.com is listed twice' }],
            },
          },
          null,
        )
      }),
    })
    await loaded()
    submit()
    await vi.waitFor(() =>
      expect(text('[data-client-sending-result]')).toBe('ap@example.com is listed twice'),
    )
    expect(document.querySelector<HTMLButtonElement>('[data-client-sending-submit]')!.disabled).toBe(false)
  })

  it('[browser] reads a contact’s new routing back into the boxes', async () => {
    const getClientInvoiceSending = vi
      .fn<NonNullable<ClientDirectoryApi['getClientInvoiceSending']>>()
      .mockResolvedValueOnce(following())
      .mockResolvedValueOnce(
        following({
          contacts: {
            to: [
              { name: 'Alex Rivera', email: 'alex@example.test' },
              { name: 'Sam Okafor', email: 'sam@example.test' },
            ],
            cc: [{ name: '', email: 'books@example.test' }],
          },
        }),
      )
    const createClientContact = vi.fn(async (input: Record<string, unknown>) => ({
      ...contact,
      id: 22,
      ...input,
    }))
    await activate({
      getClientInvoiceSending,
      setClientInvoiceSending: vi.fn(),
      createClientContact,
    })
    await loaded()

    document.querySelector<HTMLButtonElement>('[data-contact-create]')!.click()
    const contactForm = document.querySelector<HTMLFormElement>('[data-contact-form]')!
    ;(contactForm.elements.namedItem('first_name') as HTMLInputElement).value = 'Sam'
    ;(contactForm.elements.namedItem('email') as HTMLInputElement).value = 'sam@example.test'
    ;(contactForm.elements.namedItem('invoice_recipient_status') as HTMLSelectElement).value = 'recipient'
    contactForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(getClientInvoiceSending).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(to().value).toBe('Alex Rivera <alex@example.test>\nSam Okafor <sam@example.test>'),
    )
  })

  it('[browser] keeps the client page standing when the rules cannot be read, and retries', async () => {
    const getClientInvoiceSending = vi
      .fn<NonNullable<ClientDirectoryApi['getClientInvoiceSending']>>()
      .mockRejectedValueOnce(
        new EzactoApiError(500, { error: { code: 'internal_error', message: 'Sending rules are unavailable.' } }, null),
      )
      .mockResolvedValueOnce(following())
    await activate({ getClientInvoiceSending, setClientInvoiceSending: vi.fn() })

    await vi.waitFor(() =>
      expect(text('[data-client-sending-status]')).toBe('Sending rules are unavailable.'),
    )
    expect(text('[data-client-detail-name]')).toBe('Worked-For Studio')
    expect(form().hidden).toBe(true)
    const retry = document.querySelector<HTMLButtonElement>('[data-client-sending-retry]')!
    expect(retry.hidden).toBe(false)
    retry.click()
    await loaded()
    expect(retry.hidden).toBe(true)
    expect(text('[data-client-sending-status]')).toBe('')
  })

  it.each([
    ['a project manager with client grants', { ...administrator, profile: 'project_manager', manager_grants: ['clients'] }],
    ['a member', { ...administrator, profile: 'member' }],
    [
      'an API token with invoices:write',
      { ...administrator, authentication: { kind: 'token', token_id: 4, scopes: ['invoices:write'] } },
    ],
  ] satisfies ReadonlyArray<readonly [string, Whoami]>)(
    '[security] never asks for a client’s invoice sending on behalf of %s',
    async (_who, identity) => {
      // The routes refuse the read as well as the write, so there is no
      // read-only version of the section to show: it is not offered.
      const getClientInvoiceSending = vi.fn(async () => following())
      await activate({ getClientInvoiceSending, setClientInvoiceSending: vi.fn() }, identity)
      await vi.waitFor(() => expect(text('[data-client-detail-name]')).toBe('Worked-For Studio'))
      expect(section().hidden).toBe(true)
      expect(getClientInvoiceSending).not.toHaveBeenCalled()
    },
  )

  it('[security] hides it on a build that does not supply the methods', async () => {
    await activate({})
    await vi.waitFor(() => expect(text('[data-client-detail-name]')).toBe('Worked-For Studio'))
    expect(section().hidden).toBe(true)
  })

  it('[security] takes the addresses down with the session', async () => {
    const session = new AbortController()
    await activate(
      { getClientInvoiceSending: vi.fn(async () => saved), setClientInvoiceSending: vi.fn() },
      administrator,
      session.signal,
    )
    await loaded()
    expect(to().value).toContain('ap@example.com')

    session.abort()

    expect(section().hidden).toBe(true)
    expect(to().value).toBe('')
    expect(cc().value).toBe('')
  })
})


it('[browser #852] sorts siblings naturally and retains hierarchy, focus and person-specific memory', async () => {
  const clients = [parent, { ...child, name: 'Unit 10' }, { ...child, id: 12, name: 'Unit 9' }, { ...parent, id: 20, name: 'Other root' }]
  const mount = async (userId: number) => {
    setSortPreferenceOwner(userId)
    writeDocument('client-list', '/clients')
    const shell = document.querySelector<HTMLElement>('[data-authenticated-shell]')!
    shell.inert = false
    shell.hidden = false
    await createClientDirectoryController({ listDirectoryClients: async () => page(clients) })
      .activate({ ...administrator, user_id: userId }, new AbortController().signal, () => false)
  }
  const ids = () => [...document.querySelectorAll('[data-client-tree] tbody tr[data-row-key]')].map(row => row.getAttribute('data-row-key'))
  const header = () => document.querySelector<HTMLButtonElement>('[data-client-tree] button[data-sort-column="client"]')!
  try {
    await mount(1)
    expect(ids()).toEqual(['20', '10', '12', '11'])
    header().click()
    expect(ids()).toEqual(['10', '11', '12', '20'])
    expect(document.activeElement === header()).toBe(true)
    expect(header().closest('th')?.getAttribute('aria-sort')).toBe('descending')
    expect(document.querySelector('[data-client-tree] [data-row-key="11"] .client-tree-name')?.getAttribute('style')).toContain('16px')
    await mount(1)
    expect(ids()).toEqual(['10', '11', '12', '20'])
    await mount(2)
    expect(ids()).toEqual(['20', '10', '12', '11'])
  } finally { setSortPreferenceOwner(null); localStorage.clear() }
})
