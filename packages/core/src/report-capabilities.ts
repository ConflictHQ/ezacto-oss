export const REPORT_FORMATS = ['human', 'json', 'csv'] as const

export type ReportFormat = (typeof REPORT_FORMATS)[number]

export interface ReportCapability {
  readonly id:
    | 'my-hours'
    | 'time'
    | 'invoiced'
    | 'payments-received'
    | 'receivables'
    | 'uninvoiced'
    | 'client-rollup'
    | 'project-budget'
    | 'contractor-cost'
    | 'detailed-time'
    | 'activity-log'
    | 'profitability'
    | 'detailed-expense'
  readonly route: string
  readonly requiredFilters: readonly ('from' | 'to' | 'as_of' | 'client' | 'project')[]
  readonly optionalFilters: readonly string[]
  readonly formats: readonly ReportFormat[]
  readonly scope: 'time_entries:read' | 'reports:read'
  readonly administratorOnly: boolean
}

const capability = (
  value: Omit<ReportCapability, 'formats'>,
): ReportCapability => ({ ...value, formats: REPORT_FORMATS })

/** One inventory used by browser-adjacent automation, CLI, MCP, and parity tests. */
export const REPORT_CAPABILITIES: readonly ReportCapability[] = [
  capability({
    id: 'my-hours', route: '/api/v1/reports/my-hours',
    requiredFilters: ['from', 'to'], optionalFilters: ['project'],
    scope: 'time_entries:read', administratorOnly: false,
  }),
  capability({
    id: 'time', route: '/api/v1/reports/time',
    requiredFilters: ['from', 'to'], optionalFilters: ['include_fixed_fee'],
    scope: 'reports:read', administratorOnly: false,
  }),
  capability({
    id: 'invoiced', route: '/api/v1/reports/invoiced',
    requiredFilters: ['from', 'to'], optionalFilters: ['client', 'status'],
    scope: 'reports:read', administratorOnly: false,
  }),
  capability({
    id: 'payments-received', route: '/api/v1/reports/payments-received',
    requiredFilters: ['from', 'to'], optionalFilters: ['client'],
    scope: 'reports:read', administratorOnly: false,
  }),
  capability({
    id: 'receivables', route: '/api/v1/reports/receivables',
    requiredFilters: ['as_of'], optionalFilters: ['client'],
    scope: 'reports:read', administratorOnly: false,
  }),
  capability({
    id: 'uninvoiced', route: '/api/v1/reports/uninvoiced',
    requiredFilters: ['from', 'to'], optionalFilters: ['client', 'project'],
    scope: 'reports:read', administratorOnly: false,
  }),
  capability({
    id: 'client-rollup', route: '/api/v1/reports/client-rollups/{clientId}',
    requiredFilters: ['from', 'to', 'client'], optionalFilters: [],
    scope: 'reports:read', administratorOnly: false,
  }),
  capability({
    id: 'project-budget', route: '/api/v1/reports/project-budgets/{projectId}',
    requiredFilters: ['from', 'to', 'project'], optionalFilters: [],
    scope: 'reports:read', administratorOnly: false,
  }),
  capability({
    id: 'contractor-cost', route: '/api/v1/reports/contractor',
    requiredFilters: ['from', 'to'], optionalFilters: [],
    scope: 'reports:read', administratorOnly: true,
  }),
  capability({
    id: 'detailed-time', route: '/api/v1/reports/detailed-time',
    requiredFilters: ['from', 'to'],
    optionalFilters: [
      'client', 'project', 'task_id', 'user_id', 'role_id', 'tag_id',
      'hours', 'grain', 'invoice_state', 'active_projects_only',
    ],
    scope: 'reports:read', administratorOnly: false,
  }),
  capability({
    id: 'activity-log', route: '/api/v1/activity-log',
    requiredFilters: ['from', 'to'], optionalFilters: ['event_type', 'actor_id'],
    scope: 'reports:read', administratorOnly: false,
  }),
  capability({
    id: 'profitability', route: '/api/v1/reports/profitability',
    requiredFilters: ['from', 'to'],
    optionalFilters: ['project_status', 'billing_method', 'manager_id', 'tag_id'],
    scope: 'reports:read', administratorOnly: true,
  }),
  capability({
    id: 'detailed-expense', route: '/api/v1/reports/detailed-expense',
    requiredFilters: ['from', 'to'], optionalFilters: ['client', 'project', 'billable_only'],
    scope: 'reports:read', administratorOnly: false,
  }),
] as const

export type ReportCapabilityId = (typeof REPORT_CAPABILITIES)[number]['id']

export const reportCapability = (id: string): ReportCapability | undefined =>
  REPORT_CAPABILITIES.find((entry) => entry.id === id)
