import { describe, expect, it } from 'vitest'
import { aggregateAppleCleanup } from '../src/apple-lifecycle.js'

describe('Apple cleanup across independent channels', () => {
  it('never reports native proof as complete while a web or historical obligation remains', () => {
    expect(aggregateAppleCleanup(['revoked', 'pending'])).toBe('pending')
    expect(aggregateAppleCleanup(['revoked', 'manual_required'])).toBe('manual_required')
    expect(aggregateAppleCleanup(['pending', 'manual_required'])).toBe('manual_required')
  })
  it('reports confirmed revocation only after every linked channel is resolved', () => {
    expect(aggregateAppleCleanup(['revoked', 'revoked'])).toBe('revoked')
    expect(aggregateAppleCleanup(['revoked', 'not_linked'])).toBe('revoked')
    expect(aggregateAppleCleanup(['not_linked', 'not_linked'])).toBe('not_linked')
  })
})
