import { expect, test } from '@playwright/test'
const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL!,
  fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!
test('[e2e #1121] reusable quote content creates an independent draft and never sends or converts', async ({
  page,
}, testInfo) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/invoices/estimates')
  expect(
    (
      await page.request.post('/__ezacto_browser_fixture__/start-end', {
        data: { action: 'sign-in-rate-reset' },
        headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
      })
    ).status(),
  ).toBe(204)
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password', { exact: true }).fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const composer = page.locator('[data-estimate-composer]')
  await expect(composer).toBeVisible()
  await composer.locator('summary').click()
  const marker = 'Quote template ' + crypto.randomUUID()
  await composer.getByLabel('Template name', { exact: true }).fill(marker)
  await composer.getByLabel('Subject', { exact: true }).fill('Reusable scope')
  await composer.getByLabel('Notes', { exact: true }).fill('Original commercial notes')
  const line = composer.locator('[data-quote-line]').first()
  await line.getByLabel('Description', { exact: true }).fill('Services')
  await line.getByLabel('Quantity', { exact: true }).fill('2.5')
  await line.getByLabel('Unit price (integer cents)', { exact: true }).fill('1001')
  await composer.getByLabel('Discount (%)', { exact: true }).fill('10')
  await composer.getByLabel('Tax (%)', { exact: true }).fill('10')
  await line.getByLabel('Tax applies', { exact: true }).check()
  await composer.getByRole('button', { name: 'Save as new template', exact: true }).click()
  await expect(composer.locator('[data-quote-status]')).toHaveText(
    'Template saved. Existing estimates are unchanged.',
  )
  const templateId = await composer.locator('[data-quote-template]').inputValue()
  expect(templateId).toMatch(/^[a-f0-9-]{36}$/)
  await composer.getByRole('combobox', { name: 'Client', exact: true }).selectOption({ index: 1 })
  const clientId = Number(
    await composer.getByRole('combobox', { name: 'Client', exact: true }).inputValue(),
  )
  const number = 'TEMPLATE-' + crypto.randomUUID()
  await composer.getByLabel('Estimate number', { exact: true }).fill(number)
  await composer.getByLabel('Issue date', { exact: true }).fill('2026-10-01')
  const writes: string[] = []
  page.on('request', (request) => {
    if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(request.method()))
      writes.push(new URL(request.url()).pathname)
  })
  await composer.getByRole('button', { name: 'Create draft', exact: true }).click()
  const created = composer.locator('[data-quote-created]')
  await expect(created).toBeVisible()
  const href = await created.getAttribute('href'),
    id = Number(new URL(href!, 'https://fixture.test').searchParams.get('estimate'))
  const quote = await page.evaluate(
    async (id) => (await (await fetch('/api/v1/estimates/' + id)).json()).data,
    id,
  )
  expect(quote).toMatchObject({
    client_id: clientId,
    number,
    state: 'draft',
    version: 0,
    notes: 'Original commercial notes',
    amount_cents: 2478,
    discount_amount_cents: 250,
    tax_amount_cents: 225,
  })
  expect(quote.line_items).toHaveLength(1)
  await composer.getByLabel('Notes', { exact: true }).fill('Later template revision')
  await composer.getByRole('button', { name: 'Update selected template', exact: true }).click()
  await expect(composer.locator('[data-quote-status]')).toHaveText(
    'Template saved. Existing estimates are unchanged.',
  )
  const unchanged = await page.evaluate(
    async (id) => (await (await fetch('/api/v1/estimates/' + id)).json()).data,
    id,
  )
  expect(unchanged.notes).toBe('Original commercial notes')
  page.once('dialog', (dialog) => dialog.accept())
  await composer.getByRole('button', { name: 'Archive selected template', exact: true }).click()
  await expect(composer.locator('[data-quote-status]')).toHaveText('Template archived.')
  expect(writes).toEqual([
    '/api/v1/estimates',
    '/api/v1/estimate-templates/' + templateId,
    '/api/v1/estimate-templates/' + templateId,
  ])
  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1)
  await composer.screenshot({ path: testInfo.outputPath('estimate-template-phone.png') })
  await created.click()
  await expect(page.locator('[data-estimate-number]')).toHaveText(number)
  await expect(page.locator('[data-estimate-state]')).toHaveText('Draft')
})
