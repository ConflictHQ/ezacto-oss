import { expect, test } from '@playwright/test'
import BetterSqlite3 from 'better-sqlite3'
import { join } from 'node:path'

const bytes = Buffer.from([
  'Email,Client,Project,Task,Description,Billable,Start Date,Start Time,End Date,End Time,Duration (h),Billable Amount (USD)',
  'csv-admin@example.invalid,Owned CSV Studio,Owned CSV Project,General,"<img src=x onerror=alert(1)>",No,2026-09-01,09:00:00,2026-09-01,10:00:01,01:00:01,999.00',
  'csv-new-person@example.invalid,Owned CSV Studio,Owned CSV Project,General,New inactive person,No,2026-09-02,09:00:00,2026-09-02,10:00:00,01:00:00,500.00',
  'csv-admin@example.invalid,Owned CSV Studio,Owned CSV Project,General,Explicitly rejected duration,No,2026-09-03,09:00:00,2026-09-03,10:00:00,invalid-duration,1.00',
].join('\n'))

test('owned Container phone reviews Clockify mappings without importing records', async ({ page }, info) => {
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
    await expect(panel.locator('[data-csv-status]')).toHaveText('Choose a Clockify Detailed CSV to review. Applying is not enabled.')
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
    await expect(panel.locator('[data-csv-apply]')).toBeDisabled()
    const controls = await panel.locator('button:visible,input:visible,select:visible,label.settings-toggle:visible').evaluateAll(nodes => nodes.map(node => ({ type: node.getAttribute('type'), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })))
    for (const control of controls.filter(value => value.type !== 'checkbox')) { expect(control.height).toBeGreaterThanOrEqual(44); expect(control.width).toBeGreaterThanOrEqual(44) }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.screenshot({ path: info.outputPath('csv-review-phone.png'), fullPage: true })
    await page.reload()
    await expect(panel.locator('[data-csv-preview-facts]')).toContainText('7,201 seconds')
    await expect(panel.locator('[data-csv-apply]')).toBeDisabled()
    const ownedRun = new URL(page.url()).searchParams.get('csv_import')
    expect(ownedRun).not.toBeNull()
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(page.locator('[data-sign-in-form]')).toBeVisible()
    await expect(panel).not.toContainText('Owned CSV acceptance')
    await expect(panel.locator('[name="workspace"]')).toHaveValue('')
    await expect(panel.locator('[data-csv-catalog]')).toBeEmpty()
    expect(new URL(page.url()).searchParams.has('csv_import')).toBe(false)
    await page.goto(`/settings/company?csv_import=${encodeURIComponent(ownedRun!)}#import-export`)
    await signIn()
    await expect(panel.locator('[data-csv-preview-facts]')).toContainText('7,201 seconds')
    await panel.getByRole('button', { name: 'Purge staged input and diagnostics', exact: true }).click()
    await expect(panel.locator('[data-csv-status]')).toContainText('diagnostics purged')
    await expect(panel).not.toContainText('Owned CSV Project')
    expect(snapshot(businessTables)).toBe(businessBefore)
    expect(snapshot(financialTables.map(row => row.name))).toBe(financialBefore)
    expect(database.prepare('SELECT COUNT(*) AS n FROM time_entries').get()).toEqual({ n: 0 })
    expect(unexpectedRequests.every(value => value === 'https://fonts.googleapis.com' || value === 'https://fonts.gstatic.com')).toBe(true)
  } finally { database.close() }
})
