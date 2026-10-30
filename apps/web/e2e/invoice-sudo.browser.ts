import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'

// Run the shipped entry point against the production Worker and real local D1.
// Fixture credentials travel only through stdin and the private temporary config.
test('[e2e #926] built CLI reauthenticates one draft edit and unlinks only selected time', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90_000)
  const directory = await mkdtemp(join(tmpdir(), 'ezacto-sudo-native-'))
  const config = join(directory, 'config.json')
  const cli = resolve('..', '..', 'packages/cli/dist/cli.js')
  const command = (args: string[], input = '') =>
    new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args, '--config', config], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (data) => {
        output += data.toString()
      })
      child.stderr.on('data', (data) => {
        output += data.toString()
      })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, output }))
      child.stdin.end(input)
    })
  try {
    await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
    await page.goto('/')
    await page.request.post('/__ezacto_browser_fixture__/start-end', {
      data: { action: 'sign-in-rate-reset' },
      headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
    })
    await page
      .locator('[data-sign-in-form]')
      .getByLabel('Email')
      .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
    await page
      .getByLabel('Password', { exact: true })
      .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.locator('[data-sign-in-form]')).not.toBeVisible()
    const setup = await page.evaluate(async () => {
      const request = async (path: string, body: unknown) => {
        const response = await fetch('/api/v1' + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify(body),
        })
        const json = await response.json()
        if (!response.ok) throw new Error(path + ': ' + JSON.stringify(json))
        return json.data
      }
      const scopes = ['invoices:read', 'invoices:write', 'time_entries:read', 'time_entries:write']
      const token = await request('/api-tokens', { name: 'Local sudo acceptance', scopes })
      const time = await request('/time-entries', {
        project_id: 1,
        task_id: 1,
        spent_date: '2027-02-20',
        seconds: 3600,
        notes: 'Scoped sudo acceptance',
      })
      const retained = await request('/time-entries', {
        project_id: 1,
        task_id: 1,
        spent_date: '2027-02-20',
        seconds: 1800,
        notes: 'Retain this linked entry',
      })
      const project = (await (await fetch('/api/v1/projects/1')).json()).data
      const draft = await request('/invoice-generations', {
        client_id: project.client_id,
        from: '2027-02-20',
        to: '2027-02-20',
        project_ids: [1],
        time_summary_type: 'task',
        expense_summary_type: null,
      })
      return { token: token.token, scopes, timeId: time.id, retainedId: retained.id, draft }
    })
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        active_organization: 'fixture',
        organizations: {
          fixture: {
            base_url: baseURL!,
            token: setup.token,
            user_id: 1,
            profile: 'administrator',
            scopes: setup.scopes,
          },
        },
      }),
      { mode: 0o600 },
    )
    const baseline = await readFile(config, 'utf8')
    const number = String(setup.draft.number)
    const refused = await command(['invoice', 'edit', number, '--subject', 'Must not save'])
    expect(refused.code).toBe(1)
    const proof = JSON.stringify({
      email: process.env.EZACTO_BROWSER_FIXTURE_EMAIL,
      password: process.env.EZACTO_BROWSER_FIXTURE_PASSWORD,
    })
    const edited = await command(
      [
        'sudo',
        'invoice',
        'edit',
        number,
        '--subject',
        'Native sudo draft',
        '--due-date',
        '2027-03-31',
        '--line',
        '1',
        '--quantity',
        '1.5',
        '--rate',
        '123.45',
        '--description',
        'Native line',
        '--reauth-stdin',
      ],
      proof,
    )
    expect(edited.code, edited.output).toBe(0)
    const draft = await page.evaluate(
      async (id) => (await (await fetch('/api/v1/invoices/' + id)).json()).data,
      setup.draft.id,
    )
    expect(draft).toMatchObject({
      subject: 'Native sudo draft',
      due_date: '2027-03-31',
      state: 'draft',
    })
    expect(draft.line_items[0]).toMatchObject({
      quantity: 1.5,
      unit_price_cents: 12345,
      description: 'Native line',
      amount_cents: 18518,
    })
    const released = await command(
      [
        'sudo',
        'invoice',
        'unlink-time',
        number,
        '--entries',
        String(setup.timeId),
        '--reauth-stdin',
      ],
      proof,
    )
    expect(released.code, released.output).toBe(0)
    const entry = await page.evaluate(
      async (id) => (await (await fetch('/api/v1/time-entries/' + id)).json()).data,
      setup.timeId,
    )
    expect(entry.invoice_id).toBeNull()
    const retained = await page.evaluate(
      async (id) => (await (await fetch('/api/v1/time-entries/' + id)).json()).data,
      setup.retainedId,
    )
    expect(retained.invoice_id).toBe(setup.draft.id)
    const unchanged = await page.evaluate(
      async (id) => (await (await fetch('/api/v1/invoices/' + id)).json()).data,
      setup.draft.id,
    )
    expect(unchanged.amount_cents).toBe(draft.amount_cents)
    expect(await readFile(config, 'utf8')).toBe(baseline)
    expect(edited.output + released.output).not.toContain('ezi_')
    expect(edited.output + released.output).not.toContain(
      process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
