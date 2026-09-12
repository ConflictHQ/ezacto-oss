import type { EzactoClient, Whoami } from '@conflict-hq/ezacto-client'
import { describe, expect, it, vi } from 'vitest'
import {
  createShellApi,
  formatTaskRate,
  parseTaskRateCents,
  taskAdminCapabilities,
  taskRateInputValue,
} from '../src/index.js'

const identity = (
  profile: Whoami['profile'],
  manager_grants: readonly string[] = [],
  scopes?: readonly ('projects:read' | 'projects:write')[],
): Whoami => ({
  user_id: 1,
  profile,
  manager_grants: [...manager_grants],
  authentication:
    scopes === undefined
      ? { kind: 'session' }
      : { kind: 'token', token_id: 3, scopes: [...scopes] },
})

describe('Tasks administration model', () => {
  it('[unit] maps list/create/update/archive through the generated client', async () => {
    const task = {
      id: 7,
      name: 'Implementation',
      created_at: '2026-09-02T00:00:00.000Z',
      updated_at: '2026-09-02T00:00:00.000Z',
    }
    const generated = {
      listTasks: vi.fn(async () => ({
        data: [task],
        page: { next_cursor: null },
        links: {},
      })),
      createTask: vi.fn(async () => ({ data: task, links: {} })),
      updateTask: vi.fn(async () => ({ data: task, links: {} })),
      deleteTask: vi.fn(async () => undefined),
    }
    const api = createShellApi(generated as unknown as EzactoClient)
    const signal = new AbortController().signal

    await api.listAdminTasks!('active', 'next', signal)
    await api.listAdminTasks!('all', undefined, signal)
    await api.listAdminTasks!('archived', undefined, signal)
    await api.createAdminTask!({ name: 'Implementation' }, signal)
    await api.updateAdminTask!(7, { name: 'Delivery' }, signal)
    await api.archiveAdminTask!(7, signal)

    expect(generated.listTasks).toHaveBeenNthCalledWith(1, {
      query: { per_page: 50, is_active: true, cursor: 'next' },
      signal,
    })
    expect(generated.listTasks).toHaveBeenNthCalledWith(2, {
      query: { per_page: 50 },
      signal,
    })
    // #486: the archived view is a request, not a client-side narrowing --
    // this list is paged, so the rows it never fetched cannot be filtered for.
    expect(generated.listTasks).toHaveBeenNthCalledWith(3, {
      query: { per_page: 50, is_active: false },
      signal,
    })
    expect(generated.createTask).toHaveBeenCalledWith({
      body: { name: 'Implementation' },
      signal,
    })
    expect(generated.updateTask).toHaveBeenCalledWith({
      id: 7,
      body: { name: 'Delivery' },
      signal,
    })
    expect(generated.deleteTask).toHaveBeenCalledWith({ id: 7, signal })
  })

  it.each([
    [identity('member'), true, false, false],
    [identity('people_admin'), true, false, false],
    [identity('accounting'), true, false, true],
    [identity('project_manager'), true, true, false],
    [identity('project_manager', ['billable_rates_manager']), true, true, true],
    [identity('executive_manager'), true, true, true],
    [identity('administrator'), true, true, true],
    [identity('administrator', [], []), false, false, true],
    [identity('administrator', [], ['projects:read']), true, false, true],
    [identity('administrator', [], ['projects:write']), false, false, true],
    [identity('member', [], ['projects:read', 'projects:write']), true, false, false],
  ] satisfies ReadonlyArray<readonly [Whoami, boolean, boolean, boolean]>)(
    '[security] applies profile, grant, and token scope ceilings %#',
    (whoami, canRead, canWrite, canViewRate) => {
      expect(taskAdminCapabilities(whoami)).toEqual({ canRead, canWrite, canViewRate })
    },
  )

  it.each([
    ['', null],
    ['0', 0],
    ['1', 100],
    ['1.2', 120],
    ['123.45', 12_345],
    [' 9.01 ', 901],
  ])('[unit] parses exact cents from %j', (raw, expected) => {
    expect(parseTaskRateCents(raw)).toBe(expected)
  })

  it.each(['-1', '.5', '1.', '1.234', '1e3', 'NaN', '01.00'])(
    '[unit] rejects ambiguous or invalid rate %j',
    (raw) => expect(() => parseTaskRateCents(raw)).toThrow(),
  )

  it('[unit] formats stable money labels and input values', () => {
    expect(formatTaskRate(12_345)).toBe('$123.45/hour')
    expect(formatTaskRate(null)).toBe('No default rate')
    expect(taskRateInputValue(12_305)).toBe('123.05')
    expect(taskRateInputValue(null)).toBe('')
  })
})
