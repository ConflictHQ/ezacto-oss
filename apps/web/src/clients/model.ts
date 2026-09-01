import type { GeneralResource, Whoami } from '@ezacto/client'

export type ClientDirectoryPage<T = GeneralResource> = {
  readonly data: readonly T[]
  readonly page: { readonly next_cursor: string | null }
}

export interface ClientDirectoryApi {
  listDirectoryClients(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ClientDirectoryPage>
  getDirectoryClient(id: number, signal?: AbortSignal): Promise<GeneralResource>
  createDirectoryClient(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GeneralResource>
  updateDirectoryClient(
    id: number,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GeneralResource>
  archiveDirectoryClient(id: number, signal?: AbortSignal): Promise<void>
  listClientContacts(
    clientId: number,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ClientDirectoryPage>
  createClientContact(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GeneralResource>
  updateClientContact(
    id: number,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GeneralResource>
  deleteClientContact(id: number, signal?: AbortSignal): Promise<void>
  listClientProjects(
    clientId: number,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ClientDirectoryPage>
}

export interface ClientHierarchyRow {
  readonly client: GeneralResource
  readonly depth: number
}

export const clientProfileCanWrite = (profile: Whoami['profile']): boolean =>
  profile === 'project_manager' ||
  profile === 'accounting' ||
  profile === 'executive_manager' ||
  profile === 'administrator'

export const clientIdFromPathname = (pathname: string): number | null => {
  const match = /^\/clients\/([1-9][0-9]*)\/?$/u.exec(pathname)
  if (match === null) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : null
}

export const clientText = (
  resource: Readonly<GeneralResource>,
  field: string,
): string | null => {
  const value = resource[field]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export const clientNumber = (
  resource: Readonly<GeneralResource>,
  field: string,
): number | null => {
  const value = resource[field]
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
}

export const clientIsActive = (resource: Readonly<GeneralResource>): boolean =>
  resource['is_active'] !== false

export const clientDisplayName = (resource: Readonly<GeneralResource>): string =>
  clientText(resource, 'name') ?? `Client #${resource.id}`

const compareClients = (left: GeneralResource, right: GeneralResource): number => {
  const byName = clientDisplayName(left).localeCompare(
    clientDisplayName(right),
    'en-US',
    { sensitivity: 'base' },
  )
  return byName === 0 ? left.id - right.id : byName
}

/**
 * Produces a stable parent-first hierarchy. Invalid or missing parent links are
 * treated as roots, and the visited set keeps hostile/corrupt cycles bounded.
 */
export const clientHierarchy = (
  clients: readonly GeneralResource[],
): readonly ClientHierarchyRow[] => {
  const visibleIds = new Set(clients.map((client) => client.id))
  const children = new Map<number | null, GeneralResource[]>()
  for (const client of clients) {
    const parent = clientNumber(client, 'parent_client_id')
    const key = parent !== null && visibleIds.has(parent) && parent !== client.id ? parent : null
    const group = children.get(key) ?? []
    group.push(client)
    children.set(key, group)
  }
  for (const group of children.values()) group.sort(compareClients)

  const rows: ClientHierarchyRow[] = []
  const visited = new Set<number>()
  const append = (client: GeneralResource, depth: number): void => {
    if (visited.has(client.id)) return
    visited.add(client.id)
    rows.push({ client, depth })
    for (const child of children.get(client.id) ?? []) append(child, depth + 1)
  }
  for (const root of children.get(null) ?? []) append(root, 0)
  for (const client of [...clients].sort(compareClients)) append(client, 0)
  return rows
}

export const relationLabel = (
  id: number | null,
  clients: readonly GeneralResource[],
): string => {
  if (id === null) return 'None'
  const match = clients.find((client) => client.id === id)
  return match === undefined ? `Client #${id}` : clientDisplayName(match)
}
