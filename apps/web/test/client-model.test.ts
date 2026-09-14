import type {
  ClientRollupNode,
  EzactoClient,
  GeneralResource,
  Invoice,
  Retainer,
  Whoami,
} from '@conflict-hq/ezacto-client'
import { describe, expect, it, vi } from 'vitest'
import {
  clientBudgetBurn,
  clientBurnWindow,
  clientHierarchy,
  clientIdFromPathname,
  clientOpenInvoiceTotals,
  clientProfileCanReadMoney,
  clientProfileCanWrite,
  clientRetainerBalances,
  clientRollupHref,
  clientSearchMatches,
  clientSubtreeIds,
  createShellApi,
  relationLabel,
  renderClientDirectoryPages,
} from '../src/index.js'

const timestamp = '2026-09-01T12:00:00.000Z'
const client = (
  id: number,
  name: string,
  parentClientId: number | null = null,
): GeneralResource => ({
  id,
  name,
  parent_client_id: parentClientId,
  is_active: true,
  created_at: timestamp,
  updated_at: timestamp,
})

describe('Clients V1 model', () => {
  it('[unit] maps directory reads and writes to bounded generated-client operations', async () => {
    const response = { data: client(7, 'Mapped client'), links: { self: '/api/v1/clients/7' } }
    const page = { data: [], links: {}, page: { next_cursor: null } }
    const generated = {
      listClients: vi.fn(async () => page),
      getClient: vi.fn(async () => response),
      createClient: vi.fn(async () => response),
      updateClient: vi.fn(async () => response),
      deleteClient: vi.fn(async () => undefined),
      listContacts: vi.fn(async () => page),
      createContact: vi.fn(async () => response),
      updateContact: vi.fn(async () => response),
      deleteContact: vi.fn(async () => undefined),
      listProjects: vi.fn(async () => page),
      listClientDescendants: vi.fn(async () => ({ data: [], links: {} })),
      listInvoices: vi.fn(async () => page),
      listRetainers: vi.fn(async () => page),
    }
    const api = createShellApi(generated as unknown as EzactoClient)
    const signal = new AbortController().signal

    await api.listProjects('shared-cursor', signal)
    await api.listDirectoryClients!('client-cursor', signal)
    await api.getDirectoryClient!(7, signal)
    await api.createDirectoryClient!({ name: 'Mapped client' }, signal)
    await api.updateDirectoryClient!(7, { address: 'Updated' }, signal)
    await api.archiveDirectoryClient!(7, signal)
    await api.listClientContacts!(7, 'contact-cursor', signal)
    await api.createClientContact!({ client_id: 7, first_name: 'Alex' }, signal)
    await api.updateClientContact!(8, { first_name: 'Jordan' }, signal)
    await api.deleteClientContact!(8, signal)
    await api.listClientProjects!(7, 'project-cursor', signal)
    await api.listClientSubtree!(7, signal)
    await api.listClientOpenInvoices!([7, 8, 9], undefined, signal)
    await api.listClientRetainers!([7, 8, 9], undefined, signal)

    expect(generated.listProjects).toHaveBeenNthCalledWith(1, {
      query: { per_page: 200, is_active: true, cursor: 'shared-cursor' },
      signal,
    })
    expect(generated.listClients).toHaveBeenCalledWith({
      query: { per_page: 200, cursor: 'client-cursor' },
      signal,
    })
    expect(generated.getClient).toHaveBeenCalledWith({ id: 7, signal })
    expect(generated.createClient).toHaveBeenCalledWith({
      body: { name: 'Mapped client' },
      signal,
    })
    expect(generated.updateClient).toHaveBeenCalledWith({
      id: 7,
      body: { address: 'Updated' },
      signal,
    })
    expect(generated.deleteClient).toHaveBeenCalledWith({ id: 7, signal })
    expect(generated.listContacts).toHaveBeenCalledWith({
      query: { client_id: 7, per_page: 200, cursor: 'contact-cursor' },
      signal,
    })
    expect(generated.deleteContact).toHaveBeenCalledWith({ id: 8, signal })
    expect(generated.listProjects).toHaveBeenNthCalledWith(2, {
      query: { client_id: 7, per_page: 200, cursor: 'project-cursor' },
      signal,
    })
    expect(generated.listClientDescendants).toHaveBeenCalledWith({ id: 7, signal })
    // One request for the whole subtree rather than one per node, and `open`
    // applied by the server so a page of drafts never crosses the wire.
    expect(generated.listInvoices).toHaveBeenCalledWith({
      query: { client_id: '7,8,9', state: 'open', per_page: 200 },
      signal,
    })
    expect(generated.listRetainers).toHaveBeenCalledWith({
      query: { client_id: '7,8,9', per_page: 200 },
      signal,
    })
  })

  it('[unit] renders worked-for and bill-to relationships as distinct facts', () => {
    const markup = renderClientDirectoryPages()

    expect(markup).toContain('<dt>Worked-for parent</dt>')
    expect(markup).toContain('<dt>Bill-to client</dt>')
    expect(markup).not.toContain('Parent / bill-to')
    expect(markup).toContain('Permanently delete this contact?')
    expect(markup).toContain('cannot be undone')
    expect(markup).not.toContain('Archive this contact?')
  })

  it('[unit] builds a stable parent-first hierarchy and bounds corrupt cycles', () => {
    const rows = clientHierarchy([
      client(3, 'Grandchild', 2),
      client(1, 'Parent'),
      client(2, 'Child', 1),
      client(5, 'Cycle B', 4),
      client(4, 'Cycle A', 5),
    ])

    expect(rows.map(({ client: item, depth }) => [item.id, depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 0],
      [5, 1],
    ])
    expect(new Set(rows.map(({ client: item }) => item.id)).size).toBe(5)
    expect(relationLabel(1, rows.map(({ client: item }) => item))).toBe('Parent')
  })


  it('[unit] keeps the ancestors of a match so the tree still says who owns whom', () => {
    const clients = [
      client(1, 'Parent Holding'),
      client(2, 'Worked-For Studio', 1),
      client(3, 'Grandchild Unit', 2),
      client(4, 'Unrelated'),
    ]

    expect(clientSearchMatches(clients, 'grandchild').map((row) => row.name)).toEqual([
      'Parent Holding',
      'Worked-For Studio',
      'Grandchild Unit',
    ])
    // A parent that matches does not drag its children in with it: the query
    // named the parent, not the work under it.
    expect(clientSearchMatches(clients, 'parent').map((row) => row.name)).toEqual([
      'Parent Holding',
    ])
    expect(clientSearchMatches(clients, '  ').map((row) => row.id)).toEqual([1, 2, 3, 4])
    expect(clientSearchMatches(clients, 'nothing')).toEqual([])
  })

  it('[unit] bounds a parent cycle rather than climbing it forever', () => {
    // clientHierarchy already treats a cycle as roots; the search must survive
    // the same corrupt data rather than hanging the list that renders it.
    const cycle = [
      { ...client(1, 'One'), parent_client_id: 2 },
      { ...client(2, 'Two'), parent_client_id: 1 },
    ]

    expect(clientSearchMatches(cycle, 'one').map((row) => row.id)).toEqual([1, 2])
  })
  it.each([
    ['member', false],
    ['people_admin', false],
    ['project_manager', true],
    ['accounting', true],
    ['executive_manager', true],
    ['administrator', true],
  ] satisfies ReadonlyArray<readonly [Whoami['profile'], boolean]>) (
    '[unit] maps %s to clients:write visibility %s',
    (profile, expected) => {
      expect(clientProfileCanWrite(profile)).toBe(expected)
    },
  )

  it.each([
    ['/clients/1', 1],
    ['/clients/42/', 42],
    ['/clients/0', null],
    ['/clients/-1', null],
    ['/clients/nope', null],
    ['/clients/9007199254740992', null],
  ])('[unit] parses safe client path %s', (path, expected) => {
    expect(clientIdFromPathname(path)).toBe(expected)
  })
})

const invoice = (
  id: number,
  clientId: number,
  currency: string,
  state: Invoice['state'],
  dueCents: number,
  dueDate: string,
): Invoice =>
  ({
    id,
    client_id: clientId,
    currency,
    state,
    due_amount_cents: dueCents,
    due_date: dueDate,
  }) as unknown as Invoice

const retainer = (
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

const rollupNode = (
  clientId: number,
  currencies: ClientRollupNode['rollup']['currencies'],
): ClientRollupNode =>
  ({
    client_id: clientId,
    name: `Client ${clientId}`,
    parent_client_id: null,
    depth: 0,
    direct: { currencies: [] },
    rollup: { currencies },
  }) as unknown as ClientRollupNode

describe('Client 360 figures', () => {
  it('[unit] roots the subtree at this client and ignores rows anchored elsewhere', () => {
    // The endpoint is rooted, so a row for another ancestor should not arrive.
    // If one ever does -- a mis-wired call, a cached response for the previous
    // client -- rolling it in would put a stranger's money on this page.
    expect(
      clientSubtreeIds(10, [
        { ancestor_id: 10, descendant_id: 10, depth: 0 },
        { ancestor_id: 10, descendant_id: 12, depth: 1 },
        { ancestor_id: 10, descendant_id: 11, depth: 1 },
        { ancestor_id: 99, descendant_id: 50, depth: 1 },
      ]),
    ).toEqual([10, 11, 12])
    // An empty answer still includes the client itself, so its own invoices
    // are counted rather than the section reading as an empty subtree.
    expect(clientSubtreeIds(10, [])).toEqual([10])
  })

  it('[unit] keeps open-invoice obligations per currency and never blends them', () => {
    const totals = clientOpenInvoiceTotals(
      [
        invoice(1, 10, 'USD', 'open', 30_000, '2026-08-01'),
        invoice(2, 11, 'EUR', 'open', 90_000, '2026-10-01'),
        invoice(3, 11, 'USD', 'open', 10_000, '2026-10-01'),
        // Not owed: a draft has not been sent, and a paid one is settled.
        invoice(4, 11, 'USD', 'draft', 500_000, '2026-08-01'),
        invoice(5, 11, 'USD', 'paid', 500_000, '2026-08-01'),
        // Outside the subtree. The server filters too; this is what stands
        // between a filter that did not arrive and another client's debt.
        invoice(6, 77, 'USD', 'open', 700_000, '2026-08-01'),
      ],
      [10, 11],
      '2026-09-09',
    )

    expect(totals).toEqual([
      { currency: 'EUR', dueCents: 90_000, overdueCents: 0, openCount: 1, overdueCount: 0 },
      {
        currency: 'USD',
        dueCents: 40_000,
        overdueCents: 30_000,
        openCount: 2,
        overdueCount: 1,
      },
    ])
    // The two currencies stay two rows. A single 130,000 would be a number in
    // no currency at all, which is the failure this grouping exists to prevent.
    expect(totals).toHaveLength(2)
  })

  it('[unit] groups retainer balances by denomination and currency, dropping unclaimed ones', () => {
    const clients: GeneralResource[] = [
      { ...client(10, 'Parent'), currency: 'USD' },
      { ...client(11, 'Euro Child', 10), currency: 'EUR' },
    ]

    expect(
      clientRetainerBalances(
        [
          retainer(1, 10, 'money', 250_000),
          retainer(2, 10, 'money', 50_000),
          retainer(3, 11, 'money', 400_000),
          retainer(4, 10, 'hours', 36_000),
          // No client: the Harvest cutover leaves client_id unset on a stub,
          // and a balance attributed to a client that never agreed to it is a
          // wrong number.
          retainer(5, null, 'money', 999_999),
          // Outside the subtree.
          retainer(6, 77, 'money', 888_888),
        ],
        [10, 11],
        clients,
      ),
    ).toEqual([
      { denomination: 'money', currency: 'EUR', count: 1, balance: 400_000 },
      { denomination: 'money', currency: 'USD', count: 2, balance: 300_000 },
      // Seconds, and in no currency: adding this to either money row would
      // produce a number with no unit.
      { denomination: 'hours', currency: null, count: 1, balance: 36_000 },
    ])
  })

  it('[unit] derives burn per currency and refuses the payload blended total', () => {
    const burns = clientBudgetBurn(
      rollupNode(10, [
        { currency: 'USD', expense_cents: 20_000, cost_cents: 100_000 },
        { currency: 'EUR', expense_cents: 5_000, cost_cents: 0 },
      ]),
    )

    expect(burns).toEqual([
      { currency: 'USD', costCents: 100_000, expenseCents: 20_000, burnCents: 120_000 },
      { currency: 'EUR', costCents: 0, expenseCents: 5_000, burnCents: 5_000 },
    ])
    // The report's own budget_burn_cents adds these two into 125,000, an
    // integer in no currency. Nothing here ever produces that number.
    expect(burns!.some((burn) => burn.burnCents === 125_000)).toBe(false)
  })

  it('[unit] states nothing at all when the server withheld the cost figures', () => {
    // cost_rate is administrator-only, so accounting and executive managers get
    // buckets with no cost_cents on every client. Zero would say "nothing was
    // spent", which is a fact about the business; "we did not tell you" is not.
    expect(
      clientBudgetBurn(rollupNode(10, [{ currency: 'USD', expense_cents: 20_000 }])),
    ).toBeNull()
    // No activity is a different answer from a withheld one, and stays empty.
    expect(clientBudgetBurn(rollupNode(10, []))).toEqual([])
  })

  it('[unit] bounds burn to a stated window that matches the report it links to', () => {
    expect(clientBurnWindow('2026-09-09')).toEqual({ from: '2026-09-01', to: '2026-09-09' })
    expect(clientRollupHref(11, clientBurnWindow('2026-09-09'))).toBe(
      '/reports?report=client-rollup&from=2026-09-01&to=2026-09-09&client_id=11',
    )
  })

  it.each([
    ['member', false],
    ['project_manager', false],
    ['people_admin', false],
    ['accounting', true],
    ['executive_manager', true],
    ['administrator', true],
  ] satisfies ReadonlyArray<readonly [Whoami['profile'], boolean]>)(
    '[unit] maps %s to 360 money visibility %s',
    (profile, expected) => {
      expect(clientProfileCanReadMoney(profile)).toBe(expected)
    },
  )
})
