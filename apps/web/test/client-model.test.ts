import type { EzactoClient, GeneralResource, Whoami } from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import {
  clientHierarchy,
  clientIdFromPathname,
  clientProfileCanWrite,
  clientSearchMatches,
  createShellApi,
  relationLabel,
  renderClientDirectoryPages,
} from '../src/index.js'

const timestamp = '2026-09-01T12:00:00.000Z'
const client = (
  id: number,
  name: string,
  parentClientId: number | null = null,
): GeneralResource => ({
  id,
  name,
  parent_client_id: parentClientId,
  is_active: true,
  created_at: timestamp,
  updated_at: timestamp,
})

describe('Clients V1 model', () => {
  it('[unit] maps directory reads and writes to bounded generated-client operations', async () => {
    const response = { data: client(7, 'Mapped client'), links: { self: '/api/v1/clients/7' } }
    const page = { data: [], links: {}, page: { next_cursor: null } }
    const generated = {
      listClients: vi.fn(async () => page),
      getClient: vi.fn(async () => response),
      createClient: vi.fn(async () => response),
      updateClient: vi.fn(async () => response),
      deleteClient: vi.fn(async () => undefined),
      listContacts: vi.fn(async () => page),
      createContact: vi.fn(async () => response),
      updateContact: vi.fn(async () => response),
      deleteContact: vi.fn(async () => undefined),
      listProjects: vi.fn(async () => page),
    }
    const api = createShellApi(generated as unknown as EzactoClient)
    const signal = new AbortController().signal

    await api.listProjects('shared-cursor', signal)
    await api.listDirectoryClients!('client-cursor', signal)
    await api.getDirectoryClient!(7, signal)
    await api.createDirectoryClient!({ name: 'Mapped client' }, signal)
    await api.updateDirectoryClient!(7, { address: 'Updated' }, signal)
    await api.archiveDirectoryClient!(7, signal)
    await api.listClientContacts!(7, 'contact-cursor', signal)
    await api.createClientContact!({ client_id: 7, first_name: 'Alex' }, signal)
    await api.updateClientContact!(8, { first_name: 'Jordan' }, signal)
    await api.deleteClientContact!(8, signal)
    await api.listClientProjects!(7, 'project-cursor', signal)

    expect(generated.listProjects).toHaveBeenNthCalledWith(1, {
      query: { per_page: 200, is_active: true, cursor: 'shared-cursor' },
      signal,
    })
    expect(generated.listClients).toHaveBeenCalledWith({
      query: { per_page: 200, cursor: 'client-cursor' },
      signal,
    })
    expect(generated.getClient).toHaveBeenCalledWith({ id: 7, signal })
    expect(generated.createClient).toHaveBeenCalledWith({
      body: { name: 'Mapped client' },
      signal,
    })
    expect(generated.updateClient).toHaveBeenCalledWith({
      id: 7,
      body: { address: 'Updated' },
      signal,
    })
    expect(generated.deleteClient).toHaveBeenCalledWith({ id: 7, signal })
    expect(generated.listContacts).toHaveBeenCalledWith({
      query: { client_id: 7, per_page: 200, cursor: 'contact-cursor' },
      signal,
    })
    expect(generated.deleteContact).toHaveBeenCalledWith({ id: 8, signal })
    expect(generated.listProjects).toHaveBeenNthCalledWith(2, {
      query: { client_id: 7, per_page: 200, cursor: 'project-cursor' },
      signal,
    })
  })

  it('[unit] renders worked-for and bill-to relationships as distinct facts', () => {
    const markup = renderClientDirectoryPages()

    expect(markup).toContain('<dt>Worked-for parent</dt>')
    expect(markup).toContain('<dt>Bill-to client</dt>')
    expect(markup).not.toContain('Parent / bill-to')
    expect(markup).toContain('Permanently delete this contact?')
    expect(markup).toContain('cannot be undone')
    expect(markup).not.toContain('Archive this contact?')
  })

  it('[unit] builds a stable parent-first hierarchy and bounds corrupt cycles', () => {
    const rows = clientHierarchy([
      client(3, 'Grandchild', 2),
      client(1, 'Parent'),
      client(2, 'Child', 1),
      client(5, 'Cycle B', 4),
      client(4, 'Cycle A', 5),
    ])

    expect(rows.map(({ client: item, depth }) => [item.id, depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 0],
      [5, 1],
    ])
    expect(new Set(rows.map(({ client: item }) => item.id)).size).toBe(5)
    expect(relationLabel(1, rows.map(({ client: item }) => item))).toBe('Parent')
  })


  it('[unit] keeps the ancestors of a match so the tree still says who owns whom', () => {
    const clients = [
      client(1, 'Parent Holding'),
      client(2, 'Worked-For Studio', 1),
      client(3, 'Grandchild Unit', 2),
      client(4, 'Unrelated'),
    ]

    expect(clientSearchMatches(clients, 'grandchild').map((row) => row.name)).toEqual([
      'Parent Holding',
      'Worked-For Studio',
      'Grandchild Unit',
    ])
    // A parent that matches does not drag its children in with it: the query
    // named the parent, not the work under it.
    expect(clientSearchMatches(clients, 'parent').map((row) => row.name)).toEqual([
      'Parent Holding',
    ])
    expect(clientSearchMatches(clients, '  ').map((row) => row.id)).toEqual([1, 2, 3, 4])
    expect(clientSearchMatches(clients, 'nothing')).toEqual([])
  })

  it('[unit] bounds a parent cycle rather than climbing it forever', () => {
    // clientHierarchy already treats a cycle as roots; the search must survive
    // the same corrupt data rather than hanging the list that renders it.
    const cycle = [
      { ...client(1, 'One'), parent_client_id: 2 },
      { ...client(2, 'Two'), parent_client_id: 1 },
    ]

    expect(clientSearchMatches(cycle, 'one').map((row) => row.id)).toEqual([1, 2])
  })
  it.each([
    ['member', false],
    ['people_admin', false],
    ['project_manager', true],
    ['accounting', true],
    ['executive_manager', true],
    ['administrator', true],
  ] satisfies ReadonlyArray<readonly [Whoami['profile'], boolean]>) (
    '[unit] maps %s to clients:write visibility %s',
    (profile, expected) => {
      expect(clientProfileCanWrite(profile)).toBe(expected)
    },
  )

  it.each([
    ['/clients/1', 1],
    ['/clients/42/', 42],
    ['/clients/0', null],
    ['/clients/-1', null],
    ['/clients/nope', null],
    ['/clients/9007199254740992', null],
  ])('[unit] parses safe client path %s', (path, expected) => {
    expect(clientIdFromPathname(path)).toBe(expected)
  })
})
