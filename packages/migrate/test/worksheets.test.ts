import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runLoad } from '../src/load.js'
import { readManifest, writeManifest } from '../src/manifest.js'
import { acquireSnapshotLock, releaseSnapshotLock } from '../src/snapshot-lock.js'
import {
  applyRecurringInvoiceWorksheet,
  applyRetainerWorksheet,
  generateRecurringInvoiceWorksheet,
  generateRetainerWorksheet,
  type RecurringInvoiceWorksheet,
  type RetainerWorksheet,
} from '../src/worksheets.js'
import { checksumReportDigest, snapshotDigest, type ChecksumReport } from '../src/verify.js'
import { buildSanitizedLoadSnapshot } from './load-fixture.js'

const jsonBytes = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

const refreshSnapshotEvidence = async (snapshotDir: string): Promise<void> => {
  const manifest = await readManifest(snapshotDir)
  await writeManifest(snapshotDir, manifest)
  const path = join(snapshotDir, 'checksums.json')
  const checksums = JSON.parse(await readFile(path, 'utf8')) as ChecksumReport
  checksums.snapshot_sha256 = await snapshotDigest(snapshotDir, manifest)
  const { report_sha256: prior, ...payload } = checksums
  void prior
  checksums.report_sha256 = checksumReportDigest(payload)
  await writeFile(path, `${JSON.stringify(checksums)}\n`)
}

const addSecondRecurringSource = async (snapshotDir: string): Promise<void> => {
  const path = join(snapshotDir, 'raw', 'invoices.jsonl')
  const invoices = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const duplicate = structuredClone(invoices.at(-1)!)
  duplicate.id = 12_000_002
  duplicate.number = 'INV-RECURRING-SECOND'
  duplicate.recurring_invoice_id = 99_002
  invoices.push(duplicate)
  await writeFile(path, `${invoices.map((row) => JSON.stringify(row)).join('\n')}\n`)
  const manifest = await readManifest(snapshotDir)
  manifest.resources.invoices!.count = invoices.length
  manifest.resources.invoices!.total_entries = invoices.length
  await writeManifest(snapshotDir, manifest)
  await refreshSnapshotEvidence(snapshotDir)
}

const overrideLinkedInvoiceCurrency = async (
  snapshotDir: string,
  invoiceId: number,
  sourceCurrency: string,
): Promise<void> => {
  const path = join(snapshotDir, 'raw', 'invoices.jsonl')
  const invoices = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const invoice = invoices.find((row) => row.id === invoiceId)
  if (invoice === undefined) throw new Error(`missing fixture invoice ${invoiceId}`)
  invoice.currency = sourceCurrency
  await writeFile(path, `${invoices.map((row) => JSON.stringify(row)).join('\n')}\n`)
  await refreshSnapshotEvidence(snapshotDir)
}

const completeRetainer = (worksheet: RetainerWorksheet): RetainerWorksheet => ({
  ...worksheet,
  rows: worksheet.rows.map((row) => ({
    ...row,
    balance_cents: 125_500,
    occurred_on: '2026-08-27',
    notes: 'Opening balance confirmed during migration',
  })),
})

const completeRecurring = (worksheet: RecurringInvoiceWorksheet): RecurringInvoiceWorksheet => ({
  ...worksheet,
  rows: worksheet.rows.map((row) => ({
    ...row,
    subject_template: `Recurring services ${row.harvest_recurring_invoice_id}`,
    notes_template: '',
    every_n_months: 1,
    day_of_month: 15,
    next_issue_on: '2026-09-15',
    amount_config: {
      schema_version: 1,
      type: 'fixed_lines',
      line_items: [
        {
          kind: 'Service',
          description: 'Monthly migration support',
          quantity: 1,
          unit_price_cents: 25_000,
          taxed: false,
          taxed2: false,
          harvest_project_id: 14_308_069,
        },
      ],
    },
    can_draw_from_harvest_retainer_id: 88_001,
  })),
})

describe('migration worksheets', () => {
  let dir: string
  let snapshotDir: string
  let databasePath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-worksheets-'))
    snapshotDir = join(dir, 'snapshot')
    databasePath = join(dir, 'ezacto.sqlite')
    await buildSanitizedLoadSnapshot(snapshotDir)
    await runLoad({ snapshotDir, databasePath })
  })

  afterEach(async () => rm(dir, { recursive: true, force: true }))

  it('[integration] generates deterministic source-only, secret-free worksheet rows', async () => {
    const retainers = await generateRetainerWorksheet({ snapshotDir, databasePath })
    const recurring = await generateRecurringInvoiceWorksheet({ snapshotDir, databasePath })
    expect(await generateRetainerWorksheet({ snapshotDir, databasePath })).toEqual(retainers)
    expect(await generateRecurringInvoiceWorksheet({ snapshotDir, databasePath })).toEqual(
      recurring,
    )

    expect(retainers).toMatchObject({
      version: 1,
      kind: 'retainer_balance',
      rows: [
        {
          harvest_retainer_id: 88_001,
          harvest_client_id: 5_735_776,
          client_name: 'Sanitized Client 5735776',
          currency: 'USD',
          linked_invoices: [
            { harvest_invoice_id: 12_000_001, number: 'INV-EXPENSE', currency: 'USD' },
          ],
          status: 'pending',
          balance_cents: null,
          occurred_on: null,
          notes: null,
        },
      ],
    })
    expect(recurring).toMatchObject({
      version: 1,
      kind: 'recurring_invoice_definition',
      rows: [
        {
          harvest_recurring_invoice_id: 99_001,
          harvest_client_id: 5_735_776,
          client_name: 'Sanitized Client 5735776',
          currency: 'USD',
          linked_invoices: [
            { harvest_invoice_id: 12_000_001, number: 'INV-EXPENSE', currency: 'USD' },
          ],
          status: 'pending',
          amount_config: null,
        },
      ],
    })
    for (const document of [retainers, recurring]) {
      const encoded = jsonBytes(document)
      expect(encoded).not.toMatch(
        /(?:authorization\s*:|bearer\s+|harvest_pat|client_key|statement_key|reference_token)/i,
      )
      expect(encoded).not.toContain('harvest-public-link-secret-must-not-survive')
      expect(document.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(document.manifest_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(document.load_options_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(document.context_sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('[integration] applies a retainer balance once and replays the exact artifact', async () => {
    const worksheet = completeRetainer(
      await generateRetainerWorksheet({ snapshotDir, databasePath }),
    )
    const inputPath = join(dir, 'retainers.json')
    await writeFile(inputPath, jsonBytes(worksheet))

    await expect(applyRetainerWorksheet({ snapshotDir, databasePath, inputPath })).resolves.toEqual(
      {
        total: 1,
        completed: 1,
        replayed: 0,
        pending: 0,
        snapshotSha256: worksheet.snapshot_sha256,
      },
    )
    const regenerated = await generateRetainerWorksheet({ snapshotDir, databasePath })
    expect(regenerated.status).toEqual({ total: 1, completed: 1, pending: 0 })
    expect(regenerated.rows[0]).toMatchObject({
      status: 'completed',
      balance_cents: null,
      occurred_on: null,
      notes: null,
    })
    await writeFile(inputPath, jsonBytes(regenerated))
    await expect(applyRetainerWorksheet({ snapshotDir, databasePath, inputPath })).resolves.toEqual(
      {
        total: 1,
        completed: 0,
        replayed: 1,
        pending: 0,
        snapshotSha256: worksheet.snapshot_sha256,
      },
    )
    await expect(applyRetainerWorksheet({ snapshotDir, databasePath, inputPath })).resolves.toEqual(
      {
        total: 1,
        completed: 0,
        replayed: 1,
        pending: 0,
        snapshotSha256: worksheet.snapshot_sha256,
      },
    )

    const sqlite = new BetterSqlite3(databasePath, { readonly: true })
    try {
      expect(
        sqlite
          .prepare(
            `SELECT balance FROM retainer_balances balance
            JOIN retainers retainer ON retainer.id = balance.retainer_id
            WHERE retainer.harvest_id = 88001`,
          )
          .get(),
      ).toEqual({ balance: 125_500 })
      expect(
        sqlite
          .prepare(
            `SELECT count(*) AS count, min(amount) AS amount
            FROM retainer_ledger entry JOIN retainers retainer ON retainer.id = entry.retainer_id
            WHERE retainer.harvest_id = 88001`,
          )
          .get(),
      ).toEqual({ count: 1, amount: 125_500 })
      expect(
        sqlite
          .prepare(
            `SELECT count(*) AS count FROM _ezacto_worksheet_completions
            WHERE kind = 'retainer_balance'`,
          )
          .get(),
      ).toEqual({ count: 1 })
    } finally {
      sqlite.close()
    }
  })

  it('[integration] resolves recurring Harvest project and retainer ids to native ids', async () => {
    const generated = await generateRecurringInvoiceWorksheet({ snapshotDir, databasePath })
    const worksheet = completeRecurring(generated)
    const inputPath = join(dir, 'recurring.json')
    await writeFile(inputPath, jsonBytes(worksheet))

    await expect(
      applyRecurringInvoiceWorksheet({ snapshotDir, databasePath, inputPath }),
    ).resolves.toMatchObject({ total: 1, completed: 1, replayed: 0, pending: 0 })
    await expect(
      applyRecurringInvoiceWorksheet({ snapshotDir, databasePath, inputPath }),
    ).resolves.toMatchObject({ total: 1, completed: 0, replayed: 1, pending: 0 })

    const sqlite = new BetterSqlite3(databasePath, { readonly: true })
    try {
      const stored = sqlite
        .prepare(
          `SELECT definition.amount_config AS amountConfig,
            definition.can_draw_from_retainer_id AS retainerId,
            project.id AS projectId, retainer.id AS expectedRetainerId
          FROM recurring_invoices definition
          JOIN projects project ON project.harvest_id = 14308069
          JOIN retainers retainer ON retainer.harvest_id = 88001
          WHERE definition.harvest_id = 99001`,
        )
        .get() as {
        amountConfig: string
        retainerId: number
        projectId: number
        expectedRetainerId: number
      }
      expect(JSON.parse(stored.amountConfig)).toMatchObject({
        type: 'fixed_lines',
        line_items: [{ project_id: stored.projectId }],
      })
      expect(stored.projectId).not.toBe(14_308_069)
      expect(stored.retainerId).toBe(stored.expectedRetainerId)
      expect(stored.retainerId).not.toBe(88_001)
      const receipt = sqlite
        .prepare(
          `SELECT input_json AS inputJson FROM _ezacto_worksheet_completions
          WHERE kind = 'recurring_invoice_definition' AND harvest_id = 99001`,
        )
        .get() as { inputJson: string }
      expect(JSON.parse(receipt.inputJson)).toMatchObject({
        source_amount_config: {
          type: 'fixed_lines',
          line_items: [{ harvest_project_id: 14_308_069 }],
        },
        amount_config: {
          type: 'fixed_lines',
          line_items: [{ project_id: stored.projectId }],
        },
        source_can_draw_from_harvest_retainer_id: 88_001,
        can_draw_from_retainer_id: stored.expectedRetainerId,
      })
    } finally {
      sqlite.close()
    }
  })

  it('[integration] resolves line-items-import Harvest project ids and retains both identities', async () => {
    const generated = await generateRecurringInvoiceWorksheet({ snapshotDir, databasePath })
    const worksheet: RecurringInvoiceWorksheet = {
      ...generated,
      rows: generated.rows.map((row) => ({
        ...row,
        subject_template: `Imported activity ${row.harvest_recurring_invoice_id}`,
        notes_template: '',
        every_n_months: 1,
        day_of_month: 15,
        next_issue_on: '2026-09-15',
        amount_config: {
          schema_version: 1,
          type: 'line_items_import',
          harvest_project_ids: [14_308_069],
          time: { summary_type: 'detailed' },
          expenses: { summary_type: 'category' },
        },
        can_draw_from_harvest_retainer_id: null,
      })),
    }
    const inputPath = join(dir, 'recurring-import.json')
    await writeFile(inputPath, jsonBytes(worksheet))

    await expect(
      applyRecurringInvoiceWorksheet({ snapshotDir, databasePath, inputPath }),
    ).resolves.toMatchObject({ completed: 1, replayed: 0, pending: 0 })

    const sqlite = new BetterSqlite3(databasePath, { readonly: true })
    try {
      const stored = sqlite
        .prepare(
          `SELECT definition.amount_config AS amountConfig,
            completion.input_json AS inputJson, project.id AS projectId
          FROM recurring_invoices definition
          JOIN _ezacto_worksheet_completions completion
            ON completion.resource_id = definition.id
            AND completion.kind = 'recurring_invoice_definition'
          JOIN projects project ON project.harvest_id = 14308069
          WHERE definition.harvest_id = 99001`,
        )
        .get() as { amountConfig: string; inputJson: string; projectId: number }
      expect(JSON.parse(stored.amountConfig)).toMatchObject({
        type: 'line_items_import',
        project_ids: [stored.projectId],
        time: { summary_type: 'detailed' },
        expenses: { summary_type: 'category' },
      })
      expect(stored.projectId).not.toBe(14_308_069)
      expect(JSON.parse(stored.inputJson)).toMatchObject({
        source_amount_config: {
          type: 'line_items_import',
          harvest_project_ids: [14_308_069],
        },
        amount_config: {
          type: 'line_items_import',
          project_ids: [stored.projectId],
        },
      })
    } finally {
      sqlite.close()
    }
  })

  it('[integration] preserves linked invoice currency overrides without changing client denomination', async () => {
    const overrideDir = join(dir, 'currency-override')
    const overrideSnapshot = join(overrideDir, 'snapshot')
    const overrideDatabase = join(overrideDir, 'ezacto.sqlite')
    await buildSanitizedLoadSnapshot(overrideSnapshot)
    await overrideLinkedInvoiceCurrency(overrideSnapshot, 12_000_001, 'EUR')
    await runLoad({ snapshotDir: overrideSnapshot, databasePath: overrideDatabase })

    const retainer = await generateRetainerWorksheet({
      snapshotDir: overrideSnapshot,
      databasePath: overrideDatabase,
    })
    const recurring = await generateRecurringInvoiceWorksheet({
      snapshotDir: overrideSnapshot,
      databasePath: overrideDatabase,
    })
    for (const worksheet of [retainer, recurring]) {
      expect(worksheet.rows[0]).toMatchObject({
        currency: 'USD',
        linked_invoices: [{ harvest_invoice_id: 12_000_001, currency: 'EUR' }],
      })
    }
  })

  it('[integration] rejects incomplete, secret-shaped, or context-tampered input before mutation', async () => {
    const generated = await generateRecurringInvoiceWorksheet({ snapshotDir, databasePath })
    const inputPath = join(dir, 'invalid.json')
    await writeFile(inputPath, jsonBytes(generated))
    await expect(
      applyRecurringInvoiceWorksheet({ snapshotDir, databasePath, inputPath }),
    ).rejects.toThrow('incomplete')

    const secret = completeRecurring(generated)
    secret.rows[0]!.notes_template = 'Authorization: Bearer do-not-store-this'
    await writeFile(inputPath, jsonBytes(secret))
    await expect(
      applyRecurringInvoiceWorksheet({ snapshotDir, databasePath, inputPath }),
    ).rejects.toThrow('credential-shaped')

    const tampered = completeRecurring(generated)
    tampered.rows[0]!.linked_invoices = [
      { harvest_invoice_id: 13_150_403, number: '2017-09', currency: 'USD' },
    ]
    await writeFile(inputPath, jsonBytes(tampered))
    await expect(
      applyRecurringInvoiceWorksheet({ snapshotDir, databasePath, inputPath }),
    ).rejects.toThrow('loaded source context')

    const sqlite = new BetterSqlite3(databasePath, { readonly: true })
    try {
      expect(
        sqlite.prepare('SELECT count(*) AS count FROM _ezacto_worksheet_completions').get(),
      ).toEqual({ count: 0 })
      expect(
        sqlite
          .prepare(
            `SELECT definition_status AS status FROM recurring_invoices
          WHERE harvest_id = 99001`,
          )
          .get(),
      ).toEqual({ status: 'incomplete' })
    } finally {
      sqlite.close()
    }
  })

  it('[security] rejects duplicate worksheet keys before either apply path can mutate', async () => {
    const retainer = jsonBytes(
      completeRetainer(await generateRetainerWorksheet({ snapshotDir, databasePath })),
    )
    const recurring = jsonBytes(
      completeRecurring(await generateRecurringInvoiceWorksheet({ snapshotDir, databasePath })),
    )
    const retainerPath = join(dir, 'duplicate-retainer.json')
    const recurringPath = join(dir, 'duplicate-recurring.json')
    const cases = [
      {
        source: retainer.replace(
          '  "kind": "retainer_balance",',
          '  "kind": "retainer_balance",\n  "kind": "retainer_balance",',
        ),
        path: retainerPath,
        apply: () => applyRetainerWorksheet({ snapshotDir, databasePath, inputPath: retainerPath }),
        key: 'kind',
      },
      {
        source: retainer.replace(
          '      "balance_cents": 125500,',
          '      "balance_cents": 1,\n      "balance_cents": 125500,',
        ),
        path: retainerPath,
        apply: () => applyRetainerWorksheet({ snapshotDir, databasePath, inputPath: retainerPath }),
        key: 'balance_cents',
      },
      {
        source: retainer.replace(
          '  "kind": "retainer_balance",',
          '  "kind": "retainer_balance",\n  "\\u006bind": "retainer_balance",',
        ),
        path: retainerPath,
        apply: () => applyRetainerWorksheet({ snapshotDir, databasePath, inputPath: retainerPath }),
        key: 'kind',
      },
      {
        source: recurring.replace(
          '  "kind": "recurring_invoice_definition",',
          '  "kind": "recurring_invoice_definition",\n  "kind": "recurring_invoice_definition",',
        ),
        path: recurringPath,
        apply: () =>
          applyRecurringInvoiceWorksheet({ snapshotDir, databasePath, inputPath: recurringPath }),
        key: 'kind',
      },
      {
        source: recurring.replace(
          '          "unit_price_cents": 25000,',
          '          "unit_price_cents": 1,\n          "unit_price_cents": 25000,',
        ),
        path: recurringPath,
        apply: () =>
          applyRecurringInvoiceWorksheet({ snapshotDir, databasePath, inputPath: recurringPath }),
        key: 'unit_price_cents',
      },
      {
        source: recurring.replace(
          '          "unit_price_cents": 25000,',
          '          "unit_price_cents": 1,\n          "unit_price_\\u0063ents": 25000,',
        ),
        path: recurringPath,
        apply: () =>
          applyRecurringInvoiceWorksheet({ snapshotDir, databasePath, inputPath: recurringPath }),
        key: 'unit_price_cents',
      },
    ]
    for (const duplicate of cases) {
      await writeFile(duplicate.path, duplicate.source)
      await expect(duplicate.apply()).rejects.toThrow(`duplicate key "${duplicate.key}"`)
    }

    const sqlite = new BetterSqlite3(databasePath, { readonly: true })
    try {
      expect(
        sqlite.prepare('SELECT count(*) AS count FROM _ezacto_worksheet_completions').get(),
      ).toEqual({ count: 0 })
    } finally {
      sqlite.close()
    }
  })

  it('[security] rejects quoted credential keys without rejecting benign field-name prose', async () => {
    const retainer = completeRetainer(
      await generateRetainerWorksheet({ snapshotDir, databasePath }),
    )
    const retainerPath = join(dir, 'secret-retainer.json')
    retainer.rows[0]!.notes = '{"client_key":"sekrit"}'
    await writeFile(retainerPath, jsonBytes(retainer))
    await expect(
      applyRetainerWorksheet({ snapshotDir, databasePath, inputPath: retainerPath }),
    ).rejects.toThrow('credential-shaped')
    retainer.rows[0]!.notes =
      'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdHNpZ25hdHVyZQ'
    await writeFile(retainerPath, jsonBytes(retainer))
    await expect(
      applyRetainerWorksheet({ snapshotDir, databasePath, inputPath: retainerPath }),
    ).rejects.toThrow('credential-shaped')

    const recurring = completeRecurring(
      await generateRecurringInvoiceWorksheet({ snapshotDir, databasePath }),
    )
    if (recurring.rows[0]!.amount_config?.type !== 'fixed_lines') {
      throw new Error('fixture recurring config is not fixed-lines')
    }
    recurring.rows[0]!.amount_config.line_items[0]!.description = '{"reference_token":"sekrit"}'
    const recurringPath = join(dir, 'secret-recurring.json')
    await writeFile(recurringPath, jsonBytes(recurring))
    await expect(
      applyRecurringInvoiceWorksheet({ snapshotDir, databasePath, inputPath: recurringPath }),
    ).rejects.toThrow('credential-shaped')
    recurring.rows[0]!.amount_config.line_items[0]!.description = 'Bearer hvt_9Kp4wZ2xR7mN5qT8vL3s'
    await writeFile(recurringPath, jsonBytes(recurring))
    await expect(
      applyRecurringInvoiceWorksheet({ snapshotDir, databasePath, inputPath: recurringPath }),
    ).rejects.toThrow('credential-shaped')

    retainer.rows[0]!.notes =
      'The "client_key" field is documented. Preauthorization: review; ' +
      'nonclient_key: label; Bearer bonds; unbearer token.'
    await writeFile(retainerPath, jsonBytes(retainer))
    await expect(
      applyRetainerWorksheet({ snapshotDir, databasePath, inputPath: retainerPath }),
    ).resolves.toMatchObject({ completed: 1, pending: 0 })
  })

  it('[integration] prevalidates all rows and resumes after an atomic per-row crash', async () => {
    const secondDir = join(dir, 'two')
    const secondSnapshot = join(secondDir, 'snapshot')
    const secondDatabase = join(secondDir, 'ezacto.sqlite')
    await buildSanitizedLoadSnapshot(secondSnapshot)
    await addSecondRecurringSource(secondSnapshot)
    await runLoad({ snapshotDir: secondSnapshot, databasePath: secondDatabase })
    const generated = await generateRecurringInvoiceWorksheet({
      snapshotDir: secondSnapshot,
      databasePath: secondDatabase,
    })
    expect(generated.rows.map((row) => row.harvest_recurring_invoice_id)).toEqual([99_001, 99_002])
    const worksheet = completeRecurring(generated)
    const inputPath = join(secondDir, 'recurring.json')

    const invalid = structuredClone(worksheet)
    invalid.rows[1]!.subject_template = null
    await writeFile(inputPath, jsonBytes(invalid))
    await expect(
      applyRecurringInvoiceWorksheet({
        snapshotDir: secondSnapshot,
        databasePath: secondDatabase,
        inputPath,
      }),
    ).rejects.toThrow('incomplete')
    let sqlite = new BetterSqlite3(secondDatabase)
    expect(
      sqlite.prepare('SELECT count(*) AS count FROM _ezacto_worksheet_completions').get(),
    ).toEqual({ count: 0 })
    sqlite
      .prepare(
        `CREATE TRIGGER abort_second_recurring BEFORE UPDATE ON recurring_invoices
      WHEN old.harvest_id = 99002 BEGIN SELECT raise(ABORT, 'simulated crash'); END`,
      )
      .run()
    sqlite.close()

    await writeFile(inputPath, jsonBytes(worksheet))
    await expect(
      applyRecurringInvoiceWorksheet({
        snapshotDir: secondSnapshot,
        databasePath: secondDatabase,
        inputPath,
      }),
    ).rejects.toThrow('simulated crash')
    sqlite = new BetterSqlite3(secondDatabase)
    expect(
      sqlite
        .prepare('SELECT harvest_id FROM _ezacto_worksheet_completions ORDER BY harvest_id')
        .all(),
    ).toEqual([{ harvest_id: 99_001 }])
    sqlite.prepare('DROP TRIGGER abort_second_recurring').run()
    sqlite.close()

    await expect(
      applyRecurringInvoiceWorksheet({
        snapshotDir: secondSnapshot,
        databasePath: secondDatabase,
        inputPath,
      }),
    ).resolves.toMatchObject({ total: 2, completed: 1, replayed: 1, pending: 0 })
  }, 30_000)

  it('[integration] holds the shared snapshot lock for worksheet generation and application', async () => {
    const lock = await acquireSnapshotLock(snapshotDir, 'load')
    try {
      await expect(generateRetainerWorksheet({ snapshotDir, databasePath })).rejects.toThrow(
        'snapshot is locked by load',
      )
    } finally {
      await releaseSnapshotLock(lock)
    }
  })

  it('[integration] refuses changed snapshot and load-option evidence', async () => {
    const worksheet = completeRetainer(
      await generateRetainerWorksheet({ snapshotDir, databasePath }),
    )
    const inputPath = join(dir, 'retainers.json')
    await writeFile(inputPath, jsonBytes(worksheet))
    const sqlite = new BetterSqlite3(databasePath)
    sqlite
      .prepare(
        `UPDATE _ezacto_load_admission SET load_options_json = '{"organizationCurrency":"EUR"}'`,
      )
      .run()
    sqlite.close()
    await expect(applyRetainerWorksheet({ snapshotDir, databasePath, inputPath })).rejects.toThrow(
      /inconsistent provenance|evidence does not match/,
    )

    expect(
      createHash('sha256')
        .update(await readFile(inputPath))
        .digest('hex'),
    ).toMatch(/^[0-9a-f]{64}$/)
  })
})
