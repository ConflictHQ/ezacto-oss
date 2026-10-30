import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { sql } from 'drizzle-orm'
import {
  InvoiceElevationError,
  invoiceElevationLifetimeSeconds,
  type InvoiceEditElevation,
  type InvoiceElevationBinding,
  type InvoiceElevationPending,
} from '@ezacto/core'
import { runAtomic, type InvoiceStateDatabase } from './invoice-state.js'
import {
  invoiceElevationBindingSql,
  invoiceElevationSecondFactorSql,
} from './migrations/0149_invoice_elevations.js'
interface Actor {
  userId: number
  tokenId: number
}
const digest = (value: string) => bytesToHex(sha256(new TextEncoder().encode(value)))
const unavailable = (): never => {
  throw new InvoiceElevationError(
    'invoice_elevation_unavailable',
    'Reauthenticate as the administrator who owns this API token and choose a current draft invoice.',
  )
}
const translate = (error: unknown): never => {
  const message = String(error)
  if (/invoice_elevation_unavailable|invoice_elevation_required|constraint/iu.test(message))
    unavailable()
  throw error
}
const bindingPredicate = (row: string, now: string) => sql.raw(invoiceElevationBindingSql(row, now))
export const createInvoiceElevationStore = (db: InvoiceStateDatabase) => ({
  async createRequest(
    binding: InvoiceElevationBinding,
    challenge: string,
    expiresAt: string,
    now: string,
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) unavailable()
    try {
      await db.run(
        sql`INSERT INTO invoice_elevation_requests(challenge_hash,user_id,token_id,invoice_id,credential_version,created_at,expires_at) VALUES(${digest(challenge)},${binding.userId},${binding.tokenId},${binding.invoiceId},${binding.credentialVersion},${now},${expiresAt})`,
      )
    } catch (error) {
      translate(error)
    }
  },
  async pending(
    challenge: string,
    actor: Actor,
    now: string,
  ): Promise<InvoiceElevationPending | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return null
    const row = (
      await db.all<InvoiceElevationPending>(
        sql`WITH command_clock(instant) AS (VALUES(${now})) SELECT user_id AS userId,token_id AS tokenId,invoice_id AS invoiceId,credential_version AS credentialVersion,expires_at AS challengeExpiresAt FROM invoice_elevation_requests request WHERE challenge_hash=${digest(challenge)} AND user_id=${actor.userId} AND token_id=${actor.tokenId} AND consumed_at IS NULL AND julianday(created_at)<=julianday(${now}) AND julianday(expires_at)>julianday(${now}) AND ${bindingPredicate('request', '(SELECT instant FROM command_clock)')}`,
      )
    )[0]
    return row ?? null
  },
  async mint(
    binding: InvoiceElevationBinding,
    now: string,
    challenge?: string,
  ): Promise<{ credential: string; elevation: InvoiceEditElevation }> {
    const id = crypto.randomUUID(),
      credential = 'ezi_' + bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      expiresAt = new Date(Date.parse(now) + invoiceElevationLifetimeSeconds * 1000).toISOString(),
      requestHash = challenge === undefined ? null : digest(challenge)
    try {
      await runAtomic(db, [
        ...(requestHash === null
          ? []
          : [
              {
                text: `UPDATE invoice_elevation_requests SET consumed_at=? WHERE challenge_hash=? AND user_id=? AND token_id=? AND invoice_id=? AND credential_version=? AND consumed_at IS NULL`,
                params: [
                  now,
                  requestHash,
                  binding.userId,
                  binding.tokenId,
                  binding.invoiceId,
                  binding.credentialVersion,
                ],
              },
            ]),
        {
          text: `INSERT INTO invoice_elevations(id,secret_hash,user_id,token_id,invoice_id,credential_version,request_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`,
          params: [
            id,
            digest(credential),
            binding.userId,
            binding.tokenId,
            binding.invoiceId,
            binding.credentialVersion,
            requestHash,
            now,
            expiresAt,
          ],
        },
      ])
    } catch (error) {
      translate(error)
    }
    return {
      credential,
      elevation: {
        id,
        userId: binding.userId,
        tokenId: binding.tokenId,
        invoiceId: binding.invoiceId,
        credentialVersion: binding.credentialVersion,
        expiresAt,
      },
    }
  },
  async verify(
    credential: string,
    actor: Actor,
    invoiceId: number,
    now: string,
  ): Promise<InvoiceEditElevation | null> {
    if (!/^ezi_[0-9a-f]{64}$/.test(credential)) return null
    const row = (
      await db.all<InvoiceEditElevation>(
        sql`WITH command_clock(instant) AS (VALUES(${now})) SELECT id,user_id AS userId,token_id AS tokenId,invoice_id AS invoiceId,credential_version AS credentialVersion,expires_at AS expiresAt FROM invoice_elevations elevation WHERE secret_hash=${digest(credential)} AND user_id=${actor.userId} AND token_id=${actor.tokenId} AND invoice_id=${invoiceId} AND revoked_at IS NULL AND julianday(created_at)<=julianday(${now}) AND julianday(expires_at)>julianday(${now}) AND ${bindingPredicate('elevation', '(SELECT instant FROM command_clock)')} AND ${sql.raw(invoiceElevationSecondFactorSql('elevation'))}`,
      )
    )[0]
    return row ?? null
  },
  async revoke(id: string, actor: Actor, now: string) {
    await db.run(
      sql`UPDATE invoice_elevations SET revoked_at=${now} WHERE id=${id} AND user_id=${actor.userId} AND token_id=${actor.tokenId} AND revoked_at IS NULL`,
    )
  },
})
