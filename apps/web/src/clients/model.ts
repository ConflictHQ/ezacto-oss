import type {
  ClientHierarchyNode,
  ClientRollupNode,
  ClientRollupReport,
  GeneralResource,
  Invoice,
  Retainer,
  Whoami,
} from '@conflict-hq/ezacto-client'
import { invoiceObligations, type InvoiceObligation } from '../dashboard/model.js'
import { canReadFinancialReports } from '../reports/model.js'
import { retainerCurrency } from '../retainers/model.js'

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
  /** The closure rows rooted at this client, the client itself included. */
  listClientSubtree(
    clientId: number,
    signal?: AbortSignal,
  ): Promise<readonly ClientHierarchyNode[]>
  /**
   * The subtree's unpaid obligations, asked for as a set of client ids in one
   * request rather than one request per node. `state=open` is applied by the
   * server as well as by the model, so a page of drafts never crosses the wire
   * to be discarded here.
   */
  listClientOpenInvoices(
    clientIds: readonly number[],
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ClientDirectoryPage<Invoice>>
  listClientRetainers(
    clientIds: readonly number[],
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ClientDirectoryPage<Retainer>>
  /**
   * Shared verbatim with the reports workspace -- same operation, same
   * signature -- so the 360 and the client-rollup report cannot disagree about
   * what the subtree consumed.
   */
  getClientRollupReport(
    clientId: number,
    filter: { readonly from: string; readonly to: string },
    signal?: AbortSignal,
  ): Promise<ClientRollupReport>
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

/**
 * The three figures that make a client page a 360, and the arithmetic behind
 * them.
 *
 * All three are rollups over the client subtree rather than over one client,
 * because a holding company that is invoiced through its children is owed
 * nothing on its own row and that is not the answer anybody wants. The subtree
 * is `/clients/:id/descendants`, which is the closure of the hierarchy view and
 * already carries its own cycle bound.
 *
 * The one thing every function here is built around: a subtree spans
 * currencies. `packages/db/src/invoice-generation.ts` refuses to generate an
 * invoice from a mixed-currency selection rather than sum across it, and this
 * screen owes the equivalent -- each figure is grouped by currency and there is
 * no blended total anywhere, because a blended total is a wrong number that
 * looks right.
 */

/**
 * Whether the 360 figures are this person's to see.
 *
 * The three of them sit behind two API scopes -- `invoices:read` for the
 * invoice and retainer lists, `reports:read` for the rollup -- and
 * `apiScopeProfiles` gives both the same three profiles, so one predicate
 * answers for the whole section rather than three-quarters of it appearing and
 * the rest failing. It delegates to the reports screen's predicate rather than
 * restating the list, because a second copy of a permission rule is free to
 * drift from the first.
 *
 * Checked before the requests rather than after. A 403 arrives as a failure
 * message that says nothing about why the section is empty, and an empty
 * section reads as "this client owes nothing" -- a different statement, and a
 * false one.
 */
export const clientProfileCanReadMoney = (profile: Whoami['profile']): boolean =>
  canReadFinancialReports(profile)

/**
 * Every client id in the subtree rooted at this one, the root included.
 *
 * Rows anchored anywhere else are dropped. The endpoint is rooted, so they
 * should not arrive; keeping the check means a mis-wired call rolls up nothing
 * rather than a stranger's money.
 */
export const clientSubtreeIds = (
  rootId: number,
  nodes: readonly ClientHierarchyNode[],
): readonly number[] => {
  const ids = new Set<number>([rootId])
  for (const node of nodes) {
    if (node.ancestor_id === rootId) ids.add(node.descendant_id)
  }
  return [...ids].sort((left, right) => left - right)
}

/**
 * What the subtree is owed, per currency.
 *
 * "Owed" is the dashboard's definition and is imported rather than restated:
 * only an open invoice is owed, a draft has not been sent, and a paid or closed
 * one is settled however it got that way. Two screens disagreeing about what an
 * open invoice is would be two different answers to one question.
 *
 * Invoices outside the subtree are dropped here as well as in the request. The
 * server applies the `client_id` filter; this is what stands between a filter
 * that did not arrive -- an older worker, a proxy that ate the query string --
 * and another client's debt rendered as this one's.
 */
export const clientOpenInvoiceTotals = (
  invoices: readonly Invoice[],
  subtreeIds: readonly number[],
  today: string,
): readonly InvoiceObligation[] => {
  const wanted = new Set(subtreeIds)
  return invoiceObligations(
    invoices.filter((invoice) => wanted.has(invoice.client_id)),
    today,
  )
}

export interface ClientRetainerBalance {
  readonly denomination: Retainer['denomination']
  /**
   * The client's currency on a money retainer; null on an hours one, which is
   * measured in seconds and has no currency to be in.
   */
  readonly currency: string | null
  readonly count: number
  /** Cents when the denomination is money, seconds when it is hours. */
  readonly balance: number
}

/**
 * What remains on retainer across the subtree, grouped by denomination and then
 * by currency.
 *
 * Both axes are load-bearing and neither can be collapsed. A `balance` is cents
 * on a money retainer and seconds on an hours one, so adding the two gives a
 * number in no unit at all. And a retainer carries no currency of its own --
 * it borrows its client's -- so a subtree whose children bill in different
 * currencies has balances that cannot be added either.
 *
 * A retainer with no client belongs to no subtree and is left out rather than
 * attributed to the root: `client_id` is nullable, and the Harvest cutover
 * leaves it unset on a stub until the opening balance is reconciled.
 */
export const clientRetainerBalances = (
  retainers: readonly Retainer[],
  subtreeIds: readonly number[],
  clients: readonly GeneralResource[],
): readonly ClientRetainerBalance[] => {
  const wanted = new Set(subtreeIds)
  const buckets = new Map<string, {
    denomination: Retainer['denomination']
    currency: string | null
    count: number
    balance: number
  }>()
  for (const retainer of retainers) {
    if (retainer.client_id === null || !wanted.has(retainer.client_id)) continue
    const currency =
      retainer.denomination === 'money' ? retainerCurrency(retainer, clients) : null
    const key = `${retainer.denomination}:${currency ?? ''}`
    const bucket = buckets.get(key) ?? {
      denomination: retainer.denomination,
      currency,
      count: 0,
      balance: 0,
    }
    bucket.count += 1
    bucket.balance += retainer.balance
    buckets.set(key, bucket)
  }
  // Money before hours, then by currency, so the order is the same on every
  // client rather than the order the pages happened to arrive in.
  return [...buckets.values()].sort((left, right) =>
    left.denomination === right.denomination
      ? (left.currency ?? '').localeCompare(right.currency ?? '', 'en-US')
      : left.denomination === 'money'
        ? -1
        : 1,
  )
}

export interface ClientBudgetBurn {
  readonly currency: string
  readonly costCents: number
  readonly expenseCents: number
  /** Cost plus expense, in this bucket's currency and no other. */
  readonly burnCents: number
}

export const clientRollupNodeFor = (
  report: Readonly<ClientRollupReport>,
  clientId: number,
): ClientRollupNode | null =>
  report.nodes.find((node) => node.client_id === clientId) ?? null

/**
 * What the subtree consumed in the report's window, per currency.
 *
 * Deliberately not the payload's own `budget_burn_cents`. That field sums cost
 * and expense across every currency bucket into one integer, so on a subtree
 * that spans currencies it is exactly the blended total this screen exists not
 * to show. Each entry of `currencies[]` is denominated in one currency by
 * construction -- cost rates are bucketed under the organization's currency
 * because they carry none of their own, expenses under the project's billing
 * currency -- so cost plus expense within a bucket is an amount in that
 * bucket's currency and nothing else.
 *
 * Null, not an empty list, when the serializer withheld `cost_cents`. A figure
 * the server declined to send is absent; "we did not tell you" and "nothing was
 * spent" are different statements and only one of them is a fact about the
 * business.
 */
export const clientBudgetBurn = (
  node: Readonly<ClientRollupNode>,
): readonly ClientBudgetBurn[] | null => {
  const burns: ClientBudgetBurn[] = []
  for (const bucket of node.rollup.currencies) {
    if (bucket.cost_cents === undefined) return null
    burns.push({
      currency: bucket.currency,
      costCents: bucket.cost_cents,
      expenseCents: bucket.expense_cents,
      burnCents: bucket.cost_cents + bucket.expense_cents,
    })
  }
  return burns.sort((left, right) => right.burnCents - left.burnCents)
}

/**
 * The window the burn figure covers. Month to date, which is the window the
 * reports screen opens on, so the two agree and the 360's link lands on the
 * same numbers rather than a differently-bounded near-match. Burn over an
 * unstated range is not a fact, so the screen prints this range beside it.
 */
export const clientBurnWindow = (
  today: string,
): { readonly from: string; readonly to: string } => ({
  from: `${today.slice(0, 8)}01`,
  to: today,
})

export const clientRollupHref = (
  clientId: number,
  window: { readonly from: string; readonly to: string },
): string =>
  `/reports?report=client-rollup&from=${window.from}&to=${window.to}&client_id=${clientId}`

/**
 * A client figure, in the currency it was billed in.
 *
 * Named and living here rather than at the call site, which is what the money
 * guards are for: a list of formatter names cannot see an amount built inline,
 * and an amount it cannot see is one the hide-money toggle leaves on screen.
 *
 * A currency the organization typed in is not necessarily one ICU knows, and a
 * client screen is not the place to throw over it -- the same guard the expense
 * and project screens carry around the same call.
 */
export const clientMoney = (cents: number, currency: string): string => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
  } catch {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
      cents / 100,
    )
  }
}
