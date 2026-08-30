// The extract order (migration-spec §2.1, research §15.3), flattened into the
// sequence extract actually walks. FK-safe by construction: every child step's
// parent appears earlier in this array, so a load consuming raw/ in this order
// never sees a foreign key it has not already met.
//
// Steps 1 and 2 of §2.1 (accounts, company) are not here — `auth` already made
// those calls and recorded them in manifest.preflight. Step 14 (reports
// checksums) is not here either, and no path below touches /v2/reports/*: that
// runs on a different budget, 100 / 15 min, and belongs to `verify`.

import type { ManifestCompanySettings } from './manifest.js'

/** The `/v2/company` flags that decide whether a resource tree exists at all. */
export type FeatureFlag = Extract<
  keyof ManifestCompanySettings,
  | 'expense_feature'
  | 'invoice_feature'
  | 'estimate_feature'
  | 'approval_feature'
  | 'team_feature'
>

interface StepCommon {
  name: string
  /**
   * The envelope key holding the records — stated per step, never derived. The
   * pluralized-resource-name rule (research §0.4) is documented with one example
   * and no body is published for any of the nested endpoints, so for those this is
   * an informed guess. The paginator throws on a missing key precisely so a wrong
   * guess fails loudly on the first live run instead of writing an empty file and
   * reporting count: 0 as success.
   */
  collection: string
  /** Skip the step entirely when this preflight flag is false. */
  requires?: FeatureFlag
}

export interface ListStep extends StepCommon {
  kind: 'list'
  path: string
  /** Query params sent on the first request; later pages come from `links.next`. */
  params?: Record<string, string>
  /**
   * Sweep the collection once per entry, all rows landing in the same file. Used
   * only for the assignment sweeps, where one pass cannot see the whole account.
   */
  passes?: Record<string, string>[]
  /**
   * Harvest does not implement `updated_since` on this endpoint, so a re-run has
   * to sweep it in full rather than asking for what changed (§2.4). Research §13:
   * "Every list endpoint except `roles`, `billable_rates`, `cost_rates`, and
   * `teammates` supports `updated_since`" — the other three are `child` steps,
   * which are never incremental anyway. Harvest ignores query params it does not
   * know, so an incremental pass here would ask for a filter, be handed the whole
   * collection back, and merge it in as if it were the changed rows: unbounded
   * re-fetching of an endpoint that is already cheap to sweep whole.
   */
  noUpdatedSince?: true
}

export interface ChildStep extends StepCommon {
  kind: 'child'
  /** Built per parent id read back out of raw/<parent>.jsonl. */
  path: (parentId: number) => string
  /** Name of the step whose ids this one fans out over. */
  parent: string
  /**
   * Record a skip and continue on 403/404 rather than failing the run. For
   * `teammates`, which is gated by `company.team_feature` — a flag the /v2/company
   * preflight does not record, so the only way to learn it is to ask and be refused.
   */
  optional?: true
}

export type ResourceStep = ListStep | ChildStep

/** The two assignment sweeps: `is_active=false` rows are invisible without it. */
const ACTIVE_PASSES: Record<string, string>[] = [{ is_active: 'true' }, { is_active: 'false' }]

export const RESOURCES: readonly ResourceStep[] = [
  { kind: 'list', name: 'users', path: '/v2/users', collection: 'users' },
  {
    kind: 'child',
    name: 'billable_rates',
    path: (id) => `/v2/users/${id}/billable_rates`,
    collection: 'billable_rates',
    parent: 'users',
  },
  {
    kind: 'child',
    name: 'cost_rates',
    path: (id) => `/v2/users/${id}/cost_rates`,
    collection: 'cost_rates',
    parent: 'users',
  },
  {
    kind: 'child',
    name: 'teammates',
    path: (id) => `/v2/users/${id}/teammates`,
    collection: 'teammates',
    parent: 'users',
    optional: true,
    requires: 'team_feature',
  },
  // /v2/roles takes only `page` (deprecated) and `per_page` — research §7.
  { kind: 'list', name: 'roles', path: '/v2/roles', collection: 'roles', noUpdatedSince: true },
  { kind: 'list', name: 'clients', path: '/v2/clients', collection: 'clients' },
  { kind: 'list', name: 'contacts', path: '/v2/contacts', collection: 'contacts' },
  { kind: 'list', name: 'tasks', path: '/v2/tasks', collection: 'tasks' },
  {
    kind: 'list',
    name: 'expense_categories',
    path: '/v2/expense_categories',
    collection: 'expense_categories',
    requires: 'expense_feature',
  },
  {
    kind: 'list',
    name: 'invoice_item_categories',
    path: '/v2/invoice_item_categories',
    collection: 'invoice_item_categories',
    requires: 'invoice_feature',
  },
  {
    kind: 'list',
    name: 'estimate_item_categories',
    path: '/v2/estimate_item_categories',
    collection: 'estimate_item_categories',
    requires: 'estimate_feature',
  },
  { kind: 'list', name: 'projects', path: '/v2/projects', collection: 'projects' },
  // Account-wide sweeps, not per-project loops: /v2/projects/{id}/task_assignments
  // would cost one call per project, and users/{id}/project_assignments — the other
  // obvious route — returns active assignments only (research §9.4). Both passes
  // write into one file; is_active is on every row, so nothing is lost by merging.
  {
    kind: 'list',
    name: 'task_assignments',
    path: '/v2/task_assignments',
    collection: 'task_assignments',
    passes: ACTIVE_PASSES,
  },
  {
    kind: 'list',
    name: 'user_assignments',
    path: '/v2/user_assignments',
    collection: 'user_assignments',
    passes: ACTIVE_PASSES,
  },
  {
    kind: 'list',
    name: 'estimates',
    path: '/v2/estimates',
    collection: 'estimates',
    requires: 'estimate_feature',
  },
  {
    kind: 'child',
    name: 'estimate_messages',
    path: (id) => `/v2/estimates/${id}/messages`,
    collection: 'estimate_messages',
    parent: 'estimates',
    requires: 'estimate_feature',
  },
  {
    kind: 'list',
    name: 'invoices',
    path: '/v2/invoices',
    collection: 'invoices',
    requires: 'invoice_feature',
  },
  {
    kind: 'child',
    name: 'invoice_messages',
    path: (id) => `/v2/invoices/${id}/messages`,
    collection: 'invoice_messages',
    parent: 'invoices',
    requires: 'invoice_feature',
  },
  {
    kind: 'child',
    name: 'invoice_payments',
    path: (id) => `/v2/invoices/${id}/payments`,
    collection: 'invoice_payments',
    parent: 'invoices',
    requires: 'invoice_feature',
  },
  // §2.1 annotates time_entries and expenses "windowed from/to". Cursor pagination
  // already walks an unbounded collection correctly, so the window buys nothing
  // here; its real motivation is resume granularity and updated_since, which are
  // the incremental stories. `params` is the seam it attaches to when it lands.
  { kind: 'list', name: 'time_entries', path: '/v2/time_entries', collection: 'time_entries' },
  {
    kind: 'list',
    name: 'expenses',
    path: '/v2/expenses',
    collection: 'expenses',
    requires: 'expense_feature',
  },
]
