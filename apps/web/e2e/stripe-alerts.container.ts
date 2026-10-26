import { createHmac } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { expect, test } from '@playwright/test'

test('native invoice reviews signed Stripe reports without changing receipts or balance', async ({ page }, info) => {
  const directory = process.env['EZACTO_STRIPE_FIXTURE_DIRECTORY']!
  const secret = process.env['EZACTO_STRIPE_FIXTURE_WEBHOOK_SECRET']!
  const database = new BetterSqlite3(join(directory, 'db.sqlite'), { readonly: true })
  const snapshot = () => ({
    invoice: database.prepare('SELECT * FROM invoices WHERE id=1').get(),
    payments: database.prepare('SELECT * FROM invoice_payments WHERE invoice_id=1 ORDER BY id').all(),
    paidEvents: database.prepare("SELECT count(*) AS count FROM event_outbox WHERE aggregate_type='invoice' AND aggregate_id=1 AND event_type='invoice.paid'").get(),
  })
  const origin = new URL(info.project.use.baseURL!).origin
  const providerAttempts: string[] = []
  await page.route('**/*', route => {
    const requested = new URL(route.request().url())
    if (requested.origin !== origin) {
      if (requested.hostname.endsWith('stripe.com')) providerAttempts.push(requested.origin)
      return route.abort()
    }
    return route.continue()
  })
  const deliver = async (id: string, type: string, object: Record<string, unknown>) => {
    const timestamp = Math.floor(Date.now() / 1000)
    const body = JSON.stringify({ id, type, created: timestamp, data: { object } })
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
    const response = await page.request.post('/webhooks/stripe', { data: body, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${timestamp},v1=${signature}` } })
    expect(response.status(), await response.text()).toBe(200)
  }
  try {
    await deliver('evt_owned_checkout', 'checkout.session.completed', { id: 'cs_owned', payment_status: 'paid', payment_intent: 'pi_owned', amount_total: 10000, currency: 'usd', metadata: { invoice_id: '1' } })
    const before = snapshot()
    expect(before.invoice).toMatchObject({ state: 'paid', due_amount_cents: 0 })
    expect(before.payments).toHaveLength(1)
    expect(before.paidEvents).toEqual({ count: 1 })
    const refund = { id: 'ch_owned', payment_intent: 'pi_owned', amount: 10000, amount_refunded: 2000, currency: 'usd', refunded: false }
    await deliver('evt_owned_refund', 'charge.refunded', refund)
    await deliver('evt_owned_refund', 'charge.refunded', refund)
    await deliver('evt_owned_dispute', 'charge.dispute.created', { id: 'dp_owned', payment_intent: 'pi_owned', amount: 4000, currency: 'usd', status: 'needs_response' })
    expect(snapshot()).toEqual(before)
    await page.goto('/invoices/by-id/1')
    await page.locator('[data-sign-in-form]').getByLabel('Email').fill('stripe-owner@example.invalid')
    await page.getByLabel('Password', { exact: true }).fill(process.env['EZACTO_STRIPE_FIXTURE_PASSWORD']!)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    const panel = page.locator('[data-invoice-provider-alerts]')
    await expect(panel).toBeVisible()
    await expect(panel.locator('li')).toHaveCount(2)
    const refundRow = panel.locator('li').filter({ hasText: 'Refund' })
    const disputeRow = panel.locator('li').filter({ hasText: 'Dispute' })
    await expect(refundRow).toContainText('$20.00')
    await expect(disputeRow).toContainText('$40.00')
    await expect(refundRow).toContainText('Needs administrator review')
    const button = refundRow.getByRole('button', { name: 'Mark reviewed', exact: true })
    const bounds = await button.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.height).toBeGreaterThanOrEqual(44)
    expect(bounds!.width).toBeGreaterThanOrEqual(44)
    const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/v1/invoices/1/provider-alerts/evt_owned_refund/review' && value.request().method() === 'POST')
    await button.click()
    const reviewed = await response
    expect(reviewed.status(), await reviewed.text()).toBe(200)
    expect(await reviewed.json()).toMatchObject({ data: { id: 'evt_owned_refund', reviewed_by: 1 } })
    await expect(refundRow).toContainText('Reviewed ')
    await expect(refundRow.getByRole('button', { name: 'Mark reviewed' })).toHaveCount(0)
    await expect(disputeRow.getByRole('button', { name: 'Mark reviewed' })).toHaveCount(1)
    await expect(panel.locator('[data-invoice-provider-alert-status]')).toContainText('Payments and invoice balance are unchanged')
    expect(snapshot()).toEqual(before)
    expect(database.prepare('SELECT count(*) AS count FROM stripe_payment_alerts').get()).toEqual({ count: 2 })
    expect(database.prepare('SELECT count(*) AS count FROM stripe_payment_alert_reviews').get()).toEqual({ count: 1 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.screenshot({ path: info.outputPath('stripe-alert-review-phone.png'), fullPage: true })
    const logout = await page.evaluate(async () => {
      const sessions = await (await fetch('/api/v1/sessions')).json()
      const current = sessions.data.find((session: { current: boolean }) => session.current)
      return (await fetch(`/api/v1/sessions/${current.id}`, { method: 'DELETE' })).status
    })
    expect(logout).toBe(200)
    await page.reload()
    await expect(page.locator('[data-sign-in-form]')).toBeVisible()
    expect(await page.locator('[data-invoice-provider-alert-list]').textContent()).toBe('')
    expect(providerAttempts).toEqual([])
    await writeFile(info.outputPath('stripe-alert-native-receipt.json'), JSON.stringify({ nativePasswordSession: true, signedCheckout: true, signedRefundAndDispute: true, replaySafe: true, reviewApiAndRefresh: true, invoiceAndPaymentsUnchanged: true, logoutClearsAlerts: true, buttonBounds: bounds, smtpProviderDeliveryTested: false, externalProviderCalls: 0 }, null, 2))
  } finally { database.close() }
})
