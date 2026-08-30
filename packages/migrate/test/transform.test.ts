import { describe, expect, it } from 'vitest'
import {
  accessRoles,
  billingMethod,
  canonicalHarvestTime,
  hoursLiteralToSeconds,
  moneyLiteralToCents,
  numberLexemes,
  percentLiteralToPpm,
} from '../src/transform.js'

describe('lossless snapshot transforms', () => {
  it('converts exact money and rejects a third decimal place', () => {
    expect(moneyLiteralToCents('175.00')).toBe(17_500)
    expect(moneyLiteralToCents('-0.2')).toBe(-20)
    expect(() => moneyLiteralToCents('1e2')).toThrow('plain decimal')
    expect(() => moneyLiteralToCents('12.345')).toThrow('plain decimal')
    expect(() => moneyLiteralToCents('1.230e2')).toThrow('plain decimal')
  })

  it('rounds hour fractions half-even and reports only inexact residues', () => {
    expect(hoursLiteralToSeconds('0.00125')).toEqual({ seconds: 4, residue: '0.00125' })
    expect(hoursLiteralToSeconds('0.00375')).toEqual({ seconds: 14, residue: '0.00375' })
    expect(hoursLiteralToSeconds('0.0001388888888888889')).toEqual({
      seconds: 1,
      residue: '0.0001388888888888889',
    })
    expect(hoursLiteralToSeconds('1.25')).toEqual({ seconds: 4500, residue: null })
  })

  it('converts percentages without passing through floating point', () => {
    expect(percentLiteralToPpm('7.25')).toBe(72_500)
    expect(() => percentLiteralToPpm('7.25001')).toThrow('more than four decimal places')
  })

  it('captures a bigint id and nested decimal lexemes before JSON.parse', () => {
    const lexemes = numberLexemes('{"id":9007199254740993,"line_items":[{"amount":1.20}]}')
    expect(lexemes.get('/id')).toBe('9007199254740993')
    expect(lexemes.get('/line_items/0/amount')).toBe('1.20')
  })

  it('applies clock, access-role, and billing truth tables', () => {
    expect(canonicalHarvestTime('8:03pm', '12h')).toBe('20:03')
    expect(accessRoles(['manager', 'manage_projects', 'approve_timesheets'])).toEqual({
      profile: 'project_manager',
      managerGrants: ['manage_projects', 'approve_timesheets'],
    })
    expect(billingMethod(false, true)).toEqual({ value: 'non_billable', anomaly: true })
  })
})
