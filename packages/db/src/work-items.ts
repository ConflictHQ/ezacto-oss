import {
  normalizeWorkItemId,
  normalizeWorkItemUrl,
  WorkItemConnectionInactiveError,
  WorkItemConnectionNotFoundError,
  WorkItemLinkExistsError,
  WorkItemLinkNotFoundError,
  WorkItemTargetNotFoundError,
  workItemProviders,
  type WorkItemConnectionStatus,
  type WorkItemProviderId,
} from '@ezacto/core'
import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm'
import { projects, timeEntries, workItemConnections, workItemLinks } from './schema.js'
import type {
  ResourceSource,
  ResourceWindow,
  TrackedResourceDatabase,
} from './tracked-resource-repository.js'

/**
 * The work-item store (issue 1008, slice 1): which trackers this instance has
 * connected and which tracker item a time entry or project points at.
 *
 * Provider-free. Nothing here reaches a tracker, and nothing here holds a
 * credential: a connection records the name of the deployment secret that does,
 * and the record type has no field a secret value could travel in.
 *
 * Reads and writes of links are scoped to the actor. An administrator may link
 * anything; anyone else may link and see only their own time entries, and a
 * link that is not theirs is indistinguishable from one that does not exist.
 */

export interface WorkItemActor {
  readonly userId: number
  readonly profile: string
}

export interface WorkItemConnectionRecord {
  id: number
  provider: WorkItemProviderId
  status: WorkItemConnectionStatus
  ownerUserId: number
  /** The deployment secret's name, never its value. Null once disconnected. */
  credentialRef: string | null
  connectedAt: string
  disconnectedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface WorkItemLinkRecord {
  id: number
  connectionId: number
  provider: WorkItemProviderId
  timeEntryId: number | null
  projectId: number | null
  providerItemId: string
  url: string | null
  createdBy: number
  createdAt: string
  updatedAt: string
}

export interface WorkItemLinkFilters {
  connectionId?: number
  timeEntryId?: number
  projectId?: number
  providerItemId?: string
}

export interface CreateWorkItemLinkRequest {
  connectionId: number
  /** Exactly one of the two targets. */
  timeEntryId?: number
  projectId?: number
  providerItemId: string
  url?: string | null
}

const isAdministrator = (actor: WorkItemActor): boolean => actor.profile === 'administrator'

const isUniqueViolation = (error: unknown): boolean => {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if (/unique constraint failed/i.test(current.message)) return true
    current = (current as Error & { cause?: unknown }).cause
  }
  return false
}

const isInactiveWriteError = (error: unknown): boolean => {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if (/work item connection is not active/.test(current.message)) return true
    current = (current as Error & { cause?: unknown }).cause
  }
  return false
}

const connectionRecord = (
  row: typeof workItemConnections.$inferSelect,
): WorkItemConnectionRecord => ({ ...row, provider: row.provider as WorkItemProviderId })

interface LinkJoin {
  work_item_links: typeof workItemLinks.$inferSelect
  work_item_connections: typeof workItemConnections.$inferSelect
}

const linkRecord = ({ work_item_links: link, work_item_connections: connection }: LinkJoin): WorkItemLinkRecord => ({
  id: link.id,
  connectionId: link.connectionId,
  provider: connection.provider as WorkItemProviderId,
  timeEntryId: link.timeEntryId,
  projectId: link.projectId,
  providerItemId: link.providerItemId,
  url: link.url,
  createdBy: link.createdBy,
  createdAt: link.createdAt,
  updatedAt: link.updatedAt,
})

export class DrizzleWorkItemRepository {
  readonly #database: TrackedResourceDatabase

  constructor(database: TrackedResourceDatabase) {
    this.#database = database
  }

  async connections(): Promise<readonly WorkItemConnectionRecord[]> {
    const rows = await this.#database
      .select()
      .from(workItemConnections)
      .orderBy(asc(workItemConnections.provider))
    return rows.map(connectionRecord)
  }

  async #connection(id: number): Promise<WorkItemConnectionRecord> {
    const [row] = await this.#database
      .select()
      .from(workItemConnections)
      .where(eq(workItemConnections.id, id))
      .limit(1)
    if (row === undefined) throw new WorkItemConnectionNotFoundError()
    return connectionRecord(row)
  }

  /**
   * Connects a provider, or revives its row when it was disconnected so the
   * links made through it stay attached. Connecting one that is already active
   * changes nothing, so a retried request cannot move the owner or the date.
   * The credential reference comes from the provider table, not from the caller.
   */
  async connect(
    provider: WorkItemProviderId,
    ownerUserId: number,
    now: string,
  ): Promise<WorkItemConnectionRecord> {
    const credentialRef = workItemProviders[provider].credentialSecret
    const [row] = await this.#database
      .insert(workItemConnections)
      .values({
        provider,
        status: 'active',
        ownerUserId,
        credentialRef,
        connectedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: workItemConnections.provider,
        set: {
          status: 'active',
          ownerUserId,
          credentialRef,
          connectedAt: now,
          disconnectedAt: null,
          updatedAt: now,
        },
        setWhere: eq(workItemConnections.status, 'disconnected'),
      })
      .returning()
    if (row !== undefined) return connectionRecord(row)
    const [existing] = await this.#database
      .select()
      .from(workItemConnections)
      .where(eq(workItemConnections.provider, provider))
      .limit(1)
    return connectionRecord(existing!)
  }

  /**
   * Drops the credential reference and keeps the row and its links. Disconnecting
   * what is already disconnected answers with the row as it is.
   */
  async disconnect(id: number, now: string): Promise<WorkItemConnectionRecord> {
    const [row] = await this.#database
      .update(workItemConnections)
      .set({ status: 'disconnected', credentialRef: null, disconnectedAt: now, updatedAt: now })
      .where(and(eq(workItemConnections.id, id), eq(workItemConnections.status, 'active')))
      .returning()
    return row === undefined ? this.#connection(id) : connectionRecord(row)
  }

  #visible(actor: WorkItemActor) {
    return isAdministrator(actor)
      ? []
      : [
          sql`${workItemLinks.timeEntryId} in (select id from time_entries where user_id = ${actor.userId})`,
        ]
  }

  #linkConditions(actor: WorkItemActor, filters: Readonly<WorkItemLinkFilters>) {
    return [
      ...this.#visible(actor),
      ...(filters.connectionId === undefined
        ? []
        : [eq(workItemLinks.connectionId, filters.connectionId)]),
      ...(filters.timeEntryId === undefined
        ? []
        : [eq(workItemLinks.timeEntryId, filters.timeEntryId)]),
      ...(filters.projectId === undefined ? [] : [eq(workItemLinks.projectId, filters.projectId)]),
      ...(filters.providerItemId === undefined
        ? []
        : [eq(workItemLinks.providerItemId, filters.providerItemId)]),
    ]
  }

  links(
    actor: WorkItemActor,
    filters: Readonly<WorkItemLinkFilters>,
  ): ResourceSource<WorkItemLinkRecord> {
    const select = () =>
      this.#database
        .select()
        .from(workItemLinks)
        .innerJoin(workItemConnections, eq(workItemConnections.id, workItemLinks.connectionId))
    return {
      highWatermark: async () => {
        const [row] = await select()
          .where(and(...this.#linkConditions(actor, filters)))
          .orderBy(desc(workItemLinks.id))
          .limit(1)
        return row?.work_item_links.id ?? null
      },
      list: async ({ afterId, throughId, take }: ResourceWindow) => {
        const rows = await select()
          .where(
            and(
              ...this.#linkConditions(actor, filters),
              lte(workItemLinks.id, throughId),
              ...(afterId === null ? [] : [gt(workItemLinks.id, afterId)]),
            ),
          )
          .orderBy(asc(workItemLinks.id))
          .limit(take)
        return rows.map(linkRecord)
      },
    }
  }

  async #link(actor: WorkItemActor, id: number): Promise<WorkItemLinkRecord> {
    const [row] = await this.#database
      .select()
      .from(workItemLinks)
      .innerJoin(workItemConnections, eq(workItemConnections.id, workItemLinks.connectionId))
      .where(and(eq(workItemLinks.id, id), ...this.#visible(actor)))
      .limit(1)
    if (row === undefined) throw new WorkItemLinkNotFoundError()
    return linkRecord(row)
  }

  async getLink(actor: WorkItemActor, id: number): Promise<WorkItemLinkRecord> {
    return this.#link(actor, id)
  }

  /**
   * Links a time entry or a project to a tracker item. The item id is kept as
   * given: slice 1 does not ask the tracker whether it exists.
   */
  async createLink(
    actor: WorkItemActor,
    input: Readonly<CreateWorkItemLinkRequest>,
    now: string,
  ): Promise<WorkItemLinkRecord> {
    if ((input.timeEntryId === undefined) === (input.projectId === undefined)) {
      throw new RangeError('A work item link names exactly one of a time entry or a project.')
    }
    const providerItemId = normalizeWorkItemId(input.providerItemId)
    const url =
      input.url === undefined || input.url === null ? null : normalizeWorkItemUrl(input.url)
    const connection = await this.#connection(input.connectionId)
    if (connection.status !== 'active') throw new WorkItemConnectionInactiveError()
    if (input.timeEntryId !== undefined) {
      const [entry] = await this.#database
        .select()
        .from(timeEntries)
        .where(eq(timeEntries.id, input.timeEntryId))
        .limit(1)
      if (entry === undefined || (!isAdministrator(actor) && entry.userId !== actor.userId)) {
        throw new WorkItemTargetNotFoundError('time_entry')
      }
    } else {
      const [project] = await this.#database
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId!))
        .limit(1)
      if (project === undefined || !isAdministrator(actor)) {
        throw new WorkItemTargetNotFoundError('project')
      }
    }
    try {
      const [created] = await this.#database
        .insert(workItemLinks)
        .values({
          connectionId: connection.id,
          timeEntryId: input.timeEntryId ?? null,
          projectId: input.projectId ?? null,
          providerItemId,
          url,
          createdBy: actor.userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
      return await this.#link(actor, created!.id)
    } catch (error) {
      if (isInactiveWriteError(error)) throw new WorkItemConnectionInactiveError()
      if (isUniqueViolation(error)) throw new WorkItemLinkExistsError()
      throw error
    }
  }

  async deleteLink(actor: WorkItemActor, id: number): Promise<void> {
    await this.#link(actor, id)
    await this.#database.delete(workItemLinks).where(eq(workItemLinks.id, id))
  }
}
