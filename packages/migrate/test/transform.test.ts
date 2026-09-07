import { describe, expect, it } from 'vitest'
import {
  accessRoles,
  billingMethod,
  canonicalHarvestTime,
  hoursLiteralToSeconds,
  moneyLiteralToCents,
  numberLexemes,
  percentLiteralToPpm,
  rateLiteralToCents,
} from '../src/transform.js'

describe('lossless snapshot transforms', () => {
  it('converts exact money and rejects a third decimal place', () => {
    expect(moneyLiteralToCents('175.00')).toBe(17_500)
    expect(moneyLiteralToCents('-0.2')).toBe(-20)
    expect(() => moneyLiteralToCents('1e2')).toThrow('plain decimal')
    expect(() => moneyLiteralToCents('12.345')).toThrow('plain decimal')
    expect(() => moneyLiteralToCents('1.230e2')).toThrow('plain decimal')
  })

  it('rounds per-unit rates half-even and reports only inexact residues', () => {
    // Harvest's mileage categories carry the IRS half-cent rate; it is a rate,
    // not a money total, so it rounds with a residue instead of failing.
    expect(rateLiteralToCents('0.485')).toEqual({ cents: 48, residue: '0.485' })
    expect(rateLiteralToCents('0.475')).toEqual({ cents: 48, residue: '0.475' })
    expect(rateLiteralToCents('67.1428571')).toEqual({ cents: 6714, residue: '67.1428571' })
    expect(rateLiteralToCents('51.6666667')).toEqual({ cents: 5167, residue: '51.6666667' })
    expect(rateLiteralToCents('-0.485')).toEqual({ cents: -48, residue: '-0.485' })
    // Exact rates carry no residue, and two decimals stay byte-exact.
    expect(rateLiteralToCents('175.00')).toEqual({ cents: 17_500, residue: null })
    expect(rateLiteralToCents('-0.2')).toEqual({ cents: -20, residue: null })
    expect(rateLiteralToCents('12.3400')).toEqual({ cents: 1234, residue: null })
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

  it('carries the sign of a correction entry through to seconds', () => {
    // #279: a Harvest correction offsets an earlier entry, so refusing the
    // literal here made the loader skip it and overstate the period.
    expect(hoursLiteralToSeconds('-1.0')).toEqual({ seconds: -3600, residue: null })
    expect(hoursLiteralToSeconds('-0.25')).toEqual({ seconds: -900, residue: null })
    expect(hoursLiteralToSeconds('-0.00125')).toEqual({ seconds: -4, residue: '-0.00125' })
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
