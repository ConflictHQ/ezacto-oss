import { describe, expect, it } from 'vitest'
import { REPORT_CAPABILITIES, REPORT_FORMATS, reportCapability } from '../src/index.js'

describe('report capability registry', () => {
  it('[unit] keeps report IDs and routes unique with every output format', () => {
    const ids = REPORT_CAPABILITIES.map((report) => report.id)
    const routes = REPORT_CAPABILITIES.map((report) => report.route)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(routes).size).toBe(routes.length)
    for (const report of REPORT_CAPABILITIES) {
      expect(report.formats).toEqual(REPORT_FORMATS)
      expect(reportCapability(report.id)).toBe(report)
    }
  })

  it('[unit] returns no capability for an unknown report ID', () => {
    expect(reportCapability('not-a-report')).toBeUndefined()
  })
})
