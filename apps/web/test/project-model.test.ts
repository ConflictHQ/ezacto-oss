import type { EzactoClient, GeneralResource, Whoami } from '@conflict-hq/ezacto-client'
import { describe, expect, it, vi } from 'vitest'
import {
  createShellApi,
  projectCapabilities,
  projectClientLabel,
  projectCurrency,
  projectDisplayName,
  projectIdFromPathname,
  projectMoney,
} from '../src/index.js'

const timestamp = '2026-09-01T12:00:00.000Z'
const resource = (id: number, name: string): GeneralResource => ({
  id,
  name,
  created_at: timestamp,
  updated_at: timestamp,
})

describe('Projects V1 model', () => {
  it('[unit] maps the complete project workspace to generated-client operations', async () => {
    const project = { ...resource(7, 'Mapped project'), client_id: 3 }
    const response = { data: project, links: { self: '/api/v1/projects/7' } }
    const page = { data: [], links: {}, page: { next_cursor: null } }
    const attachment = {
      id: 9,
      name: 'scope.txt',
      content_hash: 'a'.repeat(64),
      byte_size: 5,
      content_type: 'text/plain',
      uploaded_by_user_id: 1,
      created_at: timestamp,
      updated_at: timestamp,
    }
    const generated = {
      listProjects: vi.fn(async () => page),
      listClients: vi.fn(async () => page),
      getProject: vi.fn(async () => response),
      createProject: vi.fn(async () => response),
      updateProject: vi.fn(async () => response),
      deleteProject: vi.fn(async () => undefined),
      listTasks: vi.fn(async () => page),
      listTaskAssignments: vi.fn(async () => page),
      createTaskAssignment: vi.fn(async () => response),
      updateTaskAssignment: vi.fn(async () => response),
      deleteTaskAssignment: vi.fn(async () => undefined),
      listProjectAttachments: vi.fn(async () => ({ data: [attachment], links: {} })),
      createProjectAttachment: vi.fn(async () => ({ data: attachment, links: {} })),
    }
    const api = createShellApi(generated as unknown as EzactoClient)
    const signal = new AbortController().signal
    const form = new FormData()
    form.set('file', new File(['scope'], 'scope.txt'))

    await api.listDirectoryProjects!('project-cursor', signal)
    await api.listProjectClients!('client-cursor', signal)
    await api.getDirectoryProject!(7, signal)
    await api.createDirectoryProject!({ client_id: 3, name: 'Mapped project' }, signal)
    await api.updateDirectoryProject!(7, { name: 'Updated' }, signal)
    await api.archiveDirectoryProject!(7, signal)
    await api.listDirectoryTasks!('task-cursor', signal)
    await api.listProjectTaskAssignments!(7, 'assignment-cursor', signal)
    await api.createProjectTaskAssignment!({ project_id: 7, task_id: 2 }, signal)
    await api.updateProjectTaskAssignment!(8, { billable: false }, signal)
    await api.archiveProjectTaskAssignment!(8, signal)
    await api.listDirectoryProjectAttachments!(7, signal)
    await api.uploadDirectoryProjectAttachment!(7, 'project-file', form, signal)

    expect(generated.listProjects).toHaveBeenCalledWith({
      query: { per_page: 200, cursor: 'project-cursor' },
      signal,
    })
    expect(generated.listClients).toHaveBeenCalledWith({
      query: { per_page: 200, cursor: 'client-cursor' },
      signal,
    })
    expect(generated.getProject).toHaveBeenCalledWith({ id: 7, signal })
    expect(generated.deleteProject).toHaveBeenCalledWith({ id: 7, signal })
    expect(generated.listTasks).toHaveBeenCalledWith({
      query: { per_page: 200, cursor: 'task-cursor' },
      signal,
    })
    expect(generated.listTaskAssignments).toHaveBeenCalledWith({
      query: { project_id: 7, per_page: 200, cursor: 'assignment-cursor' },
      signal,
    })
    expect(generated.deleteTaskAssignment).toHaveBeenCalledWith({ id: 8, signal })
    expect(generated.createProjectAttachment).toHaveBeenCalledWith({
      projectId: 7,
      'Idempotency-Key': 'project-file',
      body: form,
      signal,
    })
  })

  it.each([
    ['member', [], false, false, false, false],
    ['people_admin', [], false, false, false, false],
    ['accounting', [], false, false, false, false],
    ['project_manager', [], true, false, false, false],
    ['project_manager', ['billable_rates_manager'], true, true, false, false],
    ['executive_manager', [], true, true, true, false],
    ['administrator', [], true, true, true, true],
  ] satisfies ReadonlyArray<
    readonly [Whoami['profile'], readonly string[], boolean, boolean, boolean, boolean]
  >)(
    '[security] maps %s with grants %j to exact project field capabilities',
    (profile, manager_grants, canWrite, canViewBillableMoney, canViewCostBudget, canViewNotes) => {
      expect(projectCapabilities({ profile, manager_grants })).toEqual({
        canWrite,
        canManageCommercialTerms: canViewBillableMoney || profile === 'accounting',
        canViewBillableMoney,
        canViewCostBudget,
        canViewNotes,
      })
    },
  )

  it.each([
    ['/projects/1', 1],
    ['/projects/42/', 42],
    ['/projects/0', null],
    ['/projects/-1', null],
    ['/projects/nope', null],
    ['/projects/9007199254740992', null],
  ])('[security] parses only safe project path %s', (path, expected) => {
    expect(projectIdFromPathname(path)).toBe(expected)
  })

  it('[unit] renders project and client labels without trusting absent fields', () => {
    const client = resource(3, 'Acme')
    const project = { ...resource(7, 'Launch'), client_id: 3, code: 'WEB' }
    expect(projectDisplayName(project)).toBe('[WEB] Launch')
    expect(projectClientLabel(project, [client])).toBe('Acme')
    expect(projectClientLabel({ ...project, client_id: 99 }, [client])).toBe('Client #99')
    expect(projectCurrency(project, [{ ...client, currency: 'CAD' }])).toBe('CAD')
    expect(projectCurrency({ ...project, billing_currency: 'EUR' }, [client])).toBe('EUR')
    expect(projectMoney(12_345, 'invalid')).toBe('$123.45')
  })
})
