import { describe, expect, it } from 'vitest'
import { validReportDefinitions } from '../src/money.js'

describe('CLI money module', () => {
  it('[unit] exposes the canonical report definitions', () => {
    const definitions = validReportDefinitions()
    expect(definitions).toContain('uninvoiced')
    expect(definitions).toContain('client-rollup')
    expect(definitions).toContain('project-budget')
    expect(definitions.length).toBe(3)
  })
})
