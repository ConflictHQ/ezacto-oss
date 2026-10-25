import { expect, test } from '@playwright/test'

const fixtureEmail = process.env.EZACTO_BROWSER_FIXTURE_EMAIL
const fixturePassword = process.env.EZACTO_BROWSER_FIXTURE_PASSWORD
const fixtureInstant = process.env.EZACTO_BROWSER_FIXTURE_INSTANT

if (
  fixtureEmail === undefined ||
  fixturePassword === undefined ||
  fixtureInstant === undefined
) {
  throw new Error('browser fixture credentials are unavailable')
}

/**
 * Resource planning, slice 2 (issue 1007): the capacity view is a read-only
 * person-by-week grid under the shell. Nothing is planned on a fresh instance,
 * so every row reads zero planned against that person's capacity and nothing is
 * flagged, and the grid offers nothing that edits a plan. An administrator also
 * gets the entry forms beneath it.
 */
test('[e2e:capacity] shows the signed-in person against their weekly capacity, read-only', async ({
  page,
}) => {
  await page.clock.setFixedTime(fixtureInstant)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto('/capacity')
  await page.locator('[data-sign-in-form]').getByLabel('Email').fill(fixtureEmail)
  await page.getByLabel('Password', { exact: true }).fill(fixturePassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  const workspace = page.locator('[data-capacity-page]')
  await expect(workspace.getByRole('heading', { name: 'Capacity' })).toBeVisible()
  const grid = page.locator('[data-capacity-grid]')
  const rows = grid.locator('tbody tr')
  await expect(rows.first()).toBeVisible()
  // The calendar keeps planned, available and rounded actual time separate.
  // A fresh instance has no planned demand and no over-allocation warning.
  await expect(rows.first()).toContainText('0h planned')
  await expect(rows.first()).toContainText(/\d+(?:\.\d+)?h available/)
  await expect(rows.first()).toContainText('tracked (rounded)')
  await expect(grid).not.toContainText('Over-allocated')
  await expect(page.locator('[data-capacity-status]')).toHaveText('')

  // The grid itself is read-only: nothing in it edits a plan. Entry lives in
  // the administrator forms below it, and the fixture signs in as the owner.
  await expect(grid.locator('input, textarea, select, form, dialog')).toHaveCount(0)
  await expect(page.locator('[data-planning-allocation-form]')).toBeVisible()
  await expect(page.locator('[data-planning-timeoff-form]')).toBeVisible()

  await page.getByRole('button', { name: 'Later weeks' }).click()
  await expect(rows.first()).toBeVisible()
  await page.getByRole('button', { name: 'This week' }).click()
  await expect(rows.first()).toBeVisible()
})
