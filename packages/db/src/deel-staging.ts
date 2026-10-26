import {
  DeelStageError,
  type DeelStageAuthority,
  type DeelStageCommand,
  type DeelStageResult,
  type DeelStageSelection,
  type DeelStageSnapshot,
  type DeelStageStore,
} from '@ezacto/integrations'
import { atomicStatements } from './atomic-statements.js'
import { DEEL_SYNC_STALE_RUN_MS } from './deel-time-sync.js'
import type { InvoiceStateDatabase } from './invoice-state.js'
const statement = (text: string, ...params: unknown[]) => ({ text, params })
const auth = `EXISTS(SELECT 1 FROM users actor JOIN sessions session ON session.user_id=actor.id WHERE actor.id=? AND actor.is_active=1 AND actor.profile='administrator' AND session.id=? AND session.profile_snapshot='administrator' AND session.revoked_at IS NULL AND julianday(session.idle_expires_at)>julianday(?) AND julianday(session.absolute_expires_at)>julianday(?) AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=actor.id))`
const commandData = (authority: DeelStageAuthority, c: DeelStageCommand) => ({
  id: c.id,
  actorId: authority.userId,
  from: c.from,
  to: c.to,
  userIds: [...c.userIds].sort((a, b) => a - b),
  fingerprint: c.fingerprint,
})
const snapshotQuery = (a: DeelStageAuthority, s: DeelStageSelection, now: string) => {
  const text = `WITH selected AS(SELECT CAST(value AS INTEGER) id FROM json_each(?)),payees AS(
 SELECT u.id FROM users u JOIN selected s ON s.id=u.id WHERE u.is_active=1 AND NOT EXISTS(SELECT 1 FROM account_closures closed WHERE closed.user_id=u.id) AND COALESCE((SELECT e.provider FROM staff_payment_provider_events e WHERE e.scope='user:'||u.id ORDER BY e.version DESC LIMIT 1),(SELECT e.provider FROM staff_payment_provider_events e WHERE e.scope='organization' ORDER BY e.version DESC LIMIT 1),'wise')='deel'),
 entries AS(SELECT t.id,t.user_id,t.spent_date,t.rounded_seconds,t.timesheet_submission_id,(SELECT revision.version FROM timesheet_submissions revision WHERE revision.id=t.timesheet_submission_id) approval_version FROM time_entries t JOIN payees p ON p.id=t.user_id WHERE t.approval_status='approved' AND t.timer_started_at IS NULL AND(t.started_time IS NULL OR t.ended_time IS NOT NULL) AND t.spent_date>=? AND t.spent_date<=? ORDER BY t.spent_date,t.id LIMIT 1001),
 directory AS(SELECT p.id,COALESCE((SELECT json_group_array(json_object('address',address,'kind',kind)) FROM(SELECT address,kind FROM user_emails WHERE user_id=p.id AND invalidated_at IS NULL AND verified_at IS NOT NULL AND kind='payroll' ORDER BY id LIMIT 21)),'[]') emails FROM payees p ORDER BY p.id)
 SELECT json_object('authorized',${auth},'validPeople',(SELECT count(*) FROM payees),'facts',json_object('directory',json(COALESCE((SELECT json_group_array(json_object('userId',id,'emails',json(emails))) FROM directory),'[]')),'entries',json(COALESCE((SELECT json_group_array(json_object('id',id,'userId',user_id,'spentDate',spent_date,'roundedSeconds',rounded_seconds,'approvalSubmissionId',timesheet_submission_id,'approvalVersion',approval_version)) FROM entries),'[]'))),
 'log',json(COALESCE((SELECT json_group_array(json_object('entryId',entry_id,'fingerprint',fingerprint,'timesheetId',timesheet_id)) FROM(SELECT l.* FROM deel_transfer_log l JOIN entries e ON e.id=l.entry_id ORDER BY l.entry_id)),'[]')),
 'unresolved',json(COALESCE((SELECT json_group_array(entry_id) FROM(SELECT i.entry_id FROM deel_transfer_intents i JOIN entries e ON e.id=i.entry_id ORDER BY i.entry_id)),'[]'))) snapshot`
  return {
    text,
    params: [JSON.stringify(s.userIds), s.from, s.to, a.userId, a.sessionId, now, now],
  }
}
interface SnapshotWire {
  authorized: number
  validPeople: number
  facts: { directory: DeelStageSnapshot['directory']; entries: DeelStageSnapshot['entries'] }
  log: DeelStageSnapshot['log']
  unresolved: number[]
}
export const createDeelStageStore = (database: InvoiceStateDatabase): DeelStageStore => {
  const atomic = (items: Parameters<typeof atomicStatements>[1]) =>
    atomicStatements(database, items)
  const lookup = async (
    a: DeelStageAuthority,
    c: DeelStageCommand,
    now: string,
  ): Promise<DeelStageResult | null> => {
    const rows = await atomic([
      statement(
        `SELECT ${auth} authorized,(SELECT json_object('id',id,'startedAt',started_at,'outcome',outcome,'timesheets',timesheets_submitted,'entries',entries_transferred,'detail',json(detail)) FROM deel_sync_runs WHERE json_extract(detail,'$.staging_command.id')=? ORDER BY id LIMIT 1) record`,
        a.userId,
        a.sessionId,
        now,
        now,
        c.id,
      ),
    ])
    const row = rows[0]?.[0]
    if (row?.authorized !== 1) throw new DeelStageError('forbidden')
    if (row.record === null) return null
    const record = JSON.parse(String(row.record)) as {
      id: number
      outcome: string
      startedAt: string
      timesheets: number
      entries: number
      detail: { staging_command?: Record<string, unknown>; staging_result?: DeelStageResult }
    }
    const saved = record.detail.staging_command
    if (!saved || JSON.stringify(saved) !== JSON.stringify(commandData(a, c)))
      throw new DeelStageError('command_reused')
    const result = record.detail.staging_result
    if (
      result !== undefined &&
      (result === null ||
        typeof result !== 'object' ||
        !['staged', 'attention', 'running', 'stale', 'busy'].includes(result.status) ||
        result.commandId !== c.id ||
        result.runId !== record.id ||
        ![result.timesheetsStaged, result.entriesStaged, result.alreadyStaged].every(
          (n) => Number.isSafeInteger(n) && n >= 0,
        ) ||
        !Array.isArray(result.unresolved) ||
        result.unresolved.some((n) => !Number.isSafeInteger(n) || n < 1) ||
        (result.code !== null &&
          (typeof result.code !== 'string' || !/^[a-z_]{1,80}$/.test(result.code))))
    )
      throw new DeelStageError('stale')
    const stillRunning =
      record.outcome === 'running' &&
      Date.parse(now) - Date.parse(record.startedAt) < DEEL_SYNC_STALE_RUN_MS
    return (
      result ?? {
        status: stillRunning ? 'running' : 'attention',
        commandId: c.id,
        runId: record.id,
        timesheetsStaged: record.timesheets,
        entriesStaged: record.entries,
        alreadyStaged: 0,
        unresolved: [],
        code: stillRunning ? null : 'interrupted_run',
      }
    )
  }
  return {
    lookup,
    snapshot: async (a, s, now) => {
      const row = (await atomic([snapshotQuery(a, s, now)]))[0]?.[0]
      if (!row) throw new DeelStageError('forbidden')
      const wire = JSON.parse(String(row.snapshot)) as SnapshotWire
      if (wire.authorized !== 1) throw new DeelStageError('forbidden')
      if (
        wire.validPeople !== s.userIds.length ||
        wire.facts.entries.length > 1000 ||
        wire.facts.directory.some((person) => person.emails.length > 20)
      )
        throw new DeelStageError('invalid')
      return {
        ...wire.facts,
        log: wire.log,
        unresolved: wire.unresolved,
        sourceFacts: JSON.stringify(wire.facts),
      }
    },
    begin: async (a, c, snapshot, now) => {
      const current = snapshotQuery(a, c, now),
        before = new Date(Date.parse(now) - 3600000).toISOString()
      const rows = await atomic([
        statement(
          `WITH current AS(${current.text}) UPDATE deel_sync_runs SET outcome='failed',finished_at=?,detail=json_set(COALESCE(detail,'{}'),'$.error','interrupted_run') WHERE outcome='running' AND started_at<? AND EXISTS(SELECT 1 FROM current WHERE json_extract(snapshot,'$.authorized')=1 AND json_extract(snapshot,'$.validPeople')=? AND json_extract(snapshot,'$.facts')=?) RETURNING id`,
          ...current.params,
          now,
          before,
          c.userIds.length,
          snapshot.sourceFacts,
        ),
        statement(
          `WITH current AS(${current.text}) INSERT INTO deel_sync_runs(started_at,outcome,detail) SELECT ?,'running',? FROM current WHERE json_extract(snapshot,'$.authorized')=1 AND json_extract(snapshot,'$.validPeople')=? AND json_extract(snapshot,'$.facts')=? AND NOT EXISTS(SELECT 1 FROM deel_sync_runs WHERE json_extract(detail,'$.staging_command.id')=?) ON CONFLICT DO NOTHING RETURNING id`,
          ...current.params,
          now,
          JSON.stringify({
            staging_command: commandData(a, c),
            staging_contracts: snapshot.contracts,
          }),
          c.userIds.length,
          snapshot.sourceFacts,
          c.id,
        ),
      ])
      const id = rows[1]?.[0]?.id
      if (id === undefined) {
        const latest = await lookup(a, c, now)
        if (latest) return null
        const wire = JSON.parse(
          String((await atomic([current]))[0]?.[0]?.snapshot ?? '{}'),
        ) as SnapshotWire
        if (wire.authorized !== 1) throw new DeelStageError('forbidden')
        if (JSON.stringify(wire.facts) !== snapshot.sourceFacts) throw new DeelStageError('stale')
        return null
      }
      return Number(id)
    },
    claim: async (a, runId, c, snapshot, submission, now) => {
      const current = snapshotQuery(a, c, now),
        entries = JSON.stringify(submission.entries)
      const rows = await atomic([
        statement(
          `WITH current AS(${current.text}), planned AS(SELECT CAST(json_extract(value,'$.entryId') AS INTEGER) id,json_extract(value,'$.fingerprint') fingerprint FROM json_each(?))
    INSERT INTO deel_transfer_intents(entry_id,contract_id,fingerprint,started_at)
    SELECT id,?,fingerprint,? FROM planned WHERE EXISTS(SELECT 1 FROM current WHERE json_extract(snapshot,'$.authorized')=1 AND json_extract(snapshot,'$.facts')=?)
      AND EXISTS(SELECT 1 FROM deel_sync_runs WHERE id=? AND outcome='running' AND json_extract(detail,'$.staging_command.id')=? AND EXISTS(SELECT 1 FROM json_each(detail,'$.staging_contracts') contract WHERE json_extract(contract.value,'$.userId')=? AND json_extract(contract.value,'$.contractId')=?))
      AND (SELECT count(*) FROM planned p JOIN time_entries e ON e.id=p.id WHERE e.user_id=? AND e.spent_date=? AND p.fingerprint=?||':'||e.spent_date||':'||e.rounded_seconds)=(SELECT count(*) FROM planned)
      AND NOT EXISTS(SELECT 1 FROM planned p JOIN deel_transfer_log l ON l.entry_id=p.id)
      AND NOT EXISTS(SELECT 1 FROM planned p JOIN deel_transfer_intents i ON i.entry_id=p.id) RETURNING entry_id`,
          ...current.params,
          entries,
          submission.contractId,
          now,
          snapshot.sourceFacts,
          runId,
          c.id,
          submission.userId,
          submission.contractId,
          submission.userId,
          submission.spentDate,
          submission.contractId,
        ),
      ])
      if (rows[0]?.length === submission.entries.length) return true
      const wire = JSON.parse(
        String((await atomic([current]))[0]?.[0]?.snapshot ?? '{}'),
      ) as SnapshotWire
      if (wire.authorized !== 1) throw new DeelStageError('forbidden')
      return false
    },
    record: async (runId, submission, timesheetId, now) => {
      if (typeof timesheetId !== 'string' || timesheetId.length < 1 || timesheetId.length > 128)
        throw new DeelStageError('invalid')
      const entries = JSON.stringify(submission.entries)
      const statements = [
        statement(
          `WITH planned AS(SELECT CAST(json_extract(value,'$.entryId') AS INTEGER) id,json_extract(value,'$.fingerprint') fingerprint FROM json_each(?))
     INSERT INTO deel_transfer_log(entry_id,fingerprint,timesheet_id,transferred_at)
     SELECT id,fingerprint,?,? FROM planned WHERE NOT EXISTS(SELECT 1 FROM planned p JOIN deel_transfer_log l ON l.entry_id=p.id WHERE l.fingerprint<>p.fingerprint OR l.timesheet_id<>?) ON CONFLICT DO NOTHING RETURNING entry_id`,
          entries,
          timesheetId,
          now,
          timesheetId,
        ),
        statement(
          `UPDATE deel_sync_runs SET timesheets_submitted=timesheets_submitted+CASE WHEN changes()>0 THEN 1 ELSE 0 END,entries_transferred=entries_transferred+changes() WHERE id=? AND outcome='running' RETURNING id`,
          runId,
        ),
        statement(
          `SELECT count(*) matched FROM json_each(?) p JOIN deel_transfer_log l ON l.entry_id=CAST(json_extract(p.value,'$.entryId') AS INTEGER) WHERE l.fingerprint=json_extract(p.value,'$.fingerprint') AND l.timesheet_id=?`,
          entries,
          timesheetId,
        ),
      ]
      try {
        const result = await atomic(statements)
        if (Number(result[2]?.[0]?.matched) !== submission.entries.length)
          throw new DeelStageError('stale')
      } catch (error) {
        const result = await atomic([statements[2]!])
        if (Number(result[0]?.[0]?.matched) !== submission.entries.length) throw error
      }
    },
    release: async (submission) => {
      await atomic([
        statement(
          `DELETE FROM deel_transfer_intents WHERE contract_id=? AND EXISTS(SELECT 1 FROM json_each(?) p WHERE CAST(json_extract(p.value,'$.entryId') AS INTEGER)=deel_transfer_intents.entry_id AND json_extract(p.value,'$.fingerprint')=deel_transfer_intents.fingerprint) RETURNING entry_id`,
          submission.contractId,
          JSON.stringify(submission.entries),
        ),
      ])
    },
    finish: async (runId, result, now) => {
      await atomic([
        statement(
          `UPDATE deel_sync_runs SET outcome=?,finished_at=?,detail=json_set(detail,'$.staging_result',json(?)) WHERE id=? AND outcome='running' RETURNING id`,
          result.status === 'staged' ? 'completed' : 'failed',
          now,
          JSON.stringify(result),
          runId,
        ),
      ])
    },
  }
}
