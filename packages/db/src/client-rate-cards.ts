import {
  assertRateCardLines,
  assertRateCardName,
  pickRateCardLine,
  RateCardClientNotFoundError,
  RateCardExistsError,
  RateCardNotFoundError,
  RateCardTaskNotFoundError,
  RateCardVersionOrderError,
  type ClientRateCardRecord,
  type EffectiveClientRateCard,
  type RateCard,
  type RateCardContext,
  type RateCardLine,
  type RateCardVersionRecord,
} from '@ezacto/core'
import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { listClientAncestors } from './operations.js'
import {
  clientRateCards,
  clientRateCardVersions,
  clients,
  tasks,
} from './schema.js'
import type * as schema from './schema.js'

/**
 * Client rate cards (issue 34, slice B). A card hangs on one client node; the
 * resolver reads the cards of a client and its ancestors through `parent_client_id`
 * only, never the bill-to relation. Writing a card changes what later work
 * resolves to; it never touches an entry, an entry's snapshot or an invoice.
 */

type Database =
  | BetterSQLite3Database<typeof schema>
  | DrizzleD1Database<typeof schema>

interface StoredLine {
  task_id: number | null
  amount_cents: number
}

const hasMessage = (error: unknown, pattern: RegExp): boolean => {
  const seen = new Set<unknown>()
  let current = error
  while (current instanceof Error && !seen.has(current) && seen.size < 8) {
    if (pattern.test(current.message)) return true
    seen.add(current)
    current = (current as Error & { cause?: unknown }).cause
  }
  return false
}

const encodeLines = (lines: readonly RateCardLine[]): string =>
  JSON.stringify(
    lines.map((line): StoredLine => ({ task_id: line.taskId, amount_cents: line.amountCents })),
  )

const decodeLines = (raw: string): RateCardLine[] =>
  (JSON.parse(raw) as StoredLine[]).map((line) => ({
    taskId: line.task_id,
    amountCents: line.amount_cents,
  }))

/** Oldest first; a null start ("all prior") sorts before every date. */
const byStart = (
  left: { startDate: string | null },
  right: { startDate: string | null },
): number => (left.startDate ?? '').localeCompare(right.startDate ?? '')

/** Version rows for these cards, grouped by card id. */
const loadVersions = async (
  database: Database,
  cardIds: readonly number[],
): Promise<Map<number, RateCardVersionRecord[]>> => {
  const grouped = new Map<number, RateCardVersionRecord[]>()
  if (cardIds.length === 0) return grouped
  const rows = await database
    .select()
    .from(clientRateCardVersions)
    .where(inArray(clientRateCardVersions.cardId, [...cardIds]))
  for (const row of rows) {
    const list = grouped.get(row.cardId) ?? []
    list.push({
      id: row.id,
      startDate: row.startDate,
      lines: decodeLines(row.lines),
      createdAt: row.createdAt,
    })
    grouped.set(row.cardId, list)
  }
  for (const list of grouped.values()) list.sort(byStart)
  return grouped
}

/** Cards of the client and its ancestors, nearest first; nodes without a card are absent. */
const loadChain = async (
  database: Database,
  clientId: number,
): Promise<Array<{ depth: number; card: typeof clientRateCards.$inferSelect; versions: RateCardVersionRecord[] }>> => {
  const ancestors = await listClientAncestors(database, clientId)
  if (ancestors.length === 0) throw new RateCardClientNotFoundError()
  const depthOf = new Map(ancestors.map((node) => [node.ancestorId, node.depth]))
  const cards = await database
    .select()
    .from(clientRateCards)
    .where(inArray(clientRateCards.clientId, [...depthOf.keys()]))
  const versions = await loadVersions(
    database,
    cards.map((card) => card.id),
  )
  return cards
    .map((card) => ({
      depth: depthOf.get(card.clientId)!,
      card,
      versions: versions.get(card.id) ?? [],
    }))
    .sort((left, right) => left.depth - right.depth)
}

type Chain = Awaited<ReturnType<typeof loadChain>>

const toContext = (chain: Chain, taskId: number): RateCardContext => ({
  taskId,
  cards: chain.map(({ card, versions }): RateCard => ({
    clientId: card.clientId,
    versions: versions.map(({ startDate, lines }) => ({ startDate, lines })),
  })),
})

/**
 * The rate-card input for the pure resolver: the project client's own card and
 * every ancestor's, nearest first. Empty when no node on the chain has a card,
 * which resolves exactly as it did before cards existed.
 */
export const loadRateCardContext = async (
  database: Database,
  clientId: number,
  taskId: number,
): Promise<RateCardContext> => {
  return toContext(await loadChain(database, clientId), taskId)
}

const toRecord = (
  card: typeof clientRateCards.$inferSelect,
  versions: readonly RateCardVersionRecord[],
): ClientRateCardRecord => ({
  id: card.id,
  clientId: card.clientId,
  name: card.name,
  createdAt: card.createdAt,
  versions,
})

export interface ClientRateCardRepository {
  /** The card attached directly to this client, or null; inheritance is not applied. */
  get(clientId: number): Promise<ClientRateCardRecord | null>
  create(clientId: number, input: { name: string }, now: string): Promise<ClientRateCardRecord>
  appendVersion(
    clientId: number,
    input: { startDate: string | null; lines: readonly RateCardLine[] },
    now: string,
  ): Promise<ClientRateCardRecord>
  /** Which card, from which node, prices this task on this date; throws RateCardNotFoundError if none. */
  effective(clientId: number, taskId: number, spentDate: string): Promise<EffectiveClientRateCard>
}

export const createClientRateCardRepository = (database: Database): ClientRateCardRepository => {
  const requireClient = async (clientId: number): Promise<void> => {
    const [row] = await database
      .select()
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1)
    if (row === undefined) throw new RateCardClientNotFoundError()
  }

  const get = async (clientId: number): Promise<ClientRateCardRecord | null> => {
    await requireClient(clientId)
    const [card] = await database
      .select()
      .from(clientRateCards)
      .where(eq(clientRateCards.clientId, clientId))
      .limit(1)
    if (card === undefined) return null
    const versions = await loadVersions(database, [card.id])
    return toRecord(card, versions.get(card.id) ?? [])
  }

  return {
    get,

    async create(clientId, input, now) {
      assertRateCardName(input.name)
      await requireClient(clientId)
      try {
        const [card] = await database
          .insert(clientRateCards)
          .values({ clientId, name: input.name.trim(), createdAt: now, updatedAt: now })
          .returning()
        return toRecord(card!, [])
      } catch (error) {
        if (hasMessage(error, /UNIQUE constraint failed: client_rate_cards\.client_id/i)) {
          throw new RateCardExistsError()
        }
        throw error
      }
    },

    async appendVersion(clientId, input, now) {
      assertRateCardLines(input.lines)
      const existing = await get(clientId)
      if (existing === null) throw new RateCardNotFoundError()
      const taskIds = input.lines.flatMap((line) => (line.taskId === null ? [] : [line.taskId]))
      if (taskIds.length > 0) {
        const found = await database
          .select()
          .from(tasks)
          .where(inArray(tasks.id, taskIds))
        const known = new Set(found.map((row) => row.id))
        const missing = taskIds.find((id) => !known.has(id))
        if (missing !== undefined) throw new RateCardTaskNotFoundError(missing)
      }
      try {
        await database.insert(clientRateCardVersions).values({
          cardId: existing.id,
          startDate: input.startDate,
          lines: encodeLines(input.lines),
          createdAt: now,
        })
      } catch (error) {
        if (
          hasMessage(error, /rate card versions must be appended chronologically/i) ||
          hasMessage(error, /UNIQUE constraint failed: client_rate_card_versions\./i)
        ) {
          throw new RateCardVersionOrderError()
        }
        throw error
      }
      const after = await get(clientId)
      return after!
    },

    async effective(clientId, taskId, spentDate) {
      const chain = await loadChain(database, clientId)
      const context = toContext(chain, taskId)
      const pick = pickRateCardLine(spentDate, context)
      if (pick === null) throw new RateCardNotFoundError()
      const supplier = chain[pick.position]!
      return {
        clientId,
        suppliedByClientId: pick.clientId,
        depth: supplier.depth,
        cardId: supplier.card.id,
        cardName: supplier.card.name,
        versionStartDate: pick.versionStartDate,
        taskId: pick.taskId,
        amountCents: pick.amountCents,
      }
    },
  }
}
