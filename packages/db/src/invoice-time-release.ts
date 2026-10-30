import { sql } from 'drizzle-orm'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  InvoiceTimeReleaseError,
  type InvoiceLineTimeRelease,
  type InvoiceLineTimeReleaseResult,
} from '@ezacto/core'
import type { InvoiceStateDatabase } from './invoice-state.js'
import { atomicStatements } from './atomic-statements.js'
import {
  invoiceHoursEntriesSnapshotSql,
  readInvoiceHoursSnapshot,
} from './invoice-hours-reconciliation.js'
const conflict = (): never => {
  throw new InvoiceTimeReleaseError(
    'conflict',
    'The draft or its linked hours changed. Reload the invoice and select time again.',
  )
}
export const releaseInvoiceLineTime = async (
  database: InvoiceStateDatabase,
  command: InvoiceLineTimeRelease,
  actorUserId: number,
  now: string,
): Promise<InvoiceLineTimeReleaseResult> => {
  const entryIds = [...new Set(command.entryIds)].sort((a, b) => a - b)
  if (
    !/^[A-Za-z0-9_-]{1,128}$/u.test(command.commandId) ||
    !Number.isSafeInteger(command.invoiceId) ||
    command.invoiceId < 1 ||
    !Number.isSafeInteger(command.lineId) ||
    command.lineId < 1 ||
    !Number.isSafeInteger(command.expectedVersion) ||
    command.expectedVersion < 0 ||
    !/^[a-f0-9]{64}$/u.test(command.hoursVersion) ||
    !entryIds.length ||
    entryIds.length > 1000 ||
    entryIds.some((id) => !Number.isSafeInteger(id) || id < 1)
  )
    throw new InvoiceTimeReleaseError(
      'invalid',
      'Choose a saved draft line, its current hours review and 1–1000 linked entries.',
    )
  // This shares Detailed time's receipt table/action. The scoped fingerprint
  // binds the actor, exact displayed snapshot and selection; legacy commands
  // keep their existing identities and eligibility (including closed invoices).
  const fingerprint =
    'invoice-line-release:v1:' +
    bytesToHex(
      sha256(
        new TextEncoder().encode(
          JSON.stringify({
            invoiceId: command.invoiceId,
            lineId: command.lineId,
            expectedVersion: command.expectedVersion,
            hoursVersion: command.hoursVersion,
            entryIds,
            actorUserId,
          }),
        ),
      ),
    )
  const replay = async (): Promise<InvoiceLineTimeReleaseResult | null> => {
    const [prior] = await database.all<{ fingerprint: string; resultJson: string }>(
      sql`SELECT fingerprint,result_json AS resultJson FROM report_time_commands WHERE command_id=${command.commandId}`,
    )
    if (!prior) return null
    if (prior.fingerprint !== fingerprint) conflict()
    return { ...(JSON.parse(prior.resultJson) as InvoiceLineTimeReleaseResult), replayed: true }
  }
  const prior = await replay()
  if (prior) return prior
  const snapshot = await readInvoiceHoursSnapshot(database, command.invoiceId)
  if (!snapshot) throw new InvoiceTimeReleaseError('not_found', 'This invoice does not exist.')
  const { review } = snapshot
  if (
    review.invoiceState !== 'draft' ||
    review.invoiceVersion !== command.expectedVersion ||
    review.hoursVersion !== command.hoursVersion
  )
    conflict()
  const line = review.lines.find((line) => line.lineId === command.lineId)
  if (!line || line.status !== 'billed_below_linked')
    throw new InvoiceTimeReleaseError(
      'invalid',
      'Choose a time-derived line billing fewer hours than it links.',
    )
  const allowed = new Set(line.entryIds),
    byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]))
  if (entryIds.some((id) => !allowed.has(id) || !byId.has(id) || byId.get(id)!.running !== 0))
    throw new InvoiceTimeReleaseError('invalid', 'Select stopped entries linked to this line only.')
  const seconds = entryIds.reduce((sum, id) => sum + byId.get(id)!.seconds, 0)
  if (
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    Math.abs(seconds - (line.linkedSeconds - line.billedSeconds)) > review.toleranceSeconds
  )
    throw new InvoiceTimeReleaseError(
      'invalid',
      'The selected whole entries must match the linked-minus-billed difference within the rounding tolerance.',
    )
  const result: InvoiceLineTimeReleaseResult = {
    commandId: command.commandId,
    invoiceId: command.invoiceId,
    lineId: command.lineId,
    expectedVersion: command.expectedVersion,
    hoursVersion: command.hoursVersion,
    releasedEntryIds: entryIds,
    releasedSeconds: seconds,
    recordedAt: now,
    replayed: false,
  }
  try {
    await atomicStatements(database, [
      {
        text: `INSERT INTO report_time_commands(command_id,actor_user_id,fingerprint,action,result_json,completed_at)
        VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM invoices WHERE id=? AND state='draft' AND version=?)
          AND ${invoiceHoursEntriesSnapshotSql('?')}=?
          AND EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=1 AND profile IN ('accounting','executive_manager','administrator'))
          THEN ? ELSE NULL END,?,'mark_uninvoiced',?,?) RETURNING command_id`,
        params: [
          command.commandId,
          command.invoiceId,
          command.expectedVersion,
          command.invoiceId,
          snapshot.entriesJson,
          actorUserId,
          actorUserId,
          fingerprint,
          JSON.stringify(result),
          now,
        ],
      },
      {
        text: `UPDATE time_entries SET invoice_id=NULL,updated_at=? WHERE invoice_id=? AND id IN(SELECT value FROM json_each(?)) RETURNING id`,
        params: [now, command.invoiceId, JSON.stringify(entryIds)],
      },
    ])
  } catch (error) {
    const raced = await replay()
    if (raced) return raced
    let cause: unknown = error
    for (let depth = 0; depth < 6 && cause instanceof Error && cause.cause; depth++)
      cause = cause.cause
    const code =
      typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : ''
    if (
      code.startsWith('SQLITE_CONSTRAINT') ||
      /constraint|invoice|invoiced|locked/iu.test(String(cause))
    )
      conflict()
    throw error
  }
  return result
}
