import { describe, expect, it } from 'vitest'
import {
  createReportDefinition,
  deserializeReportDefinition,
  getMetric,
  isMetricId,
  listMetrics,
  serializeReportDefinition,
  SERIALIZATION_SCHEMA_VERSION,
  updateReportDefinition,
  type CreateReportDefinitionInput,
  type MetricId,
} from '../src/report-definitions.js'
import * as publicDatabase from '../src/index.js'

const timestamp = '2026-09-01T10:00:00.000Z'
const laterTimestamp = '2026-09-01T11:00:00.000Z'

const baseInput: CreateReportDefinitionInput = {
  id: 'rpt-001',
  name: 'Monthly Client Report',
  fields: [
    { id: 'client_name', label: 'Client', visible: true },
    { id: 'project_name', label: 'Project', visible: true },
    { id: 'spent_date', label: 'Date', visible: false },
  ],
  metrics: ['hours', 'billable', 'cost', 'margin'],
  filters: [
    { field: 'client_id', operator: 'eq', value: 42 },
    { field: 'spent_date', operator: 'between', value: ['2026-08-01', '2026-08-31'] },
  ],
  groupBy: { dimension: 'client', nodeId: 1 },
  createdAt: timestamp,
}

// ---------------------------------------------------------------------------
// Acceptance criterion 1: definition round-trips serialize/deserialize;
// version bump on change
// ---------------------------------------------------------------------------
describe('report definition serialization', () => {
  it('round-trips through serialize then deserialize', () => {
    const definition = createReportDefinition(baseInput)
    const serialized = serializeReportDefinition(definition)
    const json = JSON.stringify(serialized)
    const parsed = JSON.parse(json) as unknown
    const deserialized = deserializeReportDefinition(parsed)

    expect(deserialized).toEqual(definition)
  })

  it('includes schema markers in serialized form', () => {
    const definition = createReportDefinition(baseInput)
    const serialized = serializeReportDefinition(definition)

    expect(serialized.$schema).toBe('report-definition')
    expect(serialized.$schemaVersion).toBe(SERIALIZATION_SCHEMA_VERSION)
  })

  it('starts at version 1', () => {
    const definition = createReportDefinition(baseInput)
    expect(definition.version).toBe(1)
  })

  it('bumps version on name change', () => {
    const v1 = createReportDefinition(baseInput)
    const v2 = updateReportDefinition(v1, {
      name: 'Updated Report',
      updatedAt: laterTimestamp,
    })
    expect(v2.version).toBe(2)
    expect(v2.name).toBe('Updated Report')
    expect(v2.updatedAt).toBe(laterTimestamp)
    expect(v2.createdAt).toBe(timestamp)
  })

  it('bumps version on metrics change', () => {
    const v1 = createReportDefinition(baseInput)
    const v2 = updateReportDefinition(v1, {
      metrics: ['hours', 'billable', 'margin', 'retainer_burn'],
      updatedAt: laterTimestamp,
    })
    expect(v2.version).toBe(2)
    expect(v2.metrics).toEqual(['hours', 'billable', 'margin', 'retainer_burn'])
  })

  it('bumps version on fields change', () => {
    const v1 = createReportDefinition(baseInput)
    const v2 = updateReportDefinition(v1, {
      fields: [{ id: 'client_name', label: 'Client', visible: true }],
      updatedAt: laterTimestamp,
    })
    expect(v2.version).toBe(2)
    expect(v2.fields).toHaveLength(1)
  })

  it('bumps version on filters change', () => {
    const v1 = createReportDefinition(baseInput)
    const v2 = updateReportDefinition(v1, {
      filters: [],
      updatedAt: laterTimestamp,
    })
    expect(v2.version).toBe(2)
    expect(v2.filters).toEqual([])
  })

  it('bumps version on groupBy change', () => {
    const v1 = createReportDefinition(baseInput)
    const v2 = updateReportDefinition(v1, {
      groupBy: { dimension: 'project' },
      updatedAt: laterTimestamp,
    })
    expect(v2.version).toBe(2)
    expect(v2.groupBy).toEqual({ dimension: 'project' })
  })

  it('bumps version on groupBy set to null', () => {
    const v1 = createReportDefinition(baseInput)
    const v2 = updateReportDefinition(v1, {
      groupBy: null,
      updatedAt: laterTimestamp,
    })
    expect(v2.version).toBe(2)
    expect(v2.groupBy).toBeNull()
  })

  it('increments version successively on multiple updates', () => {
    const v1 = createReportDefinition(baseInput)
    const v2 = updateReportDefinition(v1, {
      name: 'V2',
      updatedAt: laterTimestamp,
    })
    const v3 = updateReportDefinition(v2, {
      name: 'V3',
      updatedAt: '2026-09-01T12:00:00.000Z',
    })
    expect(v3.version).toBe(3)
  })

  it('rejects update that changes nothing', () => {
    const v1 = createReportDefinition(baseInput)
    expect(() =>
      updateReportDefinition(v1, { updatedAt: laterTimestamp }),
    ).toThrow('update must change at least one field')
  })

  it('round-trips a definition after updates through serialize/deserialize', () => {
    const v1 = createReportDefinition(baseInput)
    const v2 = updateReportDefinition(v1, {
      name: 'Updated',
      metrics: ['hours', 'margin', 'budget_consumed'],
      groupBy: null,
      updatedAt: laterTimestamp,
    })
    const serialized = serializeReportDefinition(v2)
    const json = JSON.stringify(serialized)
    const deserialized = deserializeReportDefinition(JSON.parse(json))
    expect(deserialized).toEqual(v2)
  })

  it('round-trips with null groupBy', () => {
    const input: CreateReportDefinitionInput = {
      ...baseInput,
      groupBy: null,
    }
    const definition = createReportDefinition(input)
    const serialized = serializeReportDefinition(definition)
    const deserialized = deserializeReportDefinition(JSON.parse(JSON.stringify(serialized)))
    expect(deserialized).toEqual(definition)
    expect(deserialized.groupBy).toBeNull()
  })

  it('round-trips with empty filters', () => {
    const input: CreateReportDefinitionInput = {
      ...baseInput,
      filters: [],
    }
    const definition = createReportDefinition(input)
    const serialized = serializeReportDefinition(definition)
    const deserialized = deserializeReportDefinition(JSON.parse(JSON.stringify(serialized)))
    expect(deserialized).toEqual(definition)
  })
})

describe('report definition validation', () => {
  it('rejects blank name', () => {
    expect(() =>
      createReportDefinition({ ...baseInput, name: '   ' }),
    ).toThrow('name must not be blank')
  })

  it('rejects empty fields', () => {
    expect(() =>
      createReportDefinition({ ...baseInput, fields: [] }),
    ).toThrow('fields must be a non-empty array')
  })

  it('rejects empty metrics', () => {
    expect(() =>
      createReportDefinition({ ...baseInput, metrics: [] }),
    ).toThrow('metrics must be a non-empty array')
  })

  it('rejects unrecognized metric id', () => {
    expect(() =>
      createReportDefinition({
        ...baseInput,
        metrics: ['hours', 'nonexistent' as MetricId],
      }),
    ).toThrow('is not a registered metric id')
  })

  it('rejects duplicate metrics', () => {
    expect(() =>
      createReportDefinition({
        ...baseInput,
        metrics: ['hours', 'hours'],
      }),
    ).toThrow('metrics must not contain duplicates')
  })

  it('rejects invalid id format', () => {
    expect(() =>
      createReportDefinition({ ...baseInput, id: '' }),
    ).toThrow('report definition id must use 1-128 safe identifier characters')
  })

  it('rejects invalid timestamp format', () => {
    expect(() =>
      createReportDefinition({ ...baseInput, createdAt: 'not-a-timestamp' }),
    ).toThrow('createdAt must be a canonical UTC timestamp')
  })

  it('rejects invalid grouping dimension', () => {
    expect(() =>
      createReportDefinition({
        ...baseInput,
        groupBy: { dimension: 'invalid' as never },
      }),
    ).toThrow('groupBy.dimension is not a recognized dimension')
  })

  it('rejects invalid filter operator', () => {
    expect(() =>
      createReportDefinition({
        ...baseInput,
        filters: [{ field: 'x', operator: 'bad' as never, value: 1 }],
      }),
    ).toThrow('is not a recognized operator')
  })
})

describe('deserialization rejection', () => {
  it('rejects null', () => {
    expect(() => deserializeReportDefinition(null)).toThrow('must be an object')
  })

  it('rejects non-object', () => {
    expect(() => deserializeReportDefinition('string')).toThrow('must be an object')
  })

  it('rejects wrong schema', () => {
    expect(() => deserializeReportDefinition({ $schema: 'other' })).toThrow(
      'must have $schema "report-definition"',
    )
  })

  it('rejects wrong schema version', () => {
    expect(() =>
      deserializeReportDefinition({
        $schema: 'report-definition',
        $schemaVersion: 999,
      }),
    ).toThrow('unsupported report definition schema version')
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion 2: metric registry includes margin + retainer burn +
// budget consumed
// ---------------------------------------------------------------------------
describe('metric registry', () => {
  it('includes margin metric', () => {
    const metric = getMetric('margin')
    expect(metric).toBeDefined()
    expect(metric!.id).toBe('margin')
    expect(metric!.unit).toBe('cents')
    expect(metric!.label).toBe('Margin')
  })

  it('includes retainer_burn metric', () => {
    const metric = getMetric('retainer_burn')
    expect(metric).toBeDefined()
    expect(metric!.id).toBe('retainer_burn')
    expect(metric!.unit).toBe('cents')
    expect(metric!.label).toBe('Retainer Burn')
  })

  it('includes budget_consumed metric', () => {
    const metric = getMetric('budget_consumed')
    expect(metric).toBeDefined()
    expect(metric!.id).toBe('budget_consumed')
    expect(metric!.unit).toBe('ratio')
    expect(metric!.label).toBe('Budget Consumed')
  })

  it('lists all expected metrics', () => {
    const metrics = listMetrics()
    const ids = metrics.map((m) => m.id)
    expect(ids).toContain('hours')
    expect(ids).toContain('billable')
    expect(ids).toContain('cost')
    expect(ids).toContain('margin')
    expect(ids).toContain('utilisation')
    expect(ids).toContain('retainer_balance')
    expect(ids).toContain('retainer_burn')
    expect(ids).toContain('budget_consumed')
    expect(metrics).toHaveLength(8)
  })

  it('recognizes all registered metric ids', () => {
    const metrics = listMetrics()
    for (const metric of metrics) {
      expect(isMetricId(metric.id)).toBe(true)
    }
  })

  it('rejects unknown strings as metric ids', () => {
    expect(isMetricId('unknown')).toBe(false)
    expect(isMetricId('')).toBe(false)
  })

  it('returns undefined for unknown metric id', () => {
    expect(getMetric('unknown' as MetricId)).toBeUndefined()
  })

  it('returns a fresh array from listMetrics each time', () => {
    const a = listMetrics()
    const b = listMetrics()
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })
})

describe('public API surface', () => {
  it('exports report definition types from the db package', () => {
    expect(publicDatabase.createReportDefinition).toBeTypeOf('function')
    expect(publicDatabase.updateReportDefinition).toBeTypeOf('function')
    expect(publicDatabase.serializeReportDefinition).toBeTypeOf('function')
    expect(publicDatabase.deserializeReportDefinition).toBeTypeOf('function')
    expect(publicDatabase.listMetrics).toBeTypeOf('function')
    expect(publicDatabase.getMetric).toBeTypeOf('function')
    expect(publicDatabase.isMetricId).toBeTypeOf('function')
  })
})
