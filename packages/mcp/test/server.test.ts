import {
  createApiApp,
  installGeneralResourceRoutes,
  installReportRoutes,
  requireApiScope,
  serializeTimeEntry,
  type ApiTokenService,
  type GeneralResourceRouteOptions,
  type ReportReader,
  type TimeEntryRecord,
  type UserProfile,
} from '@ezacto/api'
import { EzactoClient } from '@conflict-hq/ezacto-client'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { McpServer } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it } from 'vitest'
import { createEzactoMcpServer } from '../src/server.js'
import {
  DEFAULT_REPORT_FROM,
  DEFAULT_REPORT_TO,
  MAX_RESOURCE_LOOKUP_PAGES,
  type EzactoReadClient,
} from '../src/tools.js'

const tokens = {
  member: `ezacto_membermembermem_${'A'.repeat(43)}`,
  accounting: `ezacto_accountingacct_${'B'.repeat(43)}`,
  administrator: `ezacto_adminadminadmin_${'C'.repeat(43)}`,
  projectsOnly: `ezacto_projectsonlytok_${'D'.repeat(43)}`,
} as const

const scopes = [
  'time_entries:read',
  'projects:read',
  'clients:read',
  'reports:read',
]

const tokenRecords: Record<
  string,
  { profile: UserProfile; scopes: string[] }
> = {
  [tokens.member]: {
    profile: 'member',
    scopes: ['time_entries:read', 'projects:read', 'clients:read'],
  },
  [tokens.accounting]: { profile: 'accounting', scopes },
  [tokens.administrator]: { profile: 'administrator', scopes },
  [tokens.projectsOnly]: { profile: 'administrator', scopes: ['projects:read'] },
}

const tokenService: ApiTokenService = {
  authenticate: async (presented) => {
    const record = tokenRecords[presented]
    return record === undefined
      ? null
      : {
          tokenId: Object.keys(tokenRecords).indexOf(presented) + 1,
          userId: 42,
          profile: record.profile,
          managerGrants: [],
          scopes: [...record.scopes],
        }
  },
  issue: async () => {
    throw new Error('not used')
  },
  list: async () => [],
  revoke: async () => null,
}

const timeEntry: TimeEntryRecord = {
  id: 91,
  harvestId: null,
  userId: 42,
  projectId: 20,
  taskId: 30,
  userAssignmentId: 40,
  taskAssignmentId: 50,
  spentDate: '2026-08-20',
  seconds: 3600,
  secondsWithoutTimer: 3600,
  roundedSeconds: 3600,
  timerStartedAt: null,
  startedTime: null,
  endedTime: null,
  notes: 'Read-only MCP acceptance',
  billable: true,
  budgeted: true,
  approvalStatus: 'unsubmitted',
  sourceApprovalStatus: null,
  invoiceId: null,
  billableRateCents: 20_000,
  costRateCents: 7_500,
  externalRef: null,
  calendarEventRef: null,
  noteMinimumLength: 0,
  createdAt: '2026-08-20T12:00:00.000Z',
  updatedAt: '2026-08-20T12:00:00.000Z',
  state: {
    approvalStatus: 'unsubmitted',
    invoiceId: null,
    isBilled: false,
    isLocked: false,
    lockedReasonCode: null,
    lockedReason: null,
  },
}

let lastUninvoicedFilter:
  | { from: string; to: string; clientId?: number; projectId?: number }
  | undefined

let lastProjectBudgetRange: { from: string; to: string } | undefined

const reportReader: ReportReader = {
  // Not exercised here; present because ReportReader requires it.
  detailedTime: async (filter) => ({
    kind: "report" as const,
    report: {
      from: filter.from,
      to: filter.to,
      clientId: filter.clientId ?? null,
      projectId: filter.projectId ?? null,
      hours: filter.hours ?? "all",
      grain: filter.grain ?? "day",
      activeProjectsOnly: filter.activeProjectsOnly ?? false,
      seconds: 0,
      roundedSeconds: 0,
      billableSeconds: 0,
      uninvoicedBillableSeconds: 0,
      timeEntryCount: 0,
      currencies: [],
      rows: [],
    },
  }),
  // Not exercised here; present because ReportReader requires it.
  contractorCost: async (range) => ({ from: range.from, to: range.to, rows: [] }),
  // Not exercised here; present because ReportReader requires it.
  detailedExpense: async (filter) => ({
    from: filter.from,
    to: filter.to,
    clientId: filter.clientId ?? null,
    projectId: filter.projectId ?? null,
    billableOnly: filter.billableOnly === true,
    rows: [],
    totals: [],
  }),
  // Not exercised here; present because ReportReader requires it.
  bandedMonths: async (range) => ({ from: range.from, to: range.to, rows: [] }),
  profitability: async (range) => ({
    from: range.from,
    to: range.to,
    organizationCurrency: 'USD',
    rows: [],
    totals: {
      roundedSeconds: 0,
      revenueCents: 0,
      costCents: 0,
      profitCents: 0,
      entriesWithoutBillableRate: 0,
      entriesWithoutCostRate: 0,
      projectsNotConverted: 0,
    },
    previousFrom: range.from,
    previousTo: range.to,
    previousTotals: {
      roundedSeconds: 0,
      revenueCents: 0,
      costCents: 0,
      profitCents: 0,
      entriesWithoutBillableRate: 0,
      entriesWithoutCostRate: 0,
      projectsNotConverted: 0,
    },
  }),
  // Not exercised here; present because ReportReader requires it.
  timeReport: async (range) => ({
    from: range.from,
    to: range.to,
    totals: {
      seconds: 0,
      roundedSeconds: 0,
      billableSeconds: 0,
      timeEntryCount: 0,
      unpricedBillableEntryCount: 0,
      amounts: [],
    },
    clients: [],
    projects: [],
    tasks: [],
    teammates: [],
  }),
  // Not exercised here; present because ReportReader requires it. Returning an
  // empty shape rather than throwing keeps a fixture that is about something
  // else from failing loudly if a future test does reach it.
  memberHours: async (filter) => ({
    from: filter.from,
    to: filter.to,
    userId: filter.userId,
    projectId: filter.projectId ?? null,
    seconds: 0,
    roundedSeconds: 0,
    billableSeconds: 0,
    timeEntryCount: 0,
    projects: [],
  }),
  uninvoiced: async (filter) => {
    lastUninvoicedFilter = filter
    return {
      from: filter.from,
      to: filter.to,
      clientId: filter.clientId ?? null,
      projectId: filter.projectId ?? null,
      totals: [
        {
          currency: 'USD',
          roundedSeconds: 3600,
          timeEntryCount: 1,
          unpricedTimeEntryCount: 0,
          expenseCount: 1,
          timeCents: 20_000,
          expenseCents: 2_500,
          totalCents: 22_500,
        },
      ],
      projects: [],
    }
  },
  clientRollup: async (clientId, range) => ({
    rootClientId: clientId,
    ...range,
    nodes: [
      {
        clientId,
        name: 'North Peak',
        parentClientId: null,
        depth: 0,
        nodeBudgetCents: 50_000,
        budgetBurnCents: 30_000,
        direct: {
          timeEntryCount: 1,
          expenseCount: 1,
          roundedSeconds: 3600,
          billableSeconds: 3600,
          budgetedSeconds: 3600,
          timeBudgetSeconds: 7200,
          unpricedBillableEntryCount: 0,
          unpricedCostEntryCount: 0,
          currencies: [
            {
              currency: 'USD',
              expenseCents: 2_500,
              uninvoicedTimeCents: 20_000,
              uninvoicedExpenseCents: 2_500,
              uninvoicedTotalCents: 22_500,
              moneyBudgetCents: 50_000,
              costCents: 7_500,
            },
          ],
        },
        rollup: {
          timeEntryCount: 1,
          expenseCount: 1,
          roundedSeconds: 3600,
          billableSeconds: 3600,
          budgetedSeconds: 3600,
          timeBudgetSeconds: 7200,
          unpricedBillableEntryCount: 0,
          unpricedCostEntryCount: 0,
          currencies: [
            {
              currency: 'USD',
              expenseCents: 2_500,
              uninvoicedTimeCents: 20_000,
              uninvoicedExpenseCents: 2_500,
              uninvoicedTotalCents: 22_500,
              moneyBudgetCents: 50_000,
              costCents: 7_500,
            },
          ],
        },
      },
    ],
  }),
  projectBudgetSummaries: async (range) => {
    lastProjectBudgetRange = range
    return [
      {
        projectId: 20,
        currency: 'USD',
        budgetBy: 'project_cost',
        unit: 'cents',
        budgetAmount: 50_000,
        spentAmount: 7_500,
        remainingAmount: 42_500,
        costCents: 7_500,
        unpricedEntryCount: 0,
      },
    ]
  },
  projectBudget: async (projectId, range) => ({
    projectId,
    budgetBy: 'project_cost',
    expensesIncluded: true,
    ...range,
    grains: [
      {
        source: 'project',
        sourceId: projectId,
        unit: 'cents',
        calculation: 'cost',
        budgetAmount: 50_000,
        spentAmount: 7_500,
        remainingAmount: 42_500,
        unpricedEntryCount: 0,
      },
    ],
  }),
}

const createdAt = '2026-08-01T00:00:00.000Z'
const clientRecords = [
  ...Array.from({ length: 200 }, (_value, index) => ({
    id: index + 1,
    name: `Client ${index + 1}`,
    address: null,
    currency: 'USD',
    isActive: true,
    parentClientId: null,
    billToClientId: null,
    paymentTerms: 'net_30',
    defaultTaxPct: null,
    defaultTax2Pct: null,
    defaultDiscountPct: null,
    createdAt,
    updatedAt: createdAt,
  })),
  {
    id: 201,
    name: 'North Peak',
    address: null,
    currency: 'USD',
    isActive: true,
    parentClientId: null,
    billToClientId: null,
    paymentTerms: 'net_30',
    defaultTaxPct: null,
    defaultTax2Pct: null,
    defaultDiscountPct: null,
    createdAt,
    updatedAt: createdAt,
  },
]
const projectRecords = [
  {
    id: 20,
    clientId: 201,
    name: 'North Peak Delivery',
    code: 'NORTHPEAK',
    isActive: true,
    billingMethod: 'time_materials',
    billBy: 'project',
    hourlyRateCents: 20_000,
    feeCents: 100_000,
    budgetBy: 'project_cost',
    budgetSeconds: null,
    costBudgetCents: 50_000,
    budgetIsMonthly: false,
    costBudgetIncludeExpenses: true,
    notifyWhenOverBudget: false,
    overBudgetPct: null,
    showBudgetToAll: false,
    reportVisibility: 'managers',
    startsOn: null,
    endsOn: null,
    notes: 'administrator-only project note',
    billingCurrency: 'USD',
    timeEntryNotesMinimumLength: null,
    createdAt,
    updatedAt: createdAt,
  },
]

const generalResources: GeneralResourceRouteOptions['repository'] = {
  highWatermark: async (kind, filters) => {
    if (kind === 'clients') return 201
    if (kind === 'projects' && (filters.clientId === undefined || filters.clientId === 201)) {
      return 20
    }
    return null
  },
  list: async (kind, filters, window) => {
    const records =
      kind === 'clients'
        ? clientRecords
        : kind === 'projects' &&
            (filters.clientId === undefined || filters.clientId === 201)
          ? projectRecords
          : []
    return records
      .filter(
        (record) =>
          record.id > (window.afterId ?? 0) && record.id <= window.throughId,
      )
      .slice(0, window.take)
  },
  get: async () => {
    throw new Error('not used')
  },
  create: async () => {
    throw new Error('not used')
  },
  update: async () => {
    throw new Error('not used')
  },
  remove: async () => {
    throw new Error('not used')
  },
  highWatermarkRates: async () => null,
  listRates: async () => [],
  getRate: async () => {
    throw new Error('not used')
  },
}

const teamRepository = new Proxy(
  {},
  { get: () => async () => { throw new Error('not used') } },
) as GeneralResourceRouteOptions['teamRepository']

const app = createApiApp({
  authentication: { tokens: tokenService },
  installApi: (api) => {
    api.get('/time-entries', (context) => {
      requireApiScope(context, 'time_entries:read')
      return context.json({
        data: [serializeTimeEntry(timeEntry, context.get('principal'))],
        links: { self: '/api/v1/time-entries', next: null },
        page: { per_page: 200, next_cursor: null },
      })
    })
    installGeneralResourceRoutes(api, {
      repository: generalResources,
      cursorSigningKey: new Uint8Array(32).fill(7),
      isExpensesModuleEnabled: async () => true,
      teamRepository,
    })
    installReportRoutes(api, reportReader)
  },
})

interface ProtocolHarness {
  client: Client
  server: McpServer
  close(): Promise<void>
}

const protocolHarness = async (
  token: string,
  readClient?: EzactoReadClient,
): Promise<ProtocolHarness> => {
  const apiClient =
    readClient ??
    new EzactoClient({
      baseUrl: 'https://api.test',
      token,
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    })
  const server = createEzactoMcpServer(apiClient)
  const client = new Client({ name: 'ezacto-mcp-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return {
    client,
    server,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

const directApi = async (token: string, path: string): Promise<unknown> => {
  const response = await app.request(`/api/v1${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return response.json()
}

describe('ezacto read-only MCP server', () => {
  let harness: ProtocolHarness | undefined

  afterEach(async () => {
    await harness?.close()
    harness = undefined
    lastUninvoicedFilter = undefined
    lastProjectBudgetRange = undefined
  })

  it('[mcp] advertises only the six bounded read tools', async () => {
    harness = await protocolHarness(tokens.administrator)
    const tools = await harness.client.listTools()
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'get_client_rollup',
      'get_project_budget',
      'get_uninvoiced',
      'list_project_budgets',
      'list_projects',
      'list_time_entries',
    ])
    for (const tool of tools.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      })
    }
  })

  it('[security] preserves API serializer redaction for the bearer token profile', async () => {
    harness = await protocolHarness(tokens.member)
    const timeResult = await harness.client.callTool({
      name: 'list_time_entries',
      arguments: { per_page: 10 },
    })
    expect(timeResult.isError, JSON.stringify(timeResult)).not.toBe(true)
    expect(timeResult.structuredContent).toEqual(
      await directApi(tokens.member, '/time-entries'),
    )
    const memberEntry = (
      timeResult.structuredContent as { data: Array<Record<string, unknown>> }
    ).data[0]!
    expect(memberEntry).not.toHaveProperty('billable_rate_cents')
    expect(memberEntry).not.toHaveProperty('cost_rate_cents')

    const projectResult = await harness.client.callTool({
      name: 'list_projects',
      arguments: { per_page: 200 },
    })
    expect(projectResult.structuredContent).toEqual(
      await directApi(tokens.member, '/projects?per_page=200'),
    )
    const memberProject = (
      projectResult.structuredContent as { data: Array<Record<string, unknown>> }
    ).data[0]!
    expect(memberProject).not.toHaveProperty('hourly_rate_cents')
    expect(memberProject).not.toHaveProperty('cost_budget_cents')
    expect(memberProject).not.toHaveProperty('notes')

    await harness.close()
    harness = await protocolHarness(tokens.administrator)
    const administratorResult = await harness.client.callTool({
      name: 'list_time_entries',
      arguments: {},
    })
    expect(administratorResult.structuredContent).toEqual(
      await directApi(tokens.administrator, '/time-entries'),
    )
    expect(
      (
        administratorResult.structuredContent as {
          data: Array<Record<string, unknown>>
        }
      ).data[0],
    ).toMatchObject({ billable_rate_cents: 20_000, cost_rate_cents: 7_500 })
    const administratorProjects = await harness.client.callTool({
      name: 'list_projects',
      arguments: { per_page: 200 },
    })
    expect(
      (
        administratorProjects.structuredContent as {
          data: Array<Record<string, unknown>>
        }
      ).data[0],
    ).toMatchObject({
      hourly_rate_cents: 20_000,
      cost_budget_cents: 50_000,
      notes: 'administrator-only project note',
    })
  })

  it('[security] preserves report redaction for member, accounting, and administrator tokens', async () => {
    for (const [token, expectedFields] of [
      [tokens.member, []],
      [tokens.accounting, ['budget_cents']],
      [tokens.administrator, ['budget_cents', 'spent_cents', 'remaining_cents']],
    ] as const) {
      harness = await protocolHarness(token)
      const result = await harness.client.callTool({
        name: 'get_project_budget',
        arguments: {
          project: 'NORTHPEAK',
          from: '2026-08-01',
          to: '2026-08-31',
        },
      })
      expect(result.isError, token).not.toBe(true)
      expect(result.structuredContent).toEqual(
        await directApi(
          token,
          '/reports/project-budget/20?from=2026-08-01&to=2026-08-31',
        ),
      )
      const grain = (
        result.structuredContent as {
          data: { grains: Array<Record<string, unknown>> }
        }
      ).data.grains[0]!
      expect(
        ['budget_cents', 'spent_cents', 'remaining_cents'].filter((field) =>
          Object.hasOwn(grain, field),
        ),
      ).toEqual(expectedFields)
      await harness.close()
      harness = undefined
    }
  })

  it('[mcp] lists portfolio project budgets over the full range by default', async () => {
    harness = await protocolHarness(tokens.administrator)
    const result = await harness.client.callTool({
      name: 'list_project_budgets',
      arguments: {},
    })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(lastProjectBudgetRange).toEqual({
      from: DEFAULT_REPORT_FROM,
      to: DEFAULT_REPORT_TO,
    })
    expect(result.structuredContent).toEqual(
      await directApi(
        tokens.administrator,
        `/reports/project-budgets?from=${DEFAULT_REPORT_FROM}&to=${DEFAULT_REPORT_TO}`,
      ),
    )
    expect(
      (result.structuredContent as { data: Array<Record<string, unknown>> })
        .data[0],
    ).toMatchObject({
      project_id: 20,
      budget_cents: 50_000,
      spent_cents: 7_500,
      remaining_cents: 42_500,
      cost_cents: 7_500,
    })
  })

  it('[security] withholds cost-derived budget money from non-administrators', async () => {
    for (const [token, expectedFields] of [
      [tokens.member, []],
      [tokens.accounting, ['budget_cents']],
      [
        tokens.administrator,
        ['budget_cents', 'spent_cents', 'remaining_cents', 'cost_cents'],
      ],
    ] as const) {
      harness = await protocolHarness(token)
      const result = await harness.client.callTool({
        name: 'list_project_budgets',
        arguments: { from: '2026-08-01', to: '2026-08-31' },
      })
      expect(result.isError, token).not.toBe(true)
      expect(result.structuredContent).toEqual(
        await directApi(
          token,
          '/reports/project-budgets?from=2026-08-01&to=2026-08-31',
        ),
      )
      const summary = (
        result.structuredContent as { data: Array<Record<string, unknown>> }
      ).data[0]!
      expect(
        [
          'budget_cents',
          'spent_cents',
          'remaining_cents',
          'cost_cents',
        ].filter((field) => Object.hasOwn(summary, field)),
      ).toEqual(expectedFields)
      await harness.close()
      harness = undefined
    }
  })

  it('[mcp] resolves a normalized client name across pages and defaults to all dates', async () => {
    harness = await protocolHarness(tokens.accounting)
    const result = await harness.client.callTool({
      name: 'get_uninvoiced',
      arguments: { client: 'northpeak' },
    })
    expect(result.isError).not.toBe(true)
    expect(lastUninvoicedFilter).toEqual({
      from: DEFAULT_REPORT_FROM,
      to: DEFAULT_REPORT_TO,
      clientId: 201,
    })
    expect(result.structuredContent).toMatchObject({
      data: { client_id: 201, totals: [{ total_cents: 22_500 }] },
    })
  })

  it('[security] returns machine-readable scope errors without leaking the token', async () => {
    harness = await protocolHarness(tokens.projectsOnly)
    const result = await harness.client.callTool({
      name: 'get_uninvoiced',
      arguments: { client: '7' },
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      error: {
        kind: 'ezacto_api_error',
        status: 403,
        body: { error: { code: 'insufficient_scope' } },
      },
    })
    expect(JSON.stringify(result)).not.toContain(tokens.projectsOnly)
  })

  it('[mcp] rejects unknown, ambiguous, and invalid inputs before making a report request', async () => {
    harness = await protocolHarness(tokens.accounting)
    const missing = await harness.client.callTool({
      name: 'get_project_budget',
      arguments: { project: 'does-not-exist' },
    })
    expect(missing.isError).toBe(true)
    expect(missing.structuredContent).toEqual({
      error: {
        kind: 'invalid_selection',
        message: 'project not found: does-not-exist',
      },
    })

    const invalid = await harness.client.callTool({
      name: 'list_projects',
      arguments: { per_page: 201 },
    })
    expect(invalid.isError).toBe(true)
    expect(invalid.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringMatching(/Invalid arguments|invalid/i),
      }),
    ])

    const invalidDate = await harness.client.callTool({
      name: 'list_time_entries',
      arguments: { spent_date: '0099-12-31' },
    })
    expect(invalidDate.isError).toBe(true)

    await harness.close()
    const duplicateClient = new EzactoClient({
      baseUrl: 'https://api.test',
      token: tokens.accounting,
      fetch: async () =>
        Response.json({
          data: [
            { id: 20, name: 'North Peak', code: 'NP-1' },
            { id: 21, name: 'North-Peak', code: 'NP-2' },
          ],
          links: { self: '/api/v1/projects', next: null },
          page: { per_page: 200, next_cursor: null },
        }),
    })
    harness = await protocolHarness(tokens.accounting, duplicateClient)
    const ambiguous = await harness.client.callTool({
      name: 'get_project_budget',
      arguments: { project: 'northpeak' },
    })
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.structuredContent).toEqual({
      error: {
        kind: 'invalid_selection',
        message:
          'project is ambiguous: northpeak (North Peak (#20), North-Peak (#21))',
      },
    })
  })

  it('[security] bounds advancing lookup cursors at an exact request ceiling', async () => {
    let requests = 0
    const advancingClient = new EzactoClient({
      baseUrl: 'https://api.test',
      token: tokens.accounting,
      fetch: async () => {
        requests += 1
        return Response.json({
          data: [],
          links: { self: '/api/v1/clients', next: null },
          page: { per_page: 200, next_cursor: `cursor-${requests}` },
        })
      },
    })
    harness = await protocolHarness(tokens.accounting, advancingClient)
    const result = await harness.client.callTool({
      name: 'get_client_rollup',
      arguments: { client: 'never-found' },
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({
      error: {
        kind: 'request_failed',
        message: 'The ezacto request could not be completed.',
      },
    })
    expect(requests).toBe(MAX_RESOURCE_LOOKUP_PAGES)
  })
})
