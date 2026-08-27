// AC #3: a full extract of the live account. Skipped, never mocked and never
// faked, when credentials are absent — CI holds no Harvest secrets, so this is a
// skip there rather than a red gate, and the counts it prints are the evidence
// the acceptance box is closed with.

import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAuth } from '../src/auth.js'
import { loadDevVars } from '../src/env.js'
import { runExtract } from '../src/extract.js'
import { readManifest } from '../src/manifest.js'
import { minElapsedMs } from '../src/rate-limiter.js'
import { RESOURCES } from '../src/resources.js'

loadDevVars()
const hasLiveCreds = Boolean(process.env.HARVEST_PAT && process.env.HARVEST_ACCOUNT_ID)

describe.skipIf(!hasLiveCreds)('runExtract [api] against the live CONFLICT account', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-extract-live-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('completes a full extract and records per-resource counts in manifest.json', async () => {
    const logs: string[] = []
    const env = {
      pat: process.env.HARVEST_PAT as string,
      accountId: process.env.HARVEST_ACCOUNT_ID,
      userAgentEmail: process.env.HARVEST_USER_AGENT_EMAIL || 'hello@ezacto.com',
    }
    await runAuth({ env, toolVersion: '0.0.0', snapshotDir: dir })

    const result = await runExtract({ env, snapshotDir: dir, log: (line) => logs.push(line) })
    const manifest = await readManifest(dir)

    // Every step in the registry has an answer: swept, or explicitly skipped.
    for (const step of RESOURCES) {
      const record = manifest.resources[step.name]
      expect(record, `${step.name} has no manifest record`).toBeDefined()
      expect(
        record.complete || record.skipped_reason !== null,
        `${step.name} neither completed nor recorded why it was skipped`,
      ).toBe(true)
    }

    // The four resources any real Harvest account has.
    for (const name of ['users', 'clients', 'projects', 'time_entries']) {
      expect(manifest.resources[name].count, `${name} came back empty`).toBeGreaterThan(0)
    }

    // The manifest is not allowed to describe a snapshot that is not there.
    for (const [name, record] of Object.entries(manifest.resources)) {
      if (record.skipped_reason && record.count === 0 && record.pages === 0) continue
      const lines = (await readFile(join(dir, 'raw', `${name}.jsonl`), 'utf8'))
        .split('\n')
        .filter(Boolean)
      expect(lines, `${name}: manifest count vs raw/${name}.jsonl`).toHaveLength(record.count)
    }

    // Story 04: every live receipt with a URL has a verified content-addressed
    // archive entry. This stays a real-account test; fixture coverage lives in
    // binaries.test.ts and cannot prove Harvest's signed URLs still work.
    const expenses = (await readFile(join(dir, 'raw', 'expenses.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: number; receipt?: { url?: string; file_size?: number } })
    const receipts = expenses.filter((expense) => expense.receipt?.url)
    expect(Object.keys(manifest.binaries?.receipts ?? {})).toHaveLength(receipts.length)
    expect(
      (manifest.binaries?.anomalies ?? []).filter((anomaly) => anomaly.resource === 'receipt'),
    ).toEqual([])
    for (const expense of receipts) {
      const archived = manifest.binaries?.receipts[String(expense.id)]
      expect(archived, `expense ${expense.id} receipt was not archived`).toBeDefined()
      expect((await readFile(join(dir, archived!.path))).byteLength).toBe(expense.receipt?.file_size)
    }

    // Story 07: every client-facing invoice rendering is a verified PDF in the
    // content-addressed archive, and its bearer key never leaves raw input.
    const invoices = (await readFile(join(dir, 'raw', 'invoices.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: number; client_key?: string | null })
    expect(invoices.length).toBeGreaterThan(0)
    expect(invoices).toHaveLength(manifest.resources.invoices.count)
    const invoiceArchive = manifest.binaries?.invoice_pdfs
    expect(invoiceArchive, 'manifest has no invoice PDF archive').toBeDefined()
    expect(invoiceArchive!.summary.total).toBe(invoices.length)
    expect(invoiceArchive!.summary.archived).toBe(
      invoices.length - invoiceArchive!.anomalies.length,
    )
    // The live CONFLICT account is expected to have a usable client rendering
    // for every invoice. The formula above remains the manifest invariant if an
    // anomaly is ever intentionally accepted; today, any one is a red gate.
    expect(invoiceArchive!.anomalies).toEqual([])
    expect(Object.keys(invoiceArchive!.records)).toHaveLength(invoices.length)
    for (const invoice of invoices) {
      const archived = invoiceArchive!.records[String(invoice.id)]
      expect(archived, `invoice ${invoice.id} PDF was not archived`).toBeDefined()
      expect((await readFile(join(dir, archived!.path))).subarray(0, 5).toString()).toBe('%PDF-')
    }
    const clientKeys = invoices.flatMap((invoice) =>
      typeof invoice.client_key === 'string' ? [invoice.client_key] : [],
    )
    const diagnostics = `${JSON.stringify(manifest)}\n${logs.join('\n')}`
    expect(
      clientKeys.some((key) => diagnostics.includes(key)),
      'a Harvest invoice bearer key escaped into manifest.json or extract logs',
    ).toBe(false)

    expect(manifest.finished_at).not.toBeNull()

    // The run was paced by the budget it declared (§2.2): past the first window,
    // every further RATE_LIMIT requests cost a full window, so a run of this many
    // requests cannot have finished sooner than this. Not an average rate — the
    // limiter spends its first window at once by design, so the average of a
    // correctly-paced run sits above the sustained figure and converges down to it.
    // See minElapsedMs; the per-grant window property is rate-limiter.test.ts's.
    const elapsedS = result.durationMs / 1000
    expect(result.durationMs).toBeGreaterThanOrEqual(minElapsedMs(result.requests))

    // Printed so it can be pasted into the PR as this AC's evidence.
    const width = Math.max(...Object.keys(manifest.resources).map((n) => n.length))
    for (const [name, record] of Object.entries(manifest.resources)) {
      console.log(
        `${name.padEnd(width)} ${String(record.count).padStart(7)} rows  ` +
          `${String(record.pages).padStart(4)} pages` +
          (record.skipped_reason ? `  skipped: ${record.skipped_reason}` : ''),
      )
    }
    console.log(
      `total: ${result.requests} requests in ${Math.round(elapsedS)}s ` +
        `(administrator: ${manifest.preflight.user.is_administrator})`,
    )
    console.log(
      `invoice PDFs: ${invoiceArchive!.summary.archived}/${invoiceArchive!.summary.total} archived`,
    )
  }, 1_800_000)
})
