import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { sql } from 'drizzle-orm'
import {
  InvoiceElevationError,
  type InvoiceEditElevation,
  type ElevatedInvoiceTimeUnlink,
  type ElevatedInvoiceTimeUnlinkResult,
} from '@ezacto/core'
import { runAtomic, type InvoiceStateDatabase } from './invoice-state.js'
import { invoiceTimeUnlinkSnapshotSql } from './invoice-elevation-audit.js'
const conflict = (): never => {
  throw new InvoiceElevationError(
    'invoice_time_conflict',
    'The draft, its authority or its selected time changed. Reload the draft and select its stopped linked entries again.',
  )
}
export const unlinkElevatedInvoiceTime = async (
  db: InvoiceStateDatabase,
  command: ElevatedInvoiceTimeUnlink,
  elevation: InvoiceEditElevation,
  now: string,
): Promise<ElevatedInvoiceTimeUnlinkResult> => {
  if (
    !Number.isSafeInteger(command.invoiceId) ||
    command.invoiceId < 1 ||
    !Number.isSafeInteger(command.expectedVersion) ||
    command.expectedVersion < 0 ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(command.commandId) ||
    command.entryIds.length < 1 ||
    command.entryIds.length > 1000 ||
    command.entryIds.some((id) => !Number.isSafeInteger(id) || id < 1)
  )
    throw new InvoiceElevationError(
      'invalid_invoice_time_selection',
      'Choose 1–1000 stopped linked entries and the current draft version.',
    )
  if (elevation.invoiceId !== command.invoiceId)
    throw new InvoiceElevationError(
      'invoice_elevation_required',
      'The elevation belongs to a different invoice.',
    )
  const entryIds = [...new Set(command.entryIds)].sort((a, b) => a - b),
    ids = JSON.stringify(entryIds),
    fingerprint =
      'sha256:' +
      bytesToHex(
        sha256(
          new TextEncoder().encode(
            JSON.stringify({
              invoiceId: command.invoiceId,
              actorUserId: elevation.userId,
              expectedVersion: command.expectedVersion,
              entryIds,
            }),
          ),
        ),
      )
  const replay = async () => {
    const prior = (
      await db.all<{
        input_fingerprint: string
        actor_user_id: number
        completed: number
        result_json: string | null
      }>(
        sql`SELECT input_fingerprint,actor_user_id,completed,result_json FROM invoice_elevated_time_commands WHERE invoice_id=${command.invoiceId} AND command_id=${command.commandId}`,
      )
    )[0]
    if (!prior) return null
    if (
      prior.input_fingerprint !== fingerprint ||
      prior.actor_user_id !== elevation.userId ||
      prior.completed !== 1 ||
      prior.result_json === null
    )
      conflict()
    return {
      ...(JSON.parse(prior.result_json!) as ElevatedInvoiceTimeUnlinkResult),
      replayed: true,
    }
  }
  const prior = await replay()
  if (prior) return prior
  const result: ElevatedInvoiceTimeUnlinkResult = {
    invoiceId: command.invoiceId,
    commandId: command.commandId,
    elevationId: elevation.id,
    releasedEntryIds: entryIds,
    recordedAt: now,
    replayed: false,
  }
  try {
    await runAtomic(db, [
      {
        text: `INSERT INTO invoice_elevated_time_commands(invoice_id,command_id,elevation_id,token_id,actor_user_id,expected_invoice_version,input_fingerprint,entry_ids_json,before_json,occurred_at) VALUES(?,?,?,?,?,?,?,?,(${invoiceTimeUnlinkSnapshotSql('?')}),?)`,
        params: [
          command.invoiceId,
          command.commandId,
          elevation.id,
          elevation.tokenId,
          elevation.userId,
          command.expectedVersion,
          fingerprint,
          ids,
          ids,
          now,
        ],
      },
      {
        text: `UPDATE time_entries SET invoice_id=NULL,updated_at=? WHERE invoice_id=? AND id IN(SELECT value FROM json_each(?))`,
        params: [now, command.invoiceId, ids],
      },
      {
        text: `UPDATE invoice_elevated_time_commands SET after_json=(${invoiceTimeUnlinkSnapshotSql('?')}),result_json=?,completed=1 WHERE invoice_id=? AND command_id=? AND completed=0`,
        params: [ids, JSON.stringify(result), command.invoiceId, command.commandId],
      },
    ])
  } catch (error) {
    const raced = await replay()
    if (raced) return raced
    let cause: unknown = error
    for (let depth = 0; depth < 8 && cause instanceof Error; depth++) {
      if (/invoice_elevation_/u.test(cause.message))
        throw new InvoiceElevationError(
          'invoice_elevation_required',
          'The invoice elevation expired or its authority changed. Reauthenticate before unlinking draft time.',
        )
      if (/invoice_time_|locked|invoiced/iu.test(cause.message)) conflict()
      cause = cause.cause
    }
    throw error
  }
  return result
}
