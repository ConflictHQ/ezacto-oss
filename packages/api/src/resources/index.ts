import type { Hono } from 'hono'
import type { ApiContext } from '../context.js'
import { installExpenseRoutes } from './expenses.js'
import { installTimeEntryRoutes } from './time-entries.js'
import type {
  TrackedResourceClock,
  TrackedResourceRepository,
} from './tracked-repository.js'

export interface TrackedResourceRouteOptions {
  repository: TrackedResourceRepository
  clock: TrackedResourceClock
  cursorSigningKey: Uint8Array
}

/** Narrow composition seam for the application entry point to install later. */
export const installTrackedResourceRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: TrackedResourceRouteOptions,
): void => {
  installTimeEntryRoutes(api, options)
  installExpenseRoutes(api, options)
}

export {
  installExpenseRoutes,
  serializeExpense,
  type ExpenseRouteOptions,
} from './expenses.js'
export {
  installTimeEntryRoutes,
  serializeTimeEntry,
  type TimeEntryRouteOptions,
} from './time-entries.js'
export type {
  CreateExpenseRequest,
  CreateTimeEntryRequest,
  ExpenseFilters,
  ExpenseRecord,
  ResourceTimeBoundary,
  TimeEntryFilters,
  TimeEntryRecord,
  TrackedResourceClock,
  TrackedResourceRepository,
  UpdateExpenseRequest,
  UpdateTimeEntryRequest,
} from './tracked-repository.js'
