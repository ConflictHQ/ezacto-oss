import { createApiTokenStore, createD1Database } from '@ezacto/db/d1'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Does user segmentation actually keep cost and billable money away from the
 * profiles that must not see it?
 *
 * `canViewMoneyField` states the rule and `packages/core/test/money-permissions
 * .test.ts` unit-tests the rule. Neither proves the rule is WIRED: #375 shipped
 * five routes that no entry mounted, and #383 let an identical cost base
 * through a sibling payload shape that a hand-kept register had missed. A unit
 * test of the predicate catches neither, because neither is about the
 * predicate.
 *
 * So this suite makes no call to the predicate. It bundles the real Worker
 * entry, runs it on a real D1 in Miniflare, authenticates a real stored API
 * token per profile, and reads the bytes each profile actually receives. Every
 * expectation below is a hand-written literal list of profiles; nothing here is
 * computed from the code under test, so removing the gate cannot also move the
 * goalposts.
 *
 * Read a failure as: PROFILE | SURFACE | FIELD | what went wrong.
 *
 * STATE OF THE PROOF, as committed: 25 of 27 tests pass. The two that fail are
 * `[money] GET /api/v1/clients/1` and `[money] GET /api/v1/clients (list)`, and
 * they fail because they found something — see the FINDING block on the clients
 * probes below. They are left failing on purpose.
 *
 * To confirm the suite discriminates rather than decorates, make
 * `canViewMoneyField` return `true` unconditionally for `cost_rate` and run it
 * again: 14 of 27 tests go red with 112 named leak lines on top of the 8 the
 * finding already produces, 52 of them from the wire sweep.
 */

const timestamp = '2026-08-28T08:00:00.000Z'
const cursorSecret = 'A'.repeat(43)
const range = 'from=2026-08-01&to=2026-08-31'

/* ------------------------------------------------------------------ *
 * The profiles under test. `project_manager` appears twice on purpose:
 * the billable_rates_manager grant is the only thing that separates the
 * two rows, and a suite that tested one of them would prove nothing
 * about the grant.
 * ------------------------------------------------------------------ */

type ViewerKey =
  | 'member'
  | 'project_manager'
  | 'project_manager+billable_rates_manager'
  | 'people_admin'
  | 'accounting'
  | 'executive_manager'
  | 'administrator'

interface Viewer {
  key: ViewerKey
  userId: number
  profile: string
  grants: readonly string[]
  /**
   * The widest scope set this profile is permitted to hold, transcribed from
   * `apiScopeProfiles` in packages/core/src/api-authorization.ts. Transcribed
   * rather than imported so the token authority is stated evidence: this is the
   * most authority the profile can obtain, and the isolation claim is made
   * against that ceiling, not against a conveniently narrow token. The
   * [drift] test below fails loudly if a transcription stops matching.
   */
  scopes: readonly string[]
}

const everyProfileScopes = [
  'time_entries:read',
  'time_entries:write',
  'projects:read',
  'clients:read',
  'expenses:read',
  'expenses:write',
  'schedule:read',
] as const

const viewers: readonly Viewer[] = [
  {
    key: 'member',
    userId: 2,
    profile: 'member',
    grants: [],
    scopes: [...everyProfileScopes],
  },
  {
    key: 'project_manager',
    userId: 3,
    profile: 'project_manager',
    grants: [],
    scopes: [
      ...everyProfileScopes,
      'projects:write',
      'clients:write',
      'team:read',
      'schedule:write',
    ],
  },
  {
    key: 'project_manager+billable_rates_manager',
    userId: 4,
    profile: 'project_manager',
    grants: ['billable_rates_manager'],
    scopes: [
      ...everyProfileScopes,
      'projects:write',
      'clients:write',
      'team:read',
      'schedule:write',
    ],
  },
  {
    key: 'people_admin',
    userId: 5,
    profile: 'people_admin',
    grants: [],
    scopes: [...everyProfileScopes, 'team:read'],
  },
  {
    key: 'accounting',
    userId: 6,
    profile: 'accounting',
    grants: [],
    scopes: [
      ...everyProfileScopes,
      'clients:write',
      'invoices:read',
      'invoices:write',
      'reports:read',
    ],
  },
  {
    key: 'executive_manager',
    userId: 7,
    profile: 'executive_manager',
    grants: [],
    scopes: [
      ...everyProfileScopes,
      'projects:write',
      'clients:write',
      'invoices:read',
      'invoices:write',
      'team:read',
      'schedule:write',
      'reports:read',
    ],
  },
  {
    key: 'administrator',
    userId: 1,
    profile: 'administrator',
    grants: [],
    scopes: [
      ...everyProfileScopes,
      'projects:write',
      'clients:write',
      'invoices:read',
      'invoices:write',
      'team:read',
      'schedule:write',
      'reports:read',
    ],
  },
]

const everyViewer = viewers.map((viewer) => viewer.key)

/* ------------------------------------------------------------------ *
 * The rules, written out as literal profile lists.
 * ------------------------------------------------------------------ */

/** `cost_rate` — administrator only. */
const COST: readonly ViewerKey[] = ['administrator']

/** `money_budget` — the accounting/executive/administrator set. */
const BUDGET: readonly ViewerKey[] = [
  'accounting',
  'executive_manager',
  'administrator',
]

/** `billable_rate` — the same set, plus a project manager holding the grant. */
const BILLABLE: readonly ViewerKey[] = [
  'project_manager+billable_rates_manager',
  'accounting',
  'executive_manager',
  'administrator',
]

/**
 * Two money fields on the general-resource surfaces are gated by predicates
 * that live in packages/api/src/general-resources.ts rather than by
 * `canViewMoneyField`. They are transcribed here as they ship, so the suite
 * describes the deployed behaviour rather than the behaviour someone assumed.
 * The divergence itself is reported to the owner, not silently normalised.
 */
const PROJECT_BILLABLE: readonly ViewerKey[] = [
  'project_manager+billable_rates_manager',
  'executive_manager',
  'administrator',
]
const PROJECT_COST_BUDGET: readonly ViewerKey[] = [
  'executive_manager',
  'administrator',
]

/** Project notes are administrator-only, and sit beside the money fields. */
const ADMIN_ONLY: readonly ViewerKey[] = ['administrator']

/**
 * Key names that are derived from a payroll cost rate. No profile but the
 * administrator may see any of them, on any surface, ever. Quoted so that
 * `"total_cost_cents"` — an expense amount, not a cost rate — cannot match.
 */
const COST_DERIVED_KEYS = [
  '"cost_rate_cents"',
  '"cost_rates"',
  '"cost_cents"',
  '"budget_burn_cents"',
] as const

/* ------------------------------------------------------------------ *
 * Probes. Each names one endpoint, one JSON node inside its body, the
 * money fields on that node with the profiles entitled to each, and the
 * non-money fields every entitled profile must still receive.
 * ------------------------------------------------------------------ */

interface Probe {
  /** Appears verbatim in failure output. */
  surface: string
  path: string | ((viewer: Viewer) => string)
  method?: 'GET' | 'POST'
  body?: (viewer: Viewer) => unknown
  /** Profiles whose scope ceiling lets them reach the route at all. */
  reachableBy: readonly ViewerKey[]
  /** Status a reachable profile must get. */
  okStatus?: number
  /** Dotted path to the node the field rules apply to. */
  node: string
  /** field name -> the exact profiles entitled to see it. */
  money: Readonly<Record<string, readonly ViewerKey[]>>
  /**
   * Fields every reachable profile must still receive. Without these an
   * endpoint that returned nothing at all, or redacted everything, would
   * satisfy every absence assertion above and prove nothing.
   */
  entitled: Readonly<Record<string, unknown>>
}

const probes: readonly Probe[] = [
  {
    surface: 'GET /api/v1/time-entries',
    path: '/api/v1/time-entries?per_page=50',
    reachableBy: everyViewer,
    node: 'data.0',
    money: {
      billable_rate_cents: BILLABLE,
      cost_rate_cents: COST,
    },
    entitled: { rounded_seconds: 3600, seconds: 3600 },
  },
  {
    surface: 'GET /api/v1/time-entries/{own id}',
    path: (viewer) => `/api/v1/time-entries/${100 + viewer.userId}`,
    reachableBy: everyViewer,
    node: 'data',
    money: {
      billable_rate_cents: BILLABLE,
      cost_rate_cents: COST,
    },
    entitled: { rounded_seconds: 3600 },
  },
  {
    // A create response is a second serialisation of the same record. #383 was
    // exactly this: the register covered one payload shape and not its sibling.
    surface: 'POST /api/v1/time-entries (create response)',
    path: '/api/v1/time-entries',
    method: 'POST',
    okStatus: 201,
    body: () => ({
      project_id: 1,
      task_id: 1,
      // Deliberately outside the report range below, so that one profile's
       // create cannot move another profile's report totals.
      spent_date: '2026-09-05',
      seconds: 1800,
    }),
    reachableBy: everyViewer,
    node: 'data',
    money: {
      billable_rate_cents: BILLABLE,
      cost_rate_cents: COST,
    },
    entitled: { seconds: 1800, spent_date: '2026-09-05' },
  },
  {
    surface: 'GET /api/v1/projects/1',
    path: '/api/v1/projects/1',
    reachableBy: everyViewer,
    node: 'data',
    money: {
      hourly_rate_cents: PROJECT_BILLABLE,
      fee_cents: PROJECT_BILLABLE,
      cost_budget_cents: PROJECT_COST_BUDGET,
      notes: ADMIN_ONLY,
    },
    entitled: { name: 'Cost Budgeted', budget_by: 'project_cost' },
  },
  {
    surface: 'GET /api/v1/projects (list)',
    path: '/api/v1/projects?per_page=50',
    reachableBy: everyViewer,
    node: 'data.0',
    money: {
      hourly_rate_cents: PROJECT_BILLABLE,
      fee_cents: PROJECT_BILLABLE,
      cost_budget_cents: PROJECT_COST_BUDGET,
      notes: ADMIN_ONLY,
    },
    entitled: { name: 'Cost Budgeted' },
  },
  {
    surface: 'GET /api/v1/tasks',
    path: '/api/v1/tasks?per_page=50',
    reachableBy: everyViewer,
    node: 'data.0',
    money: { default_hourly_rate_cents: BILLABLE },
    entitled: { name: 'Delivery' },
  },
  {
    surface: 'GET /api/v1/task-assignments',
    path: '/api/v1/task-assignments?per_page=50',
    reachableBy: everyViewer,
    node: 'data.0',
    money: {
      hourly_rate_cents: PROJECT_BILLABLE,
      budget_cents: PROJECT_COST_BUDGET,
    },
    entitled: { project_id: 1, task_id: 1 },
  },
  {
    surface: 'GET /api/v1/user-assignments',
    path: '/api/v1/user-assignments?per_page=50',
    reachableBy: [
      'project_manager',
      'project_manager+billable_rates_manager',
      'people_admin',
      'executive_manager',
      'administrator',
    ],
    node: 'data.0',
    money: { hourly_rate_cents: BILLABLE },
    entitled: { project_id: 1, user_id: 1 },
  },
  {
    // ------------------------------------------------------------------
    // FINDING (open, deliberately left failing).
    //
    // `clients.budget_cents` is the SAME client money budget that
    // serializeClientRollup redacts as `node_budget_cents` behind
    // `canViewMoneyField(viewer, 'money_budget')` — db/src/reports.ts reads
    // the identical column into ClientRollupNode.nodeBudgetCents. The rollup
    // hides it from member, project_manager and people_admin; GET /clients
    // and GET /clients/{id} hand it to all three, because
    // `hiddenGeneralField` in packages/api/src/general-resources.ts has no
    // clients branch at all.
    //
    // This is #383's shape exactly: the same money base reachable through a
    // sibling payload the register never covered. The two probes below assert
    // the rule rather than the behaviour, so they FAIL until the owner
    // decides. Do not relax them to make the suite green — a proof that
    // accommodates the leak is worth less than no proof.
    //
    // The gate, if the owner wants it, is one clause in hiddenGeneralField:
    //   if (kind === 'clients' && field === 'budgetCents')
    //     return !canViewMoneyField(viewer, 'money_budget')
    // and a matching clause in authorizeMutationFields, since clients:write
    // reaches project_manager. It also needs the Client contract schema to
    // stop requiring budget_cents.
    // ------------------------------------------------------------------
    surface: 'GET /api/v1/clients/1',
    path: '/api/v1/clients/1',
    reachableBy: everyViewer,
    node: 'data',
    money: { budget_cents: BUDGET },
    entitled: { name: 'Northwind', currency: 'USD' },
  },
  {
    surface: 'GET /api/v1/clients (list)',
    path: '/api/v1/clients?per_page=50',
    reachableBy: everyViewer,
    node: 'data.0',
    money: { budget_cents: BUDGET },
    entitled: { name: 'Northwind' },
  },
  {
    surface: 'GET /api/v1/team/people/2',
    path: '/api/v1/team/people/2',
    reachableBy: [
      'project_manager',
      'project_manager+billable_rates_manager',
      'people_admin',
      'executive_manager',
      'administrator',
    ],
    node: 'data',
    money: { cost_rates: COST, billable_rates: BILLABLE },
    entitled: { first_name: 'Mel', profile: 'member' },
  },
  {
    surface: 'GET /api/v1/team/people/2 -> project_assignments[0]',
    path: '/api/v1/team/people/2',
    reachableBy: [
      'project_manager',
      'project_manager+billable_rates_manager',
      'people_admin',
      'executive_manager',
      'administrator',
    ],
    node: 'data.project_assignments.0',
    money: { hourly_rate_cents: BILLABLE },
    entitled: { project_id: 1, is_active: true },
  },
  {
    surface: 'GET /api/v1/users/2/cost-rates',
    path: '/api/v1/users/2/cost-rates',
    reachableBy: COST,
    node: 'data.0',
    money: {},
    entitled: { amount_cents: 4200, user_id: 2 },
  },
  {
    surface: 'GET /api/v1/users/2/billable-rates',
    path: '/api/v1/users/2/billable-rates',
    reachableBy: BILLABLE,
    node: 'data.0',
    money: {},
    entitled: { amount_cents: 19_200, user_id: 2 },
  },
  {
    surface: 'GET /api/v1/reports/project-budgets -> project 1 (cost budget)',
    path: `/api/v1/reports/project-budgets?${range}`,
    reachableBy: everyViewer,
    node: 'project:1',
    money: {
      budget_cents: BUDGET,
      spent_cents: COST,
      remaining_cents: COST,
      cost_cents: COST,
    },
    entitled: { budget_by: 'project_cost', unit: 'cents', currency: 'USD' },
  },
  {
    surface: 'GET /api/v1/reports/project-budgets -> project 2 (task fees)',
    path: `/api/v1/reports/project-budgets?${range}`,
    reachableBy: everyViewer,
    node: 'project:2',
    money: {
      budget_cents: BUDGET,
      spent_cents: BILLABLE,
      // budget AND spent, so the intersection and nothing wider.
      remaining_cents: BUDGET,
      cost_cents: COST,
    },
    entitled: { budget_by: 'task_fees', unit: 'cents' },
  },
  {
    surface: 'GET /api/v1/reports/project-budgets -> project 3 (time budget)',
    path: `/api/v1/reports/project-budgets?${range}`,
    reachableBy: everyViewer,
    node: 'project:3',
    money: { cost_cents: COST },
    entitled: {
      budget_by: 'project',
      unit: 'seconds',
      budget_seconds: 36000,
      spent_seconds: 0,
    },
  },
  {
    surface: 'GET /api/v1/reports/project-budget/1 -> grains[0] (cost)',
    path: `/api/v1/reports/project-budget/1?${range}`,
    reachableBy: everyViewer,
    node: 'data.grains.0',
    money: {
      budget_cents: BUDGET,
      spent_cents: COST,
      remaining_cents: COST,
    },
    entitled: { source: 'project', calculation: 'cost', unit: 'cents' },
  },
  {
    surface: 'GET /api/v1/reports/project-budget/2 -> grains[0] (task fees)',
    path: `/api/v1/reports/project-budget/2?${range}`,
    reachableBy: everyViewer,
    node: 'data.grains.0',
    money: {
      budget_cents: BUDGET,
      spent_cents: BILLABLE,
      remaining_cents: BUDGET,
    },
    entitled: {
      source: 'task_assignment',
      calculation: 'billable',
      unit: 'cents',
    },
  },
  {
    surface: 'GET /api/v1/reports/client-rollups/1 -> nodes[0]',
    path: `/api/v1/reports/client-rollups/1?${range}`,
    reachableBy: BUDGET,
    node: 'data.nodes.0',
    money: { node_budget_cents: BUDGET, budget_burn_cents: COST },
    entitled: { client_id: 1, name: 'Northwind', depth: 0 },
  },
  {
    surface:
      'GET /api/v1/reports/client-rollups/1 -> nodes[0].direct.currencies[0]',
    path: `/api/v1/reports/client-rollups/1?${range}`,
    reachableBy: BUDGET,
    node: 'data.nodes.0.direct.currencies.0',
    money: {
      uninvoiced_time_cents: BILLABLE,
      uninvoiced_expense_cents: BILLABLE,
      uninvoiced_total_cents: BILLABLE,
      money_budget_cents: BUDGET,
      cost_cents: COST,
    },
    entitled: { currency: 'USD' },
  },
  {
    surface: 'GET /api/v1/reports/uninvoiced -> totals[0]',
    path: `/api/v1/reports/uninvoiced?${range}`,
    reachableBy: BUDGET,
    node: 'data.totals.0',
    money: {
      time_cents: BILLABLE,
      expense_cents: BILLABLE,
      total_cents: BILLABLE,
    },
    entitled: { currency: 'USD', rounded_seconds: 25_200 },
  },
  {
    // The billable side of the owner's question. There is no per-field gate
    // here: the whole invoice surface is walled off by the invoices:read
    // scope, which only the money profiles may hold. Probing it proves the
    // wall stands rather than assuming it.
    surface: 'GET /api/v1/invoices',
    path: '/api/v1/invoices?per_page=50',
    reachableBy: BUDGET,
    node: 'data.0',
    money: {},
    entitled: { number: 'NW-001', currency: 'USD' },
  },
]

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

let miniflare: Miniflare
let database: D1Database
const tokens = new Map<ViewerKey, string>()

interface Capture {
  status: number
  text: string
  json: unknown
}

/** viewer -> surface -> the exact bytes that viewer received. */
const captures = new Map<ViewerKey, Map<string, Capture>>()

const request = (path: string, init?: RequestInit): Promise<Response> =>
  miniflare.dispatchFetch(
    new URL(path, 'https://worker.test').toString(),
    init as never,
  ) as unknown as Promise<Response>

const run = async (statement: string, ...bindings: unknown[]): Promise<void> => {
  await database
    .prepare(statement)
    .bind(...bindings)
    .run()
}

const pathOf = (probe: Probe, viewer: Viewer): string =>
  typeof probe.path === 'string' ? probe.path : probe.path(viewer)

const resolveNode = (body: unknown, node: string): unknown => {
  // `project:N` selects the project-budget summary for project N, because a
  // whole-body search would confuse one project's spent_cents with another's.
  if (node.startsWith('project:')) {
    const projectId = Number(node.slice('project:'.length))
    const data = (body as { data?: unknown[] })?.data
    if (!Array.isArray(data)) return undefined
    return data.find(
      (row) => (row as { project_id?: number })?.project_id === projectId,
    )
  }
  let current: unknown = body
  for (const segment of node.split('.')) {
    if (current === null || current === undefined) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

beforeAll(async () => {
  const bundled = await build({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    bundle: true,
    conditions: ['development'],
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  })
  miniflare = new Miniflare({
    bindings: {
      API_CURSOR_SIGNING_KEY: cursorSecret,
      ENVIRONMENT: 'test',
      RELEASE: 'money-isolation-test',
    },
    compatibilityDate: '2026-08-06',
    d1Databases: ['DB'],
    r2Buckets: ['ATTACHMENTS'],
    modules: true,
    script: bundled.outputFiles[0]!.text,
  })

  // The Worker migrates on its own first DB-backed request, exactly as a real
  // deployment does. Nothing here installs schema by hand.
  await request('/api/v1/time-entries')
  database = await miniflare.getD1Database('DB')

  await run(
    `INSERT INTO organizations (
      id, name, time_entry_mode, time_rounding, modules, created_at, updated_at
    ) VALUES (1, 'Isolation Org', 'duration', 'none', ?, ?, ?)`,
    JSON.stringify({
      team: true,
      expenses: true,
      invoices: true,
      approval: false,
    }),
    timestamp,
    timestamp,
  )

  // Ascending user id, so the administrator lands first and the schema's own
  // trigger makes them the organization owner.
  const seedOrder = [...viewers].sort((left, right) => left.userId - right.userId)
  for (const viewer of seedOrder) {
    await run(
      `INSERT INTO users (
        id, first_name, last_name, profile, manager_grants,
        has_access_to_all_future_projects, created_at, updated_at
      ) VALUES (?, ?, 'Tester', ?, ?, 1, ?, ?)`,
      viewer.userId,
      viewer.userId === 2 ? 'Mel' : viewer.key.replace(/\W/g, '_'),
      viewer.profile,
      JSON.stringify(viewer.grants),
      timestamp,
      timestamp,
    )
    await run(
      `INSERT INTO user_emails (
        user_id, address, verified_at, is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)`,
      viewer.userId,
      `${viewer.userId}@isolation.test`,
      timestamp,
      timestamp,
      timestamp,
    )
    // Rates exist for every person so that the "entitled profiles still get the
    // number" half of each assertion is testing a real number, not a null.
    await run(
      `INSERT INTO user_cost_rates (user_id, amount_cents, start_date, created_at, updated_at)
       VALUES (?, ?, '2026-01-01', ?, ?)`,
      viewer.userId,
      4000 + viewer.userId * 100,
      timestamp,
      timestamp,
    )
    await run(
      `INSERT INTO user_billable_rates (user_id, amount_cents, start_date, created_at, updated_at)
       VALUES (?, ?, '2026-01-01', ?, ?)`,
      viewer.userId,
      19_000 + viewer.userId * 100,
      timestamp,
      timestamp,
    )
  }

  await run(
    `INSERT INTO clients (id, name, currency, budget_cents, created_at, updated_at)
     VALUES (1, 'Northwind', 'USD', 5000000, ?, ?)`,
    timestamp,
    timestamp,
  )
  await run(
    `INSERT INTO projects (
      id, client_id, name, code, hourly_rate_cents, fee_cents, budget_by,
      budget_seconds, cost_budget_cents, report_visibility, notes,
      created_at, updated_at
    ) VALUES
      (1, 1, 'Cost Budgeted', 'COST', 20000, 750000, 'project_cost',
        NULL, 1000000, 'everyone', 'Confidential margin note', ?, ?),
      (2, 1, 'Fee Budgeted', 'FEES', 20000, 750000, 'task_fees',
        NULL, 1000000, 'everyone', 'Confidential margin note', ?, ?),
      (3, 1, 'Time Budgeted', 'TIME', 20000, 750000, 'project',
        36000, 1000000, 'everyone', 'Confidential margin note', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await run(
    `INSERT INTO tasks (id, name, default_hourly_rate_cents, created_at, updated_at)
     VALUES (1, 'Delivery', 21000, ?, ?)`,
    timestamp,
    timestamp,
  )
  for (const project of [1, 2, 3]) {
    await run(
      `INSERT INTO task_assignments (
        id, project_id, task_id, billable, hourly_rate_cents, budget_cents,
        created_at, updated_at
      ) VALUES (?, ?, 1, 1, 22000, 800000, ?, ?)`,
      project,
      project,
      timestamp,
      timestamp,
    )
    for (const viewer of viewers) {
      await run(
        `INSERT INTO user_assignments (
          id, project_id, user_id, is_project_manager, hourly_rate_cents,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 23000, ?, ?)`,
        project * 100 + viewer.userId,
        project,
        viewer.userId,
        viewer.profile === 'project_manager' ? 1 : 0,
        timestamp,
        timestamp,
      )
    }
  }

  // One budgeted, priced entry per person on the cost-budgeted project, so
  // every profile has its own row to read back and every cost aggregate is a
  // real number.
  for (const viewer of viewers) {
    await run(
      `INSERT INTO time_entries (
        id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
        spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
        billable_rate_cents, cost_rate_cents, budgeted, created_at, updated_at
      ) VALUES (?, ?, 1, 1, ?, 1, '2026-08-10', 3600, 3600, 3600, 1, ?, ?, 1, ?, ?)`,
      100 + viewer.userId,
      viewer.userId,
      100 + viewer.userId,
      19_000 + viewer.userId * 100,
      4000 + viewer.userId * 100,
      timestamp,
      timestamp,
    )
  }
  await run(
    `INSERT INTO expense_categories (id, name, created_at, updated_at)
     VALUES (1, 'Travel', ?, ?)`,
    timestamp,
    timestamp,
  )
  await run(
    `INSERT INTO expenses (
      id, user_id, project_id, expense_category_id, spent_date,
      total_cost_cents, created_at, updated_at
    ) VALUES (1, 1, 1, 1, '2026-08-10', 12345, ?, ?)`,
    timestamp,
    timestamp,
  )

  await run(
    `INSERT INTO invoices (
      id, client_id, created_by_user_id, number, currency, issue_date,
      due_date, created_at, updated_at
    ) VALUES (1, 1, 1, 'NW-001', 'USD', '2026-08-15', '2026-09-14', ?, ?)`,
    timestamp,
    timestamp,
  )

  const store = createApiTokenStore(createD1Database(database), {
    now: () => timestamp,
  })
  for (const viewer of viewers) {
    const issued = await store.issue({
      userId: viewer.userId,
      name: `money isolation ${viewer.key}`,
      scopes: [...viewer.scopes],
    })
    tokens.set(viewer.key, issued.token)
  }

  // Drive every probe once per profile and keep the bytes. Each assertion below
  // reads from this table, so one HTTP pass backs the whole matrix and the
  // evidence is the same bytes in every test.
  for (const viewer of viewers) {
    const perSurface = new Map<string, Capture>()
    for (const probe of probes) {
      if (perSurface.has(probe.surface)) continue
      const authorization = `Bearer ${tokens.get(viewer.key)!}`
      const response = await request(pathOf(probe, viewer), {
        method: probe.method ?? 'GET',
        headers:
          probe.method === 'POST'
            ? {
                authorization,
                'content-type': 'application/json',
                'idempotency-key': `money-isolation-${viewer.userId}`,
              }
            : { authorization },
        ...(probe.body === undefined
          ? {}
          : { body: JSON.stringify(probe.body(viewer)) }),
      })
      const text = await response.text()
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
      perSurface.set(probe.surface, { status: response.status, text, json })
    }
    captures.set(viewer.key, perSurface)
  }
}, 60_000)

afterAll(async () => miniflare.dispose())

/* ------------------------------------------------------------------ *
 * The proof
 * ------------------------------------------------------------------ */

describe('Money isolation across the deployed API', () => {
  it('[drift] issues each profile the widest token it may hold, and the app agrees', async () => {
    const mismatches: string[] = []
    for (const viewer of viewers) {
      const response = await request('/api/v1/whoami', {
        headers: { authorization: `Bearer ${tokens.get(viewer.key)!}` },
      })
      const body = (await response.json()) as {
        data?: {
          profile?: string
          manager_grants?: string[]
          authentication?: { scopes?: string[] }
        }
      }
      if (response.status !== 200) {
        mismatches.push(
          `${viewer.key} | /whoami rejected the token with ${response.status} — the transcribed scope ceiling no longer matches apiScopeProfiles`,
        )
        continue
      }
      if (body.data?.profile !== viewer.profile) {
        mismatches.push(
          `${viewer.key} | expected profile ${viewer.profile}, app said ${String(body.data?.profile)}`,
        )
      }
      const granted = [...(body.data?.authentication?.scopes ?? [])].sort()
      const expected = [...viewer.scopes].sort()
      if (granted.join(',') !== expected.join(',')) {
        mismatches.push(
          `${viewer.key} | scopes: expected [${expected.join(' ')}], got [${granted.join(' ')}]`,
        )
      }
      const grants = [...(body.data?.manager_grants ?? [])].sort()
      if (grants.join(',') !== [...viewer.grants].sort().join(',')) {
        mismatches.push(
          `${viewer.key} | grants: expected [${viewer.grants.join(' ')}], got [${grants.join(' ')}]`,
        )
      }
    }
    expect(mismatches).toEqual([])
  })

  it('[reachability] every probed surface answers the profiles that may reach it', () => {
    const failures: string[] = []
    for (const probe of probes) {
      for (const viewer of viewers) {
        const capture = captures.get(viewer.key)!.get(probe.surface)!
        const mayReach = probe.reachableBy.includes(viewer.key)
        const expectedStatus = mayReach ? (probe.okStatus ?? 200) : 403
        if (capture.status !== expectedStatus) {
          failures.push(
            `${viewer.key} | ${probe.surface} | expected HTTP ${expectedStatus}` +
              `${mayReach ? '' : ' (refused)'}, got ${capture.status} — ${capture.text.slice(0, 160)}`,
          )
        }
      }
    }
    expect(failures).toEqual([])
  })

  for (const probe of probes) {
    it(`[money] ${probe.surface}`, () => {
      const failures: string[] = []
      for (const viewer of viewers) {
        const capture = captures.get(viewer.key)!.get(probe.surface)!
        if (!probe.reachableBy.includes(viewer.key)) {
          // A refusal is the isolation guarantee for this profile, so the
          // refusal body must not carry the numbers either.
          for (const field of Object.keys(probe.money)) {
            if (capture.text.includes(`"${field}"`)) {
              failures.push(
                `${viewer.key} | ${probe.surface} | ${field} | LEAK: appeared in the ${capture.status} refusal body`,
              )
            }
          }
          continue
        }
        const node = resolveNode(capture.json, probe.node)
        if (node === null || typeof node !== 'object') {
          failures.push(
            `${viewer.key} | ${probe.surface} | node "${probe.node}" | missing from the response — ` +
              `an empty payload cannot stand in for a redaction: ${capture.text.slice(0, 200)}`,
          )
          continue
        }
        const row = node as Record<string, unknown>

        // Direction one: the profile still receives what it is entitled to.
        for (const [field, value] of Object.entries(probe.entitled)) {
          if (!Object.hasOwn(row, field)) {
            failures.push(
              `${viewer.key} | ${probe.surface} | ${field} | OVER-REDACTED: entitled field absent`,
            )
          } else if (JSON.stringify(row[field]) !== JSON.stringify(value)) {
            failures.push(
              `${viewer.key} | ${probe.surface} | ${field} | expected ${JSON.stringify(value)}, got ${JSON.stringify(row[field])}`,
            )
          }
        }

        // Direction two: money is present exactly for the listed profiles.
        for (const [field, allowed] of Object.entries(probe.money)) {
          const present = Object.hasOwn(row, field)
          if (allowed.includes(viewer.key) && !present) {
            failures.push(
              `${viewer.key} | ${probe.surface} | ${field} | OVER-REDACTED: this profile is entitled to the field and did not get it`,
            )
          }
          if (!allowed.includes(viewer.key) && present) {
            failures.push(
              `${viewer.key} | ${probe.surface} | ${field} | LEAK: value ${JSON.stringify(row[field])} reached a profile that must not see it ` +
                `(entitled: ${allowed.join(', ') || 'nobody'})`,
            )
          }
        }
      }
      expect(failures).toEqual([])
    })
  }

  it('[sweep] no cost-derived key appears in any non-administrator response body', () => {
    const leaks: string[] = []
    for (const viewer of viewers) {
      if (viewer.profile === 'administrator') continue
      for (const [surface, capture] of captures.get(viewer.key)!) {
        for (const key of COST_DERIVED_KEYS) {
          if (capture.text.includes(key)) {
            leaks.push(
              `${viewer.key} | ${surface} | ${key} | LEAK on the wire: ${capture.text.slice(0, 240)}`,
            )
          }
        }
      }
    }
    expect(leaks).toEqual([])
  })

  it('[sweep] the administrator does receive every cost-derived key somewhere', () => {
    const admin = captures.get('administrator')!
    const seen = new Set<string>()
    for (const capture of admin.values()) {
      for (const key of COST_DERIVED_KEYS) {
        if (capture.text.includes(key)) seen.add(key)
      }
    }
    // Without this, the sweep above would pass on an API that had simply
    // stopped serving cost numbers to anyone.
    expect([...COST_DERIVED_KEYS].filter((key) => !seen.has(key))).toEqual([])
  })
})
