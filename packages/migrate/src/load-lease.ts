/**
 * Who may load into a target database (issue 409, slice 3).
 *
 * The file lock beside a snapshot answers "is another process on this machine
 * working on this directory". A load driven from the platform runs in whichever
 * Worker invocation the queue hands the next message to, on no machine in
 * particular, so ownership has to live where the writes land: in the target
 * database, in one row.
 *
 * A holder claims the lease for a time to live and renews it at the start of
 * every invocation. A claimant that finds a live lease is refused. One that
 * finds an expired lease takes it over, and the takeover bumps a fencing token.
 * Expiry alone is not enough, because a holder that stalled past its expiry
 * will wake up and finish the chunk it was in the middle of. So every write the
 * holder makes carries a guard statement in the same batch: it fails, and the
 * whole batch with it, unless this holder and this fencing token are still the
 * current lease and unexpired. A stale holder stops before its next write, not
 * after it.
 *
 * The lease also pins what was claimed: the verified snapshot digest, the hash
 * of manifest.json, and a fingerprint of every object the load reads. A source
 * that changes underneath a running load is refused rather than read.
 *
 * Time is the caller's clock, passed in, so a test can stop it. Two hosts whose
 * clocks disagree by more than the time to live can both believe they hold the
 * lease; the fencing token, not the clock, is what keeps that from corrupting
 * anything, since it is compared in the database.
 */

import { sha256Hex } from './portable-hash.js'
import { RESOURCES } from './resources.js'
import type { Manifest } from './manifest.js'
import type { SnapshotSource } from './snapshot-source.js'

export const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000

export interface LeaseStatement {
  sql: string
  bindings: readonly unknown[]
}

/** The two things the lease needs from a database, so this module imports none. */
export interface LeaseDatabase {
  first<T>(sql: string, bindings?: readonly unknown[]): Promise<T | null>
  run(statements: readonly LeaseStatement[]): Promise<void>
}

export interface LeasePins {
  snapshotSha256: string
  manifestSha256: string
  sourceFingerprint: string
}

export interface LoadLease {
  readonly holder: string
  /** Bumped on every takeover; a write is accepted only under the current one. */
  readonly fence: number
  readonly ttlMs: number
  readonly now: () => number
  /** Epoch milliseconds; moves forward on every renewal. */
  expiresAt: number
}

export class LoadLeaseHeldError extends Error {
  constructor(readonly expiresAt: number) {
    super(
      `another load holds the lease on this database until ${new Date(expiresAt).toISOString()}`,
    )
    this.name = 'LoadLeaseHeldError'
  }
}

export class LoadLeaseLostError extends Error {
  constructor() {
    super('this load no longer holds the lease on its database; stopping before writing')
    this.name = 'LoadLeaseLostError'
  }
}

export class LoadSnapshotChangedError extends Error {
  constructor(what: string) {
    super(`the snapshot changed since this load claimed its lease: ${what}`)
    this.name = 'LoadSnapshotChangedError'
  }
}

export const LEASE_SCHEMA: readonly LeaseStatement[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS _ezacto_load_lease (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      holder TEXT NOT NULL,
      fence INTEGER NOT NULL CHECK (fence >= 1),
      claimed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      released_at INTEGER,
      previous_holder TEXT,
      snapshot_sha256 TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL
    ) STRICT`,
    bindings: [],
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS _ezacto_load_lease_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      fence INTEGER NOT NULL,
      event TEXT NOT NULL CHECK (event IN ('claimed', 'taken_over', 'released')),
      holder TEXT NOT NULL,
      previous_holder TEXT,
      at INTEGER NOT NULL,
      UNIQUE (fence, event)
    ) STRICT`,
    bindings: [],
  },
  {
    // One row, rewritten by every guarded batch. Its CHECK is the whole point:
    // writing a 0 into it fails the statement, and a failed statement in a batch
    // rolls the batch back.
    sql: `CREATE TABLE IF NOT EXISTS _ezacto_load_fence (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      lease_held INTEGER NOT NULL CHECK (lease_held = 1)
    ) STRICT`,
    bindings: [],
  },
]

const newHolder = (): string => globalThis.crypto.randomUUID()

/** Fails the batch it is in unless `lease` is still the current, unexpired lease. */
export const fenceStatement = (lease: LoadLease): LeaseStatement => ({
  sql: `INSERT INTO _ezacto_load_fence (singleton, lease_held)
    SELECT 1, CASE WHEN EXISTS (
      SELECT 1 FROM _ezacto_load_lease
      WHERE singleton = 1 AND holder = ? AND fence = ?
        AND released_at IS NULL AND expires_at > ?
    ) THEN 1 ELSE 0 END WHERE 1
    ON CONFLICT (singleton) DO UPDATE SET lease_held = excluded.lease_held`,
  bindings: [lease.holder, lease.fence, lease.now()],
})

/** A rejected guard reads as a constraint failure; say what it means. */
export const translateFenceFailure = (error: unknown): unknown =>
  error instanceof Error && /lease_held = 1/u.test(error.message) ? new LoadLeaseLostError() : error

interface LeaseRow {
  holder: string
  fence: number
  expiresAt: number
  releasedAt: number | null
  snapshotSha256: string
  manifestSha256: string
  sourceFingerprint: string
}

const readLease = (database: LeaseDatabase): Promise<LeaseRow | null> =>
  database.first<LeaseRow>(
    `SELECT holder, fence, expires_at AS expiresAt, released_at AS releasedAt,
      snapshot_sha256 AS snapshotSha256, manifest_sha256 AS manifestSha256,
      source_fingerprint AS sourceFingerprint
     FROM _ezacto_load_lease WHERE singleton = 1`,
  )

export const claimLease = async (
  database: LeaseDatabase,
  pins: LeasePins,
  options: { holder?: string; ttlMs?: number; now?: () => number } = {},
): Promise<LoadLease> => {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('lease ttlMs must be positive')
  const holder = options.holder ?? newHolder()
  const at = now()
  await database.run([
    {
      // Wins only over a lease that has expired or been released. Everything on
      // the right of SET reads the row as it was, so `fence + 1` is the
      // previous holder's token plus one.
      sql: `INSERT INTO _ezacto_load_lease
        (singleton, holder, fence, claimed_at, expires_at, released_at, previous_holder,
         snapshot_sha256, manifest_sha256, source_fingerprint)
        VALUES (1, ?, 1, ?, ?, NULL, NULL, ?, ?, ?)
        ON CONFLICT (singleton) DO UPDATE SET
          holder = excluded.holder,
          fence = _ezacto_load_lease.fence + 1,
          claimed_at = excluded.claimed_at,
          expires_at = excluded.expires_at,
          previous_holder = CASE WHEN _ezacto_load_lease.released_at IS NULL
            THEN _ezacto_load_lease.holder ELSE NULL END,
          released_at = NULL,
          snapshot_sha256 = excluded.snapshot_sha256,
          manifest_sha256 = excluded.manifest_sha256,
          source_fingerprint = excluded.source_fingerprint
        WHERE _ezacto_load_lease.expires_at <= ? OR _ezacto_load_lease.released_at IS NOT NULL`,
      bindings: [
        holder,
        at,
        at + ttlMs,
        pins.snapshotSha256,
        pins.manifestSha256,
        pins.sourceFingerprint,
        at,
      ],
    },
    {
      // Only if this claim won. A takeover is the case where the lease row
      // remembers a previous holder that never released it.
      sql: `INSERT OR IGNORE INTO _ezacto_load_lease_log (fence, event, holder, previous_holder, at)
        SELECT fence, CASE WHEN previous_holder IS NULL THEN 'claimed' ELSE 'taken_over' END,
          holder, previous_holder, ?
        FROM _ezacto_load_lease WHERE singleton = 1 AND holder = ?`,
      bindings: [at, holder],
    },
  ])
  const row = await readLease(database)
  if (row === null || row.holder !== holder) throw new LoadLeaseHeldError(row?.expiresAt ?? at)
  return { holder, fence: row.fence, ttlMs, now, expiresAt: row.expiresAt }
}

/** Extends a held lease by its time to live; rejects if it has been lost. */
export const renewLease = async (database: LeaseDatabase, lease: LoadLease): Promise<void> => {
  const expiresAt = lease.now() + lease.ttlMs
  try {
    await database.run([
      fenceStatement(lease),
      {
        sql: `UPDATE _ezacto_load_lease SET expires_at = ?
          WHERE singleton = 1 AND holder = ? AND fence = ?`,
        bindings: [expiresAt, lease.holder, lease.fence],
      },
    ])
  } catch (error) {
    throw translateFenceFailure(error)
  }
  lease.expiresAt = expiresAt
}

/** Gives the lease up at once, so the next claimant does not wait out the expiry. */
export const releaseLease = async (database: LeaseDatabase, lease: LoadLease): Promise<void> => {
  const at = lease.now()
  try {
    await database.run([
      fenceStatement(lease),
      {
        sql: `UPDATE _ezacto_load_lease SET released_at = ?, expires_at = ?
          WHERE singleton = 1 AND holder = ? AND fence = ?`,
        bindings: [at, at, lease.holder, lease.fence],
      },
      {
        sql: `INSERT OR IGNORE INTO _ezacto_load_lease_log
          (fence, event, holder, previous_holder, at) VALUES (?, 'released', ?, NULL, ?)`,
        bindings: [lease.fence, lease.holder, at],
      },
    ])
  } catch (error) {
    throw translateFenceFailure(error)
  }
}

/**
 * A load that holds no lease must not write under one that does. The CLI path
 * keeps its file lock and claims nothing; this is what stops it from running
 * alongside a platform load of the same database.
 */
export const assertNoLiveLease = async (
  database: LeaseDatabase,
  now: number = Date.now(),
): Promise<void> => {
  const row = await readLease(database)
  if (row !== null && row.releasedAt === null && row.expiresAt > now) {
    throw new LoadLeaseHeldError(row.expiresAt)
  }
}

/** Refuses a source that is not the one the lease was claimed over. */
export const assertPins = async (
  database: LeaseDatabase,
  lease: LoadLease,
  current: LeasePins,
): Promise<void> => {
  const row = await readLease(database)
  if (row === null || row.holder !== lease.holder || row.fence !== lease.fence) {
    throw new LoadLeaseLostError()
  }
  if (row.snapshotSha256 !== current.snapshotSha256) {
    throw new LoadSnapshotChangedError('checksums.json names a different snapshot')
  }
  if (row.manifestSha256 !== current.manifestSha256) {
    throw new LoadSnapshotChangedError('manifest.json')
  }
  if (row.sourceFingerprint !== current.sourceFingerprint) {
    throw new LoadSnapshotChangedError('a raw object was replaced or rewritten')
  }
}

/**
 * One digest over every object the load reads: each manifest resource that has
 * rows, and the lineage beside each child resource. Size alone would miss a
 * same-length edit, so a source supplies its own notion of identity.
 */
export const sourceFingerprint = async (
  source: SnapshotSource,
  manifest: Manifest,
): Promise<string> => {
  const names: string[] = []
  for (const step of RESOURCES) {
    if ((manifest.resources[step.name]?.count ?? 0) === 0) continue
    names.push(step.name)
    if (step.kind === 'child') names.push(`${step.name}.lineage`)
  }
  const lines = await Promise.all(
    names.sort().map(async (name) => `${name}=${await source.fingerprint(name)}`),
  )
  return sha256Hex(lines.join('\n'))
}
