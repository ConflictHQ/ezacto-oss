import { serve, type ServerType } from '@hono/node-server'
import {
  createApiApp,
  installReportRoutes,
  requireApiScope,
  type ApiTokenService,
  type ReportReader,
} from '@ezacto/api'
import { CLI_CONFIG_VERSION, writeConfig } from '@conflict-hq/ezacto-cli'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_REPORT_FROM, DEFAULT_REPORT_TO } from '../src/tools.js'

const token = `ezacto_abcdefghijklmnop_${'A'.repeat(43)}`
const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(packageDirectory, 'dist', 'cli.js')

let authenticated = 0
let observedRange: { from: string; to: string; clientId?: number } | undefined

const tokenService: ApiTokenService = {
  authenticate: async (presented) => {
    if (presented !== token) return null
    authenticated += 1
    return {
      tokenId: 8,
      userId: 42,
      profile: 'accounting',
      managerGrants: [],
      scopes: ['clients:read', 'reports:read'],
    }
  },
  issue: async () => {
    throw new Error('not used')
  },
  list: async () => [],
  revoke: async () => null,
}

const reports: ReportReader = {
  reportDefinitionRegistry: () => ({ fields: [], metrics: [] }),
  listSavedReports: async () => [],
  readSavedReport: async () => null,
  createSavedReport: async () => { throw new Error('not used') },
  updateSavedReport: async () => 'not_found',
  shareSavedReport: async () => false,
  pinSavedReport: async () => false,
  deleteSavedReport: async () => false,
  runSavedReport: async () => null,
  previewReport: async (definition) => ({ definitionId: definition.id, definitionVersion: definition.version, state: 'empty', rows: [] }),
  executeTimeAction: async (input) => ({
    commandId: input.commandId, action: input.action, requested: input.entryIds.length,
    changedEntryIds: [], ineligibleEntryIds: input.entryIds, replayed: false,
  }),
  invoiced: async (filter) => ({
    from: filter.from, to: filter.to, clientId: filter.clientId ?? null,
    state: filter.state ?? null, totals: [], rows: [],
  }),
  paymentsReceived: async (filter) => ({
    from: filter.from, to: filter.to, clientId: filter.clientId ?? null,
    totals: [], rows: [],
  }),
  receivables: async (filter) => ({
    asOf: filter.asOf, clientId: filter.clientId ?? null, totals: [], rows: [],
  }),
  // Not exercised here; present because ReportReader requires it.
  detailedTime: async (filter) => ({
    kind: "report" as const,
    report: {
      from: filter.from,
      to: filter.to,
      clientId: filter.clientId ?? null,
      projectId: filter.projectId ?? null,
      taskId: filter.taskId ?? null,
      userId: filter.userId ?? null,
      roleId: filter.roleId ?? null,
      tagId: filter.tagId ?? null,
      invoiceState: filter.invoiceState ?? 'all',
      hours: filter.hours ?? "all",
      grain: filter.grain ?? 'day',
      activeProjectsOnly: filter.activeProjectsOnly ?? false,
      seconds: 0,
      roundedSeconds: 0,
      billableSeconds: 0,
      uninvoicedBillableSeconds: 0,
      claimedSeconds: 0,
      unclaimedSeconds: 0,
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
    categoryId: filter.categoryId ?? null,
    userId: filter.userId ?? null,
    billable: filter.billable ?? null,
    reimbursable: filter.reimbursable ?? null,
    invoiceState: filter.invoiceState ?? 'all',
    activeProjectsOnly: filter.activeProjectsOnly ?? false,
    rows: [],
    totals: [],
  }),
  // Not exercised here; present because ReportReader requires it.
  monthEndManifest: async (input) => ({ periodStart: input.periodStart, periodEnd: input.periodEnd, items: [], excluded: [] }),
  readBandCostAlert: async () => 8000,
  setBandCostAlert: async () => {},
  bandedMonths: async (range) => ({ from: range.from, to: range.to, rows: [] }),
  profitability: async (range) => ({
    from: range.from,
    to: range.to,
    organizationCurrency: 'USD',
    rows: [],
    clients: [], teammates: [], tasks: [], trend: [],
    filters: { projectStatus: 'all', billingMethod: null, managerId: null, tagId: null },
    totals: {
      roundedSeconds: 0,
      revenueCents: 0,
      costCents: 0,
      profitCents: 0,
      returnOnCostPpm: null,
      revenueFeeCents: 0,
      feesIncludedInDeliveryCostCents: 0,
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
      returnOnCostPpm: null,
      revenueFeeCents: 0,
      feesIncludedInDeliveryCostCents: 0,
      entriesWithoutBillableRate: 0,
      entriesWithoutCostRate: 0,
      projectsNotConverted: 0,
    },
  }),
  // Not exercised here; present because ReportReader requires it.
  timeReport: async (range) => ({
    from: range.from,
    to: range.to,
    fixedFeeIncluded: range.includeFixedFee === true,
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
    observedRange = filter
    return {
      from: filter.from,
      to: filter.to,
      clientId: filter.clientId ?? null,
      projectId: filter.projectId ?? null,
      totals: [
        {
          currency: 'USD',
          roundedSeconds: 7200,
          timeEntryCount: 2,
          unpricedTimeEntryCount: 0,
          expenseCount: 0,
          timeCents: 40_000,
          expenseCents: 0,
          totalCents: 40_000,
        },
      ],
      projects: [],
    }
  },
  clientRollup: async () => null,
  projectBudgetSummaries: async () => [],
  projectBudget: async () => null,
}

describe('ezacto MCP stdio executable', () => {
  let server: ServerType
  let directory: string
  let configPath: string
  let mcpClient: Client
  let transport: StdioClientTransport
  let stderr = ''

  beforeAll(async () => {
    const app = createApiApp({
      authentication: { tokens: tokenService },
      installApi: (api) => {
        api.get('/clients', (context) => {
          requireApiScope(context, 'clients:read')
          return context.json({
            data: [
              {
                id: 7,
                name: 'North Peak',
                created_at: '2026-08-01T00:00:00.000Z',
                updated_at: '2026-08-01T00:00:00.000Z',
              },
            ],
            links: { self: '/api/v1/clients', next: null },
            page: { per_page: 200, next_cursor: null },
          })
        })
        installReportRoutes(api, reports)
      },
    })
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port))
    })
    directory = await mkdtemp(join(tmpdir(), 'ezacto-mcp-e2e-'))
    configPath = join(directory, 'config', 'config.json')
    await writeConfig(configPath, {
      version: CLI_CONFIG_VERSION,
      active_organization: 'acceptance',
      organizations: {
        acceptance: {
          base_url: `http://127.0.0.1:${port}`,
          token,
          user_id: 42,
          profile: 'accounting',
          scopes: ['clients:read', 'reports:read'],
        },
      },
    })
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, '--config', configPath],
      cwd: packageDirectory,
      stderr: 'pipe',
    })
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    mcpClient = new Client({ name: 'ezacto-stdio-test', version: '1.0.0' })
    await mcpClient.connect(transport)
  })

  afterAll(async () => {
    await mcpClient?.close()
    await transport?.close()
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error === undefined ? resolve() : reject(error)))
    })
    await rm(directory, { recursive: true, force: true })
  })

  it('[e2e:mcp] loads CLI config, authenticates the token, and answers Northpeak', async () => {
    const tools = await mcpClient.listTools()
    expect(tools.tools.map((tool) => tool.name)).toContain('get_uninvoiced')

    const result = await mcpClient.callTool({
      name: 'get_uninvoiced',
      arguments: { client: 'northpeak' },
    })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      data: {
        client_id: 7,
        totals: [{ currency: 'USD', total_cents: 40_000 }],
      },
    })
    expect(observedRange).toEqual({
      from: DEFAULT_REPORT_FROM,
      to: DEFAULT_REPORT_TO,
      clientId: 7,
    })
    expect(authenticated).toBeGreaterThanOrEqual(2)
    expect(stderr).not.toContain(token)
  })
})
