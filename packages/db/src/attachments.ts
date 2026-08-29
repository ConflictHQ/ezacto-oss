import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type ContainerDatabase = BetterSQLite3Database<typeof schema> & {
  $client: BetterSqlite3.Database
}

type WorkerDatabase = DrizzleD1Database<typeof schema> & {
  $client: D1Database
}

export type AttachmentDatabase = ContainerDatabase | WorkerDatabase

export interface AttachmentFileInput {
  /** Lowercase, unprefixed SHA-256 hex, matching the migration snapshot manifest. */
  contentHash: string
  /** R2/disk placement chosen by the D17 storage adapter. */
  fileKey: string
  byteSize: number
  contentType: string
}

export interface AttachmentMetadataInput extends AttachmentFileInput {
  /** Stable route-level command identity; all three identity fields are supplied together. */
  attachmentId?: number
  commandId?: string
  actorUserId?: number
  name: string
  uploadedByUserId?: number | null
  createdAt: string
  updatedAt: string
}

export type CreateInvoiceAttachmentInput = AttachmentMetadataInput & { invoiceId: number }
export type CreateRecurringInvoiceAttachmentInput = AttachmentMetadataInput & {
  recurringInvoiceId: number
}
export type CreateEstimateAttachmentInput = AttachmentMetadataInput & { estimateId: number }
export type CreateExpenseAttachmentInput = AttachmentMetadataInput & { expenseId: number }
export type CreateProjectAttachmentInput = AttachmentMetadataInput & { projectId: number }

export interface AttachmentRecord {
  id: number
  fileObjectId: number
  contentHash: string
  fileKey: string
  byteSize: number
  contentType: string
  name: string
  uploadedByUserId: number | null
  createdAt: string
  updatedAt: string
}

export interface StaticRecurringAttachmentPolicyV1 {
  schema_version: 1
  type: 'static'
  /** Unique logical attachments already owned by this recurring definition. */
  attachment_ids: number[]
}

export interface AttachmentStore {
  createInvoiceAttachment(input: CreateInvoiceAttachmentInput): Promise<AttachmentRecord>
  createRecurringInvoiceAttachment(
    input: CreateRecurringInvoiceAttachmentInput,
  ): Promise<AttachmentRecord>
  createEstimateAttachment(input: CreateEstimateAttachmentInput): Promise<AttachmentRecord>
  createExpenseAttachment(input: CreateExpenseAttachmentInput): Promise<AttachmentRecord>
  createProjectAttachment(input: CreateProjectAttachmentInput): Promise<AttachmentRecord>
  listInvoiceAttachments(invoiceId: number): Promise<readonly AttachmentRecord[]>
  listRecurringInvoiceAttachments(recurringInvoiceId: number): Promise<readonly AttachmentRecord[]>
  listEstimateAttachments(estimateId: number): Promise<readonly AttachmentRecord[]>
  listExpenseAttachments(expenseId: number): Promise<readonly AttachmentRecord[]>
  listProjectAttachments(projectId: number): Promise<readonly AttachmentRecord[]>
  getInvoiceAttachment(invoiceId: number, attachmentId: number): Promise<AttachmentRecord | null>
  getRecurringInvoiceAttachment(
    recurringInvoiceId: number,
    attachmentId: number,
  ): Promise<AttachmentRecord | null>
  getEstimateAttachment(estimateId: number, attachmentId: number): Promise<AttachmentRecord | null>
  getExpenseAttachment(expenseId: number, attachmentId: number): Promise<AttachmentRecord | null>
  getProjectAttachment(projectId: number, attachmentId: number): Promise<AttachmentRecord | null>
  setRecurringInvoiceAttachmentPolicy(
    recurringInvoiceId: number,
    policy: StaticRecurringAttachmentPolicyV1 | null,
    updatedAt: string,
  ): Promise<void>
}

interface Operation {
  query: string
  bindings: readonly unknown[]
}

interface StoredAttachmentRow {
  id: number
  file_object_id: number
  content_hash: string
  file_key: string
  byte_size: number
  content_type: string
  name: string
  uploaded_by_user_id: number | null
  created_at: string
  updated_at: string
}

interface OwnerDefinition {
  table: string
  parentColumn: string
  parentInputKey: 'invoiceId' | 'recurringInvoiceId' | 'estimateId' | 'expenseId' | 'projectId'
  guardColumn: string
  commandKind:
    | 'invoice_attachment.create'
    | 'recurring_invoice_attachment.create'
    | 'estimate_attachment.create'
    | 'expense_attachment.create'
    | 'project_attachment.create'
}

const owners = {
  invoice: {
    table: 'invoice_attachments',
    parentColumn: 'invoice_id',
    parentInputKey: 'invoiceId',
    guardColumn: 'invoice_attachment_link_id',
    commandKind: 'invoice_attachment.create',
  },
  recurringInvoice: {
    table: 'recurring_invoice_attachments',
    parentColumn: 'recurring_invoice_id',
    parentInputKey: 'recurringInvoiceId',
    guardColumn: 'recurring_invoice_attachment_link_id',
    commandKind: 'recurring_invoice_attachment.create',
  },
  estimate: {
    table: 'estimate_attachments',
    parentColumn: 'estimate_id',
    parentInputKey: 'estimateId',
    guardColumn: 'estimate_attachment_link_id',
    commandKind: 'estimate_attachment.create',
  },
  expense: {
    table: 'expense_attachments',
    parentColumn: 'expense_id',
    parentInputKey: 'expenseId',
    guardColumn: 'expense_attachment_link_id',
    commandKind: 'expense_attachment.create',
  },
  project: {
    table: 'project_attachments',
    parentColumn: 'project_id',
    parentInputKey: 'projectId',
    guardColumn: 'project_attachment_link_id',
    commandKind: 'project_attachment.create',
  },
} as const satisfies Record<string, OwnerDefinition>

const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const contentHashPattern = /^[0-9a-f]{64}$/

const assertPositiveSafeInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
}

const assertCanonicalTimestamp = (value: string, field: string): void => {
  const match = timestampPattern.exec(value)
  if (!match) throw new RangeError(`${field} must be a canonical UTC timestamp`)
  const milliseconds = Date.parse(value)
  const date = new Date(milliseconds)
  if (
    !Number.isFinite(milliseconds) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5]) ||
    date.getUTCSeconds() !== Number(match[6]) ||
    date.getUTCMilliseconds() !== Number((match[7] ?? '').padEnd(3, '0') || 0)
  ) {
    throw new RangeError(`${field} must be a real canonical UTC timestamp`)
  }
}

const assertBoundedText = (value: string, field: string, maximum: number): void => {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || !value.trim()) {
    throw new TypeError(`${field} must be non-empty and at most ${maximum} characters`)
  }
}

const normalizeAttachmentInput = <T extends AttachmentMetadataInput>(input: T): T => {
  if (!contentHashPattern.test(input.contentHash)) {
    throw new TypeError('contentHash must be lowercase, unprefixed SHA-256 hex')
  }
  assertBoundedText(input.fileKey, 'fileKey', 1024)
  assertBoundedText(input.contentType, 'contentType', 255)
  assertBoundedText(input.name, 'name', 255)
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 0) {
    throw new RangeError('byteSize must be a non-negative safe integer')
  }
  if (input.uploadedByUserId !== undefined && input.uploadedByUserId !== null) {
    assertPositiveSafeInteger(input.uploadedByUserId, 'uploadedByUserId')
  }
  const commandFields = [input.attachmentId, input.commandId, input.actorUserId]
  if (commandFields.some((value) => value !== undefined)) {
    if (commandFields.some((value) => value === undefined)) {
      throw new TypeError('attachment command identity fields must be supplied together')
    }
    assertPositiveSafeInteger(input.attachmentId!, 'attachmentId')
    assertPositiveSafeInteger(input.actorUserId!, 'actorUserId')
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.commandId!)) {
      throw new TypeError('commandId has invalid characters or length')
    }
  }
  assertCanonicalTimestamp(input.createdAt, 'createdAt')
  assertCanonicalTimestamp(input.updatedAt, 'updatedAt')
  return input
}

export const assertStaticRecurringAttachmentPolicy: (
  value: unknown,
) => asserts value is StaticRecurringAttachmentPolicyV1 = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('attachment policy must be an object')
  }
  const policy = value as Record<string, unknown>
  const keys = Object.keys(policy)
  if (
    keys.length !== 3 ||
    !Object.hasOwn(policy, 'schema_version') ||
    !Object.hasOwn(policy, 'type') ||
    !Object.hasOwn(policy, 'attachment_ids')
  ) {
    throw new TypeError('attachment policy has missing or unknown fields')
  }
  if (policy.schema_version !== 1) {
    throw new RangeError('attachment policy schema_version must be 1')
  }
  if (policy.type !== 'static') {
    throw new TypeError('only static recurring attachment policy is supported')
  }
  if (!Array.isArray(policy.attachment_ids) || policy.attachment_ids.length === 0) {
    throw new TypeError('static attachment policy requires at least one attachment id')
  }
  const attachmentIds = policy.attachment_ids as unknown[]
  for (const [index, attachmentId] of attachmentIds.entries()) {
    assertPositiveSafeInteger(attachmentId as number, `attachment_ids[${index}]`)
  }
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new TypeError('attachment policy ids must be unique')
  }
}

export const sha256ContentHash = async (bytes: ArrayBuffer | ArrayBufferView): Promise<string> => {
  const source =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const input = new Uint8Array(source.byteLength)
  input.set(source)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const attachmentSelect = `SELECT
    attachment.id,
    attachment.file_object_id,
    file.content_hash,
    file.file_key,
    file.byte_size,
    file.content_type,
    attachment.name,
    attachment.uploaded_by_user_id,
    attachment.created_at,
    attachment.updated_at
  FROM attachments attachment
  JOIN file_objects file ON file.id = attachment.file_object_id`

const attachment = (row: StoredAttachmentRow): AttachmentRecord => ({
  id: row.id,
  fileObjectId: row.file_object_id,
  contentHash: row.content_hash,
  fileKey: row.file_key,
  byteSize: row.byte_size,
  contentType: row.content_type,
  name: row.name,
  uploadedByUserId: row.uploaded_by_user_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const createOperations = (
  owner: OwnerDefinition,
  attachmentId: number,
  parentId: number,
  input: AttachmentMetadataInput,
  inputFingerprint?: string,
): readonly Operation[] => {
  const guards = Object.values(owners).map(({ guardColumn }) =>
    guardColumn === owner.guardColumn ? attachmentId : null,
  )
  const operations: Operation[] = [
    {
      query: `INSERT INTO file_objects (
          content_hash, file_key, byte_size, content_type, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM file_objects existing WHERE existing.content_hash = ?
        )`,
      bindings: [
        input.contentHash,
        input.fileKey,
        input.byteSize,
        input.contentType,
        input.createdAt,
        input.updatedAt,
        input.contentHash,
      ],
    },
    {
      query: `INSERT INTO attachments (
          id, file_object_id, name, uploaded_by_user_id,
          invoice_attachment_link_id, recurring_invoice_attachment_link_id,
          estimate_attachment_link_id, expense_attachment_link_id,
          project_attachment_link_id, created_at, updated_at
        )
        SELECT ?, file.id, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM file_objects file
        WHERE file.content_hash = ?
          AND file.file_key = ?
          AND file.byte_size = ?
          AND file.content_type = ?`,
      bindings: [
        attachmentId,
        input.name,
        input.uploadedByUserId ?? null,
        ...guards,
        input.createdAt,
        input.updatedAt,
        input.contentHash,
        input.fileKey,
        input.byteSize,
        input.contentType,
      ],
    },
    {
      query: `INSERT INTO ${owner.table} (attachment_id, ${owner.parentColumn}) VALUES (?, ?)`,
      bindings: [attachmentId, parentId],
    },
  ]
  if (
    inputFingerprint !== undefined &&
    input.commandId !== undefined &&
    input.actorUserId !== undefined
  ) {
    operations.push({
      query: `INSERT INTO resource_create_commands (
          command_kind, command_id, input_fingerprint, actor_user_id,
          resource_id, result_json, occurred_at
        ) SELECT ?, ?, ?, ?, attachment.id,
          json_object('schema_version', 1, 'data', json_object(
            'id', attachment.id,
            'fileObjectId', attachment.file_object_id,
            'contentHash', file.content_hash,
            'fileKey', file.file_key,
            'byteSize', file.byte_size,
            'contentType', file.content_type,
            'name', attachment.name,
            'uploadedByUserId', attachment.uploaded_by_user_id,
            'createdAt', attachment.created_at,
            'updatedAt', attachment.updated_at
          )), ?
        FROM attachments attachment
        JOIN file_objects file ON file.id = attachment.file_object_id
        WHERE attachment.id = ?`,
      bindings: [
        owner.commandKind,
        input.commandId,
        inputFingerprint,
        input.actorUserId,
        input.createdAt,
        attachmentId,
      ],
    })
  }
  return operations
}

const isD1Client = (client: BetterSqlite3.Database | D1Database): client is D1Database =>
  'batch' in client

const d1Rows = async <T>(
  database: D1Database,
  query: string,
  bindings: readonly unknown[] = [],
): Promise<T[]> =>
  (
    await database
      .prepare(query)
      .bind(...bindings)
      .all<T>()
  ).results

const containerRows = <T>(
  database: BetterSqlite3.Database,
  query: string,
  bindings: readonly unknown[] = [],
): T[] => database.prepare(query).all(...bindings) as T[]

const isAttachmentIdCollision = (error: unknown): boolean =>
  error instanceof Error &&
  /(attachment identity already exists|unique constraint failed: attachments\.id)/i.test(
    error.message,
  )

interface StoredAttachmentCommand {
  input_fingerprint: string
  actor_user_id: number
  resource_id: number
}

const fingerprintAttachment = async (
  owner: OwnerDefinition,
  parentId: number,
  input: AttachmentMetadataInput,
): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify({
          schema_version: 1,
          command_kind: owner.commandKind,
          actor: { type: 'user', id: input.actorUserId },
          owner: { type: owner.commandKind, id: parentId },
          file: {
            content_hash: input.contentHash,
            file_key: input.fileKey,
            byte_size: input.byteSize,
            content_type: input.contentType,
            name: input.name,
            uploaded_by_user_id: input.uploadedByUserId ?? null,
          },
        }),
      ),
    ),
  )
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const ownerParentId = (owner: OwnerDefinition, input: AttachmentMetadataInput): number => {
  const parentId = (input as unknown as Record<string, unknown>)[owner.parentInputKey]
  assertPositiveSafeInteger(parentId as number, owner.parentInputKey)
  return parentId as number
}

/**
 * Shared attachment persistence over the Drizzle wrapper used by both runtimes.
 * D1 commits file identity, logical metadata, and the one owner link in one batch;
 * the container uses the same predetermined statements in one transaction.
 */
export const createAttachmentStore = (database: AttachmentDatabase): AttachmentStore => {
  const client = database.$client

  const rows = async <T>(query: string, bindings: readonly unknown[] = []): Promise<T[]> =>
    isD1Client(client)
      ? d1Rows<T>(client, query, bindings)
      : containerRows<T>(client, query, bindings)

  const read = async (
    owner: OwnerDefinition,
    parentId: number,
    attachmentId?: number,
  ): Promise<readonly AttachmentRecord[]> => {
    assertPositiveSafeInteger(parentId, owner.parentInputKey)
    if (attachmentId !== undefined) assertPositiveSafeInteger(attachmentId, 'attachmentId')
    const stored = await rows<StoredAttachmentRow>(
      `${attachmentSelect}
       JOIN ${owner.table} ownership ON ownership.attachment_id = attachment.id
       WHERE ownership.${owner.parentColumn} = ?
         ${attachmentId === undefined ? '' : 'AND attachment.id = ?'}
       ORDER BY attachment.created_at, attachment.id`,
      attachmentId === undefined ? [parentId] : [parentId, attachmentId],
    )
    return stored.map(attachment)
  }

  const create = async <T extends AttachmentMetadataInput>(
    owner: OwnerDefinition,
    input: T,
  ): Promise<AttachmentRecord> => {
    normalizeAttachmentInput(input)
    const parentId = ownerParentId(owner, input)
    const durable = input.commandId !== undefined
    const attachmentId = durable ? input.attachmentId! : undefined
    const inputFingerprint = durable
      ? await fingerprintAttachment(owner, parentId, input)
      : undefined
    const readReceipt = async (): Promise<StoredAttachmentCommand | null> => {
      if (!durable) return null
      return (
        (
          await rows<StoredAttachmentCommand>(
            `SELECT input_fingerprint, actor_user_id, resource_id
           FROM resource_create_commands WHERE command_kind = ? AND command_id = ?`,
            [owner.commandKind, input.commandId!],
          )
        )[0] ?? null
      )
    }
    const replay = async (receipt: StoredAttachmentCommand): Promise<AttachmentRecord> => {
      if (
        receipt.input_fingerprint !== inputFingerprint ||
        receipt.actor_user_id !== input.actorUserId ||
        receipt.resource_id !== attachmentId
      ) {
        throw new Error('attachment command id was reused with different input')
      }
      const [created] = await read(owner, parentId, receipt.resource_id)
      if (!created) throw new Error('attachment command result is missing')
      return created
    }
    const prior = await readReceipt()
    if (prior !== null) return replay(prior)

    if (isD1Client(client)) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const [next] = durable
          ? [{ id: attachmentId! }]
          : await d1Rows<{ id: number }>(
              client,
              `SELECT coalesce(max(id), 0) + 1 AS id FROM attachments`,
            )
        if (!next || !Number.isSafeInteger(next.id)) {
          throw new Error('attachment id allocation failed')
        }
        try {
          await client.batch(
            createOperations(owner, next.id, parentId, input, inputFingerprint).map(
              ({ query, bindings }) => client.prepare(query).bind(...bindings),
            ),
          )
          const [created] = await read(owner, parentId, next.id)
          if (!created) throw new Error('attachment batch did not persist its logical row')
          return created
        } catch (error) {
          const completed = await readReceipt()
          if (completed !== null) return replay(completed)
          if (!isAttachmentIdCollision(error) || attempt === 3) throw error
          if (durable) throw error
        }
      }
      throw new Error('attachment id allocation exhausted')
    }

    const run = client.transaction((): AttachmentRecord => {
      const next = durable
        ? { id: attachmentId! }
        : (client.prepare(`SELECT coalesce(max(id), 0) + 1 AS id FROM attachments`).get() as
            { id: number } | undefined)
      if (!next || !Number.isSafeInteger(next.id))
        throw new Error('attachment id allocation failed')
      for (const { query, bindings } of createOperations(
        owner,
        next.id,
        parentId,
        input,
        inputFingerprint,
      )) {
        client.prepare(query).run(...bindings)
      }
      const [created] = containerRows<StoredAttachmentRow>(
        client,
        `${attachmentSelect}
         JOIN ${owner.table} ownership ON ownership.attachment_id = attachment.id
         WHERE ownership.${owner.parentColumn} = ? AND attachment.id = ?`,
        [parentId, next.id],
      )
      if (!created) throw new Error('attachment transaction did not persist its logical row')
      return attachment(created)
    })
    try {
      return run()
    } catch (error) {
      const completed = await readReceipt()
      if (completed !== null) return replay(completed)
      throw error
    }
  }

  const get = async (
    owner: OwnerDefinition,
    parentId: number,
    attachmentId: number,
  ): Promise<AttachmentRecord | null> => (await read(owner, parentId, attachmentId))[0] ?? null

  const setRecurringInvoiceAttachmentPolicy = async (
    recurringInvoiceId: number,
    policy: StaticRecurringAttachmentPolicyV1 | null,
    updatedAt: string,
  ): Promise<void> => {
    assertPositiveSafeInteger(recurringInvoiceId, 'recurringInvoiceId')
    assertCanonicalTimestamp(updatedAt, 'updatedAt')
    if (policy !== null) assertStaticRecurringAttachmentPolicy(policy)
    const serialized = policy === null ? null : JSON.stringify(policy)
    const query = `UPDATE recurring_invoices
      SET attachment_policy = ?, updated_at = ? WHERE id = ?`
    const bindings = [serialized, updatedAt, recurringInvoiceId] as const
    const changes = isD1Client(client)
      ? (
          await client
            .prepare(query)
            .bind(...bindings)
            .run()
        ).meta.changes
      : client.prepare(query).run(...bindings).changes
    if (changes !== 1) throw new Error(`recurring invoice ${recurringInvoiceId} does not exist`)
  }

  return {
    createInvoiceAttachment: (input) => create(owners.invoice, input),
    createRecurringInvoiceAttachment: (input) => create(owners.recurringInvoice, input),
    createEstimateAttachment: (input) => create(owners.estimate, input),
    createExpenseAttachment: (input) => create(owners.expense, input),
    createProjectAttachment: (input) => create(owners.project, input),
    listInvoiceAttachments: (invoiceId) => read(owners.invoice, invoiceId),
    listRecurringInvoiceAttachments: (recurringInvoiceId) =>
      read(owners.recurringInvoice, recurringInvoiceId),
    listEstimateAttachments: (estimateId) => read(owners.estimate, estimateId),
    listExpenseAttachments: (expenseId) => read(owners.expense, expenseId),
    listProjectAttachments: (projectId) => read(owners.project, projectId),
    getInvoiceAttachment: (invoiceId, attachmentId) => get(owners.invoice, invoiceId, attachmentId),
    getRecurringInvoiceAttachment: (recurringInvoiceId, attachmentId) =>
      get(owners.recurringInvoice, recurringInvoiceId, attachmentId),
    getEstimateAttachment: (estimateId, attachmentId) =>
      get(owners.estimate, estimateId, attachmentId),
    getExpenseAttachment: (expenseId, attachmentId) => get(owners.expense, expenseId, attachmentId),
    getProjectAttachment: (projectId, attachmentId) => get(owners.project, projectId, attachmentId),
    setRecurringInvoiceAttachmentPolicy,
  }
}
