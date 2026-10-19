import { describe, expect, it } from 'vitest'
import {
  isWorkItemProvider,
  normalizeWorkItemId,
  normalizeWorkItemUrl,
  workItemProviders,
} from '../src/work-item.js'

describe('work item rules', () => {
  it('[unit] knows its providers and nothing inherited from an object', () => {
    expect(isWorkItemProvider('github')).toBe(true)
    for (const value of ['jira', 'toString', '__proto__', 'constructor', 1, null, undefined]) {
      expect(isWorkItemProvider(value)).toBe(false)
    }
    expect(workItemProviders.github.credentialSecret).toBe('GITHUB_WORK_ITEMS_CREDENTIAL')
  })

  it('[unit] keeps an item id as one printable token', () => {
    expect(normalizeWorkItemId('  owner/repo#12 ')).toBe('owner/repo#12')
    for (const bad of ['', '   ', 'two words', 'tab\tbed', 'nul\u0000', 'x'.repeat(257)]) {
      expect(() => normalizeWorkItemId(bad)).toThrow(RangeError)
    }
  })

  it('[security] stores only absolute http(s) addresses', () => {
    expect(normalizeWorkItemUrl('https://github.com/o/r/issues/1')).toBe(
      'https://github.com/o/r/issues/1',
    )
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      '/relative',
      'ftp://x.test/a',
      '',
      `https://x.test/${'a'.repeat(2048)}`,
    ]) {
      expect(() => normalizeWorkItemUrl(bad)).toThrow(RangeError)
    }
  })
})
