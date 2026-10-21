import { sql } from 'drizzle-orm'
import type { EmailMessage, SenderBoundQueuedMailer } from '@ezacto/mailer'
import { createAttachmentStore } from './attachments.js'
import { runAtomic, type InvoiceStateDatabase } from './invoice-state.js'
import { createScheduledActionStore, type RunItemRecord } from './scheduled-actions.js'
import { executeRun } from './run-executor.js'

export interface ScheduledSenderBinding {
  senderIdentityId: number
  senderIdentityVersion: number
  senderEvidenceVersion: number
  from: { email: string; name: string }
  replyTo?: readonly { email: string }[]
}
export interface ScheduledDispatchPorts {
  sender(): Promise<ScheduledSenderBinding>
  enqueue: NonNullable<SenderBoundQueuedMailer['enqueuePersisted']>
  readBytes(key: string): Promise<Uint8Array | null>
  now(): string
}
interface ReceiptRow {
  run_item_id: number
  delivery_id: number
  attachment_id: number
  sender_identity_id: number
  sender_identity_version: number
  sender_evidence_version: number
  message_json: string
  created_at: string
}
const identity = async (namespace: string, itemId: number): Promise<number> => {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${namespace}:${itemId}`)),
  )
  return [...hash.slice(0, 6)].reduce((value, byte) => value * 256 + byte, 0) + 1
}
const digest = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

/** One durable intent and one attachment identity per item, before any queue handoff. */
export const createScheduledRunDispatchService = (
  database: InvoiceStateDatabase,
  ports: ScheduledDispatchPorts,
) => {
  const store = createScheduledActionStore(database),
    attachments = createAttachmentStore(database)
  const receipt = async (itemId: number) =>
    (
      await database.all<ReceiptRow>(
        sql`SELECT * FROM scheduled_run_deliveries WHERE run_item_id=${itemId}`,
      )
    )[0] ?? null
  const prepare = async (item: RunItemRecord, runId: number, leaseToken: string) => {
    const prior = await receipt(item.id)
    if (prior) return prior
    if (!item.report || !item.target)
      throw new Error('This legacy item has no saved report and cannot be sent automatically.')
    const sender = await ports.sender(),
      now = ports.now()
    const deliveryId = await identity('scheduled-email', item.id),
      attachmentId = await identity('scheduled-attachment', item.id)
    const message: EmailMessage = {
      from: sender.from,
      ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
      to: [{ email: item.target }],
      template: 'month-end-pack',
      subject: `Work detail: ${item.description}`,
      text: `Please find the work detail for ${item.description} attached.`,
      related: { type: 'scheduled_run', id: runId },
    }
    try {
      await runAtomic(database, [
        {
          text: `INSERT INTO email_log(id,from_json,reply_to_json,to_json,template,subject,related_type,related_id,created_at,updated_at)
          SELECT ?,?,?,?,?,?,'scheduled_run',?,?,? WHERE EXISTS(
            SELECT 1 FROM run_items item JOIN proposed_runs run ON run.id=item.run_id
            JOIN invoices invoice ON invoice.id=item.subject_id
            JOIN users actor ON actor.id=run.confirmed_by_user_id
            WHERE item.id=? AND item.state='running' AND item.lease_token=? AND run.state='confirmed'
              AND actor.is_active=1 AND actor.profile='administrator' AND invoice.state='open'
              AND item.target=? AND item.report_content_hash IS NOT NULL
              AND (SELECT contact.email FROM contacts contact WHERE contact.client_id=invoice.client_id
                AND contact.invoice_recipient_status='recipient' AND contact.email IS NOT NULL AND trim(contact.email)<>'' ORDER BY contact.id LIMIT 1)=item.target
          )`,
          params: [
            deliveryId,
            JSON.stringify(message.from),
            message.replyTo === undefined ? null : JSON.stringify(message.replyTo),
            JSON.stringify(message.to),
            message.template,
            message.subject,
            runId,
            now,
            now,
            item.id,
            leaseToken,
            item.target,
          ],
        },
        {
          text: `INSERT INTO scheduled_run_deliveries(run_item_id,delivery_id,attachment_id,sender_identity_id,sender_identity_version,sender_evidence_version,message_json,created_at)
          SELECT ?,?,?,?,?,?,?,? WHERE changes()=1`,
          params: [
            item.id,
            deliveryId,
            attachmentId,
            sender.senderIdentityId,
            sender.senderIdentityVersion,
            sender.senderEvidenceVersion,
            JSON.stringify(message),
            now,
          ],
        },
      ])
    } catch (error) {
      const raced = await receipt(item.id)
      if (raced) return raced
      throw error
    }
    const recorded = await receipt(item.id)
    if (!recorded)
      throw new Error(
        'The invoice, recipient, administrator authority or execution lease changed before delivery was recorded.',
      )
    // The actor is retained by the attachment command; it is the confirmer,
    // never the scheduler or the historical creator of the monthly job.
    return recorded
  }
  return {
    async processDue(now = ports.now()) {
      const deadline = Date.now() + 20000,
        signal = AbortSignal.timeout(20000)
      const rows = await database.all<{
        id: number
        confirmed_by_user_id: number
      }>(sql`SELECT run.id,run.confirmed_by_user_id FROM proposed_runs run
        WHERE run.state='confirmed' AND EXISTS(SELECT 1 FROM run_items item WHERE item.run_id=run.id AND
          ((item.state IN('pending','failed') AND item.attempt_count<item.attempt_limit)
            OR (item.state='running' AND (item.lease_expires_at IS NULL OR item.lease_expires_at<=${now})))) ORDER BY run.id LIMIT 10`)
      let completed = 0
      const failed: { runId: number; itemId: number; reason: string }[] = []
      for (const row of rows) {
        if (Date.now() >= deadline) break
        const result = await executeRun(row.id, {
          store,
          now: ports.now,
          maxItems: 10,
          signal,
          handler: async (item, { leaseToken }) => {
            if (item.subjectType !== 'invoice')
              throw new Error('This dispatcher only executes invoice month-end packs.')
            if (!item.report)
              throw new Error(
                'This legacy item has no saved report and cannot be sent automatically.',
              )
            const bytes = await ports.readBytes(item.report.key)
            if (
              bytes === null ||
              bytes.length !== item.report.byteSize ||
              (await digest(bytes)) !== item.report.contentHash
            )
              throw new Error(
                'The saved report is missing or does not match its captured hash. Restore the original artifact before retrying.',
              )
            const recorded = await prepare(item, row.id, leaseToken)
            const message = JSON.parse(recorded.message_json) as EmailMessage
            await attachments.createInvoiceAttachment({
              invoiceId: item.subjectId,
              attachmentId: recorded.attachment_id,
              commandId: `scheduled-attachment:${item.id}`,
              actorUserId: row.confirmed_by_user_id,
              uploadedByUserId: row.confirmed_by_user_id,
              contentHash: item.report.contentHash,
              fileKey: item.report.key,
              byteSize: item.report.byteSize,
              contentType: 'application/pdf',
              name: item.report.name,
              createdAt: recorded.created_at,
              updatedAt: recorded.created_at,
            })
            const current = await database.all<{ id: number }>(
              sql`SELECT id FROM run_items WHERE id=${item.id} AND state='running' AND lease_token=${leaseToken}`,
            )
            if (!current.length)
              throw new Error('The execution lease changed before queue handoff.')
            await ports.enqueue(
              recorded.delivery_id,
              {
                senderIdentityId: recorded.sender_identity_id,
                senderIdentityVersion: recorded.sender_identity_version,
                senderEvidenceVersion: recorded.sender_evidence_version,
                from: message.from,
                ...(message.replyTo ? { replyTo: message.replyTo } : {}),
              },
              message,
              [
                {
                  key: item.report.key,
                  filename: item.report.name,
                  contentType: 'application/pdf',
                },
              ],
            )
          },
        })
        completed += result.completed
        failed.push(...result.failed.map((item) => ({ runId: row.id, ...item })))
      }
      return { completed, failed }
    },
  }
}
