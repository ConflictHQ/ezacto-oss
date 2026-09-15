/**
 * Report definitions as data (DV-19).
 *
 * A report definition is a versioned, serializable entity that captures which
 * fields, metrics, filters, and grouping a report displays. It is the
 * configuration object that drives report generation — not the report output
 * itself.
 *
 * The metric registry enumerates every metric the system can compute, with
 * enough metadata for renderers to format values correctly.
 */

// ---------------------------------------------------------------------------
// Metric registry
// ---------------------------------------------------------------------------

export type MetricUnit = 'seconds' | 'cents' | 'ratio' | 'percentage'

export type MetricId =
  | 'hours'
  | 'billable'
  | 'cost'
  | 'margin'
  | 'utilisation'
  | 'retainer_balance'
  | 'retainer_burn'
  | 'budget_consumed'

export interface MetricDefinition {
  readonly id: MetricId
  readonly label: string
  readonly unit: MetricUnit
  readonly description: string
}

const metricDefinitions: readonly MetricDefinition[] = [
  {
    id: 'hours',
    label: 'Hours',
    unit: 'seconds',
    description: 'Total tracked time in seconds',
  },
  {
    id: 'billable',
    label: 'Billable Amount',
    unit: 'cents',
    description: 'Billable amount computed from billable hours and rates',
  },
  {
    id: 'cost',
    label: 'Cost',
    unit: 'cents',
    description: 'Internal cost computed from tracked hours and cost rates',
  },
  {
    id: 'margin',
    label: 'Margin',
    unit: 'cents',
    description: 'Billable amount minus cost',
  },
  {
    id: 'utilisation',
    label: 'Utilisation',
    unit: 'percentage',
    description: 'Billable seconds as a percentage of capacity',
  },
  {
    id: 'retainer_balance',
    label: 'Retainer Balance',
    unit: 'cents',
    description: 'Current retainer balance after deposits and drawdowns',
  },
  {
    id: 'retainer_burn',
    label: 'Retainer Burn',
    unit: 'cents',
    description: 'Total retainer drawdowns in the reporting period',
  },
  {
    id: 'budget_consumed',
    label: 'Budget Consumed',
    unit: 'ratio',
    description: 'Fraction of budget spent (spent / budget), 0..N',
  },
] as const

const metricById = new Map<MetricId, MetricDefinition>(
  metricDefinitions.map((metric) => [metric.id, metric]),
)

/**
 * Return all registered metric definitions, ordered by their canonical
 * position. The array is freshly cloned on each call.
 */
export const listMetrics = (): readonly MetricDefinition[] => [...metricDefinitions]

/**
 * Look up a single metric by id. Returns undefined when the id is not
 * in the registry.
 */
export const getMetric = (id: MetricId): MetricDefinition | undefined => metricById.get(id)

/**
 * Returns true when the given string is a registered metric id.
 */
export const isMetricId = (value: string): value is MetricId => metricById.has(value as MetricId)

// ---------------------------------------------------------------------------
// Report definition entity
// ---------------------------------------------------------------------------

export interface ReportField {
  readonly id: string
  readonly label: string
  readonly visible: boolean
}

export interface ReportFieldDefinition {
  readonly id: string
  readonly label: string
  readonly filterable: boolean
  readonly groupable: boolean
}

const fieldDefinitions: readonly ReportFieldDefinition[] = [
  { id: 'client_id', label: 'Client ID', filterable: true, groupable: false },
  { id: 'client_name', label: 'Client', filterable: false, groupable: true },
  { id: 'project_id', label: 'Project ID', filterable: true, groupable: false },
  { id: 'project_name', label: 'Project', filterable: false, groupable: true },
  { id: 'task_id', label: 'Task ID', filterable: true, groupable: false },
  { id: 'task_name', label: 'Task', filterable: false, groupable: true },
  { id: 'user_id', label: 'Teammate ID', filterable: true, groupable: false },
  { id: 'user_name', label: 'Teammate', filterable: false, groupable: true },
  { id: 'spent_date', label: 'Date', filterable: true, groupable: true },
  { id: 'billable', label: 'Billable', filterable: true, groupable: false },
] as const

const fieldById = new Map(fieldDefinitions.map((field) => [field.id, field]))
export const listReportFields = (): readonly ReportFieldDefinition[] => [...fieldDefinitions]

export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'between'

export interface ReportFilter {
  readonly field: string
  readonly operator: FilterOperator
  readonly value: unknown
}

export type GroupingDimension = 'client' | 'project' | 'task' | 'user' | 'date'

export interface ReportGrouping {
  readonly dimension: GroupingDimension
  readonly nodeId?: number
}

export interface ReportDefinition {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly fields: readonly ReportField[]
  readonly metrics: readonly MetricId[]
  readonly filters: readonly ReportFilter[]
  readonly groupBy: ReportGrouping | null
  readonly createdAt: string
  readonly updatedAt: string
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const idPattern = /^[A-Za-z0-9_-]{1,128}$/
const timestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const assertNonBlank = (value: string, field: string): void => {
  if (value.trim().length === 0) throw new RangeError(`${field} must not be blank`)
}

const assertCanonicalTimestamp = (value: string, field: string): void => {
  if (!timestampPattern.test(value)) {
    throw new RangeError(`${field} must be a canonical UTC timestamp`)
  }
}

const assertPositiveInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
}

const validOperators: readonly FilterOperator[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'between',
]

const validDimensions: readonly GroupingDimension[] = [
  'client',
  'project',
  'task',
  'user',
  'date',
]

const validateField = (field: ReportField, index: number): void => {
  assertNonBlank(field.id, `fields[${index}].id`)
  assertNonBlank(field.label, `fields[${index}].label`)
  if (typeof field.visible !== 'boolean') {
    throw new TypeError(`fields[${index}].visible must be a boolean`)
  }
  if (!fieldById.has(field.id)) throw new RangeError(`fields[${index}].id is not registered`)
}

const validateFilter = (filter: ReportFilter, index: number): void => {
  assertNonBlank(filter.field, `filters[${index}].field`)
  if (!validOperators.includes(filter.operator)) {
    throw new RangeError(`filters[${index}].operator is not a recognized operator`)
  }
  if (fieldById.get(filter.field)?.filterable !== true) {
    throw new RangeError(`filters[${index}].field is not filterable`)
  }
}

const validateGrouping = (groupBy: ReportGrouping): void => {
  if (!validDimensions.includes(groupBy.dimension)) {
    throw new RangeError(`groupBy.dimension is not a recognized dimension`)
  }
  if (groupBy.nodeId !== undefined) {
    assertPositiveInteger(groupBy.nodeId, 'groupBy.nodeId')
  }
}

const validateDefinition = (definition: ReportDefinition): void => {
  if (!idPattern.test(definition.id)) {
    throw new RangeError('report definition id must use 1-128 safe identifier characters')
  }
  assertNonBlank(definition.name, 'name')
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
    throw new RangeError('version must be a positive safe integer')
  }
  if (!Array.isArray(definition.fields) || definition.fields.length === 0) {
    throw new RangeError('fields must be a non-empty array')
  }
  definition.fields.forEach(validateField)
  if (!Array.isArray(definition.metrics) || definition.metrics.length === 0) {
    throw new RangeError('metrics must be a non-empty array')
  }
  for (let i = 0; i < definition.metrics.length; i++) {
    if (!isMetricId(definition.metrics[i])) {
      throw new RangeError(`metrics[${i}] is not a registered metric id`)
    }
  }
  if (new Set(definition.metrics).size !== definition.metrics.length) {
    throw new RangeError('metrics must not contain duplicates')
  }
  if (!Array.isArray(definition.filters)) {
    throw new TypeError('filters must be an array')
  }
  definition.filters.forEach(validateFilter)
  if (definition.groupBy !== null) {
    validateGrouping(definition.groupBy)
  }
  assertCanonicalTimestamp(definition.createdAt, 'createdAt')
  assertCanonicalTimestamp(definition.updatedAt, 'updatedAt')
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateReportDefinitionInput {
  readonly id: string
  readonly name: string
  readonly fields: readonly ReportField[]
  readonly metrics: readonly MetricId[]
  readonly filters: readonly ReportFilter[]
  readonly groupBy: ReportGrouping | null
  readonly createdAt: string
}

/**
 * Construct a new report definition at version 1.
 */
export const createReportDefinition = (
  input: CreateReportDefinitionInput,
): ReportDefinition => {
  const definition: ReportDefinition = {
    id: input.id,
    name: input.name,
    version: 1,
    fields: [...input.fields],
    metrics: [...input.metrics],
    filters: [...input.filters],
    groupBy: input.groupBy,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  }
  validateDefinition(definition)
  return definition
}

// ---------------------------------------------------------------------------
// Update (version bump)
// ---------------------------------------------------------------------------

export interface UpdateReportDefinitionInput {
  readonly name?: string
  readonly fields?: readonly ReportField[]
  readonly metrics?: readonly MetricId[]
  readonly filters?: readonly ReportFilter[]
  readonly groupBy?: ReportGrouping | null
  readonly updatedAt: string
}

/**
 * Return a new definition with the changed fields and an incremented
 * version. Throws if nothing actually changed.
 */
export const updateReportDefinition = (
  existing: ReportDefinition,
  changes: UpdateReportDefinitionInput,
): ReportDefinition => {
  const name = changes.name ?? existing.name
  const fields = changes.fields ?? existing.fields
  const metrics = changes.metrics ?? existing.metrics
  const filters = changes.filters ?? existing.filters
  const groupBy = changes.groupBy !== undefined ? changes.groupBy : existing.groupBy

  const nameChanged = name !== existing.name
  const fieldsChanged = JSON.stringify(fields) !== JSON.stringify(existing.fields)
  const metricsChanged = JSON.stringify(metrics) !== JSON.stringify(existing.metrics)
  const filtersChanged = JSON.stringify(filters) !== JSON.stringify(existing.filters)
  const groupByChanged = JSON.stringify(groupBy) !== JSON.stringify(existing.groupBy)

  if (!nameChanged && !fieldsChanged && !metricsChanged && !filtersChanged && !groupByChanged) {
    throw new Error('update must change at least one field')
  }

  const updated: ReportDefinition = {
    id: existing.id,
    name,
    version: existing.version + 1,
    fields: [...fields],
    metrics: [...metrics],
    filters: [...filters],
    groupBy,
    createdAt: existing.createdAt,
    updatedAt: changes.updatedAt,
  }
  validateDefinition(updated)
  return updated
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Schema version for the JSON wire format. */
export const SERIALIZATION_SCHEMA_VERSION = 1

export interface SerializedReportDefinition {
  readonly $schema: 'report-definition'
  readonly $schemaVersion: 1
  readonly id: string
  readonly name: string
  readonly version: number
  readonly fields: readonly ReportField[]
  readonly metrics: readonly MetricId[]
  readonly filters: readonly ReportFilter[]
  readonly groupBy: ReportGrouping | null
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * Serialize a validated report definition to its JSON-safe wire format.
 */
export const serializeReportDefinition = (
  definition: ReportDefinition,
): SerializedReportDefinition => {
  validateDefinition(definition)
  return {
    $schema: 'report-definition',
    $schemaVersion: SERIALIZATION_SCHEMA_VERSION,
    id: definition.id,
    name: definition.name,
    version: definition.version,
    fields: [...definition.fields],
    metrics: [...definition.metrics],
    filters: [...definition.filters],
    groupBy: definition.groupBy,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  }
}

/**
 * Deserialize from the wire format back to a validated report definition.
 * Throws on unrecognized schema versions or invalid data.
 */
export const deserializeReportDefinition = (
  data: unknown,
): ReportDefinition => {
  if (data === null || typeof data !== 'object') {
    throw new TypeError('serialized report definition must be an object')
  }
  const record = data as Record<string, unknown>
  if (record.$schema !== 'report-definition') {
    throw new TypeError('serialized report definition must have $schema "report-definition"')
  }
  if (record.$schemaVersion !== SERIALIZATION_SCHEMA_VERSION) {
    throw new RangeError(
      `unsupported report definition schema version: ${String(record.$schemaVersion)}`,
    )
  }
  const definition: ReportDefinition = {
    id: record.id as string,
    name: record.name as string,
    version: record.version as number,
    fields: record.fields as ReportField[],
    metrics: record.metrics as MetricId[],
    filters: record.filters as ReportFilter[],
    groupBy: (record.groupBy ?? null) as ReportGrouping | null,
    createdAt: record.createdAt as string,
    updatedAt: record.updatedAt as string,
  }
  validateDefinition(definition)
  return definition
}
