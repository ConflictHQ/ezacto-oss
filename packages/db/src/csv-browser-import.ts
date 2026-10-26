import {
  CsvBrowserLedgerRefusal,
  CSV_BROWSER_MAX_DATA_ROWS,
  csvPlanDifference,
  csvPlanId,
  type AdministratorActor,
  type CsvBrowserCommit,
  type CsvBrowserExisting,
  type CsvBrowserSetupKind,
  type CsvBrowserDatasetLedger,
  type CsvDatasetRun,
  type CsvPlanInput,
} from '@ezacto/core'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { DrizzleTrackedResourceRepository } from './tracked-resource-repository.js'
import { atomicStatements } from './atomic-statements.js'
import type { InvoiceStateDatabase } from './invoice-state.js'
import type { CompiledQuery } from './tracked-state.js'
import { createGeneralResourceRepository } from './general-resources.js'
import { isDuplicateCsvImportKey } from './csv-imports.js'

const digest = (text: string): string => bytesToHex(sha256(new TextEncoder().encode(text)))
function refuse(code: ConstructorParameters<typeof CsvBrowserLedgerRefusal>[0]): never {
  throw new CsvBrowserLedgerRefusal(code)
}
const actorId = (actor: AdministratorActor): number => {
  const id = Number(actor.userId)
  if (
    actor.kind !== 'administrator' ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    String(id) !== actor.userId
  )
    refuse('actor_required')
  return id
}
const authority = `EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.profile='administrator'
  AND u.is_active=1 AND NOT EXISTS(SELECT 1 FROM account_closures c WHERE c.user_id=u.id))
  AND NOT EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed'
    AND (status<>'cancelled' OR started_at IS NOT NULL))`
interface RunRow extends Record<string, unknown> {
  id: number
  source_id: string
  browser_plan_json: string
  browser_plan_id: string
  browser_state: CsvDatasetRun['status']
  confirmed_by_user_id: number | null
  lease_holder: string | null
  lease_actor_user_id: number | null
  lease_generation: number
  lease_expires_at: number | null
  committed_chunks: number
}
const mapRun = (row: RunRow, written = 0, alreadyImported = 0): CsvDatasetRun => ({
  runId: String(row.id),
  planId: row.browser_plan_id,
  plan: JSON.parse(row.browser_plan_json) as CsvPlanInput,
  status: row.browser_state,
  actor:
    row.confirmed_by_user_id === null
      ? null
      : {
          kind: 'administrator',
          userId: String(row.confirmed_by_user_id),
        },
  written,
  alreadyImported,
})
const validPlan = (plan: CsvPlanInput): void => {
  if (
    !/^browser:[a-f0-9]{56}$/.test(plan.datasetId) ||
    !/^[a-f0-9]{64}$/.test(plan.fileSha256) ||
    !/^[a-f0-9]{64}$/.test(plan.mappingSha256) ||
    !Number.isSafeInteger(plan.identityVersion) ||
    plan.identityVersion < 1 ||
    plan.dateFormat !== 'iso' ||
    typeof plan.fileRows !== 'number' ||
    !Number.isSafeInteger(plan.fileRows) ||
    plan.fileRows < 0 ||
    plan.fileRows > CSV_BROWSER_MAX_DATA_ROWS ||
    typeof plan.selectedRows !== 'number' ||
    !Number.isSafeInteger(plan.selectedRows) ||
    plan.selectedRows < 0 ||
    plan.selectedRows > plan.fileRows ||
    typeof plan.exporterZone !== 'string' ||
    plan.exporterZone.trim().length === 0 ||
    plan.adapterId.length < 1 ||
    plan.adapterId.length > 128 ||
    plan.destinationVersion.length < 1 ||
    plan.destinationVersion.length > 1024 ||
    plan.excludedLines.some((line) => !Number.isSafeInteger(line) || line < 1)
  )
    throw new RangeError('Invalid CSV plan')
  try {
    new Intl.DateTimeFormat('en', { timeZone: plan.exporterZone })
  } catch {
    throw new RangeError('Invalid CSV exporter zone')
  }
}

/** Uses the existing tracked writer and imported-row key ledger. The destination
 * predicate is compiled by the same native snapshot reader as preview; it must
 * be a pure SQL boolean, so freshness is checked INSIDE the time/key transaction. */
export const createCsvBrowserDatasetLedger = (
  database: InvoiceStateDatabase,
  options: {
    tracked: Pick<DrizzleTrackedResourceRepository, 'createTimeEntry'>
    now: () => Date
    /** Trusted request/job authority, repeated inside every native write. Offline CLI defaults to its existing current-role guard. */
    authorityFence?: (actor: AdministratorActor) => CompiledQuery
    destinationFence: (
      plan: CsvPlanInput,
      pendingSetup?: {
        kind: CsvBrowserSetupKind
        entityIdSql: string
        entityIdParams: readonly unknown[]
      },
    ) => CompiledQuery
    /** Canonical relevant-facts hash expression, evaluated after default relations in the same creation batch. */
    setupFacts: (
      kind: CsvBrowserSetupKind,
      entityIdSql: string,
      entityIdParams: readonly unknown[],
    ) => CompiledQuery
    /** Deterministic native-clock seam for tests; normal runtimes use SQLite's live statement clock. */
    clockSql?: () => CompiledQuery
  },
): CsvBrowserDatasetLedger => {
  const atomic = (statements: Parameters<typeof atomicStatements>[1]) =>
    atomicStatements(database, statements)
  const rows = async <T extends Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> => (await atomic([{ text, params }]))[0] as T[]
  const boundAuthority = (actor: AdministratorActor): CompiledQuery => {
    const extra = options.authorityFence?.(actor) ?? { sql: '1', params: [] }
    return {
      sql: `(${authority}) AND (${extra.sql})`,
      params: [actorId(actor), ...extra.params],
    }
  }
  const checkActor = async (actor: AdministratorActor): Promise<number> => {
    const id = actorId(actor)
    const authorized = boundAuthority(actor)
    const [row] = await rows<{ allowed: number }>(`SELECT (${authorized.sql}) AS allowed`,
      authorized.params,
    )
    if (row?.allowed !== 1) refuse('actor_required')
    return id
  }
  const read = async (runId: string): Promise<RunRow | undefined> => {
    if (!/^[1-9][0-9]*$/.test(runId)) refuse('unknown_run')
    return (
      await rows<RunRow>(
        'SELECT * FROM csv_import_runs WHERE id=? AND browser_plan_json IS NOT NULL',
        [runId],
      )
    )[0]
  }
  const result = async (row: RunRow): Promise<CsvDatasetRun> => {
    const [counts] = await rows<{ written: number; duplicates: number }>(
      `SELECT coalesce(sum(inserted_rows),0) AS written,coalesce(sum(already_imported_rows),0) AS duplicates
       FROM csv_import_chunks WHERE run_id=?`,
      [row.id],
    )
    return mapRun(row, counts?.written, counts?.duplicates)
  }
  const fence = (
    actor: AdministratorActor,
    input: Pick<CsvBrowserCommit, 'runId' | 'planId' | 'holder' | 'leaseGeneration'>,
    plan: CsvPlanInput,
    pendingSetup?: {
      kind: CsvBrowserSetupKind
      entityIdSql: string
      entityIdParams: readonly unknown[]
    },
    checkDestination = true,
  ): CompiledQuery => {
    const authorized = boundAuthority(actor)
    const destination = checkDestination
      ? options.destinationFence(plan, pendingSetup)
      : { sql: '1', params: [] }
    const clock = options.clockSql?.() ?? {
      sql: "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)",
      params: [],
    }
    return {
      sql: `(${authorized.sql}) AND EXISTS(SELECT 1 FROM csv_import_runs r
      WHERE r.id=? AND r.browser_plan_id=? AND r.browser_state='partial'
      AND r.lease_actor_user_id=? AND r.lease_holder=? AND r.lease_generation=? AND r.lease_expires_at>(${clock.sql}))
      AND (${destination.sql})`,
      params: [
        ...authorized.params,
        input.runId,
        input.planId,
        actorId(actor),
        input.holder,
        input.leaseGeneration,
        ...clock.params,
        ...destination.params,
      ],
    }
  }
  const assertLive = async (
    actor: AdministratorActor,
    input: Pick<CsvBrowserCommit, 'runId' | 'planId' | 'holder' | 'leaseGeneration'>,
    checkDestination = true,
  ) => {
    await checkActor(actor)
    const row = await read(input.runId)
    if (!row) refuse('unknown_run')
    if (row.browser_plan_id !== input.planId) refuse('stale_plan')
    if (row.browser_state === 'draft') refuse('not_confirmed')
    if (row.browser_state !== 'partial') refuse('cancelled')
    const plan = JSON.parse(row.browser_plan_json) as CsvPlanInput
    const guard = fence(actor, input, plan, undefined, false)
    const destination = checkDestination ? options.destinationFence(plan) : { sql: '1', params: [] }
    const [allowed] = await rows<{ lease_allowed: number; destination_allowed: number }>(
      `SELECT (${guard.sql}) AS lease_allowed, (${destination.sql}) AS destination_allowed`,
      [...guard.params, ...destination.params],
    )
    if (allowed?.lease_allowed !== 1) {
      await checkActor(actor)
      refuse('stale_lease')
    }
    if (allowed.destination_allowed !== 1) refuse('stale_plan')
    return { row, plan }
  }
  const validSource = (input: CsvBrowserExisting): void => {
    if (
      !Number.isSafeInteger(input.line) ||
      input.line < 1 ||
      !Number.isSafeInteger(input.sourceSeconds) ||
      input.sourceSeconds < 0 ||
      !Number.isSafeInteger(input.chunkIndex) ||
      input.chunkIndex < 0 ||
      !input.sourceKey ||
      input.sourceKey.length > 128
    )
      throw new RangeError('Invalid CSV row')
  }
  const assertSourcePosition = async (runId: number, input: CsvBrowserExisting): Promise<void> => {
    const [prior] = await rows<{ chunk_index: number }>(
      'SELECT chunk_index FROM csv_import_chunks WHERE run_id=? AND source_key=?',
      [runId, input.sourceKey],
    )
    if (prior && prior.chunk_index !== input.chunkIndex) refuse('chunk_conflict')
  }
  const progressStatements = (
    actor: AdministratorActor,
    input: CsvBrowserExisting,
    row: RunRow,
    plan: CsvPlanInput,
    now: Date,
    requestHash: string,
    inserted: number,
    checkDestination = true,
    targetUserId?: number,
  ): CompiledQuery[] => {
    const baseGuard = fence(actor, input, plan, undefined, checkDestination)
    const guard =
      targetUserId === undefined
        ? baseGuard
        : {
            sql: `(${baseGuard.sql}) AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=?)`,
            params: [...baseGuard.params, targetUserId],
          }
    const guardedRun = `CASE WHEN (${guard.sql}) AND EXISTS(SELECT 1 FROM csv_import_runs WHERE id=? AND committed_chunks=? AND committed_chunks<CAST(json_extract(browser_plan_json,'$.selectedRows') AS INTEGER))
      AND EXISTS(SELECT 1 FROM csv_import_entries WHERE source_id=? AND source_key=? AND source_line=? AND source_seconds=?) THEN ? ELSE NULL END`
    return [
      {
        sql: `INSERT INTO csv_import_chunks(run_id,actor_user_id,chunk_index,request_sha256,source_key,source_line,source_seconds,inserted_rows,already_imported_rows,committed_at)
      VALUES(${guardedRun},?,?,?,?,?,?,?,?,?) RETURNING run_id`,
        params: [
          ...guard.params,
          row.id,
          input.chunkIndex,
          row.source_id,
          input.sourceKey,
          input.line,
          input.sourceSeconds,
          row.id,
          actorId(actor),
          input.chunkIndex,
          requestHash,
          input.sourceKey,
          input.line,
          input.sourceSeconds,
          inserted,
          1 - inserted,
          now.toISOString(),
        ],
      },
      {
        sql: 'UPDATE csv_import_runs SET committed_chunks=committed_chunks+1,updated_at=? WHERE id=? RETURNING id',
        params: [now.toISOString(), row.id],
      },
    ]
  }
  return {
    async acknowledgeExisting(actor, input) {
      const { row, plan } = await assertLive(actor, input, false)
      validSource(input)
      if (plan.excludedLines.includes(input.line)) refuse('excluded_line')
      await assertSourcePosition(row.id, input)
      const [key] = await rows<{ source_line: number | null; source_seconds: number | null }>(
        'SELECT source_line,source_seconds FROM csv_import_entries WHERE source_id=? AND source_key=?',
        [row.source_id, input.sourceKey],
      )
      if (!key) refuse('source_key_required')
      if (key.source_line === null || key.source_seconds === null)
        refuse('source_identity_unavailable')
      if (key.source_line !== input.line || key.source_seconds !== input.sourceSeconds)
        refuse('chunk_conflict')
      const replay = async () => {
        const [chunk] = await rows<{
          source_key: string
          source_line: number
          source_seconds: number
          inserted_rows: number
        }>(
          'SELECT source_key,source_line,source_seconds,inserted_rows FROM csv_import_chunks WHERE run_id=? AND chunk_index=?',
          [row.id, input.chunkIndex],
        )
        if (!chunk) return null
        if (
          chunk.source_key !== input.sourceKey ||
          chunk.source_line !== input.line ||
          chunk.source_seconds !== input.sourceSeconds
        )
          refuse('chunk_conflict')
        return {
          outcome: chunk.inserted_rows === 1 ? ('written' as const) : ('duplicate' as const),
        }
      }
      const existing = await replay()
      if (existing) return existing
      if (input.chunkIndex !== row.committed_chunks) refuse('chunk_conflict')
      try {
        const hash = digest(JSON.stringify([input.sourceKey, input.line, input.sourceSeconds]))
        await atomic(
          progressStatements(actor, input, row, plan, options.now(), hash, 0, false).map(
            (query) => ({ text: query.sql, params: query.params }),
          ),
        )
        return { outcome: 'duplicate' }
      } catch (error) {
        await assertLive(actor, input, false)
        await assertSourcePosition(row.id, input)
        const raced = await replay()
        if (raced) return raced
        throw error
      }
    },
    async setup(actor, input) {
      const { row, plan } = await assertLive(actor, input)
      const targetUserId =
        input.kind === 'user-assignments' ? Number(input.input.userId) : undefined
      if (targetUserId !== undefined) {
        if (!Number.isSafeInteger(targetUserId) || targetUserId < 1)
          throw new RangeError('Invalid CSV assignment target')
        if (
          (await rows('SELECT user_id FROM account_closures WHERE user_id=?', [targetUserId]))
            .length
        )
          refuse('stale_plan')
      }
      if (!input.setupKey || input.setupKey.length > 128)
        throw new RangeError('Invalid CSV setup key')
      const requestHash = digest(
        JSON.stringify([
          input.kind,
          Object.entries(input.input).sort(([a], [b]) => a.localeCompare(b)),
        ]),
      )
      const lookup = async () => {
        const [stored] = await rows<{
          entity_kind: string
          entity_id: number
          request_sha256: string
        }>(
          'SELECT entity_kind,entity_id,request_sha256 FROM csv_import_setup WHERE run_id=? AND setup_key=?',
          [row.id, input.setupKey],
        )
        if (!stored) return null
        if (stored.entity_kind !== input.kind || stored.request_sha256 !== requestHash)
          refuse('chunk_conflict')
        return createGeneralResourceRepository(database).get(input.kind, stored.entity_id, {
          userId: actorId(actor),
          profile: 'administrator',
          managerGrants: [],
        })
      }
      const existing = await lookup()
      if (existing) return existing
      const now = options.now()
      const resources = createGeneralResourceRepository(database, {
        followUps(kind, table) {
          if (kind !== input.kind) throw new Error('CSV setup kind mismatch')
          const baseGuard = fence(actor, input, plan, {
            kind: input.kind,
            entityIdSql: `(SELECT max(id) FROM ${table})`,
            entityIdParams: [],
          })
          const guard =
            targetUserId === undefined
              ? baseGuard
              : {
                  sql: `(${baseGuard.sql}) AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=?)`,
                  params: [...baseGuard.params, targetUserId],
                }
          return [
            {
              text: `INSERT INTO csv_import_setup(run_id,actor_user_id,setup_key,entity_kind,entity_id,request_sha256,created_at)
            VALUES(CASE WHEN changes()=1 AND (${guard.sql}) THEN ? ELSE NULL END,?,?,?,(SELECT max(id) FROM ${table}),?,?) RETURNING entity_id`,
              params: [
                ...guard.params,
                row.id,
                actorId(actor),
                input.setupKey,
                kind,
                requestHash,
                now.toISOString(),
              ],
            },
          ]
        },
        afterRelations() {
          const finalGuard = fence(actor, input, plan, undefined, false)
          const facts = options.setupFacts(
            input.kind,
            '(SELECT entity_id FROM csv_import_setup WHERE run_id=? AND setup_key=?)',
            [row.id, input.setupKey],
          )
          return [
            {
              text: `UPDATE csv_import_setup SET policy_facts_sha256=CASE WHEN (${finalGuard.sql}) THEN (${facts.sql}) ELSE NULL END
            WHERE run_id=? AND setup_key=? RETURNING entity_id`,
              params: [...finalGuard.params, ...facts.params, row.id, input.setupKey],
            },
          ]
        },
      })
      try {
        return await resources.create(input.kind, input.input, now.toISOString(), {
          userId: actorId(actor),
          profile: 'administrator',
          managerGrants: [],
        })
      } catch (error) {
        await assertLive(actor, input)
        const raced = await lookup()
        if (raced) return raced
        throw error
      }
    },
    async registerDataset(actor, input) {
      await checkActor(actor)
      const authorized = boundAuthority(actor)
      if (
        input.workspaceIdentity.length < 1 ||
        input.workspaceIdentity.length > 255 ||
        input.workspaceIdentity.trim() !== input.workspaceIdentity
      )
        throw new RangeError('Invalid CSV workspace identity')
      const sourceId = `browser:${digest(input.workspaceIdentity).slice(0, 56)}`
      const [registeredBefore] = await rows<{ workspace_identity: string }>(
        'SELECT workspace_identity FROM csv_import_datasets WHERE singleton=1',
      )
      if (registeredBefore && registeredBefore.workspace_identity !== input.workspaceIdentity)
        refuse('dataset_conflict')
      try {
        await atomic([
          {
            text: `INSERT INTO csv_import_datasets(source_id,workspace_identity,created_at)
        SELECT ?,?,? WHERE (${authorized.sql}) ON CONFLICT(workspace_identity) DO NOTHING RETURNING source_id`,
            params: [sourceId, input.workspaceIdentity, options.now().toISOString(), ...authorized.params],
          },
        ])
      } catch (error) {
        await checkActor(actor)
        const [winner] = await rows<{ workspace_identity: string }>(
          'SELECT workspace_identity FROM csv_import_datasets WHERE singleton=1',
        )
        if (winner && winner.workspace_identity !== input.workspaceIdentity)
          refuse('dataset_conflict')
        throw error
      }
      await checkActor(actor)
      const [registered] = await rows<{ source_id: string }>(
        'SELECT source_id FROM csv_import_datasets WHERE workspace_identity=?',
        [input.workspaceIdentity],
      )
      if (!registered) refuse('actor_required')
      return registered.source_id
    },
    async seal(actor, input, confirm) {
      const id = await checkActor(actor)
      const authorized = boundAuthority(actor)
      validPlan(input)
      const plan = {
        ...input,
        excludedLines: [...new Set(input.excludedLines)].sort((a, b) => a - b),
      }
      const [dataset] = await rows('SELECT source_id FROM csv_import_datasets WHERE source_id=?', [
        plan.datasetId,
      ])
      if (!dataset) refuse('dataset_required')
      const [existing] = await rows<RunRow>(
        'SELECT * FROM csv_import_runs WHERE source_id=? AND browser_plan_json IS NOT NULL',
        [plan.datasetId],
      )
      if (existing && existing.browser_state !== 'draft') {
        const difference = csvPlanDifference(
          JSON.parse(existing.browser_plan_json) as CsvPlanInput,
          plan,
        )
        if (difference)
          return { outcome: 'blocked', reason: difference, run: await result(existing) }
        return { outcome: 'reopened', run: await result(existing) }
      }
      const now = options.now().toISOString()
      const planId = csvPlanId(plan)
      const destination = options.destinationFence(plan)
      const [sealedRows] = await atomic([
        {
          text: `INSERT INTO csv_import_runs
        (source_id,file_sha256,mapping_json,mapping_sha256,status,total_rows,created_at,updated_at,
        browser_plan_json,browser_plan_id,browser_state,confirmed_by_user_id)
        SELECT ?,?,?,?,'partial',?,?,?,?,?,?,? WHERE (${authorized.sql}) AND (${destination.sql})
        ON CONFLICT(source_id) WHERE browser_plan_json IS NOT NULL DO UPDATE SET
          file_sha256=excluded.file_sha256,mapping_json=excluded.mapping_json,mapping_sha256=excluded.mapping_sha256,total_rows=excluded.total_rows,
          updated_at=excluded.updated_at,browser_plan_json=excluded.browser_plan_json,browser_plan_id=excluded.browser_plan_id,
          browser_state=excluded.browser_state,confirmed_by_user_id=excluded.confirmed_by_user_id
        WHERE csv_import_runs.browser_state='draft' RETURNING id`,
          params: [
            plan.datasetId,
            plan.fileSha256,
            JSON.stringify({ mappingSha256: plan.mappingSha256 }),
            plan.mappingSha256,
            plan.fileRows,
            now,
            now,
            JSON.stringify(plan),
            planId,
            confirm ? 'partial' : 'draft',
            confirm ? id : null,
            ...authorized.params,
            ...destination.params,
          ],
        },
      ])
      await checkActor(actor)
      const [saved] = await rows<RunRow>(
        'SELECT * FROM csv_import_runs WHERE source_id=? AND browser_plan_json IS NOT NULL',
        [plan.datasetId],
      )
      if (!sealedRows?.length && (!saved || saved.browser_state === 'draft'))
        return { outcome: 'blocked', reason: 'stale_plan', run: saved ? await result(saved) : null }
      if (!saved) refuse('actor_required')
      if (saved.browser_plan_id !== planId)
        return { outcome: 'blocked', reason: 'stale_plan', run: await result(saved) }
      return { outcome: existing ? 'reopened' : 'created', run: await result(saved) }
    },
    async getRun(actor, runId) {
      await checkActor(actor)
      const row = await read(runId)
      return row ? result(row) : null
    },
    async claimLease(actor, input) {
      const id = await checkActor(actor)
      const authorized = boundAuthority(actor)
      if (
        !input.holder ||
        input.holder.length > 128 ||
        !Number.isSafeInteger(input.ttlMs) ||
        input.ttlMs < 1 ||
        input.ttlMs > 300000
      )
        throw new RangeError('Invalid CSV lease')
      const row = await read(input.runId)
      if (!row) refuse('unknown_run')
      if (row.browser_state === 'draft') refuse('not_confirmed')
      if (row.browser_state !== 'partial') refuse('cancelled')
      const now = options.now().getTime()
      const [updated] = await atomic([
        {
          text: `UPDATE csv_import_runs SET lease_holder=?,lease_actor_user_id=?,lease_generation=lease_generation+1,lease_expires_at=?
        WHERE id=? AND browser_state='partial' AND (lease_expires_at IS NULL OR lease_expires_at<=?)
        AND lease_generation<9007199254740991 AND (${authorized.sql}) RETURNING lease_generation,lease_expires_at`,
          params: [input.holder, id, now + input.ttlMs, input.runId, now, ...authorized.params],
        },
      ])
      const claimed = updated?.[0]
      if (claimed)
        return {
          outcome: 'claimed',
          lease: {
            holder: input.holder,
            generation: Number(claimed.lease_generation),
            expiresAt: Number(claimed.lease_expires_at),
          },
        }
      await checkActor(actor)
      const current = await read(input.runId)
      if (!current || current.browser_state !== 'partial') refuse('cancelled')
      return { outcome: 'held', retryAfterMs: Math.max(0, (current.lease_expires_at ?? now) - now) }
    },
    async commitEntry(actor, input) {
      const { row, plan } = await assertLive(actor, input)
      const targetUserId = input.entry.userId ?? actorId(actor)
      if (
        (await rows('SELECT user_id FROM account_closures WHERE user_id=?', [targetUserId])).length
      )
        refuse('stale_plan')
      validSource(input)
      if (plan.excludedLines.includes(input.line)) refuse('excluded_line')
      await assertSourcePosition(row.id, input)
      const requestHash = digest(
        JSON.stringify([
          input.sourceKey,
          input.line,
          input.sourceSeconds,
          Object.fromEntries(
            Object.entries(input.entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          ),
        ]),
      )
      const replay = async () => {
        const [chunk] = await rows<{ request_sha256: string; inserted_rows: number }>(
          'SELECT request_sha256,inserted_rows FROM csv_import_chunks WHERE run_id=? AND chunk_index=?',
          [row.id, input.chunkIndex],
        )
        if (!chunk) return null
        if (chunk.request_sha256 !== requestHash) refuse('chunk_conflict')
        return {
          outcome: chunk.inserted_rows === 1 ? ('written' as const) : ('duplicate' as const),
        }
      }
      const previous = await replay()
      if (previous) return previous
      if (input.chunkIndex !== row.committed_chunks) refuse('chunk_conflict')
      const now = options.now()
      const baseGuard = fence(actor, input, plan)
      const guard = {
        sql: `(${baseGuard.sql}) AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=?)`,
        params: [...baseGuard.params, targetUserId],
      }
      // NOT NULL run_id is the aborting guard: SELECT/WHERE zero rows would
      // silently leave the preceding time insert behind, so never use that form.
      const guardedRun = `CASE WHEN (${guard.sql}) AND EXISTS(SELECT 1 FROM csv_import_runs WHERE id=? AND committed_chunks=? AND committed_chunks<CAST(json_extract(browser_plan_json,'$.selectedRows') AS INTEGER)) THEN ? ELSE NULL END`
      const guardParams = [...guard.params, row.id, input.chunkIndex, row.id]
      const progress = (inserted: number): CompiledQuery[] =>
        progressStatements(actor, input, row, plan, now, requestHash, inserted, true, targetUserId)
      const duplicate = async () => {
        const [known] = await rows<{ source_line: number | null; source_seconds: number | null }>(
          'SELECT source_line,source_seconds FROM csv_import_entries WHERE source_id=? AND source_key=?',
          [row.source_id, input.sourceKey],
        )
        if (!known) refuse('source_key_required')
        if (known.source_line === null || known.source_seconds === null)
          refuse('source_identity_unavailable')
        if (known.source_line !== input.line || known.source_seconds !== input.sourceSeconds)
          refuse('chunk_conflict')
        await atomic(progress(0).map((query) => ({ text: query.sql, params: query.params })))
        return { outcome: 'duplicate' as const }
      }
      const [key] = await rows(
        'SELECT id FROM csv_import_entries WHERE source_id=? AND source_key=?',
        [row.source_id, input.sourceKey],
      )
      if (key) return duplicate()
      try {
        await options.tracked.createTimeEntry(
          { userId: actorId(actor), profile: 'administrator' },
          input.entry,
          {
            instant: now.toISOString(),
            date: now.toISOString().slice(0, 10),
            time: now.toISOString().slice(11, 16),
          },
          [
            {
              sql: `INSERT INTO csv_import_entries(run_id,source_id,source_key,time_entry_id,created_at,source_line,source_seconds)
              VALUES(CASE WHEN changes()=1 THEN ${guardedRun} ELSE NULL END,?,?,last_insert_rowid(),?,?,?)`,
              params: [
                ...guardParams,
                row.source_id,
                input.sourceKey,
                now.toISOString(),
                input.line,
                input.sourceSeconds,
              ],
            },
            ...progress(1),
          ],
        )
        return { outcome: 'written' }
      } catch (error) {
        await assertLive(actor, input)
        await assertSourcePosition(row.id, input)
        const raced = await replay()
        if (raced) return raced
        if (isDuplicateCsvImportKey(error)) return duplicate()
        throw error
      }
    },
    async finish(actor, input) {
      const checkDestination = input.status !== 'cancelled'
      const { row, plan } = await assertLive(actor, input, checkDestination)
      if (
        input.status === 'complete' &&
        (!Number.isSafeInteger(plan.selectedRows) || row.committed_chunks !== plan.selectedRows)
      )
        refuse('incomplete_run')
      const baseGuard = fence(actor, input, plan, undefined, checkDestination)
      const guard =
        input.status === 'complete'
          ? {
              sql: `(${baseGuard.sql}) AND EXISTS(SELECT 1 FROM csv_import_runs WHERE id=? AND committed_chunks=CAST(json_extract(browser_plan_json,'$.selectedRows') AS INTEGER))`,
              params: [...baseGuard.params, row.id],
            }
          : baseGuard
      await atomic([
        {
          text: `INSERT INTO csv_import_chunks(run_id,actor_user_id,chunk_index,request_sha256,source_key,source_line,source_seconds,inserted_rows,already_imported_rows,committed_at)
        SELECT NULL,?,0,'','',1,0,0,0,'' WHERE NOT (${guard.sql}) RETURNING run_id`,
          params: [actorId(actor), ...guard.params],
        },
        {
          text: `UPDATE csv_import_runs SET browser_state=?,status=?,finished_at=?,updated_at=?,lease_expires_at=NULL
          WHERE id=? RETURNING id`,
          params: [
            input.status,
            input.status === 'complete' ? 'complete' : 'aborted',
            options.now().toISOString(),
            options.now().toISOString(),
            row.id,
          ],
        },
      ])
    },
  }
}
