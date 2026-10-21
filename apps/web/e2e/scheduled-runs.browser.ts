import { expect, test } from '@playwright/test'

test('[e2e:month-end #61] email deep-link requires sign-in and an explicit, single decision', async ({
  page,
  request,
}) => {
  const headers = { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' }
  const seeded = await request.post('/__ezacto_browser_fixture__/start-end', {
    headers,
    data: { action: 'scheduled-manifest-seed' },
  })
  expect(seeded.status()).toBe(200)
  const { runId } = (await seeded.json()) as { runId: number }
  const notices = await request.post('/__ezacto_browser_fixture__/scheduled-notices', { headers })
  if (notices.status() !== 200) throw new Error(`Notice fixture failed: ${await notices.text()}`)
  const { jobs } = (await notices.json()) as {
    jobs: {
      deliveryId: number
      message: { template: string; text: string; related?: { id: number } }
    }[]
  }
  const notice = jobs.find(
    (job) => job.message.template === 'scheduled-manifest' && job.message.related?.id === runId,
  )
  expect(notice).toBeDefined()
  expect(notice!.message.text).toContain('Browser Month End Client')
  expect(notice!.message.text).toContain('USD 123.45')
  const link = /https?:\/\/\S+\/scheduled-runs\/\d+/.exec(notice!.message.text)![0]
  const unauthenticated = await request.post(
    `${new URL(link).origin}/api/v1/scheduled-runs/${runId}/confirm`,
    {
      headers: { origin: new URL(link).origin },
    },
  )
  expect(unauthenticated.status()).toBe(401)
  await page.goto(link)
  await expect(page.locator('[data-sign-in-form]')).toBeVisible()
  await page
    .locator('[data-sign-in-form]')
    .getByLabel('Email')
    .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  const signedIn = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/auth/sign-in' &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  expect((await signedIn).status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Review month-end pack' })).toBeVisible()
  await expect(page.locator('[data-scheduled-run-items]')).toContainText(
    'month-end-accounts@example.test',
  )
  await expect(page.locator('[data-scheduled-run-items]')).toContainText('1h 30m')
  await expect(page.locator('[data-scheduled-run-summary]')).toContainText('proposed')
  await page.screenshot({ path: test.info().outputPath('manifest-phone.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: test.info().outputPath('manifest-desktop.png'), fullPage: true })
  const button = page.getByRole('button', { name: 'Confirm this manifest', exact: true })
  await button.click()
  await expect(page.locator('[data-scheduled-run-status]')).toContainText('Confirmation recorded')
  await expect(button).toBeHidden()
  const before = await page.request.get(`${new URL(link).origin}/api/v1/scheduled-runs/${runId}`)
  expect(before.status()).toBe(200)
  const recorded = (await before.json()).data
  const repeat = await page.request.post(
    `${new URL(link).origin}/api/v1/scheduled-runs/${runId}/confirm`,
    {
      headers: { origin: new URL(link).origin },
    },
  )
  expect(repeat.status()).toBe(200)
  expect((await repeat.json()).data).toEqual(recorded)
  await page.reload()
  await expect(button).toBeHidden()
  await expect(page.locator('[data-scheduled-run-summary]')).toContainText('confirmed')
})
