import type BetterSqlite3 from 'better-sqlite3'
import {
  CsvApplyRefusal,
  canonicalCsvApplyCommand,
  type CsvApplyAuthorization,
  type CsvApplyContext,
  type CsvApplyLease,
  type CsvApplyCode,
  type CsvApplyState,
  type CsvStagingAuthority,
} from '@ezacto/core'
import type { CompiledQuery } from './tracked-state.js'
import { csvStagingSessionFence } from './csv-staging-authority.js'

interface Row {
  id: number
  browser_plan_id: string
  browser_plan_json: string
  browser_state: CsvApplyContext['nativeState']
  total_rows: number
  committed_chunks: number
  finished_at: string | null
  lease_generation: number
  lease_holder: string | null
  lease_expires_at: number | null
  apply_state: CsvApplyState | null
  apply_code: CsvApplyCode | null
  apply_ready: number
  apply_stage_id: string | null
  apply_stage_version: number | null
  apply_preview_id: string | null
  apply_target_nonce: string | null
  apply_session_id: number | null
  apply_actor_user_id: number | null
  apply_input_expires_at: string | null
  apply_request_json: string | null
  apply_receipts_json: string
  apply_command_id: string | null
  apply_confirmation_command_id: string | null
  apply_cancel_command_id: string | null
  apply_source_seconds_total: number | null
  apply_acknowledged_destination_delta: number | null
  apply_attempts: number
  apply_failure_chunk: number | null
  apply_next_attempt_at: string | null
}
const epochSql = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)"
const context = (row: Row): CsvApplyContext => ({
  runId: String(row.id),
  stageId: row.apply_stage_id!,
  stageVersion: row.apply_stage_version!,
  previewId: row.apply_preview_id!,
  targetNonce: row.apply_target_nonce!,
  authority: { userId: row.apply_actor_user_id ?? 0, sessionRowId: row.apply_session_id ?? 0 },
  inputExpiresAt: row.apply_input_expires_at!,
  commandId: row.apply_command_id!,
  confirmationCommandId: row.apply_confirmation_command_id!,
  requestJson: row.apply_request_json!,
  sourceSecondsTotal: row.apply_source_seconds_total!,
  acknowledgedDestinationDelta: row.apply_acknowledged_destination_delta!,
  ready: row.apply_ready === 1,
  state:
    row.browser_state === 'complete'
      ? 'complete'
      : row.browser_state === 'cancelled'
        ? 'cancelled'
        : row.apply_state!,
  code: row.apply_code,
  attempts: row.apply_attempts,
  failureChunk: row.apply_failure_chunk,
  nextAttemptAt: row.apply_next_attempt_at,
  committedRows: row.committed_chunks,
  selectedRows: (JSON.parse(row.browser_plan_json) as { selectedRows: number }).selectedRows,
  fileRows: row.total_rows,
  leaseGeneration: row.lease_generation,
  leaseHolder: row.lease_holder,
  leaseExpiresAt: row.lease_expires_at,
  nativeState: row.browser_state,
  finishedAt: row.finished_at,
})
const validRun = (id: string): number => {
  if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))
    throw new CsvApplyRefusal('run_not_found')
  return Number(id)
}
const validAuthority = (authority: CsvStagingAuthority): boolean =>
  Number.isSafeInteger(authority.userId) &&
  authority.userId > 0 &&
  Number.isSafeInteger(authority.sessionRowId) &&
  authority.sessionRowId > 0

/** Metadata operations are bounded synchronous SQLite statements. No raw input or job payload is stored here. */
export const createCsvApplyRunStore = (sqlite: BetterSqlite3.Database) => {
  const one = <T>(sql: string, params: readonly unknown[] = []) =>
    sqlite.prepare(sql).get(...params) as T | undefined
  const raw = (runId: string) =>
    one<Row>('SELECT * FROM csv_import_runs WHERE id=? AND browser_plan_json IS NOT NULL', [
      validRun(runId),
    ])
  const read = (runId: string): CsvApplyContext | null => {
    const row = raw(runId)
    return row?.apply_state ? context(row) : null
  }
  const session = (authority: CsvStagingAuthority, nonce: string): CompiledQuery =>
    validAuthority(authority) ? csvStagingSessionFence(authority, nonce) : { sql: '0', params: [] }
  const same = (expected: CsvApplyContext): CompiledQuery => ({
    sql: 'id=? AND apply_stage_id=? AND apply_preview_id=? AND apply_target_nonce=? AND apply_command_id=? AND apply_session_id IS ? AND apply_actor_user_id IS ?',
    params: [
      validRun(expected.runId),
      expected.stageId,
      expected.previewId,
      expected.targetNonce,
      expected.commandId,
      expected.authority.sessionRowId || null,
      expected.authority.userId || null,
    ],
  })
  const inspect = (expected: CsvApplyContext): 'ok' | CsvApplyCode | 'stale_lease' => {
    const row = raw(expected.runId)
    if (
      !row ||
      row.apply_command_id !== expected.commandId ||
      row.apply_stage_id !== expected.stageId ||
      row.apply_preview_id !== expected.previewId ||
      row.apply_target_nonce !== expected.targetNonce
    )
      return 'stale_lease'
    if (row.browser_state === 'cancelled') return 'cancelled_by_administrator'
    const target = one<{ nonce: string }>(
      'SELECT nonce FROM csv_staging_instance WHERE singleton=1',
    )
    if (target?.nonce !== expected.targetNonce) return 'input_unavailable'
    if (!validAuthority(expected.authority)) return 'authority_revoked'
    const proof = session(expected.authority, expected.targetNonce)
    if (one<{ allowed: number }>(`SELECT (${proof.sql}) AS allowed`, proof.params)?.allowed !== 1) {
      const record = one<{ revoked_at: string | null; expired: number }>(
        "SELECT revoked_at,(julianday(idle_expires_at)<=julianday('now') OR julianday(absolute_expires_at)<=julianday('now')) AS expired FROM sessions WHERE id=? AND user_id=?",
        [expected.authority.sessionRowId, expected.authority.userId],
      )
      return record && record.revoked_at === null && record.expired === 1
        ? 'authority_expired'
        : 'authority_revoked'
    }
    return one<{ valid: number }>("SELECT julianday(?)>julianday('now') AS valid", [
      expected.inputExpiresAt,
    ])?.valid === 1
      ? 'ok'
      : 'input_expired'
  }
  return {
    read,
    inspect,
    activate(expected: CsvApplyContext): CsvApplyContext {
      const cas = same(expected),
        proof = session(expected.authority, expected.targetNonce)
      const row = one<Row>(
        `UPDATE csv_import_runs SET apply_ready=1 WHERE ${cas.sql} AND browser_state='partial' AND apply_state='queued' AND(${proof.sql}) AND julianday(apply_input_expires_at)>julianday('now') RETURNING *`,
        [...cas.params, ...proof.params],
      )
      if (!row) throw new CsvApplyRefusal('authority_required')
      return context(row)
    },
    recordStageVersion(expected: CsvApplyContext, version: number): CsvApplyContext | null {
      if (!Number.isSafeInteger(version) || version < expected.stageVersion)
        throw new CsvApplyRefusal('binding_mismatch')
      const cas = same(expected)
      const row = one<Row>(
        `UPDATE csv_import_runs SET apply_stage_version=? WHERE ${cas.sql} AND lease_generation=? AND apply_stage_version<=? RETURNING *`,
        [version, ...cas.params, expected.leaseGeneration, version],
      )
      return row ? context(row) : null
    },
    findByStage(stageId: string): CsvApplyContext | null {
      const row = one<Row>(
        'SELECT * FROM csv_import_runs WHERE apply_stage_id=? ORDER BY id DESC LIMIT 1',
        [stageId],
      )
      return row?.apply_state ? context(row) : null
    },
    readReceipt(
      runId: string,
      commandId: string,
    ): { stageId: string; actorUserId: number; targetNonce: string; requestJson: string } | null {
      const row = raw(runId)
      if (!row) return null
      const receipts = JSON.parse(row.apply_receipts_json) as Record<
        string,
        { stageId: string; actorUserId: number; targetNonce: string; requestJson: string }
      >
      return Object.hasOwn(receipts, commandId) ? receipts[commandId]! : null
    },
    summary(runId: string) {
      const id = validRun(runId)
      const progress = one<{
        insertedRows: number
        alreadyImportedRows: number
        sourceSecondsCommitted: number
        destinationSeconds: number
        deletedImportedRows: number
      }>(
        `
        SELECT coalesce(sum(chunk.inserted_rows),0) AS insertedRows,
          coalesce(sum(chunk.already_imported_rows),0) AS alreadyImportedRows,
          coalesce(sum(chunk.source_seconds),0) AS sourceSecondsCommitted,
          coalesce(sum(time.rounded_seconds),0) AS destinationSeconds,
          coalesce(sum(CASE WHEN time.id IS NULL THEN 1 ELSE 0 END),0) AS deletedImportedRows
        FROM csv_import_chunks chunk JOIN csv_import_runs run ON run.id=chunk.run_id
          JOIN csv_import_entries imported ON imported.source_id=run.source_id AND imported.source_key=chunk.source_key
          LEFT JOIN time_entries time ON time.id=imported.time_entry_id WHERE chunk.run_id=?`,
        [id],
      )!
      const setup = one<{ createdSetup: number }>(
        'SELECT count(*) AS createdSetup FROM csv_import_setup WHERE run_id=?',
        [id],
      )!
      return {
        ...progress,
        ...setup,
        destinationDeltaSeconds: progress.destinationSeconds - progress.sourceSecondsCommitted,
      }
    },
    authorize(input: CsvApplyAuthorization): {
      outcome: 'queued' | 'replayed' | 'terminal'
      run: CsvApplyContext
    } {
      const intent = canonicalCsvApplyCommand(JSON.parse(input.requestJson))
      const row = raw(input.runId)
      if (!row) throw new CsvApplyRefusal('run_not_found')
      if (
        !Number.isSafeInteger(input.stageVersion) ||
        input.stageVersion < 1 ||
        !Number.isSafeInteger(input.sourceSecondsTotal) ||
        input.sourceSecondsTotal < 0 ||
        !Number.isSafeInteger(input.acknowledgedDestinationDelta) ||
        !input.stageId ||
        input.stageId.length > 128 ||
        !input.previewId ||
        input.previewId.length > 128 ||
        !input.commandId ||
        input.commandId.length > 128 ||
        !input.confirmationCommandId ||
        input.confirmationCommandId.length > 128
      )
        throw new CsvApplyRefusal('binding_mismatch')
      const proof = session(input.authority, input.targetNonce)
      if (one<{ allowed: number }>(`SELECT (${proof.sql}) AS allowed`, proof.params)?.allowed !== 1)
        throw new CsvApplyRefusal('authority_required')
      if (
        intent.command.command_id !== input.commandId ||
        intent.command.preview_id !== input.previewId ||
        intent.command.expected_selected_rows !==
          (JSON.parse(row.browser_plan_json) as { selectedRows: number }).selectedRows ||
        intent.command.expected_source_seconds !== input.sourceSecondsTotal ||
        intent.command.expected_destination_seconds - input.sourceSecondsTotal !==
          input.acknowledgedDestinationDelta
      )
        throw new CsvApplyRefusal('binding_mismatch')
      const receipts = JSON.parse(row.apply_receipts_json) as Record<
        string,
        { stageId: string; actorUserId: number; targetNonce: string; requestJson: string }
      >
      const receipt = receipts[input.commandId]
      if (receipt) {
        if (
          receipt.stageId !== input.stageId ||
          receipt.actorUserId !== input.authority.userId ||
          receipt.targetNonce !== input.targetNonce ||
          receipt.requestJson !== intent.json
        )
          throw new CsvApplyRefusal('command_conflict')
        return { outcome: 'replayed', run: context(row) }
      }
      if (Object.keys(receipts).length >= 256) throw new CsvApplyRefusal('command_limit_reached')
      if (row.browser_plan_id !== input.planId) throw new CsvApplyRefusal('binding_mismatch')
      if (row.browser_state === 'cancelled') throw new CsvApplyRefusal('cancelled')
      if (row.apply_command_id === input.commandId) {
        if (
          row.apply_stage_id !== input.stageId ||
          row.apply_preview_id !== input.previewId ||
          row.apply_actor_user_id !== input.authority.userId ||
          row.apply_confirmation_command_id !== input.confirmationCommandId
        )
          throw new CsvApplyRefusal('command_conflict')
        return { outcome: 'replayed', run: context(row) }
      }
      if (
        one<{ valid: number }>("SELECT julianday(?)>julianday('now') AS valid", [
          input.inputExpiresAt,
        ])?.valid !== 1
      )
        throw new CsvApplyRefusal('input_expired')
      const prior = row.apply_state ? context(row) : null
      const oldProof = prior
        ? session(prior.authority, prior.targetNonce)
        : { sql: '0', params: [] }
      const priorAllowed = prior && inspect(prior) === 'ok'
      if (
        priorAllowed &&
        (row.apply_state === 'queued' ||
          (row.apply_state === 'running' &&
            row.lease_expires_at !== null &&
            row.lease_expires_at > Date.now()))
      )
        throw new CsvApplyRefusal('apply_busy')
      const state: CsvApplyState = row.browser_state === 'complete' ? 'complete' : 'queued'
      const cas = prior
        ? same(prior)
        : { sql: 'id=? AND apply_state IS NULL', params: [validRun(input.runId)] }
      const result = one<Row>(
        `UPDATE csv_import_runs SET apply_stage_id=?,apply_stage_version=?,apply_preview_id=?,apply_target_nonce=?,apply_session_id=?,apply_actor_user_id=?,apply_input_expires_at=?,apply_command_id=?,apply_confirmation_command_id=?,apply_request_json=?,apply_receipts_json=json_set(apply_receipts_json,?,json(?)),apply_source_seconds_total=?,apply_acknowledged_destination_delta=?,apply_state=?,apply_ready=0,apply_code=NULL,apply_attempts=0,apply_failure_chunk=NULL,apply_next_attempt_at=NULL,lease_expires_at=NULL,lease_holder=NULL,lease_generation=lease_generation+1
        WHERE (${cas.sql}) AND browser_plan_id=? AND browser_state IN('partial','complete') AND lease_generation<9007199254740991 AND(apply_source_seconds_total IS NULL OR apply_source_seconds_total=?) AND (${proof.sql}) AND julianday(?)>julianday('now')
        AND(apply_state IS NULL OR apply_state IN('paused','partial','failed','complete') OR NOT(${oldProof.sql}) OR julianday(apply_input_expires_at)<=julianday('now') OR(apply_state='running' AND(lease_expires_at IS NULL OR lease_expires_at<=${epochSql}))) RETURNING *`,
        [
          input.stageId,
          input.stageVersion,
          input.previewId,
          input.targetNonce,
          input.authority.sessionRowId,
          input.authority.userId,
          input.inputExpiresAt,
          input.commandId,
          input.confirmationCommandId,
          intent.json,
          '$.' + JSON.stringify(input.commandId),
          JSON.stringify({
            stageId: input.stageId,
            actorUserId: input.authority.userId,
            targetNonce: input.targetNonce,
            requestJson: intent.json,
            acceptedAt: new Date().toISOString(),
          }),
          input.sourceSecondsTotal,
          input.acknowledgedDestinationDelta,
          state,
          ...cas.params,
          input.planId,
          input.sourceSecondsTotal,
          ...proof.params,
          input.inputExpiresAt,
          ...oldProof.params,
        ],
      )
      if (!result) {
        const latest = raw(input.runId)
        const receipt = latest
          ? (
              JSON.parse(latest.apply_receipts_json) as Record<
                string,
                { stageId: string; actorUserId: number; targetNonce: string; requestJson: string }
              >
            )[input.commandId]
          : undefined
        if (
          latest &&
          receipt &&
          receipt.stageId === input.stageId &&
          receipt.actorUserId === input.authority.userId &&
          receipt.targetNonce === input.targetNonce &&
          receipt.requestJson === intent.json
        )
          return { outcome: 'replayed', run: context(latest) }
        throw new CsvApplyRefusal('apply_busy')
      }
      return { outcome: state === 'complete' ? 'terminal' : 'queued', run: context(result) }
    },
    /** Bind this immutable context to a fresh C ledger instance, never a global mutable actor. */
    executionFence(expected: CsvApplyContext, actorUserId: number): CompiledQuery {
      const proof = validAuthority(expected.authority)
        ? csvStagingSessionFence(expected.authority, expected.targetNonce, actorUserId)
        : { sql: '0', params: [] }
      const cas = same(expected)
      return {
        sql: `(${proof.sql}) AND EXISTS(SELECT 1 FROM csv_import_runs WHERE ${cas.sql} AND browser_state='partial' AND apply_ready=1 AND(apply_state IN('queued','running') OR(apply_state='partial' AND apply_attempts<3 AND(apply_next_attempt_at IS NULL OR julianday(apply_next_attempt_at)<=julianday('now')))) AND julianday(apply_input_expires_at)>julianday('now'))`,
        params: [...proof.params, ...cas.params],
      }
    },
    listUnbound(limit = 1): CsvApplyContext[] {
      const rows = sqlite
        .prepare(
          `SELECT * FROM csv_import_runs WHERE apply_state='queued' AND apply_ready=0 AND browser_state='partial' AND apply_target_nonce=(SELECT nonce FROM csv_staging_instance WHERE singleton=1) ORDER BY id LIMIT ?`,
        )
        .all(Math.max(1, Math.min(10, limit))) as Row[]
      return rows.map(context)
    },
    listReady(limit = 1): CsvApplyContext[] {
      const rows = sqlite
        .prepare(
          `SELECT * FROM csv_import_runs WHERE apply_state IS NOT NULL AND apply_target_nonce=(SELECT nonce FROM csv_staging_instance WHERE singleton=1)
        AND((browser_state='partial' AND apply_ready=1 AND apply_state IN('queued','running','partial') AND apply_attempts<3 AND(apply_next_attempt_at IS NULL OR julianday(apply_next_attempt_at)<=julianday('now')) AND(lease_expires_at IS NULL OR lease_expires_at<=${epochSql}))
        OR(browser_state IN('complete','cancelled') AND apply_state NOT IN('complete','cancelled'))) ORDER BY id LIMIT ?`,
        )
        .all(Math.max(1, Math.min(10, limit))) as Row[]
      return rows.map(context)
    },
    markRunning(expected: CsvApplyContext, lease: CsvApplyLease): CsvApplyContext {
      const cas = same(expected)
      const row = one<Row>(
        `UPDATE csv_import_runs SET apply_state='running',apply_code=NULL WHERE ${cas.sql} AND browser_state='partial' AND apply_ready=1 AND lease_holder=? AND lease_generation=? AND lease_expires_at>${epochSql} RETURNING *`,
        [...cas.params, lease.holder, lease.generation],
      )
      if (!row) throw new CsvApplyRefusal('stale_lease')
      return context(row)
    },
    settle(
      expected: CsvApplyContext,
      lease: CsvApplyLease | null,
      state: CsvApplyState,
      code: CsvApplyCode | null,
      options: {
        attempts?: number
        failureChunk?: number | null
        nextAttemptAt?: string | null
      } = {},
    ): CsvApplyContext | null {
      const cas = same(expected)
      const leaseGuard = lease
        ? ' AND lease_holder=? AND lease_generation=?'
        : ` AND(browser_state IN('complete','cancelled') OR lease_expires_at IS NULL OR lease_expires_at<=${epochSql})`
      const params: unknown[] = [
        state,
        code,
        options.attempts ?? expected.attempts,
        options.failureChunk ?? null,
        options.nextAttemptAt ?? null,
        ...cas.params,
      ]
      if (lease) params.push(lease.holder, lease.generation)
      const row = one<Row>(
        `UPDATE csv_import_runs SET apply_state=?,apply_code=?,apply_attempts=?,apply_failure_chunk=?,apply_next_attempt_at=?,lease_expires_at=NULL,lease_holder=NULL
        WHERE ${cas.sql}${leaseGuard} AND(browser_state='partial' OR(browser_state='complete' AND ?='complete') OR(browser_state='cancelled' AND ?='cancelled')) RETURNING *`,
        [...params, state, state],
      )
      return row ? context(row) : null
    },
    cancel(
      authority: CsvStagingAuthority,
      input: {
        runId: string
        stageId: string
        targetNonce: string
        previewId: string
        executionCommandId: string
        commandId: string
      },
    ): CsvApplyContext {
      const proof = session(authority, input.targetNonce)
      const row = one<Row>(
        `UPDATE csv_import_runs SET browser_state='cancelled',status='aborted',apply_state='cancelled',apply_ready=0,apply_code='cancelled_by_administrator',apply_cancel_command_id=?,finished_at=coalesce(finished_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),lease_expires_at=NULL,lease_holder=NULL
        WHERE id=? AND apply_stage_id=? AND apply_target_nonce=? AND apply_preview_id=? AND apply_command_id=? AND browser_state IN('partial','cancelled') AND(${proof.sql}) RETURNING *`,
        [
          input.commandId,
          validRun(input.runId),
          input.stageId,
          input.targetNonce,
          input.previewId,
          input.executionCommandId,
          ...proof.params,
        ],
      )
      if (!row) throw new CsvApplyRefusal('run_not_found')
      return context(row)
    },
    verifyStageBinding(input: {
      stageId: string
      targetNonce: string
      nativeRunId: number
      previewId: string
      leaseGeneration: number
      commandId: string
    }): boolean {
      return !!one(
        'SELECT 1 FROM csv_import_runs CROSS JOIN csv_staging_instance target WHERE csv_import_runs.id=? AND apply_stage_id=? AND apply_target_nonce=? AND target.nonce=? AND apply_preview_id=? AND lease_generation=? AND apply_confirmation_command_id=?',
        [
          input.nativeRunId,
          input.stageId,
          input.targetNonce,
          input.targetNonce,
          input.previewId,
          input.leaseGeneration,
          input.commandId,
        ],
      )
    },
  }
}
