import { expect, test } from '@playwright/test'

test('configures named GitHub repository mappings and reviews an App manifest before leaving the native UI', async ({ page, request }, testInfo) => {
  const reset = await request.post('/__ezacto_browser_fixture__/start-end', {
    headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
    data: { action: 'sign-in-rate-reset' },
  })
  expect(reset.status()).toBe(204)
  let configured = true
  const mappings: Record<string, unknown>[] = []
  const connections: Record<string, unknown>[] = []
  await page.route('**/api/v1/work-items/github/**', async route => {
    const resource = new URL(route.request().url()).pathname.split('/').at(-1)
    if (resource === 'status') return route.fulfill({ json: { data: { configured, available: configured, setup_supported: true, owned_acceptance_required: true, app: configured ? { id: '9', slug: 'fixture-reader', installation_url: 'https://github.com/apps/fixture-reader/installations/new' } : null, connections } } })
    if (resource === 'installations') return route.fulfill({ json: { data: { items: [{ id: '55', account: 'Acme engineering', repository_selection: 'selected' }], next_page: null } } })
    if (resource === 'repositories' && route.request().method() === 'GET') return route.fulfill({ json: { data: { items: [{ id: '77', full_name: 'acme/website' }], next_page: null } } })
    if (resource === 'repositories') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      mappings.push(body)
      connections.push({ id: '1:9:55', generation: 1, installation_id: '55', state: 'active', deferred_until: null, failure_codes: [], resources: [{ repository_id: '77', full_name: 'acme/website', project_id: 11, task_id: 12, state: 'active', checkpoint_status: 'idle', attempts: 0, next_retry_at: 0, failure_code: null, items_visible: 0, items_unavailable: 0 }] })
      return route.fulfill({ json: { data: { connection_id: '1:9:55', generation: 1 } } })
    }
    if (resource === 'reconcile') return route.fulfill({ status: 204, body: '' })
    if (resource === 'setup') return route.fulfill({ json: { data: { registration_url: 'https://github.com/organizations/acme/settings/apps/new?state=browser-fixture', manifest: JSON.stringify({ name: 'Native UI fixture reader', public: false, default_permissions: { issues: 'read', metadata: 'read' }, default_events: ['issues', 'repository'] }) } } })
    return route.abort()
  })
  for (const [path, data] of [
    ['projects', [{ id: 11, name: 'Website', is_active: true }]],
    ['tasks', [{ id: 12, name: 'Development', is_active: true }]],
    ['task-assignments', [{ id: 13, project_id: 11, task_id: 12, is_active: true }]],
  ] as const) await page.route(`**/api/v1/${path}?*`, route => route.fulfill({ json: { data, page: { next_cursor: null } } }))
  await page.goto('/settings/company#work-items')
  await page.locator('[data-sign-in-form]').getByLabel('Email', { exact: true }).fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
  await page.getByLabel('Password', { exact: true }).fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const section = page.locator('[data-settings-section="work-items"]')
  await expect(section).toBeVisible()
  await section.getByRole('combobox', { name: 'GitHub installation', exact: true }).selectOption({ label: 'Acme engineering (selected repositories)' })
  await section.getByRole('combobox', { name: 'Repository', exact: true }).selectOption({ label: 'acme/website' })
  await section.getByRole('combobox', { name: 'Project', exact: true }).selectOption({ label: 'Website' })
  await section.getByRole('combobox', { name: 'Task', exact: true }).selectOption({ label: 'Development' })
  await section.getByRole('button', { name: 'Save repository mapping', exact: true }).click()
  await expect(section.locator('[data-github-reader-status]')).toContainText('Repository mapped')
  expect(mappings).toHaveLength(1)
  expect(mappings[0]).toMatchObject({ installation_id: '55', repository_id: '77', project_id: 11, task_id: 12, expected_generation: 0 })
  await expect(section.locator('[data-github-reader-connections]')).toContainText('acme/website → Website / Development')
  await section.getByRole('button', { name: 'Sync GitHub issues now', exact: true }).click()
  await expect(section.locator('[data-github-reader-status]')).toContainText('GitHub sync requested')
  configured = false; connections.length = 0
  await section.getByRole('button', { name: 'Refresh GitHub status', exact: true }).click()
  await section.getByLabel('GitHub organization (optional)').fill('acme')
  await section.getByRole('button', { name: 'Review GitHub App setup', exact: true }).click()
  await expect(section.locator('[data-github-reader-manifest-review]')).toBeVisible()
  await expect(section.getByRole('button', { name: 'Continue to GitHub', exact: true })).toBeDisabled()
  await section.getByLabel('I reviewed the App permissions and want to continue to GitHub.').check()
  await expect(section.getByRole('button', { name: 'Continue to GitHub', exact: true })).toBeEnabled()
  await expect(section.locator('[data-github-reader-manifest-form]')).toHaveAttribute('action', 'https://github.com/organizations/acme/settings/apps/new?state=browser-fixture')
  for (const button of await section.getByRole('button').all()) {
    if (await button.isVisible()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  }
  await page.screenshot({ path: testInfo.outputPath('github-reader-phone.png'), fullPage: true })
})
