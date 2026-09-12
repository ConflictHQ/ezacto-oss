import type { GeneralResource, Whoami } from '@conflict-hq/ezacto-client'

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
  /**
   * Whether this client is billed through BILL (issue 542). Optional because a
   * deployment that composes no BILL runtime does not mount the routes, and a
   * control that answers 404 is worse than no control.
   */
  getBillClientDelivery?(
    clientId: number,
    signal?: AbortSignal,
  ): Promise<{ deliver_via_bill: boolean }>
  setBillClientDelivery?(
    clientId: number,
    deliverViaBill: boolean,
    signal?: AbortSignal,
  ): Promise<{ deliver_via_bill: boolean }>
  /** Whether this deployment can reach BILL at all, and how it delivers. */
  getBillStatus?(signal?: AbortSignal): Promise<{
    configured: boolean
    can_send_from_bill: boolean
  }>
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

/**
 * The rows a search leaves standing. A match keeps its ancestors even when they
 * do not match themselves: the list is a tree, and dropping a parent because the
 * query only names its child reparents the child to the root and quietly says
 * the wrong thing about who is worked for by whom.
 */
export const clientSearchMatches = (
  clients: readonly GeneralResource[],
  query: string,
): readonly GeneralResource[] => {
  const wanted = query.trim().toLocaleLowerCase('en-US')
  if (wanted === '') return clients
  const byId = new Map(clients.map((client) => [client.id, client]))
  const kept = new Set<number>()
  for (const client of clients) {
    if (!clientDisplayName(client).toLocaleLowerCase('en-US').includes(wanted)) continue
    let ancestor: GeneralResource | undefined = client
    // The same bound the hierarchy uses: a corrupt parent cycle must not spin.
    while (ancestor !== undefined && !kept.has(ancestor.id)) {
      kept.add(ancestor.id)
      const parent = clientNumber(ancestor, 'parent_client_id')
      ancestor = parent === null ? undefined : byId.get(parent)
    }
  }
  return clients.filter((client) => kept.has(client.id))
}

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
