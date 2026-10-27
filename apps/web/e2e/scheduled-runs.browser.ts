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
  const { runId, invoiceIds } = (await seeded.json()) as { runId: number; invoiceIds: number[] }
  try {
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
    const link = /https?:\/\/\S+\/scheduled-runs\/\d+(?:#review=[A-Za-z0-9_.-]+)?/.exec(
      notice!.message.text,
    )![0]
    const reviewToken = new URLSearchParams(new URL(link).hash.slice(1)).get('review')!
    expect(reviewToken).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u)
    const unauthenticatedReview = await request.post(
      `${new URL(link).origin}/api/v1/scheduled-runs/${runId}/review-link`,
      { data: { token: reviewToken }, headers: { origin: new URL(link).origin } },
    )
    expect(unauthenticatedReview.status()).toBe(401)
    const unauthenticated = await request.post(
      `${new URL(link).origin}/api/v1/scheduled-runs/${runId}/confirm`,
      {
        headers: { origin: new URL(link).origin },
      },
    )
    expect(unauthenticated.status()).toBe(401)
    await page.goto(link)
    await expect(page.locator('[data-sign-in-form]')).toBeVisible()
    await expect.poll(() => new URL(page.url()).hash).toBe('')
    const reviewed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/v1/scheduled-runs/${runId}/review-link` &&
        response.request().method() === 'POST',
    )
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
    expect((await reviewed).status()).toBe(200)
    await expect(page.getByRole('heading', { name: 'Review month-end pack' })).toBeVisible()
    const proposedResponse = await page.request.get(`${new URL(link).origin}/api/v1/scheduled-runs/${runId}`)
    expect(proposedResponse.status()).toBe(200)
    const proposed = (await proposedResponse.json()).data
    expect(Date.parse(proposed.expires_at)-Date.parse(proposed.proposed_at)).toBe(3600000)
    expect(Date.parse(proposed.expires_at)).toBeGreaterThan(Date.now())
    await expect(page.locator('[data-scheduled-run-items]')).toContainText(
      'month-end-accounts@example.test',
    )
    await expect(page.locator('[data-scheduled-run-items]')).toContainText('Browser Owner — 1h 30m')
    await expect(page.locator('[data-scheduled-run-summary]')).toContainText('proposed')
    const usedReview = await page.request.post(
      `${new URL(link).origin}/api/v1/scheduled-runs/${runId}/review-link`,
      { data: { token: reviewToken }, headers: { origin: new URL(link).origin } },
    )
    expect(usedReview.status()).toBe(409)
    expect((await usedReview.json()).error.code).toBe('review_link_used')
    expect(
      JSON.stringify(
        await page.evaluate(() => ({
          local: Object.values(localStorage),
          session: Object.values(sessionStorage),
        })),
      ),
    ).not.toContain(reviewToken)
    await page.screenshot({ path: test.info().outputPath('manifest-phone.png'), fullPage: true })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.screenshot({ path: test.info().outputPath('manifest-desktop.png'), fullPage: true })
    const button = page.getByRole('button', { name: 'Confirm this manifest', exact: true })
    await expect(button).toBeDisabled()
    const withoutAcknowledgement = await page.request.post(
      `${new URL(link).origin}/api/v1/scheduled-runs/${runId}/confirm`,
      { headers: { origin: new URL(link).origin } },
    )
    expect(withoutAcknowledgement.status()).toBe(409)
    const pdfLinks = page.getByRole('link', { name: 'Review saved PDF' })
    await expect(pdfLinks).toHaveCount(2)
    for (const [index, pdfLink] of (await pdfLinks.all()).entries()) {
      const pdf = await page.request.get(new URL((await pdfLink.getAttribute('href'))!, link).href)
      expect(pdf.status()).toBe(200)
      expect(pdf.headers()['content-type']).toBe('application/pdf')
      expect((await pdf.body()).toString()).toContain(
        index === 0 ? 'Browser Month End Brand A' : 'Browser Month End Brand B',
      )
    }
    await page
      .getByRole('checkbox', {
        name: 'I reviewed the report warnings and the exact saved PDFs that will be sent.',
      })
      .check()
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
    const dispatched = await request.post('/__ezacto_browser_fixture__/scheduled-dispatch', {
      headers,
    })
    expect(dispatched.status()).toBe(200)
    const dispatchBody = await dispatched.json()
    expect(dispatchBody.result).toMatchObject({ completed: 2, failed: [] })
    const sends = dispatchBody.jobs.filter(
      (job: { message: { template: string; related?: { id: number } } }) =>
        job.message.template === 'month-end-pack' && job.message.related?.id === runId,
    )
    expect(sends).toHaveLength(2)
    expect(
      sends.map((job: { message: { to: { email: string }[] } }) => job.message.to[0]!.email),
    ).toEqual(['month-end-accounts@example.test', 'month-end-b@example.test'])
    for (const invoiceId of invoiceIds) {
      const attachments = await page.request.get(
        `${new URL(link).origin}/api/v1/invoices/${invoiceId}/attachments`,
      )
      expect(attachments.status()).toBe(200)
      expect((await attachments.json()).data).toHaveLength(1)
    }
    const repeated = await request.post('/__ezacto_browser_fixture__/scheduled-dispatch', {
      headers,
    })
    expect((await repeated.json()).result).toMatchObject({ completed: 0, failed: [] })
    await page.getByRole('button', { name: 'Refresh proposal' }).click()
    await expect(page.locator('[data-scheduled-run-status]')).toContainText('This run is complete')
    await expect(page.locator('[data-scheduled-run-items]')).toContainText('Delivery queued')
    const drained = await request.post('/__ezacto_browser_fixture__/drain-outbox', { headers })
    expect(drained.status()).toBe(200)
    const activity = await page.request.get(
      `${new URL(link).origin}/api/v1/activity-log?aggregate_type=scheduled_run&aggregate_id=${runId}`,
    )
    expect(activity.status()).toBe(200)
    const trail = JSON.stringify(await activity.json())
    expect(trail).toContain('scheduled_run.proposed')
    expect(trail).toContain('scheduled_run.confirmed')
    expect(trail).toContain('scheduled_run.item_completed')
    expect(trail).toContain('scheduled_run.completed')
  } finally {
    const cleaned = await request.post('/__ezacto_browser_fixture__/start-end', {
      headers,
      data: { action: 'scheduled-manifest-cleanup' },
    })
    expect(cleaned.status()).toBe(204)
  }
})
