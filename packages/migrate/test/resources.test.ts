// AC #1, registry half: the order is the spec, transcribed once and asserted
// literally — and the FK safety it exists to provide is asserted as a property,
// so a future insertion cannot quietly break it while still matching a list.

import { describe, expect, it } from 'vitest'
import { RESOURCES } from '../src/resources.js'

const NAMES = RESOURCES.map((step) => step.name)

describe('the extract resource registry', () => {
  it('[unit] order matches migration-spec §2.1 exactly', () => {
    expect(NAMES).toEqual([
      'users',
      'billable_rates',
      'cost_rates',
      'teammates',
      'roles',
      'clients',
      'contacts',
      'tasks',
      'expense_categories',
      'invoice_item_categories',
      'estimate_item_categories',
      'projects',
      'task_assignments',
      'user_assignments',
      'estimates',
      'estimate_messages',
      'invoices',
      'invoice_messages',
      'invoice_payments',
      'time_entries',
      'expenses',
    ])
  })

  it('[unit] every child step is preceded by the parent it fans out over', () => {
    for (const [index, step] of RESOURCES.entries()) {
      if (step.kind !== 'child') continue
      const parentIndex = NAMES.indexOf(step.parent)
      expect(
        parentIndex,
        `${step.name} fans out over an unknown step ${step.parent}`,
      ).toBeGreaterThanOrEqual(0)
      expect(parentIndex, `${step.name} runs before its parent ${step.parent}`).toBeLessThan(index)
    }
  })

  it('[unit] a child step is never enabled while its parent is feature-skipped', () => {
    // Otherwise readIds hits a raw/<parent>.jsonl that no step ever wrote.
    for (const step of RESOURCES) {
      if (step.kind !== 'child') continue
      const parent = RESOURCES.find((s) => s.name === step.parent)
      if (parent?.requires) expect(step.requires).toBe(parent.requires)
    }
  })

  it('[unit] assignment sweeps are account-wide, with an is_active=false pass', () => {
    for (const name of ['task_assignments', 'user_assignments']) {
      const step = RESOURCES.find((s) => s.name === name)
      expect(step?.kind).toBe('list')
      if (step?.kind !== 'list') throw new Error('unreachable')

      // Account-wide: never /v2/projects/{id}/… (one call per project, and
      // /v2/users/{id}/project_assignments returns active rows only, research §9.4)
      expect(step.path).toBe(`/v2/${name}`)
      expect(step.path).not.toContain('/v2/projects/')
      expect(step.passes).toEqual([{ is_active: 'true' }, { is_active: 'false' }])
    }
  })

  it('[unit] no step touches the reports API — that budget belongs to verify', () => {
    for (const step of RESOURCES) {
      const path = step.kind === 'list' ? step.path : step.path(1)
      expect(path, `${step.name} reads a reports endpoint`).not.toContain('/v2/reports/')
    }
  })

  it('[unit] every step names the envelope key it reads, and names it only once', () => {
    for (const step of RESOURCES) expect(step.collection).toBeTruthy()
    expect(new Set(NAMES).size).toBe(NAMES.length)
  })
})
