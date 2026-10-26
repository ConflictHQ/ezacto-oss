import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import BetterSqlite3 from 'better-sqlite3'
import { join } from 'node:path'

const bytes = Buffer.from([
  'Email,Client,Project,Task,Description,Billable,Start Date,Start Time,End Date,End Time,Duration (h),Billable Amount (USD)',
  'csv-admin@example.invalid,Owned CSV Studio,Owned CSV Project,General,"<img src=x onerror=alert(1)>",No,2026-09-01,09:00:00,2026-09-01,10:00:01,01:00:01,999.00',
  'csv-new-person@example.invalid,Owned CSV Studio,Owned CSV Project,General,New inactive person,No,2026-09-02,09:00:00,2026-09-02,10:00:00,01:00:00,500.00',
  'csv-admin@example.invalid,Owned CSV Studio,Owned CSV Project,General,Explicitly rejected duration,No,2026-09-03,09:00:00,2026-09-03,10:00:00,invalid-duration,1.00',
].join('\n'))

test('owned Container phone imports reviewed Clockify time through real private staging and durable apply', async ({ page }, info) => {
  const directory = process.env['EZACTO_CSV_FIXTURE_DIRECTORY']!
  const database = new BetterSqlite3(join(directory, 'db.sqlite'), { readonly: true })
  // Auth/session/staging/dataset bookkeeping is expected. Preview must not create business records.
  const businessTables = ['users', 'clients', 'projects', 'tasks', 'user_assignments', 'task_assignments', 'time_entries']
  const financialTables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name LIKE '%invoice%' OR name LIKE '%payment%' OR name LIKE '%payout%' OR name LIKE '%credit%' OR name LIKE '%expense%' OR name LIKE '%retainer%' OR name LIKE '%billable_rate%') ORDER BY name").all() as { name: string }[]
  const snapshot = (tables: readonly string[]) => JSON.stringify(tables.map(name => [name, database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()]))
  const businessBefore = snapshot(businessTables), financialBefore = snapshot(financialTables.map(row => row.name))
  const origin = new URL(info.project.use.baseURL!).origin
  const unexpectedRequests: string[] = []
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { unexpectedRequests.push(new URL(route.request().url()).origin); return route.abort() }
    return route.continue()
  })
  const signIn = async () => {
    await page.locator('[data-sign-in-form]').getByLabel('Email').fill('csv-admin@example.invalid')
    await page.getByLabel('Password', { exact: true }).fill(process.env['EZACTO_CSV_FIXTURE_PASSWORD']!)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  }
  try {
    await page.goto('/settings/company#import-export')
    await signIn()
    const panel = page.locator('[data-csv-import]')
    await expect(panel.locator('[data-csv-status]')).toHaveText('Choose a Clockify Detailed CSV to review before importing.')
    const whoami = await page.evaluate(async () => (await (await fetch('/api/v1/whoami')).json()).data)
    expect(whoami.user_id).toBe(2); expect(whoami.profile).toBe('administrator')
    expect(database.prepare('SELECT is_owner FROM users WHERE id=2').get()).toEqual({ is_owner: 0 })
    await panel.getByLabel('Clockify Detailed CSV', { exact: true }).setInputFiles({ name: 'invented-owned-fixture.csv', mimeType: 'text/csv', buffer: bytes })
    await panel.getByRole('button', { name: 'Upload for review', exact: true }).click()
    await expect(panel.locator('[data-csv-status]')).toContainText('CSV staged privately')
    await panel.getByLabel('Clockify workspace identity', { exact: true }).fill('owned-browser-clockify-workspace')
    await panel.getByLabel('Exporter timezone', { exact: true }).fill('America/Costa_Rica')
    await panel.getByRole('button', { name: 'Read mapping and preview', exact: true }).click()
    await expect(panel.locator('[data-csv-status]')).toContainText('Preview ready')
    const newPerson = panel.locator('[data-csv-source-key]').filter({ has: page.getByRole('heading', { name: 'csv-new-person@example.invalid', exact: true }) })
    await expect(newPerson).toBeVisible()
    await newPerson.getByRole('button', { name: 'Edit this mapping', exact: true }).click()
    await newPerson.getByLabel('First name', { exact: true }).fill('Owned')
    await newPerson.getByLabel('Last name', { exact: true }).fill('Inactive')
    await newPerson.getByRole('button', { name: 'Use this mapping', exact: true }).click()
    await panel.getByRole('button', { name: 'Save choices and refresh preview', exact: true }).click()
    await expect(panel.locator('[data-csv-status]')).toContainText('Preview ready')
    const rejectionTarget = panel.locator('[data-csv-errors] label.settings-toggle').first()
    await expect(rejectionTarget).toBeVisible()
    const rejectionBounds = await rejectionTarget.boundingBox()
    expect(rejectionBounds).not.toBeNull(); expect(rejectionBounds!.height).toBeGreaterThanOrEqual(44); expect(rejectionBounds!.width).toBeGreaterThanOrEqual(44)
    await panel.getByLabel('Excluded physical lines', { exact: true }).fill('4')
    await expect(rejectionTarget.locator('input')).toBeChecked()
    const selectionResponse = page.waitForResponse(response => /\/api\/v1\/csv-imports\/[^/]+\/preview$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST' && response.status() === 200)
    await panel.getByRole('button', { name: 'Review this exact selection', exact: true }).click()
    await expect(panel.locator('[data-csv-status]')).toContainText('Preview ready')
    const reviewed = (await (await selectionResponse).json()).data
    expect(reviewed.tallies).toMatchObject({ file_rows: 3, selected_rows: 2, source_seconds: 7201, rejected_row_count: 0, file_error_count: 0 })
    await expect(panel.locator('[data-csv-catalog]')).toContainText('Proposed inactive person: Owned Inactive. No invitation or password.')
    await expect(panel.locator('[data-csv-preview-facts]')).toContainText('Owned CSV acceptance')
    await expect(panel.locator('[data-csv-preview-facts]')).toContainText('7,201 seconds')
    await expect(panel.locator('[data-csv-preview-facts]')).toContainText('Unpriced')
    expect(snapshot(businessTables)).toBe(businessBefore)
    expect(snapshot(financialTables.map(row => row.name))).toBe(financialBefore)
    expect(await panel.locator('img').count()).toBe(0)
    const [diagnosticsDownload] = await Promise.all([
      page.waitForEvent('download'),
      panel.getByRole('button', { name: 'Download all static diagnostics', exact: true }).click(),
    ])
    const diagnosticsPath = await diagnosticsDownload.path()
    expect(diagnosticsPath).not.toBeNull()
    const diagnosticReceipt = JSON.parse(await readFile(diagnosticsPath!, 'utf8'))
    expect(diagnosticReceipt.preview_id).toBe(reviewed.preview_id)
    expect(diagnosticReceipt.diagnostics.length).toBeGreaterThan(0)
    expect(JSON.stringify(diagnosticReceipt)).not.toContain('<img')
    await panel.getByLabel('I reviewed this destination, file, dataset, mappings and exact selected rows.', { exact: true }).check()
    await panel.getByLabel('I reviewed every excluded physical line and accept that this is a partial dataset.', { exact: true }).check()
    const difference = panel.getByLabel('I reviewed the source and destination seconds and their difference, including any imported history.', { exact: true })
    if (await difference.isVisible()) await difference.check()
    await panel.getByLabel('I reviewed the new inactive people. No one is invited or activated.', { exact: true }).check()
    await expect(panel.locator('[data-csv-apply]')).toBeEnabled()
    const controls = await panel.locator('button:visible,input:visible,select:visible,label.settings-toggle:visible').evaluateAll(nodes => nodes.map(node => ({ tag: node.tagName, type: node.getAttribute('type'), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })))
    for (const control of controls.filter(value => value.type !== 'checkbox')) { expect(control.height).toBeGreaterThanOrEqual(44); expect(control.width).toBeGreaterThanOrEqual(44) }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.screenshot({ path: info.outputPath('csv-review-phone.png'), fullPage: true })
    let acceptedResponsesLost = 0
    const commands: { body: Record<string, unknown>; key: string | undefined }[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/v1\/csv-imports\/[^/]+\/apply$/.test(new URL(request.url()).pathname)) commands.push({ body: request.postDataJSON() as Record<string, unknown>, key: request.headers()['idempotency-key'] })
    })
    await page.route('**/api/v1/csv-imports/*/apply', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      const accepted = await route.fetch()
      expect(accepted.status()).toBe(200)
      acceptedResponsesLost++
      await accepted.dispose()
      // Lose the real accepted response, without replacing its body or server side effects.
      await route.abort('failed')
    }, { times: 1 })
    await panel.getByRole('button', { name: 'Confirm and apply this preview', exact: true }).click()
    await expect(panel.locator('[data-csv-progress-status]')).toContainText('completed', { timeout: 30_000 })
    expect(acceptedResponsesLost).toBe(1)
    expect(commands.length).toBeGreaterThan(0)
    for (const command of commands) { expect(command.body).toEqual(commands[0]!.body); expect(command.key).toBe(command.body['command_id']) }
    expect(database.prepare('SELECT COUNT(*) AS n,SUM(rounded_seconds) AS seconds FROM time_entries').get()).toEqual({ n: 2, seconds: reviewed.tallies.destination_seconds })
    const person = database.prepare("SELECT id,is_active,profile FROM users WHERE first_name='Owned' AND last_name='Inactive'").get() as { id: number; is_active: number; profile: string }
    expect(person.is_active).toBe(0)
    expect(database.prepare('SELECT COUNT(*) AS n FROM user_passwords WHERE user_id=?').get(person.id)).toEqual({ n: 0 })
    expect(database.prepare('SELECT COUNT(*) AS n FROM csv_import_entries').get()).toEqual({ n: 2 })
    expect(database.prepare('SELECT COUNT(*) AS n FROM csv_import_runs,json_each(apply_receipts_json)').get()).toEqual({ n: 1 })
    await writeFile(info.outputPath('csv-acceptance.json'), JSON.stringify({
      issue: 1183, runtime: 'disposable Container/SQLite', viewport: { width: 390, height: 844 },
      source_sha256: createHash('sha256').update(bytes).digest('hex'),
      adapter: reviewed.choices.adapter_id, timezone: reviewed.choices.exporter_zone,
      currency_policy: reviewed.choices.currency_policy, organization_currency: reviewed.tallies.organization_currency,
      owned_target_nonce: (database.prepare('SELECT nonce FROM csv_staging_instance WHERE singleton=1').get() as { nonce: string }).nonce,
      source_rows: reviewed.tallies.file_rows, selected_rows: reviewed.tallies.selected_rows, explicit_exclusions: reviewed.choices.excluded_lines,
      source_seconds: reviewed.tallies.source_seconds, destination_seconds: reviewed.tallies.destination_seconds,
      time_after_apply: database.prepare('SELECT COUNT(*) AS rows,SUM(rounded_seconds) AS seconds FROM time_entries').get(),
      apply_response_lost: acceptedResponsesLost === 1, repeated_commands_identical: commands.every(command => JSON.stringify(command.body) === JSON.stringify(commands[0]!.body)),
      financial_rows_unchanged: snapshot(financialTables.map(row => row.name)) === financialBefore,
      actor_user_id: whoami.user_id,
    }, null, 2) + '\n')
    expect(snapshot(financialTables.map(row => row.name))).toBe(financialBefore)
    await page.reload()
    await expect(panel.locator('[data-csv-progress-status]')).toContainText('completed')
    expect(database.prepare('SELECT COUNT(*) AS n FROM time_entries').get()).toEqual({ n: 2 })
    await page.screenshot({ path: info.outputPath('csv-completed-phone.png'), fullPage: true })
    const lightInk = await panel.evaluate(element => getComputedStyle(element).color)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => panel.evaluate(element => getComputedStyle(element).color)).not.toBe(lightInk)
    await page.screenshot({ path: info.outputPath('csv-completed-phone-dark.png'), fullPage: true })
    const ownedRun = new URL(page.url()).searchParams.get('csv_import')
    expect(ownedRun).not.toBeNull()
    // Sign out while the private preview still exists; purge must not make this proof vacuous.
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(page.locator('[data-sign-in-form]')).toBeVisible()
    await expect(panel).not.toContainText('Owned CSV acceptance')
    await expect(panel.locator('[name="workspace"]')).toHaveValue('')
    await expect(panel.locator('[data-csv-catalog]')).toBeEmpty()
    expect(new URL(page.url()).searchParams.has('csv_import')).toBe(false)
    expect(await page.evaluate(async () => (await fetch('/api/v1/whoami')).status)).toBe(401)
    await page.goto(`/settings/company?csv_import=${encodeURIComponent(ownedRun!)}#import-export`)
    await signIn()
    await expect(panel.locator('[data-csv-progress-status]')).toContainText('completed')
    await panel.getByRole('button', { name: 'Purge staged input and diagnostics', exact: true }).click()
    await expect(panel.locator('[data-csv-status]')).toContainText('were purged')
    await expect(panel).not.toContainText('Owned CSV Project')
    expect(database.prepare('SELECT COUNT(*) AS n FROM time_entries').get()).toEqual({ n: 2 })
    expect(snapshot(financialTables.map(row => row.name))).toBe(financialBefore)
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(page.locator('[data-sign-in-form]')).toBeVisible()
    await expect(panel.locator('[name="workspace"]')).toHaveValue('')
    await expect(panel.locator('[data-csv-catalog]')).toBeEmpty()
    expect(new URL(page.url()).searchParams.has('csv_import')).toBe(false)
    // Fonts are deliberately denied; no provider URL or CSV cell is requested.
    expect(unexpectedRequests.every(value => value === 'https://fonts.googleapis.com' || value === 'https://fonts.gstatic.com')).toBe(true)
  } finally { database.close() }
})
