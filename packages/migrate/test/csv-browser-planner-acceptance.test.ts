import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createTimesheetLockPolicyRepository, createCsvBrowserDatasetLedger, DrizzleTrackedResourceRepository, csvImportDestinationFence, csvImportSetupFacts, registerCsvImportSqliteFunctions } from '@ezacto/db'
import { CLOCKIFY_ADAPTERS, createClockifyBrowserAdapter } from '../src/csv-clockify.js'
import { parseCsv, sourceKeys } from '../src/csv-contract.js'
import { canonicalMapping, emptyMapping } from '../src/csv-mapping.js'
import { csvSourceEntityKeys, parseBrowserMapping } from '../src/csv-browser-mapping.js'
import { applyCsvImport } from '../src/csv-import.js'
import { csvBrowserSealInput, planCsvImportFromSnapshot } from '../src/csv-planner.js'
import { createCsvBrowserWriter } from '../src/csv-browser-writer.js'
import { createSqliteCsvBrowserService } from '../src/csv-browser-sqlite.js'
import { sha256Hex } from '../src/portable-hash.js'
import { readCsvDestinationSnapshot } from '../src/csv-planner-snapshot.js'
import { completeSqliteFingerprint, createOwnedPlannerDestination, plannerAdministrator, plannerFixtureNow } from './support/csv-planner-acceptance.js'

const bytes = readFileSync(new URL('./fixtures/csv-browser-planner/preview.csv', import.meta.url))
const parse = (input: Uint8Array = bytes) => parseCsv(input, createClockifyBrowserAdapter({ exporterZone: 'UTC' }))
const options = { actor: plannerAdministrator, sourceId: 'clockify-owned-acceptance', adapterId: CLOCKIFY_ADAPTERS.browser, exporterZone: 'UTC' }
const lockActor = { userId: 2, profile: 'administrator' } as const

describe('owned SQLite browser planner acceptance', () => {
  let destination: Awaited<ReturnType<typeof createOwnedPlannerDestination>> | undefined
  afterEach(async () => { await destination?.close(); destination = undefined })

  const setup = async () => {
    destination = await createOwnedPlannerDestination()
    return destination
  }
  const preview = (db: NonNullable<typeof destination>, parsed = parse()) => {
    const snapshot = readCsvDestinationSnapshot(db.readonly(), {
      actor: plannerAdministrator, parsed, dates: parsed.rows.map(row => row.date), now: new Date(plannerFixtureNow), sourceId: options.sourceId,
    })
    return planCsvImportFromSnapshot(parsed, emptyMapping(), snapshot, options)
  }

  const nativeLedger = (db: NonNullable<typeof destination>) => {
    registerCsvImportSqliteFunctions(db.writer)
    const database = createContainerDatabase(db.writer)
    return createCsvBrowserDatasetLedger(database, {
      tracked: new DrizzleTrackedResourceRepository(database, createTimesheetLockPolicyRepository(database)),
      now: () => new Date(plannerFixtureNow),
      destinationFence: csvImportDestinationFence,
      setupFacts: csvImportSetupFacts,
      clockSql: () => ({ sql: '?', params: [new Date(plannerFixtureNow).getTime()] }),
    })
  }

  it('previews as the actual nonowner administrator through a readonly connection without changing ANY persisted table', async () => {
    const db = await setup()
    expect(db.writer.prepare('SELECT is_owner FROM users WHERE id=2').get()).toEqual({ is_owner: 0 })
    expect(db.writer.prepare('SELECT is_owner FROM users WHERE id=1').get()).toEqual({ is_owner: 1 })
    const before = completeSqliteFingerprint(db.writer)
    expect(before.tables.sqlite_sequence.count).toBeGreaterThan(0)
    expect(before.tables.event_outbox.count).toBe(1)
    const plan = preview(db)
    expect(plan.actor).toEqual(plannerAdministrator)
    expect(plan.plan.report.entries).toEqual({ total: 1, new: 1, alreadyImported: 0, rejected: 0 })
    expect(plan).toMatchObject({ sourceSeconds: 3601, destinationSeconds: 3600, destinationDeltaSeconds: -1, selectedRows: 1, fileRows: 1, organizationCurrency: 'USD', unpriced: true })
    expect(plan.plan.items[0]).toMatchObject({ person: { id: 3 }, client: { id: 1 }, project: { id: 1 }, task: { id: 1 } })
    expect(db.readonly().readonly).toBe(true)
    expect(db.readonly().pragma('query_only', { simple: true })).toBe(1)
    expect(db.readonly().inTransaction).toBe(false)
    expect(completeSqliteFingerprint(db.writer)).toEqual(before)
  })

  it('refuses a forged administrator kind for an actual member and freshly revoked administrator without mutations', async () => {
    const db = await setup()
    const before = completeSqliteFingerprint(db.writer)
    expect(() => readCsvDestinationSnapshot(db.readonly(), { actor: { kind: 'administrator', userId: '3' }, parsed: parse(), sourceId: options.sourceId, dates: ['2026-09-01'], now: new Date(plannerFixtureNow) })).toThrow('administrator_required')
    expect(completeSqliteFingerprint(db.writer)).toEqual(before)
    db.writer.prepare("UPDATE users SET profile='member' WHERE id=2").run()
    const revoked = completeSqliteFingerprint(db.writer)
    expect(() => preview(db)).toThrow('administrator_required')
    expect(completeSqliteFingerprint(db.writer)).toEqual(revoked)
  })

  it('evaluates an elapsed unmaterialized weekly deadline without writing lock windows', async () => {
    const db = await setup()
    const locks = createTimesheetLockPolicyRepository(createContainerDatabase(db.writer))
    await locks.updateSettings(lockActor, { autoLock: true, timesheetDeadline: { day: 'monday', time: '12:00' }, timezone: 'UTC' }, plannerFixtureNow)
    expect(db.writer.prepare('SELECT count(*) AS n FROM timesheet_lock_windows').get()).toEqual({ n: 0 })
    const before = completeSqliteFingerprint(db.writer)
    const plan = preview(db)
    expect(plan.plan.report.rejected).toEqual(expect.arrayContaining([expect.objectContaining({ line: 2, code: 'period_locked' })]))
    expect(plan.selectedRows).toBe(0)
    expect(completeSqliteFingerprint(db.writer)).toEqual(before)
  })

  it('respects canonical explicit weekly unlock instead of rematerializing its expired deadline', async () => {
    const db = await setup()
    const locks = createTimesheetLockPolicyRepository(createContainerDatabase(db.writer), { clock: () => plannerFixtureNow })
    await locks.updateSettings(lockActor, { autoLock: true, timesheetDeadline: { day: 'monday', time: '12:00' }, timezone: 'UTC' }, plannerFixtureNow)
    // Real mutating policy calls belong to fixture SETUP, before the readonly boundary.
    expect((await locks.lockedDates(['2026-09-01'])).get('2026-09-01')).toBe(true)
    const window = db.writer.prepare("SELECT id FROM timesheet_lock_windows WHERE period_start <= ? AND period_end >= ?").get('2026-09-01', '2026-09-01') as { id: number }
    await locks.unlock(lockActor, window.id, 'Owned acceptance correction', plannerFixtureNow)
    const before = completeSqliteFingerprint(db.writer)
    expect(preview(db).plan.report.entries.new).toBe(1)
    expect(completeSqliteFingerprint(db.writer)).toEqual(before)
  })

  it('uses the canonical manual cutoff and explicit unlock on both sides of the readonly boundary', async () => {
    const db = await setup()
    const locks = createTimesheetLockPolicyRepository(createContainerDatabase(db.writer))
    const lock = await locks.createManualLock(lockActor, '2026-09-01', 'Owned acceptance close', plannerFixtureNow, 'owned-cutoff', `sha256:${'a'.repeat(64)}`)
    const locked = completeSqliteFingerprint(db.writer)
    expect(preview(db).rejectedRows).toBe(1)
    expect(completeSqliteFingerprint(db.writer)).toEqual(locked)
    await locks.unlock(lockActor, lock.id, 'Owned acceptance reopen', plannerFixtureNow)
    const unlocked = completeSqliteFingerprint(db.writer)
    expect(preview(db).selectedRows).toBe(1)
    expect(completeSqliteFingerprint(db.writer)).toEqual(unlocked)
  })

  it('releases its read transaction before an unrelated shared-container write and never rolls it back', async () => {
    const db = await setup()
    const first = preview(db)
    expect(db.readonly().inTransaction).toBe(false)
    // busy_timeout=0 makes a leaked read transaction fail rather than silently wait.
    db.writer.pragma('busy_timeout = 0')
    db.writer.prepare("INSERT INTO tasks(name,created_at,updated_at) VALUES('Unrelated concurrent task',?,?)").run(plannerFixtureNow, plannerFixtureNow)
    const afterWrite = completeSqliteFingerprint(db.writer)
    db.writer.prepare("UPDATE projects SET name='Unrelated renamed project' WHERE id=2").run()
    const afterUnrelatedEdit = completeSqliteFingerprint(db.writer)
    const next = preview(db)
    expect(next.plan.items[0]?.key).toBe(first.plan.items[0]?.key)
    expect(next.destinationVersion).toBe(first.destinationVersion)
    expect(afterWrite.tables.tasks.count).toBe(2)
    expect(completeSqliteFingerprint(db.writer)).toEqual(afterUnrelatedEdit)
    expect(db.writer.prepare("SELECT count(*) AS n FROM tasks WHERE name='Unrelated concurrent task'").get()).toEqual({ n: 1 })
  })

  it('preserves stable parser, mapping and occurrence identity while exclusions retain original source keys', async () => {
    const db = await setup()
    const text = new TextDecoder().decode(bytes).trimEnd()
    const repeated = parse(new TextEncoder().encode(`${text}\n${text.split('\n')[1]}\n`))
    expect(repeated.rows).toHaveLength(2)
    const snapshot = readCsvDestinationSnapshot(db.readonly(), { actor: plannerAdministrator, parsed: repeated, dates: ['2026-09-01'], now: new Date(plannerFixtureNow), sourceId: options.sourceId })
    const mapping = emptyMapping()
    const before = completeSqliteFingerprint(db.writer)
    const original = planCsvImportFromSnapshot(repeated, mapping, snapshot, options)
    const again = planCsvImportFromSnapshot(parse(new TextEncoder().encode(`${text}\n${text.split('\n')[1]}\n`)), emptyMapping(), snapshot, options)
    expect(again).toEqual(original)
    expect(original.plan.fileSha256).toBe(repeated.sha256)
    expect(original.plan.mappingSha256).toBe(canonicalMapping(mapping).sha256)
    expect(original.plan.items.map(item => item.key)).toEqual(sourceKeys(repeated.rows))
    const selectedSnapshot = readCsvDestinationSnapshot(db.readonly(), { actor: plannerAdministrator, parsed: repeated, mapping, excludedLines: [2], now: new Date(plannerFixtureNow), sourceId: options.sourceId })
    const selected = planCsvImportFromSnapshot(repeated, mapping, selectedSnapshot, { ...options, excludedLines: [2] })
    expect(selected.plan.items).toHaveLength(1)
    expect(selected.plan.items[0]?.key).toBe(original.plan.items[1]?.key)
    expect(selected.selectionHash).not.toBe(original.selectionHash)
    expect(selected.sourceSeconds).toBe(3601)
    expect(completeSqliteFingerprint(db.writer)).toEqual(before)
  })

  it('plans new entities explicitly and freezes independent copies rather than freezing caller inputs', async () => {
    const db = await setup()
    const parsed = parse(new TextEncoder().encode(new TextDecoder().decode(bytes).replace('member@example.invalid', 'new-person@example.invalid').replace('Fixture studio', 'New studio').replace('Existing project', 'New project').replace('Existing task', 'New task')))
    const mapping = emptyMapping()
    mapping.people['new-person@example.invalid'] = { create: { firstName: 'New', lastName: 'Person' } }
    const snapshot = readCsvDestinationSnapshot(db.readonly(), { actor: plannerAdministrator, parsed, mapping, sourceId: options.sourceId, dates: ['2026-09-01'], now: new Date(plannerFixtureNow) })
    const before = completeSqliteFingerprint(db.writer)
    const plan = planCsvImportFromSnapshot(parsed, mapping, snapshot, options)
    expect(plan.plan.report.entries.new).toBe(1)
    for (const kind of ['people', 'clients', 'projects', 'tasks'] as const) expect(plan.plan.report[kind].new).toBe(1)
    expect(plan.plan.report.assignments).toEqual({ userProject: 1, projectTask: 1 })
    expect(Object.isFrozen(plan.plan.items[0]?.row)).toBe(true)
    mapping.people['new-person@example.invalid'] = 'member@example.invalid'
    parsed.rows[0]!.notes = 'Changed only in caller memory'
    expect(plan.plan.items[0]?.person).toMatchObject({ status: 'new', person: { firstName: 'New', lastName: 'Person' } })
    expect(plan.plan.items[0]?.row.notes).toBe('Exact seconds preserved')
    expect(completeSqliteFingerprint(db.writer)).toEqual(before)
  })

  it('does not confuse an excluded imported occurrence with the next unimported duplicate in the real key ledger', async () => {
    const db = await setup()
    // Seed actual time + its atomic key using the existing importer, not hand-written
    // dedup rows or a fake ledger. Browser authorization below remains administrator 2.
    const imported = await applyCsvImport(db.writer, bytes, {
      sourceId: options.sourceId, adapter: createClockifyBrowserAdapter({ exporterZone: 'UTC' }),
      now: () => new Date(plannerFixtureNow),
    })
    expect(imported.created).toBe(1)
    expect(db.writer.prepare('SELECT count(*) AS n FROM time_entries').get()).toEqual({ n: 1 })
    const text = new TextDecoder().decode(bytes).trimEnd()
    const parsed = parse(new TextEncoder().encode(`${text}\n${text.split('\n')[1]}\n`))
    const keys = sourceKeys(parsed.rows)
    expect(db.writer.prepare('SELECT source_key FROM csv_import_entries').all()).toEqual([{ source_key: keys[0] }])
    const snapshot = readCsvDestinationSnapshot(db.readonly(), { actor: plannerAdministrator, parsed, excludedLines: [2], dates: ['2026-09-01'], now: new Date(plannerFixtureNow), sourceId: options.sourceId })
    const before = completeSqliteFingerprint(db.writer)
    const plan = planCsvImportFromSnapshot(parsed, emptyMapping(), snapshot, { ...options, excludedLines: [2] })
    expect(plan.plan.items).toHaveLength(1)
    expect(plan.plan.items[0]).toMatchObject({ key: keys[1], state: 'ready' })
    expect(plan.plan.report.entries).toMatchObject({ new: 1, alreadyImported: 0, rejected: 0 })
    expect(completeSqliteFingerprint(db.writer)).toEqual(before)
  })
  it('binds explicit existing IDs among duplicate names to their source parents and only their referenced destination policy', async () => {
    const db = await setup()
    db.writer.prepare("UPDATE clients SET name='Fixture studio' WHERE id=2").run()
    db.writer.prepare("UPDATE projects SET name='Existing project' WHERE id=2").run()
    db.writer.prepare("INSERT INTO tasks(id,name,created_at,updated_at) VALUES(2,'Existing task',?,?)").run(plannerFixtureNow, plannerFixtureNow)
    const parsed = parse()
    const keys = csvSourceEntityKeys(parsed.rows[0]!)
    const mapping = parseBrowserMapping(JSON.stringify({ destinationIds: {
      people: { [keys.people]: 3 }, clients: { [keys.clients]: 2 }, projects: { [keys.projects]: 2 }, tasks: { [keys.tasks]: 2 },
    } }))
    const takeSnapshot = () => readCsvDestinationSnapshot(db.readonly(), { actor: plannerAdministrator, parsed, mapping, sourceId: options.sourceId, now: new Date(plannerFixtureNow) })
    const snapshot = takeSnapshot()
    const before = completeSqliteFingerprint(db.writer)
    const plan = planCsvImportFromSnapshot(parsed, mapping, snapshot, options)
    expect(plan.plan.items[0]).toMatchObject({ state: 'ready', person: { id: 3 }, client: { id: 2 }, project: { id: 2 }, task: { id: 2 } })
    expect(plan.plan.report.entries.rejected).toBe(0)
    expect(completeSqliteFingerprint(db.writer)).toEqual(before)
    db.writer.prepare("UPDATE projects SET name='Unrelated project renamed' WHERE id=1").run()
    expect(takeSnapshot().destinationVersion).toBe(snapshot.destinationVersion)
    db.writer.prepare('UPDATE projects SET hourly_rate_cents=12345 WHERE id=2').run()
    expect(takeSnapshot().destinationVersion).not.toBe(snapshot.destinationVersion)
    mapping.destinationIds!.projects[keys.projects] = 1
    const wrongParentSnapshot = takeSnapshot()
    const wrongParent = planCsvImportFromSnapshot(parsed, mapping, wrongParentSnapshot, options)
    expect(wrongParent.plan.report.rejected).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'project_not_found' })]))
    expect(wrongParent.plan.report.projects.new).toBe(0)
  })

  it('keeps historical rounded time and deleted-ledger tombstones truthful after current policy changes', async () => {
    const db = await setup()
    expect((await applyCsvImport(db.writer, bytes, {
      sourceId: options.sourceId, adapter: createClockifyBrowserAdapter({ exporterZone: 'UTC' }),
      now: () => new Date(plannerFixtureNow),
    })).created).toBe(1)
    db.writer.prepare(`UPDATE organizations SET time_rounding_mode='up',time_rounding_minutes=30,
      time_entry_notes_required=1,time_entry_notes_minimum_length=100 WHERE id=1`).run()
    const before = completeSqliteFingerprint(db.writer)
    const historical = preview(db)
    expect(historical.plan.report.entries).toMatchObject({ new: 0, alreadyImported: 1, rejected: 0 })
    expect(historical.sourceSeconds).toBe(3601)
    expect(historical.destinationSeconds).toBe(3600)
    expect(completeSqliteFingerprint(db.writer)).toEqual(before)
    db.writer.prepare('DELETE FROM time_entries').run()
    const deleted = completeSqliteFingerprint(db.writer)
    const tombstone = preview(db)
    expect(tombstone.plan.report.entries).toMatchObject({ new: 0, alreadyImported: 1, rejected: 0 })
    expect(tombstone.deletedImportedRows).toBe(1)
    expect(tombstone.destinationSeconds).toBe(0)
    expect(completeSqliteFingerprint(db.writer)).toEqual(deleted)
  })

  it('creates an inactive uninvited person and native time through the concrete browser composition as nonowner administrator', async () => {
    const db = await setup()
    // This concrete composition deliberately uses SQLite's live lease clock.
    const service = createSqliteCsvBrowserService(db.writer)
    const sourceId = await service.ledger.registerDataset(plannerAdministrator, { workspaceIdentity: 'owned-new-person-workspace' })
    const input = new TextEncoder().encode(new TextDecoder().decode(bytes).replace('member@example.invalid', 'new-person@example.invalid'))
    const mapping = emptyMapping()
    mapping.people['new-person@example.invalid'] = { create: { firstName: 'New', lastName: 'Person' } }
    const before = completeSqliteFingerprint(db.writer)
    const { plan, snapshot } = service.preview(plannerAdministrator, sourceId, input, { exporterZone: 'UTC', mapping })
    expect(plan.plan.report.entries.new).toBe(1)
    expect(completeSqliteFingerprint(db.writer)).toEqual(before)
    const sealed = await service.confirm(plannerAdministrator, plan)
    if (sealed.outcome === 'blocked') throw new Error(`Owned seal refused: ${sealed.reason}`)
    const claim = await service.ledger.claimLease(plannerAdministrator, { runId: sealed.run.runId, holder: 'owned-person-import', ttlMs: 10_000 })
    if (claim.outcome !== 'claimed') throw new Error('Owned lease unexpectedly held')
    const writer = service.writer(snapshot, plan)
    expect(await writer.writeRow(plannerAdministrator, { ...claim.lease, runId: sealed.run.runId }, sealed.run.planId, plan.plan.items[0]!, 0)).toEqual({ outcome: 'written' })
    expect(db.writer.prepare(`SELECT u.id,u.profile,u.is_active,u.is_owner FROM users u JOIN user_emails e ON e.user_id=u.id WHERE e.address='new-person@example.invalid'`).get()).toEqual({ id: expect.any(Number), profile: 'member', is_active: 0, is_owner: 0 })
    expect(db.writer.prepare('SELECT t.seconds,t.rounded_seconds,u.is_active FROM time_entries t JOIN users u ON u.id=t.user_id').all()).toEqual([{ seconds: 3601, rounded_seconds: 3600, is_active: 0 }])
    const after = completeSqliteFingerprint(db.writer)
    for (const name of Object.keys(before.tables).filter(name => /invite|email_log|email_outbox|mail_queue|invoice|payment|expense|credit_note|retainer|payout|billable_rate/.test(name))) {
      expect(after.tables[name], name).toEqual(before.tables[name])
    }
    expect(await service.ledger.getRun(plannerAdministrator, sealed.run.runId)).toMatchObject({ actor: plannerAdministrator, written: 1 })
  })

  it('imports both separator-collision paths through the real browser bridge with distinct projects and no financial mutations', async () => {
    const db = await setup()
    const parsed = parse(new TextEncoder().encode(
      'Email,Client,Project,Task,Description,Billable,Start Date,Start Time,End Date,End Time,Duration (h)\n' +
      'member@example.invalid,A/B,C,Existing task,First owned path,Yes,2026-09-01,09:00:00,2026-09-01,10:00:00,01:00:00\n' +
      'member@example.invalid,A,B/C,Existing task,Second owned path,Yes,2026-09-01,10:00:00,2026-09-01,12:00:00,02:00:00\n',
    ))
    expect(parsed.fileErrors).toEqual([])
    expect(parsed.invalid).toEqual([])
    const ledger = nativeLedger(db)
    const sourceId = await ledger.registerDataset(plannerAdministrator, { workspaceIdentity: 'owned-clockify-workspace' })
    let snapshot = readCsvDestinationSnapshot(db.readonly(), { actor: plannerAdministrator, parsed, now: new Date(plannerFixtureNow), sourceId })
    const before = completeSqliteFingerprint(db.writer)
    let plan = planCsvImportFromSnapshot(parsed, emptyMapping(), snapshot, { ...options, sourceId })
    expect(plan.plan.report.entries.new).toBe(2)
    expect(plan.plan.report.projects.new).toBe(2)
    expect(completeSqliteFingerprint(db.writer)).toEqual(before)
    const sealed = await ledger.seal(plannerAdministrator, csvBrowserSealInput(plan), true)
    if (sealed.outcome === 'blocked') throw new Error(`Owned seal refused: ${sealed.reason}`)
    const claimed = await ledger.claimLease(plannerAdministrator, { runId: sealed.run.runId, holder: 'owned-acceptance', ttlMs: 10_000 })
    if (claimed.outcome !== 'claimed') throw new Error('Owned lease unexpectedly held')
    const lease = { ...claimed.lease, runId: sealed.run.runId }
    // A real committed setup may survive cancellation/interruption before time.
    // Recreate the snapshot/plan/writer and prove canonical lineage is reused.
    const client = plan.plan.items[0]!.client!
    const partialClient = await ledger.setup(plannerAdministrator, {
      runId: lease.runId, planId: sealed.run.planId, holder: lease.holder, leaseGeneration: lease.generation,
      setupKey: sha256Hex(client.key), kind: 'clients', input: { name: client.name, currency: client.currency! },
    })
    const initialVersion = plan.destinationVersion
    snapshot = readCsvDestinationSnapshot(db.readonly(), { actor: plannerAdministrator, parsed, now: new Date(plannerFixtureNow), sourceId })
    plan = planCsvImportFromSnapshot(parsed, emptyMapping(), snapshot, { ...options, sourceId })
    expect(plan.destinationVersion).toBe(initialVersion)
    expect(plan.plan.items[0]!.client!.id).toBe(Number(partialClient.id))
    expect((await ledger.seal(plannerAdministrator, csvBrowserSealInput(plan), true)).outcome).toBe('reopened')
    const writer = createCsvBrowserWriter(ledger, snapshot, plan)
    for (const [index, item] of plan.plan.items.entries()) {
      expect(await writer.writeRow(plannerAdministrator, lease, sealed.run.planId, item, index)).toEqual({ outcome: 'written' })
    }
    const rows = db.writer.prepare(`SELECT c.id AS client_id,c.name AS client,p.id AS project_id,p.name AS project,t.seconds,t.rounded_seconds
      FROM time_entries t JOIN projects p ON p.id=t.project_id JOIN clients c ON c.id=p.client_id ORDER BY t.id`).all() as {
      client_id: number; client: string; project_id: number; project: string; seconds: number; rounded_seconds: number
    }[]
    expect(rows).toEqual([
      { client_id: expect.any(Number), client: 'A/B', project_id: expect.any(Number), project: 'C', seconds: 3600, rounded_seconds: 3600 },
      { client_id: expect.any(Number), client: 'A', project_id: expect.any(Number), project: 'B/C', seconds: 7200, rounded_seconds: 7200 },
    ])
    expect(new Set(rows.map(row => row.project_id)).size).toBe(2)
    expect(new Set(rows.map(row => row.client_id)).size).toBe(2)
    expect(db.writer.prepare('SELECT source_line,source_seconds FROM csv_import_entries ORDER BY source_line').all()).toEqual([
      { source_line: 2, source_seconds: 3600 }, { source_line: 3, source_seconds: 7200 },
    ])
    const committed = completeSqliteFingerprint(db.writer)
    const moneyTables = Object.keys(before.tables).filter(name => /invoice|payment|expense|credit_note|retainer|payout|billable_rate/.test(name))
    expect(moneyTables.length).toBeGreaterThan(0)
    for (const name of moneyTables) expect(committed.tables[name], name).toEqual(before.tables[name])
    expect(await writer.writeRow(plannerAdministrator, lease, sealed.run.planId, plan.plan.items[0]!, 0)).toEqual({ outcome: 'written' })
    expect(completeSqliteFingerprint(db.writer)).toEqual(committed)
    expect(await ledger.getRun(plannerAdministrator, sealed.run.runId)).toMatchObject({ actor: plannerAdministrator, written: 2 })
  })
})
